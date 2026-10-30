/**
 * usage-helpers — pure logic for the Settings "Usage" section
 * (#54 API-usage dashboard + #55 cost ledger).
 *
 * NOTE on wire casing: /api-usage/* serializes snake_case
 * (`cost_cents`, `window_days`) while /costs/* serializes camelCase
 * (`apiKeyId`, `nextCursor`, `tenantId`) — see WIRING-WRAPPERS.md #55.
 * These helpers consume both shapes verbatim; no re-mapping.
 */

import type {
  APIUsageKeyRow,
  APIUsageSummary,
  CostAggregateRow,
  CostLedgerEntry,
} from "../../lib/api-client";

/** Cents → "$12.34". Whole-dollar amounts keep the cents for scan-ability.
 *  Coerces a missing/NaN wire value to 0 so the card never prints "$NaN". */
export function fmtCentsAsDollars(cents: number | null | undefined): string {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/** Thousands-grouped integer formatting (locale-stable for tests).
 *  A missing/NaN wire value renders as "0", never "NaN". */
export function fmtCount(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat("en-US").format(v);
}

export interface UsageStat {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

/**
 * The stat-grid model for the summary card. Cost fields arrive as
 * cents on the wire and are rendered as dollars — never echo raw
 * cents into the UI.
 */
export function summaryStats(s: APIUsageSummary): UsageStat[] {
  return [
    {
      key: "sends",
      label: `Sends (${s.window_days}d)`,
      value: fmtCount(s.total_sends),
      hint: `${fmtCount(Math.round(s.avg_sends_per_day))}/day average`,
    },
    {
      key: "cost",
      label: `Cost (${s.window_days}d)`,
      value: fmtCentsAsDollars(s.total_cost_cents),
      hint: `${fmtCentsAsDollars(Math.round(s.avg_cost_cents_per_day))}/day average`,
    },
    {
      key: "active_keys",
      label: "Active keys",
      value: fmtCount(s.active_keys),
    },
    {
      key: "projected_sends",
      label: "Projected sends (30d)",
      value: fmtCount(s.projected_30d_sends),
    },
    {
      key: "projected_cost",
      label: "Projected cost (30d)",
      value: fmtCentsAsDollars(s.projected_30d_cost_cents),
    },
  ];
}

export interface UsagePoint {
  date: string;
  sends: number;
  cost_cents: number;
}

/** Coerce a possibly-undefined/NaN wire number to a finite value (0). */
function finiteOrZero(n: number | undefined | null): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** Timeseries → LineChart points for the sends series. */
export function sendsLinePoints(
  points: UsagePoint[],
): Array<{ date: string; count: number }> {
  return points.map((p) => ({ date: p.date, count: finiteOrZero(p.sends) }));
}

/**
 * Timeseries → LineChart points for the cost series, converted to
 * dollars so the y-axis matches what the stat grid shows. Kept as a
 * separate chart from sends — overlaying two different units on one
 * y-axis misleads.
 */
export function costLinePoints(
  points: UsagePoint[],
): Array<{ date: string; count: number }> {
  return points.map((p) => ({
    date: p.date,
    count: Math.round((finiteOrZero(p.cost_cents) / 100) * 100) / 100,
  }));
}

/** Per-key table ordering: cost desc, then sends desc, then label.
 *  Wire rows can omit any field (the interface even carries an index
 *  signature for extras) — coerce numbers to 0 and the label to "" so a
 *  partial row sorts deterministically instead of crashing on
 *  `undefined.localeCompare` / NaN arithmetic. */
export function sortKeyRows(rows: APIUsageKeyRow[]): APIUsageKeyRow[] {
  return [...rows].sort((a, b) => {
    const aCost = a.cost_cents ?? 0;
    const bCost = b.cost_cents ?? 0;
    if (bCost !== aCost) return bCost - aCost;
    const aSends = a.sends ?? 0;
    const bSends = b.sends ?? 0;
    if (bSends !== aSends) return bSends - aSends;
    return (a.label ?? "").localeCompare(b.label ?? "");
  });
}

/**
 * Cursor-paged ledger accumulation: appends the next page while
 * de-duplicating on entry id (keyset pagination can re-serve the
 * boundary row when entries land between requests).
 */
export function mergeLedgerRows(
  prev: CostLedgerEntry[],
  next: CostLedgerEntry[],
): CostLedgerEntry[] {
  const seen = new Set(prev.map((e) => e.id));
  const out = [...prev];
  for (const e of next) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/**
 * Window-days → the `since` query value the cost endpoints accept.
 * cost.ParseSince understands the "<n>d" suffix form.
 */
export function sinceParam(days: number): string {
  const n = Math.max(1, Math.round(days));
  return `${n}d`;
}

/* ---------- #55 cost aggregate (GET /costs?by=) ------------------------ */

/** The group-by dimensions GET /api/v1/costs accepts via `?by=`. */
export type CostGroupBy = "api_key_id" | "kind" | "day";

export const COST_GROUP_BYS: ReadonlyArray<{
  key: CostGroupBy;
  label: string;
}> = [
  { key: "kind", label: "Kind" },
  { key: "api_key_id", label: "API key" },
  { key: "day", label: "Day" },
];

/**
 * Display label for one aggregate bucket under the active group-by.
 * The wire is camelCase (cost.CostRow) and leaves the non-grouped
 * dimensions null — only the grouped field is meaningful per row.
 */
export function aggregateRowLabel(
  row: CostAggregateRow,
  by: CostGroupBy,
): string {
  const v =
    by === "api_key_id" ? row.apiKeyId : by === "kind" ? row.kind : row.day;
  if (v) return v;
  return by === "api_key_id" ? "(no key)" : "(unknown)";
}

/**
 * Aggregate-table ordering: day buckets read chronologically (newest
 * first); every other dimension orders by cost desc, then label, so
 * the biggest spender tops the table.
 */
export function sortAggregateRows(
  rows: CostAggregateRow[],
  by: CostGroupBy,
): CostAggregateRow[] {
  return [...rows].sort((a, b) => {
    if (by === "day") {
      return aggregateRowLabel(b, by).localeCompare(aggregateRowLabel(a, by));
    }
    const aCents = a.cents ?? 0;
    const bCents = b.cents ?? 0;
    if (bCents !== aCents) return bCents - aCents;
    return aggregateRowLabel(a, by).localeCompare(aggregateRowLabel(b, by));
  });
}

/** Sum across all buckets for the table footer (cents, verbatim math). */
export function aggregateTotals(rows: CostAggregateRow[]): {
  cents: number;
  quantity: number;
  count: number;
} {
  return rows.reduce(
    (acc, r) => ({
      cents: acc.cents + (r.cents ?? 0),
      quantity: acc.quantity + (r.quantity ?? 0),
      count: acc.count + (r.count ?? 0),
    }),
    { cents: 0, quantity: 0, count: 0 },
  );
}
