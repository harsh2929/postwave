/**
 * Product events — the ingest catalogue: which events this workspace receives,
 * at what volume, and when each was last seen.
 *
 * WHY THIS ROUTE IS `viewer` AND NOT `admin`. Every read behind it is
 * SCOPE-gated, not role-gated. `GET /api/v1/track/catalog` and
 * `/api/v1/track/stats` are `apikeys.RequireScope(ScopeReadReports)`
 * (track/handlers.go:93-94); `GET /api/v1/track/events` is
 * `RequireAllScopes(ScopeReadReports, ScopeReadSubscribers)` (:92). Both
 * scopes are in the `readOnlyScopes` allowlist (apikeys/middleware.go:331-336),
 * so `requireAdminRoleForScopes` returns false and the session-cookie path
 * never reaches the owner/admin check at middleware.go:211-221. A viewer sees
 * the whole screen. `routeauth/manifest.json` agrees — all three rows are
 * `session_minimum_role: viewer` with `review_status: "reviewed"` rather than
 * the auto-generated `safe-default:read` / `fail_closed_default` pair — but the
 * handler is what was read, and the handler is what this floor is based on.
 *
 * The one route on this surface that is NOT viewer-reachable is
 * `POST /api/v1/track`, which is `ScopeAdmin` (:90). That is ingest, and it is
 * deliberately not built: see the note in ProductEventsScreen.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ProductEventsScreen } from "@/components/product-events/ProductEventsScreen";

/**
 * Route-scoped boundary. Product-event properties are an untyped
 * `map[string]interface{}` written by whatever integration is sending them
 * (track/repo.go:35), so this screen renders the least predictable payload in
 * the app — a render throw here must cost this tab and not the whole shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function ProductEvents() {
  return <ProductEventsScreen />;
}
