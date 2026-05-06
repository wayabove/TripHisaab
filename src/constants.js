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
