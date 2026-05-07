import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "firebase/auth";
import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  query,
  where,
  serverTimestamp,
  writeBatch,
  updateDoc,
  addDoc,
  deleteDoc
} from "firebase/firestore";

import { auth, googleProvider, db } from "./firebase";
import {
  DEFAULT_CATEGORIES,
  SUPPORTED_CURRENCIES,
  FALLBACK_EXCHANGE_RATES_FROM_EUR,
  TRIP_STATUSES,
  CATEGORY_TYPES
} from "./constants";
import {
  todayIso,
  nowTimeIso,
  getEmailLower,
  getInviteFromUrl,
  buildInviteLink,
  getCurrencyRate as getRate,
  convertToEur as convertAmount,
  formatMoney,
  formatCurrency,
  readRatesCache,
  writeRatesCache,
  csvRow,
  downloadCsv,
  slugify,
  openDatePicker
} from "./utils";
import "./App.css";

const EMPTY_EXPENSE_FORM = {
  date: "",
  time: "",
  categoryId: "",
  description: "",
  originalAmount: "",
  originalCurrency: "EUR",
  paymentMethod: "card",
  notes: "",
  expenseType: "personal",
  splitType: "equal",
  paidByMemberId: "",
  splitMemberIds: [],
  customSplitShares: {}
};

const TRIP_IMAGE_MAX_WIDTH = 640;
const TRIP_IMAGE_MAX_HEIGHT = 360;
const TRIP_IMAGE_QUALITY = 0.68;
const TRIP_IMAGE_MAX_BYTES = 260 * 1024;
const PROFILE_IMAGE_SIZE = 256;
const PROFILE_IMAGE_QUALITY = 0.82;
const MEMBER_DIRECTORY_STORAGE_KEY = "triphisaab-member-directory";
const APP_VIEW_STORAGE_KEY = "triphisaab-app-view";
const LAST_TRIP_STORAGE_KEY = "triphisaab-last-trip";
const LAST_TAB_STORAGE_KEY = "triphisaab-last-tab";
const CATEGORY_EMOJI_OPTIONS = [
  "📌", "✈️", "🚆", "🚕", "🚌", "⛽", "🏨", "🏠",
  "🍽️", "☕", "🍕", "🛒", "🛍️", "🎟️", "🎡", "🏖️",
  "💸", "💳", "🧾", "🎁", "💊", "📱", "🧳", "✨",
  "🍔", "🍜", "🥐", "🥤", "🍷", "🚗", "🚲", "🚇",
  "⛴️", "🛫", "🛬", "🛌", "🏕️", "🎭", "🎮", "📷",
  "🧴", "👕", "👶", "🐾", "🗺️", "🧡", "⭐", "🔖"
];

const BUDGET_SCOPE_OPTIONS = [
  { value: "group", label: "Whole group" },
  { value: "selected", label: "Selected people" },
  { value: "me", label: "Only me" }
];

const EMPTY_BUDGET_FORM = {
  categoryId: "",
  title: "",
  estimatedEur: "",
  scope: "group",
  visibleMemberIds: []
};

const MONEY_EPSILON = 0.01;

function roundMoney(amount) {
  return Math.round(Number(amount || 0) * 100) / 100;
}

function memberDisplayName(member) {
  return member?.displayName || member?.name || member?.email || member?.id || "Unknown member";
}

function cleanDisplayName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "Unknown member";
  if (raw.includes("@")) return raw;
  return raw
    .split(/\s+/)
    .map(part => {
      if (!part) return part;
      const mostlyLowerOrUpper = part === part.toLowerCase() || part === part.toUpperCase();
      return mostlyLowerOrUpper
        ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        : part;
    })
    .join(" ");
}

function normalizeExpenseScope(expense) {
  if (expense?.scope === "group" || expense?.scope === "selected_members" || expense?.scope === "personal") {
    return expense.scope;
  }
  return expense?.expenseType === "shared" ? "group" : "personal";
}

function expenseVisibleIds(expense, members = []) {
  if (expense?.visibleTo === "all") return members.map(m => m.id);
  if (Array.isArray(expense?.visibleTo)) return expense.visibleTo;
  if (normalizeExpenseScope(expense) === "selected_members") {
    return expense?.splitMemberIds?.length ? expense.splitMemberIds : [];
  }
  if (normalizeExpenseScope(expense) === "personal") {
    return expense?.paidByMemberId ? [expense.paidByMemberId] : [];
  }
  return members.map(m => m.id);
}

function canUserSeeExpense(expense, currentUserId, isAdmin = false) {
  if (isAdmin) return true;
  if (expense?.visibleTo === "all") return true;
  if (Array.isArray(expense?.visibleTo)) return expense.visibleTo.includes(currentUserId);
  if (normalizeExpenseScope(expense) === "group") return true;
  if (normalizeExpenseScope(expense) === "personal") return expense.paidByMemberId === currentUserId;
  return expense?.splitMemberIds?.includes(currentUserId);
}

function isActiveSharedExpense(expense) {
  return expense?.isActive !== false
    && expense?.expenseType === "shared"
    && Number(expense?.amountEur || 0) > 0;
}

function getGroupSettlementExpenses(expenses) {
  return expenses.filter(expense => {
    if (!isActiveSharedExpense(expense)) return false;
    return normalizeExpenseScope(expense) === "group"
      || expense.visibleTo === "all"
      || expense.countsTowardGroupSettlement === true;
  });
}

function getPrivateSettlementGroups(expenses, currentUserId, isAdmin = false) {
  const groups = new Map();
  expenses.forEach(expense => {
    if (!isActiveSharedExpense(expense)) return;
    const selectedScope =
      normalizeExpenseScope(expense) === "selected_members"
      || Array.isArray(expense.visibleTo);
    if (!selectedScope || expense.visibleTo === "all") return;
    if (!canUserSeeExpense(expense, currentUserId, isAdmin)) return;

    const ids = Array.from(
      new Set(expenseVisibleIds(expense).filter(Boolean))
    ).sort();
    if (ids.length < 2) return;
    const groupId = ids.join("__");
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        settlementGroupId: groupId,
        memberIds: ids,
        expenses: []
      });
    }
    groups.get(groupId).expenses.push(expense);
  });
  return Array.from(groups.values());
}

function calculateBalances(expenses, members, settlementRecords = []) {
  const out = {};
  members.forEach(member => {
    out[member.id] = {
      memberId: member.id,
      userId: member.id,
      name: memberDisplayName(member),
      email: member.email || "",
      paid: 0,
      share: 0,
      owes: 0,
      settledPaid: 0,
      settledReceived: 0,
      net: 0
    };
  });

  expenses.forEach(expense => {
    if (!isActiveSharedExpense(expense)) return;
    const amount = roundMoney(expense.amountEur);
    if (amount <= 0 || !out[expense.paidByMemberId]) return;
    out[expense.paidByMemberId].paid += amount;

    let shares = {};
    if ((expense.splitType === "custom" || expense.splitType === "percent") && expense.customSplitSharesEur) {
      shares = expense.customSplitSharesEur;
    } else {
      const splitIds =
        expense.splitMemberIds?.length > 0
          ? expense.splitMemberIds
          : members.map(member => member.id);
      const share = splitIds.length > 0 ? amount / splitIds.length : 0;
      splitIds.forEach(id => {
        shares[id] = share;
      });
    }

    Object.entries(shares).forEach(([memberId, share]) => {
      if (out[memberId]) out[memberId].share += Number(share || 0);
    });
  });

  settlementRecords
    .filter(record => (record.status || "paid") === "paid")
    .forEach(record => {
      const amount = roundMoney(record.amountEur || record.amount);
      if (out[record.fromMemberId || record.fromUserId]) {
        out[record.fromMemberId || record.fromUserId].settledPaid += amount;
      }
      if (out[record.toMemberId || record.toUserId]) {
        out[record.toMemberId || record.toUserId].settledReceived += amount;
      }
    });

  Object.values(out).forEach(balance => {
    balance.paid = roundMoney(balance.paid);
    balance.share = roundMoney(balance.share);
    balance.owes = balance.share;
    balance.settledPaid = roundMoney(balance.settledPaid);
    balance.settledReceived = roundMoney(balance.settledReceived);
    balance.net = roundMoney(
      balance.paid - balance.share + balance.settledPaid - balance.settledReceived
    );
  });

  return Object.values(out);
}

function generateSettlementSuggestions(balances, currency = "EUR") {
  const debtors = balances
    .filter(balance => balance.net < -MONEY_EPSILON)
    .map(balance => ({ ...balance, amount: roundMoney(Math.abs(balance.net)) }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = balances
    .filter(balance => balance.net > MONEY_EPSILON)
    .map(balance => ({ ...balance, amount: roundMoney(balance.net) }))
    .sort((a, b) => b.amount - a.amount);

  const suggestions = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = roundMoney(Math.min(debtor.amount, creditor.amount));
    if (amount > MONEY_EPSILON) {
      suggestions.push({
        id: `${debtor.memberId}-${creditor.memberId}-${amount.toFixed(2)}`,
        fromUserId: debtor.memberId,
        fromMemberId: debtor.memberId,
        fromName: debtor.name,
        toUserId: creditor.memberId,
        toMemberId: creditor.memberId,
        toName: creditor.name,
        amount,
        currency,
        status: "pending"
      });
    }
    debtor.amount = roundMoney(debtor.amount - amount);
    creditor.amount = roundMoney(creditor.amount - amount);
    if (debtor.amount <= MONEY_EPSILON) debtorIndex += 1;
    if (creditor.amount <= MONEY_EPSILON) creditorIndex += 1;
  }
  return suggestions;
}

// ---- Settlement mode helpers ----

function buildExpenseRelationshipGraph(expenses) {
  const graph = {};
  expenses.forEach(expense => {
    if (!isActiveSharedExpense(expense)) return;
    const ids = new Set();
    if (expense.paidByMemberId) ids.add(expense.paidByMemberId);
    if (expense.splitMemberIds?.length > 0) expense.splitMemberIds.forEach(id => ids.add(id));
    if (expense.customSplitSharesEur) Object.keys(expense.customSplitSharesEur).forEach(id => ids.add(id));
    const arr = Array.from(ids).filter(Boolean);
    if (arr.length < 2) return;
    arr.forEach(id => {
      if (!graph[id]) graph[id] = new Set();
      arr.forEach(otherId => { if (otherId !== id) graph[id].add(otherId); });
    });
  });
  return graph;
}

// Familiar-only: match debtors and creditors who shared at least one expense.
// Returns { suggestions, unresolvedDebtors, unresolvedCreditors, fallbackRequired }.
function generateFamiliarSettlements(balances, relationshipGraph, currency = "EUR") {
  const debtors = balances
    .filter(b => b.net < -MONEY_EPSILON)
    .map(b => ({ ...b, amount: roundMoney(Math.abs(b.net)) }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = balances
    .filter(b => b.net > MONEY_EPSILON)
    .map(b => ({ ...b, amount: roundMoney(b.net) }))
    .sort((a, b) => b.amount - a.amount);

  const suggestions = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let di = 0; di < debtors.length; di++) {
      const debtor = debtors[di];
      if (debtor.amount <= MONEY_EPSILON) continue;
      const knownTo = relationshipGraph[debtor.memberId] || new Set();
      for (let ci = 0; ci < creditors.length; ci++) {
        const creditor = creditors[ci];
        if (creditor.amount <= MONEY_EPSILON) continue;
        if (!knownTo.has(creditor.memberId)) continue;
        const amount = roundMoney(Math.min(debtor.amount, creditor.amount));
        if (amount > MONEY_EPSILON) {
          suggestions.push({
            id: `${debtor.memberId}-${creditor.memberId}-${amount.toFixed(2)}`,
            fromUserId: debtor.memberId,
            fromMemberId: debtor.memberId,
            fromName: debtor.name,
            toUserId: creditor.memberId,
            toMemberId: creditor.memberId,
            toName: creditor.name,
            amount,
            currency,
            status: "pending",
            isFamiliarPayment: true,
            settlementMode: "familiar_only"
          });
          debtor.amount = roundMoney(debtor.amount - amount);
          creditor.amount = roundMoney(creditor.amount - amount);
          changed = true;
          if (debtor.amount <= MONEY_EPSILON) break;
        }
      }
    }
  }
  const unresolvedDebtors = debtors.filter(d => d.amount > MONEY_EPSILON);
  const unresolvedCreditors = creditors.filter(c => c.amount > MONEY_EPSILON);
  return {
    suggestions,
    unresolvedDebtors,
    unresolvedCreditors,
    fallbackRequired: unresolvedDebtors.length > 0 || unresolvedCreditors.length > 0
  };
}

// Build settlement units: saved groups first, then remaining members as individuals.
function getSettlementUnits(members, settlementGroups = []) {
  const activeGroups = settlementGroups.filter(g => g.isActive !== false);
  const assignedIds = new Set(activeGroups.flatMap(g => g.memberIds));
  const units = activeGroups.map(g => ({ ...g, isNamedUnit: true }));
  members.forEach(member => {
    if (!assignedIds.has(member.id)) {
      units.push({
        id: member.id,
        name: memberDisplayName(member),
        memberIds: [member.id],
        type: "individual",
        isNamedUnit: false
      });
    }
  });
  return units;
}

function calculateUnitBalances(memberBalances, units) {
  return units.map(unit => {
    const inUnit = memberBalances.filter(b => unit.memberIds.includes(b.memberId));
    return {
      unitId: unit.id,
      name: unit.name,
      memberIds: unit.memberIds,
      type: unit.type || "individual",
      net: roundMoney(inUnit.reduce((s, b) => s + b.net, 0)),
      paid: roundMoney(inUnit.reduce((s, b) => s + b.paid, 0)),
      share: roundMoney(inUnit.reduce((s, b) => s + b.share, 0))
    };
  });
}

// Run greedy settlement on unit balances instead of individual balances.
function generateFamilyCoupleSettlements(memberBalances, units, currency = "EUR") {
  const unitBalances = calculateUnitBalances(memberBalances, units);
  const debtors = unitBalances
    .filter(u => u.net < -MONEY_EPSILON)
    .map(u => ({ ...u, amount: roundMoney(Math.abs(u.net)) }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = unitBalances
    .filter(u => u.net > MONEY_EPSILON)
    .map(u => ({ ...u, amount: roundMoney(u.net) }))
    .sort((a, b) => b.amount - a.amount);

  const suggestions = [];
  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const debtor = debtors[di];
    const creditor = creditors[ci];
    const amount = roundMoney(Math.min(debtor.amount, creditor.amount));
    if (amount > MONEY_EPSILON) {
      suggestions.push({
        id: `unit-${debtor.unitId}-${creditor.unitId}-${amount.toFixed(2)}`,
        fromUnitId: debtor.unitId,
        fromMemberId: debtor.memberIds[0],
        fromName: debtor.name,
        fromType: debtor.memberIds.length > 1 ? "unit" : "member",
        toUnitId: creditor.unitId,
        toMemberId: creditor.memberIds[0],
        toName: creditor.name,
        toType: creditor.memberIds.length > 1 ? "unit" : "member",
        amount,
        currency,
        status: "pending",
        settlementMode: "family_couple"
      });
    }
    debtor.amount = roundMoney(debtor.amount - amount);
    creditor.amount = roundMoney(creditor.amount - amount);
    if (debtor.amount <= MONEY_EPSILON) di++;
    if (creditor.amount <= MONEY_EPSILON) ci++;
  }
  return suggestions;
}

// Mode-aware version of getSmartSettleSummary.
function getSmartSettleSummaryByMode(
  expenses, members, currentUserId, settlementRecords = [],
  isAdmin = false, currency = "EUR",
  mode = "fewest_payments", settlementGroups = []
) {
  const activeMembers = members.filter(m => m.status !== "inactive");
  const groupExpenses = getGroupSettlementExpenses(expenses);
  const groupSettlements = settlementRecords.filter(r => (r.settlementLayer || "group") === "group");
  const groupBalances = calculateBalances(groupExpenses, activeMembers, groupSettlements);
  const relationshipGraph = buildExpenseRelationshipGraph(groupExpenses);

  let groupResult;
  if (mode === "familiar_only") {
    groupResult = generateFamiliarSettlements(groupBalances, relationshipGraph, currency);
  } else if (mode === "family_couple") {
    const units = getSettlementUnits(activeMembers, settlementGroups);
    groupResult = {
      suggestions: generateFamilyCoupleSettlements(groupBalances, units, currency),
      fallbackRequired: false, unresolvedDebtors: [], unresolvedCreditors: []
    };
  } else {
    groupResult = {
      suggestions: generateSettlementSuggestions(groupBalances, currency),
      fallbackRequired: false, unresolvedDebtors: [], unresolvedCreditors: []
    };
  }

  const privateSettlements = getPrivateSettlementGroups(expenses, currentUserId, isAdmin).map(group => {
    const groupMembers = activeMembers.filter(m => group.memberIds.includes(m.id));
    const paidRecords = settlementRecords.filter(r =>
      r.settlementLayer === "private" && r.settlementGroupId === group.settlementGroupId
    );
    const balances = calculateBalances(group.expenses, groupMembers, paidRecords);
    const privRelGraph = buildExpenseRelationshipGraph(group.expenses);

    let privResult;
    if (mode === "familiar_only") {
      privResult = generateFamiliarSettlements(balances, privRelGraph, currency);
    } else if (mode === "family_couple") {
      const units = getSettlementUnits(groupMembers, settlementGroups);
      privResult = {
        suggestions: generateFamilyCoupleSettlements(balances, units, currency),
        fallbackRequired: false, unresolvedDebtors: [], unresolvedCreditors: []
      };
    } else {
      privResult = {
        suggestions: generateSettlementSuggestions(balances, currency),
        fallbackRequired: false, unresolvedDebtors: [], unresolvedCreditors: []
      };
    }

    return {
      settlementGroupId: group.settlementGroupId,
      memberIds: group.memberIds,
      memberNames: groupMembers.map(memberDisplayName),
      totalSpent: roundMoney(group.expenses.reduce((s, e) => s + Number(e.amountEur || 0), 0)),
      balances,
      suggestions: privResult.suggestions,
      fallbackRequired: privResult.fallbackRequired || false,
      unresolvedDebtors: privResult.unresolvedDebtors || [],
      unresolvedCreditors: privResult.unresolvedCreditors || []
    };
  });

  return {
    groupSettlement: {
      totalSpent: roundMoney(groupExpenses.reduce((s, e) => s + Number(e.amountEur || 0), 0)),
      balances: groupBalances,
      suggestions: groupResult.suggestions,
      fallbackRequired: groupResult.fallbackRequired || false,
      unresolvedDebtors: groupResult.unresolvedDebtors || [],
      unresolvedCreditors: groupResult.unresolvedCreditors || []
    },
    privateSettlements
  };
}

const DEMO_TRIP_ID = "demo-norway-trip";
const DEMO_MEMBERS = [
  { id: "demo-alex", displayName: "Alex", email: "alex@example.com", status: "active", role: "owner", isOwner: true },
  { id: "demo-sam", displayName: "Sam", email: "sam@example.com", status: "active", role: "member", isOwner: false },
  { id: "demo-maya", displayName: "Maya", email: "maya@example.com", status: "active", role: "member", isOwner: false }
];
const DEMO_CATEGORIES = [
  { id: "flights", name: "Flights", type: "Trip", icon: "✈️", color: "#2563eb", isActive: true },
  { id: "hotel", name: "Hotel", type: "Trip", icon: "🏨", color: "#7c3aed", isActive: true },
  { id: "food", name: "Food", type: "Daily", icon: "🍽️", color: "#ea580c", isActive: true },
  { id: "transport", name: "Transport", type: "Daily", icon: "🚆", color: "#0891b2", isActive: true },
  { id: "activities", name: "Activities", type: "Fun", icon: "🎟️", color: "#16a34a", isActive: true }
];
const DEMO_PREDICTIONS = [
  { id: "flights", categoryId: "flights", categoryName: "Flights", estimatedEur: 720 },
  { id: "hotel", categoryId: "hotel", categoryName: "Hotel", estimatedEur: 900 },
  { id: "food", categoryId: "food", categoryName: "Food", estimatedEur: 420 },
  { id: "transport", categoryId: "transport", categoryName: "Transport", estimatedEur: 260 },
  { id: "activities", categoryId: "activities", categoryName: "Activities", estimatedEur: 360 }
];
const DEMO_EXPENSES = [
  { id: "demo-exp-1", date: "2026-06-10", time: "09:10", categoryId: "flights", categoryName: "Flights", categoryIcon: "✈️", description: "Oslo round-trip flights", amountEur: 695, originalAmount: 695, originalCurrency: "EUR", expenseType: "shared", splitType: "equal", paidByMemberId: "demo-alex", paidByMemberName: "Alex", splitMemberIds: ["demo-alex", "demo-sam", "demo-maya"], paymentMethod: "card", notes: "" },
  { id: "demo-exp-2", date: "2026-06-10", time: "17:30", categoryId: "hotel", categoryName: "Hotel", categoryIcon: "🏨", description: "Bergen harbor hotel", amountEur: 870, originalAmount: 870, originalCurrency: "EUR", expenseType: "shared", splitType: "equal", paidByMemberId: "demo-sam", paidByMemberName: "Sam", splitMemberIds: ["demo-alex", "demo-sam", "demo-maya"], paymentMethod: "card", notes: "4 nights" },
  { id: "demo-exp-3", date: "2026-06-11", time: "12:20", categoryId: "food", categoryName: "Food", categoryIcon: "🍽️", description: "Fish market lunch", amountEur: 86, originalAmount: 86, originalCurrency: "EUR", expenseType: "shared", splitType: "equal", paidByMemberId: "demo-maya", paidByMemberName: "Maya", splitMemberIds: ["demo-alex", "demo-sam", "demo-maya"], paymentMethod: "card", notes: "" },
  { id: "demo-exp-4", date: "2026-06-12", time: "08:45", categoryId: "transport", categoryName: "Transport", categoryIcon: "🚆", description: "Flam railway tickets", amountEur: 240, originalAmount: 240, originalCurrency: "EUR", expenseType: "shared", splitType: "equal", paidByMemberId: "demo-alex", paidByMemberName: "Alex", splitMemberIds: ["demo-alex", "demo-sam", "demo-maya"], paymentMethod: "card", notes: "" },
  { id: "demo-exp-5", date: "2026-06-13", time: "14:00", categoryId: "activities", categoryName: "Activities", categoryIcon: "🎟️", description: "Fjord cruise", amountEur: 330, originalAmount: 330, originalCurrency: "EUR", expenseType: "shared", splitType: "equal", paidByMemberId: "demo-sam", paidByMemberName: "Sam", splitMemberIds: ["demo-alex", "demo-sam", "demo-maya"], paymentMethod: "card", notes: "" },
  { id: "demo-exp-6", date: "2026-06-14", time: "19:10", categoryId: "food", categoryName: "Food", categoryIcon: "🍽️", description: "Last dinner in Oslo", amountEur: 124, originalAmount: 124, originalCurrency: "EUR", expenseType: "shared", splitType: "equal", paidByMemberId: "demo-maya", paidByMemberName: "Maya", splitMemberIds: ["demo-alex", "demo-sam", "demo-maya"], paymentMethod: "card", notes: "" }
];
const DEMO_SETTLEMENTS = [
  { id: "demo-settle-1", date: "2026-06-15", fromMemberId: "demo-maya", fromMemberName: "Maya", toMemberId: "demo-alex", toMemberName: "Alex", amountEur: 120, notes: "Partial payback" }
];

function readTripImage(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please choose an image file."));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(
          1,
          TRIP_IMAGE_MAX_WIDTH / image.width,
          TRIP_IMAGE_MAX_HEIGHT / image.height
        );
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, width, height);
        let quality = TRIP_IMAGE_QUALITY;
        let dataUrl = canvas.toDataURL("image/jpeg", quality);
        while (dataUrl.length * 0.75 > TRIP_IMAGE_MAX_BYTES && quality > 0.36) {
          quality -= 0.08;
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(dataUrl);
      };
      image.onerror = () => reject(new Error("Could not read this image."));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read this image."));
    reader.readAsDataURL(file);
  });
}

function readProfileImage(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please choose an image file."));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const sourceSize = Math.min(image.width, image.height);
        const sourceX = Math.round((image.width - sourceSize) / 2);
        const sourceY = Math.round((image.height - sourceSize) / 2);
        const canvas = document.createElement("canvas");
        canvas.width = PROFILE_IMAGE_SIZE;
        canvas.height = PROFILE_IMAGE_SIZE;
        const context = canvas.getContext("2d");
        context.drawImage(
          image,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          PROFILE_IMAGE_SIZE,
          PROFILE_IMAGE_SIZE
        );
        resolve(canvas.toDataURL("image/jpeg", PROFILE_IMAGE_QUALITY));
      };
      image.onerror = () => reject(new Error("Could not read this image."));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read this image."));
    reader.readAsDataURL(file);
  });
}

function readStoredMemberDirectory() {
  try {
    const raw = window.localStorage.getItem(MEMBER_DIRECTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredMemberDirectory(membersList) {
  try {
    window.localStorage.setItem(
      MEMBER_DIRECTORY_STORAGE_KEY,
      JSON.stringify(membersList.slice(0, 80))
    );
  } catch {
    // Local storage is only a convenience cache; adding members still works.
  }
}

function mergeMemberDirectory(current, incoming) {
  const map = new Map();
  [...incoming, ...current].forEach(member => {
    const emailLower = getEmailLower(member.email);
    if (!emailLower) return;
    map.set(emailLower, {
      displayName: member.displayName || member.name || emailLower,
      email: emailLower
    });
  });
  return Array.from(map.values()).sort((a, b) =>
    String(a.displayName || a.email).localeCompare(String(b.displayName || b.email))
  );
}

// -------------------- Reusable Modal shell --------------------
function Modal({ isOpen, onClose, title, children }) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = e => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function parseIsoDateParts(isoDate) {
  const [year, month, day] = String(isoDate || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

function dateFromIso(isoDate) {
  const parts = parseIsoDateParts(isoDate);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day);
}

function isoFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function formatTripDateRange(startDate, endDate) {
  if (!startDate && !endDate) return "Select trip dates";
  if (startDate === endDate || !endDate) return startDate;
  return `${startDate} -> ${endDate}`;
}

function DateRangePicker({ label, startDate, endDate, onChange }) {
  const pickerRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [viewDate, setViewDate] = useState(() => dateFromIso(startDate) || new Date());
  const monthStart = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const calendarStart = addDays(monthStart, -monthStart.getDay());
  const monthName = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric"
  });

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = event => {
      if (pickerRef.current && !pickerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  function handleDateSelect(date) {
    const nextDate = isoFromDate(date);
    if (!selectingEnd) {
      onChange(nextDate, nextDate);
      setSelectingEnd(true);
      return;
    }

    if (startDate && nextDate < startDate) {
      onChange(nextDate, startDate);
    } else {
      onChange(startDate || nextDate, nextDate);
    }
    setSelectingEnd(false);
    setIsOpen(false);
  }

  return (
    <div className="date-range-picker" ref={pickerRef}>
      <span className="date-range-label">{label}</span>
      <button
        className="date-range-trigger"
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          const nextOpen = !isOpen;
          const currentStart = dateFromIso(startDate);
          if (nextOpen && currentStart) {
            setViewDate(new Date(currentStart.getFullYear(), currentStart.getMonth(), 1));
          }
          setIsOpen(nextOpen);
          setSelectingEnd(false);
        }}
      >
        <span>{formatTripDateRange(startDate, endDate)}</span>
        <span aria-hidden="true">Calendar</span>
      </button>
      {isOpen ? (
        <div className="date-range-popover">
          <div className="date-range-head">
            <button
              type="button"
              className="date-range-nav"
              aria-label="Previous month"
              onClick={() => setViewDate(date => addMonths(date, -1))}
            >
              &lt;
            </button>
            <strong>{monthName}</strong>
            <button
              type="button"
              className="date-range-nav"
              aria-label="Next month"
              onClick={() => setViewDate(date => addMonths(date, 1))}
            >
              &gt;
            </button>
          </div>
          <div className="date-range-status">
            {selectingEnd ? "Select an end date" : "Select a start date"}
          </div>
          <div className="date-range-weekdays">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="date-range-grid">
            {Array.from({ length: 42 }, (_, index) => {
              const day = addDays(calendarStart, index);
              const iso = isoFromDate(day);
              const isOutsideMonth = day.getMonth() !== monthStart.getMonth();
              const isStart = iso === startDate;
              const isEnd = iso === endDate;
              const isInRange =
                startDate &&
                endDate &&
                iso > startDate &&
                iso < endDate;
              return (
                <button
                  key={iso}
                  type="button"
                  className={[
                    "date-range-day",
                    isOutsideMonth ? "outside" : "",
                    isInRange ? "in-range" : "",
                    isStart || isEnd ? "selected" : ""
                  ].filter(Boolean).join(" ")}
                  onClick={() => handleDateSelect(day)}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Preloader() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setProgress(current => {
        if (current >= 100) return 100;
        const step = current < 70 ? 4 : current < 92 ? 2 : 1;
        return Math.min(100, current + step);
      });
    }, 90);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="preloader-page" aria-label="Loading TripHisaab">
      <div className="preloader-card">
        <img className="preloader-logo" src="/triphisaab-logo.svg" alt="TripHisaab" />
        <p className="preloader-tagline">Every trip. Every spend. Sorted.</p>
        <div
          className="flight-loader"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progress}
          style={{ "--progress": `${progress}%` }}
        >
          <div className="flight-trail" />
          <div className="flight-progress" />
          <span className="flight-plane" aria-hidden="true">✈</span>
        </div>
        <div className="preloader-percent">{progress}%</div>
      </div>
      <p className="preloader-credit">App created by- Vaibhav Walunj</p>
    </main>
  );
}

const TOUR_STEPS = [
  {
    targets: [],
    title: "Welcome to TripHisaab! 👋",
    body: "Your smart, free travel expense tracker — no ads, no paywalls, ever. Let me show you around in 4 quick steps.",
    position: "center",
  },
  {
    targets: ["create-trip"],
    title: "Create Your First Trip",
    body: "Start here! Give your trip a name, add your destination, travel dates, and currency. You can set a budget too.",
    position: "bottom",
  },
  {
    targets: ["home-stats"],
    title: "Your Travel Overview",
    body: "At a glance — see how many trips you've taken, total money spent, and any outstanding balances across all journeys.",
    position: "bottom",
  },
  {
    targets: ["sidebar-tour", "bottom-nav-tour"],
    title: "Everything Inside a Trip",
    body: "Open any trip to access its tabs: log Expenses, plan ahead with Plan Budget, manage Members, view Balances, and adjust Settings.",
    position: "right",
  },
  {
    targets: [],
    title: "You're All Set! ✈️",
    body: "Invite friends to split shared costs, then settle up at the end with one tap. 100% free, no ads — forever. Happy travels!",
    position: "center",
  },
];

function TourOverlay({ onComplete }) {
  const [step, setStep] = useState(0);
  const [spotlight, setSpotlight] = useState(null);
  const [tooltipPos, setTooltipPos] = useState(null);
  const [visible, setVisible] = useState(false);
  const tooltipRef = useRef(null);
  const current = TOUR_STEPS[step];
  const currentTargets = current.targets;
  const currentPosition = current.position;

  function findTarget(targets) {
    for (const t of targets) {
      const el = document.querySelector(`[data-tour="${t}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight) {
        return { el, r };
      }
    }
    return null;
  }

  useEffect(() => {
    const update = () => {
      const found = findTarget(currentTargets);
      if (!found) {
        setSpotlight(null);
        return;
      }
      const PAD = 10;
      const br = parseFloat(window.getComputedStyle(found.el).borderRadius) || 0;
      setSpotlight({
        top: found.r.top - PAD,
        left: found.r.left - PAD,
        width: found.r.width + PAD * 2,
        height: found.r.height + PAD * 2,
        borderRadius: br + PAD,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [currentTargets]);

  useEffect(() => {
    if (!tooltipRef.current) return;
    const tid = setTimeout(() => {
      if (!tooltipRef.current) return;
      const PAD = 16;
      const tt = tooltipRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top, left;
      const pos = spotlight ? currentPosition : "center";

      if (pos === "center" || !spotlight) {
        top = vh / 2 - tt.height / 2;
        left = vw / 2 - tt.width / 2;
      } else if (pos === "bottom") {
        top = spotlight.top + spotlight.height + 18;
        left = spotlight.left + spotlight.width / 2 - tt.width / 2;
      } else if (pos === "top") {
        top = spotlight.top - tt.height - 18;
        left = spotlight.left + spotlight.width / 2 - tt.width / 2;
      } else if (pos === "right") {
        top = spotlight.top + spotlight.height / 2 - tt.height / 2;
        left = spotlight.left + spotlight.width + 18;
        if (left + tt.width > vw - PAD) {
          top = spotlight.top + spotlight.height + 18;
          left = spotlight.left + spotlight.width / 2 - tt.width / 2;
        }
      } else if (pos === "left") {
        top = spotlight.top + spotlight.height / 2 - tt.height / 2;
        left = spotlight.left - tt.width - 18;
      }

      top = Math.max(PAD, Math.min(top, vh - tt.height - PAD));
      left = Math.max(PAD, Math.min(left, vw - tt.width - PAD));
      setTooltipPos({ top, left });
      setVisible(true);
    }, 60);
    return () => clearTimeout(tid);
  }, [currentPosition, spotlight]);

  const next = () => {
    setVisible(false);
    if (step < TOUR_STEPS.length - 1) {
      setStep(s => s + 1);
    } else {
      onComplete();
    }
  };
  const prev = () => {
    setVisible(false);
    setStep(s => s - 1);
  };
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <>
      <div className="tour-overlay" />
      {spotlight && (
        <div
          className="tour-spotlight"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            borderRadius: spotlight.borderRadius,
          }}
        />
      )}
      <div
        ref={tooltipRef}
        className="tour-tooltip"
        style={
          tooltipPos && visible
            ? { top: tooltipPos.top, left: tooltipPos.left, opacity: 1 }
            : { top: 0, left: 0, opacity: 0, pointerEvents: "none" }
        }
      >
        <div className="tour-header">
          <div className="tour-dots">
            {TOUR_STEPS.map((_, i) => (
              <div key={i} className={`tour-dot${i === step ? " tour-dot-active" : ""}`} />
            ))}
          </div>
          <button className="tour-skip-btn" type="button" onClick={onComplete}>
            Skip
          </button>
        </div>
        <h3 className="tour-title">{current.title}</h3>
        <p className="tour-body">{current.body}</p>
        <div className="tour-actions">
          {step > 0 && (
            <button className="secondary-button small-button" type="button" onClick={prev}>
              ← Back
            </button>
          )}
          <button className="primary-button small-button" type="button" onClick={next}>
            {isLast ? "Done ✓" : "Next →"}
          </button>
        </div>
      </div>
    </>
  );
}

function DonateButton({ inline = false }) {
  const btnRef = useRef(null);
  const reactId = useId();
  const idRef = useRef(`paypal-donate-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`);

  useEffect(() => {
    const id = idRef.current;
    const buttonHost = btnRef.current;
    let didCancel = false;

    if (buttonHost) {
      buttonHost.id = id;
      buttonHost.dataset.paypalRendered = "";
      buttonHost.replaceChildren();
    }

    const init = () => {
      if (
        !didCancel &&
        window.PayPal?.Donation?.Button &&
        buttonHost &&
        buttonHost.dataset.paypalRendered !== "true"
      ) {
        buttonHost.replaceChildren();
        buttonHost.dataset.paypalRendered = "true";
        window.PayPal.Donation.Button({
          env: "production",
          hosted_button_id: "LQTZMMTWGUUFU",
          image: {
            src: "https://www.paypalobjects.com/en_US/DK/i/btn/btn_donateCC_LG.gif",
            alt: "Donate with PayPal button",
            title: "PayPal - The safer, easier way to pay online!",
          },
        }).render("#" + id);
      }
    };

    if (window.PayPal?.Donation?.Button) {
      init();
    } else {
      const existing = document.querySelector('script[src*="donate-sdk"]');
      if (!existing) {
        const script = document.createElement("script");
        script.src = "https://www.paypalobjects.com/donate/sdk/donate-sdk.js";
        script.charset = "UTF-8";
        script.onload = init;
        document.body.appendChild(script);
      } else {
        existing.addEventListener("load", init);
      }
    }

    return () => {
      didCancel = true;
      const existing = document.querySelector('script[src*="donate-sdk"]');
      existing?.removeEventListener("load", init);
      if (buttonHost) {
        buttonHost.dataset.paypalRendered = "";
        buttonHost.replaceChildren();
      }
    };
  }, []);

  return (
    <div className={inline ? "inline-donate" : "sidebar-donate"}>
      {!inline && <p className="sidebar-donate-text">Like the App?<br />Buy me a Coffee! ☕</p>}
      <div ref={btnRef} />
    </div>
  );
}

function App() {
  // -------------------- Auth --------------------
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState({
    profileImageDataUrl: "",
    tutorialCompletedAt: null,
    loaded: false
  });
  const [authLoading, setAuthLoading] = useState(true);
  const [initialPreloading, setInitialPreloading] = useState(true);

  // -------------------- Invites --------------------
  const [pendingInvite, setPendingInvite] = useState(null);
  const [inviteDetails, setInviteDetails] = useState(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [creatingInvite, setCreatingInvite] = useState(false);

  // -------------------- Exchange rates --------------------
  const [exchangeRates, setExchangeRates] = useState(
    FALLBACK_EXCHANGE_RATES_FROM_EUR
  );
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesMeta, setRatesMeta] = useState({
    status: "fallback",
    source: "Fallback fixed MVP rates",
    updatedAt: "",
    error: ""
  });

  // -------------------- Trips --------------------
  const [trips, setTrips] = useState([]);
  const [tripLoading, setTripLoading] = useState(false);
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isSettlementModalOpen, setIsSettlementModalOpen] = useState(false);
  const [isAddExpenseModalOpen, setIsAddExpenseModalOpen] = useState(false);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isInviteShareModalOpen, setIsInviteShareModalOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [tripSearch, setTripSearch] = useState("");
  const [showLanding, setShowLanding] = useState(() => {
    try {
      return localStorage.getItem(APP_VIEW_STORAGE_KEY) !== "app";
    } catch {
      return true;
    }
  });
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isStandaloneApp, setIsStandaloneApp] = useState(false);

  const [selectedTrip, setSelectedTrip] = useState(null);
  const [activeTab, setActiveTab] = useState(() => {
    try {
      return localStorage.getItem(LAST_TAB_STORAGE_KEY) || "dashboard";
    } catch {
      return "dashboard";
    }
  });
  const [tripDataLoading, setTripDataLoading] = useState(false);
  const [deletingTrip, setDeletingTrip] = useState(false);
  const [leavingTrip, setLeavingTrip] = useState(false);

  // -------------------- Trip data --------------------
  const [members, setMembers] = useState([]);
  const [memberProfilesByEmail, setMemberProfilesByEmail] = useState({});
  const [categories, setCategories] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [settlements, setSettlements] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [selectedNotification, setSelectedNotification] = useState(null);

  // -------------------- Forms --------------------
  const [memberForm, setMemberForm] = useState({ displayName: "", email: "" });
  const [memberSearch, setMemberSearch] = useState("");
  const [memberDirectory, setMemberDirectory] = useState(() => readStoredMemberDirectory());
  const [savingMember, setSavingMember] = useState(false);
  const [updatingMemberId, setUpdatingMemberId] = useState("");

  const [settlementForm, setSettlementForm] = useState({
    date: todayIso(),
    fromMemberId: "",
    toMemberId: "",
    amountEur: "",
    notes: ""
  });
  const [savingSettlement, setSavingSettlement] = useState(false);
  const [approvingNotificationId, setApprovingNotificationId] = useState("");
  const [expandedSmartSettleId, setExpandedSmartSettleId] = useState("");
  const [pendingSmartSettlement, setPendingSmartSettlement] = useState(null);
  const [smartSettleToast, setSmartSettleToast] = useState("");
  const [settlementMode, setSettlementMode] = useState("fewest_payments");
  const [settlementGroups, setSettlementGroups] = useState([]);
  const [settlementGroupForm, setSettlementGroupForm] = useState({ name: "", memberIds: [], type: "couple" });
  const [editingSettlementGroupId, setEditingSettlementGroupId] = useState(null);
  const [showSettlementGroupForm, setShowSettlementGroupForm] = useState(false);

  const [savingPredictions, setSavingPredictions] = useState(false);
  const [budgetForm, setBudgetForm] = useState(EMPTY_BUDGET_FORM);
  const [editingBudgetId, setEditingBudgetId] = useState(null);

  const [settingsTripForm, setSettingsTripForm] = useState({
    name: "",
    startDate: "",
    endDate: "",
    defaultCurrency: "EUR",
    imageDataUrl: ""
  });
  const [savingTripSettings, setSavingTripSettings] = useState(false);

  const [savingExpense, setSavingExpense] = useState(false);
  const [expenseFeedback, setExpenseFeedback] = useState(null);
  const [expenseSearch, setExpenseSearch] = useState("");
  const [expenseFilter, setExpenseFilter] = useState("all");
  const [expenseSort, setExpenseSort] = useState("newest");
  const [expensePage, setExpensePage] = useState(1);
  const [expenseForm, setExpenseForm] = useState({
    ...EMPTY_EXPENSE_FORM,
    date: todayIso(),
    time: nowTimeIso()
  });

  const [editingExpenseId, setEditingExpenseId] = useState(null);
  const [savingExpenseEdit, setSavingExpenseEdit] = useState(false);
  const [expenseEditForm, setExpenseEditForm] = useState({
    ...EMPTY_EXPENSE_FORM,
    date: todayIso(),
    time: nowTimeIso()
  });
  const [expenseFormTab, setExpenseFormTab] = useState("basic");
  const expenseTouchStartXRef = useRef(null);

  const [categoryForm, setCategoryForm] = useState({
    name: "",
    type: "Daily",
    icon: "📌",
    color: "#0F766E"
  });
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [categoryStatusFilter, setCategoryStatusFilter] = useState("all");
  const [categoryPage, setCategoryPage] = useState(1);
  const [savingProfilePicture, setSavingProfilePicture] = useState(false);

  const [form, setForm] = useState({
    name: "",
    startDate: todayIso(),
    endDate: todayIso(),
    defaultCurrency: "EUR",
    imageDataUrl: ""
  });

  const [editingTripId, setEditingTripId] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    startDate: todayIso(),
    endDate: todayIso(),
    defaultCurrency: "EUR",
    status: "Active",
    imageDataUrl: ""
  });

  // -------------------- Effects --------------------
  useEffect(() => {
    loadLiveExchangeRates();
    const inviteFromUrl = getInviteFromUrl();
    if (inviteFromUrl) setPendingInvite(inviteFromUrl);
    setIsStandaloneApp(
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      window.navigator.standalone === true
    );
    const preloadTimer = window.setTimeout(() => {
      setInitialPreloading(false);
    }, 1800);
    return () => window.clearTimeout(preloadTimer);
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = event => {
      event.preventDefault();
      setDeferredInstallPrompt(event);
      setIsInstallable(true);
    };
    const handleAppInstalled = () => {
      setDeferredInstallPrompt(null);
      setIsInstallable(false);
      setIsStandaloneApp(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async currentUser => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser) {
        setShowLanding(false);
        try {
          localStorage.setItem(APP_VIEW_STORAGE_KEY, "app");
        } catch {
          /* localStorage unavailable */
        }
        await createUserProfileIfNeeded(currentUser);
        const loadedTrips = await loadTrips(currentUser.uid, currentUser.email);
        try {
          const lastTripId = localStorage.getItem(LAST_TRIP_STORAGE_KEY);
          if (lastTripId) {
            const lastTrip = loadedTrips.find(trip => trip.id === lastTripId);
            if (lastTrip) {
              setSelectedTrip(lastTrip);
              setActiveTab(localStorage.getItem(LAST_TAB_STORAGE_KEY) || "dashboard");
              await loadTripData(lastTrip.id, lastTrip);
            }
          }
        } catch {
          /* localStorage unavailable */
        }
      } else {
        setTrips([]);
        setSelectedTrip(null);
        setShowLanding(true);
        setUserProfile({
          profileImageDataUrl: "",
          tutorialCompletedAt: null,
          loaded: false
        });
      }
    });
    return () => unsubscribe();
  // Auth restore intentionally runs once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(APP_VIEW_STORAGE_KEY, showLanding ? "landing" : "app");
    } catch {
      /* localStorage unavailable */
    }
  }, [showLanding]);

  useEffect(() => {
    try {
      if (selectedTrip && selectedTrip.id !== DEMO_TRIP_ID && selectedTrip.isDemo !== true) {
        localStorage.setItem(LAST_TRIP_STORAGE_KEY, selectedTrip.id);
      } else if (!selectedTrip) {
        localStorage.removeItem(LAST_TRIP_STORAGE_KEY);
      }
    } catch {
      /* localStorage unavailable */
    }
  }, [selectedTrip]);

  // Restore settlement mode and groups from localStorage when trip changes.
  useEffect(() => {
    if (!selectedTrip) return;
    const tripId = selectedTrip.id;
    try {
      const storedMode = localStorage.getItem(`triphisaab-settle-mode-${tripId}`);
      if (storedMode) setSettlementMode(storedMode);
      else setSettlementMode("fewest_payments");
      const storedGroups = localStorage.getItem(`triphisaab-settle-groups-${tripId}`);
      if (storedGroups) setSettlementGroups(JSON.parse(storedGroups));
      else setSettlementGroups([]);
    } catch {
      setSettlementMode("fewest_payments");
      setSettlementGroups([]);
    }
    setShowSettlementGroupForm(false);
    setEditingSettlementGroupId(null);
  }, [selectedTrip?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_TAB_STORAGE_KEY, activeTab);
    } catch {
      /* localStorage unavailable */
    }
  }, [activeTab]);

  useEffect(() => {
    if (!user || !userProfile.loaded || pendingInvite) return;
    if (!userProfile.tutorialCompletedAt) setIsTutorialOpen(true);
  }, [pendingInvite, user, userProfile.loaded, userProfile.tutorialCompletedAt]);

  useEffect(() => {
    if (user && pendingInvite) loadInviteDetails(pendingInvite);
  }, [user, pendingInvite]);

  useEffect(() => {
    if (selectedTrip) {
      setSettingsTripForm({
        name: selectedTrip.name || "",
        startDate: selectedTrip.startDate || todayIso(),
        endDate: selectedTrip.endDate || todayIso(),
        defaultCurrency: selectedTrip.defaultCurrency || "EUR",
        imageDataUrl: selectedTrip.imageDataUrl || "",
      });
    }
  }, [selectedTrip]);

  useEffect(() => {
    if (!smartSettleToast) return;
    const timer = window.setTimeout(() => setSmartSettleToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [smartSettleToast]);

  useEffect(() => {
    setExpensePage(1);
  }, [expenseFilter, expenseSearch, expenseSort, selectedTrip?.id]);

  // -------------------- Memoized lookups & derived data --------------------
  const membersById = useMemo(() => {
    const map = new Map();
    members.forEach(m => map.set(m.id, m));
    return map;
  }, [members]);

  const categoriesById = useMemo(() => {
    const map = new Map();
    categories.forEach(c => map.set(c.id, c));
    return map;
  }, [categories]);

  const groupBudgetByCategoryId = useMemo(() => {
    const map = new Map();
    predictions
      .filter(p => normalizeBudgetScope(p) === "group")
      .forEach(p => {
        map.set(
          p.categoryId,
          (map.get(p.categoryId) || 0) + Number(p.estimatedEur || 0)
        );
      });
    return map;
  }, [predictions]);

  const activeMembers = useMemo(
    () => members.filter(m => m.status !== "inactive"),
    [members]
  );

  const activeCategories = useMemo(
    () => categories.filter(c => c.isActive),
    [categories]
  );

  const totals = useMemo(() => {
    let actual = 0;
    let shared = 0;
    expenses.forEach(e => {
      const amount = Number(e.amountEur || 0);
      actual += amount;
      if (e.expenseType === "shared") shared += amount;
    });
    const predicted = predictions
      .filter(p => normalizeBudgetScope(p) === "group")
      .reduce(
      (sum, p) => sum + Number(p.estimatedEur || 0),
      0
    );
    const settled = settlements.reduce(
      (sum, s) => sum + Number(s.amountEur || 0),
      0
    );
    return { predicted, actual, shared, settled };
  }, [expenses, predictions, settlements]);

  const visiblePlanTotal = useMemo(
    () => predictions.reduce((sum, p) => sum + Number(p.estimatedEur || 0), 0),
    [predictions]
  );

  const actualByCategoryId = useMemo(() => {
    const map = new Map();
    expenses.forEach(e => {
      map.set(e.categoryId, (map.get(e.categoryId) || 0) + Number(e.amountEur || 0));
    });
    return map;
  }, [expenses]);

  const memberNameOf = useCallback(
    memberId => {
      const m = membersById.get(memberId);
      if (!m) return "Unknown member";
      return cleanDisplayName(m.displayName || m.email || "Unnamed member");
    },
    [membersById]
  );

  const memberImageOf = useCallback(
    memberOrId => {
      const member =
        typeof memberOrId === "string" ? membersById.get(memberOrId) : memberOrId;
      if (!member) return "";
      const emailLower = getEmailLower(member.email);
      if (!emailLower) return "";
      return memberProfilesByEmail[emailLower]?.profileImageDataUrl || "";
    },
    [memberProfilesByEmail, membersById]
  );

  const memberInitialOf = useCallback(
    memberOrId => {
      const member =
        typeof memberOrId === "string" ? membersById.get(memberOrId) : memberOrId;
      return (member?.displayName || member?.name || member?.email || "?")
        .slice(0, 1)
        .toUpperCase();
    },
    [membersById]
  );

  const balances = useMemo(() => {
    const groupSettlements = settlements.filter(s => (s.settlementLayer || "group") === "group");
    return calculateBalances(
      getGroupSettlementExpenses(expenses),
      activeMembers,
      groupSettlements
    );
  }, [activeMembers, expenses, settlements]);

  const currentUserMemberId = useMemo(
    () => {
      if (!user) return "";
      const byUserId = members.find(m => m.userId === user.uid);
      if (byUserId) return byUserId.id;
      const emailLower = getEmailLower(user.email);
      const byEmail = members.find(
        m => getEmailLower(m.email) === emailLower
      );
      return byEmail?.id || "";
    },
    [members, user]
  );

  const currentUserBalance = useMemo(
    () => balances.find(b => b.memberId === currentUserMemberId) || null,
    [balances, currentUserMemberId]
  );

  const expenseStats = useMemo(() => {
    const today = new Date(`${todayIso()}T00:00:00`);
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 6);

    return expenses.reduce(
      (stats, expense) => {
        const amount = Number(expense.amountEur || 0);
        if (amount <= 0) return stats;

        stats.total += amount;
        if (expense.expenseType === "shared") stats.shared += amount;
        else stats.personal += amount;

        const expenseDate = expense.date ? new Date(`${expense.date}T00:00:00`) : null;
        if (expenseDate && !Number.isNaN(expenseDate.getTime()) && expenseDate >= weekStart && expenseDate <= today) {
          stats.thisWeek += amount;
          stats.thisWeekCount += 1;
        }

        if (
          expense.expenseType === "shared" &&
          (!Array.isArray(expense.splitMemberIds) || expense.splitMemberIds.length === 0)
        ) {
          stats.pendingSplit += 1;
        }

        return stats;
      },
      {
        total: 0,
        shared: 0,
        personal: 0,
        thisWeek: 0,
        thisWeekCount: 0,
        pendingSplit: 0
      }
    );
  }, [expenses]);

  const expenseRows = useMemo(() => {
    const queryText = expenseSearch.trim().toLowerCase();

    const dateTimeValue = expense => {
      const value = `${expense.date || ""}T${expense.time || "00:00"}`;
      const parsed = new Date(value).getTime();
      return Number.isNaN(parsed) ? 0 : parsed;
    };

    const matchesFilter = expense => {
      if (expenseFilter === "shared") return expense.expenseType === "shared";
      if (expenseFilter === "personal") return expense.expenseType !== "shared";
      if (expenseFilter === "pending") {
        return (
          expense.expenseType === "shared" &&
          (!Array.isArray(expense.splitMemberIds) || expense.splitMemberIds.length === 0)
        );
      }
      return true;
    };

    const matchesSearch = expense => {
      if (!queryText) return true;
      const participantNames = (expense.splitMemberIds || []).map(memberNameOf).join(" ");
      return [
        expense.description,
        expense.categoryName,
        expense.notes,
        memberNameOf(expense.paidByMemberId),
        participantNames
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(queryText);
    };

    return expenses
      .filter(expense => matchesFilter(expense) && matchesSearch(expense))
      .sort((a, b) => {
        if (expenseSort === "oldest") return dateTimeValue(a) - dateTimeValue(b);
        if (expenseSort === "highest") return Number(b.amountEur || 0) - Number(a.amountEur || 0);
        if (expenseSort === "lowest") return Number(a.amountEur || 0) - Number(b.amountEur || 0);
        if (expenseSort === "category") {
          return String(a.categoryName || "").localeCompare(String(b.categoryName || ""));
        }
        return dateTimeValue(b) - dateTimeValue(a);
      });
  }, [expenseFilter, expenseSearch, expenseSort, expenses, memberNameOf]);

  const pagedExpenseRows = useMemo(() => {
    const pageSize = 5;
    const start = (expensePage - 1) * pageSize;
    return expenseRows.slice(start, start + pageSize);
  }, [expensePage, expenseRows]);

  const expenseTotalPages = Math.max(1, Math.ceil(expenseRows.length / 5));

  const visibleNotifications = useMemo(
    () =>
      notifications
        .filter(n => !n.recipientMemberId || n.recipientMemberId === currentUserMemberId)
        .sort((a, b) =>
          String(b.createdAtIso || "").localeCompare(String(a.createdAtIso || ""))
        ),
    [currentUserMemberId, notifications]
  );

  const smartSettleSummary = useMemo(
    () =>
      getSmartSettleSummaryByMode(
        expenses,
        members,
        currentUserMemberId,
        settlements,
        Boolean(user && selectedTrip && selectedTrip.ownerId === user.uid),
        selectedTrip?.defaultCurrency || "EUR",
        settlementMode,
        settlementGroups
      ),
    [currentUserMemberId, expenses, members, selectedTrip, settlements, user, settlementMode, settlementGroups]
  );

  const unreadNotificationCount = useMemo(
    () =>
      visibleNotifications.filter(n =>
        n.status === "pending" || n.status === "unread"
      ).length,
    [visibleNotifications]
  );

  const memberSuggestions = useMemo(() => {
    const currentTripEmails = new Set(members.map(m => getEmailLower(m.email)));
    const q = memberSearch.trim().toLowerCase();
    return memberDirectory
      .filter(member => !currentTripEmails.has(getEmailLower(member.email)))
      .filter(member => {
        if (!q) return true;
        return (
          String(member.displayName || "").toLowerCase().includes(q) ||
          String(member.email || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 6);
  }, [memberDirectory, memberSearch, members]);

  const defaultExpenseCategoryId = useMemo(() => {
    const activeIds = new Set(activeCategories.map(c => c.id));
    const sortedExpenses = [...expenses].sort((a, b) => {
      const aKey = `${a.date || ""} ${a.time || ""}`;
      const bKey = `${b.date || ""} ${b.time || ""}`;
      return bKey.localeCompare(aKey);
    });
    const lastUsed = sortedExpenses.find(e => activeIds.has(e.categoryId))?.categoryId;
    if (lastUsed) return lastUsed;

    const counts = new Map();
    expenses.forEach(e => {
      if (activeIds.has(e.categoryId)) {
        counts.set(e.categoryId, (counts.get(e.categoryId) || 0) + 1);
      }
    });
    const mostCommon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return mostCommon || activeCategories[0]?.id || "";
  }, [activeCategories, expenses]);

  const suggestedSettlements = useMemo(() => {
    const debtors = balances
      .filter(b => b.net < -0.01)
      .map(b => ({ ...b, amount: Math.abs(b.net) }))
      .sort((a, b) => b.amount - a.amount);
    const creditors = balances
      .filter(b => b.net > 0.01)
      .map(b => ({ ...b, amount: b.net }))
      .sort((a, b) => b.amount - a.amount);

    const out = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i];
      const c = creditors[j];
      const amount = Math.min(d.amount, c.amount);
      if (amount > 0.01) {
        out.push({
          fromMemberId: d.memberId,
          fromName: d.name,
          toMemberId: c.memberId,
          toName: c.name,
          amount
        });
      }
      d.amount -= amount;
      c.amount -= amount;
      if (d.amount <= 0.01) i += 1;
      if (c.amount <= 0.01) j += 1;
    }
    return out;
  }, [balances]);

  // -------------------- Currency helpers (bound to current rates) --------------------
  const getCurrencyRate = useCallback(
    currency => getRate(exchangeRates, currency),
    [exchangeRates]
  );
  const convertToEur = useCallback(
    (amount, currency) => convertAmount(exchangeRates, amount, currency),
    [exchangeRates]
  );

  const ratesStatusLabel = useMemo(() => {
    if (ratesMeta.status === "live") {
      return `Live rates from ${ratesMeta.source}${
        ratesMeta.updatedAt ? ` · ${ratesMeta.updatedAt}` : ""
      }`;
    }
    if (ratesMeta.status === "cached") {
      return `Cached rates from ${ratesMeta.source}${
        ratesMeta.updatedAt ? ` · ${ratesMeta.updatedAt}` : ""
      }`;
    }
    return "Fallback fixed MVP rates";
  }, [ratesMeta]);

  // -------------------- Rates --------------------
  async function loadLiveExchangeRates() {
    setRatesLoading(true);

    const cached = readRatesCache();
    if (cached?.rates) {
      setExchangeRates({ ...FALLBACK_EXCHANGE_RATES_FROM_EUR, ...cached.rates });
      setRatesMeta({
        status: "cached",
        source: cached.source || "Cached Frankfurter rates",
        updatedAt: cached.updatedAt || "",
        error: ""
      });
    }

    try {
      const quotes = SUPPORTED_CURRENCIES.filter(c => c !== "EUR").join(",");
      const response = await fetch(
        `https://api.frankfurter.dev/v2/rates?base=EUR&quotes=${quotes}`
      );
      if (!response.ok) throw new Error(`Rate server returned ${response.status}`);

      const data = await response.json();
      const apiRates = data.rates || data.quotes || {};

      const cleanRates = { EUR: 1 };
      SUPPORTED_CURRENCIES.forEach(c => {
        if (c === "EUR") return;
        const r = Number(apiRates[c]);
        cleanRates[c] = r > 0 ? r : FALLBACK_EXCHANGE_RATES_FROM_EUR[c];
      });
      const updatedAt = data.date || todayIso();

      setExchangeRates({ ...FALLBACK_EXCHANGE_RATES_FROM_EUR, ...cleanRates });
      setRatesMeta({
        status: "live",
        source: "Frankfurter API",
        updatedAt,
        error: ""
      });
      writeRatesCache({
        rates: cleanRates,
        source: "Frankfurter API",
        updatedAt,
        cachedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("Could not load live exchange rates:", error);
      if (!cached) {
        setExchangeRates(FALLBACK_EXCHANGE_RATES_FROM_EUR);
        setRatesMeta({
          status: "fallback",
          source: "Fallback fixed MVP rates",
          updatedAt: "",
          error: String(error.message || error)
        });
      } else {
        setRatesMeta(prev => ({
          ...prev,
          status: "cached",
          error: String(error.message || error)
        }));
      }
    } finally {
      setRatesLoading(false);
    }
  }

  // -------------------- Auth & user profile --------------------
  function canManageTrip(trip) {
    return Boolean(user && trip && trip.ownerId === user.uid);
  }

  function canManageSelectedTrip() {
    return canManageTrip(selectedTrip);
  }

  function isDemoMode() {
    return selectedTrip?.id === DEMO_TRIP_ID || selectedTrip?.isDemo === true;
  }

  function normalizeBudgetScope(entry) {
    if (entry?.scope === "selected" || entry?.scope === "me") return entry.scope;
    return "group";
  }

  function budgetScopeLabel(entry) {
    const scope = normalizeBudgetScope(entry);
    return BUDGET_SCOPE_OPTIONS.find(option => option.value === scope)?.label || "Whole group";
  }

  function budgetVisibleNames(entry) {
    const scope = normalizeBudgetScope(entry);
    if (scope === "group") return "Everyone";
    const ids = entry.visibleMemberIds?.length
      ? entry.visibleMemberIds
      : entry.memberIds || [];
    if (scope === "me") return "Only me";
    return ids.map(memberNameOf).join(", ") || "Selected people";
  }

  async function createUserProfileIfNeeded(currentUser) {
    const userRef = doc(db, "users", currentUser.uid);
    const userSnap = await getDoc(userRef);
    const existingProfile = userSnap.exists() ? userSnap.data() : {};
    const profile = {
      email: currentUser.email,
      emailLower: getEmailLower(currentUser.email),
      displayName: currentUser.displayName || "",
      photoURL: currentUser.photoURL || "",
      profileImageDataUrl: existingProfile.profileImageDataUrl || "",
      tutorialCompletedAt: existingProfile.tutorialCompletedAt || null,
      updatedAt: serverTimestamp()
    };
    if (!userSnap.exists()) {
      await setDoc(userRef, { ...profile, createdAt: serverTimestamp() });
    } else {
      await setDoc(userRef, profile, { merge: true });
    }
    setUserProfile({
      profileImageDataUrl: profile.profileImageDataUrl,
      tutorialCompletedAt: profile.tutorialCompletedAt,
      loaded: true
    });
  }

  async function markTutorialSeen() {
    setIsTutorialOpen(false);
    if (!user) return;
    setUserProfile(current => ({
      ...current,
      tutorialCompletedAt: current.tutorialCompletedAt || new Date().toISOString()
    }));
    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          email: user.email,
          emailLower: getEmailLower(user.email),
          displayName: user.displayName || "",
          tutorialCompletedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Could not save tutorial status:", error);
    }
  }

  async function saveProfilePicture(profileImageDataUrl) {
    if (!user) return;
    setSavingProfilePicture(true);
    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          email: user.email,
          emailLower: getEmailLower(user.email),
          displayName: user.displayName || "",
          profileImageDataUrl,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
      setUserProfile(current => ({ ...current, profileImageDataUrl }));
      const emailLower = getEmailLower(user.email);
      if (emailLower) {
        setMemberProfilesByEmail(current => ({
          ...current,
          [emailLower]: { profileImageDataUrl }
        }));
      }
    } catch (error) {
      console.error("Could not save profile picture:", error);
      alert("Could not save profile picture.");
    } finally {
      setSavingProfilePicture(false);
    }
  }

  async function handleProfilePictureChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imageDataUrl = await readProfileImage(file);
      await saveProfilePicture(imageDataUrl);
    } catch (error) {
      alert(error.message || "Could not upload profile picture.");
    } finally {
      event.target.value = "";
    }
  }

  async function removeProfilePicture() {
    await saveProfilePicture("");
  }

  async function loadMemberProfiles(memberList) {
    const emailLowers = Array.from(
      new Set(
        memberList
          .map(member => getEmailLower(member.email))
          .filter(Boolean)
      )
    );
    const currentUserEmailLower = getEmailLower(user?.email);
    const profiles = {};

    if (currentUserEmailLower && emailLowers.includes(currentUserEmailLower)) {
      profiles[currentUserEmailLower] = {
        profileImageDataUrl: userProfile.profileImageDataUrl || ""
      };
    }

    if (emailLowers.length === 0) {
      setMemberProfilesByEmail(profiles);
      return;
    }

    try {
      const chunks = [];
      for (let i = 0; i < emailLowers.length; i += 10) {
        chunks.push(emailLowers.slice(i, i + 10));
      }

      const snapshots = await Promise.all(
        chunks.map(chunk =>
          getDocs(query(collection(db, "users"), where("emailLower", "in", chunk)))
        )
      );

      snapshots.forEach(snapshot => {
        snapshot.docs.forEach(profileDoc => {
          const profile = profileDoc.data();
          const emailLower = getEmailLower(profile.emailLower || profile.email);
          if (!emailLower) return;
          profiles[emailLower] = {
            profileImageDataUrl: profile.profileImageDataUrl || ""
          };
        });
      });
    } catch (error) {
      console.warn("Could not load member profile images:", error);
    }

    setMemberProfilesByEmail(profiles);
  }

  async function handleGoogleLogin() {
    try {
      setShowLanding(false);
      try {
        localStorage.setItem(APP_VIEW_STORAGE_KEY, "app");
      } catch {
        /* localStorage unavailable */
      }
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Google login failed:", error);
      alert(
        "Google login failed. Check that Google sign-in is enabled in Firebase Authentication."
      );
    }
  }

  async function handleInstallApp() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setDeferredInstallPrompt(null);
        setIsInstallable(false);
      }
      return;
    }

    alert(
      "To add TripHisaab to your home screen:\n\nOn iPhone/iPad: tap Share, then Add to Home Screen.\nOn Android: open the browser menu, then tap Install app or Add to Home screen."
    );
  }

  function renderInstallButton({ compact = false } = {}) {
    if (isStandaloneApp) return null;
    return (
      <button
        className={`secondary-button ${compact ? "small-button" : ""}`}
        type="button"
        onClick={handleInstallApp}
      >
        {compact ? (isInstallable ? "Install" : "Add") : isInstallable ? "Install app" : "Add to Home Screen"}
      </button>
    );
  }

  async function handleLogout() {
    try {
      await signOut(auth);
      setShowLanding(true);
      try {
        localStorage.setItem(APP_VIEW_STORAGE_KEY, "landing");
        localStorage.removeItem(LAST_TRIP_STORAGE_KEY);
      } catch {
        /* localStorage unavailable */
      }
      closeTrip();
    } catch (error) {
      console.error("Logout failed:", error);
      alert("Logout failed. Please try again.");
    }
  }

  // -------------------- Invites --------------------
  function clearInviteUrl() {
    window.history.replaceState({}, "", window.location.origin + "/");
    setPendingInvite(null);
    setInviteDetails(null);
    setInviteError("");
  }

  async function loadInviteDetails(invite) {
    if (!invite?.tripId || !invite?.inviteId) return;
    setInviteLoading(true);
    setInviteError("");
    try {
      const inviteRef = doc(db, "trips", invite.tripId, "invites", invite.inviteId);
      const snap = await getDoc(inviteRef);
      if (!snap.exists()) {
        setInviteError("This invite link is invalid or expired.");
        setInviteDetails(null);
        return;
      }
      const data = snap.data();
      if (data.status !== "active") {
        setInviteError("This invite link is no longer active.");
        setInviteDetails(null);
        return;
      }
      setInviteDetails({ id: snap.id, ...data });
    } catch (error) {
      console.error("Could not load invite:", error);
      setInviteError("Could not load invite. Check your connection and rules.");
      setInviteDetails(null);
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleAcceptInvite() {
    if (!user || !pendingInvite || !inviteDetails) return;
    setAcceptingInvite(true);
    try {
      if (inviteDetails.ownerId === user.uid) {
        const tripSnap = await getDoc(doc(db, "trips", pendingInvite.tripId));
        await loadTrips(user.uid, user.email);
        clearInviteUrl();
        if (tripSnap.exists()) {
          await openTrip({
            id: tripSnap.id,
            accessRole: "owner",
            ...tripSnap.data()
          });
        }
        return;
      }

      const emailLower = getEmailLower(user.email);
      const displayName = user.displayName || emailLower;
      const batch = writeBatch(db);

      batch.set(
        doc(db, "trips", pendingInvite.tripId, "members", emailLower),
        {
          displayName,
          email: emailLower,
          emailLower,
          role: "member",
          status: "active",
          isOwner: false,
          userId: user.uid,
          photoURL: user.photoURL || "",
          inviteId: pendingInvite.inviteId,
          invitedBy: inviteDetails.createdBy || "",
          joinedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      batch.set(
        doc(db, "emailAccess", emailLower, "trips", pendingInvite.tripId),
        {
          tripId: pendingInvite.tripId,
          role: "member",
          ownerId: inviteDetails.ownerId,
          ownerEmailLower: inviteDetails.ownerEmailLower || "",
          status: "active",
          inviteId: pendingInvite.inviteId,
          acceptedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      await batch.commit();
      await setDoc(
        doc(db, "users", user.uid),
        {
          leftTrips: {
            [pendingInvite.tripId]: false
          },
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      const tripSnap = await getDoc(doc(db, "trips", pendingInvite.tripId));
      await loadTrips(user.uid, user.email);
      clearInviteUrl();
      if (tripSnap.exists()) {
        await openTrip({
          id: tripSnap.id,
          accessRole: "member",
          ...tripSnap.data()
        });
      }
    } catch (error) {
      console.error("Could not accept invite:", error);
      alert("Could not join trip. Check your Firestore rules.");
    } finally {
      setAcceptingInvite(false);
    }
  }

  async function createInviteLink() {
    if (!selectedTrip || !user) return;
    if (!canManageSelectedTrip()) {
      alert("Only the trip owner can create invite links.");
      return "";
    }
    setCreatingInvite(true);
    try {
      const inviteRef = doc(collection(db, "trips", selectedTrip.id, "invites"));
      await setDoc(inviteRef, {
        tripId: selectedTrip.id,
        tripName: selectedTrip.name,
        startDate: selectedTrip.startDate || "",
        endDate: selectedTrip.endDate || "",
        defaultCurrency: selectedTrip.defaultCurrency || "",
        tripStatus: selectedTrip.status || "",
        ownerId: selectedTrip.ownerId,
        ownerEmail: selectedTrip.ownerEmail || user.email,
        ownerEmailLower:
          selectedTrip.ownerEmailLower || getEmailLower(user.email),
        createdBy: user.uid,
        status: "active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      const link = buildInviteLink(selectedTrip.id, inviteRef.id);
      setInviteLink(link);
      return link;
    } catch (error) {
      console.error("Could not create invite link:", error);
      alert("Could not create invite link. Check your Firestore rules.");
      return "";
    } finally {
      setCreatingInvite(false);
    }
  }

  async function handleCreateInviteLink() {
    const link = await createInviteLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      alert("Invite link created and copied.");
    } catch {
      alert("Invite link created. Copy it from the field below.");
    }
  }

  async function openInviteShareModal() {
    const link = inviteLink || (await createInviteLink());
    if (link) setIsInviteShareModalOpen(true);
  }

  function inviteShareMessage({ includeLink = true } = {}) {
    if (!selectedTrip || !inviteLink) {
      return `Join my trip "${selectedTrip?.name || "Trip"}": ${inviteLink}`;
    }

    const summary = [
      `Trip: ${selectedTrip.name || "Trip"}`,
      selectedTrip.startDate && selectedTrip.endDate
        ? `Dates: ${selectedTrip.startDate} to ${selectedTrip.endDate}`
        : "",
      selectedTrip.defaultCurrency ? `Currency: ${selectedTrip.defaultCurrency}` : "",
      selectedTrip.status ? `Status: ${selectedTrip.status}` : ""
    ].filter(Boolean);

    if (summary.length <= 1) {
      return `Join my trip "${selectedTrip.name || "Trip"}": ${inviteLink}`;
    }

    const lines = [
      "Join my TripHisaab trip",
      "",
      ...summary,
    ];

    if (includeLink) {
      lines.push("", `Invite link: ${inviteLink}`);
    }

    return lines.join("\n");
  }

  async function shareInviteNative() {
    if (!inviteLink) return;
    const text = inviteShareMessage({ includeLink: false });
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join ${selectedTrip?.name || "my trip"}`,
          text,
          url: inviteLink
        });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    await copyInviteLink();
  }

  function shareInviteWhatsApp() {
    if (!inviteLink) return;
    window.open(
      `https://wa.me/?text=${encodeURIComponent(inviteShareMessage())}`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  function shareInviteMessage() {
    if (!inviteLink) return;
    window.location.href = `sms:?&body=${encodeURIComponent(inviteShareMessage())}`;
  }

  async function copyInviteLink() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      alert("Invite link copied.");
    } catch {
      alert("Could not copy automatically. Select and copy the link manually.");
    }
  }

  // -------------------- Trips --------------------
  async function loadTrips(userId, email) {
    setTripLoading(true);
    try {
      const tripsMap = new Map();
      const emailLower = getEmailLower(email);

      // Fetch owner trips and email-access list in parallel
      const [ownerSnap, accessSnap, userSnap] = await Promise.all([
        getDocs(query(collection(db, "trips"), where("ownerId", "==", userId))),
        emailLower
          ? getDocs(collection(db, "emailAccess", emailLower, "trips"))
          : Promise.resolve({ docs: [] }),
        getDoc(doc(db, "users", userId))
      ]);
      const leftTrips = userSnap.exists() ? userSnap.data().leftTrips || {} : {};

      ownerSnap.docs.forEach(d => {
        tripsMap.set(d.id, { id: d.id, accessRole: "owner", ...d.data() });
      });

      // Resolve all access trips in parallel
      const accessEntries = accessSnap.docs
        .map(d => ({ data: d.data(), tripId: d.data().tripId || d.id }))
        .filter(e =>
          e.tripId &&
          e.data.status !== "inactive" &&
          leftTrips[e.tripId] !== true &&
          !tripsMap.has(e.tripId)
        );

      const tripSnaps = await Promise.all(
        accessEntries.map(e => getDoc(doc(db, "trips", e.tripId)))
      );

      tripSnaps.forEach((snap, idx) => {
        if (snap.exists()) {
          tripsMap.set(snap.id, {
            id: snap.id,
            accessRole: accessEntries[idx].data.role || "member",
            ...snap.data()
          });
        }
      });

      const loaded = Array.from(tripsMap.values()).sort((a, b) => {
        const aT = a.createdAt?.seconds || 0;
        const bT = b.createdAt?.seconds || 0;
        return bT - aT;
      });
      setTrips(loaded);
      return loaded;
    } catch (error) {
      console.error("Could not load trips:", error);
      alert("Could not load trips. Check your Firestore rules.");
      return [];
    } finally {
      setTripLoading(false);
    }
  }

  async function handleCreateTrip(event) {
    event.preventDefault();
    if (!user) {
      alert("Please log in first.");
      return;
    }
    if (!form.name.trim()) {
      alert("Trip name is required.");
      return;
    }
    if (new Date(form.endDate) < new Date(form.startDate)) {
      alert("End date must be on or after start date.");
      return;
    }
    setCreatingTrip(true);
    try {
      const tripRef = doc(collection(db, "trips"));
      const ownerEmailLower = getEmailLower(user.email);
      const batch = writeBatch(db);

      batch.set(tripRef, {
        name: form.name.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        defaultCurrency: form.defaultCurrency,
        imageDataUrl: form.imageDataUrl || "",
        ownerId: user.uid,
        ownerEmail: user.email,
        ownerEmailLower,
        status: "Active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      batch.set(doc(db, "trips", tripRef.id, "members", user.uid), {
        userId: user.uid,
        email: user.email,
        emailLower: ownerEmailLower,
        displayName: user.displayName || user.email || "You",
        photoURL: user.photoURL || "",
        role: "owner",
        status: "active",
        isOwner: true,
        joinedAt: serverTimestamp()
      });

      batch.set(doc(db, "emailAccess", ownerEmailLower, "trips", tripRef.id), {
        tripId: tripRef.id,
        role: "owner",
        ownerId: user.uid,
        ownerEmailLower,
        status: "active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      DEFAULT_CATEGORIES.forEach(category => {
        batch.set(doc(db, "trips", tripRef.id, "categories", category.id), {
          ...category,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });

      await batch.commit();
      setForm({
        name: "",
        startDate: todayIso(),
        endDate: todayIso(),
        defaultCurrency: "EUR",
        imageDataUrl: ""
      });
      setIsCreateModalOpen(false);
      await loadTrips(user.uid, user.email);
    } catch (error) {
      console.error("Could not create trip:", error);
      alert("Could not create trip. Check your Firestore rules.");
    } finally {
      setCreatingTrip(false);
    }
  }

  async function deleteRefsInBatches(refs) {
    for (let i = 0; i < refs.length; i += 450) {
      const batch = writeBatch(db);
      refs.slice(i, i + 450).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
  }

  async function handleDeleteTrip(targetTrip = selectedTrip) {
    if (!targetTrip || !user) return;
    if (!canManageTrip(targetTrip)) {
      alert("Only the trip owner can delete this trip.");
      return;
    }

    const confirmed = window.confirm(
      `Delete "${targetTrip.name}" permanently?\n\nThis removes the trip, members, expenses, settlements, plan budget, categories, and invite links for everyone.`
    );
    if (!confirmed) return;

    setDeletingTrip(true);
    try {
      const subcollections = [
        "members",
        "categories",
        "predictions",
        "expenses",
        "settlements",
        "invites"
      ];
      const snaps = await Promise.all(
        subcollections.map(name =>
          getDocs(collection(db, "trips", targetTrip.id, name))
        )
      );
      const memberDocs = snaps[0].docs.map(d => ({ id: d.id, ...d.data() }));
      const subcollectionRefs = snaps.flatMap(snap => snap.docs.map(d => d.ref));
      const accessRefs = memberDocs
        .map(m => getEmailLower(m.email))
        .filter(Boolean)
        .map(emailLower => doc(db, "emailAccess", emailLower, "trips", targetTrip.id));

      const ownerEmailLower =
        targetTrip.ownerEmailLower || getEmailLower(targetTrip.ownerEmail || user.email);
      if (ownerEmailLower) {
        accessRefs.push(doc(db, "emailAccess", ownerEmailLower, "trips", targetTrip.id));
      }

      const refsToDelete = [...subcollectionRefs, ...accessRefs];
      const uniqueRefsToDelete = Array.from(
        new Map(refsToDelete.map(ref => [ref.path, ref])).values()
      );

      await deleteRefsInBatches(uniqueRefsToDelete);
      await deleteDoc(doc(db, "trips", targetTrip.id));
      if (selectedTrip?.id === targetTrip.id) closeTrip();
      if (editingTripId === targetTrip.id) cancelEditingTrip();
      await loadTrips(user.uid, user.email);
    } catch (error) {
      console.error("Could not delete trip:", error);
      alert("Could not delete trip. Check your Firestore rules.");
    } finally {
      setDeletingTrip(false);
    }
  }

  function startEditingTrip(trip) {
    setEditingTripId(trip.id);
    setEditForm({
      name: trip.name || "",
      startDate: trip.startDate || todayIso(),
      endDate: trip.endDate || todayIso(),
      defaultCurrency: trip.defaultCurrency || "EUR",
      status: trip.status || "Active",
      imageDataUrl: trip.imageDataUrl || ""
    });
    setIsEmojiPickerOpen(false);
    setActiveTab("categories");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEditingTrip() {
    setEditingTripId(null);
    setEditForm({
      name: "",
      startDate: todayIso(),
      endDate: todayIso(),
      defaultCurrency: "EUR",
      status: "Active",
      imageDataUrl: ""
    });
  }

  async function handleUpdateTrip(event) {
    event.preventDefault();
    if (!user || !editingTripId) return;
    if (!editForm.name.trim()) {
      alert("Trip name is required.");
      return;
    }
    if (new Date(editForm.endDate) < new Date(editForm.startDate)) {
      alert("End date must be on or after start date.");
      return;
    }
    setSavingEdit(true);
    try {
      await updateDoc(doc(db, "trips", editingTripId), {
        name: editForm.name.trim(),
        startDate: editForm.startDate,
        endDate: editForm.endDate,
        defaultCurrency: editForm.defaultCurrency,
        imageDataUrl: editForm.imageDataUrl || "",
        status: editForm.status,
        updatedAt: serverTimestamp()
      });
      if (selectedTrip?.id === editingTripId) {
        setSelectedTrip(t => ({
          ...t,
          name: editForm.name.trim(),
          startDate: editForm.startDate,
          endDate: editForm.endDate,
          defaultCurrency: editForm.defaultCurrency,
          imageDataUrl: editForm.imageDataUrl || "",
          status: editForm.status
        }));
      }
      cancelEditingTrip();
      await loadTrips(user.uid, user.email);
    } catch (error) {
      console.error("Could not update trip:", error);
      alert("Could not update trip. Check your Firestore rules.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSaveTripSettings(event) {
    event.preventDefault();
    if (!user || !selectedTrip) return;
    const tripImageChanged =
      (selectedTrip.imageDataUrl || "") !== (settingsTripForm.imageDataUrl || "");

    if (!canManageSelectedTrip()) {
      if (!tripImageChanged) {
        alert("Choose a new trip image before saving.");
        return;
      }
      setSavingTripSettings(true);
      try {
        await updateDoc(doc(db, "trips", selectedTrip.id), {
          imageDataUrl: settingsTripForm.imageDataUrl || "",
          updatedAt: serverTimestamp()
        });
        setSelectedTrip(t => ({
          ...t,
          imageDataUrl: settingsTripForm.imageDataUrl || ""
        }));
        await loadTrips(user.uid, user.email);
      } catch (error) {
        console.error("Could not save trip image:", error);
        alert("Could not save trip image. Please publish the latest Firestore rules and try again.");
      } finally {
        setSavingTripSettings(false);
      }
      return;
    }

    if (!settingsTripForm.name.trim()) {
      alert("Trip name is required.");
      return;
    }
    if (new Date(settingsTripForm.endDate) < new Date(settingsTripForm.startDate)) {
      alert("End date must be on or after start date.");
      return;
    }
    setSavingTripSettings(true);
    try {
      const tripSettingsUpdate = {
        name: settingsTripForm.name.trim(),
        startDate: settingsTripForm.startDate,
        endDate: settingsTripForm.endDate,
        defaultCurrency: settingsTripForm.defaultCurrency,
        updatedAt: serverTimestamp()
      };

      if (tripImageChanged) {
        tripSettingsUpdate.imageDataUrl = settingsTripForm.imageDataUrl || "";
      }

      await updateDoc(doc(db, "trips", selectedTrip.id), tripSettingsUpdate);
      setSelectedTrip(t => ({
        ...t,
        name: settingsTripForm.name.trim(),
        startDate: settingsTripForm.startDate,
        endDate: settingsTripForm.endDate,
        defaultCurrency: settingsTripForm.defaultCurrency,
        ...(tripImageChanged
          ? { imageDataUrl: settingsTripForm.imageDataUrl || "" }
          : {}),
      }));
      await loadTrips(user.uid, user.email);
    } catch (error) {
      console.error("Could not save trip settings:", error);
      const tripImageChanged =
        (selectedTrip.imageDataUrl || "") !== (settingsTripForm.imageDataUrl || "");
      alert(
        tripImageChanged
          ? "Could not save trip settings. Try uploading a smaller trip image, or check that your database rules allow trip updates."
          : "Could not save trip settings."
      );
    } finally {
      setSavingTripSettings(false);
    }
  }

  async function handleTripImageChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imageDataUrl = await readTripImage(file);
      setSettingsTripForm(current => ({ ...current, imageDataUrl }));
    } catch (error) {
      alert(error.message || "Could not upload image.");
    } finally {
      event.target.value = "";
    }
  }

  function removeTripImage() {
    setSettingsTripForm(current => ({ ...current, imageDataUrl: "" }));
  }

  async function handleCreateTripImageChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imageDataUrl = await readTripImage(file);
      setForm(current => ({ ...current, imageDataUrl }));
    } catch (error) {
      alert(error.message || "Could not upload image.");
    } finally {
      event.target.value = "";
    }
  }

  async function handleEditTripImageChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imageDataUrl = await readTripImage(file);
      setEditForm(current => ({ ...current, imageDataUrl }));
    } catch (error) {
      alert(error.message || "Could not upload image.");
    } finally {
      event.target.value = "";
    }
  }

  async function openTrip(trip) {
    setSelectedTrip(trip);
    const storedTab = (() => {
      try {
        return localStorage.getItem(LAST_TRIP_STORAGE_KEY) === trip.id
          ? localStorage.getItem(LAST_TAB_STORAGE_KEY) || "dashboard"
          : "dashboard";
      } catch {
        return "dashboard";
      }
    })();
    setActiveTab(storedTab);
    setShowLanding(false);
    try {
      localStorage.setItem(APP_VIEW_STORAGE_KEY, "app");
      localStorage.setItem(LAST_TRIP_STORAGE_KEY, trip.id);
      localStorage.setItem(LAST_TAB_STORAGE_KEY, storedTab);
    } catch {
      /* localStorage unavailable */
    }
    await loadTripData(trip.id, trip);
  }

  async function openDemoTrip() {
    setShowLanding(false);
    setSelectedTrip({
      id: DEMO_TRIP_ID,
      isDemo: true,
      accessRole: "demo",
      name: "5-Day Norway Trip Demo",
      startDate: "2026-06-10",
      endDate: "2026-06-14",
      defaultCurrency: "EUR",
      status: "Demo",
      ownerId: "demo",
      ownerEmail: "demo@triphisaab.app",
      imageDataUrl: ""
    });
    setActiveTab("dashboard");
    await loadTripData(DEMO_TRIP_ID, { id: DEMO_TRIP_ID, isDemo: true });
  }

  function closeTrip() {
    const wasDemoMode = isDemoMode();
    setSelectedTrip(null);
    setActiveTab("dashboard");
    if (wasDemoMode) setShowLanding(true);
    try {
      localStorage.removeItem(LAST_TRIP_STORAGE_KEY);
      localStorage.setItem(LAST_TAB_STORAGE_KEY, "dashboard");
      if (wasDemoMode) localStorage.setItem(APP_VIEW_STORAGE_KEY, "landing");
    } catch {
      /* localStorage unavailable */
    }
    setMembers([]);
    setMemberProfilesByEmail({});
    setCategories([]);
    setPredictions([]);
    setExpenses([]);
    setSettlements([]);
    setNotifications([]);
    setSelectedNotification(null);
    cancelCategoryForm();
    cancelEditingExpense();
    setMemberForm({ displayName: "", email: "" });
    resetSettlementForm();
    setInviteLink("");
  }

  function openLandingPage() {
    closeTrip();
    cancelEditingTrip();
    setIsCreateModalOpen(false);
    setShowLanding(true);
    setIsSidebarOpen(false);
    try {
      localStorage.setItem(APP_VIEW_STORAGE_KEY, "landing");
    } catch {
      /* localStorage unavailable */
    }
  }

  async function loadTripData(tripId, tripContext = selectedTrip) {
    if (tripId === DEMO_TRIP_ID) {
      setTripDataLoading(true);
      setMembers(DEMO_MEMBERS);
      setMemberProfilesByEmail({});
      setCategories(DEMO_CATEGORIES);
      setPredictions(DEMO_PREDICTIONS);
      setExpenses(DEMO_EXPENSES);
      setSettlements(DEMO_SETTLEMENTS);
      setNotifications([]);
      setTripDataLoading(false);
      return;
    }
    setTripDataLoading(true);
    try {
      // Parallelize the base reads; budget visibility depends on the loaded member id.
      const [membersSnap, categoriesSnap] =
        await Promise.all([
          getDocs(collection(db, "trips", tripId, "members")),
          getDocs(collection(db, "trips", tripId, "categories"))
        ]);

      const loadedMembers = membersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const loadedCategories = categoriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const loadedCurrentUserMemberId = getCurrentUserMemberIdFromList(loadedMembers);
      const settlementCollection = collection(db, "trips", tripId, "settlements");
      const settlementSnaps = tripContext?.ownerId === user?.uid
        ? [await getDocs(settlementCollection)]
        : await Promise.all([
            getDocs(query(settlementCollection, where("settlementLayer", "==", "group"))),
            getDocs(query(settlementCollection, where("settlementLayer", "==", null))).catch(() => ({ docs: [] })),
            loadedCurrentUserMemberId
              ? getDocs(
                  query(
                    settlementCollection,
                    where("settlementMemberIds", "array-contains", loadedCurrentUserMemberId)
                  )
                ).catch(() => ({ docs: [] }))
              : Promise.resolve({ docs: [] })
          ]);
      const loadedSettlements = Array.from(
        settlementSnaps
          .flatMap(snap => snap.docs)
          .reduce((map, d) => map.set(d.id, { id: d.id, ...d.data() }), new Map())
          .values()
      );
      const expenseCollection = collection(db, "trips", tripId, "expenses");
      const canLoadAllExpenses = tripContext?.ownerId === user?.uid;
      const expenseSnaps = canLoadAllExpenses
        ? [await getDocs(expenseCollection)]
        : await Promise.all([
            getDocs(query(expenseCollection, where("scope", "==", "group"))),
            getDocs(query(expenseCollection, where("scope", "==", null))).catch(() => ({ docs: [] })),
            loadedCurrentUserMemberId
              ? getDocs(
                  query(
                    expenseCollection,
                    where("visibleTo", "array-contains", loadedCurrentUserMemberId)
                  )
                ).catch(() => ({ docs: [] }))
              : Promise.resolve({ docs: [] })
          ]);
      const loadedExpenses = Array.from(
        expenseSnaps
          .flatMap(snap => snap.docs)
          .reduce((map, d) => map.set(d.id, { id: d.id, ...d.data() }), new Map())
          .values()
      );
      const predictionCollection = collection(db, "trips", tripId, "predictions");
      const predictionReads = [
        getDocs(query(predictionCollection, where("scope", "==", "group"))),
        getDocs(query(predictionCollection, where("scope", "==", null))).catch(() => ({ docs: [] }))
      ];
      if (loadedCurrentUserMemberId) {
        predictionReads.push(
          getDocs(
            query(
              predictionCollection,
              where("visibleMemberIds", "array-contains", loadedCurrentUserMemberId)
            )
          ).catch(() => ({ docs: [] }))
        );
      }
      const predictionSnaps = await Promise.all(predictionReads);
      const loadedPredictions = Array.from(
        predictionSnaps
          .flatMap(snap => snap.docs)
          .reduce((map, d) => map.set(d.id, { id: d.id, ...d.data() }), new Map())
          .values()
      );
      const notificationsSnap = loadedCurrentUserMemberId
        ? await getDocs(
            query(
              collection(db, "trips", tripId, "notifications"),
              where("recipientMemberId", "==", loadedCurrentUserMemberId)
            )
          ).catch(() => ({ docs: [] }))
        : { docs: [] };
      const loadedNotifications = notificationsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      loadedMembers.sort((a, b) => {
        if (a.isOwner) return -1;
        if (b.isOwner) return 1;
        const aInactive = a.status === "inactive";
        const bInactive = b.status === "inactive";
        if (aInactive !== bInactive) return aInactive ? 1 : -1;
        return String(a.displayName || a.email).localeCompare(
          String(b.displayName || b.email)
        );
      });

      loadedCategories.sort((a, b) =>
        String(a.name).localeCompare(String(b.name))
      );

      loadedExpenses.sort((a, b) =>
        (String(b.date || "") + String(b.time || "")).localeCompare(
          String(a.date || "") + String(a.time || "")
        )
      );

      loadedSettlements.sort((a, b) =>
        String(b.date || "").localeCompare(String(a.date || ""))
      );

      const firstActiveCategory = loadedCategories.find(c => c.isActive);
      const activeLoadedMembers = loadedMembers.filter(m => m.status !== "inactive");

      const defaultPayerId =
        getCurrentUserMemberIdFromList(activeLoadedMembers) ||
        activeLoadedMembers[0]?.id ||
        loadedMembers[0]?.id ||
        "";

      const activeMemberIds = activeLoadedMembers.map(m => m.id);

      setMembers(loadedMembers);
      setMemberDirectory(current => {
        const next = mergeMemberDirectory(current, loadedMembers);
        writeStoredMemberDirectory(next);
        return next;
      });
      await loadMemberProfiles(loadedMembers);
      setCategories(loadedCategories);
      setPredictions(loadedPredictions);
      setExpenses(loadedExpenses);
      setSettlements(loadedSettlements);
      setNotifications(loadedNotifications);
      setBudgetForm(current => ({
        ...current,
        categoryId: current.categoryId || firstActiveCategory?.id || "",
        visibleMemberIds: current.visibleMemberIds?.length
          ? current.visibleMemberIds
          : loadedCurrentUserMemberId
          ? [loadedCurrentUserMemberId]
          : []
      }));

      setExpenseForm(prev => ({
        ...prev,
        categoryId: prev.categoryId || firstActiveCategory?.id || "",
        originalCurrency:
          prev.originalCurrency || tripContext?.defaultCurrency || "EUR",
        paidByMemberId: prev.paidByMemberId || defaultPayerId,
        splitMemberIds:
          prev.splitMemberIds?.length > 0
            ? prev.splitMemberIds.filter(id => activeMemberIds.includes(id))
            : activeMemberIds
      }));

      setSettlementForm(prev => ({
        ...prev,
        fromMemberId: prev.fromMemberId || defaultPayerId,
        toMemberId:
          prev.toMemberId ||
          activeLoadedMembers.find(m => m.id !== defaultPayerId)?.id ||
          ""
      }));
    } catch (error) {
      console.error("Could not load trip data:", error);
      alert("Could not load trip data. Check your Firestore rules.");
    } finally {
      setTripDataLoading(false);
    }
  }

  function getCurrentUserMemberIdFromList(memberList) {
    if (!user) return "";
    const byUserId = memberList.find(m => m.userId === user.uid);
    if (byUserId) return byUserId.id;
    const emailLower = getEmailLower(user.email);
    const byEmail = memberList.find(
      m => getEmailLower(m.email) === emailLower
    );
    return byEmail?.id || "";
  }

  // -------------------- Members --------------------
  async function handleAddMember(event) {
    event.preventDefault();
    if (!selectedTrip || !user) return;
    if (!canManageSelectedTrip()) {
      alert("Only the trip owner can add members.");
      return;
    }

    const displayName = memberForm.displayName.trim();
    const emailLower = getEmailLower(memberForm.email);
    if (!emailLower) {
      alert("Email is required so your friend can log in and access this trip.");
      return;
    }
    const alreadyExists = members.some(
      m => getEmailLower(m.email) === emailLower
    );

    setSavingMember(true);
    try {
      const batch = writeBatch(db);
      const memberRef = doc(db, "trips", selectedTrip.id, "members", emailLower);

      if (!alreadyExists) {
        batch.set(memberRef, {
          displayName: displayName || emailLower,
          email: emailLower,
          emailLower,
          role: "member",
          status: "active",
          isOwner: false,
          userId: "",
          photoURL: "",
          joinedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      } else {
        batch.update(memberRef, {
          status: "active",
          displayName: displayName || emailLower,
          updatedAt: serverTimestamp()
        });
      }

      batch.set(doc(db, "emailAccess", emailLower, "trips", selectedTrip.id), {
        tripId: selectedTrip.id,
        role: "member",
        ownerId: selectedTrip.ownerId,
        ownerEmailLower:
          selectedTrip.ownerEmailLower || getEmailLower(user.email),
        status: "active",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      await batch.commit();
      setMemberDirectory(current => {
        const next = mergeMemberDirectory(current, [
          { displayName: displayName || emailLower, email: emailLower }
        ]);
        writeStoredMemberDirectory(next);
        return next;
      });
      setMemberForm({ displayName: "", email: "" });
      setMemberSearch("");
      await loadTripData(selectedTrip.id);

      if (alreadyExists) {
        alert("This member already existed. Their access is active again.");
      }
    } catch (error) {
      console.error("Could not add member:", error);
      alert("Could not add member. Check your Firestore rules.");
    } finally {
      setSavingMember(false);
    }
  }

  async function handleToggleMemberStatus(member) {
    if (!selectedTrip || !user) return;
    if (!canManageSelectedTrip()) {
      alert("Only the trip owner can manage members.");
      return;
    }
    if (member.isOwner) {
      alert("The owner cannot be deactivated.");
      return;
    }
    const emailLower = getEmailLower(member.email);
    if (!emailLower) {
      alert("This member has no email, so access cannot be managed.");
      return;
    }
    const isInactive = member.status === "inactive";
    const nextStatus = isInactive ? "active" : "inactive";
    const message = isInactive
      ? `Reactivate ${memberNameOf(member.id)} and give them access again?`
      : `Remove ${memberNameOf(member.id)} from this trip? Old expenses will stay visible.`;
    if (!window.confirm(message)) return;

    setUpdatingMemberId(member.id);
    try {
      const batch = writeBatch(db);
      const memberRef = doc(db, "trips", selectedTrip.id, "members", member.id);
      const accessRef = doc(db, "emailAccess", emailLower, "trips", selectedTrip.id);

      batch.update(memberRef, {
        status: nextStatus,
        updatedAt: serverTimestamp()
      });

      if (nextStatus === "inactive") {
        batch.delete(accessRef);
      } else {
        batch.set(accessRef, {
          tripId: selectedTrip.id,
          role: member.role || "member",
          ownerId: selectedTrip.ownerId,
          ownerEmailLower:
            selectedTrip.ownerEmailLower || getEmailLower(user.email),
          status: "active",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }

      await batch.commit();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not update member status:", error);
      alert("Could not update member. Check your Firestore rules.");
    } finally {
      setUpdatingMemberId("");
    }
  }

  function selectMemberSuggestion(member) {
    setMemberForm({
      displayName: member.displayName || "",
      email: member.email || ""
    });
    setMemberSearch(member.displayName || member.email || "");
  }

  async function handleLeaveTrip() {
    if (!selectedTrip || !user) return;
    if (canManageSelectedTrip()) {
      alert("Trip owners cannot leave their own trip. Delete the trip instead if you no longer need it.");
      return;
    }

    const balanceNet = Number(currentUserBalance?.net || 0);
    if (Math.abs(balanceNet) > 0.01) {
      const direction = balanceNet < 0 ? "owe" : "are owed";
      alert(
        `You cannot leave this trip yet.\n\nYou still ${direction} ${formatMoney(Math.abs(balanceNet))}. Please settle up before leaving.`
      );
      setActiveTab("settlements");
      return;
    }

    const confirmed = window.confirm(
      `Leave "${selectedTrip.name}"?\n\nYou will lose access to this trip. Your old expenses will stay in the trip history.`
    );
    if (!confirmed) return;

    setLeavingTrip(true);
    try {
      const emailLower = getEmailLower(user.email);
      if (!emailLower) {
        alert("Could not identify your account email, so this trip access cannot be removed.");
        return;
      }

      await deleteDoc(doc(db, "emailAccess", emailLower, "trips", selectedTrip.id));
      await setDoc(
        doc(db, "users", user.uid),
        {
          leftTrips: {
            [selectedTrip.id]: false
          },
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      if (currentUserMemberId) {
        try {
          await updateDoc(doc(db, "trips", selectedTrip.id, "members", currentUserMemberId), {
            status: "inactive",
            updatedAt: serverTimestamp()
          });
        } catch (memberError) {
          console.warn("Trip access was removed, but member history status could not be updated:", memberError);
        }
      }

      closeTrip();
      await loadTrips(user.uid, user.email);
    } catch (error) {
      console.error("Could not leave trip:", error);
      try {
        await setDoc(
          doc(db, "users", user.uid),
          {
            leftTrips: {
              [selectedTrip.id]: true
            },
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
        closeTrip();
        await loadTrips(user.uid, user.email);
      } catch (fallbackError) {
        console.error("Could not hide left trip:", fallbackError);
        alert("Could not leave trip. Check your Firestore rules.");
      }
    } finally {
      setLeavingTrip(false);
    }
  }

  // -------------------- Plan Budget --------------------
  function resetBudgetForm(overrides = {}) {
    setEditingBudgetId(null);
    setBudgetForm({
      ...EMPTY_BUDGET_FORM,
      categoryId: activeCategories[0]?.id || categories[0]?.id || "",
      visibleMemberIds: currentUserMemberId ? [currentUserMemberId] : [],
      ...overrides
    });
  }

  function toggleBudgetMember(memberId) {
    setBudgetForm(current => {
      const selected = new Set(current.visibleMemberIds || []);
      if (selected.has(memberId)) selected.delete(memberId);
      else selected.add(memberId);
      return { ...current, visibleMemberIds: Array.from(selected) };
    });
  }

  function buildBudgetVisibility(scope) {
    if (scope === "group") return activeMembers.map(m => m.id);
    if (scope === "me") return currentUserMemberId ? [currentUserMemberId] : [];
    return budgetForm.visibleMemberIds || [];
  }

  function startEditingBudget(entry) {
    setEditingBudgetId(entry.id);
    setBudgetForm({
      categoryId: entry.categoryId || activeCategories[0]?.id || "",
      title: entry.title || entry.notes || "",
      estimatedEur: entry.estimatedEur ? String(entry.estimatedEur) : "",
      scope: normalizeBudgetScope(entry),
      visibleMemberIds:
        entry.visibleMemberIds?.length
          ? entry.visibleMemberIds
          : entry.memberIds || []
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleSavePredictions(event) {
    event.preventDefault();
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to edit trip budgets.");
    const amount = Number(budgetForm.estimatedEur);
    if (!budgetForm.categoryId) return alert("Choose a category.");
    if (!amount || amount <= 0) return alert("Enter a budget amount above zero.");
    if (!currentUserMemberId) return alert("Could not find your trip member profile yet.");
    const scope = budgetForm.scope || "group";
    const visibleMemberIds = buildBudgetVisibility(scope);
    if (scope === "selected" && visibleMemberIds.length === 0) {
      return alert("Choose at least one person for this budget entry.");
    }
    const category = categoriesById.get(budgetForm.categoryId);
    setSavingPredictions(true);
    try {
      const payload = {
        categoryId: budgetForm.categoryId,
        categoryName: category?.name || "",
        title: budgetForm.title.trim(),
        estimatedEur: amount,
        scope,
        visibleMemberIds,
        createdByMemberId: currentUserMemberId,
        updatedAt: serverTimestamp()
      };
      if (editingBudgetId) {
        await setDoc(
          doc(db, "trips", selectedTrip.id, "predictions", editingBudgetId),
          payload,
          { merge: true }
        );
      } else {
        await addDoc(collection(db, "trips", selectedTrip.id, "predictions"), {
          ...payload,
          createdBy: user.uid,
          createdAt: serverTimestamp()
        });
      }
      await loadTripData(selectedTrip.id);
      resetBudgetForm({ categoryId: budgetForm.categoryId });
      alert("Plan budget saved.");
    } catch (error) {
      console.error("Could not save plan budget:", error);
      alert("Could not save plan budget.");
    } finally {
      setSavingPredictions(false);
    }
  }

  async function handleDeleteBudget(entry) {
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to edit trip budgets.");
    if (!window.confirm(`Delete this budget entry for ${entry.categoryName || "this category"}?`)) {
      return;
    }
    try {
      await deleteDoc(doc(db, "trips", selectedTrip.id, "predictions", entry.id));
      if (editingBudgetId === entry.id) resetBudgetForm();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not delete plan budget:", error);
      alert("Could not delete plan budget.");
    }
  }

  // -------------------- Expense form helpers --------------------
  function getCustomSplitTotal(formData) {
    return Object.values(formData.customSplitShares || {}).reduce(
      (sum, v) => sum + Number(v || 0),
      0
    );
  }

  function getCustomSplitMemberIds(formData) {
    return Object.keys(formData.customSplitShares || {}).filter(
      id => Number(formData.customSplitShares[id] || 0) > 0
    );
  }

  function validateCustomSplit(formData) {
    if (formData.expenseType !== "shared") return true;
    if (formData.splitType === "custom") {
      const total = Number(formData.originalAmount || 0);
      const customTotal = getCustomSplitTotal(formData);
      if (Math.abs(total - customTotal) > 0.02) {
        alert(
          `Custom split must equal the total expense amount.\n\nExpense total: ${formatCurrency(
            total,
            formData.originalCurrency
          )}\nCustom split total: ${formatCurrency(customTotal, formData.originalCurrency)}`
        );
        return false;
      }
      if (getCustomSplitMemberIds(formData).length === 0) {
        alert("Add at least one custom split amount.");
        return false;
      }
    }
    if (formData.splitType === "percent") {
      const pctTotal = getPercentageSplitTotal(formData);
      if (Math.abs(pctTotal - 100) > 0.1) {
        alert(`Percentages must total 100%.\n\nCurrent total: ${pctTotal.toFixed(1)}%`);
        return false;
      }
      const hasAny = Object.values(formData.customSplitShares || {}).some(v => Number(v) > 0);
      if (!hasAny) {
        alert("Enter a percentage for at least one person.");
        return false;
      }
    }
    return true;
  }

  function buildCustomSplitSharesEur(formData) {
    const out = {};
    const currency = formData.originalCurrency || "EUR";
    Object.entries(formData.customSplitShares || {}).forEach(([id, v]) => {
      const amount = Number(v || 0);
      if (amount > 0) out[id] = convertToEur(amount, currency);
    });
    return out;
  }

  function updateCustomSplitShare(formData, setFormData, memberId, value) {
    setFormData({
      ...formData,
      customSplitShares: {
        ...(formData.customSplitShares || {}),
        [memberId]: value
      }
    });
  }

  function getCleanSplitMemberIds(formData) {
    const activeIds = activeMembers.map(m => m.id);
    if (formData.expenseType === "personal") {
      return formData.paidByMemberId ? [formData.paidByMemberId] : [];
    }
    if (formData.splitType === "custom" || formData.splitType === "percent") {
      return getCustomSplitMemberIds(formData).filter(id => activeIds.includes(id));
    }
    const selected = (formData.splitMemberIds || []).filter(id =>
      activeIds.includes(id)
    );
    return selected.length > 0 ? selected : activeIds;
  }

  function getPercentageSplitTotal(fd) {
    return Object.values(fd.customSplitShares || {}).reduce((sum, v) => sum + Number(v || 0), 0);
  }

  function buildPercentSplitSharesOriginal(fd) {
    const out = {};
    const total = Number(fd.originalAmount || 0);
    Object.entries(fd.customSplitShares || {}).forEach(([id, pct]) => {
      const amount = (Number(pct || 0) / 100) * total;
      if (amount > 0) out[id] = amount;
    });
    return out;
  }

  function buildPercentSplitSharesEur(fd) {
    const out = {};
    const currency = fd.originalCurrency || "EUR";
    const total = Number(fd.originalAmount || 0);
    Object.entries(fd.customSplitShares || {}).forEach(([id, pct]) => {
      const amount = (Number(pct || 0) / 100) * total;
      if (amount > 0) out[id] = convertToEur(amount, currency);
    });
    return out;
  }

  function toggleSplitMember(formData, setFormData, memberId) {
    const current = formData.splitMemberIds || [];
    setFormData({
      ...formData,
      splitMemberIds: current.includes(memberId)
        ? current.filter(id => id !== memberId)
        : [...current, memberId]
    });
  }

  function buildFastExpenseForm(overrides = {}) {
    const payerId =
      currentUserMemberId ||
      getCurrentUserMemberIdFromList(activeMembers) ||
      activeMembers[0]?.id ||
      "";
    return {
      ...EMPTY_EXPENSE_FORM,
      date: todayIso(),
      time: nowTimeIso(),
      categoryId: defaultExpenseCategoryId,
      originalCurrency: selectedTrip?.defaultCurrency || "EUR",
      paymentMethod: "card",
      expenseType: "personal",
      splitType: "equal",
      paidByMemberId: payerId,
      splitMemberIds: payerId ? [payerId] : [],
      ...overrides
    };
  }

  function openFastExpenseModal(overrides = {}) {
    if (isDemoMode()) {
      alert("Demo trip is read-only. Sign in with Google to create and edit your own trips.");
      return;
    }
    setExpenseFeedback(null);
    setExpenseForm(buildFastExpenseForm(overrides));
    setExpenseFormTab("basic");
    setIsAddExpenseModalOpen(true);
  }

  // -------------------- Expenses --------------------
  async function handleAddExpense(event) {
    event.preventDefault();
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to add expenses.");

    const normalizedExpenseForm = {
      ...expenseForm,
      date: expenseForm.date || todayIso(),
      time: expenseForm.time || nowTimeIso(),
      originalCurrency:
        expenseForm.originalCurrency || selectedTrip.defaultCurrency || "EUR",
      categoryId: expenseForm.categoryId || defaultExpenseCategoryId,
      paidByMemberId:
        expenseForm.paidByMemberId ||
        currentUserMemberId ||
        activeMembers[0]?.id ||
        "",
      expenseType: expenseForm.expenseType || "personal",
      splitType: expenseForm.splitType || "equal",
      paymentMethod: expenseForm.paymentMethod || "card"
    };

    const originalAmount = Number(normalizedExpenseForm.originalAmount);
    const originalCurrency = normalizedExpenseForm.originalCurrency || "EUR";

    if (!normalizedExpenseForm.categoryId) return alert("Choose a category.");
    if (!normalizedExpenseForm.paidByMemberId) return alert("Choose who paid.");
    if (!originalAmount || originalAmount <= 0) return alert("Enter a valid amount.");
    if (!validateCustomSplit(normalizedExpenseForm)) return;

    const splitMemberIds = getCleanSplitMemberIds(normalizedExpenseForm);
    if (normalizedExpenseForm.expenseType === "shared" && splitMemberIds.length === 0) {
      return alert("Choose at least one split member.");
    }

    setSavingExpense(true);
    try {
      const category = categoriesById.get(normalizedExpenseForm.categoryId);
      const amountEur = convertToEur(originalAmount, originalCurrency);
      const isGroupExpense =
        normalizedExpenseForm.expenseType === "shared"
        && splitMemberIds.length >= activeMembers.length
        && activeMembers.every(member => splitMemberIds.includes(member.id));
      const expenseScope =
        normalizedExpenseForm.expenseType === "personal"
          ? "personal"
          : isGroupExpense
          ? "group"
          : "selected_members";
      const visibleTo =
        expenseScope === "group"
          ? "all"
          : expenseScope === "personal"
          ? [normalizedExpenseForm.paidByMemberId]
          : Array.from(new Set([...splitMemberIds, normalizedExpenseForm.paidByMemberId].filter(Boolean)));
      const expenseRef = await addDoc(collection(db, "trips", selectedTrip.id, "expenses"), {
        date: normalizedExpenseForm.date,
        time: normalizedExpenseForm.time,
        categoryId: normalizedExpenseForm.categoryId,
        categoryName: category?.name || "",
        description: normalizedExpenseForm.description.trim(),
        amountEur,
        originalAmount,
        originalCurrency,
        exchangeRateFromEur: getCurrencyRate(originalCurrency),
        ratesSource: ratesMeta.source,
        ratesStatus: ratesMeta.status,
        ratesUpdatedAt: ratesMeta.updatedAt,
        paymentMethod: normalizedExpenseForm.paymentMethod,
        notes: normalizedExpenseForm.notes.trim(),
        expenseType: normalizedExpenseForm.expenseType,
        splitType:
          normalizedExpenseForm.expenseType === "shared" ? normalizedExpenseForm.splitType : "none",
        customSplitSharesOriginal:
          normalizedExpenseForm.expenseType === "shared" && normalizedExpenseForm.splitType === "custom"
            ? normalizedExpenseForm.customSplitShares
            : normalizedExpenseForm.expenseType === "shared" && normalizedExpenseForm.splitType === "percent"
            ? buildPercentSplitSharesOriginal(normalizedExpenseForm)
            : {},
        customSplitSharesEur:
          normalizedExpenseForm.expenseType === "shared" && normalizedExpenseForm.splitType === "custom"
            ? buildCustomSplitSharesEur(normalizedExpenseForm)
            : normalizedExpenseForm.expenseType === "shared" && normalizedExpenseForm.splitType === "percent"
            ? buildPercentSplitSharesEur(normalizedExpenseForm)
            : {},
        paidByMemberId: normalizedExpenseForm.paidByMemberId,
        paidByMemberName: memberNameOf(normalizedExpenseForm.paidByMemberId),
        splitMemberIds,
        scope: expenseScope,
        visibleTo,
        countsTowardGroupSettlement: expenseScope === "group",
        isActive: true,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      setExpenseForm(buildFastExpenseForm({
        originalAmount: "",
        description: "",
        categoryId: normalizedExpenseForm.categoryId
      }));
      setIsAddExpenseModalOpen(false);
      await loadTripData(selectedTrip.id);
      setExpenseFeedback({
        expenseId: expenseRef.id,
        message: `${formatCurrency(originalAmount, originalCurrency)} added to ${category?.name || "expense"}. Trip Overview updated.`
      });
    } catch (error) {
      console.error("Could not save expense:", error);
      alert("Could not save expense.");
    } finally {
      setSavingExpense(false);
    }
  }

  async function undoLastExpense() {
    if (!selectedTrip || !expenseFeedback?.expenseId) return;
    const undoId = expenseFeedback.expenseId;
    setExpenseFeedback(null);
    try {
      await deleteDoc(doc(db, "trips", selectedTrip.id, "expenses", undoId));
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not undo expense:", error);
      alert("Could not undo expense.");
    }
  }

  function addAnotherExpense() {
    openFastExpenseModal({
      originalAmount: "",
      description: "",
      notes: ""
    });
  }

  function viewDashboardAfterExpense() {
    setExpenseFeedback(null);
    setActiveTab("dashboard");
  }

  function startEditingExpense(expense) {
    const defaultPayerId =
      expense.paidByMemberId ||
      getCurrentUserMemberIdFromList(members) ||
      members[0]?.id ||
      "";
    const defaultSplitMemberIds =
      expense.splitMemberIds?.length > 0
        ? expense.splitMemberIds
        : expense.expenseType === "shared"
        ? activeMembers.map(m => m.id)
        : [defaultPayerId];

    setExpenseFormTab("basic");
    setEditingExpenseId(expense.id);
    setExpenseEditForm({
      date: expense.date || todayIso(),
      time: expense.time || nowTimeIso(),
      categoryId: expense.categoryId || "",
      description: expense.description || "",
      originalAmount: String(expense.originalAmount || expense.amountEur || ""),
      originalCurrency: expense.originalCurrency || "EUR",
      paymentMethod: expense.paymentMethod || "card",
      notes: expense.notes || "",
      expenseType: expense.expenseType || "personal",
      splitType: expense.splitType || "equal",
      paidByMemberId: defaultPayerId,
      splitMemberIds: defaultSplitMemberIds,
      customSplitShares:
        expense.customSplitSharesOriginal || expense.customSplitShares || {}
    });
  }

  function cancelEditingExpense() {
    setEditingExpenseId(null);
    setExpenseEditForm({
      ...EMPTY_EXPENSE_FORM,
      date: todayIso(),
      time: nowTimeIso()
    });
  }

  async function handleUpdateExpense(event) {
    event.preventDefault();
    if (!selectedTrip || !editingExpenseId) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to edit expenses.");

    const originalAmount = Number(expenseEditForm.originalAmount);
    const originalCurrency = expenseEditForm.originalCurrency || "EUR";

    if (!expenseEditForm.categoryId) return alert("Choose a category.");
    if (!expenseEditForm.paidByMemberId) return alert("Choose who paid.");
    if (!originalAmount || originalAmount <= 0) return alert("Enter a valid amount.");
    if (!validateCustomSplit(expenseEditForm)) return;

    const splitMemberIds = getCleanSplitMemberIds(expenseEditForm);
    setSavingExpenseEdit(true);
    try {
      const category = categoriesById.get(expenseEditForm.categoryId);
      const isGroupExpense =
        expenseEditForm.expenseType === "shared"
        && splitMemberIds.length >= activeMembers.length
        && activeMembers.every(member => splitMemberIds.includes(member.id));
      const expenseScope =
        expenseEditForm.expenseType === "personal"
          ? "personal"
          : isGroupExpense
          ? "group"
          : "selected_members";
      const visibleTo =
        expenseScope === "group"
          ? "all"
          : expenseScope === "personal"
          ? [expenseEditForm.paidByMemberId]
          : Array.from(new Set([...splitMemberIds, expenseEditForm.paidByMemberId].filter(Boolean)));
      await updateDoc(
        doc(db, "trips", selectedTrip.id, "expenses", editingExpenseId),
        {
          date: expenseEditForm.date,
          time: expenseEditForm.time,
          categoryId: expenseEditForm.categoryId,
          categoryName: category?.name || "",
          description: expenseEditForm.description.trim(),
          amountEur: convertToEur(originalAmount, originalCurrency),
          originalAmount,
          originalCurrency,
          exchangeRateFromEur: getCurrencyRate(originalCurrency),
          ratesSource: ratesMeta.source,
          ratesStatus: ratesMeta.status,
          ratesUpdatedAt: ratesMeta.updatedAt,
          paymentMethod: expenseEditForm.paymentMethod,
          notes: expenseEditForm.notes.trim(),
          expenseType: expenseEditForm.expenseType,
          splitType:
            expenseEditForm.expenseType === "shared"
              ? expenseEditForm.splitType
              : "none",
          customSplitSharesOriginal:
            expenseEditForm.expenseType === "shared" && expenseEditForm.splitType === "custom"
              ? expenseEditForm.customSplitShares
              : expenseEditForm.expenseType === "shared" && expenseEditForm.splitType === "percent"
              ? buildPercentSplitSharesOriginal(expenseEditForm)
              : {},
          customSplitSharesEur:
            expenseEditForm.expenseType === "shared" && expenseEditForm.splitType === "custom"
              ? buildCustomSplitSharesEur(expenseEditForm)
              : expenseEditForm.expenseType === "shared" && expenseEditForm.splitType === "percent"
              ? buildPercentSplitSharesEur(expenseEditForm)
              : {},
          paidByMemberId: expenseEditForm.paidByMemberId,
          paidByMemberName: memberNameOf(expenseEditForm.paidByMemberId),
          splitMemberIds,
          scope: expenseScope,
          visibleTo,
          countsTowardGroupSettlement: expenseScope === "group",
          isActive: true,
          updatedAt: serverTimestamp()
        }
      );
      cancelEditingExpense();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not update expense:", error);
      alert("Could not update expense.");
    } finally {
      setSavingExpenseEdit(false);
    }
  }

  async function handleDeleteExpense(expense) {
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to delete expenses.");
    const confirmed = window.confirm(
      `Delete this expense?\n\n${
        expense.description || expense.categoryName
      } — ${formatMoney(expense.amountEur)}`
    );
    if (!confirmed) return;
    try {
      await deleteDoc(
        doc(db, "trips", selectedTrip.id, "expenses", expense.id)
      );
      if (editingExpenseId === expense.id) cancelEditingExpense();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not delete expense:", error);
      alert("Could not delete expense.");
    }
  }

  // -------------------- Categories --------------------
  function startEditingCategory(category) {
    setEditingCategoryId(category.id);
    setCategoryForm({
      name: category.name || "",
      type: category.type || "Daily",
      icon: category.icon || "📌",
      color: category.color || "#0F766E"
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelCategoryForm() {
    setEditingCategoryId(null);
    setCategoryForm({ name: "", type: "Daily", icon: "📌", color: "#0F766E" });
  }

  function openCreateCategory() {
    cancelCategoryForm();
    setIsEmojiPickerOpen(false);
    setIsCategoryModalOpen(true);
  }

  function closeCategoryModal() {
    setIsCategoryModalOpen(false);
    setIsEmojiPickerOpen(false);
    cancelCategoryForm();
  }

  function renderTutorialModal() {
    return isTutorialOpen ? <TourOverlay onComplete={markTutorialSeen} /> : null;
  }

  function selectCategoryEmoji(emoji) {
    setCategoryForm(current => ({ ...current, icon: emoji }));
    setIsEmojiPickerOpen(false);
  }

  async function handleSaveCategory(event) {
    event.preventDefault();
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to edit categories.");
    if (!categoryForm.name.trim()) {
      alert("Category name is required.");
      return;
    }
    setSavingCategory(true);
    try {
      if (editingCategoryId) {
        const categoryRef = doc(
          db,
          "trips",
          selectedTrip.id,
          "categories",
          editingCategoryId
        );
        await updateDoc(categoryRef, {
          name: categoryForm.name.trim(),
          type: categoryForm.type,
          icon: categoryForm.icon.trim() || "📌",
          color: categoryForm.color || "#0F766E",
          updatedAt: serverTimestamp()
        });

        // Cascade name update to expenses + visible budget entries in a single batch
        const expensesSnap = await getDocs(
          collection(db, "trips", selectedTrip.id, "expenses")
        );
        const batch = writeBatch(db);
        expensesSnap.docs.forEach(d => {
          if (d.data().categoryId === editingCategoryId) {
            batch.update(d.ref, {
              categoryName: categoryForm.name.trim(),
              updatedAt: serverTimestamp()
            });
          }
        });
        predictions
          .filter(entry => entry.categoryId === editingCategoryId)
          .forEach(entry => {
            batch.update(doc(db, "trips", selectedTrip.id, "predictions", entry.id), {
              categoryName: categoryForm.name.trim(),
              updatedAt: serverTimestamp()
            });
          });
        await batch.commit();
      } else {
        await addDoc(collection(db, "trips", selectedTrip.id, "categories"), {
          name: categoryForm.name.trim(),
          type: categoryForm.type,
          icon: categoryForm.icon.trim() || "📌",
          color: categoryForm.color || "#0F766E",
          isActive: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }

      cancelCategoryForm();
      setIsCategoryModalOpen(false);
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not save category:", error);
      alert("Could not save category. Check your Firestore rules.");
    } finally {
      setSavingCategory(false);
    }
  }

  async function handleToggleCategory(category) {
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to edit categories.");
    try {
      await updateDoc(
        doc(db, "trips", selectedTrip.id, "categories", category.id),
        {
          isActive: !category.isActive,
          updatedAt: serverTimestamp()
        }
      );
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not update category status:", error);
      alert("Could not update category status.");
    }
  }

  async function handleDeleteCategory(category) {
    if (!selectedTrip) return;
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to edit categories.");
    const usedByExpenses = expenses.some(e => e.categoryId === category.id);
    const message = usedByExpenses
      ? `Delete "${category.name}"?\n\nExisting expenses will keep their saved category name, but this category will no longer be available for new budgets or expenses.`
      : `Delete "${category.name}" and its visible budget entries?`;
    if (!window.confirm(message)) return;

    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "trips", selectedTrip.id, "categories", category.id));
      predictions
        .filter(entry => entry.categoryId === category.id)
        .forEach(entry => {
          batch.delete(doc(db, "trips", selectedTrip.id, "predictions", entry.id));
        });
      await batch.commit();
      if (budgetForm.categoryId === category.id) resetBudgetForm({ categoryId: "" });
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not delete category:", error);
      alert("Could not delete category.");
    }
  }

  // -------------------- Settlements --------------------
  function resetSettlementForm() {
    setSettlementForm({
      date: todayIso(),
      fromMemberId: "",
      toMemberId: "",
      amountEur: "",
      notes: ""
    });
  }

  async function handleRecordSettlement(event) {
    event.preventDefault();
    const saved = await saveSettlement(settlementForm);
    if (saved) setIsSettlementModalOpen(false);
  }

  async function handleMarkSettlementPaid(suggested) {
    setPendingSmartSettlement({ suggestion: suggested, layer: "group", settlementGroupId: null });
  }

  async function handleMarkSmartSettlementPaid(suggested, settlementLayer = "group", settlementGroupId = null) {
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to record settlements.");
    if (!selectedTrip || !user) return;
    setSavingSettlement(true);
    try {
      await createCompletedSettlement(
        {
          date: todayIso(),
          fromMemberId: suggested.fromMemberId || suggested.fromUserId,
          toMemberId: suggested.toMemberId || suggested.toUserId,
          amountEur: suggested.amount,
          notes: "Marked as paid from Smart Settle"
        },
        Number(suggested.amount || 0),
        {
          settlementLayer,
          settlementGroupId,
          settlementMemberIds:
            settlementLayer === "private" && settlementGroupId
              ? settlementGroupId.split("__")
              : "all",
          currency: suggested.currency || selectedTrip.defaultCurrency || "EUR",
          source: "smart_settle",
          settlementMode,
          fromType: suggested.fromType || "member",
          toType: suggested.toType || "member",
          fromName: suggested.fromName,
          toName: suggested.toName
        }
      );
      await loadTripData(selectedTrip.id);
      setPendingSmartSettlement(null);
      setSmartSettleToast("Settlement marked as paid.");
    } catch (error) {
      console.error("Could not mark Smart Settle payment as paid:", error);
      alert("Could not mark this settlement as paid.");
    } finally {
      setSavingSettlement(false);
    }
  }

  async function saveSettlement(data) {
    if (isDemoMode()) return alert("Demo trip is read-only. Sign in to record settlements.");
    if (!selectedTrip || !user) return;
    const amount = Number(data.amountEur);
    if (!data.fromMemberId || !data.toMemberId) return alert("Choose both people.");
    if (data.fromMemberId === data.toMemberId) {
      return alert("Payer and receiver cannot be the same person.");
    }
    if (!amount || amount <= 0) return alert("Enter a valid settlement amount.");

    setSavingSettlement(true);
    try {
      const isDebtorRecording = currentUserMemberId === data.fromMemberId;
      const isCreditorRecording = currentUserMemberId === data.toMemberId;

      if (isDebtorRecording && !data.skipApprovalRequest) {
        await createSettlementApprovalNotification(data, amount);
        alert("Settlement sent for approval.");
      } else {
        const settlementId = await createCompletedSettlement(data, amount);
        if (isCreditorRecording) {
          await createSettlementCompletedNotification(data, amount, settlementId);
        }
      }

      setSettlementForm({
        date: todayIso(),
        fromMemberId: data.fromMemberId,
        toMemberId: data.toMemberId,
        amountEur: "",
        notes: ""
      });
      await loadTripData(selectedTrip.id);
      return true;
    } catch (error) {
      console.error("Could not record settlement:", error);
      if (currentUserMemberId === data.fromMemberId) {
        try {
          await createCompletedSettlement(
            {
              ...data,
              notes: `${data.notes || ""} Approval notification fallback`.trim()
            },
            amount
          );
          await loadTripData(selectedTrip.id);
          alert("Could not send approval notification, so the settlement was recorded directly.");
          return true;
        } catch (fallbackError) {
          console.error("Could not record fallback settlement:", fallbackError);
        }
      }
      alert("Could not settle up.");
      return false;
    } finally {
      setSavingSettlement(false);
    }
  }

  async function createCompletedSettlement(data, amount, extra = {}) {
    const settlementRef = await addDoc(collection(db, "trips", selectedTrip.id, "settlements"), {
      date: data.date || todayIso(),
      fromMemberId: data.fromMemberId,
      fromMemberName: memberNameOf(data.fromMemberId),
      toMemberId: data.toMemberId,
      toMemberName: memberNameOf(data.toMemberId),
      amountEur: amount,
      currency: extra.currency || selectedTrip.defaultCurrency || "EUR",
      settlementLayer: extra.settlementLayer || "group",
      settlementGroupId: extra.settlementGroupId || null,
      settlementMemberIds: extra.settlementMemberIds || "all",
      status: extra.status || "paid",
      notes: data.notes || "",
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      paidAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...extra
    });
    return settlementRef.id;
  }

  async function createSettlementApprovalNotification(data, amount) {
    await addDoc(collection(db, "trips", selectedTrip.id, "notifications"), {
      type: "settlement_approval_requested",
      status: "pending",
      tripId: selectedTrip.id,
      tripName: selectedTrip.name,
      fromMemberId: data.fromMemberId,
      fromMemberName: memberNameOf(data.fromMemberId),
      toMemberId: data.toMemberId,
      toMemberName: memberNameOf(data.toMemberId),
      actorMemberId: data.fromMemberId,
      actorName: memberNameOf(data.fromMemberId),
      recipientMemberId: data.toMemberId,
      recipientName: memberNameOf(data.toMemberId),
      action: "requested settlement approval",
      amountEur: amount,
      settlementDate: data.date || todayIso(),
      notes: data.notes || "",
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      createdAtIso: new Date().toISOString(),
      updatedAt: serverTimestamp()
    });
  }

  async function createSettlementCompletedNotification(data, amount, settlementId) {
    try {
      await addDoc(collection(db, "trips", selectedTrip.id, "notifications"), {
        type: "settlement_completed",
        status: "unread",
        tripId: selectedTrip.id,
        tripName: selectedTrip.name,
        fromMemberId: data.fromMemberId,
        fromMemberName: memberNameOf(data.fromMemberId),
        toMemberId: data.toMemberId,
        toMemberName: memberNameOf(data.toMemberId),
        actorMemberId: data.toMemberId,
        actorName: memberNameOf(data.toMemberId),
        recipientMemberId: data.fromMemberId,
        recipientName: memberNameOf(data.fromMemberId),
        action: "completed settlement",
        amountEur: amount,
        settlementId,
        settlementDate: data.date || todayIso(),
        notes: data.notes || "",
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        createdAtIso: new Date().toISOString(),
        updatedAt: serverTimestamp()
      });
    } catch (error) {
      console.warn("Settlement completed, but notification could not be sent:", error);
    }
  }

  async function approveSettlementNotification(notification) {
    if (!selectedTrip || !user || !notification) return;
    setApprovingNotificationId(notification.id);
    try {
      const settlementId = await createCompletedSettlement(
        {
          date: notification.settlementDate || todayIso(),
          fromMemberId: notification.fromMemberId,
          toMemberId: notification.toMemberId,
          amountEur: notification.amountEur,
          notes: notification.notes || "Approved from notification"
        },
        Number(notification.amountEur || 0),
        { approvedFromNotificationId: notification.id }
      );
      await updateDoc(doc(db, "trips", selectedTrip.id, "notifications", notification.id), {
        status: "approved",
        settlementId,
        approvedBy: user.uid,
        approvedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await createSettlementCompletedNotification(notification, Number(notification.amountEur || 0), settlementId);
      setSelectedNotification(null);
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not approve settlement:", error);
      alert("Could not approve settlement.");
    } finally {
      setApprovingNotificationId("");
    }
  }

  async function handleDeleteSettlement(settlement) {
    if (!selectedTrip) return;
    const confirmed = window.confirm(
      `Delete this settlement?\n\n${
        settlement.fromMemberName || memberNameOf(settlement.fromMemberId)
      } paid ${
        settlement.toMemberName || memberNameOf(settlement.toMemberId)
      } ${formatMoney(settlement.amountEur)}`
    );
    if (!confirmed) return;
    try {
      await deleteDoc(
        doc(db, "trips", selectedTrip.id, "settlements", settlement.id)
      );
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not delete settlement:", error);
      alert("Could not delete settlement.");
    }
  }

  async function copySmartSettleSummary() {
    const modeLabels = {
      fewest_payments: "Fewest payments",
      familiar_only: "Familiar payments only",
      family_couple: "Family / couple settle"
    };
    const lines = ["TripHisaab Smart Settle Summary", `Mode: ${modeLabels[settlementMode] || settlementMode}`, ""];
    const groupSuggestions = smartSettleSummary.groupSettlement.suggestions;
    const privateGroups = smartSettleSummary.privateSettlements.filter(
      group => group.suggestions.length > 0
    );
    const totalPending = roundMoney(
      [...groupSuggestions, ...privateGroups.flatMap(group => group.suggestions)]
        .reduce((sum, suggestion) => sum + Number(suggestion.amount || 0), 0)
    );

    lines.push("Group settlement:");
    if (groupSuggestions.length === 0) {
      lines.push("Everyone is settled for group expenses.");
    } else {
      groupSuggestions.forEach((suggestion, index) => {
        lines.push(
          `${index + 1}. ${cleanDisplayName(suggestion.fromName)} pays ${cleanDisplayName(suggestion.toName)} ${formatMoney(suggestion.amount)}`
        );
      });
    }
    if (smartSettleSummary.groupSettlement.fallbackRequired) {
      lines.push("Note: Some balances could not be settled using familiar payments only.");
    }

    lines.push("", `Total pending: ${formatMoney(totalPending)}`, "", "Private settlements:");
    if (privateGroups.length === 0) {
      lines.push("No private settlements.");
    } else {
      privateGroups.forEach(group => {
        lines.push(`${group.memberNames.map(cleanDisplayName).join(" + ")}:`);
        group.suggestions.forEach((suggestion, index) => {
          lines.push(
            `${index + 1}. ${cleanDisplayName(suggestion.fromName)} pays ${cleanDisplayName(suggestion.toName)} ${formatMoney(suggestion.amount)}`
          );
        });
        if (group.fallbackRequired) {
          lines.push("  Note: Some balances could not be settled using familiar payments only.");
        }
      });
    }
    lines.push("", "Small personal expenses are excluded.");

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setSmartSettleToast("Settlement summary copied.");
    } catch (error) {
      console.error("Could not copy Smart Settle summary:", error);
      alert(lines.join("\n"));
    }
  }

  function formatNotificationDate(notification) {
    const raw = notification.createdAtIso || notification.createdAt?.toDate?.()?.toISOString?.();
    if (!raw) return "Just now";
    return new Date(raw).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short"
    });
  }

  async function openNotifications() {
    setIsNotificationsOpen(true);
    const readTargets = visibleNotifications.filter(n => n.status === "unread");
    if (readTargets.length === 0 || !selectedTrip) return;

    setNotifications(current =>
      current.map(n =>
        readTargets.some(target => target.id === n.id)
          ? { ...n, status: "read" }
          : n
      )
    );

    try {
      await Promise.all(
        readTargets.map(n =>
          updateDoc(doc(db, "trips", selectedTrip.id, "notifications", n.id), {
            status: "read",
            readAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          })
        )
      );
    } catch (error) {
      console.warn("Could not mark notifications as read:", error);
    }
  }

  function renderNotificationBell() {
    if (!selectedTrip) return null;
    return (
      <button
        className="notification-bell"
        type="button"
        aria-label="Open notifications"
        onClick={openNotifications}
      >
        <span className="notification-bell-icon">🔔</span>
        {unreadNotificationCount > 0 ? (
          <span className="notification-badge">{unreadNotificationCount}</span>
        ) : null}
      </button>
    );
  }

  function renderNotificationsModal() {
    return (
      <>
        <Modal
          isOpen={isNotificationsOpen}
          onClose={() => setIsNotificationsOpen(false)}
          title="Notifications"
        >
          <div className="modal-body notification-panel">
            {visibleNotifications.length === 0 ? (
              <p className="muted">No notifications yet.</p>
            ) : (
              <div className="notification-list">
                {visibleNotifications.map(notification => (
                  <button
                    className={`notification-item${notification.status === "pending" ? " pending" : ""}`}
                    type="button"
                    key={notification.id}
                    onClick={() =>
                      notification.status === "pending"
                        ? setSelectedNotification(notification)
                        : null
                    }
                  >
                    <strong>{notification.tripName || selectedTrip.name}</strong>
                    <span>From: {notification.actorName || notification.fromMemberName || "Unknown"}</span>
                    <span>
                      Action: {notification.action || "settlement update"}
                      {notification.status === "pending" ? " - approval needed" : ""}
                    </span>
                    <span>
                      With:{" "}
                      {notification.toMemberName === (notification.actorName || notification.fromMemberName)
                        ? notification.fromMemberName
                        : notification.toMemberName || notification.recipientName || "Unknown"}
                    </span>
                    <span>
                      {formatMoney(Number(notification.amountEur || 0))} ·{" "}
                      {formatNotificationDate(notification)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>

        <Modal
          isOpen={Boolean(selectedNotification)}
          onClose={() => setSelectedNotification(null)}
          title="Approve settlement"
        >
          {selectedNotification ? (
            <div className="modal-body notification-approval">
              <p>
                <strong>{selectedNotification.fromMemberName}</strong> says they paid{" "}
                <strong>{selectedNotification.toMemberName}</strong>{" "}
                <strong>{formatMoney(Number(selectedNotification.amountEur || 0))}</strong>.
              </p>
              <p className="small muted">
                Trip: {selectedNotification.tripName || selectedTrip.name}
                <br />
                Requested: {formatNotificationDate(selectedNotification)}
              </p>
              {selectedNotification.notes ? (
                <p className="small muted">Note: {selectedNotification.notes}</p>
              ) : null}
              <footer className="modal-footer">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setSelectedNotification(null)}
                >
                  Later
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={approvingNotificationId === selectedNotification.id}
                  onClick={() => approveSettlementNotification(selectedNotification)}
                >
                  {approvingNotificationId === selectedNotification.id
                    ? "Approving..."
                    : "Approve settlement"}
                </button>
              </footer>
            </div>
          ) : null}
        </Modal>
      </>
    );
  }

  // -------------------- CSV export --------------------
  function exportTripSummaryCsv() {
    if (!selectedTrip) return;
    const remaining = totals.predicted - totals.actual;
    const rows = [];

    rows.push(csvRow(["Trip Summary"]));
    rows.push(csvRow(["Trip name", selectedTrip.name]));
    rows.push(csvRow(["Start date", selectedTrip.startDate]));
    rows.push(csvRow(["End date", selectedTrip.endDate]));
    rows.push(csvRow(["Default currency", selectedTrip.defaultCurrency]));
    rows.push(csvRow(["Status", selectedTrip.status]));
    rows.push(csvRow(["Owner email", selectedTrip.ownerEmail || ""]));
    rows.push(csvRow(["Exported at", new Date().toLocaleString()]));
    rows.push("");

    rows.push(csvRow(["Plan Budget vs Expenses"]));
    rows.push(csvRow(["Metric", "Amount EUR"]));
    rows.push(csvRow(["Plan Budget total", totals.predicted.toFixed(2)]));
    rows.push(csvRow(["Expenses total", totals.actual.toFixed(2)]));
    rows.push(csvRow(["Shared expenses total", totals.shared.toFixed(2)]));
    rows.push(csvRow(["Settled total", totals.settled.toFixed(2)]));
    rows.push(csvRow(["Remaining / Over plan budget", remaining.toFixed(2)]));
    rows.push("");

    rows.push(csvRow(["Category Breakdown"]));
    rows.push(csvRow(["Category", "Type", "Plan Budget EUR", "Expenses EUR", "Difference EUR"]));
    categories.forEach(c => {
      const predicted = Number(groupBudgetByCategoryId.get(c.id) || 0);
      const actual = actualByCategoryId.get(c.id) || 0;
      rows.push(
        csvRow([
          c.name,
          c.type || "",
          predicted.toFixed(2),
          actual.toFixed(2),
          (predicted - actual).toFixed(2)
        ])
      );
    });
    rows.push("");

    rows.push(csvRow(["All Expenses"]));
    rows.push(
      csvRow([
        "Date", "Time", "Description", "Category", "Expense type", "Split type",
        "Paid by", "Amount EUR", "Original amount", "Original currency",
        "Payment method", "Rate source", "Scope", "Visible to", "Split details", "Notes"
      ])
    );
    expenses.forEach(e => {
      const splitDetails =
        e.expenseType === "shared" && e.splitType === "custom"
          ? Object.entries(e.customSplitSharesEur || {})
              .map(([id, amount]) => `${memberNameOf(id)}: €${Number(amount || 0).toFixed(2)}`)
              .join(" | ")
          : e.expenseType === "shared"
          ? `Equal split between ${(e.splitMemberIds || []).map(memberNameOf).join(" | ")}`
          : "Personal";

      rows.push(
        csvRow([
          e.date || "",
          e.time || "",
          e.description || "",
          e.categoryName || "",
          e.expenseType || "",
          e.splitType || "",
          memberNameOf(e.paidByMemberId),
          Number(e.amountEur || 0).toFixed(2),
          Number(e.originalAmount || e.amountEur || 0).toFixed(2),
          e.originalCurrency || "EUR",
          e.paymentMethod || "",
          e.ratesSource || "",
          normalizeExpenseScope(e),
          e.visibleTo === "all"
            ? "All"
            : Array.isArray(e.visibleTo)
            ? e.visibleTo.map(memberNameOf).join(" | ")
            : "",
          splitDetails,
          e.notes || ""
        ])
      );
    });
    rows.push("");

    rows.push(csvRow(["Member Balances"]));
    rows.push(
      csvRow([
        "Member", "Paid EUR", "Owes EUR", "Settled paid EUR",
        "Settled received EUR", "Net EUR"
      ])
    );
    balances.forEach(b => {
      rows.push(
        csvRow([
          b.name,
          b.paid.toFixed(2),
          b.owes.toFixed(2),
          b.settledPaid.toFixed(2),
          b.settledReceived.toFixed(2),
          b.net.toFixed(2)
        ])
      );
    });
    rows.push("");

    rows.push(csvRow(["Smart Settle Suggestions"]));
    rows.push(csvRow(["Layer", "Private group", "From", "To", "Amount EUR", "Status"]));
    if (smartSettleSummary.groupSettlement.suggestions.length === 0) {
      rows.push(csvRow(["Group", "", "Everyone is settled", "", "", ""]));
    } else {
      smartSettleSummary.groupSettlement.suggestions.forEach(s => {
        rows.push(csvRow(["Group", "", s.fromName, s.toName, s.amount.toFixed(2), s.status]));
      });
    }
    smartSettleSummary.privateSettlements.forEach(group => {
      group.suggestions.forEach(s => {
        rows.push(csvRow([
          "Private",
          group.memberNames.join(" + "),
          s.fromName,
          s.toName,
          s.amount.toFixed(2),
          s.status
        ]));
      });
    });
    rows.push("");

    rows.push(csvRow(["Settlement History"]));
    rows.push(csvRow(["Date", "Layer", "Private group", "From", "To", "Amount EUR", "Currency", "Status", "Paid At", "Notes"]));
    settlements.forEach(s => {
      rows.push(
        csvRow([
          s.date || "",
          s.settlementLayer === "private" ? "Private" : "Group",
          s.settlementGroupId || "",
          s.fromMemberName || memberNameOf(s.fromMemberId),
          s.toMemberName || memberNameOf(s.toMemberId),
          Number(s.amountEur || 0).toFixed(2),
          s.currency || selectedTrip.defaultCurrency || "EUR",
          s.status || "paid",
          s.paidAt?.toDate?.()?.toLocaleString?.() || "",
          s.notes || ""
        ])
      );
    });

    downloadCsv(`${slugify(selectedTrip.name) || "trip"}-summary.csv`, rows.join("\n"));
  }

  // -------------------- Render: expense form --------------------
  function renderExpenseForm({ mode, formData, setFormData, onSubmit, saving, onCancel }) {
    const isEdit = mode === "edit";
    const totalAmount = Number(formData.originalAmount || 0);
    const previewEur = convertToEur(totalAmount, formData.originalCurrency || "EUR");
    const customTotal = getCustomSplitTotal(formData);
    const percentTotal = getPercentageSplitTotal(formData);
    const isShared = formData.expenseType === "shared";

    const AVATAR_COLORS = [
      "#0f766e","#2563eb","#d97706","#7c3aed","#be185d","#0891b2","#15803d","#dc2626"
    ];
    function getMemberColor(memberId) {
      const idx = activeMembers.findIndex(m => m.id === memberId);
      return AVATAR_COLORS[Math.max(idx, 0) % AVATAR_COLORS.length];
    }
    function getMemberInitials(memberId) {
      const name = memberNameOf(memberId);
      return name ? name.charAt(0).toUpperCase() : "?";
    }
    function getMemberShortName(memberId) {
      const name = memberNameOf(memberId);
      if (!name) return "?";
      const first = name.trim().split(" ")[0];
      return first.length > 9 ? first.slice(0, 8) + "…" : first;
    }

    function handleExpenseTypeChange(nextType) {
      if (nextType === "personal" && expenseFormTab === "paidby") {
        setExpenseFormTab("basic");
      }
      setFormData({
        ...formData,
        expenseType: nextType,
        splitType: nextType === "shared" ? formData.splitType || "equal" : "equal",
        splitMemberIds: nextType === "shared"
          ? activeMembers.map(m => m.id)
          : formData.paidByMemberId ? [formData.paidByMemberId] : [],
        customSplitShares: nextType === "shared" ? formData.customSplitShares || {} : {}
      });
    }

    function handleSplitTypeChange(nextSplit) {
      setFormData({
        ...formData,
        splitType: nextSplit,
        splitMemberIds: nextSplit === "equal" ? activeMembers.map(m => m.id) : formData.splitMemberIds,
        customSplitShares: (nextSplit === "custom" || nextSplit === "percent") ? formData.customSplitShares || {} : {}
      });
    }

    // Tabs vary by expense type
    const EXP_TABS = isShared
      ? [
          { id: "basic",  label: "Basic",   icon: "📋" },
          { id: "paidby", label: "Paid by", icon: "👥" },
          { id: "notes",  label: "Notes",   icon: "📝" },
        ]
      : [
          { id: "basic", label: "Basic", icon: "📋" },
          { id: "notes", label: "Notes", icon: "📝" },
        ];

    // Clamp active tab to valid tabs for current type
    const validTabIds = EXP_TABS.map(t => t.id);
    const activeTab = validTabIds.includes(expenseFormTab) ? expenseFormTab : "basic";

    // Swipe handlers
    function onTouchStart(e) {
      expenseTouchStartXRef.current = e.touches[0].clientX;
    }
    function onTouchEnd(e) {
      if (expenseTouchStartXRef.current === null) return;
      const dx = e.changedTouches[0].clientX - expenseTouchStartXRef.current;
      expenseTouchStartXRef.current = null;
      if (Math.abs(dx) < 50) return;
      const idx = EXP_TABS.findIndex(t => t.id === activeTab);
      if (dx < 0 && idx < EXP_TABS.length - 1) setExpenseFormTab(EXP_TABS[idx + 1].id);
      else if (dx > 0 && idx > 0) setExpenseFormTab(EXP_TABS[idx - 1].id);
    }

    return (
      <form className="modal-form exp-tabbed-form" onSubmit={onSubmit}>

        {/* Tab navigation */}
        <div className="exp-tab-nav">
          {EXP_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`exp-tab-btn${activeTab === tab.id ? " active" : ""}`}
              onClick={() => setExpenseFormTab(tab.id)}
            >
              <span className="exp-tab-icon">{tab.icon}</span>
              <span className="exp-tab-label">{tab.label}</span>
            </button>
          ))}
        </div>

        <div
          className="modal-body exp-tab-body"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >

          {/* ── Basic ── */}
          {activeTab === "basic" && (
            <div className="exp-tab-content">

              {/* Amount + Currency at the top */}
              <div className="grid-2">
                <label>
                  Amount
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.originalAmount}
                    placeholder="0.00"
                    autoFocus
                    onChange={e => setFormData({ ...formData, originalAmount: e.target.value })}
                    required
                  />
                </label>
                <label>
                  Currency
                  <select
                    value={formData.originalCurrency}
                    onChange={e => setFormData({ ...formData, originalCurrency: e.target.value })}
                  >
                    {SUPPORTED_CURRENCIES.map(c => (
                      <option value={c} key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* EUR rate preview */}
              {totalAmount > 0 && (
                <div className="exp-rate-preview">
                  <span>≈ <strong>{formatMoney(previewEur)}</strong></span>
                  <span className="exp-rate-note">
                    1 EUR = {getCurrencyRate(formData.originalCurrency).toFixed(4)} {formData.originalCurrency}
                  </span>
                </div>
              )}

              <div className="grid-2">
                <label>
                  Date
                  <input
                    type="date"
                    value={formData.date}
                    onClick={openDatePicker}
                    onChange={e => setFormData({ ...formData, date: e.target.value })}
                    required
                  />
                </label>
                <label>
                  Time
                  <input
                    type="time"
                    value={formData.time}
                    onChange={e => setFormData({ ...formData, time: e.target.value })}
                    required
                  />
                </label>
              </div>

              <label>
                Category
                <select
                  value={formData.categoryId}
                  onChange={e => setFormData({ ...formData, categoryId: e.target.value })}
                  required
                >
                  <option value="">Choose category</option>
                  {activeCategories.map(c => (
                    <option value={c.id} key={c.id}>{c.icon} {c.name}</option>
                  ))}
                </select>
              </label>

              <div className="exp-section-header">Expense type</div>
              <div className="exp-type-toggle">
                <button
                  type="button"
                  className={`exp-type-btn${formData.expenseType === "personal" ? " active" : ""}`}
                  onClick={() => handleExpenseTypeChange("personal")}
                >
                  👤 Personal
                </button>
                <button
                  type="button"
                  className={`exp-type-btn${formData.expenseType === "shared" ? " active" : ""}`}
                  onClick={() => handleExpenseTypeChange("shared")}
                >
                  👥 Shared
                </button>
              </div>
            </div>
          )}

          {/* ── Paid by + Split (shared only) ── */}
          {activeTab === "paidby" && (
            <div className="exp-tab-content">

              <label>
                Who paid?
                <select
                  value={formData.paidByMemberId}
                  onChange={e => setFormData({ ...formData, paidByMemberId: e.target.value })}
                  required
                >
                  <option value="">Choose payer</option>
                  {activeMembers.map(m => (
                    <option value={m.id} key={m.id}>{memberNameOf(m.id)}</option>
                  ))}
                </select>
              </label>

              <div className="exp-section-header">How to split?</div>

              <div className="exp-split-tabs">
                {[
                  { id: "equal",   label: "Equal" },
                  { id: "custom",  label: "Custom" },
                  { id: "percent", label: "%" },
                ].map(st => (
                  <button
                    key={st.id}
                    type="button"
                    className={`split-type-btn${formData.splitType === st.id ? " active" : ""}`}
                    onClick={() => handleSplitTypeChange(st.id)}
                  >
                    {st.label}
                  </button>
                ))}
              </div>

              {/* ---- Equal split: tap-to-toggle member tiles ---- */}
              {formData.splitType === "equal" && (
                <>
                  <div className="member-tile-grid">
                    {activeMembers.map(m => {
                      const included = (formData.splitMemberIds || []).includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={`member-tile${included ? " selected" : ""}`}
                          onClick={() => toggleSplitMember(formData, setFormData, m.id)}
                        >
                          <div className="member-tile-avatar" style={{ background: included ? getMemberColor(m.id) : undefined }}>
                            {getMemberInitials(m.id)}
                          </div>
                          <span className="member-tile-name">{getMemberShortName(m.id)}</span>
                          {included && <span className="member-tile-check">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                  {(formData.splitMemberIds || []).length > 0 && totalAmount > 0 && (
                    <div className="exp-summary-card balanced">
                      <span className="exp-summary-label">Each pays</span>
                      <strong className="exp-summary-amount">
                        {formatCurrency(totalAmount / (formData.splitMemberIds || []).length, formData.originalCurrency || "EUR")}
                      </strong>
                      <span className="exp-summary-meta">{(formData.splitMemberIds || []).length} people</span>
                    </div>
                  )}
                </>
              )}

              {/* ---- Custom exact amounts: tiles with amount input ---- */}
              {formData.splitType === "custom" && (
                <>
                  <p className="exp-split-hint">
                    Enter each person's share in {formData.originalCurrency || "EUR"}. Must equal the total.
                  </p>
                  <div className="member-tile-grid">
                    {activeMembers.map(m => {
                      const val = (formData.customSplitShares || {})[m.id] || "";
                      const hasValue = Number(val) > 0;
                      return (
                        <div key={m.id} className={`member-tile has-input${hasValue ? " selected" : ""}`}>
                          <div className="member-tile-avatar" style={{ background: hasValue ? getMemberColor(m.id) : undefined }}>
                            {getMemberInitials(m.id)}
                          </div>
                          <span className="member-tile-name">{getMemberShortName(m.id)}</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={val}
                            placeholder="0.00"
                            className="member-tile-input"
                            onClick={e => e.stopPropagation()}
                            onChange={e => updateCustomSplitShare(formData, setFormData, m.id, e.target.value)}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className={`exp-split-total${totalAmount > 0 && Math.abs(totalAmount - customTotal) < 0.02 ? " balanced" : ""}`}>
                    <span>Split total: <strong>{formatCurrency(customTotal, formData.originalCurrency || "EUR")}</strong></span>
                    <span className="muted">/ {formatCurrency(totalAmount, formData.originalCurrency || "EUR")}</span>
                  </div>
                </>
              )}

              {/* ---- Percentage split: tiles with % input ---- */}
              {formData.splitType === "percent" && (
                <>
                  <p className="exp-split-hint">Enter each person's share as a percentage. Must total 100%.</p>
                  <div className="member-tile-grid">
                    {activeMembers.map(m => {
                      const val = (formData.customSplitShares || {})[m.id] || "";
                      const hasValue = Number(val) > 0;
                      return (
                        <div key={m.id} className={`member-tile has-input${hasValue ? " selected" : ""}`}>
                          <div className="member-tile-avatar" style={{ background: hasValue ? getMemberColor(m.id) : undefined }}>
                            {getMemberInitials(m.id)}
                          </div>
                          <span className="member-tile-name">{getMemberShortName(m.id)}</span>
                          <div className="member-tile-pct-wrap">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.1"
                              value={val}
                              placeholder="0"
                              className="member-tile-input"
                              onClick={e => e.stopPropagation()}
                              onChange={e => updateCustomSplitShare(formData, setFormData, m.id, e.target.value)}
                            />
                            <span className="member-tile-pct-suffix">%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className={`exp-split-total${Math.abs(percentTotal - 100) < 0.1 && percentTotal > 0 ? " balanced" : ""}`}>
                    <span>Total: <strong>{percentTotal.toFixed(1)}%</strong></span>
                    {totalAmount > 0 && percentTotal > 0 && (
                      <span className="muted">≈ {formatCurrency(totalAmount * percentTotal / 100, formData.originalCurrency || "EUR")}</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Notes ── */}
          {activeTab === "notes" && (
            <div className="exp-tab-content">
              <label>
                Description
                <input
                  type="text"
                  value={formData.description}
                  placeholder="e.g. Lunch, taxi, hotel (optional)"
                  onChange={e => setFormData({ ...formData, description: e.target.value })}
                />
              </label>

              <label>
                Payment method
                <select
                  value={formData.paymentMethod}
                  onChange={e => setFormData({ ...formData, paymentMethod: e.target.value })}
                >
                  <option value="card">💳 Card</option>
                  <option value="cash">💵 Cash</option>
                  <option value="bank">🏦 Bank transfer</option>
                  <option value="other">🔄 Other</option>
                </select>
              </label>

              <label>
                Notes
                <textarea
                  value={formData.notes}
                  placeholder="Any additional notes… (optional)"
                  rows={5}
                  onChange={e => setFormData({ ...formData, notes: e.target.value })}
                  style={{ resize: "vertical" }}
                />
              </label>
            </div>
          )}

        </div>

        <footer className="modal-footer">
          {onCancel && (
            <button className="secondary-button" type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save expense" : "Add expense"}
          </button>
        </footer>
      </form>
    );
  }

  // -------------------- Render: settlements tab --------------------
  function saveSettlementModeToStorage(mode) {
    if (!selectedTrip) return;
    try { localStorage.setItem(`triphisaab-settle-mode-${selectedTrip.id}`, mode); } catch { /* ignore */ }
  }

  function saveSettlementGroupsToStorage(groups) {
    if (!selectedTrip) return;
    try { localStorage.setItem(`triphisaab-settle-groups-${selectedTrip.id}`, JSON.stringify(groups)); } catch { /* ignore */ }
  }

  function handleSettlementModeChange(mode) {
    setSettlementMode(mode);
    saveSettlementModeToStorage(mode);
    setExpandedSmartSettleId("");
  }

  function handleSaveSettlementGroup(e) {
    e.preventDefault();
    const { name, memberIds, type } = settlementGroupForm;
    if (!name.trim()) return alert("Group name is required.");
    if (memberIds.length < 2) return alert("A settlement group must have at least 2 members.");

    const activeGroups = settlementGroups.filter(g => g.isActive !== false && g.id !== editingSettlementGroupId);
    const takenIds = new Set(activeGroups.flatMap(g => g.memberIds));
    const conflict = memberIds.find(id => takenIds.has(id));
    if (conflict) {
      const m = members.find(mb => mb.id === conflict);
      return alert(`${memberDisplayName(m) || conflict} is already in another settlement group.`);
    }

    let nextGroups;
    if (editingSettlementGroupId) {
      nextGroups = settlementGroups.map(g =>
        g.id === editingSettlementGroupId
          ? { ...g, name: name.trim(), memberIds, type, updatedAt: new Date().toISOString() }
          : g
      );
    } else {
      const newGroup = {
        id: `sg-${Date.now()}`,
        name: name.trim(),
        memberIds,
        type,
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      nextGroups = [...settlementGroups, newGroup];
    }
    setSettlementGroups(nextGroups);
    saveSettlementGroupsToStorage(nextGroups);
    setShowSettlementGroupForm(false);
    setEditingSettlementGroupId(null);
    setSettlementGroupForm({ name: "", memberIds: [], type: "couple" });
  }

  function handleEditSettlementGroup(group) {
    setEditingSettlementGroupId(group.id);
    setSettlementGroupForm({ name: group.name, memberIds: group.memberIds, type: group.type || "couple" });
    setShowSettlementGroupForm(true);
  }

  function handleDeleteSettlementGroup(groupId) {
    const nextGroups = settlementGroups.map(g =>
      g.id === groupId ? { ...g, isActive: false } : g
    );
    setSettlementGroups(nextGroups);
    saveSettlementGroupsToStorage(nextGroups);
    if (editingSettlementGroupId === groupId) {
      setShowSettlementGroupForm(false);
      setEditingSettlementGroupId(null);
    }
  }

  function renderSettlementsTab() {
    const groupSettlement = smartSettleSummary.groupSettlement;
    const privateSettlements = smartSettleSummary.privateSettlements;
    const privateGroupsWithSuggestions = privateSettlements.filter(group => group.suggestions.length > 0);
    const pendingSuggestions = [
      ...groupSettlement.suggestions,
      ...privateGroupsWithSuggestions.flatMap(group => group.suggestions)
    ];
    const pendingTotal = roundMoney(
      pendingSuggestions.reduce((sum, suggestion) => sum + Number(suggestion.amount || 0), 0)
    );
    const isFamilyCoupleMode = settlementMode === "family_couple";
    const involvedSet = new Set();
    pendingSuggestions.forEach(s => {
      involvedSet.add(s.fromMemberId || s.fromUserId);
      involvedSet.add(s.toMemberId || s.toUserId);
    });
    const receiverIds = new Set(groupSettlement.suggestions.map(s => s.toMemberId || s.toUserId));
    const singleGroupReceiver =
      groupSettlement.suggestions.length > 0 && receiverIds.size === 1
        ? groupSettlement.suggestions[0]
        : null;
    const groupSettlementSentence = singleGroupReceiver
      ? `${cleanDisplayName(singleGroupReceiver.toName)} should receive ${formatMoney(
          groupSettlement.suggestions.reduce((sum, s) => sum + Number(s.amount || 0), 0)
        )} total.`
      : `${groupSettlement.suggestions.length} ${
          groupSettlement.suggestions.length === 1 ? "payment" : "payments"
        } needed to settle group expenses.`;
    const hasExpenses = expenses.some(expense => expense.isActive !== false);

    const modeOptions = [
      { value: "fewest_payments", label: "Fewest payments", desc: "Minimizes the number of payments across the group." },
      { value: "familiar_only", label: "Familiar payments only", desc: "Only suggests payments between people who shared at least one expense." },
      { value: "family_couple", label: "Family / couple settle", desc: "Couples, families, or sub-groups can settle together as one unit." }
    ];
    const currentModeDesc = modeOptions.find(o => o.value === settlementMode)?.desc || "";

    const summaryCards = [
      {
        label: "Pending total",
        value: formatMoney(pendingTotal),
        detail: "Needs to be settled",
        icon: "€",
        tone: "mint"
      },
      {
        label: "Payments needed",
        value: pendingSuggestions.length,
        detail: "Minimum payments",
        icon: "⇄",
        tone: "blue"
      },
      {
        label: isFamilyCoupleMode ? "Units involved" : "People involved",
        value: involvedSet.size,
        detail: "In this settlement",
        icon: "👥",
        tone: "purple"
      },
      {
        label: "Private groups",
        value: privateGroupsWithSuggestions.length,
        detail: "With private settlements",
        icon: "👪",
        tone: "amber"
      }
    ];

    const activeMembers = members.filter(m => m.status !== "inactive");
    const activeGroups = settlementGroups.filter(g => g.isActive !== false);
    const assignedMemberIds = new Set(activeGroups.flatMap(g => g.memberIds));
    const unassignedMembers = activeMembers.filter(m => !assignedMemberIds.has(m.id));

    const renderSuggestionCard = (suggestion, layer, settlementGroupId, balancesForLayer) => {
      const cardId = `${layer}-${settlementGroupId || "group"}-${suggestion.id}`;
      const fromBalance = balancesForLayer.find(b => b.memberId === (suggestion.fromMemberId || suggestion.fromUserId));
      const toBalance = balancesForLayer.find(b => b.memberId === (suggestion.toMemberId || suggestion.toUserId));
      const expanded = expandedSmartSettleId === cardId;
      const fromInitial = cleanDisplayName(suggestion.fromName).slice(0, 1).toUpperCase();
      const isUnitSuggestion = suggestion.fromType === "unit" || suggestion.toType === "unit";
      return (
        <div className="smart-settle-row" key={cardId}>
          <div className={`smart-settle-avatar${isUnitSuggestion ? " unit-avatar" : ""}`} aria-hidden="true">
            {fromInitial}
          </div>
          <div className="smart-settle-main">
            <div className="smart-settle-route">
              <strong>{cleanDisplayName(suggestion.fromName)}</strong>
              <span aria-hidden="true">→</span>
              <strong>{cleanDisplayName(suggestion.toName)}</strong>
            </div>
            <p className="small muted">
              {layer === "private" ? "Private settlement" : "Group settlement"}
              {isUnitSuggestion ? " · Unit" : ""}
            </p>
          </div>
          <div className="smart-settle-side">
            <strong className="smart-settle-amount">{formatMoney(suggestion.amount)}</strong>
            <span className="pill pending-pill">Pending</span>
          </div>
          <div className="settlement-actions">
            <button
              className="secondary-button small-button"
              type="button"
              onClick={() => setExpandedSmartSettleId(expanded ? "" : cardId)}
            >
              ☷ Breakdown
            </button>
            {!isDemoMode() ? (
            <button
              className="primary-button small-button"
              type="button"
              disabled={savingSettlement}
              onClick={() => setPendingSmartSettlement({ suggestion, layer, settlementGroupId })}
            >
              ✓ Mark paid
            </button>
            ) : null}
          </div>
          {expanded ? (
            <div className="smart-settle-breakdown">
              {[fromBalance, toBalance].filter(Boolean).map(balance => (
                <p className="small muted" key={balance.memberId}>
                  <strong>{cleanDisplayName(balance.name)}</strong>: paid {formatMoney(balance.paid)}, share {formatMoney(balance.share)}, net {formatMoney(balance.net)}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      );
    };

    const renderFamiliarFallback = (unresolvedDebtors, unresolvedCreditors) => {
      if (!unresolvedDebtors?.length && !unresolvedCreditors?.length) return null;
      // Reconstruct balances from remaining amounts for the fallback greedy pass.
      const fallbackBalances = [
        ...(unresolvedDebtors || []).map(d => ({ ...d, net: -d.amount })),
        ...(unresolvedCreditors || []).map(c => ({ ...c, net: c.amount }))
      ];
      const fallbackSuggestions = generateSettlementSuggestions(
        fallbackBalances,
        selectedTrip?.defaultCurrency || "EUR"
      );
      return (
        <div className="settle-fallback-section">
          <div className="settle-fallback-banner">
            <span aria-hidden="true">!</span>
            <div>
              <strong>Familiar payments only could not settle all balances.</strong>
              <p className="small muted">The following suggestions use non-familiar pairings as a fallback.</p>
            </div>
          </div>
          {fallbackSuggestions.map(s => (
            <div className="smart-settle-row fallback-row" key={s.id}>
              <div className="smart-settle-avatar fallback-avatar" aria-hidden="true">
                {cleanDisplayName(s.fromName).slice(0, 1).toUpperCase()}
              </div>
              <div className="smart-settle-main">
                <div className="smart-settle-route">
                  <strong>{cleanDisplayName(s.fromName)}</strong>
                  <span aria-hidden="true">→</span>
                  <strong>{cleanDisplayName(s.toName)}</strong>
                </div>
                <p className="small muted">Fallback suggestion</p>
              </div>
              <div className="smart-settle-side">
                <strong className="smart-settle-amount">{formatMoney(s.amount)}</strong>
                <span className="pill fallback-pill">Fallback</span>
              </div>
            </div>
          ))}
        </div>
      );
    };

    const renderSettlementGroupsManager = () => {
      const typeLabels = { couple: "Couple", family: "Family", custom: "Custom", individual: "Individual" };
      return (
        <section className="card smart-settle-panel settle-groups-panel">
          <div>
            <h3>Settlement groups</h3>
            <p className="small muted">Group members who settle as one unit (e.g. couples, families).</p>
          </div>

          {activeGroups.length === 0 && !showSettlementGroupForm ? (
            <div className="settle-groups-empty">
              <p className="muted">No groups yet. All members settle individually by default.</p>
            </div>
          ) : (
            <div className="settle-groups-list">
              {activeGroups.map(group => (
                <div className="settle-group-row" key={group.id}>
                  <div className="settle-group-info">
                    <strong>{group.name}</strong>
                    <span className="small muted"> · {typeLabels[group.type] || group.type}</span>
                    <p className="small muted">
                      {group.memberIds
                        .map(id => {
                          const m = members.find(mb => mb.id === id);
                          return m ? cleanDisplayName(memberDisplayName(m)) : id;
                        })
                        .join(", ")}
                    </p>
                  </div>
                  <div className="settle-group-actions">
                    <button
                      className="secondary-button small-button"
                      type="button"
                      onClick={() => handleEditSettlementGroup(group)}
                    >
                      Edit
                    </button>
                    <button
                      className="secondary-button small-button"
                      type="button"
                      onClick={() => handleDeleteSettlementGroup(group.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              {unassignedMembers.length > 0 ? (
                <div className="settle-individuals-note">
                  <p className="small muted">
                    Settling individually: {unassignedMembers.map(m => cleanDisplayName(memberDisplayName(m))).join(", ")}
                  </p>
                </div>
              ) : null}
            </div>
          )}

          {showSettlementGroupForm ? (
            <form className="settle-group-form" onSubmit={handleSaveSettlementGroup}>
              <h4>{editingSettlementGroupId ? "Edit group" : "New settlement group"}</h4>
              <div className="form-row">
                <label className="form-label">Group name</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="e.g. Priya + Rahul"
                  value={settlementGroupForm.name}
                  onChange={e => setSettlementGroupForm(f => ({ ...f, name: e.target.value }))}
                  required
                />
              </div>
              <div className="form-row">
                <label className="form-label">Group type</label>
                <select
                  className="form-input"
                  value={settlementGroupForm.type}
                  onChange={e => setSettlementGroupForm(f => ({ ...f, type: e.target.value }))}
                >
                  <option value="couple">Couple</option>
                  <option value="family">Family</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div className="form-row">
                <label className="form-label">Members (select 2 or more)</label>
                <div className="settle-group-member-list">
                  {activeMembers.map(member => {
                    const checked = settlementGroupForm.memberIds.includes(member.id);
                    const otherGroupHas =
                      !checked &&
                      settlementGroups
                        .filter(g => g.isActive !== false && g.id !== editingSettlementGroupId)
                        .some(g => g.memberIds.includes(member.id));
                    return (
                      <label
                        key={member.id}
                        className={`settle-member-checkbox${otherGroupHas ? " dimmed" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={otherGroupHas}
                          onChange={ev => {
                            setSettlementGroupForm(f => ({
                              ...f,
                              memberIds: ev.target.checked
                                ? [...f.memberIds, member.id]
                                : f.memberIds.filter(id => id !== member.id)
                            }));
                          }}
                        />
                        <span>{cleanDisplayName(memberDisplayName(member))}</span>
                        {otherGroupHas ? <span className="small muted"> (in another group)</span> : null}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="settle-group-form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setShowSettlementGroupForm(false);
                    setEditingSettlementGroupId(null);
                    setSettlementGroupForm({ name: "", memberIds: [], type: "couple" });
                  }}
                >
                  Cancel
                </button>
                <button className="primary-button" type="submit">
                  {editingSettlementGroupId ? "Save group" : "Add group"}
                </button>
              </div>
            </form>
          ) : (
            <button
              className="secondary-button"
              type="button"
              style={{ justifySelf: "start" }}
              onClick={() => {
                setSettlementGroupForm({ name: "", memberIds: [], type: "couple" });
                setEditingSettlementGroupId(null);
                setShowSettlementGroupForm(true);
              }}
            >
              + Add settlement group
            </button>
          )}
        </section>
      );
    };

    return (
      <section className="smart-settle-page">
        <div className="smart-settle-hero">
          <div>
            <h2>Smart Settle</h2>
            <p className="muted">See who pays whom and settle trip expenses.</p>
          </div>
          <div className="smart-settle-toolbar">
            <button
              className="secondary-button"
              type="button"
              onClick={copySmartSettleSummary}
            >
              ⧉ Copy summary
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={tripDataLoading}
              onClick={() => selectedTrip ? loadTripData(selectedTrip.id) : null}
            >
              ↻ Recalculate
            </button>
          </div>
        </div>

        <div className="settle-mode-bar card">
          <p className="settle-mode-label">Settlement mode</p>
          <div className="settle-mode-options">
            {modeOptions.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`settle-mode-btn${settlementMode === opt.value ? " active" : ""}`}
                onClick={() => handleSettlementModeChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="small muted settle-mode-desc">{currentModeDesc}</p>
        </div>

        <div className="smart-settle-summary-grid">
          {summaryCards.map(card => (
            <div className="smart-summary-card" key={card.label}>
              <div className={`smart-summary-icon ${card.tone}`}>{card.icon}</div>
              <div>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <p>{card.detail}</p>
              </div>
            </div>
          ))}
        </div>

        {isFamilyCoupleMode ? renderSettlementGroupsManager() : null}

        {!hasExpenses ? (
          <section className="card smart-empty-card">
            <p className="muted">No expenses added yet.</p>
          </section>
        ) : (
          <div className="smart-settle-grid">
            <section className="card smart-settle-panel group-panel">
              <div>
                <h3>Group Settlement</h3>
                <p className="small muted">Shared expenses visible to everyone.</p>
              </div>
              {groupSettlement.suggestions.length > 0 ? (
                <p className="smart-settle-summary-sentence">
                  <span aria-hidden="true">✓</span>
                  {groupSettlementSentence}
                </p>
              ) : null}
              {groupSettlement.suggestions.length === 0 && !groupSettlement.fallbackRequired ? (
                <p className="muted">Everyone is settled for group expenses.</p>
              ) : (
                <div className="settlement-list">
                  {groupSettlement.suggestions.map(suggestion =>
                    renderSuggestionCard(suggestion, "group", null, groupSettlement.balances)
                  )}
                </div>
              )}
              {groupSettlement.fallbackRequired
                ? renderFamiliarFallback(groupSettlement.unresolvedDebtors, groupSettlement.unresolvedCreditors)
                : null}
              {isFamilyCoupleMode && activeGroups.length === 0 && groupSettlement.suggestions.length === 0 ? (
                <p className="muted">No settlement groups created. Members settle individually by default.</p>
              ) : null}
            </section>

            <section className="card smart-settle-panel private-panel">
              <div>
                <h3>Private Settlements</h3>
                <p className="small muted">Settlements only visible to selected members.</p>
              </div>
              {privateGroupsWithSuggestions.length === 0 ? (
                <div className="private-empty-state">
                  <div className="private-empty-icon" aria-hidden="true">
                    <span>👥</span>
                    <small>🔒</small>
                  </div>
                  <h4>No private settlements yet.</h4>
                  <p className="muted">
                    Private settlements appear here for expenses shared only with selected members, like couples, families, or sub-groups.
                  </p>
                </div>
              ) : (
                <div className="private-settlement-list">
                  {privateGroupsWithSuggestions.map(group => (
                    <div className="private-settlement-group" key={group.settlementGroupId}>
                      <h4>{group.memberNames.map(cleanDisplayName).join(" + ")}</h4>
                      <p className="small muted">Total shared privately: {formatMoney(group.totalSpent)}</p>
                      <div className="settlement-list">
                        {group.suggestions.map(suggestion =>
                          renderSuggestionCard(
                            suggestion,
                            "private",
                            group.settlementGroupId,
                            group.balances
                          )
                        )}
                      </div>
                      {group.fallbackRequired
                        ? renderFamiliarFallback(group.unresolvedDebtors, group.unresolvedCreditors)
                        : null}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <section className="card smart-settle-panel">
          <h2>Settlement History</h2>
          {settlements.length === 0 ? (
            <p className="muted">No settlements recorded yet. Paid settlements will appear here.</p>
          ) : (
            <div className="settlement-history-list">
              {settlements.map(s => (
                <div className="settlement-history-row" key={s.id}>
                  <span className="history-check" aria-hidden="true">✓</span>
                  <div className="smart-settle-avatar history-avatar" aria-hidden="true">
                    {cleanDisplayName(s.fromMemberName || memberNameOf(s.fromMemberId)).slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <strong>
                      {cleanDisplayName(s.fromMemberName || memberNameOf(s.fromMemberId))}
                      {" → "}
                      {cleanDisplayName(s.toMemberName || memberNameOf(s.toMemberId))}
                    </strong>
                    <p className="small muted">{s.notes || "Settlement payment"}</p>
                  </div>
                  <strong className="history-amount">{formatMoney(s.amountEur)}</strong>
                  <span className="pill paid-pill">Paid</span>
                  <p className="small muted history-date">
                    Paid on {s.paidAt?.toDate?.()?.toLocaleString?.() || s.date || "recorded date"}
                  </p>
                  {!isDemoMode() ? (
                  <button
                    className="secondary-button small-button"
                    type="button"
                    onClick={() => handleDeleteSettlement(s)}
                  >
                    View details
                  </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </section>
    );
  }

  // -------------------- Render: trip screen --------------------
  function renderTripScreen() {
    const remaining = totals.predicted - totals.actual;
    const budgetPct = totals.predicted > 0
      ? Math.min(100, Math.round((totals.actual / totals.predicted) * 100))
      : 0;
    const r = 52;
    const circ = 2 * Math.PI * r;
    const dashFill = (budgetPct / 100) * circ;

    const tripStart = new Date(selectedTrip.startDate);
    const tripEnd = new Date(selectedTrip.endDate);
    const todayDate = new Date(todayIso());
    const totalDays = Math.max(1, Math.round((tripEnd - tripStart) / 86400000) + 1);
    const daysIn = Math.max(0, Math.min(totalDays, Math.round((todayDate - tripStart) / 86400000) + 1));
    const daysLeft = Math.max(0, Math.round((tripEnd - todayDate) / 86400000));

    const budgetMsg = budgetPct === 0
      ? "Add your first expense to start tracking 🌍"
      : budgetPct < 50 ? "You're still cruising under budget 😎"
      : budgetPct < 80 ? "On track with your budget 👌"
      : budgetPct < 100 ? "Getting close to the limit ⚠️"
      : "Budget exceeded 😬";

    const userInitial = (user?.displayName || user?.email || "?")[0].toUpperCase();
    const demoMode = isDemoMode();
    const spendingBreakdown = categories
      .map((category, index) => {
        const actual = actualByCategoryId.get(category.id) || 0;
        return {
          ...category,
          actual,
          color: category.color || [
            "#0f766e",
            "#2563eb",
            "#7c3aed",
            "#ea580c",
            "#16a34a",
            "#db2777"
          ][index % 6]
        };
      })
      .filter(category => category.actual > 0);
    let breakdownCursor = 0;
    const breakdownGradient = spendingBreakdown.length > 0
      ? spendingBreakdown
          .map(category => {
            const start = breakdownCursor;
            const end = breakdownCursor + (category.actual / totals.actual) * 100;
            breakdownCursor = end;
            return `${category.color} ${start}% ${end}%`;
          })
          .join(", ")
      : "#e5e7eb 0% 100%";

    const expenseFilterOptions = [
      { key: "all", label: "All", count: expenses.length },
      { key: "shared", label: "Shared", count: expenses.filter(e => e.expenseType === "shared").length },
      { key: "personal", label: "Personal", count: expenses.filter(e => e.expenseType !== "shared").length },
      { key: "pending", label: "Pending split", count: expenseStats.pendingSplit }
    ];
    const expenseSummaryCards = [
      {
        label: "Total spent",
        value: formatMoney(expenseStats.total),
        sub: `${expenses.length} expense${expenses.length === 1 ? "" : "s"}`,
        icon: "€",
        tone: "mint"
      },
      {
        label: "Shared expenses",
        value: formatMoney(expenseStats.shared),
        sub: `${expenseFilterOptions[1].count} expense${expenseFilterOptions[1].count === 1 ? "" : "s"}`,
        icon: "S",
        tone: "blue"
      },
      {
        label: "Personal expenses",
        value: formatMoney(expenseStats.personal),
        sub: `${expenseFilterOptions[2].count} expense${expenseFilterOptions[2].count === 1 ? "" : "s"}`,
        icon: "P",
        tone: "violet"
      },
      {
        label: "This week",
        value: formatMoney(expenseStats.thisWeek),
        sub: `${expenseStats.thisWeekCount} expense${expenseStats.thisWeekCount === 1 ? "" : "s"}`,
        icon: "W",
        tone: "amber"
      }
    ];
    const expensePageStart = expenseRows.length === 0 ? 0 : (expensePage - 1) * 5 + 1;
    const expensePageEnd = Math.min(expenseRows.length, expensePage * 5);
    const firstExpensePageButton = Math.min(
      Math.max(1, expensePage - 1),
      Math.max(1, expenseTotalPages - 2)
    );
    const expensePageButtons = Array.from(
      { length: Math.min(expenseTotalPages, 3) },
      (_, index) => firstExpensePageButton + index
    );
    const participantIdsForExpense = expense => {
      const ids = Array.isArray(expense.splitMemberIds) && expense.splitMemberIds.length > 0
        ? expense.splitMemberIds
        : expense.paidByMemberId
          ? [expense.paidByMemberId]
          : [];
      return Array.from(new Set(ids));
    };
    const splitLabelOf = expense => {
      if (expense.expenseType !== "shared") return "-";
      return expense.splitType === "custom" ? "Custom split" : expense.splitType === "percent" ? "% split" : "Equal split";
    };

    const navItems = [
      { key: "dashboard", label: "Trip Overview", icon: "⊞" },
      { key: "prediction", label: "Plan Budget", icon: "📊" },
      { key: "actual", label: "Expenses", icon: "💳" },
      { key: "settlements", label: "Settle", icon: "🤝" },
      { key: "categories", label: "Categories", icon: "🏷" },
      { key: "members", label: "Members", icon: "👥" },
      { key: "settings", label: "Settings", icon: "⚙" },
    ];

    return (
      <div className="app-layout">
        {/* Backdrop — closes sidebar on mobile when tapping outside */}
        {isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} />
        )}

        <aside className={`sidebar${isSidebarOpen ? " sidebar-open" : ""}`}>
          <div className="sidebar-logo">
            <button className="sidebar-logo-button" type="button" onClick={openLandingPage}>
              <img className="app-logo-img" src="/triphisaab-logo.svg" alt="TripHisaab" />
              <div className="brand-tagline">Every trip. Every spend. Sorted.</div>
            </button>
            {/* Close button — visible only on mobile */}
            <button
              className="sidebar-close-btn"
              type="button"
              aria-label="Close menu"
              onClick={() => setIsSidebarOpen(false)}
            >
              ✕
            </button>
          </div>
          <button className="sidebar-back-btn" type="button" onClick={closeTrip}>
            ← Back to trips
          </button>
          {canManageSelectedTrip() && !demoMode ? (
            <button
              className="sidebar-invite-btn"
              type="button"
              disabled={creatingInvite}
              onClick={() => {
                setIsSidebarOpen(false);
                openInviteShareModal();
              }}
            >
              <span className="sidebar-nav-icon">🔗</span>
              {creatingInvite ? "Creating invite..." : "Share invite"}
            </button>
          ) : null}
          <nav className="sidebar-nav" data-tour="sidebar-tour">
            {navItems.map(({ key, label, icon }) => (
              <button
                key={key}
                className={`sidebar-nav-item${activeTab === key ? " active" : ""}`}
                type="button"
                onClick={() => { setActiveTab(key); setIsSidebarOpen(false); }}
              >
                <span className="sidebar-nav-icon">{icon}</span>
                {label}
              </button>
            ))}
          </nav>
          <DonateButton />
          <div className="sidebar-footer">
            <div
              className={`sidebar-avatar${userProfile.profileImageDataUrl ? " has-image" : ""}`}
              style={
                userProfile.profileImageDataUrl
                  ? { backgroundImage: `url(${userProfile.profileImageDataUrl})` }
                  : undefined
              }
            >
              {!userProfile.profileImageDataUrl ? userInitial : null}
            </div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">
                {demoMode ? "Norway Demo" : user?.displayName || user?.email?.split("@")[0]}
              </div>
              <div className="sidebar-user-role">
                {demoMode ? "Demo mode" : selectedTrip.accessRole === "owner" ? "Trip admin" : "Member"}
              </div>
            </div>
            {!demoMode ? renderNotificationBell() : null}
            {demoMode ? (
              <button className="link-button sidebar-logout" type="button" onClick={closeTrip}>
                Exit
              </button>
            ) : null}
            {!demoMode ? (
            <button className="link-button sidebar-logout" type="button" onClick={handleLogout}>
              Out
            </button>
            ) : null}
          </div>
        </aside>

        <main className="main-content">
          {/* Mobile top bar with hamburger */}
          <div className="mobile-topbar">
            <button
              className="hamburger-btn"
              type="button"
              aria-label="Open menu"
              onClick={() => setIsSidebarOpen(true)}
            >
              <span /><span /><span />
            </button>
            <span className="mobile-topbar-title">
              <img className="mobile-logo-img" src="/triphisaab-logo.svg" alt="TripHisaab" />
            </span>
            {!demoMode ? renderNotificationBell() : null}
            {!demoMode ? (
            <button
              className="primary-button small-button"
              type="button"
              onClick={() => openFastExpenseModal()}
            >
              + Add
            </button>
            ) : null}
          </div>
          {tripDataLoading ? (
            <p className="muted" style={{ padding: "24px" }}>Loading trip data...</p>
          ) : null}

        {activeTab === "dashboard" ? (
          <>
            {/* Hero banner */}
            <div
              className={`trip-hero${selectedTrip.imageDataUrl ? " has-trip-image" : ""}`}
              style={
                selectedTrip.imageDataUrl
                  ? { backgroundImage: `url(${selectedTrip.imageDataUrl})` }
                  : undefined
              }
            >
              {canManageSelectedTrip() && !demoMode ? (
              <div className="trip-hero-topright">
                <button
                    className="trip-hero-invite"
                    type="button"
                    disabled={creatingInvite}
                    onClick={openInviteShareModal}
                  >
                    🔗 {creatingInvite ? "Creating link..." : "Share invite"}
                </button>
              </div>
              ) : null}
              <h1 className="trip-hero-title">{selectedTrip.name}</h1>
              <div className="trip-hero-dates">
                📅 {selectedTrip.startDate} – {selectedTrip.endDate}
              </div>
            </div>

            <div className="dashboard-content">

              {/* ── Stat summary row ── */}
              <div className="dash-stats-row">
                <div className="dash-stat-card">
                  <div className="dash-stat-icon" style={{ background: "var(--primary-muted)", color: "var(--primary)" }}>💼</div>
                  <div>
                    <div className="dash-stat-label">Planned Budget</div>
                    <div className="dash-stat-value">{formatMoney(totals.predicted)}</div>
                  </div>
                </div>
                <div className="dash-stat-card">
                  <div className="dash-stat-icon" style={{ background: "var(--info-soft)", color: "var(--info)" }}>💳</div>
                  <div>
                    <div className="dash-stat-label">Total Spent</div>
                    <div className="dash-stat-value">{formatMoney(totals.actual)}</div>
                  </div>
                </div>
                <div className="dash-stat-card">
                  <div className="dash-stat-icon" style={{ background: remaining >= 0 ? "var(--success-soft)" : "var(--danger-soft)", color: remaining >= 0 ? "var(--success)" : "var(--danger)" }}>🎯</div>
                  <div>
                    <div className="dash-stat-label">Remaining Budget</div>
                    <div className={`dash-stat-value ${remaining >= 0 ? "positive" : "negative"}`}>
                      {remaining >= 0 ? formatMoney(remaining) : "–" + formatMoney(Math.abs(remaining))}
                    </div>
                  </div>
                </div>
                <div className="dash-stat-card">
                  <div className="dash-stat-icon" style={{ background: "#f3e8ff", color: "#7c3aed" }}>📅</div>
                  <div>
                    <div className="dash-stat-label">Trip Duration</div>
                    <div className="dash-stat-value">{totalDays} days</div>
                  </div>
                </div>
              </div>

              {/* ── Row 1: Budget overview + Quick actions ── */}
              <div className="dash-row dash-row-budget">
                <div className="dash-card budget-card">
                  <div className="budget-donut-wrap">
                    <svg width="130" height="130" viewBox="0 0 130 130">
                      <circle cx="65" cy="65" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
                      <circle
                        cx="65" cy="65" r={r} fill="none"
                        stroke={budgetPct >= 100 ? "var(--danger)" : budgetPct >= 80 ? "var(--warning)" : "var(--primary)"}
                        strokeWidth="12"
                        strokeDasharray={`${dashFill} ${circ}`}
                        strokeLinecap="round"
                        transform="rotate(-90, 65, 65)"
                      />
                    </svg>
                    <div className="budget-donut-label">
                      <span className="budget-donut-pct">{budgetPct}%</span>
                      <span className="budget-donut-sub">of budget<br/>used</span>
                    </div>
                  </div>
                  <div className="budget-stats">
                    <div className="budget-progress-track">
                      <div
                        className="budget-progress-fill"
                        style={{
                          width: `${Math.min(100, budgetPct)}%`,
                          background: budgetPct >= 100 ? "var(--danger)" : budgetPct >= 80 ? "var(--warning)" : "var(--primary)"
                        }}
                      />
                    </div>
                    <div className="budget-legend">
                      <div className="budget-legend-item">
                        <span className="budget-legend-dot" style={{ background: budgetPct >= 100 ? "var(--danger)" : "var(--primary)" }} />
                        <span>Budget used</span>
                        <strong>{budgetPct}%</strong>
                      </div>
                      <div className="budget-legend-item">
                        <span className="budget-legend-dot" style={{ background: "var(--info)" }} />
                        <span>Spent</span>
                        <strong>{formatMoney(totals.actual)}</strong>
                      </div>
                      <div className="budget-legend-item">
                        <span className="budget-legend-dot" style={{ background: "#34d399" }} />
                        <span>Remaining</span>
                        <strong className={remaining >= 0 ? "positive" : "negative"}>
                          {remaining >= 0 ? formatMoney(remaining) : "–" + formatMoney(Math.abs(remaining))}
                        </strong>
                      </div>
                    </div>
                    <div className="budget-message">{budgetMsg}</div>
                  </div>
                </div>

                <div className="dash-card">
                  <h3>Quick actions</h3>
                  <p className="dash-card-sub">Jump to what you need</p>
                  <div className="dash-quick-actions">
                    {!demoMode ? (
                    <button className="dash-action-btn" type="button" onClick={() => openFastExpenseModal()}>
                      <div className="dash-action-icon" style={{ background: "#fff7ed", color: "#ea580c" }}>➕</div>
                      <span>Add Expense</span>
                    </button>
                    ) : null}
                    <button className="dash-action-btn" type="button" onClick={() => setActiveTab("prediction")}>
                      <div className="dash-action-icon" style={{ background: "var(--info-soft)", color: "var(--info)" }}>📊</div>
                      <span>Add Budget</span>
                    </button>
                    <button className="dash-action-btn" type="button" onClick={() => setActiveTab("settlements")}>
                      <div className="dash-action-icon" style={{ background: "var(--warning-soft)", color: "var(--warning)" }}>🤝</div>
                      <span>View Settlements</span>
                    </button>
                    <button className="dash-action-btn" type="button" onClick={() => setActiveTab("categories")}>
                      <div className="dash-action-icon" style={{ background: "#f3e8ff", color: "#7c3aed" }}>🏷️</div>
                      <span>Add Category</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* ── Row 2: Settlement snapshot + Recent expenses ── */}
              <div className="dash-row dash-row-2col">
                <div className="dash-card">
                  <h3>Settlement snapshot</h3>
                  <p className="dash-card-sub">Who owes whom?</p>
                  {balances.length === 0 ? (
                    <p className="muted small">No members yet.</p>
                  ) : (
                    <>
                      {balances.slice(0, 4).map(b => (
                        <div className="dash-balance-item" key={b.memberId}>
                          <div
                            className={`dash-balance-avatar${memberImageOf(b) ? " has-image" : ""}`}
                            style={memberImageOf(b) ? { backgroundImage: `url(${memberImageOf(b)})` } : undefined}
                          >
                            {!memberImageOf(b) ? memberInitialOf(b) : null}
                          </div>
                          <div className="dash-balance-info">
                            <div className="dash-balance-name">{b.name}</div>
                            <div className="dash-balance-label">
                              {b.net >= 0.01 ? "Should receive" : b.net <= -0.01 ? "Owes" : "Settled up"}
                            </div>
                          </div>
                          <div className={`dash-balance-amount ${b.net >= 0.01 ? "positive" : b.net <= -0.01 ? "negative" : ""}`}>
                            {b.net >= 0 ? "+" : "–"}{formatMoney(Math.abs(b.net))}
                          </div>
                        </div>
                      ))}
                      {suggestedSettlements.length > 0 && (
                        <div className="settle-snapshot-strip">
                          <div className="settle-snapshot-strip-icon">✨</div>
                          <div className="settle-snapshot-strip-body">
                            <div className="settle-snapshot-strip-title">Suggested settlement</div>
                            <div className="settle-snapshot-strip-sub">
                              {suggestedSettlements[0].fromName} pays {suggestedSettlements[0].toName} {formatMoney(suggestedSettlements[0].amount)}
                            </div>
                          </div>
                          <button
                            className="primary-button small-button"
                            type="button"
                            onClick={() => setActiveTab("settlements")}
                          >
                            Open Smart Settle
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="dash-card">
                  <div className="dash-card-header">
                    <div>
                      <h3>Recent expenses</h3>
                      <p className="dash-card-sub">Latest transactions</p>
                    </div>
                    <button className="link-button" style={{ fontSize: "13px", whiteSpace: "nowrap" }} type="button" onClick={() => setActiveTab("actual")}>
                      View all →
                    </button>
                  </div>
                  {expenses.length === 0 ? (
                    <p className="muted small">No expenses yet.</p>
                  ) : (
                    expenses.slice(0, 5).map(e => (
                      <div className="dash-activity-item" key={e.id}>
                        <div className="dash-activity-icon">{e.categoryIcon || "💸"}</div>
                        <div className="dash-activity-info">
                          <div className="dash-activity-name">{e.description || e.categoryName}</div>
                          <div className="dash-activity-meta">
                            Paid by {memberNameOf(e.paidByMemberId)} · {e.date}
                          </div>
                        </div>
                        <div className="dash-activity-amount">{formatMoney(e.amountEur)}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* ── Row 3: Trip progress + Group snapshot + At a glance ── */}
              <div className="dash-row dash-row-3col">

                <div className="dash-card">
                  <h3>Trip progress</h3>
                  <p className="dash-card-sub">{daysLeft > 0 ? "We're on track! Enjoy the journey 🎉" : "Trip has ended 🏁"}</p>
                  <div className="progress-track progress-track-lg">
                    <div
                      className="progress-track-fill"
                      style={{ width: `${Math.min(100, Math.round((daysIn / totalDays) * 100))}%` }}
                    />
                  </div>
                  <div className="progress-dates-row">
                    <div className="progress-date-block">
                      <div className="progress-day-num">{daysIn}</div>
                      <div className="progress-day-label">Days completed</div>
                    </div>
                    <div className="progress-date-block">
                      <div className="progress-day-num highlight">{daysLeft}</div>
                      <div className="progress-day-label">Days remaining</div>
                    </div>
                    <div className="progress-date-block">
                      <div className="progress-day-num" style={{ fontSize: "14px", letterSpacing: 0 }}>{selectedTrip.endDate}</div>
                      <div className="progress-day-label">Trip ends</div>
                    </div>
                  </div>
                </div>

                <div className="dash-card">
                  <h3>Group snapshot</h3>
                  <p className="dash-card-sub">{activeMembers.length} member{activeMembers.length !== 1 ? "s" : ""}</p>
                  <div className="dash-group-avatars">
                    {activeMembers.slice(0, 5).map(m => (
                      <div key={m.id} className="dash-group-member">
                        <div
                          className={`dash-group-avatar${memberImageOf(m) ? " has-image" : ""}`}
                          style={memberImageOf(m) ? { backgroundImage: `url(${memberImageOf(m)})` } : undefined}
                        >
                          {!memberImageOf(m) ? memberInitialOf(m) : null}
                        </div>
                        <div className="dash-group-name">
                          {(m.displayName || m.name || m.email || "").split(" ")[0]}
                        </div>
                      </div>
                    ))}
                    {activeMembers.length > 5 && (
                      <div className="dash-group-member">
                        <div className="dash-group-avatar dash-group-more">+{activeMembers.length - 5}</div>
                        <div className="dash-group-name">more</div>
                      </div>
                    )}
                  </div>
                  <button className="secondary-button small-button" style={{ marginTop: "14px", width: "100%" }} type="button" onClick={() => setActiveTab("members")}>
                    View all members
                  </button>
                </div>

                <div className="dash-card">
                  <h3>At a glance</h3>
                  <div className="dash-glance-list">
                    <div className="dash-glance-item">
                      <div className={`dash-glance-icon ${remaining >= 0 ? "success" : "danger"}`}>
                        {remaining >= 0 ? "✓" : "!"}
                      </div>
                      <div>
                        <div className="dash-glance-title">{remaining >= 0 ? "On budget" : "Over budget"}</div>
                        <div className="dash-glance-sub">
                          {remaining >= 0 ? `You're ${formatMoney(remaining)} under budget` : `${formatMoney(Math.abs(remaining))} over budget`}
                        </div>
                      </div>
                    </div>
                    {totals.actual > 0 && daysIn > 0 && (
                      <div className="dash-glance-item">
                        <div className="dash-glance-icon info">📊</div>
                        <div>
                          <div className="dash-glance-title">Keep it balanced</div>
                          <div className="dash-glance-sub">Average spend per day: {formatMoney(totals.actual / daysIn)}</div>
                        </div>
                      </div>
                    )}
                    {suggestedSettlements.length > 0 && (
                      <div className="dash-glance-item">
                        <div className="dash-glance-icon primary">🤝</div>
                        <div>
                          <div className="dash-glance-title">Smart settle available</div>
                          <div className="dash-glance-sub">{suggestedSettlements.length} suggested settlement{suggestedSettlements.length !== 1 ? "s" : ""}</div>
                        </div>
                      </div>
                    )}
                    {totals.actual === 0 && (
                      <div className="dash-glance-item">
                        <div className="dash-glance-icon info">🌍</div>
                        <div>
                          <div className="dash-glance-title">Ready to track</div>
                          <div className="dash-glance-sub">Add your first expense to get started</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Row 4: Spending by category ── */}
              {spendingBreakdown.length > 0 && (
                <div className="dash-card breakdown-card">
                  <h3>Spending by category</h3>
                  <p className="dash-card-sub">Where your money goes</p>
                  <div className="breakdown-ring-layout">
                    <div
                      className="breakdown-ring"
                      style={{ background: `conic-gradient(${breakdownGradient})` }}
                      aria-label="Spending category chart"
                    >
                      <div className="breakdown-ring-center">
                        <span>Total</span>
                        <strong>{formatMoney(totals.actual)}</strong>
                      </div>
                    </div>
                    <div className="breakdown-items">
                      {spendingBreakdown.map(c => {
                        const pct = Math.max(1, Math.round((c.actual / totals.actual) * 100));
                        return (
                          <div className="breakdown-item" key={c.id}>
                            <div className="breakdown-cat-icon" style={{ color: c.color }}>{c.icon}</div>
                            <div className="breakdown-cat-name">{c.name}</div>
                            <div className="breakdown-amount">{formatMoney(c.actual)}</div>
                            <div className="breakdown-pct">{pct}%</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

            </div>
          </>
        ) : null}

        {activeTab !== "dashboard" ? (
          <div className="tab-page-content">
        {activeTab === "prediction" ? (
          <section className="plan-budget-page">
            <section className="card plan-budget-editor">
              <div className="section-header compact-header">
                <div>
                  <h2>Plan Budget</h2>
                  <p className="small muted">
                    Add separate budgets for everyone, selected people, or just you.
                  </p>
                </div>
                {!demoMode ? (
                <button
                  className="secondary-button small-button"
                  type="button"
                  onClick={openCreateCategory}
                >
                  + New category
                </button>
                ) : null}
              </div>

              <form className="budget-form" onSubmit={handleSavePredictions}>
                <label>
                  Category
                  <select
                    value={budgetForm.categoryId}
                    onChange={e => setBudgetForm({ ...budgetForm, categoryId: e.target.value })}
                    required
                  >
                    <option value="">Choose category</option>
                    {activeCategories.map(c => (
                      <option value={c.id} key={c.id}>{c.icon} {c.name}</option>
                    ))}
                  </select>
                </label>

                <label>
                  Budget name
                  <input
                    type="text"
                    value={budgetForm.title}
                    placeholder="e.g. Group groceries"
                    onChange={e => setBudgetForm({ ...budgetForm, title: e.target.value })}
                  />
                </label>

                <label>
                  Amount in EUR
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={budgetForm.estimatedEur}
                    placeholder="0.00"
                    onChange={e => setBudgetForm({ ...budgetForm, estimatedEur: e.target.value })}
                    required
                  />
                </label>

                <div className="budget-scope-field">
                  <span className="emoji-field-label">Who can see this?</span>
                  <div className="budget-scope-options">
                    {BUDGET_SCOPE_OPTIONS.map(option => (
                      <button
                        className={`scope-option${budgetForm.scope === option.value ? " selected" : ""}`}
                        type="button"
                        key={option.value}
                        onClick={() =>
                          setBudgetForm(current => ({
                            ...current,
                            scope: option.value,
                            visibleMemberIds:
                              option.value === "me" && currentUserMemberId
                                ? [currentUserMemberId]
                                : current.visibleMemberIds
                          }))
                        }
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                {budgetForm.scope === "selected" ? (
                  <div className="budget-member-picker">
                    <span className="emoji-field-label">Choose people</span>
                    <div className="member-chip-list">
                      {activeMembers.map(member => (
                        <button
                          className={`member-chip${(budgetForm.visibleMemberIds || []).includes(member.id) ? " selected" : ""}`}
                          type="button"
                          key={member.id}
                          onClick={() => toggleBudgetMember(member.id)}
                        >
                          {memberNameOf(member.id)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {!demoMode ? (
                <div className="budget-form-actions">
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={savingPredictions}
                  >
                    {savingPredictions
                      ? "Saving..."
                      : editingBudgetId
                      ? "Save budget entry"
                      : "Add budget entry"}
                  </button>
                  {editingBudgetId ? (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => resetBudgetForm()}
                    >
                      Cancel editing
                    </button>
                  ) : null}
                </div>
                ) : null}
              </form>
            </section>

            <section className="card">
              <div className="budget-list-header">
                <div>
                  <h3>Budget entries</h3>
                  <p className="small muted">
                    Whole group entries count toward the group total. Selected and Only me entries stay out of it.
                  </p>
                </div>
                <div className="budget-total-stack">
                  <span>Group plan</span>
                  <strong>{formatMoney(totals.predicted)}</strong>
                </div>
              </div>

              {predictions.length === 0 ? (
                <div className="empty-card">
                  <h3>No budget entries yet</h3>
                  <p className="muted">Add your first plan above.</p>
                </div>
              ) : (
                <div className="budget-entry-list">
                  {predictions.map(entry => {
                    const category = categoriesById.get(entry.categoryId);
                    const isGroup = normalizeBudgetScope(entry) === "group";
                    return (
                      <article className="budget-entry-card" key={entry.id}>
                        <div className="budget-entry-main">
                          <span
                            className="category-dot"
                            style={{
                              backgroundColor: `${category?.color || "#0F766E"}22`,
                              color: category?.color || "#0F766E"
                            }}
                          >
                            {category?.icon || entry.categoryIcon || "📌"}
                          </span>
                          <div>
                            <strong>{entry.title || entry.categoryName || category?.name || "Budget entry"}</strong>
                            <p className="small muted">
                              {category?.name || entry.categoryName || "Category"} · {budgetScopeLabel(entry)}
                            </p>
                            <p className="small muted">{budgetVisibleNames(entry)}</p>
                          </div>
                        </div>
                        <div className="budget-entry-side">
                          <strong>{formatMoney(entry.estimatedEur)}</strong>
                          <span className={isGroup ? "pill" : "pill muted-pill"}>
                            {isGroup ? "Group total" : "Personal view"}
                          </span>
                          {!demoMode ? (
                          <div className="expense-actions">
                            <button
                              className="secondary-button small-button"
                              type="button"
                              onClick={() => startEditingBudget(entry)}
                            >
                              Edit
                            </button>
                            <button
                              className="danger-button small-button"
                              type="button"
                              onClick={() => handleDeleteBudget(entry)}
                            >
                              Delete
                            </button>
                          </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === "actual" ? (
          <section className="expenses-page">
            <div className="expenses-header">
              <div className="expenses-title">
                <h2>Expenses</h2>
                <p className="muted">Track, filter, and manage trip spending.</p>
              </div>
              <div className="expenses-toolbar">
                <label className="expense-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    type="search"
                    value={expenseSearch}
                    onChange={event => setExpenseSearch(event.target.value)}
                    placeholder="Search expenses..."
                    aria-label="Search expenses"
                  />
                </label>
                <button className="secondary-button expense-filter-button" type="button">
                  Filter
                </button>
                {!demoMode ? (
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => openFastExpenseModal()}
                  >
                    + Add expense
                  </button>
                ) : null}
              </div>
            </div>

            <div className="expense-control-row">
              <div className="expense-filter-tabs" role="tablist" aria-label="Expense filters">
                {expenseFilterOptions.map(option => (
                  <button
                    key={option.key}
                    className={`expense-filter-chip${expenseFilter === option.key ? " active" : ""}`}
                    type="button"
                    onClick={() => setExpenseFilter(option.key)}
                  >
                    {option.label}
                    <span>{option.count}</span>
                  </button>
                ))}
              </div>
              <label className="expense-sort-control">
                <span>Sort by:</span>
                <select value={expenseSort} onChange={event => setExpenseSort(event.target.value)}>
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="highest">Highest amount</option>
                  <option value="lowest">Lowest amount</option>
                  <option value="category">Category</option>
                </select>
              </label>
            </div>

            <div className="expense-summary-grid">
              {expenseSummaryCards.map(card => (
                <article className="expense-summary-card" key={card.label}>
                  <div className={`expense-summary-icon ${card.tone}`}>{card.icon}</div>
                  <div>
                    <p>{card.label}</p>
                    <strong>{card.value}</strong>
                    <span>{card.sub}</span>
                  </div>
                </article>
              ))}
            </div>

            {expenses.length === 0 ? (
              <div className="empty-card">
                <div className="empty-icon">€</div>
                <h3>No expenses yet</h3>
                <p className="muted">Add your first expense to start tracking trip spending.</p>
              </div>
            ) : (
              <section className="expense-table-card" aria-label="Expenses list">
                <div className="expense-table-head">
                  <span>Expense</span>
                  <span>Date & time</span>
                  <span>Type</span>
                  <span>Split</span>
                  <span>Paid by</span>
                  <span>Participants</span>
                  <span>Amount</span>
                  <span />
                </div>

                {pagedExpenseRows.length === 0 ? (
                  <div className="expense-empty-row">
                    No expenses match your current filters.
                  </div>
                ) : (
                  pagedExpenseRows.map(expense => {
                    const category = categoriesById.get(expense.categoryId);
                    const participants = participantIdsForExpense(expense);
                    const visibleParticipants = participants.slice(0, 3);
                    const participantOverflow = Math.max(0, participants.length - visibleParticipants.length);
                    const paidByImage = memberImageOf(expense.paidByMemberId);
                    return (
                      <article className="expense-table-row" key={expense.id}>
                        <div className="expense-name-cell" data-label="Expense">
                          <div
                            className="expense-category-mark"
                            style={{ "--category-color": category?.color || "#0f766e" }}
                          >
                            {expense.categoryIcon || category?.icon || "€"}
                          </div>
                          <div>
                            <strong>{expense.description || expense.categoryName || "Expense"}</strong>
                            <span>{expense.categoryName || category?.name || "Uncategorized"}</span>
                            <small>
                              {expense.expenseType === "shared" ? "Shared" : "Personal"} · Paid by {memberNameOf(expense.paidByMemberId)}
                            </small>
                          </div>
                        </div>

                        <div className="expense-date-cell" data-label="Date & time">
                          <strong>{expense.date || "No date"}</strong>
                          <span>{expense.time || "--:--"}</span>
                        </div>

                        <div data-label="Type">
                          <span className={`expense-type-badge ${expense.expenseType === "shared" ? "shared" : "personal"}`}>
                            {expense.expenseType === "shared" ? "Shared" : "Personal"}
                          </span>
                        </div>

                        <div className="expense-muted-cell" data-label="Split">
                          {splitLabelOf(expense)}
                        </div>

                        <div className="expense-paid-cell" data-label="Paid by">
                          <span
                            className={`expense-avatar-mini${paidByImage ? " has-image" : ""}`}
                            style={paidByImage ? { backgroundImage: `url(${paidByImage})` } : undefined}
                          >
                            {!paidByImage ? memberInitialOf(expense.paidByMemberId) : null}
                          </span>
                          <span>{memberNameOf(expense.paidByMemberId)}</span>
                        </div>

                        <div className="expense-participants-cell" data-label="Participants">
                          {participants.length > 0 ? (
                            <>
                              <div className="expense-avatar-stack">
                                {visibleParticipants.map(memberId => {
                                  const image = memberImageOf(memberId);
                                  return (
                                    <span
                                      className={`expense-avatar-mini${image ? " has-image" : ""}`}
                                      style={image ? { backgroundImage: `url(${image})` } : undefined}
                                      key={memberId}
                                      title={memberNameOf(memberId)}
                                    >
                                      {!image ? memberInitialOf(memberId) : null}
                                    </span>
                                  );
                                })}
                                {participantOverflow > 0 ? (
                                  <span className="expense-avatar-more">+{participantOverflow}</span>
                                ) : null}
                              </div>
                              <small>{participants.length} {participants.length === 1 ? "person" : "people"}</small>
                            </>
                          ) : (
                            <span className="muted">-</span>
                          )}
                          {expense.ratesSource ? (
                            <small>
                              Rate: {expense.ratesSource}
                              {expense.ratesUpdatedAt ? ` · ${expense.ratesUpdatedAt}` : ""}
                            </small>
                          ) : null}
                        </div>

                        <div className="expense-amount-cell" data-label="Amount">
                          <strong>{formatMoney(expense.amountEur)}</strong>
                          {expense.originalCurrency && expense.originalCurrency !== "EUR" ? (
                            <span>{formatCurrency(expense.originalAmount, expense.originalCurrency)}</span>
                          ) : null}
                        </div>

                        <div className="expense-row-actions">
                          {!demoMode ? (
                            <>
                              <button
                                className="secondary-button small-button"
                                type="button"
                                onClick={() => startEditingExpense(expense)}
                              >
                                Edit
                              </button>
                              <button
                                className="danger-button small-button"
                                type="button"
                                onClick={() => handleDeleteExpense(expense)}
                              >
                                Delete
                              </button>
                            </>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                )}

                <footer className="expense-table-footer">
                  <span>
                    Showing {expensePageStart}-{expensePageEnd} of {expenseRows.length} expenses
                  </span>
                  <div className="expense-pagination" aria-label="Expense pagination">
                    <button
                      type="button"
                      disabled={expensePage <= 1}
                      onClick={() => setExpensePage(page => Math.max(1, page - 1))}
                      aria-label="Previous page"
                    >
                      ‹
                    </button>
                    {expensePageButtons.map(page => (
                      <button
                        key={page}
                        type="button"
                        className={expensePage === page ? "active" : ""}
                        onClick={() => setExpensePage(page)}
                      >
                        {page}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={expensePage >= expenseTotalPages}
                      onClick={() => setExpensePage(page => Math.min(expenseTotalPages, page + 1))}
                      aria-label="Next page"
                    >
                      ›
                    </button>
                  </div>
                </footer>
              </section>
            )}
          </section>
        ) : null}

        {activeTab === "actual" ? (
          <section className="legacy-expenses-section" aria-hidden="true">
            <div className="section-header">
              <h2>Expenses</h2>
              <div className="section-actions">
                {!demoMode ? (
                <button
                  className="secondary-button small-button"
                  type="button"
                  onClick={openCreateCategory}
                >
                  + New category
                </button>
                ) : null}
                {!demoMode ? (
                <button
                  className="primary-button small-button"
                  type="button"
                  onClick={() => openFastExpenseModal()}
                >
                  + Add expense
                </button>
                ) : null}
              </div>
            </div>
            <section>
              {expenses.length === 0 ? (
                <div className="empty-card">
                  <div className="empty-icon">💸</div>
                  <h3>No expenses yet</h3>
                  <p className="muted">Add your first expense above.</p>
                </div>
              ) : (
                <div className="expense-list">
                  {expenses.map(e => (
                    <article className="expense-card" key={e.id}>
                      <div>
                        <strong>{e.description || e.categoryName}</strong>
                        <p className="small muted">
                          {e.date} · {e.time} · {e.categoryName}
                        </p>
                        <p className="small muted">
                          {e.expenseType === "shared"
                            ? `Shared · ${
                                e.splitType === "custom"
                                  ? "Custom split"
                                  : e.splitType === "percent"
                                  ? "% split"
                                  : "Equal split"
                              } · Paid by ${memberNameOf(e.paidByMemberId)}`
                            : `Personal · Paid by ${memberNameOf(e.paidByMemberId)}`}
                        </p>
                        {e.expenseType === "shared" &&
                        (e.splitType === "custom" || e.splitType === "percent") ? (
                          <p className="small muted">
                            {e.splitType === "percent" ? "% split" : "Custom split"} ·{" "}
                            {Object.entries(e.customSplitSharesEur || {})
                              .map(
                                ([id, amount]) =>
                                  `${memberNameOf(id)}: ${formatMoney(amount)}`
                              )
                              .join(" · ")}
                          </p>
                        ) : null}
                        {e.notes ? (
                          <p className="small muted">Note: {e.notes}</p>
                        ) : null}
                        {e.ratesSource ? (
                          <p className="small muted">
                            Rate: {e.ratesSource}
                            {e.ratesUpdatedAt ? ` · ${e.ratesUpdatedAt}` : ""}
                          </p>
                        ) : null}
                      </div>

                      <div className="expense-card-side">
                        <strong>{formatMoney(e.amountEur)}</strong>
                        {e.originalCurrency && e.originalCurrency !== "EUR" ? (
                          <span className="small muted">
                            Original:{" "}
                            {formatCurrency(e.originalAmount, e.originalCurrency)}
                          </span>
                        ) : null}
                        {!demoMode ? (
                        <div className="expense-actions">
                          <button
                            className="secondary-button small-button"
                            type="button"
                            onClick={() => startEditingExpense(e)}
                          >
                            Edit
                          </button>
                          <button
                            className="danger-button small-button"
                            type="button"
                            onClick={() => handleDeleteExpense(e)}
                          >
                            Delete
                          </button>
                        </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === "settlements" ? renderSettlementsTab() : null}

        {activeTab === "categories" ? (() => {
          const budgetCategoryIds = new Set(predictions.map(entry => entry.categoryId).filter(Boolean));
          const expenseCategoryCounts = expenses.reduce((map, expense) => {
            if (!expense.categoryId) return map;
            map.set(expense.categoryId, (map.get(expense.categoryId) || 0) + 1);
            return map;
          }, new Map());
          const categoriesInExpenses = categories.filter(category => expenseCategoryCounts.has(category.id)).length;
          const categoriesInBudget = categories.filter(category => budgetCategoryIds.has(category.id)).length;
          const categoryStats = [
            { label: "Active categories", value: categories.filter(category => category.isActive).length, icon: "A", tone: "mint" },
            { label: "Inactive categories", value: categories.filter(category => !category.isActive).length, icon: "I", tone: "peach" },
            { label: "Used in budget", value: categoriesInBudget, icon: "B", tone: "blue" },
            { label: "Used in expenses", value: categoriesInExpenses, icon: "E", tone: "violet" }
          ];
          const filteredCategories = categories.filter(category => {
            const search = categorySearch.trim().toLowerCase();
            const matchesSearch = !search
              || [category.name, category.type].some(value =>
                String(value || "").toLowerCase().includes(search)
              );
            const matchesStatus =
              categoryStatusFilter === "all"
              || (categoryStatusFilter === "active" && category.isActive)
              || (categoryStatusFilter === "inactive" && !category.isActive);
            return matchesSearch && matchesStatus;
          });
          const categoryTotalPages = Math.max(1, Math.ceil(filteredCategories.length / 5));
          const safeCategoryPage = Math.min(categoryPage, categoryTotalPages);
          const categoryPageStart = filteredCategories.length === 0 ? 0 : (safeCategoryPage - 1) * 5 + 1;
          const categoryPageEnd = Math.min(filteredCategories.length, safeCategoryPage * 5);
          const visibleCategories = filteredCategories.slice(categoryPageStart - 1, categoryPageEnd);
          const categoryColorOptions = ["#0F766E", "#3B82F6", "#8B5CF6", "#F43F5E", "#F97316", "#EAB308", "#65A30D", "#6B7280"];

          return (
            <section className="categories-page">
              <div className="categories-head">
                <div>
                  <h2>Categories</h2>
                  <p className="muted">Create and manage categories used in budgets and expenses.</p>
                </div>
                <div className="categories-toolbar">
                  <label className="category-search">
                    <span aria-hidden="true">?</span>
                    <input
                      type="search"
                      value={categorySearch}
                      placeholder="Search categories"
                      onChange={e => {
                        setCategorySearch(e.target.value);
                        setCategoryPage(1);
                      }}
                    />
                  </label>
                  <label className="category-status-select">
                    <span>Status:</span>
                    <select
                      value={categoryStatusFilter}
                      onChange={e => {
                        setCategoryStatusFilter(e.target.value);
                        setCategoryPage(1);
                      }}
                    >
                      <option value="all">All</option>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                  {!demoMode ? (
                    <button
                      className="primary-button category-new-mobile-button"
                      type="button"
                      onClick={() => {
                        cancelCategoryForm();
                        window.requestAnimationFrame(() => {
                          document
                            .getElementById("category-editor-panel")
                            ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        });
                      }}
                    >
                      + New category
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="category-stat-grid">
                {categoryStats.map(stat => (
                  <article className="category-stat-card" key={stat.label}>
                    <div className={`category-stat-icon ${stat.tone}`}>{stat.icon}</div>
                    <div>
                      <strong>{stat.value}</strong>
                      <span>{stat.label}</span>
                      <p>This trip</p>
                    </div>
                  </article>
                ))}
              </div>

              <div className="categories-workspace">
                <section className="categories-list-panel">
                  <div className="categories-panel-head">
                    <h3>All categories</h3>
                    <div className="category-filter-pills">
                      {["all", "active", "inactive"].map(filter => (
                        <button
                          key={filter}
                          className={categoryStatusFilter === filter ? "active" : ""}
                          type="button"
                          onClick={() => {
                            setCategoryStatusFilter(filter);
                            setCategoryPage(1);
                          }}
                        >
                          {filter[0].toUpperCase() + filter.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {visibleCategories.length === 0 ? (
                    <div className="category-empty-state">
                      <h4>{categories.length === 0 ? "No categories yet" : "No categories found"}</h4>
                      <p className="muted">Create a category or adjust your filters.</p>
                    </div>
                  ) : (
                    <div className="category-table-list">
                      {visibleCategories.map(category => {
                        const expenseCount = expenseCategoryCounts.get(category.id) || 0;
                        const usedInBudget = budgetCategoryIds.has(category.id);
                        const usageLabel = usedInBudget && expenseCount > 0
                          ? "Used in Plan Budget & Expenses"
                          : usedInBudget
                          ? "Used in Plan Budget"
                          : expenseCount > 0
                          ? `Used in Expenses (${expenseCount})`
                          : "Not used yet";
                        return (
                          <article className="category-table-row" key={category.id}>
                            <span
                              className="category-dot category-dot-large"
                              style={{
                                backgroundColor: `${category.color || "#0F766E"}22`,
                                color: category.color || "#0F766E"
                              }}
                            >
                              {category.icon || "??"}
                            </span>
                            <div className="category-table-main">
                              <strong>{category.name}</strong>
                              <span>{category.type}</span>
                            </div>
                            <span className={category.isActive ? "pill" : "pill muted-pill"}>
                              {category.isActive ? "Active" : "Inactive"}
                            </span>
                            <span className="category-usage">? {usageLabel}</span>
                            {!demoMode ? (
                              <div className="category-menu-actions">
                                <button className="secondary-button small-button" type="button" onClick={() => startEditingCategory(category)}>Edit</button>
                                <button className="secondary-button small-button" type="button" onClick={() => handleToggleCategory(category)}>
                                  {category.isActive ? "Deactivate" : "Activate"}
                                </button>
                                <button className="danger-button small-button" type="button" onClick={() => handleDeleteCategory(category)}>Delete</button>
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  )}

                  <footer className="category-list-footer">
                    <span>Showing {categoryPageStart}-{categoryPageEnd} of {filteredCategories.length} categories</span>
                    <div className="category-pagination">
                      <button type="button" disabled={safeCategoryPage <= 1} onClick={() => setCategoryPage(page => Math.max(1, page - 1))}>‹</button>
                      {Array.from({ length: categoryTotalPages }, (_, index) => index + 1).slice(0, 5).map(page => (
                        <button
                          key={page}
                          type="button"
                          className={safeCategoryPage === page ? "active" : ""}
                          onClick={() => setCategoryPage(page)}
                        >
                          {page}
                        </button>
                      ))}
                      <button type="button" disabled={safeCategoryPage >= categoryTotalPages} onClick={() => setCategoryPage(page => Math.min(categoryTotalPages, page + 1))}>›</button>
                    </div>
                  </footer>
                </section>

                {!demoMode ? (
                  <section className="category-editor-panel" id="category-editor-panel">
                    <h3>{editingCategoryId ? "Edit category" : "Create category"}</h3>
                    <p className="muted">Active categories appear in Plan Budget and Expenses.</p>
                    <form onSubmit={handleSaveCategory}>
                      <label>
                        Category name
                        <input
                          type="text"
                          value={categoryForm.name}
                          placeholder="e.g. Coffee"
                          onChange={e => setCategoryForm({ ...categoryForm, name: e.target.value })}
                          required
                        />
                      </label>
                      <div className="grid-2 category-editor-grid">
                        <label>
                          Type
                          <select value={categoryForm.type} onChange={e => setCategoryForm({ ...categoryForm, type: e.target.value })}>
                            {CATEGORY_TYPES.map(type => <option value={type} key={type}>{type}</option>)}
                          </select>
                        </label>
                        <label>
                          Icon
                          <select value={categoryForm.icon} onChange={e => setCategoryForm({ ...categoryForm, icon: e.target.value })}>
                            {CATEGORY_EMOJI_OPTIONS.slice(0, 24).map(emoji => <option value={emoji} key={emoji}>{emoji}</option>)}
                          </select>
                        </label>
                      </div>
                      <div>
                        <div className="create-trip-img-label">Color</div>
                        <div className="category-color-swatches">
                          {categoryColorOptions.map(color => (
                            <button
                              key={color}
                              type="button"
                              className={categoryForm.color === color ? "selected" : ""}
                              style={{ backgroundColor: color }}
                              aria-label={`Use ${color}`}
                              onClick={() => setCategoryForm({ ...categoryForm, color })}
                            >
                              {categoryForm.color === color ? "?" : ""}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="create-trip-img-label">Preview</div>
                        <div className="category-editor-preview">
                          <span
                            className="category-dot category-dot-large"
                            style={{ backgroundColor: `${categoryForm.color}22`, color: categoryForm.color }}
                          >
                            {categoryForm.icon || "??"}
                          </span>
                          <div>
                            <strong>{categoryForm.name || "Category name"}</strong>
                            <p className="small muted">{categoryForm.type || "Type"}</p>
                          </div>
                          <span className="pill">Active</span>
                        </div>
                      </div>
                      <div className="category-editor-actions">
                        <button className="secondary-button" type="button" onClick={cancelCategoryForm}>Cancel</button>
                        <button className="primary-button" type="submit" disabled={savingCategory}>
                          {savingCategory ? "Saving..." : editingCategoryId ? "Save category" : "Create category"}
                        </button>
                      </div>
                    </form>
                  </section>
                ) : null}
              </div>
            </section>
          );
        })() : null}
        {activeTab === "members" ? (
          <section>
            {selectedTrip && canManageSelectedTrip() ? (
              <section className="card">
                <h2>Invite link</h2>
                <p className="small muted">
                  Create a shareable link. Your friend opens it, logs in with
                  Google, and joins this trip automatically.
                </p>
                <button
                  className="primary-button"
                  type="button"
                  disabled={creatingInvite}
                  onClick={handleCreateInviteLink}
                >
                  {creatingInvite ? "Creating invite..." : "Create invite link"}
                </button>
                {inviteLink ? (
                  <div style={{ marginTop: "14px", display: "grid", gap: "10px" }}>
                    <input value={inviteLink} readOnly />
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={copyInviteLink}
                    >
                      Copy invite link
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            {canManageSelectedTrip() ? (
            <section className="card">
              <h2>Add trip member</h2>
              <p className="small muted">
                Search previous members or enter a new Google email.
              </p>
              <form onSubmit={handleAddMember}>
                <label>
                  Search previous members
                  <div className="member-search-combobox">
                    <input
                      type="search"
                      value={memberSearch}
                      placeholder="Search by name or email"
                      autoComplete="off"
                      onChange={e => setMemberSearch(e.target.value)}
                    />
                    {memberSuggestions.length > 0 ? (
                      <div className="member-suggestion-list">
                        {memberSuggestions.map(member => (
                          <button
                            className="member-suggestion-item"
                            type="button"
                            key={member.email}
                            onClick={() => selectMemberSuggestion(member)}
                          >
                            <span className="member-suggestion-name">
                              {member.displayName || member.email}
                            </span>
                            <span className="member-suggestion-email">{member.email}</span>
                          </button>
                        ))}
                      </div>
                    ) : memberSearch.trim() ? (
                      <div className="member-suggestion-empty">
                        No saved member matches this search.
                      </div>
                    ) : null}
                  </div>
                </label>
                <label>
                  Name
                  <input
                    type="text"
                    value={memberForm.displayName}
                    placeholder="e.g. Alex"
                    onChange={e =>
                      setMemberForm({ ...memberForm, displayName: e.target.value })
                    }
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    value={memberForm.email}
                    placeholder="alex@example.com"
                    onChange={e =>
                      setMemberForm({ ...memberForm, email: e.target.value })
                    }
                    required
                  />
                </label>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={savingMember}
                >
                  {savingMember ? "Adding..." : "Add member + give access"}
                </button>
              </form>
            </section>
            ) : null}

            <section className="card">
              <h2>Trip members</h2>
              <p className="small muted">
                Removing a member takes away app access but keeps old expense
                history readable.
              </p>
              {members.length === 0 ? (
                <p className="muted">No members yet.</p>
              ) : (
                <div className="member-list">
                  {members.map(m => (
                    <div className="member-row" key={m.id}>
                      <div
                        className={`member-avatar${memberImageOf(m) ? " has-image" : ""}`}
                        style={
                          memberImageOf(m)
                            ? { backgroundImage: `url(${memberImageOf(m)})` }
                            : undefined
                        }
                      >
                        {!memberImageOf(m) ? memberInitialOf(m) : null}
                      </div>
                      <div style={{ flex: 1 }}>
                        <strong>{memberNameOf(m.id)}</strong>
                        <p className="small muted">{m.email || "No email"}</p>
                        <span
                          className={
                            m.status === "inactive" ? "pill muted-pill" : "pill"
                          }
                        >
                          {m.isOwner
                            ? "Owner"
                            : m.status === "inactive"
                            ? "Inactive"
                            : "Member"}
                        </span>
                      </div>
                      {canManageSelectedTrip() && !m.isOwner ? (
                        <button
                          className={
                            m.status === "inactive"
                              ? "secondary-button small-button"
                              : "danger-button small-button"
                          }
                          type="button"
                          disabled={updatingMemberId === m.id}
                          onClick={() => handleToggleMemberStatus(m)}
                        >
                          {updatingMemberId === m.id
                            ? "Updating..."
                            : m.status === "inactive"
                            ? "Restore"
                            : "Remove"}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section className="card">
            <h2>Trip settings</h2>

            <section className="profile-picture-setting">
              <div
                className={`profile-picture-preview${userProfile.profileImageDataUrl ? " has-image" : ""}`}
                style={
                  userProfile.profileImageDataUrl
                    ? { backgroundImage: `url(${userProfile.profileImageDataUrl})` }
                    : undefined
                }
              >
                {!userProfile.profileImageDataUrl ? userInitial : null}
              </div>
              <div className="profile-picture-copy">
                <h3>Profile picture</h3>
                <p className="small muted">
                  This appears in your sidebar. Without a photo, your first initial is shown.
                </p>
                <div className="trip-image-controls">
                  <label className="trip-image-upload">
                    Upload profile picture
                    <input
                      type="file"
                      accept="image/*"
                      disabled={savingProfilePicture}
                      onChange={handleProfilePictureChange}
                    />
                  </label>
                  {userProfile.profileImageDataUrl ? (
                    <button
                      className="secondary-button small-button"
                      type="button"
                      disabled={savingProfilePicture}
                      onClick={removeProfilePicture}
                    >
                      Remove picture
                    </button>
                  ) : null}
                </div>
                {savingProfilePicture ? (
                  <p className="small muted">Saving profile picture...</p>
                ) : null}
              </div>
            </section>

            <form onSubmit={handleSaveTripSettings}>
              {!canManageSelectedTrip() ? (
                <p className="small muted">
                  Trip details are managed by the owner. You can still update the trip image.
                </p>
              ) : null}
              <label>
                Trip name
                <input
                  type="text"
                  value={settingsTripForm.name}
                  disabled={!canManageSelectedTrip()}
                  onChange={e => setSettingsTripForm({ ...settingsTripForm, name: e.target.value })}
                  required
                />
              </label>
              <div className="grid-2">
                <label>
                  Start date
                  <input
                    type="date"
                    value={settingsTripForm.startDate}
                    disabled={!canManageSelectedTrip()}
                    onClick={openDatePicker}
                    onChange={e => {
                      const newStart = e.target.value;
                      setSettingsTripForm(f => ({
                        ...f,
                        startDate: newStart,
                        endDate: f.endDate < newStart ? newStart : f.endDate,
                      }));
                    }}
                    required
                  />
                </label>
                <label>
                  End date
                  <input
                    type="date"
                    value={settingsTripForm.endDate}
                    min={settingsTripForm.startDate}
                    disabled={!canManageSelectedTrip()}
                    onClick={openDatePicker}
                    onChange={e => setSettingsTripForm({ ...settingsTripForm, endDate: e.target.value })}
                    required
                  />
                </label>
              </div>
              <label>
                Default currency
                <select
                  value={settingsTripForm.defaultCurrency}
                  disabled={!canManageSelectedTrip()}
                  onChange={e => setSettingsTripForm({ ...settingsTripForm, defaultCurrency: e.target.value })}
                >
                  {SUPPORTED_CURRENCIES.map(c => (
                    <option value={c} key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <div className="trip-image-setting">
                <div
                  className={`trip-image-preview${settingsTripForm.imageDataUrl ? " has-image" : ""}`}
                  style={
                    settingsTripForm.imageDataUrl
                      ? { backgroundImage: `url(${settingsTripForm.imageDataUrl})` }
                      : undefined
                  }
                >
                  {!settingsTripForm.imageDataUrl ? (
                    <span className="trip-image-placeholder">Trip image</span>
                  ) : null}
                </div>
                <div className="trip-image-controls">
                  <label className="trip-image-upload">
                    Upload image
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleTripImageChange}
                    />
                  </label>
                  {settingsTripForm.imageDataUrl ? (
                    <button
                      className="secondary-button small-button"
                      type="button"
                      onClick={removeTripImage}
                    >
                      Remove image
                    </button>
                  ) : null}
                </div>
              </div>
              <button
                className="primary-button"
                type="submit"
                disabled={savingTripSettings}
              >
                {savingTripSettings
                  ? "Saving..."
                  : canManageSelectedTrip()
                  ? "Save changes"
                  : "Save trip image"}
              </button>
            </form>

            <div className="settings-list" style={{ marginTop: "16px" }}>
              <p><strong>Status:</strong> {selectedTrip.status}</p>
              <p><strong>Members:</strong> {members.length}</p>
              <p><strong>Active members:</strong> {activeMembers.length}</p>
              <p><strong>Settlements:</strong> {settlements.length}</p>
              <p>
                <strong>Your access:</strong>{" "}
                {selectedTrip.accessRole === "owner" ? "Owner" : "Member"}
              </p>
            </div>

            <section style={{ marginTop: "20px" }}>
              <h2>Export</h2>
              <p className="small muted">
                Download a full CSV summary with trip details, totals, categories,
                expenses, balances, suggested settlements, and settlement history.
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={exportTripSummaryCsv}
              >
                Export trip summary CSV
              </button>
            </section>

            <section style={{ marginTop: "20px" }}>
              <h2>App Tour</h2>
              <p className="small muted">New here or need a refresher? Replay the interactive walkthrough.</p>
              <button
                className="secondary-button small-button"
                type="button"
                onClick={() => setIsTutorialOpen(true)}
              >
                ▶ Show tutorial
              </button>
            </section>

            <section style={{ marginTop: "20px" }}>
              <h2>Support the App</h2>
              <p className="small muted">Like TripHisaab? Buy me a Coffee! ☕</p>
              <DonateButton inline />
            </section>

            <section style={{ marginTop: "20px" }}>
              <h2>Exchange rates</h2>
              <p className="small muted">{ratesStatusLabel}</p>
              {ratesMeta.error ? (
                <p className="small muted">Last refresh error: {ratesMeta.error}</p>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                disabled={ratesLoading}
                onClick={loadLiveExchangeRates}
              >
                {ratesLoading ? "Refreshing rates..." : "Refresh live rates"}
              </button>
              <div className="settings-list" style={{ marginTop: "14px" }}>
                {SUPPORTED_CURRENCIES.map(c => (
                  <p key={c}>
                    <strong>1 EUR</strong> = {getCurrencyRate(c).toFixed(4)} {c}
                  </p>
                ))}
              </div>
            </section>

            <button
              className="secondary-button"
              type="button"
              onClick={async () => {
                await loadTripData(selectedTrip.id);
                alert("Trip data refreshed.");
              }}
            >
              Refresh trip data
            </button>

            {!demoMode ? (
            <section className="danger-zone">
              <h2>{canManageSelectedTrip() ? "Delete trip" : "Leave trip"}</h2>
              {canManageSelectedTrip() ? (
                <>
                  <p className="small muted">
                    Permanently delete this trip for everyone, including members,
                    expenses, settlements, plan budget, categories, and invite links.
                  </p>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={deletingTrip}
                    onClick={() => handleDeleteTrip()}
                  >
                    {deletingTrip ? "Deleting trip..." : "Delete trip"}
                  </button>
                </>
              ) : (
                <>
                  <p className="small muted">
                    You can leave once your balance is settled. Current balance:{" "}
                    <strong>{formatMoney(Math.abs(Number(currentUserBalance?.net || 0)))}</strong>
                    {Number(currentUserBalance?.net || 0) < -0.01
                      ? " owed"
                      : Number(currentUserBalance?.net || 0) > 0.01
                      ? " to receive"
                      : " outstanding"}
                    .
                  </p>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={leavingTrip}
                    onClick={handleLeaveTrip}
                  >
                    {leavingTrip ? "Leaving trip..." : "Leave trip"}
                  </button>
                </>
              )}
            </section>
            ) : null}
          </section>
        ) : null}
          </div>
        ) : null}
        </main>

        {/* Bottom navigation — visible on mobile only */}
        <nav className="bottom-nav" data-tour="bottom-nav-tour">
          <button
            className="bottom-nav-item"
            type="button"
            onClick={closeTrip}
          >
            <span className="bottom-nav-icon">←</span>
            <span className="bottom-nav-label">Trips</span>
          </button>
          {[
            { key: "dashboard", label: "Trip Overview", icon: "⊞" },
            { key: "prediction", label: "Plan Budget", icon: "📊" },
            { key: "actual", label: "Expenses", icon: "💳" },
            { key: "settlements", label: "Settle", icon: "🤝" },
            { key: "categories", label: "Categories", icon: "🏷" },
            { key: "members", label: "Members", icon: "👥" },
            { key: "settings", label: "Settings", icon: "⚙" },
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              className={`bottom-nav-item${activeTab === key ? " active" : ""}`}
              type="button"
              onClick={() => setActiveTab(key)}
            >
              <span className="bottom-nav-icon">{icon}</span>
              <span className="bottom-nav-label">{label}</span>
            </button>
          ))}
        </nav>

        {!demoMode ? (
        <button
          className="floating-add-expense"
          type="button"
          onClick={() => openFastExpenseModal()}
        >
          <span className="floating-add-icon">+</span>
          <span>Add Expense</span>
        </button>
        ) : null}

        {expenseFeedback ? (
          <div className="expense-feedback" role="status">
            <button
              className="expense-feedback-close"
              type="button"
              aria-label="Dismiss"
              onClick={() => setExpenseFeedback(null)}
            >
              ×
            </button>
            <strong>{expenseFeedback.message}</strong>
            <div className="expense-feedback-actions">
              <button type="button" onClick={undoLastExpense}>Undo</button>
              <button type="button" onClick={addAnotherExpense}>Add another</button>
              <button type="button" onClick={viewDashboardAfterExpense}>View trip overview</button>
            </div>
          </div>
        ) : null}

        {smartSettleToast ? (
          <div className="smart-settle-toast" role="status">
            {smartSettleToast}
          </div>
        ) : null}

        <Modal
          isOpen={Boolean(pendingSmartSettlement)}
          onClose={() => setPendingSmartSettlement(null)}
          title="Mark this settlement as paid?"
        >
          <div className="modal-body">
            {pendingSmartSettlement ? (
              <div className="confirm-settlement-card">
                <p>
                  <strong>{cleanDisplayName(pendingSmartSettlement.suggestion.fromName)}</strong>{" "}
                  will pay{" "}
                  <strong>{cleanDisplayName(pendingSmartSettlement.suggestion.toName)}</strong>.
                </p>
                <strong className="confirm-settlement-amount">
                  {formatMoney(pendingSmartSettlement.suggestion.amount)}
                </strong>
              </div>
            ) : null}
          </div>
          <footer className="modal-footer">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setPendingSmartSettlement(null)}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={savingSettlement || !pendingSmartSettlement}
              onClick={() =>
                pendingSmartSettlement
                  ? handleMarkSmartSettlementPaid(
                      pendingSmartSettlement.suggestion,
                      pendingSmartSettlement.layer,
                      pendingSmartSettlement.settlementGroupId
                    )
                  : null
              }
            >
              {savingSettlement ? "Saving..." : "Mark as paid"}
            </button>
          </footer>
        </Modal>

        {/* Add expense modal */}
        <Modal
          isOpen={isAddExpenseModalOpen}
          onClose={() => setIsAddExpenseModalOpen(false)}
          title="Add expense"
        >
          {renderExpenseForm({
            mode: "add",
            formData: expenseForm,
            setFormData: setExpenseForm,
            onSubmit: handleAddExpense,
            saving: savingExpense,
            onCancel: () => setIsAddExpenseModalOpen(false),
          })}
        </Modal>

        {/* Share invite modal */}
        <Modal
          isOpen={isInviteShareModalOpen}
          onClose={() => setIsInviteShareModalOpen(false)}
          title="Share trip invite"
        >
          <div className="modal-body invite-share-body">
            <p className="small muted">
              Send this link to someone you want to join this trip.
            </p>
            <label>
              Invite link
              <input value={inviteLink} readOnly />
            </label>
            <div className="invite-share-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={copyInviteLink}
              >
                Copy link
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={shareInviteNative}
              >
                Share
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={shareInviteMessage}
              >
                Message
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={shareInviteWhatsApp}
              >
                WhatsApp
              </button>
            </div>
          </div>
        </Modal>

        {/* Edit expense modal */}
        <Modal
          isOpen={Boolean(editingExpenseId)}
          onClose={cancelEditingExpense}
          title="Edit expense"
        >
          {renderExpenseForm({
            mode: "edit",
            formData: expenseEditForm,
            setFormData: setExpenseEditForm,
            onSubmit: handleUpdateExpense,
            saving: savingExpenseEdit,
            onCancel: cancelEditingExpense,
          })}
        </Modal>

        {/* Create category modal */}
        <Modal
          isOpen={isCategoryModalOpen}
          onClose={closeCategoryModal}
          title="Create category"
        >
          <form className="modal-form" onSubmit={handleSaveCategory}>
            <div className="modal-body">
              <p className="small muted">
                Active categories appear in Plan Budget and Expenses forms.
              </p>

              <label>
                Category name
                <input
                  type="text"
                  value={categoryForm.name}
                  placeholder="e.g. Coffee"
                  onChange={e =>
                    setCategoryForm({ ...categoryForm, name: e.target.value })
                  }
                  autoFocus
                  required
                />
              </label>

              <div className="grid-2">
                <label>
                  Type
                  <select
                    value={categoryForm.type}
                    onChange={e =>
                      setCategoryForm({ ...categoryForm, type: e.target.value })
                    }
                  >
                    {CATEGORY_TYPES.map(t => (
                      <option value={t} key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <div className="emoji-field">
                  <span className="emoji-field-label">Icon</span>
                  <button
                    className="emoji-edit-button"
                    type="button"
                    aria-expanded={isEmojiPickerOpen}
                    onClick={() => setIsEmojiPickerOpen(open => !open)}
                  >
                    <span className="emoji-edit-value">{categoryForm.icon || "📌"}</span>
                    <span className="emoji-edit-text">Choose emoji</span>
                  </button>
                  {isEmojiPickerOpen ? (
                    <div className="emoji-picker" role="listbox" aria-label="Choose category emoji">
                      {CATEGORY_EMOJI_OPTIONS.map(emoji => (
                        <button
                          className={`emoji-option${(categoryForm.icon || "📌") === emoji ? " selected" : ""}`}
                          type="button"
                          key={emoji}
                          onClick={() => selectCategoryEmoji(emoji)}
                          aria-label={`Use ${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <label>
                Color
                <input
                  className="color-input"
                  type="color"
                  value={categoryForm.color}
                  onChange={e =>
                    setCategoryForm({ ...categoryForm, color: e.target.value })
                  }
                />
              </label>

              <div className="category-preview">
                <span
                  className="category-dot"
                  style={{
                    backgroundColor: `${categoryForm.color}22`,
                    color: categoryForm.color
                  }}
                >
                  {categoryForm.icon || "📌"}
                </span>
                <div>
                  <strong>{categoryForm.name || "Category preview"}</strong>
                  <p className="small muted">{categoryForm.type}</p>
                </div>
              </div>
            </div>

            <footer className="modal-footer">
              <button
                className="secondary-button"
                type="button"
                onClick={closeCategoryModal}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={savingCategory}
              >
                {savingCategory ? "Saving..." : "Create category"}
              </button>
            </footer>
          </form>
        </Modal>
        <Modal
          isOpen={isSettlementModalOpen}
          onClose={() => setIsSettlementModalOpen(false)}
          title="Record settlement"
        >
          <form className="modal-form" onSubmit={handleRecordSettlement}>
            <div className="modal-body">
              <p className="small muted">
                Use this when someone pays another person back outside the app.
              </p>
              <label>
                Date
                <input
                  type="date"
                  value={settlementForm.date}
                  onClick={openDatePicker}
                  onChange={e =>
                    setSettlementForm({ ...settlementForm, date: e.target.value })
                  }
                  required
                />
              </label>
              <div className="grid-2">
                <label>
                  Who paid?
                  <select
                    value={settlementForm.fromMemberId}
                    onChange={e =>
                      setSettlementForm({ ...settlementForm, fromMemberId: e.target.value })
                    }
                    required
                  >
                    <option value="">Choose person</option>
                    {activeMembers.map(m => (
                      <option value={m.id} key={m.id}>{memberNameOf(m.id)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Who received?
                  <select
                    value={settlementForm.toMemberId}
                    onChange={e =>
                      setSettlementForm({ ...settlementForm, toMemberId: e.target.value })
                    }
                    required
                  >
                    <option value="">Choose person</option>
                    {activeMembers.map(m => (
                      <option value={m.id} key={m.id}>{memberNameOf(m.id)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Amount EUR
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={settlementForm.amountEur}
                  placeholder="0.00"
                  onChange={e =>
                    setSettlementForm({ ...settlementForm, amountEur: e.target.value })
                  }
                  required
                />
              </label>
              <label>
                Notes
                <input
                  type="text"
                  value={settlementForm.notes}
                  placeholder="e.g. Paid via bank transfer"
                  onChange={e =>
                    setSettlementForm({ ...settlementForm, notes: e.target.value })
                  }
                />
              </label>
            </div>
            <footer className="modal-footer">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setIsSettlementModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={savingSettlement}
              >
                {savingSettlement ? "Saving..." : "Record settlement"}
              </button>
            </footer>
          </form>
        </Modal>
        {renderNotificationsModal()}
        {renderTutorialModal()}
      </div>
    );
  }

  function renderLandingPage() {
    const displayName = user?.displayName || user?.email?.split("@")[0] || "traveler";
    return (
      <main className="landing-page">
        <div className="landing-bg" aria-hidden="true">
          <img className="landing-bg-art" src="/landingDesktopBG.svg" alt="" />
        </div>
        <section className="landing-shell">
          <img className="landing-logo" src="/landingPage-logo.svg" alt="TripHisaab" />
          <p className="landing-tagline">Every trip. Every spend. Sorted.</p>

          <div className="landing-copy">
            <h1>Plan, split, and track your trip expenses in one simple place.</h1>
            <p>
              TripHisaab helps you create a trip budget before you travel, log
              real expenses on the go, split shared costs with family or friends,
              and see who owes whom, all backed by Easy CSV export.
            </p>
          </div>

          <div className="landing-actions">
            {user ? (
              <>
                <button
                  className="primary-button landing-google"
                  type="button"
                  onClick={() => {
                    setShowLanding(false);
                    try {
                      localStorage.setItem(APP_VIEW_STORAGE_KEY, "app");
                    } catch {
                      /* localStorage unavailable */
                    }
                  }}
                >
                  {user.photoURL ? <img src={user.photoURL} alt="" /> : null}
                  Continue as {displayName}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={async () => {
                    await signOut(auth);
                    setShowLanding(false);
                    await signInWithPopup(auth, googleProvider);
                  }}
                >
                  Switch account
                </button>
              </>
            ) : (
              <button className="primary-button landing-google" type="button" onClick={handleGoogleLogin}>
                Sign in with Google
              </button>
            )}
            <button className="secondary-button" type="button" onClick={openDemoTrip}>
              Try Demo Trip
            </button>
          </div>

          <p className="landing-secondary">
            Each trip gets its own Easy CSV export, so your expenses stay editable,
            exportable, and under your control.
          </p>
        </section>
      </main>
    );
  }

  // -------------------- Render: invite screen --------------------
  function renderInviteScreen() {
    const inviteSummaryRows = inviteDetails
      ? [
          ["Trip", inviteDetails.tripName],
          [
            "Dates",
            inviteDetails.startDate && inviteDetails.endDate
              ? `${inviteDetails.startDate} to ${inviteDetails.endDate}`
              : ""
          ],
          ["Currency", inviteDetails.defaultCurrency],
          ["Status", inviteDetails.tripStatus]
        ].filter(([, value]) => Boolean(value))
      : [];

    return (
      <main className="page center-page">
        <div className="logo">🧳</div>
        <div>
          <h1>Trip invite</h1>
          {!user ? (
            <p className="muted intro-text">
              Log in with Google to view and accept this trip invitation.
            </p>
          ) : inviteLoading ? (
            <p className="muted intro-text">Loading invite...</p>
          ) : inviteError ? (
            <p className="muted intro-text">{inviteError}</p>
          ) : inviteDetails ? (
            <>
              <p className="muted intro-text">
                You have been invited to join{" "}
                <strong>{inviteDetails.tripName || "this trip"}</strong>
                {inviteDetails.ownerEmail ? ` by ${inviteDetails.ownerEmail}` : ""}.
              </p>
              {inviteSummaryRows.length > 1 ? (
                <div className="invite-summary-card">
                  {inviteSummaryRows.map(([label, value]) => (
                    <p key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="muted intro-text">Preparing invite...</p>
          )}
        </div>
        {!user ? (
          <button className="primary-button" onClick={handleGoogleLogin}>
            Continue with Google
          </button>
        ) : inviteDetails && !inviteError ? (
          <button
            className="primary-button"
            type="button"
            disabled={acceptingInvite}
            onClick={handleAcceptInvite}
          >
            {acceptingInvite ? "Joining trip..." : "Join trip"}
          </button>
        ) : null}
        <button className="secondary-button" type="button" onClick={clearInviteUrl}>
          Cancel
        </button>
        {user ? renderTutorialModal() : null}
      </main>
    );
  }

  // -------------------- Top-level render switch --------------------
  if (authLoading || initialPreloading) {
    return <Preloader />;
  }

  if (pendingInvite) return renderInviteScreen();

  if (selectedTrip) return renderTripScreen();

  if (!user || showLanding) return renderLandingPage();

  if (!user && !showLanding) {
    return (
      <main className="page center-page">
        <div className="logo">💼</div>
        <div>
          <h1>Expense Tracking</h1>
          <p className="muted intro-text">
            Track travel expenses, trip budgets, shared costs, and plan budgets.
          </p>
        </div>
        <button className="primary-button" onClick={handleGoogleLogin}>
          Continue with Google
        </button>
        {renderInstallButton()}
        <p className="small muted">
          Firebase MVP: Google login + Firestore database.
        </p>
      </main>
    );
  }

  {
    const today = todayIso();
    const activeTripCount = trips.filter(t => t.status === "Active").length;
    const upcomingCount = trips.filter(t => t.startDate > today).length;
    const editingTrip = trips.find(t => t.id === editingTripId);
    const filteredTrips = tripSearch.trim()
      ? trips.filter(t => t.name.toLowerCase().includes(tripSearch.toLowerCase()))
      : trips;
    const cardGradients = [
      "linear-gradient(135deg,#89CFF0,#B0E2F5)",
      "linear-gradient(135deg,#F4A96A,#FFD97D)",
      "linear-gradient(135deg,#98D8AA,#C3EFC3)",
      "linear-gradient(135deg,#C9A6E4,#E4C6F0)",
      "linear-gradient(135deg,#F08080,#FFB6C1)",
      "linear-gradient(135deg,#74C0FC,#A5D8FF)",
      "linear-gradient(135deg,#FFD43B,#FFF3BF)",
    ];
    const cardEmojis = ["🌊","🏔","🌸","🏙","🌴","🗺","🏛","🌅","⛵","🗼"];
    const userInitial = (user?.displayName || user?.email || "?")[0].toUpperCase();
    const userName = user?.displayName || user?.email?.split("@")[0] || "User";

    return (
      <div className="app-layout">
        {isSidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)} />
        )}

        <aside className={`sidebar${isSidebarOpen ? " sidebar-open" : ""}`}>
          <div className="sidebar-logo">
            <button className="sidebar-logo-button" type="button" onClick={openLandingPage}>
              <img className="app-logo-img" src="/triphisaab-logo.svg" alt="TripHisaab" />
              <div className="brand-tagline">Every trip. Every spend. Sorted.</div>
            </button>
            <button className="sidebar-close-btn" type="button" aria-label="Close menu" onClick={() => setIsSidebarOpen(false)}>✕</button>
          </div>
          <nav className="sidebar-nav" data-tour="sidebar-tour">
            <button className="sidebar-nav-item active" type="button">
              <span className="sidebar-nav-icon">🗺</span> Trips
            </button>
          </nav>
          <div className="sidebar-promo">
            <div className="sidebar-promo-icon">🧳</div>
            <p className="sidebar-promo-text">Adventure funded.<br/>Memories included. 🌴</p>
          </div>
          <DonateButton />
          <div className="sidebar-footer">
            <div
              className={`sidebar-avatar${userProfile.profileImageDataUrl ? " has-image" : ""}`}
              style={
                userProfile.profileImageDataUrl
                  ? { backgroundImage: `url(${userProfile.profileImageDataUrl})` }
                  : undefined
              }
            >
              {!userProfile.profileImageDataUrl ? userInitial : null}
            </div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name">{userName}</div>
              <div className="sidebar-user-role">Trip admin</div>
            </div>
            <button className="link-button sidebar-logout" type="button" onClick={handleLogout}>Out</button>
          </div>
        </aside>

        <main className="main-content">
          {/* Mobile top bar */}
          <div className="mobile-topbar">
            <button className="hamburger-btn" type="button" aria-label="Open menu" onClick={() => setIsSidebarOpen(true)}>
              <span /><span /><span />
            </button>
            <span className="mobile-topbar-title">
              <img className="mobile-logo-img" src="/triphisaab-logo.svg" alt="TripHisaab" />
            </span>
            {renderInstallButton({ compact: true })}
            <button className="primary-button small-button" type="button" onClick={() => setIsCreateModalOpen(true)}>+ New</button>
          </div>

          {/* Hero banner */}
          <div className="home-hero">
            <div className="home-hero-text">
              <h1 className="home-hero-title">Your trips</h1>
              <p className="home-hero-sub">All your adventures, neatly packed ✈️</p>
            </div>
            <div className="home-hero-right">
              {renderInstallButton()}
              <button className="home-create-btn" type="button" onClick={() => setIsCreateModalOpen(true)} data-tour="create-trip">
                + Create new trip
              </button>
            </div>
          </div>

          <div className="home-content">
            {/* Search row */}
            <div className="home-search-row">
              <div className="home-search-wrap">
                <span className="home-search-icon">🔍</span>
                <input
                  className="home-search-input"
                  type="text"
                  placeholder="Search trips..."
                  value={tripSearch}
                  onChange={e => setTripSearch(e.target.value)}
                />
              </div>
              <button className="secondary-button small-button home-filter-btn" type="button" onClick={() => loadTrips(user.uid, user.email)}>
                ↻ Refresh
              </button>
            </div>

            {/* Stats row */}
            <div className="home-stats-row" data-tour="home-stats">
              <div className="home-stat-card">
                <div className="home-stat-icon" style={{background:"#E8F4FF"}}>💼</div>
                <div>
                  <div className="home-stat-label">Total trips</div>
                  <div className="home-stat-num">{trips.length}</div>
                  <div className="home-stat-sub">All time</div>
                </div>
              </div>
              <div className="home-stat-card">
                <div className="home-stat-icon" style={{background:"#E8FFF0"}}>✈️</div>
                <div>
                  <div className="home-stat-label">Active trips</div>
                  <div className="home-stat-num">{activeTripCount}</div>
                  <div className="home-stat-sub">Currently active</div>
                </div>
              </div>
              <div className="home-stat-card">
                <div className="home-stat-icon" style={{background:"#FFF0E8"}}>📅</div>
                <div>
                  <div className="home-stat-label">Upcoming trips</div>
                  <div className="home-stat-num">{upcomingCount}</div>
                  <div className="home-stat-sub">Starting soon</div>
                </div>
              </div>
              <div className="home-stat-promo">
                <div className="home-stat-promo-title">Passport to organized spending</div>
                <div className="home-stat-promo-sub">Track. Control. Enjoy the journey. 🌍</div>
              </div>
            </div>

            {/* Trip grid */}
            {tripLoading ? (
              <p className="muted" style={{padding:"20px 0"}}>Loading trips...</p>
            ) : filteredTrips.length === 0 ? (
              <div className="empty-card">
                <div className="empty-icon">🧳</div>
                <h3>{tripSearch ? "No trips match your search" : "No trips yet"}</h3>
                <p className="muted">
                  {tripSearch ? "Try a different name." : "Tap + Create new trip to get started."}
                </p>
              </div>
            ) : (
              <div className="home-trip-grid">
                {filteredTrips.map((trip, i) => (
                  <div
                    className="home-trip-card"
                    key={trip.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTrip(trip)}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") openTrip(trip); }}
                  >
                    <div
                      className={`home-trip-img${trip.imageDataUrl ? " has-trip-image" : ""}`}
                      style={
                        trip.imageDataUrl
                          ? { backgroundImage: `url(${trip.imageDataUrl})` }
                          : { background: cardGradients[i % cardGradients.length] }
                      }
                    >
                      {!trip.imageDataUrl ? (
                        <span className="home-trip-emoji">{cardEmojis[i % cardEmojis.length]}</span>
                      ) : null}
                    </div>
                    <div className="home-trip-body">
                      <div className="home-trip-header">
                        <h3 className="home-trip-name">{trip.name}</h3>
                        {trip.ownerId === user.uid ? (
                          <button
                            className="home-trip-edit-btn"
                            type="button"
                            aria-label="Edit trip"
                            onClick={e => { e.stopPropagation(); startEditingTrip(trip); }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                            </svg>
                          </button>
                        ) : null}
                      </div>
                      <p className="home-trip-dates">{trip.startDate} → {trip.endDate}</p>
                      <div className="home-trip-pills">
                        <span className="home-pill">{trip.accessRole === "owner" ? "Owner" : "Member"}</span>
                        <span className="home-pill">{trip.defaultCurrency}</span>
                        <span className="home-pill home-pill-active">● {trip.status}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>

      {/* Create trip modal */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Create new trip"
      >
        <form className="modal-form" onSubmit={handleCreateTrip}>
          <div className="modal-body">
            <label>
              Trip name
              <input
                type="text"
                value={form.name}
                placeholder="e.g. Norway 2026"
                onChange={e => setForm({ ...form, name: e.target.value })}
                autoFocus
                required
              />
            </label>
            <DateRangePicker
              label="Trip dates"
              startDate={form.startDate}
              endDate={form.endDate}
              onChange={(startDate, endDate) =>
                setForm(f => ({ ...f, startDate, endDate }))
              }
            />
            <label>
              Default currency
              <select
                value={form.defaultCurrency}
                onChange={e =>
                  setForm({ ...form, defaultCurrency: e.target.value })
                }
              >
                {SUPPORTED_CURRENCIES.map(c => (
                  <option value={c} key={c}>{c}</option>
                ))}
              </select>
            </label>
            <div>
              <div className="create-trip-img-label">Trip image <span className="muted" style={{fontWeight:500}}>(optional)</span></div>
              <div className="create-trip-img-row">
                <div
                  className={`create-trip-img-preview${form.imageDataUrl ? " has-image" : ""}`}
                  style={form.imageDataUrl ? { backgroundImage: `url(${form.imageDataUrl})` } : undefined}
                >
                  {!form.imageDataUrl && <span>🏔</span>}
                </div>
                <div className="trip-image-controls">
                  <label className="trip-image-upload small-button">
                    {form.imageDataUrl ? "Change image" : "Upload image"}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleCreateTripImageChange}
                    />
                  </label>
                  {form.imageDataUrl && (
                    <button
                      className="secondary-button small-button"
                      type="button"
                      onClick={() => setForm(f => ({ ...f, imageDataUrl: "" }))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <footer className="modal-footer">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setIsCreateModalOpen(false)}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={creatingTrip}
            >
              {creatingTrip ? "Creating..." : "Create trip"}
            </button>
          </footer>
        </form>
      </Modal>

      {/* Edit trip modal */}
      <Modal
        isOpen={Boolean(editingTripId)}
        onClose={cancelEditingTrip}
        title="Edit trip"
      >
        <form className="modal-form" onSubmit={handleUpdateTrip}>
          <div className="modal-body">
            <label>
              Trip name
              <input
                type="text"
                value={editForm.name}
                onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                autoFocus
                required
              />
            </label>
            <DateRangePicker
              label="Trip dates"
              startDate={editForm.startDate}
              endDate={editForm.endDate}
              onChange={(startDate, endDate) =>
                setEditForm(f => ({ ...f, startDate, endDate }))
              }
            />
            <label>
              Default currency
              <select
                value={editForm.defaultCurrency}
                onChange={e =>
                  setEditForm({ ...editForm, defaultCurrency: e.target.value })
                }
              >
                {SUPPORTED_CURRENCIES.map(c => (
                  <option value={c} key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select
                value={editForm.status}
                onChange={e =>
                  setEditForm({ ...editForm, status: e.target.value })
                }
              >
                {TRIP_STATUSES.map(s => (
                  <option value={s} key={s}>{s}</option>
                ))}
              </select>
            </label>
            <div>
              <div className="create-trip-img-label">Trip image <span className="muted" style={{fontWeight:500}}>(optional)</span></div>
              <div className="create-trip-img-row">
                <div
                  className={`create-trip-img-preview${editForm.imageDataUrl ? " has-image" : ""}`}
                  style={editForm.imageDataUrl ? { backgroundImage: `url(${editForm.imageDataUrl})` } : undefined}
                >
                  {!editForm.imageDataUrl && <span>🏔</span>}
                </div>
                <div className="trip-image-controls">
                  <label className="trip-image-upload small-button">
                    {editForm.imageDataUrl ? "Change image" : "Upload image"}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleEditTripImageChange}
                    />
                  </label>
                  {editForm.imageDataUrl && (
                    <button
                      className="secondary-button small-button"
                      type="button"
                      onClick={() => setEditForm(f => ({ ...f, imageDataUrl: "" }))}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <footer className="modal-footer">
            <button
              className="danger-button"
              type="button"
              disabled={deletingTrip || savingEdit || !editingTrip}
              onClick={() => editingTrip && handleDeleteTrip(editingTrip)}
            >
              {deletingTrip ? "Deleting..." : "Delete trip"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={cancelEditingTrip}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={savingEdit}
            >
              {savingEdit ? "Saving..." : "Save changes"}
            </button>
          </footer>
        </form>
      </Modal>
      {renderTutorialModal()}
    </div>
  );
  }
}

export default App;
