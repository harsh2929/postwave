/**
 * api/commerce.ts — store connections, their sync cursor, and the one write
 * a phone can honestly perform.
 *
 * SCOPES (read from the route table, apps/api/internal/commerce/handlers.go:
 * 137-167 — not from a doc):
 *
 *   GET  /api/v1/commerce/integrations            ScopeAdmin        (:138)
 *   GET  /api/v1/commerce/integrations/{id}/analytics
 *                                                 ScopeReadReports  (:166)
 *   GET  /api/v1/commerce/integrations/{id}/orders
 *                                                 ScopeReadReports  (:164)
 *   POST /api/v1/commerce/integrations/{id}/sync  ScopeAdmin        (:141)
 *
 * The same four rows appear in the generated policy manifest
 * (apps/api/internal/routeauth/manifest.json) with session_minimum_role
 * admin / viewer / viewer / admin — and routeauth.Middleware (mounted at
 * main.go:2265) evaluates that INDEPENDENTLY of the per-route RequireScope,
 * so a session has to clear both. They agree on all four.
 *
 * The list route being admin-only while the detail routes are not is the
 * awkward fact this surface has to live with: an editor or viewer session gets
 * a 403 on the ONLY route that can enumerate stores, and there is no
 * read-scoped alternative. Callers must branch on that (see
 * `isCommerceScopeDenied`) rather than render an empty portfolio.
 *
 * Unlike `api/integrations.ts`, the write here is REAL. `SyncIntegration`
 * (handlers.go:1386) with an empty body runs `providerBackfillRequest`, pulls
 * from the provider and returns 202 with a `SyncSummary` — it does not return
 * a "delegated" descriptor. It can still legitimately fail with 409
 * (`integration_disconnected`, :1411) or 422 (`payload_required`, :1463) for a
 * provider that has no server-side puller, which is why the caller gets a
 * status-carrying error instead of a boolean.
 */
import {
  normalizeCommerceOrders,
  type CommerceOrdersPage,
} from "@/lib/commerceOrders";
import {
  normalizeRecoveryPage,
  type RecoveryKind,
  type RecoveryPage,
} from "@/lib/commerceRecovery";
import {
  normalizeCommerceAnalytics,
  normalizeCommerceStores,
  type CommerceAnalytics,
  type CommerceStore,
} from "@/lib/commerceRollup";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * How many orders one phone screen reads.
 *
 * `ReadParamsWithDefault(q, 50, 200)` (pagination/cursor.go:128) would give 50
 * unasked; 25 is a deliberate reduction — this is a glance at what just came
 * in, and every row not shown is a row not paid for over cellular.
 */
export const COMMERCE_ORDERS_PAGE_SIZE = 25;

/** Keeps the HTTP status so the UI can tell a 403 from a 409 from a 422. */
export class CommerceRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "CommerceRequestError";
  }
}

async function commerceRequest<T>(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<T | null> {
  const res = await rawRequest<T>(method, path, body);
  if (res.error) throw new CommerceRequestError(res.error, label);
  return res.data;
}

export async function listCommerceStores(): Promise<CommerceStore[]> {
  const raw = await commerceRequest<unknown>(
    "GET",
    "/api/v1/commerce/integrations",
    "Loading store connections",
  );
  return normalizeCommerceStores(raw);
}

export async function fetchCommerceAnalytics(
  integrationId: string,
): Promise<CommerceAnalytics> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to read analytics.");
  const raw = await commerceRequest<unknown>(
    "GET",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/analytics`,
    "Loading store analytics",
  );
  return normalizeCommerceAnalytics(raw);
}

/**
 * The most recent orders for one store.
 *
 * Deliberately NOT paged from the phone. `ListOrders` (repo.go:2485) keyset-
 * pages on `(ordered_at, id)` and a phone that walked that cursor would be
 * re-implementing the desktop's 12-column browse grid on a 390pt screen. What
 * a phone answers is "what just came in", which is page one — so this reads
 * page one, and the screen says out loud that it is the last N rather than
 * presenting the sample as a total.
 */
export async function listCommerceOrders(
  integrationId: string,
  limit: number = COMMERCE_ORDERS_PAGE_SIZE,
): Promise<CommerceOrdersPage> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to read orders.");
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await commerceRequest<unknown>(
    "GET",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/orders?${params.toString()}`,
    "Loading recent orders",
  );
  return normalizeCommerceOrders(raw);
}

/**
 * How many recovery rows one phone screen reads.
 *
 * Matches `COMMERCE_ORDERS_PAGE_SIZE` deliberately. The three recovery lists
 * sit directly beneath the order list on the same screen, and a reader who has
 * just been told "the 25 most recent orders" should not have to work out that
 * the queue below it was sampled differently.
 */
export const COMMERCE_RECOVERY_PAGE_SIZE = 25;

/**
 * The path segment for each of the three lists. Split out of the fetcher so
 * the kind→URL mapping is one table rather than a conditional chain — and so
 * a new kind fails to compile rather than silently falling through.
 */
const RECOVERY_PATHS: Record<RecoveryKind, string> = {
  carts: "cart-recovery-links",
  "back-in-stock": "back-in-stock-subscriptions",
  "price-drops": "price-drop-watchers",
};

const RECOVERY_LABELS: Record<RecoveryKind, string> = {
  carts: "Loading abandoned carts",
  "back-in-stock": "Loading back-in-stock requests",
  "price-drops": "Loading price-drop watchers",
};

/**
 * One page of a store's recovery queue.
 *
 * All three routes are `ScopeReadReports` (handlers.go:151,153,155), which is
 * a READ-ONLY scope on the session path (apikeys/middleware.go:331-336) — so
 * unlike the store list above them, these do not need an owner/admin role.
 * That asymmetry is the reason the screen can still show a viewer something
 * useful about a store it cannot enumerate.
 *
 * Deliberately UNFILTERED. `listCommerceStatusResource` accepts `?status=`
 * (handlers.go:2175) and the temptation is to request only `eligible` rows,
 * but then "3 waiting to be told" would have no denominator and the screen
 * could not honestly say "3 of the newest 25". One page, classified client
 * side, keeps the count and its denominator from the same read.
 */
export async function listCommerceRecovery(
  integrationId: string,
  kind: RecoveryKind,
  limit: number = COMMERCE_RECOVERY_PAGE_SIZE,
): Promise<RecoveryPage> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to read its recovery queue.");
  const params = new URLSearchParams({ limit: String(limit) });
  const raw = await commerceRequest<unknown>(
    "GET",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/${RECOVERY_PATHS[kind]}?${params.toString()}`,
    RECOVERY_LABELS[kind],
  );
  return normalizeRecoveryPage(kind, raw);
}

/**
 * Resume the provider backfill from the cursor the server already holds.
 *
 * The body is deliberately EMPTY: `SyncIntegration` only takes the
 * provider-pull path when `syncRequestHasPayload(in)` is false
 * (handlers.go:1434), and sending `{}` with a cursor would make the phone
 * responsible for cursor arithmetic it has no business owning.
 */
export async function resumeCommerceSync(
  integrationId: string,
): Promise<void> {
  const id = (integrationId ?? "").trim();
  if (!id) throw new Error("A store id is required to resume a sync.");
  await commerceRequest<unknown>(
    "POST",
    `/api/v1/commerce/integrations/${encodeURIComponent(id)}/sync`,
    "Starting the sync",
    {},
  );
}
