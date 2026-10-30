// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure, unit-tested formatting + derivation helpers for the analytics surface.
// Kept dependency-free and deterministic (fixed "en-US" locale for currency so
// CSV/exports don't drift across environments — ANL-023) so the chart/tile math
// stays testable and the display never shows a raw machine identifier or a
// misread cents value (ANL-004/005/010/017).

import type { DashboardStats } from "@/lib/analytics-api";
import { safeCsvCell } from "./csv-safe";

// ---------------------------------------------------------------------------
// Metric-key humanization (ANL-004)
// ---------------------------------------------------------------------------

// Acronyms that must stay uppercased when a SCREAMING_SNAKE key is prettified.
const ACRONYMS = new Set([
  "LTV",
  "CLV",
  "ROI",
  "AOV",
  "CTR",
  "CTOR",
  "ID",
  "URL",
  "CTA",
  "RFM",
  "SMS",
  "MRR",
  "ARPU",
  "NPS",
]);

// Explicit overrides for keys whose generic prettified form we want to pin.
const KNOWN_LABELS: Record<string, string> = {
  AVERAGE_LTV_CENTS: "Average LTV",
  PREDICTED_CLV_CENTS: "Predicted CLV",
  REPEAT_PURCHASE_RATE: "Repeat purchase rate",
  MODEL_QUALITY: "Model quality",
  CUSTOMERS: "Customers",
};

/**
 * Turn a raw record key (SCREAMING_SNAKE, snake_case, or camelCase) into a
 * human label. Known keys use an explicit map; everything else is title-cased
 * with acronyms preserved and a trailing "CENTS" unit token dropped (the value
 * formatter renders those as currency). Never returns the raw screaming key.
 */
export function humanizeMetricKey(key: string): string {
  const raw = (key ?? "").trim();
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (KNOWN_LABELS[upper]) return KNOWN_LABELS[upper];

  let tokens = raw
    // split camelCase boundaries then any non-alphanumeric run
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  // Drop a trailing "cents" unit token — currency is shown in the value.
  if (tokens.length > 1 && tokens[tokens.length - 1]!.toUpperCase() === "CENTS") {
    tokens = tokens.slice(0, -1);
  }
  const words = tokens.map((t) =>
    ACRONYMS.has(t.toUpperCase()) ? t.toUpperCase() : t.toLowerCase(),
  );
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// ---------------------------------------------------------------------------
// Value formatting (ANL-005)
// ---------------------------------------------------------------------------

/** Localized currency from an integer cents value; deterministic locale. */
export function formatCents(cents: number, currency = "USD"): string {
  if (!Number.isFinite(cents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

/**
 * Format a predictive/metric value by the shape its key implies:
 *  - `*_CENTS` → currency (÷100)
 *  - `*_RATE` / `*_PCT` → percentage (0..1 fraction or an already-whole percent)
 *  - numbers → localized integer/float
 *  - strings → passed through
 */
export function formatMetricValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() ? value : "—";
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";

  const upper = key.toUpperCase();
  if (upper.endsWith("_CENTS")) return formatCents(value);
  if (upper.endsWith("_RATE") || upper.endsWith("_PCT")) {
    // A value in [0,1] is a fraction; anything larger is an already-whole
    // percentage (e.g. 25 => 25%).
    const pct = value >= 0 && value <= 1 ? value * 100 : value;
    return `${Math.round(pct)}%`;
  }
  return value.toLocaleString();
}

// ---------------------------------------------------------------------------
// Engagement rates (ANL-010)
// ---------------------------------------------------------------------------

export interface EngagementRates {
  /** Fractions in [0,1], or null when the denominator is 0/absent. */
  openRate: number | null;
  clickRate: number | null;
  clickToOpen: number | null;
  bounceRate: number | null;
  unsubRate: number | null;
}

function ratio(num: number | undefined, den: number | undefined): number | null {
  if (typeof num !== "number" || typeof den !== "number") return null;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

/**
 * Industry-standard email rates derived from the distinct-recipient counts the
 * backend already returns. Every rate divide-guards to null so a zero/absent
 * denominator never yields NaN/Infinity.
 */
export function computeEngagementRates(stats: DashboardStats): EngagementRates {
  return {
    openRate: ratio(stats.unique_opens_30d, stats.unique_delivered_30d),
    clickRate: ratio(stats.unique_clicks_30d, stats.unique_delivered_30d),
    clickToOpen: ratio(stats.unique_clicks_30d, stats.unique_opens_30d),
    bounceRate: ratio(stats.unique_bounces_30d, stats.unique_sent_30d),
    unsubRate: ratio(stats.subscribers_unsubbed_30d, stats.unique_delivered_30d),
  };
}

/** Render a 0..1 fraction as a percentage with one decimal, or a dash. */
export function formatRate(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) {
    return "—";
  }
  return `${(fraction * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Grammar (ANL-017)
// ---------------------------------------------------------------------------

/** Singular for exactly 1 (accepts a numeric string), else the plural. */
export function pluralize(
  count: number | string,
  singular: string,
  plural?: string,
): string {
  const n = typeof count === "string" ? Number(count) : count;
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

// ---------------------------------------------------------------------------
// Date range (ANL-007)
// ---------------------------------------------------------------------------

export type RangeValue = "7d" | "30d" | "90d";

export const RANGE_OPTIONS: ReadonlyArray<{ value: RangeValue; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

/** Normalize any input to a supported range (mirrors backend rangeLabel). */
export function normalizeRange(value: string | null | undefined): RangeValue {
  return value === "7d" || value === "90d" ? value : "30d";
}

export function rangeDays(range: string): number {
  return range === "7d" ? 7 : range === "90d" ? 90 : 30;
}

export function rangeSubtitle(range: string): string {
  return `Tenant overview · last ${rangeDays(range)} days unless noted.`;
}

// ---------------------------------------------------------------------------
// CSV export (ANL-013)
// ---------------------------------------------------------------------------

/** RFC-4180 cell plus the spreadsheet formula guard, matching the Go API's
 * server-side exports so both surfaces honour the same guarantee. */
export function csvCell(value: string | number | null | undefined): string {
  return safeCsvCell(value);
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Serialize the KPI rollup (and any derived rates) to a CSV string. */
export function buildStatsCsv(stats: DashboardStats, range: string): string {
  const rows: Array<Array<string | number>> = [
    ["Metric", "Value", "Window"],
    ["Subscribers (total)", stats.subscribers_total, range],
    ["Added", stats.subscribers_added_30d, range],
    ["Unsubscribed", stats.subscribers_unsubbed_30d, range],
    ["Campaigns sent", stats.campaigns_sent_30d, range],
    ["Opens", stats.opens_total_30d, range],
    ["Clicks", stats.clicks_total_30d, range],
    ["Bounces", stats.bounces_total_30d, range],
  ];
  if (typeof stats.emails_sent_30d === "number") {
    rows.push(["Emails sent", stats.emails_sent_30d, range]);
  }
  if (typeof stats.active_sequences_count === "number") {
    rows.push(["Active sequences", stats.active_sequences_count, range]);
  }
  const rates = computeEngagementRates(stats);
  const rateRows: Array<[string, number | null]> = [
    ["Open rate", rates.openRate],
    ["Click rate", rates.clickRate],
    ["Click-to-open rate", rates.clickToOpen],
    ["Bounce rate", rates.bounceRate],
    ["Unsubscribe rate", rates.unsubRate],
  ];
  for (const [label, value] of rateRows) {
    if (value !== null) rows.push([label, `${(value * 100).toFixed(2)}%`, range]);
  }
  return toCsv(rows);
}

/**
 * Reconcile a persisted KPI-tile order (from /api/v1/dashboard/layout) against
 * the currently-available tile keys (ANL-034). Returns the visible tile keys in
 * their chosen order. Rules:
 *  - Unknown saved keys are dropped (a tile may have been removed from the app).
 *  - An empty or all-unknown saved order (including the backend's legacy default
 *    order whose keys don't match the current frontend keys) means "no custom
 *    layout" → every tile in its default order.
 *  - Otherwise the saved known keys ARE the visible set, in order; any key not
 *    listed is hidden. (The customizer always lists every key so a hidden or
 *    newly-added tile can be re-enabled.)
 */
export function reconcileKpiOrder(
  allKeys: string[],
  savedOrder: string[] | undefined | null,
): string[] {
  const known = new Set(allKeys);
  const savedKnown = (savedOrder ?? []).filter((k) => known.has(k));
  return savedKnown.length === 0 ? allKeys : savedKnown;
}
