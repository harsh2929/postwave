/**
 * api/billing.ts — plan, usage, invoices and the Stripe portal hand-off.
 *
 * FIX (maturity audit COMMERCE#6): `fetchPlanSummary` used to end in
 * `return res.error ? null : (res.data ?? null)`. Discarding the error meant
 * TanStack always RESOLVED — `plan.isError` was structurally unreachable, so
 * the screen could only ever render a dead "Couldn't load your plan." with no
 * Retry. Every function here now THROWS a status-carrying error, which is what
 * `ErrorState`/`errorPresentation` need to distinguish a 403 from a 500 and to
 * decide whether a retry can possibly help.
 *
 * Shapes are normalised through `lib/billingNormalize` rather than trusted from
 * the wire (COMMERCE#39): a payload missing `resources` used to crash the
 * screen, and a missing `percent` rendered a bar of literal width "NaN%".
 */
import {
  normalizePlanSummary,
  type PlanSummary,
  type PlanUsageRow,
  type SendsProjection,
} from "@/lib/billingNormalize";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

export type { PlanSummary, PlanUsageRow, SendsProjection };
export { usageResourceLabel } from "@/lib/billingNormalize";

/** An error that keeps the HTTP status so the UI can branch on 401/403/404. */
class BillingRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "BillingRequestError";
  }
}

async function billingRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new BillingRequestError(res.error, label);
  if (res.data == null) {
    throw new Error(`${label} returned no data.`);
  }
  return res.data;
}

/** The tenant's plan summary. Throws on failure — never silently null. */
export async function fetchPlanSummary(): Promise<PlanSummary> {
  const raw = await billingRequest<unknown>(
    "GET",
    "/api/v1/billing/plan-summary",
    "Loading your plan",
  );
  return normalizePlanSummary(raw);
}

/** One row of GET /api/v1/billing/invoices (billing.DashboardInvoice). */
export interface BillingInvoice {
  id: string;
  number: string;
  /** Server-formatted date string, not necessarily ISO. */
  date: string;
  /** Server-formatted amount string, e.g. "$49.00". */
  amount: string;
  status: string;
  downloadUrl: string;
}

export async function listInvoices(): Promise<BillingInvoice[]> {
  const raw = await billingRequest<unknown>(
    "GET",
    "/api/v1/billing/invoices",
    "Loading invoices",
  );
  const arr = Array.isArray(raw) ? raw : [];
  const out: BillingInvoice[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    out.push({
      id,
      number: typeof row.number === "string" ? row.number : "",
      date: typeof row.date === "string" ? row.date : "",
      amount: typeof row.amount === "string" ? row.amount : "",
      status: typeof row.status === "string" ? row.status : "",
      downloadUrl: typeof row.downloadUrl === "string" ? row.downloadUrl : "",
    });
  }
  return out;
}

/** One point of GET /api/v1/billing/usage (billing.UsagePoint). */
export interface UsagePoint {
  date: string;
  sent: number;
}

/**
 * Send volume per day. The server clamps `days` to 30 / 90 / 365 — anything
 * else silently falls back to 90, so we only ever ask for a supported window.
 */
export type UsageWindow = 30 | 90 | 365;

export async function fetchUsage(days: UsageWindow): Promise<UsagePoint[]> {
  const raw = await billingRequest<unknown>(
    "GET",
    `/api/v1/billing/usage?days=${days}`,
    "Loading usage history",
  );
  const arr = Array.isArray(raw) ? raw : [];
  const out: UsagePoint[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const date = typeof row.date === "string" ? row.date : "";
    if (!date) continue;
    const sent = typeof row.sent === "number" ? row.sent : Number(row.sent);
    out.push({ date, sent: Number.isFinite(sent) ? sent : 0 });
  }
  return out;
}

/**
 * Mint a Stripe Billing Portal session and return its URL.
 *
 * Deliberately an OUT-OF-APP management link, never an in-app purchase path:
 * App Store rules treat subscription management for a business/reader app as a
 * web responsibility, and the portal is where cards, invoices and cancellation
 * actually live. The caller MUST run the result through
 * `safeBillingRedirectURL` before opening it.
 */
export async function createBillingPortalSession(): Promise<string> {
  const res = await billingRequest<{ url?: unknown }>(
    "POST",
    "/api/v1/billing/portal",
    "Opening the billing portal",
    {},
  );
  const url = typeof res.url === "string" ? res.url.trim() : "";
  if (!url) throw new Error("The billing portal did not return a link.");
  return url;
}
