// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers over the billing endpoints. Uses `billing-mocks` only when
// explicit mock mode is enabled.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import type {
  BillingState,
  BillingPlanSummary,
  BillingTier,
  Invoice,
  LimitsUsageResponse,
  PlanUsageResource,
  UsagePoint,
} from "./billing-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./billing-mocks");

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function getBillingState(): Promise<BillingState> {
  return withMockFallback<unknown>(
    () => api.get<unknown>("/api/v1/billing/state"),
    async () => (await loadMocks()).billingMocks.getState(),
  ).then(normalizeBillingState);
}

export function createCheckoutSession(
  tier: Exclude<BillingTier, "sandbox">,
): Promise<{ url: string }> {
  return withMockFallback(
    () => api.post<{ url: string }>("/api/v1/billing/checkout", { tier }),
    async () => (await loadMocks()).billingMocks.createCheckoutSession(tier),
  );
}

export function getStripePortalURL(signal?: AbortSignal): Promise<{ url: string }> {
  return withMockFallback(
    () => api.post<{ url: string }>("/api/v1/billing/portal", undefined, { signal }),
    async () => (await loadMocks()).billingMocks.getStripePortalURL(),
  );
}

// BILL-052: set the metered-overage preference. Returns the refreshed billing
// state so the caller can update the cache without a second fetch.
export function setBillingOverage(
  overageEnabled: boolean,
  overageCap?: number | null,
  signal?: AbortSignal,
): Promise<BillingState> {
  return withMockFallback<unknown>(
    () =>
      api.put<unknown>(
        "/api/v1/billing/overage",
        { overageEnabled, overageCap: overageCap ?? null },
        { signal },
      ),
    async () =>
      (await loadMocks()).billingMocks.setOverage(overageEnabled, overageCap),
  ).then(normalizeBillingState);
}

export function getInvoices(): Promise<Invoice[]> {
  return withMockFallback<unknown>(
    () => api.get<unknown>("/api/v1/billing/invoices"),
    async () => (await loadMocks()).billingMocks.getInvoices(),
  ).then(normalizeInvoices);
}

export function getUsage(days = 90): Promise<UsagePoint[]> {
  return withMockFallback<unknown>(
    () =>
      api.get<unknown>("/api/v1/billing/usage", {
        query: { days },
      }),
    async () => (await loadMocks()).billingMocks.getUsage(),
  ).then(normalizeUsage);
}

export function getBillingPlanSummary(): Promise<BillingPlanSummary> {
  return withMockFallback<unknown>(
    () => api.get<unknown>("/api/v1/billing/plan-summary"),
    async () => (await loadMocks()).billingMocks.getPlanSummary(),
  ).then(normalizeBillingPlanSummary);
}

export function getLimitsUsage(): Promise<LimitsUsageResponse> {
  return withMockFallback<unknown>(
    () => api.get<unknown>("/api/v1/limits/usage"),
    async () => (await loadMocks()).billingMocks.getLimitsUsage(),
  ).then(normalizeLimitsUsage);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function isTier(value: unknown): value is BillingTier {
  return (
    value === "sandbox" ||
    value === "launch" ||
    value === "growth" ||
    value === "scale"
  );
}

function canonicalTier(value: unknown): unknown {
  switch (value) {
    case "studio_ltd":
    case "studio":
      return "launch";
    case "studio_ltd_cloud":
    case "sending":
      return "growth";
    case "studio_ltd_plus":
    case "pro":
      return "scale";
    default:
      return value;
  }
}

export function normalizeBillingState(value: unknown): BillingState {
  const source = record(value);
  const tier = canonicalTier(source.tier);
  if (!isTier(tier)) {
    throw new Error("Billing state response was malformed.");
  }
  if (
    (source.sendingAddon != null && !isRecord(source.sendingAddon)) ||
    (source.card != null && !isRecord(source.card))
  ) {
    throw new Error("Billing state response was malformed.");
  }
  const addonSource =
    source.sendingAddon == null ? null : record(source.sendingAddon);
  const cardSource = source.card == null ? null : record(source.card);
  if (
    addonSource &&
    [
      addonSource.monthlyCap,
      addonSource.used,
      addonSource.daysRemaining,
      addonSource.overageUnits,
    ].some((entry) => !Number.isFinite(Number(entry)))
  ) {
    throw new Error("Billing state response was malformed.");
  }
  if (cardSource && (!text(cardSource.brand) || !text(cardSource.last4))) {
    throw new Error("Billing state response was malformed.");
  }
  return {
    tier,
    startedAt: text(source.startedAt),
    sendingAddon: addonSource
      ? {
          monthlyCap: number(addonSource.monthlyCap),
          used: number(addonSource.used),
          daysRemaining: number(addonSource.daysRemaining),
          overageEnabled: addonSource.overageEnabled === true,
          overageUnits: number(addonSource.overageUnits),
          overageCap:
            addonSource.overageCap == null
              ? null
              : number(addonSource.overageCap),
          overageChargeable: addonSource.overageChargeable === true,
          overageBillingConfigured:
            addonSource.overageBillingConfigured === true,
        }
      : null,
    card:
      cardSource && text(cardSource.brand) && text(cardSource.last4)
        ? {
            brand: text(cardSource.brand).slice(0, 40),
            last4: text(cardSource.last4).slice(-4),
          }
        : null,
  };
}

export function normalizeInvoices(value: unknown): Invoice[] {
  if (!Array.isArray(value)) {
    throw new Error("Invoice response was malformed.");
  }
  return value.slice(0, 1_000).map((value) => {
    const row = record(value);
    const status = text(row.status);
    if (
      !text(row.id) ||
      (status !== "paid" && status !== "open" && status !== "refunded")
    )
      throw new Error("Invoice response contained an invalid row.");
    return {
      id: text(row.id),
      ...(text(row.number) ? { number: text(row.number) } : {}),
      date: text(row.date),
      amount: text(row.amount) || "—",
      status,
      downloadUrl: text(row.downloadUrl),
    } satisfies Invoice;
  });
}

export function normalizeUsage(value: unknown): UsagePoint[] {
  if (!Array.isArray(value)) {
    throw new Error("Billing usage response was malformed.");
  }
  return value
    .slice(0, 366)
    .map((value) => {
      const row = record(value);
      const date = text(row.date);
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !Number.isFinite(Number(row.sent))
      ) {
        throw new Error("Billing usage response contained an invalid row.");
      }
      return { date, sent: Math.floor(number(row.sent)) } satisfies UsagePoint;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeResource(value: unknown): PlanUsageResource | null {
  const row = record(value);
  if (
    !text(row.resource) ||
    !Number.isFinite(Number(row.current)) ||
    !Number.isFinite(Number(row.limit))
  ) {
    return null;
  }
  const current = number(row.current);
  const limit = number(row.limit);
  const reportedPercent = Number(row.percent);
  return {
    resource: text(row.resource),
    current,
    limit,
    percent:
      limit > 0
        ? Math.min(
            100_000,
            Number.isFinite(reportedPercent)
              ? Math.max(0, reportedPercent)
              : (current / limit) * 100,
          )
        : 0,
    exceeded: row.exceeded === true || (limit > 0 && current > limit),
  };
}

export function normalizeBillingPlanSummary(
  value: unknown,
): BillingPlanSummary {
  const source = record(value);
  if (!text(source.tier) || !Array.isArray(source.resources)) {
    throw new Error("Billing plan summary response was malformed.");
  }
  const projection =
    source.sends_projection == null ? null : record(source.sends_projection);
  const resources = source.resources.map(normalizeResource);
  if (resources.some((row) => row === null)) {
    throw new Error("Billing plan summary contained an invalid resource.");
  }
  if (
    projection &&
    ![
      projection.current,
      projection.limit,
      projection.avg_per_day,
      projection.days_elapsed,
      projection.days_in_period,
      projection.projected_end_of_period,
    ].every((entry) => Number.isFinite(Number(entry)))
  ) {
    throw new Error("Billing plan summary contained an invalid projection.");
  }
  return {
    tier: text(source.tier),
    ...(text(source.current_period_end)
      ? { current_period_end: text(source.current_period_end) }
      : {}),
    resources: resources as PlanUsageResource[],
    ...(projection
      ? {
          sends_projection: {
            current: number(projection.current),
            limit: number(projection.limit),
            as_of: text(projection.as_of),
            period_start: text(projection.period_start),
            period_end: text(projection.period_end),
            avg_per_day: number(projection.avg_per_day),
            days_elapsed: number(projection.days_elapsed),
            days_in_period: number(projection.days_in_period),
            projected_end_of_period: number(projection.projected_end_of_period),
            projected_exceed_date:
              projection.projected_exceed_date == null
                ? null
                : text(projection.projected_exceed_date),
            on_track_to_exceed: projection.on_track_to_exceed === true,
          },
        }
      : {}),
  };
}

export function normalizeLimitsUsage(value: unknown): LimitsUsageResponse {
  const source = record(value);
  if (!text(source.tier) || !Array.isArray(source.rows)) {
    throw new Error("Billing limits response was malformed.");
  }
  const rows = source.rows.map(normalizeResource);
  if (rows.some((row) => row === null)) {
    throw new Error("Billing limits response contained an invalid resource.");
  }
  return {
    tier: text(source.tier),
    rows: rows as PlanUsageResource[],
  };
}

export type {
  BillingPlanSummary,
  BillingState,
  BillingTier,
  Invoice,
  LimitsUsageResponse,
  UsagePoint,
};
