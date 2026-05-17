export const DEFAULT_CATEGORIES = [
  { id: "travel_flight", name: "Travel - Flight", type: "Travel", icon: "✈️", color: "#3B82F6", isActive: true },
  { id: "travel_train", name: "Travel - Train", type: "Travel", icon: "🚆", color: "#0EA5E9", isActive: true },
  { id: "food", name: "Food", type: "Daily", icon: "🍽️", color: "#F59E0B", isActive: true },
  { id: "shopping", name: "Shopping", type: "Daily", icon: "🛍️", color: "#EC4899", isActive: true },
  { id: "stay", name: "Stay", type: "Accommodation", icon: "🏨", color: "#8B5CF6", isActive: true },
  { id: "local_transport", name: "Local Transport", type: "Travel", icon: "🚌", color: "#14B8A6", isActive: true },
  { id: "fuel", name: "Fuel", type: "Travel", icon: "⛽", color: "#EF4444", isActive: true },
  { id: "extras", name: "Extras", type: "Miscellaneous", icon: "✨", color: "#64748B", isActive: true }
];

export const SUPPORTED_CURRENCIES = [
  "EUR", "USD", "GBP", "NOK", "AED", "INR",
  "CHF", "JPY", "CAD", "AUD", "SGD", "THB"
];

export const FALLBACK_EXCHANGE_RATES_FROM_EUR = {
  EUR: 1, USD: 1.08, GBP: 0.85, NOK: 11.5, AED: 3.95, INR: 90.5,
  CHF: 0.95, JPY: 165, CAD: 1.48, AUD: 1.65, SGD: 1.45, THB: 38.5
};

export const CURRENCY_SYMBOLS = {
  EUR: "€", USD: "$", GBP: "£", NOK: "kr ", AED: "د.إ ", INR: "₹",
  CHF: "CHF ", JPY: "¥", CAD: "C$", AUD: "A$", SGD: "S$", THB: "฿"
};

export const RATES_CACHE_KEY = "trip_expense_tracker_live_rates_v1";

export const TRIP_STATUSES = ["Active", "Completed", "Archived"];

export const CATEGORY_TYPES = [
  "Travel", "Daily", "Accommodation", "Food", "Shopping", "Miscellaneous"
];

// --- App storage keys ---

export const MEMBER_DIRECTORY_STORAGE_KEY = "triphisaab-member-directory";
export const APP_VIEW_STORAGE_KEY = "triphisaab-app-view";
export const LAST_TRIP_STORAGE_KEY = "triphisaab-last-trip";
export const LAST_TAB_STORAGE_KEY = "triphisaab-last-tab";

// --- Image processing constants ---

export const TRIP_IMAGE_MAX_WIDTH = 640;
export const TRIP_IMAGE_MAX_HEIGHT = 360;
export const TRIP_IMAGE_QUALITY = 0.68;
export const TRIP_IMAGE_MAX_BYTES = 260 * 1024;
export const PROFILE_IMAGE_SIZE = 256;
export const PROFILE_IMAGE_QUALITY = 0.82;

// --- Financial precision ---

export const MONEY_EPSILON = 0.01;

// --- Form defaults ---

export const EMPTY_EXPENSE_FORM = {
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
  customSplitShares: {},
  includeInGroupTotal: true
};

export const EMPTY_BUDGET_FORM = {
  categoryId: "",
  title: "",
  estimatedEur: "",
  scope: "group",
  visibleMemberIds: []
};

export const EMPTY_TASK_FORM = {
  title: "",
  type: "general",
  scope: "group",
  assignedTo: [],
  selectedMemberIds: [],
  dueDate: "",
  notes: ""
};

// --- UI option lists ---

export const CATEGORY_EMOJI_OPTIONS = [
  "📌", "✈️", "🚆", "🚕", "🚌", "⛽", "🏨", "🏠",
  "🍽️", "☕", "🍕", "🛒", "🛍️", "🎟️", "🎡", "🏖️",
  "💸", "💳", "🧾", "🎁", "💊", "📱", "🧳", "✨",
  "🍔", "🍜", "🥐", "🥤", "🍷", "🚗", "🚲", "🚇",
  "⛴️", "🛫", "🛬", "🛌", "🏕️", "🎭", "🎮", "📷",
  "🧴", "👕", "👶", "🐾", "🗺️", "🧡", "⭐", "🔖"
];

export const BUDGET_SCOPE_OPTIONS = [
  { value: "group", label: "Whole group" },
  { value: "selected", label: "Selected people" },
  { value: "me", label: "Only me" }
];

export const TASK_TYPE_OPTIONS = [
  { value: "general", label: "General" },
  { value: "booking", label: "Booking" },
  { value: "payment", label: "Payment" },
  { value: "receipt", label: "Receipt" },
  { value: "packing", label: "Packing" },
  { value: "document", label: "Document" }
];

export const TASK_SCOPE_OPTIONS = [
  { value: "group", label: "Whole group" },
  { value: "selected_members", label: "Selected people" },
  { value: "personal", label: "Only me" }
];
