import {
  CURRENCY_SYMBOLS,
  FALLBACK_EXCHANGE_RATES_FROM_EUR,
  RATES_CACHE_KEY
} from "./constants";

// --- Date helpers ---------------------------------------------------------

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const nowTimeIso = () => new Date().toTimeString().slice(0, 5);

// --- Email & URL helpers --------------------------------------------------

export const getEmailLower = email =>
  String(email || "").trim().toLowerCase();

export function getInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const tripId = params.get("inviteTripId");
  const inviteId = params.get("inviteId");
  return tripId && inviteId ? { tripId, inviteId } : null;
}

export function buildInviteLink(tripId, inviteId) {
  return `${window.location.origin}/?inviteTripId=${encodeURIComponent(
    tripId
  )}&inviteId=${encodeURIComponent(inviteId)}`;
}

// --- Currency -------------------------------------------------------------

export const getCurrencyRate = (rates, currency) =>
  Number(rates?.[currency]) ||
  FALLBACK_EXCHANGE_RATES_FROM_EUR[currency] ||
  1;

export const convertToEur = (rates, amount, currency) =>
  Number(amount || 0) / getCurrencyRate(rates, currency);

export function normalizeAmountInput(raw) {
  if (raw === "" || raw === null || raw === undefined) return "";
  let s = String(raw).trim().replace(/[^\d.,]/g, "");
  if (!s) return "";
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // comma is decimal separator: 1.234,56 → 1234.56
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // dot is decimal separator: 1,234.56 → 1234.56
      s = s.replace(/,/g, "");
    }
  } else if (lastComma !== -1) {
    const afterComma = s.slice(lastComma + 1);
    const beforeComma = s.slice(0, lastComma);
    if (afterComma.length <= 2 && !beforeComma.includes(",")) {
      // treat comma as decimal: 42,68 → 42.68
      s = beforeComma + "." + afterComma;
    } else {
      // treat comma as thousands separator: 1,234 → 1234
      s = s.replace(/,/g, "");
    }
  }
  // collapse multiple dots
  const parts = s.split(".");
  if (parts.length > 2) s = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
  // strip leading zeros before digits
  s = s.replace(/^0+(\d)/, "$1");
  return s;
}

export function parseAmount(raw) {
  return parseFloat(normalizeAmountInput(raw)) || 0;
}

export const formatMoney = amount => {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: "EUR",
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(Number(amount || 0));
  } catch {
    return "€" + Number(amount || 0).toFixed(2);
  }
};

export const formatCurrency = (amount, currency) => {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency", currency: currency || "EUR",
      minimumFractionDigits: 2, maximumFractionDigits: 2
    }).format(Number(amount || 0));
  } catch {
    const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
    return symbol + Number(amount || 0).toFixed(2);
  }
};

// --- Rates cache ----------------------------------------------------------

export function readRatesCache() {
  try {
    return JSON.parse(localStorage.getItem(RATES_CACHE_KEY) || "null");
  } catch {
    return null;
  }
}

export function writeRatesCache(payload) {
  try {
    localStorage.setItem(RATES_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore — storage may be full or disabled.
  }
}

// --- CSV helpers ----------------------------------------------------------

export const csvCell = value =>
  `"${String(value ?? "").replace(/"/g, '""')}"`;

export const csvRow = values => values.map(csvCell).join(",");

export function downloadCsv(filename, content) {
  const blob = new Blob(["\ufeff" + content], {
    type: "text/csv;charset=utf-8;"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const slugify = text =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

// --- DOM helpers ----------------------------------------------------------

export function openDatePicker(event) {
  if (event.currentTarget?.showPicker) {
    event.currentTarget.showPicker();
  }
}
