// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical money/number/date formatting for the billing, discounts, and
// affiliate surfaces. Centralized so cents → display strings, tier prices, and
// invoice dates render identically everywhere and a Node/ICU bump that changes
// Intl spacing can't silently regress one surface but not another. All helpers
// are pure and locale-aware via Intl; malformed input degrades to a safe
// fallback instead of throwing during render.
//
// Formatter construction is the expensive half of Intl (~50 µs for an optioned
// constructor vs ~1 µs for .format() on an existing one), and these helpers are
// called once or twice per rendered table row. Every distinct option set is
// therefore built once and memoized at module scope; only .format() runs per
// call. The resolved locale is captured at first use, which matches how a
// browser tab behaves — a locale change requires a reload either way.

/** Memoized `Intl.NumberFormat` per currency code (the only varying option). */
const currencyFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat {
  const cached = currencyFormatters.get(currency);
  if (cached) return cached;
  // An unsupported currency code throws here exactly as it did when the
  // formatter was built inline; nothing is cached in that case.
  const built = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  });
  currencyFormatters.set(currency, built);
  return built;
}

/** Pretty-print an integer number of cents → "$X.YY" (USD default). */
export function formatCents(cents: number, currency = "USD"): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return currencyFormatter(currency).format(safe / 100);
}

/** Grouping-separator formatter for plain integers ("31,420"). */
let countFormatter: Intl.NumberFormat | null = null;

/** Localized integer with grouping separators ("31,420"). */
export function formatCount(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  countFormatter ??= new Intl.NumberFormat();
  return countFormatter.format(safe);
}

/** Date-only formatter matching invoice/expiry semantics ("Apr 8, 2026"). */
let localeDateFormatter: Intl.DateTimeFormat | null = null;

/**
 * Localized calendar date for an ISO string ("Apr 8, 2026"). Returns the raw
 * input on a malformed value so a bad timestamp never renders as "Invalid
 * Date". Date-only (no time) to match invoice/expiry semantics.
 */
export function formatLocaleDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  localeDateFormatter ??= new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return localeDateFormatter.format(d);
}

/**
 * Estimate the upcoming charge for a billing tier. Only monthly-cadence tiers
 * have a recurring charge; lifetime / free / unknown tiers return null so the
 * caller can omit the estimate rather than fabricate an amount. The returned
 * string is the tier's own catalog price copy (e.g. "$29"), never a computed
 * or invented figure.
 */
export function estimatedNextCharge(tier: {
  cadence: "free" | "lifetime" | "monthly";
  price: string;
}): string | null {
  return tier.cadence === "monthly" ? tier.price : null;
}
