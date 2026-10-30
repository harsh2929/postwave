/**
 * api/apiUsage.ts — the five reads behind billing's API usage & cost
 * dashboard.
 *
 *   GET /api/v1/api-usage/summary?days=     (admin)
 *   GET /api/v1/api-usage/keys?days=        (admin)
 *   GET /api/v1/api-usage/timeseries?days=  (admin)
 *   GET /api/v1/costs?since=<n>d&by=<dim>   (viewer, read:reports)
 *   GET /api/v1/costs/ledger?since=&cursor=&limit=  (viewer, read:reports)
 *
 * The /api-usage family's manifest floor is admin while /costs is genuinely
 * viewer — the screen gates the two halves separately for exactly that
 * reason. Shapes are normalised in lib/apiUsage (the two families disagree
 * on casing); errors keep their status so the UI can hide an entitlement
 * answer instead of rendering it as a failure.
 */
import { rawRequest } from "./request";

import {
  normalizeApiUsageKeys,
  normalizeApiUsagePoints,
  normalizeApiUsageSummary,
  normalizeCostAggregates,
  normalizeCostLedger,
  sinceParam,
  COST_LEDGER_PAGE_SIZE,
  type ApiUsageKeyRow,
  type ApiUsagePoint,
  type ApiUsageSummary,
  type CostAggregateRow,
  type CostGroupBy,
  type CostLedgerPage,
} from "@/lib/apiUsage";

export class ApiUsageError extends Error {
  readonly status: number;
  constructor(status: number, message: string, fallback: string) {
    super(message || fallback);
    this.name = "ApiUsageError";
    this.status = status;
  }
}

async function usageRead<T>(
  path: string,
  fallback: string,
  parse: (raw: unknown) => T,
): Promise<T> {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) {
    throw new ApiUsageError(res.error.status, res.error.message, fallback);
  }
  return parse(res.data);
}

export function fetchApiUsageSummary(days: number): Promise<ApiUsageSummary> {
  return usageRead(
    `/api/v1/api-usage/summary?days=${days}`,
    "Couldn't load API usage.",
    normalizeApiUsageSummary,
  );
}

export function fetchApiUsageKeys(days: number): Promise<ApiUsageKeyRow[]> {
  return usageRead(
    `/api/v1/api-usage/keys?days=${days}`,
    "Couldn't load per-key usage.",
    normalizeApiUsageKeys,
  );
}

export function fetchApiUsageTimeseries(
  days: number,
): Promise<ApiUsagePoint[]> {
  return usageRead(
    `/api/v1/api-usage/timeseries?days=${days}`,
    "Couldn't load the usage series.",
    normalizeApiUsagePoints,
  );
}

export function fetchCostAggregates(
  days: number,
  by: CostGroupBy,
): Promise<CostAggregateRow[]> {
  return usageRead(
    `/api/v1/costs?since=${sinceParam(days)}&by=${encodeURIComponent(by)}`,
    "Couldn't load cost totals.",
    (raw) => normalizeCostAggregates(raw, by),
  );
}

/** One ledger page; `cursor` comes from the previous page's nextCursor. */
export function fetchCostLedgerPage(
  days: number,
  cursor: string | null,
): Promise<CostLedgerPage> {
  const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  return usageRead(
    `/api/v1/costs/ledger?since=${sinceParam(days)}${cursorParam}&limit=${COST_LEDGER_PAGE_SIZE}`,
    "Couldn't load the cost ledger.",
    normalizeCostLedger,
  );
}
