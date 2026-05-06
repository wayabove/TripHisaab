import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const CATEGORY_EMOJI_OPTIONS = [
  "📌", "✈️", "🚆", "🚕", "🚌", "⛽", "🏨", "🏠",
  "🍽️", "☕", "🍕", "🛒", "🛍️", "🎟️", "🎡", "🏖️",
  "💸", "💳", "🧾", "🎁", "💊", "📱", "🧳", "✨"
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
    body: "Open any trip to access its tabs: log Expenses, plan ahead with Predictions, manage Members, view Balances, and adjust Settings.",
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
    setVisible(false);
    const update = () => {
      const found = findTarget(current.targets);
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
  }, [step]);

  useEffect(() => {
    if (!tooltipRef.current) return;
    const tid = setTimeout(() => {
      if (!tooltipRef.current) return;
      const PAD = 16;
      const tt = tooltipRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top, left;
      const pos = spotlight ? current.position : "center";

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
  }, [spotlight, step]);

  const next = () => {
    if (step < TOUR_STEPS.length - 1) setStep(s => s + 1);
    else onComplete();
  };
  const prev = () => setStep(s => s - 1);
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
  const idRef = useRef("paypal-donate-" + Math.random().toString(36).slice(2));

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
  const [isTutorialOpen, setIsTutorialOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [tripSearch, setTripSearch] = useState("");

  const [selectedTrip, setSelectedTrip] = useState(null);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [tripDataLoading, setTripDataLoading] = useState(false);

  // -------------------- Trip data --------------------
  const [members, setMembers] = useState([]);
  const [memberProfilesByEmail, setMemberProfilesByEmail] = useState({});
  const [categories, setCategories] = useState([]);
  const [predictions, setPredictions] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [settlements, setSettlements] = useState([]);

  // -------------------- Forms --------------------
  const [memberForm, setMemberForm] = useState({ displayName: "", email: "" });
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

  const [predictionDraft, setPredictionDraft] = useState({});
  const [savingPredictions, setSavingPredictions] = useState(false);

  const [settingsTripForm, setSettingsTripForm] = useState({
    name: "",
    startDate: "",
    endDate: "",
    defaultCurrency: "EUR",
    imageDataUrl: ""
  });
  const [savingTripSettings, setSavingTripSettings] = useState(false);

  const [savingExpense, setSavingExpense] = useState(false);
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

  const [categoryForm, setCategoryForm] = useState({
    name: "",
    type: "Daily",
    icon: "📌",
    color: "#0F766E"
  });
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [savingCategory, setSavingCategory] = useState(false);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
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
    status: "Active"
  });

  // -------------------- Effects --------------------
  useEffect(() => {
    loadLiveExchangeRates();
    const inviteFromUrl = getInviteFromUrl();
    if (inviteFromUrl) setPendingInvite(inviteFromUrl);
    const preloadTimer = window.setTimeout(() => {
      setInitialPreloading(false);
    }, 1800);
    return () => window.clearTimeout(preloadTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async currentUser => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser) {
        await createUserProfileIfNeeded(currentUser);
        await loadTrips(currentUser.uid, currentUser.email);
      } else {
        setTrips([]);
        setSelectedTrip(null);
        setUserProfile({
          profileImageDataUrl: "",
          tutorialCompletedAt: null,
          loaded: false
        });
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !userProfile.loaded || pendingInvite) return;
    if (!userProfile.tutorialCompletedAt) setIsTutorialOpen(true);
  }, [pendingInvite, user, userProfile.loaded, userProfile.tutorialCompletedAt]);

  useEffect(() => {
    if (user && pendingInvite) loadInviteDetails(pendingInvite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const predictionsByCategoryId = useMemo(() => {
    const map = new Map();
    predictions.forEach(p => map.set(p.categoryId, p));
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
    const predicted = predictions.reduce(
      (sum, p) => sum + Number(p.estimatedEur || 0),
      0
    );
    const settled = settlements.reduce(
      (sum, s) => sum + Number(s.amountEur || 0),
      0
    );
    return { predicted, actual, shared, settled };
  }, [expenses, predictions, settlements]);

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
      return m.displayName || m.email || "Unnamed member";
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
    const out = {};
    members.forEach(m => {
      out[m.id] = {
        memberId: m.id,
        name: m.displayName || m.email || "Unnamed member",
        email: m.email || "",
        paid: 0,
        owes: 0,
        settledPaid: 0,
        settledReceived: 0,
        net: 0
      };
    });

    expenses.forEach(expense => {
      if (expense.expenseType !== "shared") return;
      const amount = Number(expense.amountEur || 0);
      const payer = out[expense.paidByMemberId];
      if (!payer) return;
      payer.paid += amount;

      let owedShares;
      if (expense.splitType === "custom" && expense.customSplitSharesEur) {
        owedShares = expense.customSplitSharesEur;
      } else {
        const splitIds =
          expense.splitMemberIds?.length > 0
            ? expense.splitMemberIds
            : members.map(m => m.id);
        const share = splitIds.length > 0 ? amount / splitIds.length : 0;
        owedShares = {};
        splitIds.forEach(id => {
          owedShares[id] = share;
        });
      }

      Object.entries(owedShares).forEach(([memberId, share]) => {
        if (out[memberId]) out[memberId].owes += Number(share || 0);
      });
    });

    settlements.forEach(s => {
      const amount = Number(s.amountEur || 0);
      if (out[s.fromMemberId]) out[s.fromMemberId].settledPaid += amount;
      if (out[s.toMemberId]) out[s.toMemberId].settledReceived += amount;
    });

    Object.values(out).forEach(b => {
      b.net = b.paid - b.owes + b.settledPaid - b.settledReceived;
    });

    return Object.values(out);
  }, [members, expenses, settlements]);

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
  function canManageSelectedTrip() {
    return Boolean(user && selectedTrip && selectedTrip.ownerId === user.uid);
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
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Google login failed:", error);
      alert(
        "Google login failed. Check that Google sign-in is enabled in Firebase Authentication."
      );
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
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
    setCreatingInvite(true);
    try {
      const inviteRef = doc(collection(db, "trips", selectedTrip.id, "invites"));
      await setDoc(inviteRef, {
        tripId: selectedTrip.id,
        tripName: selectedTrip.name,
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

  function inviteShareMessage() {
    return `Join my trip "${selectedTrip?.name || "Trip"}": ${inviteLink}`;
  }

  async function shareInviteNative() {
    if (!inviteLink) return;
    const text = inviteShareMessage();
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
      const [ownerSnap, accessSnap] = await Promise.all([
        getDocs(query(collection(db, "trips"), where("ownerId", "==", userId))),
        emailLower
          ? getDocs(collection(db, "emailAccess", emailLower, "trips"))
          : Promise.resolve({ docs: [] })
      ]);

      ownerSnap.docs.forEach(d => {
        tripsMap.set(d.id, { id: d.id, accessRole: "owner", ...d.data() });
      });

      // Resolve all access trips in parallel
      const accessEntries = accessSnap.docs
        .map(d => ({ data: d.data(), tripId: d.data().tripId || d.id }))
        .filter(e => e.tripId && !tripsMap.has(e.tripId));

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
    } catch (error) {
      console.error("Could not load trips:", error);
      alert("Could not load trips. Check your Firestore rules.");
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

  function startEditingTrip(trip) {
    setEditingTripId(trip.id);
    setEditForm({
      name: trip.name || "",
      startDate: trip.startDate || todayIso(),
      endDate: trip.endDate || todayIso(),
      defaultCurrency: trip.defaultCurrency || "EUR",
      status: trip.status || "Active"
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEditingTrip() {
    setEditingTripId(null);
    setEditForm({
      name: "",
      startDate: todayIso(),
      endDate: todayIso(),
      defaultCurrency: "EUR",
      status: "Active"
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
        status: editForm.status,
        updatedAt: serverTimestamp()
      });
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

  async function openTrip(trip) {
    setSelectedTrip(trip);
    setActiveTab("dashboard");
    await loadTripData(trip.id);
  }

  function closeTrip() {
    setSelectedTrip(null);
    setActiveTab("dashboard");
    setMembers([]);
    setMemberProfilesByEmail({});
    setCategories([]);
    setPredictions([]);
    setExpenses([]);
    setSettlements([]);
    setPredictionDraft({});
    cancelCategoryForm();
    cancelEditingExpense();
    setMemberForm({ displayName: "", email: "" });
    resetSettlementForm();
    setInviteLink("");
  }

  async function loadTripData(tripId) {
    setTripDataLoading(true);
    try {
      // Parallelize all 5 reads — was the single biggest perf bottleneck.
      const [membersSnap, categoriesSnap, predictionsSnap, expensesSnap, settlementsSnap] =
        await Promise.all([
          getDocs(collection(db, "trips", tripId, "members")),
          getDocs(collection(db, "trips", tripId, "categories")),
          getDocs(collection(db, "trips", tripId, "predictions")),
          getDocs(collection(db, "trips", tripId, "expenses")),
          getDocs(collection(db, "trips", tripId, "settlements"))
        ]);

      const loadedMembers = membersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const loadedCategories = categoriesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const loadedPredictions = predictionsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const loadedExpenses = expensesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const loadedSettlements = settlementsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

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

      const draft = {};
      loadedCategories.forEach(category => {
        const existing = loadedPredictions.find(p => p.categoryId === category.id);
        draft[category.id] = existing ? String(existing.estimatedEur || "") : "";
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
      await loadMemberProfiles(loadedMembers);
      setCategories(loadedCategories);
      setPredictions(loadedPredictions);
      setExpenses(loadedExpenses);
      setSettlements(loadedSettlements);
      setPredictionDraft(draft);

      setExpenseForm(prev => ({
        ...prev,
        categoryId: prev.categoryId || firstActiveCategory?.id || "",
        originalCurrency:
          prev.originalCurrency || selectedTrip?.defaultCurrency || "EUR",
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
      setMemberForm({ displayName: "", email: "" });
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
      : `Deactivate ${memberNameOf(member.id)} and remove their trip access? Old expenses will stay visible.`;
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

  // -------------------- Predictions --------------------
  async function handleSavePredictions(event) {
    event.preventDefault();
    if (!selectedTrip) return;
    setSavingPredictions(true);
    try {
      // Run all writes in parallel (they're independent)
      await Promise.all(
        categories.map(category => {
          const amount = Number(predictionDraft[category.id]);
          const predictionRef = doc(
            db,
            "trips",
            selectedTrip.id,
            "predictions",
            category.id
          );
          if (amount > 0) {
            return setDoc(predictionRef, {
              categoryId: category.id,
              categoryName: category.name,
              estimatedEur: amount,
              notes: "",
              updatedAt: serverTimestamp()
            });
          }
          return deleteDoc(predictionRef).catch(() => {});
        })
      );
      await loadTripData(selectedTrip.id);
      alert("Predictions saved.");
    } catch (error) {
      console.error("Could not save predictions:", error);
      alert("Could not save predictions.");
    } finally {
      setSavingPredictions(false);
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
    if (formData.expenseType !== "shared" || formData.splitType !== "custom") {
      return true;
    }
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
    if (formData.splitType === "custom") {
      return getCustomSplitMemberIds(formData).filter(id => activeIds.includes(id));
    }
    const selected = (formData.splitMemberIds || []).filter(id =>
      activeIds.includes(id)
    );
    return selected.length > 0 ? selected : activeIds;
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

  // -------------------- Expenses --------------------
  async function handleAddExpense(event) {
    event.preventDefault();
    if (!selectedTrip) return;

    const originalAmount = Number(expenseForm.originalAmount);
    const originalCurrency = expenseForm.originalCurrency || "EUR";

    if (!expenseForm.categoryId) return alert("Choose a category.");
    if (!expenseForm.paidByMemberId) return alert("Choose who paid.");
    if (!originalAmount || originalAmount <= 0) return alert("Enter a valid amount.");
    if (!validateCustomSplit(expenseForm)) return;

    const splitMemberIds = getCleanSplitMemberIds(expenseForm);
    if (expenseForm.expenseType === "shared" && splitMemberIds.length === 0) {
      return alert("Choose at least one split member.");
    }

    setSavingExpense(true);
    try {
      const category = categoriesById.get(expenseForm.categoryId);
      await addDoc(collection(db, "trips", selectedTrip.id, "expenses"), {
        date: expenseForm.date,
        time: expenseForm.time,
        categoryId: expenseForm.categoryId,
        categoryName: category?.name || "",
        description: expenseForm.description.trim(),
        amountEur: convertToEur(originalAmount, originalCurrency),
        originalAmount,
        originalCurrency,
        exchangeRateFromEur: getCurrencyRate(originalCurrency),
        ratesSource: ratesMeta.source,
        ratesStatus: ratesMeta.status,
        ratesUpdatedAt: ratesMeta.updatedAt,
        paymentMethod: expenseForm.paymentMethod,
        notes: expenseForm.notes.trim(),
        expenseType: expenseForm.expenseType,
        splitType:
          expenseForm.expenseType === "shared" ? expenseForm.splitType : "none",
        customSplitSharesOriginal:
          expenseForm.expenseType === "shared" && expenseForm.splitType === "custom"
            ? expenseForm.customSplitShares
            : {},
        customSplitSharesEur:
          expenseForm.expenseType === "shared" && expenseForm.splitType === "custom"
            ? buildCustomSplitSharesEur(expenseForm)
            : {},
        paidByMemberId: expenseForm.paidByMemberId,
        paidByMemberName: memberNameOf(expenseForm.paidByMemberId),
        splitMemberIds,
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      setExpenseForm({
        ...expenseForm,
        date: todayIso(),
        time: nowTimeIso(),
        description: "",
        originalAmount: "",
        notes: "",
        customSplitShares: {}
      });
      setIsAddExpenseModalOpen(false);
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not save expense:", error);
      alert("Could not save expense.");
    } finally {
      setSavingExpense(false);
    }
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
            expenseEditForm.expenseType === "shared" &&
            expenseEditForm.splitType === "custom"
              ? expenseEditForm.customSplitShares
              : {},
          customSplitSharesEur:
            expenseEditForm.expenseType === "shared" &&
            expenseEditForm.splitType === "custom"
              ? buildCustomSplitSharesEur(expenseEditForm)
              : {},
          paidByMemberId: expenseEditForm.paidByMemberId,
          paidByMemberName: memberNameOf(expenseEditForm.paidByMemberId),
          splitMemberIds,
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

        // Cascade name update to expenses + prediction in a single batch
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
        const predictionRef = doc(
          db,
          "trips",
          selectedTrip.id,
          "predictions",
          editingCategoryId
        );
        const predictionSnap = await getDoc(predictionRef);
        if (predictionSnap.exists()) {
          batch.update(predictionRef, {
            categoryName: categoryForm.name.trim(),
            updatedAt: serverTimestamp()
          });
        }
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
    await saveSettlement(settlementForm);
    setIsSettlementModalOpen(false);
  }

  async function handleMarkSettlementPaid(suggested) {
    await saveSettlement({
      date: todayIso(),
      fromMemberId: suggested.fromMemberId,
      toMemberId: suggested.toMemberId,
      amountEur: suggested.amount,
      notes: "Marked paid from suggested settlement"
    });
  }

  async function saveSettlement(data) {
    if (!selectedTrip || !user) return;
    const amount = Number(data.amountEur);
    if (!data.fromMemberId || !data.toMemberId) return alert("Choose both people.");
    if (data.fromMemberId === data.toMemberId) {
      return alert("Payer and receiver cannot be the same person.");
    }
    if (!amount || amount <= 0) return alert("Enter a valid settlement amount.");

    setSavingSettlement(true);
    try {
      await addDoc(collection(db, "trips", selectedTrip.id, "settlements"), {
        date: data.date || todayIso(),
        fromMemberId: data.fromMemberId,
        fromMemberName: memberNameOf(data.fromMemberId),
        toMemberId: data.toMemberId,
        toMemberName: memberNameOf(data.toMemberId),
        amountEur: amount,
        notes: data.notes || "",
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      setSettlementForm({
        date: todayIso(),
        fromMemberId: data.fromMemberId,
        toMemberId: data.toMemberId,
        amountEur: "",
        notes: ""
      });
      await loadTripData(selectedTrip.id);
    } catch (error) {
      console.error("Could not record settlement:", error);
      alert("Could not settle up.");
    } finally {
      setSavingSettlement(false);
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

    rows.push(csvRow(["Predicted vs Actual"]));
    rows.push(csvRow(["Metric", "Amount EUR"]));
    rows.push(csvRow(["Predicted total", totals.predicted.toFixed(2)]));
    rows.push(csvRow(["Actual total", totals.actual.toFixed(2)]));
    rows.push(csvRow(["Shared expenses total", totals.shared.toFixed(2)]));
    rows.push(csvRow(["Settled total", totals.settled.toFixed(2)]));
    rows.push(csvRow(["Remaining / Over prediction", remaining.toFixed(2)]));
    rows.push("");

    rows.push(csvRow(["Category Breakdown"]));
    rows.push(csvRow(["Category", "Type", "Predicted EUR", "Actual EUR", "Difference EUR"]));
    categories.forEach(c => {
      const predicted = Number(predictionsByCategoryId.get(c.id)?.estimatedEur || 0);
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
        "Payment method", "Rate source", "Split details", "Notes"
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

    rows.push(csvRow(["Suggested Settlements"]));
    rows.push(csvRow(["From", "To", "Amount EUR"]));
    if (suggestedSettlements.length === 0) {
      rows.push(csvRow(["Everyone is settled up", "", ""]));
    } else {
      suggestedSettlements.forEach(s => {
        rows.push(csvRow([s.fromName, s.toName, s.amount.toFixed(2)]));
      });
    }
    rows.push("");

    rows.push(csvRow(["Settlement History"]));
    rows.push(csvRow(["Date", "From", "To", "Amount EUR", "Notes"]));
    settlements.forEach(s => {
      rows.push(
        csvRow([
          s.date || "",
          s.fromMemberName || memberNameOf(s.fromMemberId),
          s.toMemberName || memberNameOf(s.toMemberId),
          Number(s.amountEur || 0).toFixed(2),
          s.notes || ""
        ])
      );
    });

    downloadCsv(`${slugify(selectedTrip.name) || "trip"}-summary.csv`, rows.join("\n"));
  }

  // -------------------- Render: expense form --------------------
  function renderExpenseForm({ mode, formData, setFormData, onSubmit, saving, onCancel }) {
    const isEdit = mode === "edit";
    const previewEur = convertToEur(
      Number(formData.originalAmount || 0),
      formData.originalCurrency || "EUR"
    );

    return (
      <form className="modal-form" onSubmit={onSubmit}>
        <div className="modal-body">
          <p className="small muted">{ratesStatusLabel}</p>
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
                <option value={c.id} key={c.id}>
                  {c.icon} {c.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Description
            <input
              type="text"
              value={formData.description}
              placeholder="e.g. Lunch"
              onChange={e => setFormData({ ...formData, description: e.target.value })}
            />
          </label>

          <div className="grid-2">
            <label>
              Original amount
              <input
                type="number"
                min="0"
                step="0.01"
                value={formData.originalAmount}
                placeholder="0.00"
                onChange={e =>
                  setFormData({ ...formData, originalAmount: e.target.value })
                }
                required
              />
            </label>
            <label>
              Currency
              <select
                value={formData.originalCurrency}
                onChange={e =>
                  setFormData({ ...formData, originalCurrency: e.target.value })
                }
              >
                {SUPPORTED_CURRENCIES.map(c => (
                  <option value={c} key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>

          <p className="small muted">
            Converted estimate: <strong>{formatMoney(previewEur)}</strong> · 1 EUR ={" "}
            {getCurrencyRate(formData.originalCurrency).toFixed(4)}{" "}
            {formData.originalCurrency}
          </p>

          <label>
            Expense type
            <select
              value={formData.expenseType}
              onChange={e => {
                const nextType = e.target.value;
                setFormData({
                  ...formData,
                  expenseType: nextType,
                  splitType:
                    nextType === "shared" ? formData.splitType || "equal" : "equal",
                  splitMemberIds:
                    nextType === "shared"
                      ? activeMembers.map(m => m.id)
                      : formData.paidByMemberId
                      ? [formData.paidByMemberId]
                      : [],
                  customSplitShares:
                    nextType === "shared" ? formData.customSplitShares || {} : {}
                });
              }}
            >
              <option value="personal">Personal expense</option>
              <option value="shared">Shared expense</option>
            </select>
          </label>

          <label>
            Paid by
            <select
              value={formData.paidByMemberId}
              onChange={e =>
                setFormData({
                  ...formData,
                  paidByMemberId: e.target.value,
                  splitMemberIds:
                    formData.expenseType === "personal"
                      ? [e.target.value]
                      : formData.splitMemberIds
                })
              }
              required
            >
              <option value="">Choose payer</option>
              {activeMembers.map(m => (
                <option value={m.id} key={m.id}>{memberNameOf(m.id)}</option>
              ))}
            </select>
          </label>

          {formData.expenseType === "shared" ? (
            <div className="split-box">
              <strong>Split type</strong>
              <label>
                How should this be split?
                <select
                  value={formData.splitType || "equal"}
                  onChange={e =>
                    setFormData({
                      ...formData,
                      splitType: e.target.value,
                      splitMemberIds:
                        e.target.value === "equal"
                          ? activeMembers.map(m => m.id)
                          : formData.splitMemberIds,
                      customSplitShares:
                        e.target.value === "custom"
                          ? formData.customSplitShares || {}
                          : {}
                    })
                  }
                >
                  <option value="equal">Equal split</option>
                  <option value="custom">Custom exact amounts</option>
                </select>
              </label>

              {(formData.splitType || "equal") === "equal" ? (
                <>
                  <strong>Split equally between</strong>
                  <p className="small muted">
                    Select everyone who should share this expense.
                  </p>
                  <div className="checkbox-grid">
                    {activeMembers.map(m => (
                      <label className="check-row" key={m.id}>
                        <input
                          type="checkbox"
                          checked={(formData.splitMemberIds || []).includes(m.id)}
                          onChange={() =>
                            toggleSplitMember(formData, setFormData, m.id)
                          }
                        />
                        <span>{memberNameOf(m.id)}</span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <strong>Custom exact shares</strong>
                  <p className="small muted">
                    Enter each person's exact share in{" "}
                    {formData.originalCurrency || "EUR"}. The total must equal the
                    expense amount.
                  </p>
                  <div className="checkbox-grid">
                    {activeMembers.map(m => (
                      <label className="check-row" key={m.id}>
                        <span style={{ flex: 1 }}>{memberNameOf(m.id)}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={(formData.customSplitShares || {})[m.id] || ""}
                          placeholder="0.00"
                          onChange={e =>
                            updateCustomSplitShare(
                              formData,
                              setFormData,
                              m.id,
                              e.target.value
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p className="small muted">
                    Custom total:{" "}
                    <strong>
                      {formatCurrency(
                        getCustomSplitTotal(formData),
                        formData.originalCurrency
                      )}
                    </strong>{" "}
                    / Expense total:{" "}
                    <strong>
                      {formatCurrency(
                        Number(formData.originalAmount || 0),
                        formData.originalCurrency
                      )}
                    </strong>
                  </p>
                </>
              )}
            </div>
          ) : null}

          <label>
            Payment method
            <select
              value={formData.paymentMethod}
              onChange={e =>
                setFormData({ ...formData, paymentMethod: e.target.value })
              }
            >
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label>
            Notes
            <input
              type="text"
              value={formData.notes}
              placeholder="Optional"
              onChange={e => setFormData({ ...formData, notes: e.target.value })}
            />
          </label>

        </div>
        <footer className="modal-footer">
          {onCancel ? (
            <button className="secondary-button" type="button" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? "Saving..." : isEdit ? "Save expense" : "Add expense"}
          </button>
        </footer>
      </form>
    );
  }

  // -------------------- Render: settlements tab --------------------
  function renderSettlementsTab() {
    return (
      <section>
        <section className="card">
          <h2>Suggested settlements</h2>
          {suggestedSettlements.length === 0 ? (
            <p className="muted">Everyone is settled up.</p>
          ) : (
            <div className="settlement-list">
              {suggestedSettlements.map((s, i) => (
                <div className="settlement-row" key={i}>
                  <div>
                    <strong>{s.fromName}</strong> pays <strong>{s.toName}</strong>
                    <p className="small muted">
                      Suggested amount: {formatMoney(s.amount)}
                    </p>
                  </div>
                  <button
                    className="primary-button small-button"
                    type="button"
                    disabled={savingSettlement}
                    onClick={() => handleMarkSettlementPaid(s)}
                  >
                    Mark paid
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Settlement history</h2>
          {settlements.length === 0 ? (
            <p className="muted">No settlements recorded yet.</p>
          ) : (
            <div className="settlement-list">
              {settlements.map(s => (
                <div className="settlement-row" key={s.id}>
                  <div>
                    <strong>
                      {s.fromMemberName || memberNameOf(s.fromMemberId)}
                    </strong>{" "}
                    paid{" "}
                    <strong>
                      {s.toMemberName || memberNameOf(s.toMemberId)}
                    </strong>
                    <p className="small muted">
                      {s.date} · {formatMoney(s.amountEur)}
                    </p>
                    {s.notes ? <p className="small muted">{s.notes}</p> : null}
                  </div>
                  <button
                    className="danger-button small-button"
                    type="button"
                    onClick={() => handleDeleteSettlement(s)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <button
          className="primary-button"
          type="button"
          onClick={() => {
            resetSettlementForm();
            setIsSettlementModalOpen(true);
          }}
        >
          Settle Up
        </button>

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

    const navItems = [
      { key: "dashboard", label: "Dashboard", icon: "⊞" },
      { key: "prediction", label: "Prediction", icon: "📊" },
      { key: "actual", label: "Actual", icon: "💳" },
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
            <div className="brand-copy">
              <img className="app-logo-img" src="/triphisaab-logo.svg" alt="TripHisaab" />
              <div className="brand-tagline">Every trip. Every spend. Sorted.</div>
            </div>
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
                {user?.displayName || user?.email?.split("@")[0]}
              </div>
              <div className="sidebar-user-role">
                {selectedTrip.accessRole === "owner" ? "Trip admin" : "Member"}
              </div>
            </div>
            <button className="link-button sidebar-logout" type="button" onClick={handleLogout}>
              Out
            </button>
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
              <span className="mobile-topbar-tagline">Every trip. Every spend. Sorted.</span>
            </span>
            <button
              className="primary-button small-button"
              type="button"
              onClick={() => setIsAddExpenseModalOpen(true)}
            >
              + Add
            </button>
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
              <h1 className="trip-hero-title">{selectedTrip.name}</h1>
              <div className="trip-hero-dates">
                📅 {selectedTrip.startDate} → {selectedTrip.endDate}
              </div>
            </div>

            <div className="dashboard-content">
              {/* Row 1: Budget card + Quick Add */}
              <div className="dash-row dash-row-2col">
                <div className="dash-card budget-card">
                  <div className="budget-donut-wrap">
                    <svg width="130" height="130" viewBox="0 0 130 130">
                      <circle cx="65" cy="65" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
                      <circle
                        cx="65" cy="65" r={r} fill="none"
                        stroke="var(--primary)" strokeWidth="12"
                        strokeDasharray={`${dashFill} ${circ}`}
                        strokeLinecap="round"
                        transform="rotate(-90, 65, 65)"
                      />
                    </svg>
                    <div className="budget-donut-label">
                      <span className="budget-donut-pct">{budgetPct}%</span>
                      <span className="budget-donut-sub">of budget<br/>spent</span>
                    </div>
                  </div>
                  <div className="budget-stats">
                    <div className="budget-stat-row">
                      <div className="budget-stat">
                        <span className="budget-stat-label">Predicted budget</span>
                        <span className="budget-stat-value">{formatMoney(totals.predicted)}</span>
                      </div>
                      <div className="budget-stat">
                        <span className="budget-stat-label">Spent</span>
                        <span className="budget-stat-value">{formatMoney(totals.actual)}</span>
                      </div>
                      <div className="budget-stat">
                        <span className="budget-stat-label">Remaining</span>
                        <span className={`budget-stat-value ${remaining >= 0 ? "positive" : "negative"}`}>
                          {remaining >= 0 ? formatMoney(remaining) : "-" + formatMoney(Math.abs(remaining))}
                        </span>
                      </div>
                    </div>
                    <div className="budget-message">{budgetMsg}</div>
                  </div>
                </div>

                <div className="dash-card quick-add-card">
                  <button
                    className="quick-add-btn"
                    type="button"
                    onClick={() => setIsAddExpenseModalOpen(true)}
                  >
                    <div className="quick-add-circle">+</div>
                    <div>
                      <div className="quick-add-title">+ Add expense</div>
                      <div className="small muted">Snap it. Track it. Done.</div>
                    </div>
                  </button>
                  <div className="quick-add-chips">
                    {activeCategories.slice(0, 4).map(c => (
                      <button
                        key={c.id}
                        className="quick-add-chip"
                        type="button"
                        onClick={() => setIsAddExpenseModalOpen(true)}
                      >
                        {c.icon} {c.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Row 2: Trip progress + Balances + Recent activity */}
              <div className="dash-row dash-row-3col">
                <div className="dash-card">
                  <h3>Trip progress 🚗</h3>
                  <p className="dash-card-sub">
                    {daysLeft > 0 ? "Still plenty of road ahead 🌴" : "Trip has ended 🏁"}
                  </p>
                  <div className="progress-days">
                    <div className="progress-day-block">
                      <div className="progress-day-num">{daysIn}</div>
                      <div className="progress-day-label">day{daysIn !== 1 ? "s" : ""} in</div>
                    </div>
                    <div className="progress-day-divider" />
                    <div className="progress-day-block">
                      <div className="progress-day-num highlight">{daysLeft}</div>
                      <div className="progress-day-label">day{daysLeft !== 1 ? "s" : ""} left</div>
                    </div>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-track-fill"
                      style={{ width: `${Math.min(100, Math.round((daysIn / totalDays) * 100))}%` }}
                    />
                  </div>
                </div>

                <div className="dash-card">
                  <div className="dash-card-header">
                    <div>
                      <h3>Balances</h3>
                      <p className="dash-card-sub">Who owes who?</p>
                    </div>
                    <button
                      className="secondary-button small-button"
                      type="button"
                      onClick={() => { resetSettlementForm(); setIsSettlementModalOpen(true); }}
                    >
                      + Settle Up
                    </button>
                  </div>
                  {balances.length === 0 ? (
                    <p className="muted small">No members yet.</p>
                  ) : (
                    <>
                      {balances.slice(0, 3).map(b => (
                        <div className="dash-balance-item" key={b.memberId}>
                          <div
                            className={`dash-balance-avatar${memberImageOf(b) ? " has-image" : ""}`}
                            style={
                              memberImageOf(b)
                                ? { backgroundImage: `url(${memberImageOf(b)})` }
                                : undefined
                            }
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
                            {b.net >= 0 ? "+" : "-"}{formatMoney(Math.abs(b.net))}
                          </div>
                        </div>
                      ))}
                      {suggestedSettlements.length > 0 && (
                        <div className="suggested-strip">
                          <div>
                            <div className="small" style={{ fontWeight: 700 }}>💜 Suggested settlement</div>
                            <div className="small muted">
                              {suggestedSettlements[0].fromName} pays {suggestedSettlements[0].toName} {formatMoney(suggestedSettlements[0].amount)}
                            </div>
                          </div>
                          <button
                            className="primary-button small-button"
                            type="button"
                            disabled={savingSettlement}
                            onClick={() => handleMarkSettlementPaid(suggestedSettlements[0])}
                          >
                            Mark paid
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="dash-card">
                  <h3>Recent activity</h3>
                  <p className="dash-card-sub">Latest expenses</p>
                  {expenses.length === 0 ? (
                    <p className="muted small">No expenses yet.</p>
                  ) : (
                    <>
                      {expenses.slice(0, 3).map(e => (
                        <div className="dash-activity-item" key={e.id}>
                          <div className="dash-activity-icon">{e.categoryIcon || "💸"}</div>
                          <div className="dash-activity-info">
                            <div className="dash-activity-name">{e.categoryName}</div>
                            <div className="dash-activity-meta">
                              Paid by {memberNameOf(e.paidByMemberId)} · {e.date}
                            </div>
                          </div>
                          <div className="dash-activity-amount">{formatMoney(e.amountEur)}</div>
                        </div>
                      ))}
                      <button
                        className="link-button"
                        style={{ marginTop: "8px", fontSize: "13px" }}
                        type="button"
                        onClick={() => setActiveTab("actual")}
                      >
                        View all activity →
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Row 3: Category breakdown */}
              {categories.length > 0 && (
                <div className="dash-card breakdown-card">
                  <h3>Where your money goes</h3>
                  <p className="dash-card-sub">Category breakdown</p>
                  <div className="breakdown-items">
                    {categories.map(c => {
                      const actual = actualByCategoryId.get(c.id) || 0;
                      const pct = totals.actual > 0
                        ? Math.min(100, Math.round((actual / totals.actual) * 100))
                        : 0;
                      return (
                        <div className="breakdown-item" key={c.id}>
                          <div className="breakdown-cat-icon">{c.icon}</div>
                          <div className="breakdown-cat-name">{c.name}</div>
                          <div className="breakdown-bar-wrap">
                            <div className="breakdown-bar-fill" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="breakdown-amount">{formatMoney(actual)}</div>
                          <div className="breakdown-pct">{pct}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : null}

        {activeTab !== "dashboard" ? (
          <div className="tab-page-content">
        {activeTab === "prediction" ? (
          <section className="card">
            <div className="section-header compact-header">
              <h2>Prediction</h2>
              <button
                className="secondary-button small-button"
                type="button"
                onClick={openCreateCategory}
              >
                + New category
              </button>
            </div>
            <p className="small muted">Set estimated cost per category in EUR.</p>
            <form onSubmit={handleSavePredictions}>
              {activeCategories.map(c => (
                <label key={c.id}>
                  {c.icon} {c.name}
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={predictionDraft[c.id] || ""}
                    placeholder="0.00"
                    onChange={e =>
                      setPredictionDraft({
                        ...predictionDraft,
                        [c.id]: e.target.value
                      })
                    }
                  />
                </label>
              ))}
              <button
                className="primary-button"
                type="submit"
                disabled={savingPredictions}
              >
                {savingPredictions ? "Saving..." : "Save predictions"}
              </button>
            </form>
          </section>
        ) : null}

        {activeTab === "actual" ? (
          <section>
            <div className="section-header">
              <h2>Expenses</h2>
              <div className="section-actions">
                <button
                  className="secondary-button small-button"
                  type="button"
                  onClick={openCreateCategory}
                >
                  + New category
                </button>
                <button
                  className="primary-button small-button"
                  type="button"
                  onClick={() => setIsAddExpenseModalOpen(true)}
                >
                  + Add expense
                </button>
              </div>
            </div>
            <section>
              {expenses.length === 0 ? (
                <div className="empty-card">
                  <div className="empty-icon">💸</div>
                  <h3>No expenses yet</h3>
                  <p className="muted">Add your first actual expense above.</p>
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
                                  : "Equal split"
                              } · Paid by ${memberNameOf(e.paidByMemberId)}`
                            : `Personal · Paid by ${memberNameOf(e.paidByMemberId)}`}
                        </p>
                        {e.expenseType === "shared" &&
                        e.splitType === "custom" ? (
                          <p className="small muted">
                            Custom split ·{" "}
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
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === "settlements" ? renderSettlementsTab() : null}

        {activeTab === "categories" ? (
          <section>
            <section className="card">
              <h2>{editingCategoryId ? "Edit category" : "Create category"}</h2>
              <p className="small muted">
                Active categories appear in Prediction and Actual expense forms.
              </p>

              <form onSubmit={handleSaveCategory}>
                <label>
                  Category name
                  <input
                    type="text"
                    value={categoryForm.name}
                    placeholder="e.g. Coffee"
                    onChange={e =>
                      setCategoryForm({ ...categoryForm, name: e.target.value })
                    }
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
                  <label>
                    Icon
                    <input
                      type="text"
                      value={categoryForm.icon}
                      maxLength="4"
                      onChange={e =>
                        setCategoryForm({ ...categoryForm, icon: e.target.value })
                      }
                    />
                  </label>
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

                <button
                  className="primary-button"
                  type="submit"
                  disabled={savingCategory}
                >
                  {savingCategory
                    ? "Saving..."
                    : editingCategoryId
                    ? "Save category"
                    : "Create category"}
                </button>

                {editingCategoryId ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={cancelCategoryForm}
                  >
                    Cancel editing
                  </button>
                ) : null}
              </form>
            </section>

            <section className="card">
              <h2>Categories</h2>
              {categories.length === 0 ? (
                <p className="muted">No categories yet.</p>
              ) : (
                <div className="category-list">
                  {categories.map(c => (
                    <div className="category-row" key={c.id}>
                      <span
                        className="category-dot"
                        style={{
                          backgroundColor: `${c.color || "#0F766E"}22`,
                          color: c.color || "#0F766E"
                        }}
                      >
                        {c.icon || "📌"}
                      </span>
                      <div className="category-row-body">
                        <strong>{c.name}</strong>
                        <p className="small muted">{c.type}</p>
                        <span className={c.isActive ? "pill" : "pill muted-pill"}>
                          {c.isActive ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <div className="category-actions">
                        <button
                          className="secondary-button small-button"
                          type="button"
                          onClick={() => startEditingCategory(c)}
                        >
                          Edit
                        </button>
                        <button
                          className="secondary-button small-button"
                          type="button"
                          onClick={() => handleToggleCategory(c)}
                        >
                          {c.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : null}

        {activeTab === "members" ? (
          <section>
            {selectedTrip ? (
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

            <section className="card">
              <h2>Add trip member manually</h2>
              <p className="small muted">
                You can still add your friend's Google email manually.
              </p>
              <form onSubmit={handleAddMember}>
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

            <section className="card">
              <h2>Trip members</h2>
              <p className="small muted">
                Deactivating a member removes their app access but keeps old
                expense history readable.
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
                            ? "Reactivate"
                            : "Deactivate"}
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
            { key: "dashboard", label: "Dashboard", icon: "⊞" },
            { key: "prediction", label: "Prediction", icon: "📊" },
            { key: "actual", label: "Actual", icon: "💳" },
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
                Active categories appear in Prediction and Actual expense forms.
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
          title="Settle Up"
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
                {savingSettlement ? "Settling..." : "Settle Up"}
              </button>
            </footer>
          </form>
        </Modal>
        {renderTutorialModal()}
      </div>
    );
  }

  // -------------------- Render: invite screen --------------------
  function renderInviteScreen() {
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
            <p className="muted intro-text">
              You have been invited to join{" "}
              <strong>{inviteDetails.tripName || "this trip"}</strong>
              {inviteDetails.ownerEmail ? ` by ${inviteDetails.ownerEmail}` : ""}.
            </p>
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

  if (!user) {
    return (
      <main className="page center-page">
        <div className="logo">💼</div>
        <div>
          <h1>Expense Tracking</h1>
          <p className="muted intro-text">
            Track travel expenses, trip budgets, shared costs, and predictions.
          </p>
        </div>
        <button className="primary-button" onClick={handleGoogleLogin}>
          Continue with Google
        </button>
        <p className="small muted">
          Firebase MVP: Google login + Firestore database.
        </p>
      </main>
    );
  }

  if (selectedTrip) return renderTripScreen();

  {
    const today = todayIso();
    const activeTripCount = trips.filter(t => t.status === "Active").length;
    const upcomingCount = trips.filter(t => t.startDate > today).length;
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
            <div className="brand-copy">
              <img className="app-logo-img" src="/triphisaab-logo.svg" alt="TripHisaab" />
              <div className="brand-tagline">Every trip. Every spend. Sorted.</div>
            </div>
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
              <span className="mobile-topbar-tagline">Every trip. Every spend. Sorted.</span>
            </span>
            <button className="primary-button small-button" type="button" onClick={() => setIsCreateModalOpen(true)}>+ New</button>
          </div>

          {/* Hero banner */}
          <div className="home-hero">
            <div className="home-hero-text">
              <h1 className="home-hero-title">Your trips</h1>
              <p className="home-hero-sub">All your adventures, neatly packed ✈️</p>
            </div>
            <div className="home-hero-right">
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
            <div className="grid-2">
              <label>
                Start date
                <input
                  type="date"
                  value={form.startDate}
                  onClick={openDatePicker}
                  onChange={e => {
                    const newStart = e.target.value;
                    setForm(f => ({
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
                  value={form.endDate}
                  min={form.startDate}
                  onClick={openDatePicker}
                  onChange={e => setForm({ ...form, endDate: e.target.value })}
                  required
                />
              </label>
            </div>
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
            <div className="grid-2">
              <label>
                Start date
                <input
                  type="date"
                  value={editForm.startDate}
                  onClick={openDatePicker}
                  onChange={e => {
                    const newStart = e.target.value;
                    setEditForm(f => ({
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
                  value={editForm.endDate}
                  min={editForm.startDate}
                  onClick={openDatePicker}
                  onChange={e =>
                    setEditForm({ ...editForm, endDate: e.target.value })
                  }
                  required
                />
              </label>
            </div>
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
          </div>
          <footer className="modal-footer">
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
