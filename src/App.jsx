import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
const APP_VERSION = "2.1.0";
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
  deleteDoc,
  onSnapshot
} from "firebase/firestore";

import { auth, googleProvider, db } from "./firebase";
import {
  DEFAULT_CATEGORIES,
  SUPPORTED_CURRENCIES,
  FALLBACK_EXCHANGE_RATES_FROM_EUR,
  TRIP_STATUSES,
  CATEGORY_TYPES,
  MEMBER_DIRECTORY_STORAGE_KEY,
  APP_VIEW_STORAGE_KEY,
  LAST_TRIP_STORAGE_KEY,
  LAST_TAB_STORAGE_KEY,
  TRIP_IMAGE_MAX_WIDTH,
  TRIP_IMAGE_MAX_HEIGHT,
  TRIP_IMAGE_QUALITY,
  TRIP_IMAGE_MAX_BYTES,
  PROFILE_IMAGE_SIZE,
  PROFILE_IMAGE_QUALITY,
  MONEY_EPSILON,
  EMPTY_EXPENSE_FORM,
  EMPTY_BUDGET_FORM,
  EMPTY_TASK_FORM,
  CATEGORY_EMOJI_OPTIONS,
  BUDGET_SCOPE_OPTIONS,
  TASK_TYPE_OPTIONS,
  TASK_SCOPE_OPTIONS
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

function canUserSeeTask(task, currentUserId) {
  if (!task) return false;
  if (task.visibleTo === "all") return true;
  if (Array.isArray(task.visibleTo) && task.visibleTo.includes(currentUserId)) return true;
  if (Array.isArray(task.assignedTo) && task.assignedTo.includes(currentUserId)) return true;
  return task.createdBy === currentUserId;
}

function canUserCompleteTask(task, currentUserId) {
  if (!task || !currentUserId) return false;
  return task.createdBy === currentUserId
    || (Array.isArray(task.assignedTo) && task.assignedTo.includes(currentUserId));
}

function canUserEditTask(task, currentUserId, isAdmin = false) {
  if (!task) return false;
  if (isAdmin) return true;
  if (!currentUserId) return false;
  return task.createdBy === currentUserId;
}

function getVisibleTasks(tasks, currentUserId) {
  return tasks.filter(task => task.isActive !== false && canUserSeeTask(task, currentUserId));
}

function getPendingTasks(tasks) {
  return tasks.filter(task => task.isActive !== false && (task.status || "todo") === "todo");
}

function getDoneTasks(tasks) {
  return tasks.filter(task => task.isActive !== false && task.status === "done");
}

function getTasksAssignedToMe(tasks, currentUserId) {
  return tasks.filter(task =>
    task.isActive !== false
    && Array.isArray(task.assignedTo)
    && task.assignedTo.includes(currentUserId)
  );
}

function getTaskCreatedTime(task) {
  if (task?.createdAt?.seconds) return task.createdAt.seconds * 1000;
  if (typeof task?.createdAt === "string") {
    const parsed = Date.parse(task.createdAt);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function getOverviewTasks(tasks, currentUserId) {
  const today = todayIso();
  return getPendingTasks(getVisibleTasks(tasks, currentUserId))
    .slice()
    .sort((a, b) => {
      const aAssigned = a.assignedTo?.includes(currentUserId) ? 1 : 0;
      const bAssigned = b.assignedTo?.includes(currentUserId) ? 1 : 0;
      if (aAssigned !== bAssigned) return bAssigned - aAssigned;
      const aOverdue = a.dueDate && a.dueDate < today ? 1 : 0;
      const bOverdue = b.dueDate && b.dueDate < today ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      const aGroup = a.scope === "group" ? 1 : 0;
      const bGroup = b.scope === "group" ? 1 : 0;
      if (aGroup !== bGroup) return bGroup - aGroup;
      return getTaskCreatedTime(b) - getTaskCreatedTime(a);
    })
    .slice(0, 5);
}

function getTaskSummary(tasks, currentUserId) {
  const visibleTasks = getVisibleTasks(tasks, currentUserId);
  return {
    assignedToMeCount: getTasksAssignedToMe(visibleTasks, currentUserId).length,
    groupTaskCount: visibleTasks.filter(task => task.scope === "group").length,
    doneCount: getDoneTasks(visibleTasks).length,
    pendingCount: getPendingTasks(visibleTasks).length
  };
}

function isActiveSharedExpense(expense) {
  return expense?.isActive !== false
    && expense?.expenseType === "shared"
    && Number(expense?.amountEur || 0) > 0;
}

function getMemberUnitMap(settlementGroups) {
  const map = {};
  settlementGroups.filter(g => g.isActive !== false).forEach(g => {
    g.memberIds.forEach(id => { map[id] = g.id; });
  });
  return map;
}

function getGroupSettlementExpenses(expenses) {
  return expenses.filter(expense => {
    if (!isActiveSharedExpense(expense)) return false;
    return normalizeExpenseScope(expense) === "group"
      || expense.visibleTo === "all"
      || expense.countsTowardGroupSettlement === true;
  });
}

function isIncludedPersonalExpense(expense) {
  return expense?.isActive !== false
    && normalizeExpenseScope(expense) === "personal"
    && Number(expense?.amountEur || 0) > 0
    && expense?.includeInGroupTotal !== false;
}

function getPersonalContributionTotal(contributions, expenses, currentUserUid, currentUserMemberId, canUseLoadedPersonalExpenses = false) {
  if (canUseLoadedPersonalExpenses) {
    return roundMoney(
      expenses
        .filter(isIncludedPersonalExpense)
        .reduce((sum, expense) => sum + Number(expense.amountEur || 0), 0)
    );
  }

  const contributionByUser = new Map(
    contributions.map(contribution => [
      contribution.memberId || contribution.userId,
      Number(contribution.totalEur || 0)
    ])
  );

  if (currentUserUid && currentUserMemberId) {
    const currentUserTotal = expenses
      .filter(expense =>
        isIncludedPersonalExpense(expense)
        && expense.paidByMemberId === currentUserMemberId
      )
      .reduce((sum, expense) => sum + Number(expense.amountEur || 0), 0);
    contributionByUser.set(currentUserMemberId, currentUserTotal);
  }

  return roundMoney(
    Array.from(contributionByUser.values())
      .reduce((sum, amount) => sum + Number(amount || 0), 0)
  );
}

function getMemberContributionSummary(expenses, memberId) {
  const includedExpenses = expenses.filter(expense =>
    isIncludedPersonalExpense(expense)
    && expense.paidByMemberId === memberId
  );
  return {
    totalEur: roundMoney(
      includedExpenses.reduce((sum, expense) => sum + Number(expense.amountEur || 0), 0)
    ),
    expenseCount: includedExpenses.length
  };
}

function getTripTotalsSummary(expenses) {
  const activeExpenses = expenses.filter(expense =>
    expense?.isActive !== false && Number(expense?.amountEur || 0) > 0
  );
  const sharedExpenses = activeExpenses.filter(expense => expense.expenseType === "shared");
  const includedPersonalExpenses = activeExpenses.filter(isIncludedPersonalExpense);
  const sharedTotalEur = roundMoney(
    sharedExpenses.reduce((sum, expense) => sum + Number(expense.amountEur || 0), 0)
  );
  const personalTotalEur = roundMoney(
    includedPersonalExpenses.reduce((sum, expense) => sum + Number(expense.amountEur || 0), 0)
  );
  return {
    sharedTotalEur,
    personalTotalEur,
    totalSpentEur: roundMoney(sharedTotalEur + personalTotalEur),
    expenseCount: activeExpenses.length,
    sharedExpenseCount: sharedExpenses.length,
    personalExpenseCount: includedPersonalExpenses.length
  };
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
          : normalizeExpenseScope(expense) === "selected_members"
            ? [expense.paidByMemberId].filter(Boolean)
            : members.map(m => m.id);
      const perPerson = splitIds.length > 0 ? amount / splitIds.length : 0;
      splitIds.forEach(id => { shares[id] = perPerson; });
      // Assign rounding residual to payer (or last person) so shares sum exactly to amount.
      const totalShares = roundMoney(splitIds.reduce((s, id) => s + (shares[id] || 0), 0));
      const residual = roundMoney(amount - totalShares);
      if (Math.abs(residual) > 0) {
        const adjustId = splitIds.includes(expense.paidByMemberId)
          ? expense.paidByMemberId
          : splitIds[splitIds.length - 1];
        if (adjustId) shares[adjustId] = roundMoney((shares[adjustId] || 0) + residual);
      }
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
    const familiarResult = generateFamiliarSettlements(groupBalances, relationshipGraph, currency);
    if (familiarResult.fallbackRequired) {
      // Auto-resolve unmatched balances with fewest-payments and tag them.
      const fallbackSuggestions = generateSettlementSuggestions(
        [...familiarResult.unresolvedDebtors, ...familiarResult.unresolvedCreditors],
        currency
      ).map(s => ({ ...s, isFallback: true }));
      groupResult = {
        suggestions: [...familiarResult.suggestions, ...fallbackSuggestions],
        fallbackRequired: false,
        unresolvedDebtors: [],
        unresolvedCreditors: [],
        hasFallbackPayments: fallbackSuggestions.length > 0
      };
    } else {
      groupResult = familiarResult;
    }
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
      const famPriv = generateFamiliarSettlements(balances, privRelGraph, currency);
      if (famPriv.fallbackRequired) {
        const fallbackSuggestions = generateSettlementSuggestions(
          [...famPriv.unresolvedDebtors, ...famPriv.unresolvedCreditors],
          currency
        ).map(s => ({ ...s, isFallback: true }));
        privResult = {
          suggestions: [...famPriv.suggestions, ...fallbackSuggestions],
          fallbackRequired: false, unresolvedDebtors: [], unresolvedCreditors: [],
          hasFallbackPayments: fallbackSuggestions.length > 0
        };
      } else {
        privResult = famPriv;
      }
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

  // In family_couple mode, exclude intra-unit private settlements from consolidated
  // (they cancel at the unit level). Cross-unit private visibilty is expanded when
  // settlement groups are saved, so all unit members see the same consolidated total.
  let consolidatedPrivates = privateSettlements;
  if (mode === "family_couple") {
    const unitMap = getMemberUnitMap(settlementGroups);
    consolidatedPrivates = privateSettlements.filter(group => {
      const unitIds = new Set(group.memberIds.map(id => unitMap[id]).filter(Boolean));
      return unitIds.size >= 2;
    });
  }
  const combinedMemberBalances = getCombinedMemberBalances(
    { balances: groupBalances },
    consolidatedPrivates
  );
  let consolidatedSuggestions;
  if (mode === "family_couple") {
    const units = getSettlementUnits(activeMembers, settlementGroups);
    consolidatedSuggestions = generateFamilyCoupleSettlements(combinedMemberBalances, units, currency);
  } else {
    consolidatedSuggestions = generateSettlementSuggestions(combinedMemberBalances, currency);
  }
  return {
    groupSettlement: {
      totalSpent: roundMoney(groupExpenses.reduce((s, e) => s + Number(e.amountEur || 0), 0)),
      balances: groupBalances,
      suggestions: groupResult.suggestions,
      fallbackRequired: groupResult.fallbackRequired || false,
      unresolvedDebtors: groupResult.unresolvedDebtors || [],
      unresolvedCreditors: groupResult.unresolvedCreditors || []
    },
    privateSettlements,
    consolidatedSuggestions
  };
}

function generateConsolidatedSettlement(groupSettlement, privateSettlements, currency = "EUR") {
  const combined = {};
  groupSettlement.balances.forEach(b => {
    combined[b.memberId] = { memberId: b.memberId, name: b.name, net: b.net };
  });
  privateSettlements.forEach(privGroup => {
    privGroup.balances.forEach(b => {
      if (!combined[b.memberId]) {
        combined[b.memberId] = { memberId: b.memberId, name: b.name, net: 0 };
      }
      combined[b.memberId].net = roundMoney(combined[b.memberId].net + b.net);
    });
  });
  return generateSettlementSuggestions(Object.values(combined), currency);
}

function getCombinedMemberBalances(groupSettlement, privateSettlements) {
  const combined = {};
  groupSettlement.balances.forEach(b => {
    combined[b.memberId] = { memberId: b.memberId, name: b.name, paid: b.paid, share: b.share, net: b.net };
  });
  privateSettlements.forEach(privGroup => {
    privGroup.balances.forEach(b => {
      if (!combined[b.memberId]) {
        combined[b.memberId] = { memberId: b.memberId, name: b.name, paid: 0, share: 0, net: 0 };
      }
      combined[b.memberId].paid = roundMoney(combined[b.memberId].paid + b.paid);
      combined[b.memberId].share = roundMoney(combined[b.memberId].share + b.share);
      combined[b.memberId].net = roundMoney(combined[b.memberId].net + b.net);
    });
  });
  return Object.values(combined);
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
function Modal({ isOpen, onClose, title, children, className }) {
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
        className={`modal${className ? ` ${className}` : ""}`}
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
  const [tasks, setTasks] = useState([]);
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
  const [pendingSettleAmount, setPendingSettleAmount] = useState("");
  const [pendingSettleActualPayer, setPendingSettleActualPayer] = useState("");
  const [smartSettleToast, setSmartSettleToast] = useState("");
  const [appToast, setAppToast] = useState(null);
  const appToastTimer = useRef(null);
  const [settlementMode, setSettlementMode] = useState("fewest_payments");
  const [settlementGroups, setSettlementGroups] = useState([]);
  const [settlementGroupForm, setSettlementGroupForm] = useState({ name: "", memberIds: [], type: "couple" });
  const [editingSettlementGroupId, setEditingSettlementGroupId] = useState(null);
  const [showSettlementGroupForm, setShowSettlementGroupForm] = useState(false);
  const [showSettlementBreakdown, setShowSettlementBreakdown] = useState(false);

  const [personalBudget, setPersonalBudget] = useState(null);
  const [showPersonalBudgetForm, setShowPersonalBudgetForm] = useState(false);
  const [showCategoryBreakdown, setShowCategoryBreakdown] = useState(false);
  const [personalBudgetForm, setPersonalBudgetForm] = useState({ amount: "", currency: "EUR" });
  const [savingPersonalBudget, setSavingPersonalBudget] = useState(false);
  const [personalContributions, setPersonalContributions] = useState([]);
  const [tripTotalsSummary, setTripTotalsSummary] = useState(null);

  const [savingPredictions, setSavingPredictions] = useState(false);
  const [budgetForm, setBudgetForm] = useState(EMPTY_BUDGET_FORM);
  const [editingBudgetId, setEditingBudgetId] = useState(null);

  const [taskForm, setTaskForm] = useState(EMPTY_TASK_FORM);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [savingTask, setSavingTask] = useState(false);
  const [taskFilter, setTaskFilter] = useState("all");
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [isBulkTaskModalOpen, setIsBulkTaskModalOpen] = useState(false);
  const [bulkTaskRows, setBulkTaskRows] = useState([{ id: 1, title: "", type: "general" }]);
  const [savingBulkTasks, setSavingBulkTasks] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState(new Set());
  const [isBulkAssignOpen, setIsBulkAssignOpen] = useState(false);
  const [bulkAssignMode, setBulkAssignMode] = useState("group");
  const [bulkAssignMemberIds, setBulkAssignMemberIds] = useState([]);
  const [savingBulkAssign, setSavingBulkAssign] = useState(false);

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
  const [showBetaWelcome, setShowBetaWelcome] = useState(() => {
    try { return !localStorage.getItem('thBetaWelcomeSeen'); } catch { return false; }
  });
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(0);
  const [feedbackWorking, setFeedbackWorking] = useState('');
  const [feedbackBroken, setFeedbackBroken] = useState('');
  const [feedbackSuggestion, setFeedbackSuggestion] = useState('');
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
  const crossUnitExpandedTripsRef = useRef(new Set());

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
    const ua = navigator.userAgent || '';
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isMobile) {
      const isAndroid = /Android/i.test(ua);
      document.documentElement.classList.add(isAndroid ? 'os-android' : 'os-ios');
    }
  }, []);

  useEffect(() => {
    let lastY = 0;
    const onScroll = (e) => {
      const el = e.target;
      if (!el?.classList?.contains('main-content')) return;
      const y = el.scrollTop;
      const atBottom = y + el.clientHeight >= el.scrollHeight - 40;
      if (y <= 60 || atBottom) {
        document.documentElement.classList.remove('fabs-hidden');
      } else if (y > lastY) {
        document.documentElement.classList.add('fabs-hidden');
      } else {
        document.documentElement.classList.remove('fabs-hidden');
      }
      lastY = y;
    };
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => document.removeEventListener('scroll', onScroll, true);
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

  // Restore settlement mode from localStorage when trip changes.
  // Settlement groups are loaded from Firestore in loadTripData.
  useEffect(() => {
    if (!selectedTrip) return;
    const tripId = selectedTrip.id;
    try {
      const storedMode = localStorage.getItem(`triphisaab-settle-mode-${tripId}`);
      if (storedMode) setSettlementMode(storedMode);
      else setSettlementMode("fewest_payments");
    } catch {
      setSettlementMode("fewest_payments");
    }
    setShowSettlementGroupForm(false);
    setEditingSettlementGroupId(null);
    setShowSettlementBreakdown(false);
  }, [selectedTrip?.id]);

  useEffect(() => {
    try {
      localStorage.setItem(LAST_TAB_STORAGE_KEY, activeTab);
    } catch {
      /* localStorage unavailable */
    }
  }, [activeTab]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelectorAll(".main-content").forEach(container => {
        container.scrollTo({ top: 0, left: 0, behavior: "auto" });
      });
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.documentElement.classList.remove("fabs-hidden");
    });

    return () => cancelAnimationFrame(frame);
  }, [activeTab, selectedTrip?.id, showLanding]);

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

  const totals = useMemo(() => {
    let shared = 0;
    expenses.forEach(e => {
      const amount = Number(e.amountEur || 0);
      if (e.isActive === false || amount <= 0) return;
      if (e.expenseType === "shared") shared += amount;
    });
    const isTripOwner = selectedTrip?.ownerId === user?.uid;
    // Add all members' personal contributions (amounts they opted to count toward group total).
    // Each member's doc holds only their aggregate — no individual expense details exposed.
    const contribTotal = getPersonalContributionTotal(
      personalContributions,
      expenses,
      user?.uid,
      currentUserMemberId,
      isTripOwner
    );
    if (!isTripOwner && tripTotalsSummary?.totalSpentEur != null) {
      shared = Number(tripTotalsSummary.sharedTotalEur || 0);
    }
    const actual = !isTripOwner && tripTotalsSummary?.totalSpentEur != null
      ? roundMoney(tripTotalsSummary.totalSpentEur)
      : roundMoney(shared + contribTotal);
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
  }, [currentUserMemberId, expenses, personalContributions, predictions, selectedTrip?.ownerId, settlements, tripTotalsSummary, user?.uid]);

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

  // Real-time listener for settlements — keeps all members in sync when someone marks a payment.
  // Must be placed after currentUserMemberId is declared to avoid temporal dead zone.
  useEffect(() => {
    if (!selectedTrip || selectedTrip.id === DEMO_TRIP_ID || selectedTrip.isDemo) return;
    const tripId = selectedTrip.id;
    const isOwner = selectedTrip.ownerId === user?.uid;
    const settlementCol = collection(db, "trips", tripId, "settlements");

    let queries;
    if (isOwner) {
      queries = [settlementCol];
    } else {
      const memberId = currentUserMemberId;
      queries = [
        query(settlementCol, where("settlementLayer", "==", "group")),
        ...(memberId
          ? [query(settlementCol, where("settlementMemberIds", "array-contains", memberId))]
          : [])
      ];
    }

    const mergedMap = new Map();
    const unsubscribers = queries.map(q =>
      onSnapshot(q, snap => {
        snap.docs.forEach(d => mergedMap.set(d.id, { id: d.id, ...d.data() }));
        setSettlements(Array.from(mergedMap.values()));
      }, () => { })
    );
    return () => unsubscribers.forEach(u => u());
  }, [selectedTrip?.id, user?.uid, currentUserMemberId]);

  useEffect(() => {
    if (!selectedTrip || selectedTrip.id === DEMO_TRIP_ID || selectedTrip.isDemo) return;
    const contributionsCol = collection(db, "trips", selectedTrip.id, "personalContributions");
    return onSnapshot(
      contributionsCol,
      snap => {
        setPersonalContributions(
          snap.docs.map(d => ({ userId: d.id, ...d.data() }))
        );
      },
      () => {}
    );
  }, [selectedTrip]);

  useEffect(() => {
    if (!selectedTrip || selectedTrip.id === DEMO_TRIP_ID || selectedTrip.isDemo) return;
    const summaryRef = doc(db, "trips", selectedTrip.id, "tripTotals", "summary");
    return onSnapshot(
      summaryRef,
      snap => {
        setTripTotalsSummary(snap.exists() ? snap.data() : null);
      },
      () => {}
    );
  }, [selectedTrip]);

  const currentUserBalance = useMemo(
    () => balances.find(b => b.memberId === currentUserMemberId) || null,
    [balances, currentUserMemberId]
  );

  const visibleTasks = useMemo(
    () => getVisibleTasks(tasks, currentUserMemberId),
    [tasks, currentUserMemberId]
  );

  const taskSummary = useMemo(
    () => getTaskSummary(tasks, currentUserMemberId),
    [tasks, currentUserMemberId]
  );

  const overviewTasks = useMemo(
    () => getOverviewTasks(tasks, currentUserMemberId),
    [tasks, currentUserMemberId]
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

  const myPersonalExpenses = useMemo(
    () =>
      currentUserMemberId
        ? expenses.filter(
            e =>
              e.expenseType !== "shared" &&
              e.paidByMemberId === currentUserMemberId &&
              e.isActive !== false
          )
        : [],
    [expenses, currentUserMemberId]
  );

  const memberSpending = useMemo(() => {
    const result = balances.map(b => {
      const personalPaid = roundMoney(
        expenses
          .filter(
            e =>
              e.isActive !== false &&
              e.expenseType !== "shared" &&
              e.paidByMemberId === b.memberId
          )
          .reduce((s, e) => s + Number(e.amountEur || 0), 0)
      );
      return { ...b, personalPaid, totalPaid: roundMoney(b.paid + personalPaid) };
    });
    result.sort((a, b) => {
      if (a.memberId === currentUserMemberId) return -1;
      if (b.memberId === currentUserMemberId) return 1;
      return b.totalPaid - a.totalPaid;
    });
    return result;
  }, [balances, expenses, currentUserMemberId]);

  const spendingBreakdown = useMemo(
    () =>
      categories
        .map((category, index) => {
          const actual = actualByCategoryId.get(category.id) || 0;
          return {
            ...category,
            actual,
            color:
              category.color ||
              ["#0f766e", "#2563eb", "#7c3aed", "#ea580c", "#16a34a", "#db2777"][index % 6]
          };
        })
        .filter(category => category.actual > 0),
    [categories, actualByCategoryId]
  );

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

  // -------------------- Toast notifications --------------------
  function showToast(message, type = "error") {
    if (appToastTimer.current) clearTimeout(appToastTimer.current);
    setAppToast({ message, type });
    appToastTimer.current = setTimeout(() => setAppToast(null), 3800);
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
      showToast("Could not save profile picture.", "error");
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
      showToast(error.message || "Could not upload profile picture.", "error");
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
      showToast("Google login failed. Check that Google sign-in is enabled in Firebase Authentication.", "error");
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

    showToast("To add TripHisaab: on iPhone tap Share then Add to Home Screen; on Android open the browser menu and tap Install or Add to Home Screen.", "info");
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
      showToast("Logout failed. Please try again.", "error");
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
      showToast("Could not join trip. Check your Firestore rules.", "error");
    } finally {
      setAcceptingInvite(false);
    }
  }

  async function createInviteLink() {
    if (!selectedTrip || !user) return;
    if (!canManageSelectedTrip()) {
      showToast("Only the trip owner can create invite links.", "error");
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
      showToast("Could not create invite link. Check your Firestore rules.", "error");
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
      showToast("Invite link created and copied.", "success");
    } catch {
      showToast("Invite link created. Copy it from the field below.", "info");
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
      showToast("Invite link copied.", "success");
    } catch {
      showToast("Could not copy automatically. Select and copy the link manually.", "error");
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
      showToast("Could not load trips. Check your Firestore rules.", "error");
      return [];
    } finally {
      setTripLoading(false);
    }
  }

  async function handleCreateTrip(event) {
    event.preventDefault();
    if (!user) {
      showToast("Please log in first.", "error");
      return;
    }
    if (!form.name.trim()) {
      showToast("Trip name is required.", "error");
      return;
    }
    if (new Date(form.endDate) < new Date(form.startDate)) {
      showToast("End date must be on or after start date.", "error");
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
      showToast("Could not create trip. Check your Firestore rules.", "error");
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
      showToast("Only the trip owner can delete this trip.", "error");
      return;
    }

    const confirmed = window.confirm(
      `Delete "${targetTrip.name}" permanently?\n\nThis removes the trip, members, expenses, settlements, tasks, plan budget, categories, and invite links for everyone.`
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
        "tasks",
        "invites",
        "personalBudgets",
        "personalContributions",
        "settlementGroups"
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
      showToast("Could not delete trip. Check your Firestore rules.", "error");
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
      showToast("Trip name is required.", "error");
      return;
    }
    if (new Date(editForm.endDate) < new Date(editForm.startDate)) {
      showToast("End date must be on or after start date.", "error");
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
      showToast("Could not update trip. Check your Firestore rules.", "error");
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
        showToast("Choose a new trip image before saving.", "error");
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
        showToast("Could not save trip image. Please publish the latest Firestore rules and try again.", "error");
      } finally {
        setSavingTripSettings(false);
      }
      return;
    }

    if (!settingsTripForm.name.trim()) {
      showToast("Trip name is required.", "error");
      return;
    }
    if (new Date(settingsTripForm.endDate) < new Date(settingsTripForm.startDate)) {
      showToast("End date must be on or after start date.", "error");
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
      showToast(
        tripImageChanged
          ? "Could not save trip settings. Try uploading a smaller trip image, or check that your database rules allow trip updates."
          : "Could not save trip settings.",
        "error"
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
      showToast(error.message || "Could not upload image.", "error");
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
      showToast(error.message || "Could not upload image.", "error");
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
      showToast(error.message || "Could not upload image.", "error");
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
    setTasks([]);
    setNotifications([]);
    setSelectedNotification(null);
    setPersonalBudget(null);
    setShowPersonalBudgetForm(false);
    setPersonalContributions([]);
    setTripTotalsSummary(null);
    closeTaskModal();
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
      setTasks([]);
      setNotifications([]);
      setSettlementGroups([]);
      setTripDataLoading(false);
      return;
    }
    setTripDataLoading(true);
    try {
      // Parallelize the base reads; budget visibility depends on the loaded member id.
      const [membersSnap, categoriesSnap, settlementGroupsSnap] =
        await Promise.all([
          getDocs(collection(db, "trips", tripId, "members")),
          getDocs(collection(db, "trips", tripId, "categories")),
          getDocs(collection(db, "trips", tripId, "settlementGroups")).catch(() => ({ docs: [] }))
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
      const taskCollection = collection(db, "trips", tripId, "tasks");
      const canLoadAllTasks = tripContext?.ownerId === user?.uid;
      const taskSnaps = canLoadAllTasks
        ? [await getDocs(taskCollection)]
        : await Promise.all([
            getDocs(query(taskCollection, where("scope", "==", "group"))).catch(() => ({ docs: [] })),
            loadedCurrentUserMemberId
              ? getDocs(
                  query(
                    taskCollection,
                    where("visibleTo", "array-contains", loadedCurrentUserMemberId)
                  )
                ).catch(() => ({ docs: [] }))
              : Promise.resolve({ docs: [] }),
            loadedCurrentUserMemberId
              ? getDocs(
                  query(
                    taskCollection,
                    where("assignedTo", "array-contains", loadedCurrentUserMemberId)
                  )
                ).catch(() => ({ docs: [] }))
              : Promise.resolve({ docs: [] }),
            loadedCurrentUserMemberId
              ? getDocs(
                  query(
                    taskCollection,
                    where("createdBy", "==", loadedCurrentUserMemberId)
                  )
                ).catch(() => ({ docs: [] }))
              : Promise.resolve({ docs: [] })
          ]);
      const loadedTasks = Array.from(
        taskSnaps
          .flatMap(snap => snap.docs)
          .reduce((map, d) => map.set(d.id, { id: d.id, ...d.data() }), new Map())
          .values()
      ).filter(task => canLoadAllTasks || canUserSeeTask(task, loadedCurrentUserMemberId));
      const expenseCollection = collection(db, "trips", tripId, "expenses");
      const canLoadAllExpenses = tripContext?.ownerId === user?.uid;
      const expenseSnaps = canLoadAllExpenses
        ? [await getDocs(expenseCollection)]
        : await Promise.all([
            getDocs(query(expenseCollection, where("scope", "==", "group"))),
            getDocs(query(expenseCollection, where("scope", "==", null))).catch(() => ({ docs: [] })),
            getDocs(query(expenseCollection, where("visibleTo", "==", "all"))).catch(() => ({ docs: [] })),
            getDocs(query(expenseCollection, where("countsTowardGroupSettlement", "==", true))).catch(() => ({ docs: [] })),
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

      // Settlement groups — load from Firestore; migrate from localStorage on first load.
      const firestoreGroups = settlementGroupsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(g => g.isActive !== false);
      let loadedSettlementGroups = firestoreGroups;
      if (firestoreGroups.length === 0) {
        try {
          const storedKey = `triphisaab-settle-groups-${tripId}`;
          const stored = localStorage.getItem(storedKey);
          if (stored) {
            const parsed = JSON.parse(stored).filter(g => g.isActive !== false);
            if (parsed.length > 0) {
              const batch = writeBatch(db);
              parsed.forEach(g => batch.set(doc(db, "trips", tripId, "settlementGroups", g.id), g));
              await batch.commit();
              loadedSettlementGroups = parsed;
            }
          }
        } catch { /* migration is non-fatal */ }
      }
      try { localStorage.removeItem(`triphisaab-settle-groups-${tripId}`); } catch { /* ignore */ }

      // Deduplicate groups by member set — keep first, soft-delete extras.
      const seenMemberSets = new Set();
      const deduped = [];
      const duplicateIds = [];
      for (const g of loadedSettlementGroups) {
        const key = [...g.memberIds].sort().join(",");
        if (seenMemberSets.has(key)) {
          duplicateIds.push(g.id);
        } else {
          seenMemberSets.add(key);
          deduped.push(g);
        }
      }
      if (duplicateIds.length > 0) {
        loadedSettlementGroups = deduped;
        try {
          const batch = writeBatch(db);
          duplicateIds.forEach(id =>
            batch.update(doc(db, "trips", tripId, "settlementGroups", id), {
              isActive: false, updatedAt: new Date().toISOString()
            })
          );
          await batch.commit();
        } catch { /* dedup cleanup is non-fatal */ }
      }

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

      loadedTasks.sort((a, b) => {
        if ((a.status || "todo") !== (b.status || "todo")) {
          return (a.status || "todo") === "todo" ? -1 : 1;
        }
        if (a.dueDate || b.dueDate) {
          return String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31"));
        }
        return getTaskCreatedTime(b) - getTaskCreatedTime(a);
      });

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
      setTasks(loadedTasks);
      setNotifications(loadedNotifications);
      setSettlementGroups(loadedSettlementGroups);

      if (user?.uid) {
        const pbSnap = await getDoc(doc(db, "trips", tripId, "personalBudgets", user.uid)).catch(() => null);
        setPersonalBudget(pbSnap?.exists() ? { ...pbSnap.data() } : null);
      } else {
        setPersonalBudget(null);
      }

      // Load all members' personal contribution totals (aggregate only — no expense detail exposed).
      const contribSnap = await getDocs(collection(db, "trips", tripId, "personalContributions")).catch(() => ({ docs: [] }));
      const loadedContributions = contribSnap.docs.map(d => ({ userId: d.id, ...d.data() }));
      setPersonalContributions(loadedContributions);

      if (tripContext?.ownerId === user?.uid) {
        const tripSummary = getTripTotalsSummary(loadedExpenses);
        await setDoc(
          doc(db, "trips", tripId, "tripTotals", "summary"),
          { ...tripSummary, updatedAt: new Date().toISOString() },
          { merge: true }
        ).catch(error => {
          console.warn("Could not sync trip totals summary", error);
        });
        setTripTotalsSummary(tripSummary);

        const contributionByUser = new Map(loadedContributions.map(c => [c.userId, c]));
        const syncedContributions = [];
        await Promise.all(
          loadedMembers
            .filter(member => member.status !== "inactive")
            .map(async member => {
              const contributionId = member.userId || member.id;
              if (!contributionId) return;
              const summary = getMemberContributionSummary(loadedExpenses, member.id);
              const existing = contributionByUser.get(contributionId);
              const changed =
                Math.abs(Number(existing?.totalEur || 0) - summary.totalEur) > 0.001
                || Number(existing?.expenseCount || 0) !== summary.expenseCount;

              const contribution = {
                userId: contributionId,
                memberId: member.id,
                ...summary
              };
              syncedContributions.push(contribution);

              if (changed) {
                await setDoc(
                  doc(db, "trips", tripId, "personalContributions", contributionId),
                  { ...summary, memberId: member.id, updatedAt: new Date().toISOString() },
                  { merge: true }
                ).catch(error => {
                  console.warn("Could not sync member personal contribution", contributionId, error);
                });
              }
            })
        );

        setPersonalContributions(prev => {
          const next = new Map(prev.map(c => [c.userId, c]));
          syncedContributions.forEach(c => next.set(c.userId, c));
          return Array.from(next.values());
        });
      }

      // Self-migration: write current user's contribution total from existing personal expenses.
      // Absence of includeInGroupTotal field is treated as true (count toward group total).
      if (user?.uid) {
        const myContribution = getMemberContributionSummary(loadedExpenses, loadedCurrentUserMemberId);
        const existingContrib = loadedContributions.find(c => c.userId === user.uid);
        if (
          Math.abs(Number(existingContrib?.totalEur || 0) - myContribution.totalEur) > 0.001
          || Number(existingContrib?.expenseCount || 0) !== myContribution.expenseCount
        ) {
          await setDoc(
            doc(db, "trips", tripId, "personalContributions", user.uid),
            { ...myContribution, memberId: loadedCurrentUserMemberId, updatedAt: new Date().toISOString() },
            { merge: true }
          ).catch(error => {
            console.warn("Could not sync own personal contribution", error);
          });
          setPersonalContributions(prev => {
            const next = prev.filter(c => c.userId !== user.uid);
            return [...next, { userId: user.uid, memberId: loadedCurrentUserMemberId, ...myContribution }];
          });
        }
      }

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
      showToast("Could not load trip data. Check your Firestore rules.", "error");
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
      showToast("Only the trip owner can add members.", "error");
      return;
    }

    const displayName = memberForm.displayName.trim();
    const emailLower = getEmailLower(memberForm.email);
    if (!emailLower) {
      showToast("Email is required so your friend can log in and access this trip.", "error");
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
        showToast("This member already existed. Their access is active again.", "success");
      }
    } catch (error) {
      console.error("Could not add member:", error);
      showToast("Could not add member. Check your Firestore rules.", "error");
    } finally {
      setSavingMember(false);
    }
  }

  async function handleToggleMemberStatus(member) {
    if (!selectedTrip || !user) return;
    if (!canManageSelectedTrip()) {
      showToast("Only the trip owner can manage members.", "error");
      return;
    }
    if (member.isOwner) {
      showToast("The owner cannot be deactivated.", "error");
      return;
    }
    const emailLower = getEmailLower(member.email);
    if (!emailLower) {
      showToast("This member has no email, so access cannot be managed.", "error");
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
      showToast("Could not update member. Check your Firestore rules.", "error");
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
      showToast("Trip owners cannot leave their own trip. Delete the trip instead if you no longer need it.", "error");
      return;
    }

    const balanceNet = Number(currentUserBalance?.net || 0);
    if (Math.abs(balanceNet) > 0.01) {
      const direction = balanceNet < 0 ? "owe" : "are owed";
      showToast(`You cannot leave this trip yet. You still ${direction} ${formatMoney(Math.abs(balanceNet))}. Please settle up before leaving.`, "error");
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
        showToast("Could not identify your account email, so this trip access cannot be removed.", "error");
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
        showToast("Could not leave trip. Check your Firestore rules.", "error");
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
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to edit trip budgets.", "info");
    const amount = Number(budgetForm.estimatedEur);
    if (!budgetForm.categoryId) return showToast("Choose a category.", "error");
    if (!amount || amount <= 0) return showToast("Enter a budget amount above zero.", "error");
    if (!currentUserMemberId) return showToast("Could not find your trip member profile yet.", "error");
    const scope = budgetForm.scope || "group";
    const visibleMemberIds = buildBudgetVisibility(scope);
    if (scope === "selected" && visibleMemberIds.length === 0) {
      return showToast("Choose at least one person for this budget entry.", "error");
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
      showToast("Plan budget saved.", "success");
    } catch (error) {
      console.error("Could not save plan budget:", error);
      showToast("Could not save plan budget.", "error");
    } finally {
      setSavingPredictions(false);
    }
  }

  async function handleDeleteBudget(entry) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to edit trip budgets.", "info");
    if (!window.confirm(`Delete this budget entry for ${entry.categoryName || "this category"}?`)) {
      return;
    }
    try {
      await deleteDoc(doc(db, "trips", selectedTrip.id, "predictions", entry.id));
      if (editingBudgetId === entry.id) resetBudgetForm();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not delete plan budget:", error);
      showToast("Could not delete plan budget.", "error");
    }
  }

  // -------------------- Personal budget & contributions --------------------
  // Recalculates the current user's personal contribution total from the live
  // expenses array and writes a single aggregate doc visible to all trip members.
  async function recalculatePersonalContribution(updatedExpenses) {
    if (!selectedTrip || !user?.uid || isDemoMode()) return;
    const myMemberId = currentUserMemberId;
    const summary = getMemberContributionSummary(updatedExpenses, myMemberId);
    await setDoc(
      doc(db, "trips", selectedTrip.id, "personalContributions", user.uid),
      { ...summary, memberId: myMemberId, updatedAt: new Date().toISOString() },
      { merge: true }
    ).catch(error => {
      console.warn("Could not recalculate personal contribution", error);
    });
    setPersonalContributions(prev => {
      const next = prev.filter(c => c.userId !== user.uid);
      return [...next, { userId: user.uid, memberId: myMemberId, ...summary }];
    });
  }

  async function handleSavePersonalBudget() {
    if (!selectedTrip || !user?.uid || isDemoMode()) return;
    const amount = Number(personalBudgetForm.amount);
    if (!amount || amount <= 0) return showToast("Enter a valid amount.", "error");
    setSavingPersonalBudget(true);
    try {
      const currency = personalBudgetForm.currency || selectedTrip.defaultCurrency || "EUR";
      const amountEur = convertAmount(amount, currency);
      const data = { originalAmount: amount, originalCurrency: currency, amountEur, updatedAt: new Date().toISOString() };
      await setDoc(doc(db, "trips", selectedTrip.id, "personalBudgets", user.uid), data);
      setPersonalBudget(data);
      setShowPersonalBudgetForm(false);
    } catch (err) {
      console.error("Could not save personal budget:", err);
      showToast("Could not save personal budget.", "error");
    } finally {
      setSavingPersonalBudget(false);
    }
  }

  async function handleDeletePersonalBudget() {
    if (!selectedTrip || !user?.uid || isDemoMode()) return;
    if (!window.confirm("Remove your personal budget?")) return;
    try {
      await deleteDoc(doc(db, "trips", selectedTrip.id, "personalBudgets", user.uid));
      setPersonalBudget(null);
      setShowPersonalBudgetForm(false);
    } catch (err) {
      console.error("Could not remove personal budget:", err);
      showToast("Could not remove personal budget.", "error");
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
        showToast(
          `Custom split must equal the total expense amount. Expense total: ${formatCurrency(
            total,
            formData.originalCurrency
          )}, Custom split total: ${formatCurrency(customTotal, formData.originalCurrency)}`,
          "error"
        );
        return false;
      }
      if (getCustomSplitMemberIds(formData).length === 0) {
        showToast("Add at least one custom split amount.", "error");
        return false;
      }
    }
    if (formData.splitType === "percent") {
      const pctTotal = getPercentageSplitTotal(formData);
      if (Math.abs(pctTotal - 100) > 0.1) {
        showToast(`Percentages must total 100%. Current total: ${pctTotal.toFixed(1)}%`, "error");
        return false;
      }
      const hasAny = Object.values(formData.customSplitShares || {}).some(v => Number(v) > 0);
      if (!hasAny) {
        showToast("Enter a percentage for at least one person.", "error");
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
      showToast("Demo trip is read-only. Sign in with Google to create and edit your own trips.", "info");
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
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to add expenses.", "info");

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

    if (!normalizedExpenseForm.categoryId) return showToast("Choose a category.", "error");
    if (!normalizedExpenseForm.paidByMemberId) return showToast("Choose who paid.", "error");
    if (!originalAmount || originalAmount <= 0) return showToast("Enter a valid amount.", "error");
    if (!validateCustomSplit(normalizedExpenseForm)) return;

    const splitMemberIds = getCleanSplitMemberIds(normalizedExpenseForm);
    if (normalizedExpenseForm.expenseType === "shared" && splitMemberIds.length === 0) {
      return showToast("Choose at least one split member.", "error");
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
        includeInGroupTotal: expenseScope === "personal"
          ? normalizedExpenseForm.includeInGroupTotal !== false
          : true,
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
      showToast("Could not save expense.", "error");
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
      showToast("Could not undo expense.", "error");
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
        expense.customSplitSharesOriginal || expense.customSplitShares || {},
      includeInGroupTotal: expense.includeInGroupTotal !== false
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
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to edit expenses.", "info");

    const originalAmount = Number(expenseEditForm.originalAmount);
    const originalCurrency = expenseEditForm.originalCurrency || "EUR";

    if (!expenseEditForm.categoryId) return showToast("Choose a category.", "error");
    if (!expenseEditForm.paidByMemberId) return showToast("Choose who paid.", "error");
    if (!originalAmount || originalAmount <= 0) return showToast("Enter a valid amount.", "error");
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
          includeInGroupTotal: expenseScope === "personal"
            ? expenseEditForm.includeInGroupTotal !== false
            : true,
          isActive: true,
          updatedAt: serverTimestamp()
        }
      );
      cancelEditingExpense();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not update expense:", error);
      showToast("Could not update expense.", "error");
    } finally {
      setSavingExpenseEdit(false);
    }
  }

  async function handleDeleteExpense(expense) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to delete expenses.", "info");
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
      showToast("Could not delete expense.", "error");
    }
  }

  // -------------------- Tasks --------------------
  function taskTypeLabel(type) {
    return TASK_TYPE_OPTIONS.find(option => option.value === type)?.label || "General";
  }

  function taskScopeLabel(scope) {
    if (scope === "group") return "Group";
    if (scope === "selected_members") return "Shared";
    if (scope === "personal") return "Private";
    return "Task";
  }

  function formatTaskDate(date) {
    if (!date) return "";
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return date;
    return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function taskMemberListLabel(memberIds, maxNames = 2) {
    const ids = Array.from(new Set((memberIds || []).filter(Boolean)));
    if (ids.length === 0) return "Unassigned";
    const names = ids.slice(0, maxNames).map(memberNameOf);
    const extraCount = ids.length - names.length;
    return extraCount > 0 ? `${names.join(" + ")} + ${extraCount}` : names.join(" + ");
  }

  function normalizeTaskFormForSave() {
    const fallbackAssignee = currentUserMemberId || activeMembers[0]?.id || "";
    let assignedTo = taskForm.assignedTo?.length
      ? Array.from(new Set(taskForm.assignedTo))
      : fallbackAssignee
      ? [fallbackAssignee]
      : [];
    const creatorId = currentUserMemberId || fallbackAssignee;
    let scope = taskForm.scope || "group";
    let visibleTo;

    if (scope === "personal") {
      assignedTo = creatorId ? [creatorId] : assignedTo;
      visibleTo = creatorId ? [creatorId] : [];
    } else if (scope === "selected_members") {
      visibleTo = Array.from(
        new Set([...(taskForm.selectedMemberIds || []), creatorId].filter(Boolean))
      );
    } else {
      scope = "group";
      visibleTo = "all";
    }

    return {
      title: taskForm.title.trim(),
      type: taskForm.type || "general",
      scope,
      visibleTo,
      assignedTo,
      dueDate: taskForm.dueDate || null,
      notes: taskForm.notes.trim(),
      createdBy: creatorId
    };
  }

  function resetTaskForm() {
    setTaskForm({
      ...EMPTY_TASK_FORM,
      assignedTo: currentUserMemberId ? [currentUserMemberId] : [],
      selectedMemberIds: currentUserMemberId ? [currentUserMemberId] : []
    });
    setEditingTaskId(null);
  }

  function openCreateTask() {
    resetTaskForm();
    setIsTaskModalOpen(true);
  }

  function closeTaskModal() {
    setIsTaskModalOpen(false);
    setEditingTaskId(null);
    setTaskForm(EMPTY_TASK_FORM);
  }

  function openBulkTaskModal() {
    setBulkTaskRows([{ id: Date.now(), title: "", type: "general" }]);
    setIsBulkTaskModalOpen(true);
  }

  function closeBulkTaskModal() {
    setIsBulkTaskModalOpen(false);
    setBulkTaskRows([{ id: Date.now(), title: "", type: "general" }]);
  }

  async function handleSaveBulkTasks(e) {
    e.preventDefault();
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to manage tasks.", "info");
    const creatorId = currentUserMemberId;
    if (!creatorId) return showToast("Could not find your trip member profile yet.", "error");
    const validRows = bulkTaskRows.filter(r => r.title.trim().length > 0);
    if (validRows.length === 0) return showToast("Add at least one task title.", "error");
    setSavingBulkTasks(true);
    try {
      const batch = writeBatch(db);
      validRows.forEach(row => {
        const ref = doc(collection(db, "trips", selectedTrip.id, "tasks"));
        batch.set(ref, {
          tripId: selectedTrip.id,
          title: row.title.trim(),
          type: row.type || "general",
          scope: "personal",
          visibleTo: [creatorId],
          assignedTo: [creatorId],
          dueDate: null,
          notes: "",
          status: "todo",
          completedBy: null,
          completedAt: null,
          isActive: true,
          createdBy: creatorId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
      closeBulkTaskModal();
      await loadTripData(selectedTrip.id);
    } catch (err) {
      console.error("Could not save tasks:", err);
      showToast("Could not save tasks. Check your Firestore rules.", "error");
    } finally {
      setSavingBulkTasks(false);
    }
  }

  async function handleBulkAssign() {
    if (!selectedTrip || selectedTaskIds.size === 0) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to manage tasks.", "info");
    const creatorId = currentUserMemberId;
    let assignedTo, scope, visibleTo;
    if (bulkAssignMode === "group") {
      scope = "group";
      visibleTo = "all";
      assignedTo = activeMembers.map(m => m.id);
    } else {
      const memberIds = Array.from(new Set([...bulkAssignMemberIds, creatorId].filter(Boolean)));
      if (memberIds.length === 0) return showToast("Select at least one member.", "error");
      scope = "selected_members";
      visibleTo = memberIds;
      assignedTo = memberIds;
    }
    setSavingBulkAssign(true);
    try {
      const batch = writeBatch(db);
      [...selectedTaskIds].forEach(taskId => {
        const ref = doc(db, "trips", selectedTrip.id, "tasks", taskId);
        batch.update(ref, { scope, visibleTo, assignedTo, updatedAt: serverTimestamp() });
      });
      await batch.commit();
      setSelectedTaskIds(new Set());
      setIsBulkAssignOpen(false);
      setBulkAssignMode("group");
      setBulkAssignMemberIds([]);
      await loadTripData(selectedTrip.id);
    } catch (err) {
      console.error("Could not assign tasks:", err);
      showToast("Could not assign tasks.", "error");
    } finally {
      setSavingBulkAssign(false);
    }
  }

  function startEditingTask(task) {
    if (!canUserEditTask(task, currentUserMemberId, canManageSelectedTrip())) return;
    setEditingTaskId(task.id);
    setTaskForm({
      title: task.title || "",
      type: task.type || "general",
      scope: task.scope || "group",
      assignedTo: Array.isArray(task.assignedTo) ? task.assignedTo : [],
      selectedMemberIds: Array.isArray(task.visibleTo) ? task.visibleTo : [],
      dueDate: task.dueDate || "",
      notes: task.notes || ""
    });
    setIsTaskModalOpen(true);
  }

  async function handleSaveTask(event) {
    event.preventDefault();
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to manage tasks.", "info");
    const normalized = normalizeTaskFormForSave();
    if (!normalized.title) return showToast("Task title is required.", "error");
    if (!normalized.createdBy) return showToast("Could not find your trip member profile yet.", "error");
    if (!normalized.assignedTo.length) return showToast("Assign this task to at least one member.", "error");
    if (
      normalized.scope === "selected_members"
      && (!Array.isArray(normalized.visibleTo) || normalized.visibleTo.length === 0)
    ) {
      return showToast("Choose at least one person who can see this task.", "error");
    }

    setSavingTask(true);
    try {
      if (editingTaskId) {
        const task = tasks.find(t => t.id === editingTaskId);
        if (!canUserEditTask(task, currentUserMemberId, canManageSelectedTrip())) {
          showToast("Only the task creator can edit this task.", "error");
          return;
        }
        await updateDoc(doc(db, "trips", selectedTrip.id, "tasks", editingTaskId), {
          ...normalized,
          updatedAt: serverTimestamp()
        });
      } else {
        await addDoc(collection(db, "trips", selectedTrip.id, "tasks"), {
          tripId: selectedTrip.id,
          ...normalized,
          status: "todo",
          completedBy: null,
          completedAt: null,
          isActive: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      closeTaskModal();
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not save task:", error);
      showToast("Could not save task. Check your Firestore rules.", "error");
    } finally {
      setSavingTask(false);
    }
  }

  async function handleMarkTaskDone(task) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to update tasks.", "info");
    if (!canUserCompleteTask(task, currentUserMemberId)) {
      showToast("Only assigned members or the creator can complete this task.", "error");
      return;
    }
    try {
      await updateDoc(doc(db, "trips", selectedTrip.id, "tasks", task.id), {
        status: "done",
        completedBy: currentUserMemberId,
        completedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not complete task:", error);
      showToast("Could not mark task done.", "error");
    }
  }

  async function handleReopenTask(task) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to update tasks.", "info");
    if (!canUserCompleteTask(task, currentUserMemberId)) {
      showToast("Only assigned members or the creator can reopen this task.", "error");
      return;
    }
    try {
      await updateDoc(doc(db, "trips", selectedTrip.id, "tasks", task.id), {
        status: "todo",
        completedBy: null,
        completedAt: null,
        updatedAt: serverTimestamp()
      });
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not reopen task:", error);
      showToast("Could not reopen task.", "error");
    }
  }

  async function handleArchiveTask(task) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to archive tasks.", "info");
    if (!canUserEditTask(task, currentUserMemberId, canManageSelectedTrip())) {
      showToast("Only the task creator can archive this task.", "error");
      return;
    }
    if (!window.confirm(`Archive "${task.title}"?`)) return;
    try {
      await updateDoc(doc(db, "trips", selectedTrip.id, "tasks", task.id), {
        isActive: false,
        updatedAt: serverTimestamp()
      });
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not archive task:", error);
      showToast("Could not archive task.", "error");
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

  // ── Beta welcome modal ──────────────────────────────────────────
  function renderBetaWelcome() {
    if (!showBetaWelcome || !user) return null;
    function dismiss() {
      try { localStorage.setItem('thBetaWelcomeSeen', '1'); } catch {}
      setShowBetaWelcome(false);
    }
    const features = [
      { icon: '💰', title: 'Plan Budget',       sub: 'Set category budgets before you travel' },
      { icon: '💳', title: 'Track Expenses',    sub: 'Log every spend, split by person or group' },
      { icon: '🤝', title: 'Smart Settle',      sub: 'See who owes whom and settle in one tap' },
      { icon: '✅', title: 'Trip Tasks',         sub: 'Assign and track todos before and during the trip' },
      { icon: '👥', title: 'Group & Members',   sub: 'Invite travel mates, manage access and roles' },
      { icon: '📊', title: 'Spending Insights', sub: 'Visual breakdown by category' },
    ];
    return (
      <div className="beta-welcome-overlay" role="dialog" aria-modal="true" aria-label="Welcome to TripHisaab Beta">
        <div className="beta-welcome-card">
          <div className="beta-welcome-header">
            <span className="beta-welcome-badge">Beta</span>
            <h2>Welcome to TripHisaab 🌍</h2>
            <p>You're one of the first people to try this. Here's what to explore:</p>
          </div>
          <ul className="beta-feature-list">
            {features.map(f => (
              <li key={f.title} className="beta-feature-item">
                <span className="beta-feature-icon">{f.icon}</span>
                <div>
                  <strong>{f.title}</strong>
                  <span>{f.sub}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="beta-welcome-tip">
            Found a bug or have ideas? Tap the <strong>💬</strong> button anytime to share feedback.
          </p>
          <button className="primary-button beta-welcome-cta" type="button" onClick={dismiss}>
            Start exploring →
          </button>
        </div>
      </div>
    );
  }

  // ── Feedback widget ──────────────────────────────────────────────
  function renderFeedbackWidget(hasExpenseFab = false) {
    if (!user) return null;
    const screenLabel = selectedTrip
      ? ({ dashboard: 'Trip Overview', prediction: 'Plan Budget', actual: 'Expenses', settlements: 'Settle', tasks: 'Tasks', categories: 'Categories', members: 'Members', settings: 'Settings' }[activeTab] || activeTab)
      : 'Your Trips';
    function buildMailto() {
      const stars = '★'.repeat(feedbackRating) + '☆'.repeat(5 - feedbackRating);
      const subject = `TripHisaab Feedback — ${screenLabel}${feedbackRating ? ` [${stars}]` : ''}`;
      const body = [
        `Screen: ${screenLabel}`,
        feedbackRating ? `Rating: ${stars} (${feedbackRating}/5)` : 'Rating: not given',
        '',
        "What's working well:",
        feedbackWorking.trim() || '(not filled)',
        '',
        'Bugs / what could be better:',
        feedbackBroken.trim() || '(not filled)',
        '',
        'Suggestions:',
        feedbackSuggestion.trim() || '(not filled)',
        '',
        '---',
        'Sent from TripHisaab in-app feedback',
      ].join('\n');
      return `mailto:wayabove@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }
    function sendFeedback() {
      window.location.href = buildMailto();
      setFeedbackOpen(false);
      setFeedbackRating(0);
      setFeedbackWorking('');
      setFeedbackBroken('');
      setFeedbackSuggestion('');
    }
    return (
      <div className={`feedback-widget${feedbackOpen ? ' feedback-widget--open' : ''}${hasExpenseFab ? ' feedback-widget--above-fab' : ''}`}>
        {feedbackOpen && (
          <div className="feedback-panel" role="dialog" aria-label="Share feedback">
            <div className="feedback-panel-header">
              <div className="feedback-panel-title">
                <span>Share feedback</span>
                <span className="feedback-screen-tag">{screenLabel}</span>
              </div>
              <button className="feedback-close-btn" type="button" aria-label="Close" onClick={() => setFeedbackOpen(false)}>✕</button>
            </div>
            <div className="feedback-rating-row">
              <span className="feedback-field-label">Overall rating</span>
              <div className="feedback-stars">
                {[1,2,3,4,5].map(n => (
                  <button
                    key={n}
                    type="button"
                    className={`feedback-star${feedbackRating >= n ? ' feedback-star--on' : ''}`}
                    aria-label={`${n} star`}
                    onClick={() => setFeedbackRating(feedbackRating === n ? 0 : n)}
                  >★</button>
                ))}
              </div>
            </div>
            <div className="feedback-fields">
              <label className="feedback-field-label">
                What's working well?
                <textarea value={feedbackWorking} onChange={e => setFeedbackWorking(e.target.value)} placeholder="Anything you like so far…" rows={2} />
              </label>
              <label className="feedback-field-label">
                Bugs / what could be better?
                <textarea value={feedbackBroken} onChange={e => setFeedbackBroken(e.target.value)} placeholder="Something broken or confusing…" rows={2} />
              </label>
              <label className="feedback-field-label">
                Suggestions
                <textarea value={feedbackSuggestion} onChange={e => setFeedbackSuggestion(e.target.value)} placeholder="Feature ideas, improvements…" rows={2} />
              </label>
            </div>
            <button className="primary-button feedback-send-btn" type="button" onClick={sendFeedback}>
              Send via email ✉️
            </button>
          </div>
        )}
        <button
          className="feedback-fab"
          type="button"
          aria-label="Give feedback"
          aria-expanded={feedbackOpen}
          onClick={() => setFeedbackOpen(v => !v)}
        >
          <span className="feedback-fab-icon">💬</span>
          <span className="feedback-fab-label">Feedback</span>
        </button>
      </div>
    );
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
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to edit categories.", "info");
    if (!categoryForm.name.trim()) {
      showToast("Category name is required.", "error");
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
      showToast("Could not save category. Check your Firestore rules.", "error");
    } finally {
      setSavingCategory(false);
    }
  }

  async function handleToggleCategory(category) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to edit categories.", "info");
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
      showToast("Could not update category status.", "error");
    }
  }

  async function handleDeleteCategory(category) {
    if (!selectedTrip) return;
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to edit categories.", "info");
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
      showToast("Could not delete category.", "error");
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
    setPendingSettleAmount(String(suggested.amount || ""));
    setPendingSettleActualPayer(suggested.fromMemberId || suggested.fromUserId || "");
  }

  async function handleMarkSmartSettlementPaid(suggested, settlementLayer = "group", settlementGroupId = null, customAmount = null, actualFromMemberId = null) {
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to record settlements.", "info");
    if (!selectedTrip || !user) return;
    const amount = customAmount != null ? Number(customAmount) : Number(suggested.amount || 0);
    if (!amount || amount <= 0) return showToast("Enter a valid amount.", "error");
    const fromMemberId = actualFromMemberId || suggested.fromMemberId || suggested.fromUserId;
    setSavingSettlement(true);
    try {
      await createCompletedSettlement(
        {
          date: todayIso(),
          fromMemberId,
          toMemberId: suggested.toMemberId || suggested.toUserId,
          amountEur: amount,
          notes: customAmount && Number(customAmount) !== Number(suggested.amount)
            ? `Partial payment (suggested ${formatMoney(suggested.amount)})`
            : "Marked as paid from Smart Settle"
        },
        amount,
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
      showToast("Could not mark this settlement as paid.", "error");
    } finally {
      setSavingSettlement(false);
    }
  }

  async function saveSettlement(data) {
    if (isDemoMode()) return showToast("Demo trip is read-only. Sign in to record settlements.", "info");
    if (!selectedTrip || !user) return;
    const amount = Number(data.amountEur);
    if (!data.fromMemberId || !data.toMemberId) return showToast("Choose both people.", "error");
    if (data.fromMemberId === data.toMemberId) {
      return showToast("Payer and receiver cannot be the same person.", "error");
    }
    if (!amount || amount <= 0) return showToast("Enter a valid settlement amount.", "error");

    setSavingSettlement(true);
    try {
      const isDebtorRecording = currentUserMemberId === data.fromMemberId;
      const isCreditorRecording = currentUserMemberId === data.toMemberId;

      if (isDebtorRecording && !data.skipApprovalRequest) {
        await createSettlementApprovalNotification(data, amount);
        showToast("Settlement sent for approval.", "success");
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
          showToast("Could not send approval notification, so the settlement was recorded directly.", "error");
          return true;
        } catch (fallbackError) {
          console.error("Could not record fallback settlement:", fallbackError);
        }
      }
      showToast("Could not settle up.", "error");
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
      showToast("Could not approve settlement.", "error");
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
      showToast("Could not delete settlement.", "error");
    }
  }

  async function copySmartSettleSummary() {
    const modeLabels = {
      fewest_payments: "Fewest payments",
      familiar_only: "Familiar payments only",
      family_couple: "Family / couple settle"
    };
    const lines = ["TripHisaab Smart Settle Summary", `Mode: ${modeLabels[settlementMode] || settlementMode}`, ""];
    const consolSuggestions = smartSettleSummary.consolidatedSuggestions || [];
    const groupSuggestions = smartSettleSummary.groupSettlement.suggestions;
    const privateGroups = smartSettleSummary.privateSettlements.filter(
      group => group.suggestions.length > 0
    );
    const totalPending = roundMoney(
      consolSuggestions.reduce((sum, s) => sum + Number(s.amount || 0), 0)
    );

    lines.push("Final Settlement (what to pay):");
    if (consolSuggestions.length === 0) {
      lines.push("All settled up — no payments needed.");
    } else {
      consolSuggestions.forEach((s, i) => {
        lines.push(`${i + 1}. ${cleanDisplayName(s.fromName)} pays ${cleanDisplayName(s.toName)} ${formatMoney(s.amount)}`);
      });
    }
    lines.push("", `Total: ${formatMoney(totalPending)}`, "", "--- Details ---", "", "Group settlement:");
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
      showToast("Could not copy to clipboard. Check browser permissions.", "error");
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
  async function exportTripSummaryCsv() {
    if (!selectedTrip) return;
    const XLSX = (await import("xlsx-js-style")).default;
    const cur = selectedTrip.defaultCurrency || "EUR";

    // ── Colour palette (brand teal) ──────────────────────────────
    const C = {
      teal:       "0F766E",
      tealMid:    "CCEBE8",
      tealLight:  "E6F4F2",
      white:      "FFFFFF",
      text:       "0F172A",
      muted:      "64748B",
      green:      "16A34A",
      greenLight: "F0FDF4",
      red:        "DC2626",
      redLight:   "FEF2F2",
      amber:      "D97706",
      amberLight: "FFFBEB",
      grey:       "F8FAFC",
      border:     "E2E8F0",
    };

    // ── Style presets ────────────────────────────────────────────
    const border = side => ({ style: "thin", color: { rgb: C.border } });
    const allBorders = { top: border(), bottom: border(), left: border(), right: border() };

    const S = {
      hdr: (right = false) => ({
        font: { bold: true, color: { rgb: C.white }, sz: 11, name: "Calibri" },
        fill: { fgColor: { rgb: C.teal } },
        alignment: { horizontal: right ? "right" : "left", vertical: "center" },
        border: allBorders,
      }),
      secHdr: () => ({
        font: { bold: true, color: { rgb: C.teal }, sz: 12, name: "Calibri" },
        fill: { fgColor: { rgb: C.tealLight } },
        border: allBorders,
      }),
      unitHdr: () => ({
        font: { bold: true, color: { rgb: C.teal }, name: "Calibri" },
        fill: { fgColor: { rgb: C.tealMid } },
        border: allBorders,
      }),
      confid: () => ({
        font: { bold: true, color: { rgb: C.white }, name: "Calibri" },
        fill: { fgColor: { rgb: C.red } },
        alignment: { horizontal: "center" },
      }),
      label: (alt = false) => ({
        font: { bold: true, color: { rgb: C.text }, name: "Calibri" },
        fill: alt ? { fgColor: { rgb: C.grey } } : undefined,
        border: allBorders,
      }),
      val: (alt = false) => ({
        font: { color: { rgb: C.text }, name: "Calibri" },
        fill: alt ? { fgColor: { rgb: C.grey } } : undefined,
        border: allBorders,
      }),
      num: (alt = false) => ({
        font: { color: { rgb: C.text }, name: "Calibri" },
        fill: alt ? { fgColor: { rgb: C.grey } } : undefined,
        numFmt: "#,##0.00",
        alignment: { horizontal: "right" },
        border: allBorders,
      }),
      numBold: () => ({
        font: { bold: true, color: { rgb: C.text }, name: "Calibri" },
        numFmt: "#,##0.00",
        alignment: { horizontal: "right" },
        border: allBorders,
      }),
      pos: (alt = false) => ({
        font: { bold: true, color: { rgb: C.green }, name: "Calibri" },
        fill: alt ? { fgColor: { rgb: C.grey } } : undefined,
        numFmt: "#,##0.00",
        alignment: { horizontal: "right" },
        border: allBorders,
      }),
      neg: (alt = false) => ({
        font: { bold: true, color: { rgb: C.red }, name: "Calibri" },
        fill: alt ? { fgColor: { rgb: C.grey } } : undefined,
        numFmt: "#,##0.00",
        alignment: { horizontal: "right" },
        border: allBorders,
      }),
      paidBg: () => ({
        font: { color: { rgb: C.green }, name: "Calibri" },
        fill: { fgColor: { rgb: C.greenLight } },
        alignment: { horizontal: "center" },
        border: allBorders,
      }),
      pendingBg: () => ({
        font: { color: { rgb: C.amber }, name: "Calibri" },
        fill: { fgColor: { rgb: C.amberLight } },
        alignment: { horizontal: "center" },
        border: allBorders,
      }),
      doneBg: () => ({
        font: { color: { rgb: C.green }, name: "Calibri" },
        fill: { fgColor: { rgb: C.greenLight } },
        border: allBorders,
      }),
      pct: (alt = false) => ({
        font: { color: { rgb: C.muted }, name: "Calibri" },
        fill: alt ? { fgColor: { rgb: C.grey } } : undefined,
        alignment: { horizontal: "right" },
        border: allBorders,
      }),
    };

    // ── Cell builder helpers ─────────────────────────────────────
    const cs = (v, s) => ({ v: v ?? "", t: "s", s });
    const cn = (v, s) => ({ v: Number(v) || 0, t: "n", s });
    const empty = () => ({ v: "", t: "s", s: {} });

    // ── Sheet builder ────────────────────────────────────────────
    function makeSheet(rows, colWidths, freezeRow = 0, autoFilterRef = null, merges = []) {
      const ws = {};
      let maxCol = 0;
      rows.forEach((row, r) => {
        (row || []).forEach((cell, c) => {
          if (c > maxCol) maxCol = c;
          const addr = XLSX.utils.encode_cell({ r, c });
          ws[addr] = (cell && typeof cell === "object" && "v" in cell)
            ? cell
            : { v: cell ?? "", t: "s" };
        });
      });
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows.length - 1), c: maxCol } });
      if (colWidths?.length) ws["!cols"] = colWidths.map(w => ({ wch: w }));
      if (freezeRow > 0) ws["!freeze"] = { xSplit: 0, ySplit: freezeRow };
      if (autoFilterRef) ws["!autofilter"] = { ref: autoFilterRef };
      if (merges.length) ws["!merges"] = merges;
      return ws;
    }

    // ── Dynamic flags ────────────────────────────────────────────
    const hasBudget       = totals.predicted > 0;
    const activeTasks     = tasks.filter(t => t.isActive !== false);
    const hasTasks        = activeTasks.length > 0;
    const hasMultiCurrency = expenses.some(e => e.originalCurrency && e.originalCurrency !== cur);
    const activeGroups    = settlementGroups.filter(g => g.isActive !== false);
    const hasFamilyGroups = activeGroups.length > 0;
    const activeExpenses  = expenses.filter(e => e.isActive !== false);
    const exportedAt      = new Date().toLocaleString();

    // Trip duration helper
    const tripStart = selectedTrip.startDate ? new Date(selectedTrip.startDate) : null;
    const tripEnd   = selectedTrip.endDate   ? new Date(selectedTrip.endDate)   : null;
    const today     = new Date(); today.setHours(0, 0, 0, 0);
    let daysElapsed = 0;
    if (tripStart) {
      const endForCalc = tripEnd && tripEnd < today ? tripEnd : today;
      daysElapsed = Math.max(1, Math.round((endForCalc - tripStart) / 86400000) + 1);
    }
    const tripDays = tripStart && tripEnd
      ? Math.max(1, Math.round((tripEnd - tripStart) / 86400000) + 1)
      : 0;

    const wb = XLSX.utils.book_new();
    const NUM_SUMMARY_COLS = 2; // for merge calculation

    // ════════════════════════════════════════════════════════════
    // SHEET 1: SUMMARY
    // ════════════════════════════════════════════════════════════
    {
      const confText = `CONFIDENTIAL – ${selectedTrip.name} financial export – Handle with care – Do not share outside the trip group`;
      const rows = [
        [cs(confText, S.confid()), cs("", S.confid())],
        [],
        [cs("TRIP OVERVIEW", S.secHdr()), cs("", S.secHdr())],
        [cs("Trip name",    S.label()),  cs(selectedTrip.name || "",           S.val())],
        [cs("Description",  S.label(true)), cs(selectedTrip.description || "", S.val(true))],
        [cs("Start date",   S.label()),  cs(selectedTrip.startDate || "",      S.val())],
        [cs("End date",     S.label(true)), cs(selectedTrip.endDate || "",     S.val(true))],
        [cs("Duration",     S.label()),  cs(tripDays ? `${tripDays} day${tripDays !== 1 ? "s" : ""}` : "", S.val())],
        [cs("Currency",     S.label(true)), cs(cur, S.val(true))],
        [cs("Members",      S.label()),  cs(activeMembers.map(m => m.name || m.email || m.id).join(", "), S.val())],
        [cs("Total expenses", S.label(true)), cs(String(activeExpenses.length), S.val(true))],
        [cs("Exported at",  S.label()),  cs(exportedAt, S.val())],
        [],
        [cs("FINANCIAL OVERVIEW", S.secHdr()), cs("", S.secHdr())],
        [cs("Metric", S.hdr()), cs(`Amount (${cur})`, S.hdr(true))],
        [cs("Trip total (shared + included personal)", S.label()), cn(totals.actual, S.numBold())],
        [cs("Shared expenses",  S.label(true)), cn(totals.shared,                  S.num(true))],
        [cs("Personal expenses (included)", S.label()), cn(totals.actual - totals.shared, S.num())],
        ...(daysElapsed > 0 && totals.actual > 0
          ? [[cs("Average spend per day", S.label(true)), cn(roundMoney(totals.actual / daysElapsed), S.num(true))]]
          : []),
        [cs("Already settled", S.label()), cn(totals.settled, S.num())],
        ...(hasBudget ? [
          [cs("Planned budget", S.label(true)), cn(totals.predicted, S.num(true))],
          [cs(totals.predicted >= totals.actual ? "Under budget by" : "Over budget by", S.label()),
           cn(Math.abs(totals.predicted - totals.actual),
              totals.predicted >= totals.actual ? S.pos() : S.neg())],
        ] : []),
      ];
      const ws = makeSheet(rows, [38, 22], 0, null,
        [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }] // merge confidential row
      );
      XLSX.utils.book_append_sheet(wb, ws, "Summary");
    }

    // ════════════════════════════════════════════════════════════
    // SHEET 2: MEMBERS
    // ════════════════════════════════════════════════════════════
    {
      const memberSpendingMap = new Map(
        balances.map(b => {
          const personalPaid = roundMoney(
            activeExpenses
              .filter(e => e.expenseType !== "shared" && e.paidByMemberId === b.memberId)
              .reduce((s, e) => s + Number(e.amountEur || 0), 0)
          );
          return [b.memberId, { ...b, personalPaid, totalPaid: roundMoney(b.paid + personalPaid) }];
        })
      );

      const hdrRow = [
        cs("Member",                    S.hdr()),
        cs(`Total paid (${cur})`,       S.hdr(true)),
        cs(`Group paid (${cur})`,       S.hdr(true)),
        cs(`Personal paid (${cur})`,    S.hdr(true)),
        cs(`Net balance (${cur})`,      S.hdr(true)),
        cs("Status",                    S.hdr()),
      ];

      const memberRow = (m, alt) => {
        const netPos = m.net >= MONEY_EPSILON;
        const netNeg = m.net <= -MONEY_EPSILON;
        return [
          cs(m.name, S.label(alt)),
          cn(m.totalPaid, S.num(alt)),
          cn(m.paid,      S.num(alt)),
          cn(m.personalPaid, S.num(alt)),
          cn(Math.abs(m.net), netPos ? S.pos(alt) : netNeg ? S.neg(alt) : S.num(alt)),
          cs(netPos ? `Owed ${cur} ${m.net.toFixed(2)}` : netNeg ? `Owes ${cur} ${(-m.net).toFixed(2)}` : "Settled",
             netPos ? S.paidBg() : netNeg ? S.pendingBg() : S.val(alt)),
        ];
      };

      const rows = [[cs("Member spending — who paid what and what they owe / are owed", S.secHdr()),
                     ...Array(5).fill(cs("", S.secHdr()))]];

      if (hasFamilyGroups) {
        activeGroups.forEach((group, gi) => {
          rows.push([]);
          rows.push([cs(`Unit: ${group.name || "Group"}`, S.unitHdr()), ...Array(5).fill(cs("", S.unitHdr()))]);
          rows.push(hdrRow);
          let ri = 0;
          group.memberIds.forEach(id => {
            const m = memberSpendingMap.get(id);
            if (m) { rows.push(memberRow(m, ri % 2 === 1)); ri++; }
          });
          const unitMs = group.memberIds.map(id => memberSpendingMap.get(id)).filter(Boolean);
          const unitTotal = roundMoney(unitMs.reduce((s, m) => s + m.totalPaid, 0));
          const unitNet   = roundMoney(unitMs.reduce((s, m) => s + m.net, 0));
          const unitPos = unitNet >= MONEY_EPSILON;
          const unitNeg = unitNet <= -MONEY_EPSILON;
          rows.push([
            cs("Unit total", S.label()),
            cn(unitTotal, S.numBold()),
            cs("", S.val()), cs("", S.val()),
            cn(Math.abs(unitNet), unitPos ? S.pos() : unitNeg ? S.neg() : S.numBold()),
            cs(unitPos ? `Owed ${cur} ${unitNet.toFixed(2)}` : unitNeg ? `Owes ${cur} ${(-unitNet).toFixed(2)}` : "Settled",
               unitPos ? S.paidBg() : unitNeg ? S.pendingBg() : S.val()),
          ]);
        });

        const groupedIds = new Set(activeGroups.flatMap(g => g.memberIds));
        const ungrouped = balances.filter(b => !groupedIds.has(b.memberId));
        if (ungrouped.length > 0) {
          rows.push([]);
          rows.push([cs("Individual members", S.unitHdr()), ...Array(5).fill(cs("", S.unitHdr()))]);
          rows.push(hdrRow);
          ungrouped.forEach((b, i) => {
            const m = memberSpendingMap.get(b.memberId) || { ...b, personalPaid: 0, totalPaid: b.paid };
            rows.push(memberRow(m, i % 2 === 1));
          });
        }
      } else {
        rows.push([]);
        rows.push(hdrRow);
        balances.forEach((b, i) => {
          const m = memberSpendingMap.get(b.memberId) || { ...b, personalPaid: 0, totalPaid: b.paid };
          rows.push(memberRow(m, i % 2 === 1));
        });
      }

      const ws = makeSheet(rows, [24, 16, 16, 16, 16, 24], 0, null,
        [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }]
      );
      XLSX.utils.book_append_sheet(wb, ws, "Members");
    }

    // ════════════════════════════════════════════════════════════
    // SHEET 3: EXPENSES
    // ════════════════════════════════════════════════════════════
    {
      const expHdrs = [
        cs("Date",         S.hdr()),
        cs("Description",  S.hdr()),
        cs("Category",     S.hdr()),
        cs("Type",         S.hdr()),
        cs("Paid by",      S.hdr()),
        cs(`Amount (${cur})`, S.hdr(true)),
      ];
      if (hasMultiCurrency) {
        expHdrs.push(cs("Orig. amount", S.hdr(true)));
        expHdrs.push(cs("Orig. currency", S.hdr()));
      }
      expHdrs.push(cs("Split among", S.hdr()), cs("Notes", S.hdr()));

      const colW = [12, 30, 16, 10, 16, 13];
      if (hasMultiCurrency) colW.push(13, 10);
      colW.push(30, 25);

      const dataRows = activeExpenses.map((e, i) => {
        const alt = i % 2 === 1;
        const isOwn = e.paidByMemberId === currentUserMemberId;
        const isShared = e.expenseType === "shared";
        // Privacy: redact other members' personal expense details
        const desc = isShared || isOwn ? (e.description || "") : "Personal expense";
        const notes = isShared || isOwn ? (e.notes || "") : "";

        const splitAmong = isShared && e.splitType === "custom"
          ? Object.entries(e.customSplitSharesEur || {})
              .map(([id, amt]) => `${memberNameOf(id)}: ${Number(amt).toFixed(2)}`)
              .join(", ")
          : isShared
          ? (e.splitMemberIds || []).map(memberNameOf).join(", ")
          : memberNameOf(e.paidByMemberId);

        const row = [
          cs(e.date || "",                                         S.val(alt)),
          cs(desc,                                                 S.val(alt)),
          cs(e.categoryName || "",                                 S.val(alt)),
          cs(isShared ? "Shared" : "Personal",                    S.val(alt)),
          cs(memberNameOf(e.paidByMemberId),                      S.val(alt)),
          cn(Number(e.amountEur || 0),                            S.num(alt)),
        ];
        if (hasMultiCurrency) {
          const hasFx = e.originalCurrency && e.originalCurrency !== cur;
          row.push(
            hasFx ? cn(Number(e.originalAmount || e.amountEur || 0), S.num(alt)) : cs("", S.val(alt)),
            hasFx ? cs(e.originalCurrency, S.val(alt)) : cs("", S.val(alt)),
          );
        }
        row.push(cs(splitAmong, S.val(alt)), cs(notes, S.val(alt)));
        return row;
      });

      const autoRef = `A1:${XLSX.utils.encode_col(expHdrs.length - 1)}1`;
      const ws = makeSheet([expHdrs, ...dataRows], colW, 1, autoRef);
      XLSX.utils.book_append_sheet(wb, ws, "Expenses");
    }

    // ════════════════════════════════════════════════════════════
    // SHEET 4: CATEGORIES
    // ════════════════════════════════════════════════════════════
    {
      const catHdrs = [
        cs("Category",        S.hdr()),
        cs(`Spent (${cur})`,  S.hdr(true)),
        cs("% of total",      S.hdr(true)),
      ];
      const colW = [22, 15, 10];
      if (hasBudget) {
        catHdrs.push(cs(`Budgeted (${cur})`, S.hdr(true)));
        catHdrs.push(cs(`Difference (${cur})`, S.hdr(true)));
        colW.push(15, 15);
      }

      const breakdown = categories
        .map(c => ({ name: c.name, actual: actualByCategoryId.get(c.id) || 0, predicted: Number(groupBudgetByCategoryId.get(c.id) || 0) }))
        .filter(c => c.actual > 0)
        .sort((a, b) => b.actual - a.actual);

      const dataRows = breakdown.map((c, i) => {
        const alt = i % 2 === 1;
        const pctVal = totals.actual > 0 ? `${Math.round((c.actual / totals.actual) * 100)}%` : "0%";
        const row = [
          cs(c.name, S.label(alt)),
          cn(c.actual, S.num(alt)),
          cs(pctVal, S.pct(alt)),
        ];
        if (hasBudget) {
          const diff = c.predicted - c.actual;
          row.push(cn(c.predicted, S.num(alt)));
          row.push(cn(diff, diff >= 0 ? S.pos(alt) : S.neg(alt)));
        }
        return row;
      });

      // Totals row
      const totRow = [cs("TOTAL", S.label()), cn(totals.actual, S.numBold()), cs("100%", S.pct())];
      if (hasBudget) {
        const totalDiff = totals.predicted - totals.actual;
        totRow.push(cn(totals.predicted, S.numBold()));
        totRow.push(cn(totalDiff, totalDiff >= 0 ? S.pos() : S.neg()));
      }

      const ws = makeSheet([catHdrs, ...dataRows, totRow], colW, 1);
      XLSX.utils.book_append_sheet(wb, ws, "Categories");
    }

    // ════════════════════════════════════════════════════════════
    // SHEET 5: SETTLEMENTS
    // ════════════════════════════════════════════════════════════
    {
      const rows = [];
      const allGroupSugg   = smartSettleSummary.groupSettlement.suggestions || [];
      const allPrivateSugg = smartSettleSummary.privateSettlements || [];
      const allSettled = allGroupSugg.length === 0 && allPrivateSugg.every(g => g.suggestions.length === 0);

      rows.push([cs("SETTLEMENT PLAN", S.secHdr()), ...Array(3).fill(cs("", S.secHdr()))]);
      rows.push([]);

      if (allSettled) {
        rows.push([cs("All members are settled — no payments needed", S.paidBg()), cs("", S.paidBg()), cs("", S.paidBg()), cs("", S.paidBg())]);
      } else {
        const planHdr = [cs("From", S.hdr()), cs("To", S.hdr()), cs(`Amount (${cur})`, S.hdr(true)), cs("Status", S.hdr())];
        if (allGroupSugg.length > 0) {
          rows.push([cs("Group settlements", S.unitHdr()), ...Array(3).fill(cs("", S.unitHdr()))]);
          rows.push(planHdr);
          allGroupSugg.forEach((s, i) => {
            rows.push([
              cs(s.fromName, S.val(i % 2 === 1)),
              cs(s.toName,   S.val(i % 2 === 1)),
              cn(s.amount,   S.num(i % 2 === 1)),
              cs(s.status || "pending", s.status === "paid" ? S.paidBg() : S.pendingBg()),
            ]);
          });
          rows.push([]);
        }
        allPrivateSugg.forEach(group => {
          if (!group.suggestions.length) return;
          rows.push([cs(`Private: ${group.memberNames.join(" & ")}`, S.unitHdr()), ...Array(3).fill(cs("", S.unitHdr()))]);
          rows.push(planHdr);
          group.suggestions.forEach((s, i) => {
            rows.push([
              cs(s.fromName, S.val(i % 2 === 1)),
              cs(s.toName,   S.val(i % 2 === 1)),
              cn(s.amount,   S.num(i % 2 === 1)),
              cs(s.status || "pending", s.status === "paid" ? S.paidBg() : S.pendingBg()),
            ]);
          });
          rows.push([]);
        });
      }

      if (settlements.length > 0) {
        rows.push([]);
        rows.push([cs("PAYMENT HISTORY", S.secHdr()), ...Array(5).fill(cs("", S.secHdr()))]);
        rows.push([]);
        const histHdr = [
          cs("Date",   S.hdr()), cs("From", S.hdr()), cs("To", S.hdr()),
          cs(`Amount (${cur})`, S.hdr(true)), cs("Status", S.hdr()), cs("Notes", S.hdr()),
        ];
        rows.push(histHdr);
        settlements.forEach((s, i) => {
          const alt = i % 2 === 1;
          const isPaid = (s.status || "paid") === "paid";
          rows.push([
            cs(s.date || s.paidAt?.toDate?.()?.toLocaleDateString?.() || "", S.val(alt)),
            cs(s.fromMemberName || memberNameOf(s.fromMemberId), S.val(alt)),
            cs(s.toMemberName   || memberNameOf(s.toMemberId),   S.val(alt)),
            cn(Number(s.amountEur || 0), S.num(alt)),
            cs(s.status || "paid", isPaid ? S.paidBg() : S.pendingBg()),
            cs(s.notes || "", S.val(alt)),
          ]);
        });
      }

      const ws = makeSheet(rows, [22, 22, 15, 14, 14, 30], 0, null,
        [
          { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
        ]
      );
      XLSX.utils.book_append_sheet(wb, ws, "Settlements");
    }

    // ════════════════════════════════════════════════════════════
    // SHEET 6: TASKS (conditional)
    // ════════════════════════════════════════════════════════════
    if (hasTasks) {
      const hdrRow = [
        cs("Title",       S.hdr()),
        cs("Type",        S.hdr()),
        cs("Assigned to", S.hdr()),
        cs("Status",      S.hdr()),
        cs("Due date",    S.hdr()),
        cs("Notes",       S.hdr()),
      ];
      const dataRows = activeTasks.map((task, i) => {
        const alt  = i % 2 === 1;
        const done = task.status === "done";
        return [
          cs(task.title || "",                                    done ? S.doneBg() : S.val(alt)),
          cs(taskTypeLabel(task.type),                            done ? S.doneBg() : S.val(alt)),
          cs((task.assignedTo || []).map(memberNameOf).join(", "), done ? S.doneBg() : S.val(alt)),
          cs(done ? "Done" : "To do",                            done ? S.paidBg() : S.pendingBg()),
          cs(task.dueDate || "",                                  done ? S.doneBg() : S.val(alt)),
          cs(task.notes || "",                                    done ? S.doneBg() : S.val(alt)),
        ];
      });
      const autoRef = `A1:F1`;
      const ws = makeSheet([hdrRow, ...dataRows], [36, 14, 24, 10, 12, 30], 1, autoRef);
      XLSX.utils.book_append_sheet(wb, ws, "Tasks");
    }

    XLSX.writeFile(wb, `${slugify(selectedTrip.name) || "trip"}-export.xlsx`);
  }

  // ── Legacy stub kept so old references don't break (not exposed in UI) ──
  function _exportTripSummaryCsvLegacy() {
    if (!selectedTrip) return;
    const cur = selectedTrip.defaultCurrency || "EUR";
    const rows = [];
    const blank = () => rows.push("");
    const section = title => {
      blank();
      rows.push(csvRow([`=== ${title} ===`]));
    };

    // Dynamic flags
    const hasBudget = totals.predicted > 0;
    const activeTasks = tasks.filter(t => t.isActive !== false);
    const hasTasks = activeTasks.length > 0;
    const hasMultiCurrency = expenses.some(
      e => e.originalCurrency && e.originalCurrency !== cur
    );
    const activeGroups = settlementGroups.filter(g => g.isActive !== false);
    const hasFamilyGroups = activeGroups.length > 0;

    // Helpers
    const money = v => Number(v || 0).toFixed(2);
    const pct = (v, total) => total > 0 ? `${Math.round((v / total) * 100)}%` : "0%";
    const exportedAt = new Date().toLocaleString();

    // ── 1. TRIP SUMMARY ──────────────────────────────────────────
    rows.push(csvRow(["TRIP SUMMARY"]));
    rows.push(csvRow(["Trip name", selectedTrip.name]));
    rows.push(csvRow(["Destination / description", selectedTrip.description || ""]));
    rows.push(csvRow(["Start date", selectedTrip.startDate || ""]));
    rows.push(csvRow(["End date", selectedTrip.endDate || ""]));
    rows.push(csvRow(["Duration", selectedTrip.startDate && selectedTrip.endDate
      ? (() => {
          const s = new Date(selectedTrip.startDate);
          const e = new Date(selectedTrip.endDate);
          const days = Math.max(1, Math.round((e - s) / 86400000) + 1);
          return `${days} day${days !== 1 ? "s" : ""}`;
        })()
      : ""]));
    rows.push(csvRow(["Currency", cur]));
    rows.push(csvRow(["Members", activeMembers.map(m => m.name || m.email || m.id).join(", ")]));
    rows.push(csvRow(["Total expenses", expenses.filter(e => e.isActive !== false).length]));
    rows.push(csvRow(["Exported at", exportedAt]));

    // ── 2. FINANCIAL OVERVIEW ─────────────────────────────────────
    section("FINANCIAL OVERVIEW");
    rows.push(csvRow(["Metric", `Amount (${cur})`]));
    rows.push(csvRow(["Trip total (shared + included personal)", money(totals.actual)]));
    rows.push(csvRow(["Shared expenses", money(totals.shared)]));
    rows.push(csvRow(["Personal expenses (included in total)", money(totals.actual - totals.shared)]));
    if (expenses.filter(e => e.isActive !== false).length > 0) {
      const tripStart = selectedTrip.startDate ? new Date(selectedTrip.startDate) : null;
      const tripEnd = selectedTrip.endDate ? new Date(selectedTrip.endDate) : null;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (tripStart) {
        const endForCalc = tripEnd && tripEnd < today ? tripEnd : today;
        const daysElapsed = Math.max(1, Math.round((endForCalc - tripStart) / 86400000) + 1);
        rows.push(csvRow(["Average spend per day", money(totals.actual / daysElapsed)]));
      }
    }
    rows.push(csvRow(["Already settled", money(totals.settled)]));
    if (hasBudget) {
      rows.push(csvRow(["Planned budget", money(totals.predicted)]));
      rows.push(csvRow([
        totals.predicted >= totals.actual ? "Under budget by" : "Over budget by",
        money(Math.abs(totals.predicted - totals.actual))
      ]));
    }

    // ── 3. MEMBER SNAPSHOT ────────────────────────────────────────
    section("MEMBER SNAPSHOT");
    rows.push(csvRow(["Who paid what and what they owe / are owed"]));
    blank();

    if (hasFamilyGroups) {
      // Unit-grouped view
      const memberSpendingMap = new Map(
        balances.map(b => {
          const personalPaid = roundMoney(
            expenses.filter(e => e.isActive !== false && e.expenseType !== "shared" && e.paidByMemberId === b.memberId)
              .reduce((s, e) => s + Number(e.amountEur || 0), 0)
          );
          return [b.memberId, { ...b, personalPaid, totalPaid: roundMoney(b.paid + personalPaid) }];
        })
      );

      activeGroups.forEach(group => {
        rows.push(csvRow([`Unit: ${group.name || "Group"}`, "", "", "", ""]));
        rows.push(csvRow(["  Member", `Total paid (${cur})`, `Group paid (${cur})`, `Personal paid (${cur})`, `Net balance (${cur})`, "Status"]));
        group.memberIds.forEach(id => {
          const m = memberSpendingMap.get(id);
          if (!m) return;
          rows.push(csvRow([
            `  ${m.name}`,
            money(m.totalPaid),
            money(m.paid),
            money(m.personalPaid),
            money(Math.abs(m.net)),
            m.net >= MONEY_EPSILON ? `Owed ${money(m.net)}` : m.net <= -MONEY_EPSILON ? `Owes ${money(-m.net)}` : "Settled"
          ]));
        });
        const unitMembers = group.memberIds.map(id => memberSpendingMap.get(id)).filter(Boolean);
        const unitTotalPaid = roundMoney(unitMembers.reduce((s, m) => s + m.totalPaid, 0));
        const unitNet = roundMoney(unitMembers.reduce((s, m) => s + m.net, 0));
        rows.push(csvRow([
          `  Unit total`,
          money(unitTotalPaid),
          "",
          "",
          money(Math.abs(unitNet)),
          unitNet >= MONEY_EPSILON ? `Owed ${money(unitNet)}` : unitNet <= -MONEY_EPSILON ? `Owes ${money(-unitNet)}` : "Settled"
        ]));
        blank();
      });

      // Ungrouped members
      const groupedIds = new Set(activeGroups.flatMap(g => g.memberIds));
      const ungrouped = balances.filter(b => !groupedIds.has(b.memberId));
      if (ungrouped.length > 0) {
        rows.push(csvRow(["Individual members", "", "", "", ""]));
        rows.push(csvRow(["Member", `Total paid (${cur})`, `Group paid (${cur})`, `Personal paid (${cur})`, `Net balance (${cur})`, "Status"]));
        ungrouped.forEach(b => {
          const personalPaid = roundMoney(
            expenses.filter(e => e.isActive !== false && e.expenseType !== "shared" && e.paidByMemberId === b.memberId)
              .reduce((s, e) => s + Number(e.amountEur || 0), 0)
          );
          rows.push(csvRow([
            b.name,
            money(b.paid + personalPaid),
            money(b.paid),
            money(personalPaid),
            money(Math.abs(b.net)),
            b.net >= MONEY_EPSILON ? `Owed ${money(b.net)}` : b.net <= -MONEY_EPSILON ? `Owes ${money(-b.net)}` : "Settled"
          ]));
        });
      }
    } else {
      // Simple flat view
      rows.push(csvRow(["Member", `Total paid (${cur})`, `Group paid (${cur})`, `Personal paid (${cur})`, `Net balance (${cur})`, "Status"]));
      balances.forEach(b => {
        const personalPaid = roundMoney(
          expenses.filter(e => e.isActive !== false && e.expenseType !== "shared" && e.paidByMemberId === b.memberId)
            .reduce((s, e) => s + Number(e.amountEur || 0), 0)
        );
        rows.push(csvRow([
          b.name,
          money(b.paid + personalPaid),
          money(b.paid),
          money(personalPaid),
          money(Math.abs(b.net)),
          b.net >= MONEY_EPSILON ? `Owed ${money(b.net)}` : b.net <= -MONEY_EPSILON ? `Owes ${money(-b.net)}` : "Settled"
        ]));
      });
    }

    // ── 4. SPENDING BY CATEGORY ───────────────────────────────────
    section("SPENDING BY CATEGORY");
    const catHeaders = ["Category", `Spent (${cur})`, "% of total"];
    if (hasBudget) catHeaders.push(`Budgeted (${cur})`, `Difference (${cur})`);
    rows.push(csvRow(catHeaders));

    const activeBreakdown = categories
      .map(c => ({
        name: c.name,
        actual: actualByCategoryId.get(c.id) || 0,
        predicted: Number(groupBudgetByCategoryId.get(c.id) || 0)
      }))
      .filter(c => c.actual > 0)
      .sort((a, b) => b.actual - a.actual);

    activeBreakdown.forEach(c => {
      const row = [c.name, money(c.actual), pct(c.actual, totals.actual)];
      if (hasBudget) row.push(money(c.predicted), money(c.predicted - c.actual));
      rows.push(csvRow(row));
    });

    // ── 5. EXPENSES ───────────────────────────────────────────────
    section("EXPENSES");
    const expHeaders = ["Date", "Time", "Description", "Category", "Type", "Paid by", `Amount (${cur})`];
    if (hasMultiCurrency) expHeaders.push("Original amount", "Original currency");
    expHeaders.push("Split among", "Notes");
    rows.push(csvRow(expHeaders));

    expenses
      .filter(e => e.isActive !== false)
      .forEach(e => {
        const splitAmong =
          e.expenseType === "shared" && e.splitType === "custom"
            ? Object.entries(e.customSplitSharesEur || {})
                .map(([id, amt]) => `${memberNameOf(id)}: ${money(amt)}`)
                .join(" | ")
            : e.expenseType === "shared"
            ? (e.splitMemberIds || []).map(memberNameOf).join(" | ")
            : memberNameOf(e.paidByMemberId);

        const row = [
          e.date || "",
          e.time || "",
          e.description || "",
          e.categoryName || "",
          e.expenseType === "shared" ? "Shared" : "Personal",
          memberNameOf(e.paidByMemberId),
          money(e.amountEur)
        ];
        if (hasMultiCurrency) {
          row.push(
            e.originalCurrency && e.originalCurrency !== cur
              ? money(e.originalAmount || e.amountEur)
              : "",
            e.originalCurrency && e.originalCurrency !== cur
              ? e.originalCurrency
              : ""
          );
        }
        row.push(splitAmong, e.notes || "");
        rows.push(csvRow(row));
      });

    // ── 6. SETTLEMENT PLAN & HISTORY ─────────────────────────────
    section("SETTLEMENT PLAN");
    rows.push(csvRow(["Who needs to pay whom to settle the trip"]));
    blank();

    const allGroupSuggestions = smartSettleSummary.groupSettlement.suggestions || [];
    const allPrivateSuggestions = smartSettleSummary.privateSettlements || [];

    if (allGroupSuggestions.length === 0 && allPrivateSuggestions.every(g => g.suggestions.length === 0)) {
      rows.push(csvRow(["All members are settled — no payments needed"]));
    } else {
      if (allGroupSuggestions.length > 0) {
        rows.push(csvRow(["Group settlements"]));
        rows.push(csvRow(["From", "To", `Amount (${cur})`, "Status"]));
        allGroupSuggestions.forEach(s => {
          rows.push(csvRow([s.fromName, s.toName, money(s.amount), s.status || "pending"]));
        });
        blank();
      }
      allPrivateSuggestions.forEach(group => {
        if (group.suggestions.length === 0) return;
        rows.push(csvRow([`Private: ${group.memberNames.join(" & ")}`]));
        rows.push(csvRow(["From", "To", `Amount (${cur})`, "Status"]));
        group.suggestions.forEach(s => {
          rows.push(csvRow([s.fromName, s.toName, money(s.amount), s.status || "pending"]));
        });
        blank();
      });
    }

    if (settlements.length > 0) {
      rows.push(csvRow(["Settlement history"]));
      rows.push(csvRow(["Date", "From", "To", `Amount (${cur})`, "Currency", "Status", "Notes"]));
      settlements.forEach(s => {
        rows.push(csvRow([
          s.date || s.paidAt?.toDate?.()?.toLocaleDateString?.() || "",
          s.fromMemberName || memberNameOf(s.fromMemberId),
          s.toMemberName || memberNameOf(s.toMemberId),
          money(s.amountEur),
          s.currency || cur,
          s.status || "paid",
          s.notes || ""
        ]));
      });
    }

    // ── 7. TASKS (only if any exist) ─────────────────────────────
    if (hasTasks) {
      section("TASKS");
      rows.push(csvRow(["Title", "Type", "Assigned to", "Status", "Due date", "Notes"]));
      activeTasks.forEach(task => {
        rows.push(csvRow([
          task.title || "",
          taskTypeLabel(task.type),
          (task.assignedTo || []).map(memberNameOf).join(", "),
          task.status === "done" ? "Done" : "To do",
          task.dueDate || "",
          task.notes || ""
        ]));
      });
    }

    downloadCsv(`${slugify(selectedTrip.name) || "trip"}-export.csv`, rows.join("\n"));
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

    const expenseDateTimeValue = `${formData.date || todayIso()}T${formData.time || nowTimeIso()}`;

    function handleDateTimeChange(value) {
      const [date, time = ""] = String(value || "").split("T");
      setFormData({
        ...formData,
        date: date || todayIso(),
        time: time ? time.slice(0, 5) : nowTimeIso()
      });
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
          { id: "basic",  label: "Details", icon: "📋" },
          { id: "paidby", label: "Split",   icon: "👥" },
          { id: "notes",  label: "More",    icon: "📝" },
        ]
      : [
          { id: "basic", label: "Details", icon: "📋" },
          { id: "notes", label: "More", icon: "📝" },
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

              <div className="expense-form-priority">
                <label>
                  Amount
                  <input
                    className="expense-amount-input"
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

              <label>
                What was it?
                <input
                  type="text"
                  value={formData.description}
                  placeholder="e.g. Lunch, taxi, hotel"
                  onChange={e => setFormData({ ...formData, description: e.target.value })}
                />
              </label>

              <div className="grid-2 expense-form-meta-grid">
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
                <label>
                  Date & time
                  <input
                    type="datetime-local"
                    value={expenseDateTimeValue}
                    onClick={openDatePicker}
                    onChange={e => handleDateTimeChange(e.target.value)}
                    required
                  />
                </label>
              </div>

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

              {formData.expenseType === "personal" && (
                <label className="include-in-group-toggle">
                  <div className="include-in-group-toggle-row">
                    <input
                      type="checkbox"
                      checked={formData.includeInGroupTotal !== false}
                      onChange={e => setFormData({ ...formData, includeInGroupTotal: e.target.checked })}
                    />
                    <span className="include-in-group-label">Count amount in trip total</span>
                  </div>
                  <p className="include-in-group-hint">
                    {formData.includeInGroupTotal !== false
                      ? "Details stay private. This amount is included in the group budget total."
                      : "Fully private. This amount stays out of the group budget total."}
                  </p>
                </label>
              )}
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

  function handleSettlementModeChange(mode) {
    setSettlementMode(mode);
    saveSettlementModeToStorage(mode);
    setExpandedSmartSettleId("");
  }

  async function expandCrossUnitVisibility(allGroups) {
    if (!selectedTrip || isDemoMode()) return 0;
    const activeGroups = allGroups.filter(g => g.isActive !== false);
    if (activeGroups.length < 2) return 0;

    const unitMap = {};
    const unitMemberSets = {};
    activeGroups.forEach(g => {
      unitMemberSets[g.id] = new Set(g.memberIds);
      g.memberIds.forEach(id => { unitMap[id] = g.id; });
    });

    const updates = [];
    expenses.forEach(expense => {
      if (!isActiveSharedExpense(expense)) return;
      const isPrivate = normalizeExpenseScope(expense) === "selected_members"
        || Array.isArray(expense.visibleTo);
      if (!isPrivate || expense.visibleTo === "all") return;

      const visibleIds = expenseVisibleIds(expense).filter(Boolean);
      if (visibleIds.length < 2) return;
      if (!visibleIds.every(id => unitMap[id])) return;

      const involvedUnitIds = new Set(visibleIds.map(id => unitMap[id]));
      if (involvedUnitIds.size < 2) return;

      const expanded = new Set(visibleIds);
      involvedUnitIds.forEach(gid => unitMemberSets[gid]?.forEach(mid => expanded.add(mid)));

      const newVisibleTo = [...expanded].sort();
      const current = Array.isArray(expense.visibleTo)
        ? [...expense.visibleTo].sort()
        : [...visibleIds].sort();

      const unchanged = newVisibleTo.length === current.length
        && newVisibleTo.every((id, i) => id === current[i]);
      if (unchanged) return;

      updates.push({ id: expense.id, visibleTo: newVisibleTo });
    });

    if (updates.length === 0) return 0;

    await Promise.all(
      updates.map(({ id, visibleTo }) =>
        updateDoc(doc(db, "trips", selectedTrip.id, "expenses", id), { visibleTo })
      )
    );
    setExpenses(prev =>
      prev.map(e => {
        const u = updates.find(x => x.id === e.id);
        return u ? { ...e, visibleTo: u.visibleTo } : e;
      })
    );
    return updates.length;
  }

  // Auto-run expansion once per trip when admin has both expenses and ≥2 settlement groups loaded.
  // This means existing trips don't need groups to be manually re-saved.
  useEffect(() => {
    if (!selectedTrip || !user) return;
    if (selectedTrip.ownerId !== user.uid) return;
    if (settlementGroups.filter(g => g.isActive !== false).length < 2) return;
    if (expenses.length === 0) return;
    if (crossUnitExpandedTripsRef.current.has(selectedTrip.id)) return;
    crossUnitExpandedTripsRef.current.add(selectedTrip.id);
    expandCrossUnitVisibility(settlementGroups);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTrip?.id, settlementGroups.length, expenses.length]);

  async function handleSaveSettlementGroup(e) {
    e.preventDefault();
    if (!selectedTrip || isDemoMode()) return;
    const { name, type } = settlementGroupForm;
    if (!name.trim()) return showToast("Group name is required.", "error");

    const activeTripMembers = members.filter(m => m.status !== "inactive");
    const activeTripMemberIds = new Set(activeTripMembers.map(m => m.id));

    const validMemberIds = settlementGroupForm.memberIds.filter(id => activeTripMemberIds.has(id));
    const removedCount = settlementGroupForm.memberIds.length - validMemberIds.length;
    if (removedCount > 0) {
      setSettlementGroupForm(f => ({ ...f, memberIds: validMemberIds }));
      if (validMemberIds.length < 2) {
        return showToast(`${removedCount} selected member(s) are no longer in this trip. The group needs at least 2 valid members.`, "error");
      }
      showToast(`${removedCount} selected member(s) are no longer in this trip and were removed from the selection.`, "info");
    }

    const memberIds = validMemberIds;
    if (memberIds.length < 2) return showToast("A settlement group must have at least 2 members.", "error");

    const activeGroups = settlementGroups.filter(g => g.isActive !== false && g.id !== editingSettlementGroupId);

    const sortedNew = [...memberIds].sort();
    const duplicate = activeGroups.find(g => {
      const sortedExisting = [...g.memberIds].sort();
      return sortedExisting.length === sortedNew.length &&
        sortedExisting.every((id, i) => id === sortedNew[i]);
    });
    if (duplicate) {
      return showToast(`A group with the same members already exists: "${duplicate.name}". Edit or remove that group instead.`, "error");
    }

    const takenIds = new Set(activeGroups.flatMap(g => g.memberIds));
    const conflict = memberIds.find(id => takenIds.has(id));
    if (conflict) {
      const m = members.find(mb => mb.id === conflict);
      return showToast(`${memberDisplayName(m) || conflict} is already in another settlement group.`, "error");
    }

    let updatedGroups;
    try {
      if (editingSettlementGroupId) {
        const updated = { name: name.trim(), memberIds, type, updatedAt: new Date().toISOString() };
        await updateDoc(doc(db, "trips", selectedTrip.id, "settlementGroups", editingSettlementGroupId), updated);
        updatedGroups = settlementGroups.map(g =>
          g.id === editingSettlementGroupId ? { ...g, ...updated } : g
        );
        setSettlementGroups(updatedGroups);
      } else {
        const newGroupRef = doc(collection(db, "trips", selectedTrip.id, "settlementGroups"));
        const newGroup = {
          id: newGroupRef.id,
          name: name.trim(),
          memberIds,
          type,
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await setDoc(newGroupRef, newGroup);
        updatedGroups = [...settlementGroups, newGroup];
        setSettlementGroups(updatedGroups);
      }
      await expandCrossUnitVisibility(updatedGroups);
    } catch (err) {
      console.error("Failed to save settlement group:", err);
      showToast("Failed to save settlement group. Please try again.", "error");
      return;
    }
    setShowSettlementGroupForm(false);
    setEditingSettlementGroupId(null);
    setSettlementGroupForm({ name: "", memberIds: [], type: "couple" });
  }

  function handleEditSettlementGroup(group) {
    setEditingSettlementGroupId(group.id);
    setSettlementGroupForm({ name: group.name, memberIds: group.memberIds, type: group.type || "couple" });
    setShowSettlementGroupForm(true);
  }

  async function handleDeleteSettlementGroup(groupId) {
    if (!selectedTrip || isDemoMode()) return;
    try {
      await updateDoc(doc(db, "trips", selectedTrip.id, "settlementGroups", groupId), {
        isActive: false,
        updatedAt: new Date().toISOString()
      });
      setSettlementGroups(settlementGroups.map(g =>
        g.id === groupId ? { ...g, isActive: false } : g
      ));
    } catch (err) {
      console.error("Failed to remove settlement group:", err);
      showToast("Failed to remove settlement group. Please try again.", "error");
    }
    if (editingSettlementGroupId === groupId) {
      setShowSettlementGroupForm(false);
      setEditingSettlementGroupId(null);
    }
  }

  function renderSettlementsTab() {
    const groupSettlement = smartSettleSummary.groupSettlement;
    const privateSettlements = smartSettleSummary.privateSettlements;
    const privateGroupsWithSuggestions = privateSettlements.filter(group => group.suggestions.length > 0);
    const consolidatedSuggestions = smartSettleSummary.consolidatedSuggestions || [];
    const consolidatedTotal = roundMoney(consolidatedSuggestions.reduce((s, sg) => s + Number(sg.amount || 0), 0));
    const combinedBalances = getCombinedMemberBalances(groupSettlement, privateSettlements);
    const pendingSuggestions = [
      ...groupSettlement.suggestions,
      ...privateGroupsWithSuggestions.flatMap(group => group.suggestions)
    ];
    const pendingTotal = consolidatedTotal;
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
        value: consolidatedSuggestions.length,
        detail: `${pendingSuggestions.length} total incl. private`,
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

    const isAdmin = selectedTrip?.ownerId === user?.uid;
    const myMemberId = currentUserMemberId;
    const myBalance = myMemberId ? combinedBalances.find(b => b.memberId === myMemberId) : null;
    const myNet = myBalance?.net ?? 0;
    const myPeopleOwingMe = consolidatedSuggestions.filter(s => s.toMemberId === myMemberId || s.toUnitId === myMemberId);
    const myOwedToOthers = consolidatedSuggestions.filter(s => s.fromMemberId === myMemberId || s.fromUnitId === myMemberId);
    const alreadyPaidTotal = roundMoney((myBalance?.settledPaid ?? 0) + (myBalance?.settledReceived ?? 0));
    const hasPrivateExpenses = privateSettlements.length > 0;

    const renderConsolidatedCard = (suggestion) => {
      const cardId = `consolidated-${suggestion.id}`;
      const expanded = expandedSmartSettleId === cardId;
      const fromBalance = combinedBalances.find(b => b.memberId === suggestion.fromMemberId);
      const toBalance = combinedBalances.find(b => b.memberId === suggestion.toMemberId);
      const fromInitial = cleanDisplayName(suggestion.fromName).slice(0, 1).toUpperCase();
      return (
        <div className="smart-settle-row" key={cardId}>
          <div className="smart-settle-avatar" aria-hidden="true">{fromInitial}</div>
          <div className="smart-settle-main">
            <div className="smart-settle-route">
              <strong>{cleanDisplayName(suggestion.fromName)}</strong>
              <span aria-hidden="true">→</span>
              <strong>{cleanDisplayName(suggestion.toName)}</strong>
            </div>
            <p className="small muted">All expenses combined</p>
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
          </div>
          {expanded ? (
            <div className="smart-settle-breakdown">
              {[fromBalance, toBalance].filter(Boolean).map(balance => (
                <p className="small muted" key={balance.memberId}>
                  <strong>{cleanDisplayName(balance.name)}</strong>: paid {formatMoney(balance.paid)}, share {formatMoney(balance.share)}, net {formatMoney(balance.net)}
                </p>
              ))}
              {(() => {
                const involvedIds = new Set([suggestion.fromMemberId, suggestion.toMemberId].filter(Boolean));
                const related = expenses.filter(e =>
                  e.isActive !== false && e.expenseType === "shared" &&
                  (involvedIds.has(e.paidByMemberId) ||
                    (e.splitMemberIds || []).some(id => involvedIds.has(id)))
                ).slice(0, 6);
                if (!related.length) return null;
                return (
                  <div className="drill-expenses">
                    <p className="small muted drill-title">Contributing expenses ({related.length}{related.length === 6 ? "+" : ""}):</p>
                    {related.map(e => (
                      <div className="drill-expense-row" key={e.id}>
                        <span className="small">{e.description || e.categoryName}</span>
                        <span className="small muted">{formatMoney(e.amountEur)}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          ) : null}
        </div>
      );
    };

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
              onClick={() => {
                setPendingSmartSettlement({ suggestion, layer, settlementGroupId });
                setPendingSettleAmount(String(suggestion.amount || ""));
                setPendingSettleActualPayer(suggestion.fromMemberId || suggestion.fromUserId || "");
              }}
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
              {(() => {
                const fromId = suggestion.fromMemberId || suggestion.fromUserId;
                const toId = suggestion.toMemberId || suggestion.toUserId;
                const involvedIds = new Set([fromId, toId].filter(Boolean));
                const related = expenses.filter(e =>
                  e.isActive !== false && e.expenseType === "shared" &&
                  (involvedIds.has(e.paidByMemberId) ||
                    (e.splitMemberIds || []).some(id => involvedIds.has(id)))
                ).slice(0, 6);
                if (!related.length) return null;
                return (
                  <div className="drill-expenses">
                    <p className="small muted drill-title">Contributing expenses ({related.length}{related.length === 6 ? "+" : ""}):</p>
                    {related.map(e => (
                      <div className="drill-expense-row" key={e.id}>
                        <span className="small">{e.description || e.categoryName}</span>
                        <span className="small muted">{formatMoney(e.amountEur)}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
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

    const tripEndDate = selectedTrip?.endDate ? new Date(selectedTrip.endDate) : null;
    const today = new Date(todayIso());
    const tripHasEnded = tripEndDate && today > tripEndDate;
    const daysAfterEnd = tripHasEnded
      ? Math.round((today - tripEndDate) / 86400000)
      : 0;
    const allSettled = consolidatedSuggestions.length === 0 && hasExpenses;

    return (
      <section className="smart-settle-page">
        {tripHasEnded && !allSettled && (
          <div className="trip-end-settle-banner">
            <span className="trip-end-icon" aria-hidden="true">🏁</span>
            <div>
              <strong>Trip ended {daysAfterEnd === 1 ? "yesterday" : `${daysAfterEnd} days ago`}</strong>
              <p className="small muted">Time to settle up! {consolidatedSuggestions.length} payment{consolidatedSuggestions.length !== 1 ? "s" : ""} remaining totalling {formatMoney(consolidatedTotal)}.</p>
            </div>
          </div>
        )}
        {tripHasEnded && allSettled && (
          <div className="trip-end-settle-banner settled">
            <span className="trip-end-icon" aria-hidden="true">✓</span>
            <div>
              <strong>All settled up!</strong>
              <p className="small muted">This trip is over and everyone is settled.</p>
            </div>
          </div>
        )}
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

        {myMemberId && hasExpenses && (
          <div className={`your-balance-card card ${myNet < -MONEY_EPSILON ? "balance-owe" : myNet > MONEY_EPSILON ? "balance-receive" : "balance-clear"}`}>
            <div className="your-balance-main">
              <span className="your-balance-label">Your balance</span>
              {myNet < -MONEY_EPSILON ? (
                <strong className="your-balance-amount owe">You owe {formatMoney(Math.abs(myNet))} total</strong>
              ) : myNet > MONEY_EPSILON ? (
                <strong className="your-balance-amount receive">You are owed {formatMoney(myNet)} total</strong>
              ) : (
                <strong className="your-balance-amount clear">You are settled up</strong>
              )}
              <p className="small muted">
                {myOwedToOthers.length > 0 && `Pay ${myOwedToOthers.length} ${myOwedToOthers.length === 1 ? "person" : "people"} · `}
                {myPeopleOwingMe.length > 0 && `Receive from ${myPeopleOwingMe.length} ${myPeopleOwingMe.length === 1 ? "person" : "people"} · `}
                {alreadyPaidTotal > 0 && `${formatMoney(alreadyPaidTotal)} already settled`}
              </p>
            </div>
            {!isAdmin && hasPrivateExpenses && (
              <p className="your-balance-note small muted">
                Private expenses you are not part of are not shown here.
              </p>
            )}
            {!isAdmin && !hasPrivateExpenses && (
              <p className="your-balance-note small muted">
                Only group expenses visible to you are included.
              </p>
            )}
          </div>
        )}

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

        {hasExpenses ? (
          <section className="card smart-settle-panel consolidated-panel">
            <div className="consolidated-panel-header">
              <div>
                <h3>Final Settlement</h3>
                <p className="small muted">
                  {isFamilyCoupleMode
                    ? "Minimum payments between units, combining group and cross-unit private expenses."
                    : "Minimum payments combining all group and private expenses."}
                </p>
              </div>
              {consolidatedSuggestions.length > 0 ? (
                <p className="smart-settle-summary-sentence">
                  <span aria-hidden="true">✓</span>
                  {consolidatedSuggestions.length === 1
                    ? `1 payment settles ${formatMoney(consolidatedTotal)}.`
                    : `${consolidatedSuggestions.length} payments settle ${formatMoney(consolidatedTotal)}.`}
                </p>
              ) : null}
            </div>
            {consolidatedSuggestions.length === 0 ? (
              <p className="muted">All settled up — no payments needed.</p>
            ) : (
              <div className="settlement-list">
                {consolidatedSuggestions.map(s => renderConsolidatedCard(s))}
              </div>
            )}
            <p className="consolidated-note small muted">
              This is your final answer. Use "Show breakdown" below to mark individual payments as paid.
              {isFamilyCoupleMode
                ? " · Within-unit private expenses are settled internally and shown in the breakdown."
                : (!isAdmin && " · Private expenses you are not part of are excluded from this view.")}
            </p>
          </section>
        ) : null}

        {!hasExpenses ? (
          <section className="card smart-empty-card">
            <p className="muted">No expenses added yet.</p>
          </section>
        ) : (
          <>
            <button
              className="breakdown-toggle-btn"
              onClick={() => setShowSettlementBreakdown(v => !v)}
            >
              {showSettlementBreakdown ? "Hide breakdown ▲" : "Show breakdown ▼"}
              <span className="breakdown-toggle-hint"> — mark individual payments as paid</span>
            </button>
            {showSettlementBreakdown && (
              <div className="smart-settle-grid breakdown-grid">
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
          </>
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
    const r = 68;
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

    const groupExpenseCount = tripTotalsSummary?.sharedExpenseCount != null
      ? Number(tripTotalsSummary.sharedExpenseCount || 0)
      : expenses.filter(e => normalizeExpenseScope(e) === "group" && e.isActive !== false).length;
    const groupCurrency = selectedTrip?.defaultCurrency || "EUR";
    const myPersonalSpentEur = roundMoney(myPersonalExpenses.reduce((s, e) => s + Number(e.amountEur || 0), 0));
    const myPersonalBudgetEur = personalBudget?.amountEur || 0;
    const myPersonalPct = myPersonalBudgetEur > 0 ? Math.min(100, Math.round((myPersonalSpentEur / myPersonalBudgetEur) * 100)) : 0;
    const myPersonalRemaining = roundMoney(myPersonalBudgetEur - myPersonalSpentEur);
    const userInitial = (user?.displayName || user?.email || "?")[0].toUpperCase();
    const demoMode = isDemoMode();
    const userHasFinancialInvolvement =
      expenses.some(e => e.paidByMemberId === currentUserMemberId) ||
      settlements.some(s =>
        s.fromMemberId === currentUserMemberId ||
        s.toMemberId === currentUserMemberId
      );

    // Unit-level spending (only when settlement groups exist)
    const activeUnitGroups = settlementGroups.filter(g => g.isActive !== false);
    const unitSpendingData = activeUnitGroups.map(group => {
      const unitMembers = group.memberIds
        .map(id => memberSpending.find(m => m.memberId === id))
        .filter(Boolean)
        .sort((a, b) => (a.memberId === currentUserMemberId ? -1 : b.memberId === currentUserMemberId ? 1 : 0));
      return {
        ...group,
        members: unitMembers,
        totalPaid: roundMoney(unitMembers.reduce((s, m) => s + m.totalPaid, 0)),
        unitNet: roundMoney(unitMembers.reduce((s, m) => s + m.net, 0))
      };
    });

    const groupedMemberIds = new Set(activeUnitGroups.flatMap(g => g.memberIds));
    const ungroupedMemberSpending = memberSpending.filter(m => !groupedMemberIds.has(m.memberId));

    // Helper: render one member spending row
    function renderSpendingRow(m, compact = false) {
      const isMe = m.memberId === currentUserMemberId;
      const img = memberImageOf(m);
      const initial = (cleanDisplayName(m.name) || "?")[0].toUpperCase();
      const netPos = m.net >= MONEY_EPSILON;
      const netNeg = m.net <= -MONEY_EPSILON;
      return (
        <div
          key={m.memberId}
          className={`spending-row${compact ? " spending-row--compact" : ""}${isMe ? " spending-row--me" : ""}`}
        >
          <div
            className={`spending-row-avatar${img ? " has-image" : ""}`}
            style={img ? { backgroundImage: `url(${img})` } : undefined}
          >
            {!img ? initial : null}
          </div>
          <div className="spending-row-info">
            <div className="spending-row-name">
              {cleanDisplayName(m.name)}
              {isMe && <span className="spending-you-tag">You</span>}
            </div>
            <div className="spending-row-meta">paid {formatMoney(m.totalPaid)}</div>
          </div>
          <div className={`spending-row-balance${netPos ? " positive" : netNeg ? " negative" : ""}`}>
            <div className="spending-row-amount">
              {netPos ? "+" : netNeg ? "–" : ""}{formatMoney(Math.abs(m.net))}
            </div>
            <div className="spending-row-blabel">
              {netPos ? "owed" : netNeg ? "owes" : "settled"}
            </div>
          </div>
        </div>
      );
    }

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
      { key: "all", label: "Visible", count: expenses.length },
      { key: "shared", label: "Shared", count: expenses.filter(e => e.expenseType === "shared").length },
      { key: "personal", label: "My personal", count: expenses.filter(e => e.expenseType !== "shared").length },
      { key: "pending", label: "Pending split", count: expenseStats.pendingSplit }
    ];
    const expenseSummaryCards = [
      {
        label: "Trip total",
        value: formatMoney(totals.actual),
        sub: "Shared plus included personal totals",
        icon: "€",
        tone: "mint"
      },
      {
        label: "Shared",
        value: formatMoney(totals.shared),
        sub: `${expenseFilterOptions[1].count} expense${expenseFilterOptions[1].count === 1 ? "" : "s"}`,
        icon: "S",
        tone: "blue"
      },
      {
        label: "My personal",
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
        tone: "amber",
        mobileOptional: true
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
      { key: "tasks", label: "Tasks", icon: "✓" },
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
              className="primary-button small-button mobile-topbar-add"
              type="button"
              onClick={() => openFastExpenseModal()}
            >
              + Add
            </button>
            ) : null}
          </div>
          {tripDataLoading ? (
            <p className="muted padded-message">Loading trip data...</p>
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

              {/* ── Quick action bar ── */}
              <div className="dash-action-bar dash-section-actions" aria-label="Primary trip actions">
                {!demoMode ? (
                  <button className="dash-action-btn dash-action-expense" type="button" onClick={() => openFastExpenseModal()}>
                    <div className="dash-action-icon dash-action-icon--expense">➕</div>
                    <span>Add Expense</span>
                  </button>
                ) : null}
                <button className="dash-action-btn" type="button" onClick={() => setActiveTab("prediction")}>
                  <div className="dash-action-icon dash-action-icon--budget">📊</div>
                  <span>Add Budget</span>
                </button>
                <button className="dash-action-btn" type="button" onClick={() => setActiveTab("settlements")}>
                  <div className="dash-action-icon dash-action-icon--settle">🤝</div>
                  <span>Settlements</span>
                </button>
                {!demoMode ? (
                  <button className="dash-action-btn" type="button" onClick={openCreateTask}>
                    <div className="dash-action-icon dash-action-icon--tasks">✓</div>
                    <span>New Task</span>
                  </button>
                ) : null}
                <button className="dash-action-btn" type="button" onClick={() => setActiveTab("categories")}>
                  <div className="dash-action-icon dash-action-icon--category">🏷️</div>
                  <span>Categories</span>
                </button>
              </div>

              {/* ── Row 1: Budget overview + Stat panel ── */}
              <div className="dash-row dash-row-budget dash-section-priority">
                <div className="dash-card budget-card">
                  <div className="budget-card-top">
                    <div>
                      <h3>{totals.predicted > 0 ? "Budget Overview" : "Spending"}</h3>
                      <p className="dash-card-sub mb-0">
                        {totals.predicted > 0 ? `${budgetPct}% of budget used` : "No budget set yet"}
                      </p>
                    </div>
                    <button className="link-button" type="button" style={{ whiteSpace: "nowrap" }} onClick={() => setActiveTab("prediction")}>
                      {totals.predicted > 0 ? "Edit →" : "Set budget →"}
                    </button>
                  </div>

                  {totals.predicted > 0 ? (
                    <>
                      <div className="budget-donut-wrap">
                        <svg width="100%" height="100%" viewBox="0 0 160 160">
                          <circle cx="80" cy="80" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
                          <circle
                            cx="80" cy="80" r={r} fill="none"
                            stroke={budgetPct >= 100 ? "var(--danger)" : budgetPct >= 80 ? "var(--warning)" : "var(--primary)"}
                            strokeWidth="12"
                            strokeDasharray={`${dashFill} ${circ}`}
                            strokeLinecap="round"
                            transform="rotate(-90, 80, 80)"
                          />
                        </svg>
                        <div className="budget-donut-label">
                          <span className="budget-donut-pct">{budgetPct}%</span>
                          <span className="budget-donut-sub">used</span>
                        </div>
                      </div>
                      <div className="budget-inline-stats">
                        <div className="budget-inline-stat">
                          <span className="budget-inline-label">Budget</span>
                          <strong className="budget-inline-value">{formatMoney(totals.predicted)}</strong>
                        </div>
                        <div className="budget-inline-stat">
                          <span className="budget-inline-label">Spent</span>
                          <strong className="budget-inline-value">{formatMoney(totals.actual)}</strong>
                        </div>
                        <div className="budget-inline-stat">
                          <span className="budget-inline-label">Left</span>
                          <strong className={`budget-inline-value${remaining < 0 ? " negative" : ""}`}>
                            {remaining >= 0 ? formatMoney(remaining) : "–" + formatMoney(Math.abs(remaining))}
                          </strong>
                        </div>
                      </div>
                      <div className="budget-message">{budgetMsg}</div>
                    </>
                  ) : (
                    <>
                      <div className="budget-no-budget-total">
                        <span className="budget-donut-pct">{formatMoney(totals.actual)}</span>
                        <span className="budget-donut-sub">trip total</span>
                      </div>
                      <div className="budget-inline-stats">
                        <div className="budget-inline-stat">
                          <span className="budget-inline-label">Expenses</span>
                          <strong className="budget-inline-value">{groupExpenseCount}</strong>
                        </div>
                        <div className="budget-inline-stat">
                          <span className="budget-inline-label">Shared</span>
                          <strong className="budget-inline-value">{formatMoney(totals.shared)}</strong>
                        </div>
                        <div className="budget-inline-stat">
                          <span className="budget-inline-label">My personal</span>
                          <strong className="budget-inline-value">{formatMoney(expenseStats.personal)}</strong>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="dash-card dash-stat-panel dash-stat-panel--6">
                  <div className="dash-stat-panel-item">
                    <span className="dash-stat-panel-label">Trip total</span>
                    <strong className="dash-stat-panel-value">{formatMoney(totals.actual)}</strong>
                  </div>
                  <div className="dash-stat-panel-item">
                    <span className="dash-stat-panel-label">Shared</span>
                    <strong className="dash-stat-panel-value">{formatMoney(totals.shared)}</strong>
                  </div>
                  <div className="dash-stat-panel-item">
                    <span className="dash-stat-panel-label">Avg / day</span>
                    <strong className="dash-stat-panel-value">
                      {daysIn > 0 && totals.actual > 0 ? formatMoney(roundMoney(totals.actual / daysIn)) : "—"}
                    </strong>
                  </div>
                  {currentUserMemberId && (() => {
                    const myBal = balances.find(b => b.memberId === currentUserMemberId);
                    const net = myBal ? myBal.net : 0;
                    const netPos = net >= MONEY_EPSILON;
                    const netNeg = net <= -MONEY_EPSILON;
                    return (
                      <div className="dash-stat-panel-item">
                        <span className="dash-stat-panel-label">Your balance</span>
                        <strong className={`dash-stat-panel-value${netPos ? " positive" : netNeg ? " negative" : ""}`}>
                          {netPos ? "+" : netNeg ? "–" : ""}{formatMoney(Math.abs(net))}
                        </strong>
                        <span className="dash-stat-panel-sub">{netPos ? "you're owed" : netNeg ? "you owe" : "settled"}</span>
                      </div>
                    );
                  })()}
                  <div className="dash-stat-panel-item">
                    <span className="dash-stat-panel-label">Expenses</span>
                    <strong className="dash-stat-panel-value">{groupExpenseCount}</strong>
                    <span className="dash-stat-panel-sub">{expenseFilterOptions[1].count} shared · {expenseFilterOptions[2].count} personal</span>
                  </div>
                  <div className="dash-stat-panel-item">
                    <span className="dash-stat-panel-label">Trip status</span>
                    <strong className="dash-stat-panel-value">
                      {daysLeft > 0 ? `${daysLeft}d left` : "Ended"}
                    </strong>
                    <span className="dash-stat-panel-sub">{totalDays} days total</span>
                  </div>
                </div>
              </div>

              {currentUserMemberId && (
                <div className="dash-row dash-section-personal">
                  <div className="dash-card personal-strip-card">
                    {showPersonalBudgetForm ? (
                      <>
                        <div className="personal-strip-form-header">
                          <span className="personal-strip-label">Personal budget</span>
                          <button className="link-button" type="button" onClick={() => setShowPersonalBudgetForm(false)}>Cancel</button>
                        </div>
                        <div className="personal-budget-form">
                          <div className="personal-budget-form-row">
                            <input
                              className="form-input personal-budget-amount-input"
                              type="number"
                              min="0"
                              step="any"
                              placeholder="Amount"
                              value={personalBudgetForm.amount}
                              onChange={e => setPersonalBudgetForm(f => ({ ...f, amount: e.target.value }))}
                            />
                            <select
                              className="form-input personal-budget-currency-select"
                              value={personalBudgetForm.currency}
                              onChange={e => setPersonalBudgetForm(f => ({ ...f, currency: e.target.value }))}
                            >
                              {SUPPORTED_CURRENCIES.map(c => (
                                <option key={c.code} value={c.code}>{c.code} – {c.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="personal-budget-form-actions">
                            <button className="primary-button small-button" type="button" disabled={savingPersonalBudget} onClick={handleSavePersonalBudget}>
                              {savingPersonalBudget ? "Saving…" : "Save"}
                            </button>
                            {personalBudget && (
                              <button className="danger-button small-button" type="button" onClick={handleDeletePersonalBudget}>Remove</button>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="personal-strip-row">
                        <div className="personal-strip-icon">🔒</div>
                        <div className="personal-strip-info">
                          <div className="personal-strip-title">My personal spending</div>
                          <div className="personal-strip-sub">
                            {myPersonalExpenses.length} expense{myPersonalExpenses.length !== 1 ? "s" : ""}
                            {myPersonalBudgetEur > 0 && (
                              <> · <span className={myPersonalRemaining < 0 ? "over-budget" : myPersonalPct >= 80 ? "near-budget" : "under-budget"}>
                                {myPersonalPct}% of budget used
                              </span></>
                            )}
                          </div>
                          {myPersonalBudgetEur > 0 && (
                            <div className="personal-strip-bar-wrap">
                              <div className="personal-strip-bar">
                                <div
                                  className={`personal-strip-bar-fill ${myPersonalPct >= 100 ? "over-budget" : myPersonalPct >= 80 ? "near-budget" : ""}`}
                                  style={{ width: `${Math.min(100, myPersonalPct)}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="personal-strip-right">
                          <div className="personal-strip-amount">{formatMoney(myPersonalSpentEur, groupCurrency)}</div>
                          <div className="personal-strip-actions">
                            <button
                              className="link-button"
                              type="button"
                              onClick={() => { setExpenseFilter("personal"); setActiveTab("actual"); }}
                            >
                              View →
                            </button>
                            <button
                              className="link-button"
                              type="button"
                              onClick={() => {
                                setPersonalBudgetForm({
                                  amount: personalBudget ? String(personalBudget.originalAmount) : "",
                                  currency: personalBudget?.originalCurrency || groupCurrency
                                });
                                setShowPersonalBudgetForm(true);
                              }}
                            >
                              {personalBudget ? "Budget" : "+ Budget"}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {overviewTasks.length > 0 && (
              <div className="dash-row dash-section-next">
                <div className="dash-card next-actions-card">
                  <div className="dash-card-header">
                    <div>
                      <h3>Next actions</h3>
                      <p className="dash-card-sub">Track what still needs to be done before everyone is settled.</p>
                    </div>
                    <button className="link-button" type="button" onClick={() => setActiveTab("tasks")}>
                      View all tasks →
                    </button>
                  </div>
                  <div className="overview-task-list">
                    {overviewTasks.map(task => {
                      const canComplete = canUserCompleteTask(task, currentUserMemberId);
                      return (
                        <div className="overview-task-row" key={task.id}>
                          <button
                            className="task-status-button overview-task-check"
                            type="button"
                            disabled={!canComplete}
                            aria-label="Mark task done"
                            onClick={() => handleMarkTaskDone(task)}
                          >
                            <span aria-hidden="true">✓</span>
                          </button>
                          <button className="overview-task-main" type="button" onClick={() => setActiveTab("tasks")}>
                            <strong>{task.title}</strong>
                            <small>
                              Assigned to {taskMemberListLabel(task.assignedTo)} · {taskScopeLabel(task.scope)}
                              {task.type ? ` · ${taskTypeLabel(task.type)}` : ""}
                            </small>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              )}

              {/* ── Row 2: Settlement snapshot + Recent expenses ── */}
              <div className={`dash-row dash-section-activity${userHasFinancialInvolvement ? " dash-row-2col" : ""}`}>
                {userHasFinancialInvolvement && (
                <div className="dash-card">
                  <div className="dash-card-header">
                    <div>
                      <h3>Member spending</h3>
                      <p className="dash-card-sub">
                        {unitSpendingData.length > 0
                          ? "Group + personal totals · unit balances combined"
                          : "Group + personal totals and net balance"}
                      </p>
                    </div>
                    <button
                      className="link-button link-button--sm"
                      type="button"
                      onClick={() => setActiveTab("settlements")}
                    >
                      Settle →
                    </button>
                  </div>

                  {memberSpending.length === 0 ? (
                    <p className="muted small">No members yet.</p>
                  ) : (
                    <>
                      {/* Unit blocks (family / couple mode) */}
                      {unitSpendingData.map(unit => {
                        const unitNetPos = unit.unitNet >= MONEY_EPSILON;
                        const unitNetNeg = unit.unitNet <= -MONEY_EPSILON;
                        const isMyUnit = unit.members.some(m => m.memberId === currentUserMemberId);
                        return (
                          <div key={unit.id} className={`spending-unit-block${isMyUnit ? " spending-unit-block--me" : ""}`}>
                            <div className="spending-unit-header">
                              <div className="spending-unit-info">
                                <div className="spending-unit-name">{unit.name || "Unit"}</div>
                                <div className="spending-unit-meta">
                                  {unit.members.map(m => cleanDisplayName(m.name)).join(" & ")}
                                </div>
                              </div>
                              <div className="spending-unit-totals">
                                <div className="spending-unit-paid">paid {formatMoney(unit.totalPaid)}</div>
                                <div className={`spending-unit-net${unitNetPos ? " positive" : unitNetNeg ? " negative" : ""}`}>
                                  {unitNetPos ? "+" : unitNetNeg ? "–" : ""}{formatMoney(Math.abs(unit.unitNet))}
                                  <span className="spending-row-blabel">{unitNetPos ? " owed" : unitNetNeg ? " owes" : " settled"}</span>
                                </div>
                              </div>
                            </div>
                            {unit.members.map(m => renderSpendingRow(m, true))}
                          </div>
                        );
                      })}

                      {/* Ungrouped / solo members */}
                      {ungroupedMemberSpending.map(m => renderSpendingRow(m, false))}

                      {/* Suggested settlement strip */}
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
                            Settle
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                )}

                <div className="dash-card">
                  <div className="dash-card-header">
                    <div>
                      <h3>Recent expenses</h3>
                      <p className="dash-card-sub">Latest visible transactions</p>
                    </div>
                    <button className="link-button link-button--sm" type="button" onClick={() => setActiveTab("actual")}>
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
              <div className="dash-row dash-row-3col dash-section-context">

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
                  <button className="secondary-button small-button btn-full-top" type="button" onClick={() => setActiveTab("members")}>
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

              {/* ── Row 4: Spending by category (compact + tap for detail) ── */}
              {spendingBreakdown.length > 0 && (
                <div
                  className="dash-card breakdown-card breakdown-card--compact dash-section-breakdown"
                  role="button"
                  tabIndex={0}
                  aria-label="View category breakdown"
                  onClick={() => setShowCategoryBreakdown(true)}
                  onKeyDown={e => e.key === "Enter" && setShowCategoryBreakdown(true)}
                >
                  <div className="breakdown-compact-layout">
                    <div
                      className="breakdown-ring breakdown-ring--sm"
                      style={{ background: `conic-gradient(${breakdownGradient})` }}
                      aria-hidden="true"
                    >
                      <div className="breakdown-ring-center">
                        <span>Total</span>
                        <strong>{formatMoney(totals.actual)}</strong>
                      </div>
                    </div>
                    <div className="breakdown-compact-right">
                      <div className="breakdown-compact-header">
                        <div>
                          <div className="breakdown-compact-title">Spending by category</div>
                          <div className="breakdown-compact-sub">{spendingBreakdown.length} categories</div>
                        </div>
                        <div className="breakdown-compact-cta">View all →</div>
                      </div>
                      <div className="breakdown-compact-chips">
                        {spendingBreakdown.slice(0, 3).map(c => (
                          <div className="breakdown-chip" key={c.id}>
                            <span className="breakdown-chip-dot" style={{ background: c.color }} />
                            <span className="breakdown-chip-name">{c.name}</span>
                            <span className="breakdown-chip-amt">{formatMoney(c.actual)}</span>
                          </div>
                        ))}
                        {spendingBreakdown.length > 3 && (
                          <div className="breakdown-chip breakdown-chip--more">
                            +{spendingBreakdown.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Category breakdown modal */}
              <Modal
                isOpen={showCategoryBreakdown}
                onClose={() => setShowCategoryBreakdown(false)}
                title="Spending by category"
                className="category-breakdown-modal"
              >
                <div className="modal-body">
                  <div className="cbm-donut-wrap">
                    <div
                      className="breakdown-ring breakdown-ring--lg"
                      style={{ background: `conic-gradient(${breakdownGradient})` }}
                      aria-hidden="true"
                    >
                      <div className="breakdown-ring-center">
                        <span>Total</span>
                        <strong>{formatMoney(totals.actual)}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="cbm-list">
                    {spendingBreakdown.map(c => {
                      const pct = Math.max(1, Math.round((c.actual / totals.actual) * 100));
                      return (
                        <div className="cbm-item" key={c.id}>
                          <div className="cbm-item-top">
                            <div className="cbm-icon" style={{ color: c.color }}>{c.icon}</div>
                            <div className="cbm-name">{c.name}</div>
                            <div className="cbm-amount">{formatMoney(c.actual)}</div>
                            <div className="cbm-pct">{pct}%</div>
                          </div>
                          <div className="cbm-bar-track">
                            <div className="cbm-bar-fill" style={{ width: `${pct}%`, background: c.color }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Modal>

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
                <p className="muted">Track expenses visible to you. Trip totals can include private aggregates.</p>
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
                {!demoMode ? (
                  <button
                    className="primary-button expense-toolbar-add"
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
                <article
                  className={`expense-summary-card${card.mobileOptional ? " mobile-optional" : ""}`}
                  key={card.label}
                >
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

        {activeTab === "tasks" ? (() => {
          const taskStats = [
            { label: "Assigned to me", value: taskSummary.assignedToMeCount, tone: "mint" },
            { label: "Group tasks", value: taskSummary.groupTaskCount, tone: "blue" },
            { label: "Pending", value: taskSummary.pendingCount, tone: "peach" },
            { label: "Done", value: taskSummary.doneCount, tone: "violet" }
          ];
          const filteredTasks = visibleTasks.filter(task => {
            if (taskFilter === "assigned") return task.assignedTo?.includes(currentUserMemberId);
            if (taskFilter === "group") return task.scope === "group";
            if (taskFilter === "private") return task.scope === "personal" || task.scope === "selected_members";
            if (taskFilter === "done") return task.status === "done";
            return true;
          });
          const emptyCopy = {
            all: ["No tasks yet.", "Create your first trip task to keep everyone organized."],
            assigned: ["Nothing assigned to you.", "You're all caught up."],
            group: ["No group tasks yet.", "Add shared tasks like bookings, receipts, or payment reminders."],
            private: ["No private tasks yet.", "Private tasks are only visible to you or selected members."],
            done: ["No completed tasks yet.", "Completed tasks will appear here."]
          }[taskFilter] || ["No tasks yet.", "Create your first trip task to keep everyone organized."];

          return (
            <section className="tasks-page">
              <div className="tasks-head">
                <div>
                  <h2>Trip Tasks</h2>
                  <p className="muted">Plan, assign, and track what needs to be done.</p>
                </div>
                {!demoMode ? (
                  <button className="primary-button" type="button" onClick={openBulkTaskModal}>
                    + New task
                  </button>
                ) : null}
              </div>

              <div className="task-summary-grid">
                {taskStats.map(stat => (
                  <article className="task-summary-card" key={stat.label}>
                    <span className={`task-summary-icon ${stat.tone}`}>✓</span>
                    <div>
                      <strong>{stat.value}</strong>
                      <p>{stat.label}</p>
                    </div>
                  </article>
                ))}
              </div>

              <div className="task-filter-pills">
                {[
                  ["all", "All"],
                  ["assigned", "Assigned to me"],
                  ["group", "Group"],
                  ["private", "Private"],
                  ["done", "Done"]
                ].map(([value, label]) => (
                  <button
                    key={value}
                    className={taskFilter === value ? "active" : ""}
                    type="button"
                    onClick={() => setTaskFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {selectedTaskIds.size > 0 && !demoMode && (
                <div className="task-select-bar">
                  <span className="task-select-info">
                    {selectedTaskIds.size} task{selectedTaskIds.size === 1 ? "" : "s"} selected
                  </span>
                  <div className="task-select-actions">
                    <button
                      type="button"
                      className="primary-button small-button"
                      onClick={() => {
                        setBulkAssignMode("group");
                        setBulkAssignMemberIds(currentUserMemberId ? [currentUserMemberId] : []);
                        setIsBulkAssignOpen(true);
                      }}
                    >
                      Assign to…
                    </button>
                    <button
                      type="button"
                      className="secondary-button small-button"
                      onClick={() => setSelectedTaskIds(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              <div className="task-list">
                {filteredTasks.length === 0 ? (
                  <div className="task-empty-state">
                    <h3>{emptyCopy[0]}</h3>
                    <p className="muted">{emptyCopy[1]}</p>
                  </div>
                ) : (
                  filteredTasks.map(task => {
                    const isDone = task.status === "done";
                    const canComplete = canUserCompleteTask(task, currentUserMemberId);
                    const canEdit = canUserEditTask(task, currentUserMemberId, canManageSelectedTrip());
                    const isSelected = selectedTaskIds.has(task.id);
                    const completedText = task.completedBy
                      ? `Done by ${memberNameOf(task.completedBy)}${task.completedAt?.toDate ? ` · ${task.completedAt.toDate().toLocaleDateString()}` : ""}`
                      : "Done";
                    return (
                      <article className={`task-card${isDone ? " done" : ""}${isSelected ? " task-selected" : ""}`} key={task.id}>
                        {!demoMode && (
                          <input
                            type="checkbox"
                            className="task-select-checkbox"
                            checked={isSelected}
                            onChange={e => {
                              setSelectedTaskIds(prev => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(task.id);
                                else next.delete(task.id);
                                return next;
                              });
                            }}
                            aria-label="Select task"
                          />
                        )}
                        <button
                          className="task-status-button"
                          type="button"
                          disabled={!canComplete}
                          aria-label={isDone ? "Reopen task" : "Mark task done"}
                          onClick={() => isDone ? handleReopenTask(task) : handleMarkTaskDone(task)}
                        >
                          <span aria-hidden="true">{isDone ? "✓" : ""}</span>
                        </button>
                        <div className="task-card-main">
                          <div className="task-card-title-row">
                            <h3>{task.title}</h3>
                            <span className={`pill${isDone ? " muted-pill" : ""}`}>{isDone ? "Done" : "Todo"}</span>
                          </div>
                          <p className="task-meta">
                            {isDone
                              ? completedText
                              : `${taskTypeLabel(task.type)} · ${taskScopeLabel(task.scope)} task · Assigned to ${taskMemberListLabel(task.assignedTo)}`}
                            {task.dueDate && !isDone ? ` · Due ${formatTaskDate(task.dueDate)}` : ""}
                          </p>
                          {task.notes ? <p className="task-notes">{task.notes}</p> : null}
                        </div>
                        {!demoMode ? (
                          <div className="task-card-actions">
                            {canComplete ? (
                              <button className="secondary-button small-button" type="button" onClick={() => isDone ? handleReopenTask(task) : handleMarkTaskDone(task)}>
                                {isDone ? "Undo" : "Mark done"}
                              </button>
                            ) : null}
                            {canEdit ? (
                              <>
                                <button className="secondary-button small-button" type="button" onClick={() => startEditingTask(task)}>Edit</button>
                                <button className="danger-button small-button" type="button" onClick={() => handleArchiveTask(task)}>Archive</button>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })() : null}

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
                    <span aria-hidden="true">⌕</span>
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
                              {category.icon || "📌"}
                            </span>
                            <div className="category-table-main">
                              <strong>{category.name}</strong>
                              <span>{category.type}</span>
                            </div>
                            <span className={category.isActive ? "pill" : "pill muted-pill"}>
                              {category.isActive ? "Active" : "Inactive"}
                            </span>
                            <span className="category-usage">◔ {usageLabel}</span>
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
                              {categoryForm.color === color ? "✓" : ""}
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
                            {categoryForm.icon || "📌"}
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

            <div className="settings-list settings-section-sm">
              <p><strong>Status:</strong> {selectedTrip.status}</p>
              <p><strong>Members:</strong> {members.length}</p>
              <p><strong>Active members:</strong> {activeMembers.length}</p>
              <p><strong>Settlements:</strong> {settlements.length}</p>
              <p>
                <strong>Your access:</strong>{" "}
                {selectedTrip.accessRole === "owner" ? "Owner" : "Member"}
              </p>
            </div>

            <section className="settings-section">
              <h2>Export</h2>
              <p className="small muted">
                Downloads a formatted Excel workbook (.xlsx) with 6 sheets: Summary, Members, Expenses, Categories, Settlements, and Tasks. Opens directly in Excel or Google Sheets with colour-coded formatting.
              </p>
              <p className="small muted settings-section-sm" style={{ marginTop: 0 }}>
                Other members' personal expense details are redacted for privacy. The file is marked confidential.
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={exportTripSummaryCsv}
              >
                Export trip workbook (.xlsx)
              </button>
            </section>

            <section className="settings-section">
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

            <section className="settings-section">
              <h2>Support the App</h2>
              <p className="small muted">Like TripHisaab? Buy me a Coffee! ☕</p>
              <DonateButton inline />
            </section>

            <section className="settings-section">
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
              <div className="settings-list settings-section-sm">
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
                showToast("Trip data refreshed.", "success");
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
                    expenses, settlements, tasks, plan budget, categories, and invite links.
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
          {[
            { key: "dashboard",   label: "Overview", icon: "⊞" },
            { key: "actual",      label: "Expenses", icon: "💳" },
            { key: "settlements", label: "Settle",   icon: "🤝" },
            { key: "prediction",  label: "Budget",   icon: "📊" },
            { key: "tasks",       label: "Tasks",    icon: "✓"  },
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
          className={`floating-add-expense${activeTab === "actual" ? " floating-add-expense--hidden-mobile" : ""}`}
          type="button"
          aria-label="Add expense"
          onClick={() => openFastExpenseModal()}
        >
          <span className="floating-add-icon">+</span>
          <span className="floating-add-label">Add Expense</span>
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

        {appToast ? (
          <div className={`app-toast app-toast--${appToast.type}`} role="alert">
            {appToast.message}
          </div>
        ) : null}

        <Modal
          isOpen={Boolean(pendingSmartSettlement)}
          onClose={() => setPendingSmartSettlement(null)}
          title="Mark this settlement as paid?"
        >
          <div className="modal-body">
            {pendingSmartSettlement ? (() => {
              const s = pendingSmartSettlement.suggestion;
              const isUnit = s.fromType === "unit";
              const unitMemberIds = isUnit
                ? (settlementGroups.find(g => g.id === s.fromUnitId)?.memberIds || [])
                : [];
              const unitMembers = unitMemberIds
                .map(id => members.find(m => m.id === id))
                .filter(Boolean);
              return (
                <div className="confirm-settlement-card">
                  <p className="small muted">
                    <strong>{cleanDisplayName(s.fromName)}</strong> pays{" "}
                    <strong>{cleanDisplayName(s.toName)}</strong>
                  </p>

                  {isUnit && unitMembers.length > 1 && (
                    <div className="form-row">
                      <label className="form-label">Who physically pays?</label>
                      <select
                        className="form-input"
                        value={pendingSettleActualPayer}
                        onChange={e => setPendingSettleActualPayer(e.target.value)}
                      >
                        {unitMembers.map(m => (
                          <option key={m.id} value={m.id}>
                            {cleanDisplayName(memberDisplayName(m))}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="form-row">
                    <label className="form-label">
                      Amount
                      {Number(pendingSettleAmount) !== Number(s.amount)
                        ? <span className="small muted"> (suggested {formatMoney(s.amount)})</span>
                        : null}
                    </label>
                    <input
                      className="form-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={pendingSettleAmount}
                      onChange={e => setPendingSettleAmount(e.target.value)}
                    />
                  </div>
                </div>
              );
            })() : null}
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
                      pendingSmartSettlement.settlementGroupId,
                      pendingSettleAmount,
                      pendingSettleActualPayer || null
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
          className="expense-modal"
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
          className="expense-modal"
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

        {/* Create / edit task modal */}
        <Modal
          isOpen={isTaskModalOpen}
          onClose={closeTaskModal}
          title={editingTaskId ? "Edit task" : "New task"}
        >
          <form className="modal-form task-form" onSubmit={handleSaveTask}>
            <div className="modal-body">
              <p className="small muted">
                Add tasks for bookings, receipts, payments, packing, and documents.
              </p>

              <label>
                Task title
                <input
                  type="text"
                  value={taskForm.title}
                  placeholder="e.g. Upload hotel receipt"
                  onChange={e => setTaskForm({ ...taskForm, title: e.target.value })}
                  autoFocus
                  required
                />
              </label>

              <div className="grid-2">
                <label>
                  Type
                  <select
                    value={taskForm.type}
                    onChange={e => setTaskForm({ ...taskForm, type: e.target.value })}
                  >
                    {TASK_TYPE_OPTIONS.map(option => (
                      <option value={option.value} key={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Due date
                  <input
                    type="date"
                    value={taskForm.dueDate}
                    onClick={openDatePicker}
                    onChange={e => setTaskForm({ ...taskForm, dueDate: e.target.value })}
                  />
                </label>
              </div>

              <div className="task-form-section">
                <div className="create-trip-img-label">Assign to</div>
                <div className="checkbox-grid compact-checkbox-grid">
                  {activeMembers.map(member => {
                    const checked = taskForm.assignedTo.includes(member.id);
                    const lockedToMe = taskForm.scope === "personal" && member.id !== currentUserMemberId;
                    return (
                      <label className="check-row" key={member.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={lockedToMe}
                          onChange={e => {
                            const assignedTo = e.target.checked
                              ? [...taskForm.assignedTo, member.id]
                              : taskForm.assignedTo.filter(id => id !== member.id);
                            setTaskForm({ ...taskForm, assignedTo });
                          }}
                        />
                        {memberNameOf(member.id)}
                      </label>
                    );
                  })}
                </div>
              </div>

              <label>
                Visibility
                <select
                  value={taskForm.scope}
                  onChange={e => {
                    const scope = e.target.value;
                    setTaskForm(current => ({
                      ...current,
                      scope,
                      selectedMemberIds:
                        scope === "selected_members" && currentUserMemberId && !current.selectedMemberIds.includes(currentUserMemberId)
                          ? [...current.selectedMemberIds, currentUserMemberId]
                          : current.selectedMemberIds,
                      assignedTo:
                        scope === "personal" && currentUserMemberId
                          ? [currentUserMemberId]
                          : current.assignedTo
                    }));
                  }}
                >
                  {TASK_SCOPE_OPTIONS.map(option => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              {taskForm.scope === "selected_members" ? (
                <div className="task-form-section">
                  <div className="create-trip-img-label">Selected people</div>
                  <p className="small muted">Group tasks are visible to everyone. Private tasks stay with selected members.</p>
                  <div className="checkbox-grid compact-checkbox-grid">
                    {activeMembers.map(member => {
                      const checked = taskForm.selectedMemberIds.includes(member.id);
                      const isCreator = member.id === currentUserMemberId;
                      return (
                        <label className="check-row" key={member.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isCreator}
                            onChange={e => {
                              const selectedMemberIds = e.target.checked
                                ? [...taskForm.selectedMemberIds, member.id]
                                : taskForm.selectedMemberIds.filter(id => id !== member.id);
                              setTaskForm({ ...taskForm, selectedMemberIds });
                            }}
                          />
                          {memberNameOf(member.id)}{isCreator ? " (you)" : ""}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <label>
                Notes
                <textarea
                  value={taskForm.notes}
                  placeholder="Optional details"
                  onChange={e => setTaskForm({ ...taskForm, notes: e.target.value })}
                  rows={3}
                />
              </label>
            </div>

            <footer className="modal-footer">
              <button className="secondary-button" type="button" onClick={closeTaskModal}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={savingTask}>
                {savingTask ? "Saving..." : editingTaskId ? "Save changes" : "Create task"}
              </button>
            </footer>
          </form>
        </Modal>

        {/* Bulk task creation modal */}
        <Modal isOpen={isBulkTaskModalOpen} onClose={closeBulkTaskModal} title="Add Tasks">
          <form className="modal-form" onSubmit={handleSaveBulkTasks}>
            <div className="modal-body">
              <p className="small muted">
                Tasks are saved as personal tasks by default. Select and assign them to members after.
              </p>
              <div className="bulk-task-list">
                {bulkTaskRows.map((row, i) => (
                  <div className="bulk-task-row" key={row.id}>
                    <span className="bulk-task-num">{i + 1}</span>
                    <input
                      type="text"
                      placeholder="Task title"
                      value={row.title}
                      autoFocus={i === 0}
                      onChange={e => setBulkTaskRows(rows => rows.map(r => r.id === row.id ? { ...r, title: e.target.value } : r))}
                    />
                    <select
                      value={row.type}
                      onChange={e => setBulkTaskRows(rows => rows.map(r => r.id === row.id ? { ...r, type: e.target.value } : r))}
                    >
                      {TASK_TYPE_OPTIONS.map(o => <option value={o.value} key={o.value}>{o.label}</option>)}
                    </select>
                    {bulkTaskRows.length > 1 && (
                      <button
                        type="button"
                        className="bulk-task-remove"
                        aria-label="Remove row"
                        onClick={() => setBulkTaskRows(rows => rows.filter(r => r.id !== row.id))}
                      >×</button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="bulk-task-add-btn"
                onClick={() => setBulkTaskRows(rows => [...rows, { id: Date.now(), title: "", type: "general" }])}
              >
                + Add another task
              </button>
            </div>
            <footer className="modal-footer">
              <button type="button" className="secondary-button" onClick={closeBulkTaskModal}>Cancel</button>
              <button type="submit" className="primary-button" disabled={savingBulkTasks}>
                {savingBulkTasks
                  ? "Saving…"
                  : (() => {
                      const n = bulkTaskRows.filter(r => r.title.trim()).length;
                      return `Create ${n || ""} task${n === 1 ? "" : "s"}`.trim();
                    })()}
              </button>
            </footer>
          </form>
        </Modal>

        {/* Bulk assign modal */}
        <Modal
          isOpen={isBulkAssignOpen}
          onClose={() => { setIsBulkAssignOpen(false); setBulkAssignMode("group"); setBulkAssignMemberIds([]); }}
          title={`Assign ${selectedTaskIds.size} task${selectedTaskIds.size === 1 ? "" : "s"}`}
        >
          <div className="modal-body">
            <div className="bulk-assign-toggle">
              <button
                type="button"
                className={bulkAssignMode === "group" ? "active" : ""}
                onClick={() => setBulkAssignMode("group")}
              >
                Group task
              </button>
              <button
                type="button"
                className={bulkAssignMode === "members" ? "active" : ""}
                onClick={() => setBulkAssignMode("members")}
              >
                Select members
              </button>
            </div>
            {bulkAssignMode === "group" ? (
              <p className="small muted" style={{ marginTop: 14 }}>
                Tasks will be visible to all trip members and assigned to everyone.
              </p>
            ) : (
              <div className="task-form-section" style={{ marginTop: 14 }}>
                <p className="small muted">Choose who to assign these tasks to. You are always included.</p>
                <div className="checkbox-grid compact-checkbox-grid" style={{ marginTop: 10 }}>
                  {activeMembers.map(member => {
                    const isMe = member.id === currentUserMemberId;
                    const checked = isMe || bulkAssignMemberIds.includes(member.id);
                    return (
                      <label className="check-row" key={member.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={isMe}
                          onChange={e => setBulkAssignMemberIds(ids =>
                            e.target.checked
                              ? [...ids, member.id]
                              : ids.filter(id => id !== member.id)
                          )}
                        />
                        {memberNameOf(member.id)}{isMe ? " (you)" : ""}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <footer className="modal-footer">
            <button
              type="button"
              className="secondary-button"
              onClick={() => { setIsBulkAssignOpen(false); setBulkAssignMode("group"); setBulkAssignMemberIds([]); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={savingBulkAssign}
              onClick={handleBulkAssign}
            >
              {savingBulkAssign ? "Assigning…" : "Assign"}
            </button>
          </footer>
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
        {renderBetaWelcome()}
        {renderFeedbackWidget(true)}
      </div>
    );
  }

  function renderLandingPage() {
    const displayName = user?.displayName || user?.email?.split("@")[0] || "traveler";
    return (
      <main className="landing-page">
        <div className="landing-bg" aria-hidden="true">
          <img className="landing-bg-gradient" src="/LandingPage/BG gradient.svg" alt="" />
          <img className="landing-bg-left"     src="/LandingPage/landing-left.svg"  alt="" />
          <img className="landing-bg-right"    src="/LandingPage/landing-right.svg" alt="" />
          {/* Animated SVG layer: dashed trail + plane following it + cover clouds above */}
          <svg className="landing-bg-anim" viewBox="0 0 1024 238" xmlns="http://www.w3.org/2000/svg" overflow="visible">
            {/* Dashed trail — also used as the motion path via id */}
            <path id="lp-trail"
              d="M2 179.072C8.56862 72.4023 233.263 30.2698 324.003 114.285C485.76 264.053 657.131 269.17 802.213 164.85C897.651 96.2256 907.287 23.845 1024 2.00037"
              fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeDasharray="10 20" opacity="0.85"/>
            {/* Plane group — animateMotion drives position+rotation along trail */}
            <g>
              <animateMotion dur="24s" repeatCount="indefinite" rotate="auto">
                <mpath href="#lp-trail"/>
              </animateMotion>
              <g className="lp-plane-shape">
                <path d="M15.9823 40.9868C15.2238 40.7476 15.2039 40.1703 15.8739 38.1382C16.3395 36.7412 16.8791 35.4918 17.0793 35.365C17.6987 34.9727 16.6789 33.8682 15.5591 33.7282C14.0059 32.5132 14.5888 32.0002 16.2052 31.1537C17.6302 30.6012 17.6404 30.504 16.5059 28.0135C15.0941 24.9207 15.3373 24.2027 17.6522 24.6425C18.8598 24.8695 19.9689 25.6516 21.2086 27.1548L23.0106 29.3393L28.6438 28.8572C32.8862 28.4975 34.2793 28.1727 34.2895 27.5504C34.3099 26.1306 32.0015 17.998 30.6198 14.6334C29.8907 12.865 29.4581 11.3173 29.6537 11.1935C29.8493 11.0696 30.8146 11.0481 31.8042 11.1474C33.0862 11.2755 34.0821 11.8894 35.2965 13.3114C36.2416 14.4114 37.7472 15.4999 38.6807 15.7578L40.3645 16.2214L39.7594 17.5836C38.8879 19.5553 40.1004 21.1082 42.4579 21.0283C44.939 20.9478 45.8525 22.554 44.1229 23.9542C43.103 24.7752 43.0651 25.1169 43.873 26.3815C44.719 27.7063 45.2619 27.8421 49.4802 27.7636C56.4351 27.6372 58.4875 27.8996 60.7124 29.2068C64.4721 31.4219 64.463 32.5816 60.6583 34.9914C58.3811 36.4337 56.9814 36.6655 49.9493 36.7629C45.2994 36.8296 44.1762 37.2817 43.1469 39.509C42.862 40.1303 43.0363 40.4672 43.8878 40.9457C44.7649 41.4339 44.9453 41.8318 44.7377 42.7607C44.3858 44.3061 44.0934 44.4524 41.872 44.2321C40.1606 44.0649 39.9673 44.1614 39.3748 45.4508C38.9085 46.4657 38.9888 47.1279 39.6602 47.8372C40.8602 49.1128 39.8837 50.5481 38.0342 50.235C36.8062 50.0274 36.581 50.1765 34.9179 52.2996C33.2356 54.4542 33.0336 54.5886 31.4359 54.5698C29.2904 54.5413 29.0505 54.1422 29.8558 51.9012C31.5403 47.2169 34.3609 37.1063 34.0527 36.8672C33.858 36.7247 31.271 36.36 28.2928 36.0681L22.8879 35.5304L20.9317 37.7677C19.4074 39.7471 18.3853 40.3994 15.9823 40.9868Z" fill="#EF917E"/>
              </g>
            </g>
            {/* START cover cloud — drawn above plane; hides plane at loop reset (offset 0%) */}
            <image href="/LandingPage/cloud_4.svg" x="-88" y="148" width="180" height="84">
              <animateTransform attributeName="transform" type="translate" values="0 0; 6 -4; 0 0" dur="8s" repeatCount="indefinite"/>
            </image>
            {/* END cover cloud — drawn above plane; hides plane as it finishes path (offset 100%) */}
            <image href="/LandingPage/cloud_4.svg" x="932" y="-44" width="190" height="88">
              <animateTransform attributeName="transform" type="translate" values="0 0; -5 4; 0 0" dur="10s" repeatCount="indefinite"/>
            </image>
          </svg>
          {/* Background drifting clouds — drift right→left (opposite to plane direction) */}
          <img className="landing-bg-cloud landing-bg-cloud--1" src="/LandingPage/cloud_4.svg" alt="" />
          <img className="landing-bg-cloud landing-bg-cloud--2" src="/LandingPage/cloud_4.svg" alt="" />
          <img className="landing-bg-cloud landing-bg-cloud--3" src="/LandingPage/cloud_4.svg" alt="" />
          <img className="landing-bg-cloud landing-bg-cloud--4" src="/LandingPage/cloud_4.svg" alt="" />
        </div>
        <section className="landing-shell">
          <img className="landing-logo" src="/landingPage-logo.svg" alt="TripHisaab" />
          <p className="landing-tagline">Every trip. Every spend. Sorted.</p>

          <div className="landing-copy">
            <h1>Plan, split, and track your trip expenses — all in one place.</h1>
            <p>
              Budget before you travel, log expenses on the go, split costs with your group,
              and settle up in seconds. Simple, free, and yours forever.
            </p>
          </div>

          <div className="landing-actions">
            {user ? (
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
                Continue as {displayName.split(' ')[0]}
              </button>
            ) : (
              <button className="primary-button landing-google" type="button" onClick={handleGoogleLogin}>
                Sign in with Google
              </button>
            )}
            <button className="secondary-button" type="button" onClick={openDemoTrip}>
              Try Demo Trip
            </button>
            <button
              className="landing-privacy-btn"
              type="button"
              onClick={() => document.getElementById('privacy-section')?.scrollIntoView({ behavior: 'smooth' })}
            >
              🔒 Privacy Promise
            </button>
          </div>

          {user && (
            <button
              className="landing-switch-link"
              type="button"
              onClick={async () => {
                await signOut(auth);
                setShowLanding(false);
                await signInWithPopup(auth, googleProvider);
              }}
            >
              Not you? Switch account
            </button>
          )}

          <p className="landing-secondary">
            Each trip exports as a CSV file, so your data stays editable and always with you.
          </p>
        </section>

        <section className="landing-privacy" id="privacy-section">
          <div className="landing-privacy-header">
            <span className="landing-privacy-badge">Privacy</span>
            <h2>Your data, plainly spoken</h2>
            <p>No legal jargon. Just an honest explanation of what we collect, why, and what we never do.</p>
          </div>

          <div className="landing-privacy-grid">
            <div className="landing-privacy-block">
              <span className="landing-privacy-icon">📥</span>
              <div>
                <strong>What we collect</strong>
                <p>When you sign in with Google, we receive your name, email address, and profile photo. That is it. Inside the app, we store only what you create: trips, expenses, budgets, members, tasks, and settlements. We never read anything from your Google account beyond these three basics.</p>
              </div>
            </div>

            <div className="landing-privacy-block">
              <span className="landing-privacy-icon">👁️</span>
              <div>
                <strong>Who can see your trips</strong>
                <p>Only you and the people you personally invite can see a trip's data. Nobody outside your group can browse your expenses. Trip owners control who has access and can remove any member at any time.</p>
              </div>
            </div>

            <div className="landing-privacy-block">
              <span className="landing-privacy-icon">🏦</span>
              <div>
                <strong>We never touch real money</strong>
                <p>TripHisaab only records numbers you type in. We have no connection to your bank, your cards, or any payment system. We cannot see, move, or access any real funds — ever.</p>
              </div>
            </div>

            <div className="landing-privacy-block">
              <span className="landing-privacy-icon">🚫</span>
              <div>
                <strong>What we never do</strong>
                <p>We do not sell your data. We do not share it with advertisers. We do not run ads inside the app. We do not profile you, track you across other websites, or use your data for anything beyond making the app work for you.</p>
              </div>
            </div>

            <div className="landing-privacy-block">
              <span className="landing-privacy-icon">☁️</span>
              <div>
                <strong>Where it lives</strong>
                <p>All data is stored on Google Firebase — an encrypted, secure cloud service. We do not run our own servers. Your data benefits from the same security infrastructure that powers products used by billions of people.</p>
              </div>
            </div>

            <div className="landing-privacy-block">
              <span className="landing-privacy-icon">🎛️</span>
              <div>
                <strong>You stay in control</strong>
                <p>Export any trip as a CSV file anytime. Delete a trip and all its data permanently whenever you want. Your data belongs to you — we are just holding it while you need it.</p>
              </div>
            </div>
          </div>

          <p className="landing-privacy-footer">
            Questions or concerns about your data?{" "}
            <a href="mailto:wayabove@gmail.com" className="landing-privacy-link">Reach us at wayabove@gmail.com.</a>
            {" "}We reply to every message.
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
                <div className="home-stat-icon home-stat-icon--work">💼</div>
                <div>
                  <div className="home-stat-label">Total trips</div>
                  <div className="home-stat-num">{trips.length}</div>
                  <div className="home-stat-sub">All time</div>
                </div>
              </div>
              <div className="home-stat-card">
                <div className="home-stat-icon home-stat-icon--travel">✈️</div>
                <div>
                  <div className="home-stat-label">Active trips</div>
                  <div className="home-stat-num">{activeTripCount}</div>
                  <div className="home-stat-sub">Currently active</div>
                </div>
              </div>
              <div className="home-stat-card">
                <div className="home-stat-icon home-stat-icon--calendar">📅</div>
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
                    <div className="home-trip-body">
                      <h3 className="home-trip-name">{trip.name}</h3>
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
      {renderBetaWelcome()}
      {renderFeedbackWidget()}
    </div>
  );
  }
}

export default App;
