/**
 * Conversions — did revenue land, and which campaign earned it.
 *
 * A MONITOR, NOT A CONSOLE. The desktop's
 * `apps/desktop/src/components/track/ConversionsSection.tsx` is a tracking
 * console: a cursor-paged raw conversion feed plus creating and revoking the
 * public site key a tenant's JavaScript ships. Key creation returns the
 * full publishable key exactly once, so it is credential authoring and stays
 * on a desk. REVOKING that key is different — it returns no secret and is the verb
 * performed the moment a key turns up somewhere it should not be, so the
 * screen carries it (TrackingKeysPanel), exactly as it does for the HMAC
 * ingest secrets beside it. The raw feed carries `subscriber_email` on every row — which is why its
 * own guard demands `read:reports` AND `read:subscribers` — and this app
 * deliberately never requests it: a phone is glanceable from across a table and
 * there is no operations question that needs a recipient-identified purchase
 * log on one. The aggregates answer the money question without naming anybody.
 *
 * ROLE. Viewer, and both authorization layers agree, which is worth recording
 * because on most surfaces they do not. `conversions.Mount`
 * (apps/api/internal/conversions/attribution.go:704-713) guards
 * `/attribution/campaigns` and `/attribution/timeseries` with
 * `apikeys.RequireScope(apikeys.ScopeReadReports)`; `ScopeReadReports` is in
 * `readOnlyScopes` (apps/api/internal/apikeys/middleware.go:332-337), so
 * `requireAdminRoleForScopes` returns false and the session path admits every
 * authenticated role. The routeauth manifest rows for both paths say
 * `session_minimum_role: viewer` with `policy_source:
 * openapi.x-required-scopes` and `review_status: reviewed` — a checked row, not
 * a fail-closed default. The one route on this family that is NOT viewer is
 * `POST /attribution/backfill`, which is a write and is admin-scoped; this
 * screen does not offer it.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ConversionsScreen } from "@/components/conversions/ConversionsScreen";

/**
 * Route-scoped boundary. Campaign names and currency codes on this screen come
 * from tenant data and from a third-party storefront's conversion payload, so a
 * render crash on an unexpected shape must cost this tab and not the app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function Conversions() {
  return <ConversionsScreen />;
}
