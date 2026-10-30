/**
 * api/productEvents.ts — the three product-event (Track) reads a phone can
 * honestly perform, and the two the API offers that it deliberately does not.
 *
 * AUTHORIZATION, read from the mount table in
 * apps/api/internal/track/handlers.go:80-96 rather than from the manifest:
 *
 *   GET  /api/v1/track/catalog     RequireScope(ScopeReadReports)          (:93)
 *   GET  /api/v1/track/stats       RequireScope(ScopeReadReports)          (:94)
 *   GET  /api/v1/track/events      RequireAllScopes(ScopeReadReports,
 *                                                   ScopeReadSubscribers)  (:92)
 *
 * Both scopes are in `readOnlyScopes` (apikeys/middleware.go:331-336), so
 * `requireAdminRoleForScopes` returns false and the session-cookie path skips
 * the role check entirely (middleware.go:211-221) — every role, viewer
 * included, clears all three. `apps/api/internal/routeauth/manifest.json`
 * independently lists all three at `session_minimum_role: viewer` with
 * `review_status: "reviewed"`, and routeauth.Middleware evaluates that on top
 * of the per-route scope check, so both gates agree.
 *
 * An API-KEY caller is the one case where the third route can 403 while the
 * first two succeed: a key holding only `read:reports` clears catalog+stats and
 * fails `RequireAllScopes` on `/track/events` with `insufficient_scope`. The
 * sample query owns that as its own explained state rather than letting a 403
 * blank the whole screen.
 *
 * TWO ROUTES DELIBERATELY NOT USED:
 *
 *   GET /api/v1/track/stream — Server-Sent Events (handlers.go:95). NOT for
 *     the reason this comment used to give. It said React Native's `fetch` has
 *     no `ReadableStream` body, so the app could not consume SSE; that is true
 *     of RN's GLOBAL fetch and false of the app, which streams through
 *     `expo/fetch` (see `api/sseConnect`, and `api/auditStream` for a live tail
 *     that exists). The real reason is what this screen IS: a monitor you open
 *     to ask "is the integration sending, and did anything stop?", answered
 *     from three bounded reads and closed. A live tail is a watch-it-scroll
 *     surface, which is a different feature and a socket held warm on a phone
 *     radio for as long as it is open. If that feature is wanted, the transport
 *     is ready and the route is on the stream-token allow-list
 *     (apikeys/stream_tokens.go).
 *   POST /api/v1/track — ingest, mounted behind `ScopeAdmin` (handlers.go:90),
 *     which for a session becomes an owner/admin ROLE check. It is also a
 *     WRITE that fans out to live flows and attributed revenue
 *     (handlers.go:83-88). A fixture composer belongs on a developer's bench,
 *     not in a monitor a phone opens at 6pm.
 */
import {
  normalizeProductEventCatalog,
  normalizeProductEventSample,
  normalizeProductEventStats,
  type ProductEventCatalog,
  type ProductEventSample,
  type ProductEventStats,
} from "@/lib/productEvents";

import { ApiRequestError } from "./apiRequestError";
import { rawRequest, type AIApiError } from "./request";

/**
 * The windows offered on the phone.
 *
 * The server clamps `days` to [1, 365] and falls back to 30 outside it
 * (extras.go:227-230), so any of these is safe. Three options rather than a
 * free date range because the catalogue answers a coarse question — is this
 * event still arriving — and a 43-day window answers it no better than 30.
 */
export const PRODUCT_EVENT_WINDOWS = [7, 30, 90] as const;
export type ProductEventWindow = (typeof PRODUCT_EVENT_WINDOWS)[number];
export const DEFAULT_PRODUCT_EVENT_WINDOW: ProductEventWindow = 30;

/**
 * How many raw rows one event's drill-down reads.
 *
 * `ListEvents` defaults to 50 (`atoiDefault(…, 50)`, handlers.go:284) and
 * returns no cursor and no total, so a page is a sample with nothing to page
 * through. 20 is a deliberate reduction: the question the rows answer is "what
 * does the payload actually look like right now", and rows 21-50 answer it
 * again at cellular cost.
 */
export const PRODUCT_EVENT_SAMPLE_LIMIT = 20;

/** Keeps the HTTP status so the UI can tell a 403 from a 500. */
export class ProductEventRequestError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "ProductEventRequestError";
  }
}

async function trackRequest<T>(path: string, label: string): Promise<unknown> {
  const res = await rawRequest<T>("GET", path);
  if (res.error) throw new ProductEventRequestError(res.error, label);
  return res.data;
}

/** Workspace-wide activity for the window. Powers the strip above the list. */
export async function fetchProductEventStats(
  days: number,
): Promise<ProductEventStats> {
  const params = new URLSearchParams({ days: String(days) });
  const raw = await trackRequest(
    `/api/v1/track/stats?${params.toString()}`,
    "Loading product-event activity",
  );
  return normalizeProductEventStats(raw);
}

/** One row per distinct event name seen in the window. The catalogue itself. */
export async function fetchProductEventCatalog(
  days: number,
): Promise<ProductEventCatalog> {
  const params = new URLSearchParams({ days: String(days) });
  const raw = await trackRequest(
    `/api/v1/track/catalog?${params.toString()}`,
    "Loading the event catalogue",
  );
  return normalizeProductEventCatalog(raw);
}

/**
 * The newest raw rows for ONE event name.
 *
 * `event_name` is matched server-side (`ListByEvent`, repo.go:37) — the
 * alternative, pulling recent events for the workspace and filtering on the
 * phone, would silently return nothing for any event quieter than the busiest
 * fifty. `before` is deliberately not sent: this is page one by definition.
 */
export async function fetchProductEventSample(
  eventName: string,
  limit: number = PRODUCT_EVENT_SAMPLE_LIMIT,
): Promise<ProductEventSample> {
  const name = (eventName ?? "").trim();
  if (!name) throw new Error("An event name is required to read its events.");
  const params = new URLSearchParams({
    event_name: name,
    limit: String(limit),
  });
  const raw = await trackRequest(
    `/api/v1/track/events?${params.toString()}`,
    "Loading recent events",
  );
  return normalizeProductEventSample(raw, limit);
}
