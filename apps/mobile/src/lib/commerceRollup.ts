/**
 * lib/commerceRollup.ts — parsing the commerce store feed and its analytics.
 *
 * WHY MOBILE GETS A COMMERCE SURFACE AT ALL. `apps/api/internal/commerce` is
 * one of the largest subsystems in the product — twenty-odd routes, six
 * provider adapters, a webhook claim table and a resumable backfill cursor —
 * and `grep -rli commerce apps/mobile` returned two incidental string matches.
 * The desktop's four-tab browse tables (12-column customer/product/order grids)
 * are correctly desktop-only. What is NOT desktop-only is the question the
 * subsystem exists to answer away from a desk: *is the store pipeline still
 * flowing, and if it stopped, when and why*.
 *
 * THE SHAPES THIS MIRRORS, read from the Go source rather than from a doc:
 *   - `Integration`          apps/api/internal/commerce/types.go:28-44
 *   - `IntegrationSyncState` types.go:46-59  (decorated onto every list row by
 *     `decorateIntegrationListSyncState`, handlers.go:203)
 *   - `Analytics`            types.go:687-696
 *
 * TWO SERVER FACTS THAT SHAPE THE UI AND ARE EASY TO GET WRONG:
 *
 *  1. THE LIST ROUTE IS ADMIN-SCOPED, THE DETAIL ROUTES ARE NOT.
 *     `GET /api/v1/commerce/integrations` is mounted behind
 *     `apikeys.RequireScope(ScopeAdmin)` (handlers.go:138) while
 *     `GET /{id}` and `GET /{id}/analytics` take `ScopeReadReports`
 *     (handlers.go:140, :166). For a session cookie `RequireScope` turns an
 *     admin scope into an owner/admin ROLE check (middleware.go:211-220), so an
 *     editor or viewer gets a 403 `insufficient_role` on the only route that
 *     can ENUMERATE stores — and there is no read-scoped alternative. The
 *     screen therefore has to treat 403 as a first-class, explainable state
 *     rather than as "no stores connected".
 *  2. REVENUE IS IN CENTS AND THE CURRENCY IS PER-INTEGRATION.
 *     `Analytics.RevenueCents` is an int and `Currency` defaults to "USD" only
 *     because the SQL COALESCEs it (repo.go:2582). Dividing by 100 and
 *     hard-coding a dollar sign is how a EUR store's numbers end up wrong on
 *     one surface and right on every other.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

export type CommerceSyncTone = "ok" | "retrying" | "failed" | "idle";

export interface CommerceStore {
  id: string;
  provider: string;
  /** Shop domain when the provider has one ("acme.myshopify.com"). */
  shopDomain: string;
  status: string;
  /** ISO timestamp of the last successful sync, or "". */
  lastSyncAt: string;
  /** Top-level integration error (not the per-cursor one). */
  errorMessage: string;
  sync: CommerceSyncHealth;
}

export interface CommerceSyncHealth {
  tone: CommerceSyncTone;
  /** Human sentence. Always non-empty. */
  label: string;
  attempts: number;
  lastError: string;
  retryDue: boolean;
  complete: boolean;
  /** ISO timestamp of the next scheduled attempt, or "". */
  nextAttemptAt: string;
}

export interface CommerceAnalytics {
  customers: number;
  products: number;
  orders: number;
  /** Integer cents, exactly as the server sent it. */
  revenueCents: number;
  averageOrderCents: number;
  currency: string;
  ordersByStatus: { status: string; count: number }[];
  lastOrderAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/** Cents → major units. Kept here so no call site re-derives the /100. */
export function centsToMajor(cents: number): number {
  return int(cents) / 100;
}

/**
 * Classify one integration's backfill cursor.
 *
 * `complete` is checked FIRST and beats a stale `last_error`: a cursor that
 * finished carries the error from the attempt before the one that succeeded,
 * and reporting a finished backfill as failing is how someone re-runs a sync
 * that did not need re-running. `retry_due` beats a bare `last_error` for the
 * same reason in the other direction — the platform has already scheduled the
 * next attempt, so the honest word is "retrying", not "failed".
 */
export function syncHealthOf(raw: unknown): CommerceSyncHealth {
  const state = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const attempts = Math.max(0, int(state.attempts));
  const lastError = str(state.last_error);
  const retryDue = state.retry_due === true;
  const complete = state.complete === true;
  const nextAttemptAt = str(state.next_attempt_at);

  if (complete) {
    return {
      tone: "ok",
      label: "Backfill complete",
      attempts,
      lastError: "",
      retryDue: false,
      complete: true,
      nextAttemptAt: "",
    };
  }
  if (retryDue) {
    return {
      tone: "retrying",
      label:
        attempts > 0
          ? `Retrying after ${attempts} failed attempt${attempts === 1 ? "" : "s"}`
          : "Retry scheduled",
      attempts,
      lastError,
      retryDue: true,
      complete: false,
      nextAttemptAt,
    };
  }
  if (lastError) {
    return {
      tone: "failed",
      label: "Sync stopped on an error",
      attempts,
      lastError,
      retryDue: false,
      complete: false,
      nextAttemptAt,
    };
  }
  return {
    tone: "idle",
    label: "No backfill in progress",
    attempts,
    lastError: "",
    retryDue: false,
    complete: false,
    nextAttemptAt: "",
  };
}

/** Unwrap the array / `{items}` shapes the list endpoint has been seen to send. */
function unwrap(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const env = payload as { items?: unknown; integrations?: unknown };
  if (Array.isArray(env.items)) return env.items;
  if (Array.isArray(env.integrations)) return env.integrations;
  return [];
}

export function normalizeCommerceStores(payload: unknown): CommerceStore[] {
  const out: CommerceStore[] = [];
  for (const entry of unwrap(payload)) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = str(row.id);
    if (!id) continue;
    out.push({
      id,
      provider: str(row.provider) || "store",
      shopDomain: str(row.shop_domain),
      status: str(row.status) || "unknown",
      lastSyncAt: str(row.last_sync_at),
      errorMessage: str(row.error_message),
      sync: syncHealthOf(row.sync_state),
    });
  }
  return out;
}

export function normalizeCommerceAnalytics(payload: unknown): CommerceAnalytics {
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const byStatus: { status: string; count: number }[] = [];
  const map = row.orders_by_status;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [status, count] of Object.entries(
      map as Record<string, unknown>,
    )) {
      const n = int(count);
      if (!status || n <= 0) continue;
      byStatus.push({ status, count: n });
    }
    // Highest count first, then alphabetically — a stable order, so the strip
    // does not reshuffle itself between two identical refreshes.
    byStatus.sort((a, b) =>
      b.count === a.count ? a.status.localeCompare(b.status) : b.count - a.count,
    );
  }
  return {
    customers: Math.max(0, int(row.customers)),
    products: Math.max(0, int(row.products)),
    orders: Math.max(0, int(row.orders)),
    revenueCents: int(row.revenue_cents),
    averageOrderCents: int(row.average_order_cents),
    currency: str(row.currency) || "USD",
    ordersByStatus: byStatus,
    lastOrderAt: str(row.last_order_at),
  };
}

/**
 * The four HTTP outcomes a resume-sync can produce, in the customer's words.
 *
 * `payload_required` (422) is the one that reads as nonsense without help: it
 * means the provider has no server-side puller wired, so a sync can only be
 * driven by POSTing canonical records — which is an integration job, not
 * something a phone can do. Saying "this provider can't be resumed from here"
 * is the truth; "Unprocessable Entity" is not.
 */
export function commerceSyncErrorMessage(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status: unknown }).status)
      : 0;
  if (status === 403) {
    return "Resuming a sync needs an owner or admin session.";
  }
  if (status === 409) {
    return "This store is disconnected. Reconnect it on the web admin first.";
  }
  if (status === 422) {
    return "This provider can't be resumed from the app — it needs a sync run from the web admin.";
  }
  if (status === 404) {
    return "That store no longer exists. Pull to refresh.";
  }
  const message =
    err instanceof Error && err.message ? err.message.trim() : "";
  return message || "Couldn't start the sync.";
}

/**
 * True when a failure means "your session isn't allowed to enumerate stores",
 * which the screen must say out loud instead of rendering an empty portfolio.
 */
export function isCommerceScopeDenied(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return Number((err as { status?: unknown }).status) === 403;
}

/** Stores whose pipeline needs a human. Drives the header count. */
export function storesNeedingAttention(
  stores: readonly CommerceStore[],
): number {
  return stores.filter(
    (s) =>
      s.sync.tone === "failed" ||
      s.errorMessage !== "" ||
      s.status.toLowerCase() === "disconnected",
  ).length;
}
