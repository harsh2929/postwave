/**
 * lib/apiUsage.ts — the pure half of billing's API usage & cost dashboard.
 *
 * Desktop renders UsageSection (apps/desktop/src/components/settings/
 * UsageSection.tsx): summary stat cards, per-key usage, daily timeseries,
 * cost aggregates and a cursor-paged cost-ledger drilldown. Mobile's billing
 * screen read plan-summary/usage/invoices and nothing else — API spend was
 * invisible from the phone.
 *
 * WIRE SHAPES, read off the Go handlers:
 *   GET /api/v1/api-usage/summary|keys|timeseries?days= — snake_case maps
 *     (apps/api/internal/api_usage_dashboard/api_usage_dashboard.go)
 *   GET /api/v1/costs?since=<n>d&by=<dim> and /api/v1/costs/ledger —
 *     CAMELCASE rows (apps/api/internal/cost/aggregator.go:17, cost.go:35).
 *     The two families genuinely disagree on casing; both are normalised here
 *     so no component ever sees the difference.
 *
 * LEDGER PAGINATION GOTCHAS (cost/handlers.go:60): the request `cursor` is a
 * decimal int64 id, the response `nextCursor` is a STRING, and the key is
 * omitted entirely on the final page — absence means end-of-list. Keyset
 * pagination can re-serve the boundary row, so merging pages de-dupes on id.
 *
 * Import-free; runs under node vitest.
 */

/** The windows the dashboard offers, matching desktop's WINDOWS = [7,30,90]. */
export const API_USAGE_WINDOWS = [7, 30, 90] as const;
export type ApiUsageWindow = (typeof API_USAGE_WINDOWS)[number];

/** Ledger page size, matching desktop's drilldown. */
export const COST_LEDGER_PAGE_SIZE = 50;

export interface ApiUsageSummary {
  windowDays: number;
  totalSends: number;
  totalCostCents: number;
  activeKeys: number;
  avgSendsPerDay: number;
  avgCostCentsPerDay: number;
  projected30dSends: number;
  projected30dCostCents: number;
}

export interface ApiUsageKeyRow {
  id: string;
  label: string;
  prefix: string;
  actorType: string;
  sends: number;
  costCents: number;
}

export interface ApiUsagePoint {
  date: string;
  sends: number;
  costCents: number;
}

export type CostGroupBy = "kind" | "api_key_id" | "day";

export const COST_GROUP_BYS: readonly { key: CostGroupBy; label: string }[] = [
  { key: "kind", label: "Kind" },
  { key: "api_key_id", label: "API key" },
  { key: "day", label: "Day" },
];

export interface CostAggregateRow {
  apiKeyId: string;
  actorType: string;
  kind: string;
  day: string;
  cents: number;
  quantity: number;
  count: number;
}

export interface CostLedgerEntry {
  /** int64 row id; also the de-dupe key across pages. */
  id: number;
  apiKeyId: string;
  kind: string;
  cents: number;
  quantity: number;
  at: string;
}

export interface CostLedgerPage {
  rows: CostLedgerEntry[];
  /** Absent on the wire's final page → null = end of list. */
  nextCursor: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function float(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `since` for the /costs family: "30d". Bounded below at one day. */
export function sinceParam(days: number): string {
  return `${Math.max(1, Math.round(days))}d`;
}

/**
 * Cents → "$12.34", negatives kept ("-$0.50"), junk → "$0.00". Desktop's
 * fmtCentsAsDollars, ported so the two clients can never disagree on money.
 */
export function fmtCentsAsDollars(cents: unknown): string {
  const n = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  const sign = n < 0 ? "-" : "";
  return `${sign}$${(Math.abs(n) / 100).toFixed(2)}`;
}

export function normalizeApiUsageSummary(payload: unknown): ApiUsageSummary {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    windowDays: int(raw.window_days),
    totalSends: int(raw.total_sends),
    totalCostCents: int(raw.total_cost_cents),
    activeKeys: int(raw.active_keys),
    avgSendsPerDay: float(raw.avg_sends_per_day),
    avgCostCentsPerDay: float(raw.avg_cost_cents_per_day),
    projected30dSends: int(raw.projected_30d_sends),
    projected30dCostCents: int(raw.projected_30d_cost_cents),
  };
}

/** `{keys:[...]}` → rows sorted cost desc, sends desc, label asc (desktop). */
export function normalizeApiUsageKeys(payload: unknown): ApiUsageKeyRow[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.keys) ? raw.keys : [];
  const out: ApiUsageKeyRow[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    out.push({
      id,
      label: str(r.label),
      prefix: str(r.prefix),
      actorType: str(r.actor_type),
      sends: int(r.sends),
      costCents: int(r.cost_cents),
    });
  }
  out.sort(
    (a, b) =>
      b.costCents - a.costCents ||
      b.sends - a.sends ||
      a.label.localeCompare(b.label),
  );
  return out;
}

/** `{points:[...]}` → the daily series (server zero-fills, order preserved). */
export function normalizeApiUsagePoints(payload: unknown): ApiUsagePoint[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.points) ? raw.points : [];
  const out: ApiUsagePoint[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const date = str(r.date);
    if (!date) continue;
    out.push({ date, sends: int(r.sends), costCents: int(r.cost_cents) });
  }
  return out;
}

/**
 * `{rows:[...]}` → aggregate rows (camelCase wire), sorted for the active
 * group-by: day → newest first; anything else → cents desc, label asc.
 */
export function normalizeCostAggregates(
  payload: unknown,
  by: CostGroupBy,
): CostAggregateRow[] {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const out: CostAggregateRow[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    out.push({
      apiKeyId: str(r.apiKeyId),
      actorType: str(r.actorType),
      kind: str(r.kind),
      day: str(r.day),
      cents: int(r.cents),
      quantity: int(r.quantity),
      count: int(r.count),
    });
  }
  if (by === "day") {
    out.sort((a, b) => b.day.localeCompare(a.day));
  } else {
    out.sort(
      (a, b) =>
        b.cents - a.cents ||
        aggregateRowLabel(a, by).localeCompare(aggregateRowLabel(b, by)),
    );
  }
  return out;
}

/** The grouped dimension's display label; blanks named, not blank. */
export function aggregateRowLabel(
  row: CostAggregateRow,
  by: CostGroupBy,
): string {
  const value =
    by === "kind" ? row.kind : by === "api_key_id" ? row.apiKeyId : row.day;
  if (value) return value;
  return by === "api_key_id" ? "(no key)" : "(unknown)";
}

export function aggregateTotals(rows: readonly CostAggregateRow[]): {
  cents: number;
  quantity: number;
  count: number;
} {
  return rows.reduce(
    (acc, row) => ({
      cents: acc.cents + row.cents,
      quantity: acc.quantity + row.quantity,
      count: acc.count + row.count,
    }),
    { cents: 0, quantity: 0, count: 0 },
  );
}

/** `{rows, nextCursor?}` → a page; absent nextCursor is the end of the list. */
export function normalizeCostLedger(payload: unknown): CostLedgerPage {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const out: CostLedgerEntry[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = int(r.id);
    if (id <= 0) continue;
    out.push({
      id,
      apiKeyId: str(r.apiKeyId),
      kind: str(r.kind),
      cents: int(r.cents),
      quantity: int(r.quantity),
      at: str(r.at),
    });
  }
  const cursor = str(raw.nextCursor);
  return { rows: out, nextCursor: cursor || null };
}

/**
 * Append a page, de-duplicating on id — keyset pagination can re-serve the
 * boundary row, and a duplicated ledger line reads as double billing.
 */
export function mergeLedgerRows(
  prev: readonly CostLedgerEntry[],
  next: readonly CostLedgerEntry[],
): CostLedgerEntry[] {
  const seen = new Set(prev.map((row) => row.id));
  const merged = [...prev];
  for (const row of next) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}
