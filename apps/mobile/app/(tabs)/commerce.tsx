/**
 * Commerce — store connections, their sync cursor, and what came through.
 *
 * NOT A HUB, AND THAT IS A DELIBERATE DOWNGRADE FROM THE BRIEF. The round-5
 * request was an "Enterprise hub" of commerce links. Reading
 * `apps/api/internal/commerce/handlers.go:137-167` rather than the OpenAPI
 * summary killed that idea: of the twenty mounted commerce routes, the ones a
 * hub row would point at (catalogs, cart-recovery links, back-in-stock
 * subscriptions, price-drop watchers, per-product inventory and price history)
 * are all either admin-scoped or require a PRODUCT ID that only the desktop's
 * 12-column browse grid can supply. A hub row leading to a screen that cannot
 * be reached without a product picker is a row that leads nowhere, so this is
 * the single surface with real, reachable backing instead.
 *
 * WHY THIS ROUTE IS `admin` AND NOT `viewer`. The route-auth manifest lists the
 * per-integration reads as `session_minimum_role: viewer`, and that is true —
 * `GET /{id}/analytics` and `GET /{id}/orders` are both mounted behind
 * `apikeys.RequireScope(ScopeReadReports)` (handlers.go:166, :164), and
 * `ScopeReadReports` is in the `readOnlyScopes` allowlist
 * (apikeys/middleware.go:332-337) so a session of any role clears them. But
 * every one of those routes needs an INTEGRATION ID, and the only route that
 * can enumerate integrations — `GET /api/v1/commerce/integrations`
 * (handlers.go:138) — is behind `ScopeAdmin`, which on the session path becomes
 * a hard owner/admin ROLE check (middleware.go:211-220). There is no
 * read-scoped alternative and no other source of an integration id on the
 * phone. So a viewer would reach a screen that can only ever render a 403
 * explainer. The screen still HANDLES that 403 as a first-class state, because
 * `storedGrantsCoverScopes` (middleware.go:216) can additively grant the admin
 * scope to a custom role, and because a role can change mid-session — but it is
 * a fallback, not the expected path.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { CommerceScreen } from "@/components/commerce/CommerceScreen";

/**
 * Route-scoped boundary. A commerce payload is third-party-shaped — provider
 * adapters funnel ten vocabularies into one wire — so a render crash here must
 * cost this tab and not the whole app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function Commerce() {
  return <CommerceScreen />;
}
