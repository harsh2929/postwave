/**
 * lib/api-usage-api.ts — API key usage and its projected cost.
 *
 * Three `/api/v1/api-usage/*` paths were reached by desktop and by no web
 * file: summary, per-key breakdown and a timeseries.
 *
 * PROJECTIONS ARE NOT MEASUREMENTS. The summary reports both what has actually
 * happened (`total_sends`, `total_cost_cents` over `window_days`) and what the
 * server extrapolates from it (`projected_30d_*`). Rendering the projection
 * with the same weight as the measurement — or worse, instead of it — turns a
 * straight-line guess into a bill. The two are kept apart here and labelled
 * differently in the UI.
 *
 * Costs are in CENTS. A client that formats them as currency without dividing
 * reports a hundredfold overcharge.
 *
 * `since` and `window_days` appear on the summary AND on the per-key
 * breakdown, and the two are not guaranteed to match. Each block therefore
 * reports its own window rather than inheriting the page's.
 */
import { api } from "@/lib/api";

export interface ApiUsageSummary {
  active_keys: number;
  window_days: number;
  /** Actually observed in the window. */
  total_sends: number;
  total_cost_cents: number;
  avg_sends_per_day: number;
  avg_cost_cents_per_day: number;
  /** Extrapolated, not measured. */
  projected_30d_sends: number;
  projected_30d_cost_cents: number;
  since?: string;
}

function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}

export async function getApiUsageSummary(): Promise<ApiUsageSummary> {
  const res = await api.get<ApiUsageSummary>("/api/v1/api-usage/summary");
  return {
    active_keys: num(res?.active_keys),
    window_days: num(res?.window_days),
    total_sends: num(res?.total_sends),
    total_cost_cents: num(res?.total_cost_cents),
    avg_sends_per_day: num(res?.avg_sends_per_day),
    avg_cost_cents_per_day: num(res?.avg_cost_cents_per_day),
    projected_30d_sends: num(res?.projected_30d_sends),
    projected_30d_cost_cents: num(res?.projected_30d_cost_cents),
    since: res?.since,
  };
}

/** Cents to a currency string. The server speaks cents; screens speak money. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format((Number.isFinite(cents) ? cents : 0) / 100);
}

export interface ApiUsagePoint {
  date: string;
  sends: number;
  cost_cents: number;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Per-key usage over the window.
 *
 * Carries its own `since`/`window_days`: the breakdown is a separate query
 * from the summary and can cover a different span.
 */
export async function getApiUsageKeys(): Promise<{
  keys: unknown[];
  count: number;
  since: string;
  window_days: number;
}> {
  const r = await api.get<Record<string, unknown>>("/api/v1/api-usage/keys");
  return {
    keys: asArray(r?.keys),
    count: num(r?.count),
    since: str(r?.since),
    window_days: num(r?.window_days),
  };
}

export async function getApiUsageTimeseries(): Promise<{
  points: ApiUsagePoint[];
  window_days: number;
}> {
  const r = await api.get<Record<string, unknown>>(
    "/api/v1/api-usage/timeseries",
  );
  return {
    points: asArray<Record<string, unknown>>(r?.points).map((pt) => ({
      date: str(pt?.date),
      sends: num(pt?.sends),
      cost_cents: num(pt?.cost_cents),
    })),
    window_days: num(r?.window_days),
  };
}

/**
 * Days in the series that recorded any activity.
 *
 * A 30-point series of zeros is not the same as 30 days of measured traffic,
 * and an average taken over it divides real usage by days that never had any.
 */
export function activeDays(points: ApiUsagePoint[]): number {
  return points.filter((p) => p.sends > 0 || p.cost_cents > 0).length;
}

export type CostGroupBy = "kind" | "api_key_id" | "day";

export interface CostAggregateRow {
  apiKeyId: string | null;
  actorType: string | null;
  kind: string | null;
  day: string | null;
  cents: number;
  quantity: number;
  count: number;
}

export interface CostAggregateResponse {
  rows: CostAggregateRow[];
  since: string;
  group_by: CostGroupBy;
}

/** Deliberately excludes tenantId and metadata from long-lived UI state. */
export interface CostLedgerRow {
  id: number;
  apiKeyId: string | null;
  actorType: string | null;
  kind: string;
  cents: number;
  quantity: number;
  at: string;
}

export interface CostLedgerPage {
  rows: CostLedgerRow[];
  nextCursor?: string;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${context} response`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid cost ${field}`);
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    throw new Error(`Invalid cost ${field}`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`Invalid cost ${field}`);
  }
  return value;
}

function assertCostWindow(value: string): string {
  const match = /^(\d{1,3})d$/u.exec(value);
  const days = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("Cost window must be between 1 and 365 days");
  }
  return value;
}

function parseAggregateRow(value: unknown): CostAggregateRow {
  const row = object(value, "cost aggregate row");
  const day = row.day == null ? null : timestamp(row.day, "aggregate day");
  return {
    apiKeyId: optionalBoundedString(row.apiKeyId, "API key id"),
    actorType: optionalBoundedString(row.actorType, "actor type"),
    kind: optionalBoundedString(row.kind, "kind"),
    day,
    cents: nonNegativeSafeInteger(row.cents, "aggregate cents"),
    quantity: nonNegativeSafeInteger(row.quantity, "aggregate quantity"),
    count: nonNegativeSafeInteger(row.count, "aggregate count"),
  };
}

export function parseCostAggregateResponse(
  value: unknown,
  expectedGroupBy: CostGroupBy,
): CostAggregateResponse {
  const response = object(value, "cost aggregate");
  if (!Array.isArray(response.rows) || response.rows.length > 1_000) {
    throw new Error("Invalid cost aggregate rows");
  }
  if (response.group_by !== expectedGroupBy) {
    throw new Error("Cost aggregate group identity mismatch");
  }
  return {
    rows: response.rows.map(parseAggregateRow),
    since: timestamp(response.since, "aggregate since"),
    group_by: expectedGroupBy,
  };
}

export async function getCostAggregate(options: {
  since: string;
  groupBy: CostGroupBy;
  signal?: AbortSignal;
}): Promise<CostAggregateResponse> {
  const since = assertCostWindow(options.since);
  const params = new URLSearchParams({ since, by: options.groupBy });
  const response = await api.get<unknown>(`/api/v1/costs?${params}`, {
    signal: options.signal,
  });
  return parseCostAggregateResponse(response, options.groupBy);
}

function parseLedgerRow(value: unknown): CostLedgerRow {
  const row = object(value, "cost ledger row");
  const kind = optionalBoundedString(row.kind, "ledger kind");
  if (!kind) throw new Error("Invalid cost ledger kind");
  return {
    id: nonNegativeSafeInteger(row.id, "ledger id"),
    apiKeyId: optionalBoundedString(row.apiKeyId, "API key id"),
    actorType: optionalBoundedString(row.actorType, "actor type"),
    kind,
    cents: nonNegativeSafeInteger(row.cents, "ledger cents"),
    quantity: nonNegativeSafeInteger(row.quantity, "ledger quantity"),
    at: timestamp(row.at, "ledger timestamp"),
  };
}

export function parseCostLedgerPage(
  value: unknown,
  limit: number,
): CostLedgerPage {
  const response = object(value, "cost ledger");
  if (!Array.isArray(response.rows) || response.rows.length > limit) {
    throw new Error("Invalid cost ledger rows");
  }
  const rows = response.rows.map(parseLedgerRow);
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.id < 1 || ids.has(row.id))
      throw new Error("Invalid cost ledger id");
    ids.add(row.id);
  }
  let nextCursor: string | undefined;
  if (response.nextCursor !== undefined) {
    if (
      typeof response.nextCursor !== "string" ||
      !/^[1-9]\d*$/u.test(response.nextCursor) ||
      rows.length === 0 ||
      response.nextCursor !== String(rows.at(-1)?.id)
    ) {
      throw new Error("Invalid cost ledger cursor");
    }
    nextCursor = response.nextCursor;
  }
  return { rows, ...(nextCursor ? { nextCursor } : {}) };
}

export async function getCostLedgerPage(options: {
  since: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<CostLedgerPage> {
  const since = assertCostWindow(options.since);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Cost ledger page size must be between 1 and 100");
  }
  if (options.cursor !== undefined && !/^[1-9]\d*$/u.test(options.cursor)) {
    throw new Error("Invalid cost ledger cursor");
  }
  const params = new URLSearchParams({ since, limit: String(limit) });
  if (options.cursor) params.set("cursor", options.cursor);
  const response = await api.get<unknown>(`/api/v1/costs/ledger?${params}`, {
    signal: options.signal,
  });
  return parseCostLedgerPage(response, limit);
}
