/**
 * Inbound routing — did mail reach a rule, and did its actions run.
 *
 * A MONITOR WITH AN OFF SWITCH, NOT A CONSOLE. The desktop's
 * `apps/desktop/src/pages/InboundRoutes.tsx` is a rule editor: the receiver
 * endpoint with a one-shot HMAC secret, a test-match panel, and a
 * priority-ordered table with inline drag reorder and type-to-confirm delete.
 * Glob grammar, priority ordering and a drag gesture are pointer-and-keyboard
 * work. The operations half ports: an inbound webhook that starts refusing at
 * 02:00 silently drops every reply until somebody notices — and once noticed
 * HERE, the rule can be switched off HERE (the stopping half,
 * lib/stoppingHalfPolicy; authoring still stays on the web admin).
 *
 * ROLE. Owner/admin, read off the HANDLER, because the manifest disagrees with
 * itself inside this one family. `MountRouteAdminRoutes`
 * (apps/api/internal/inbound_email/routes.go:80-89) applies
 * `apikeys.RequireScope(apikeys.ScopeAdmin)` to ALL EIGHT routes, including
 * `GET /{id}/matches` (:87) and `GET /matches/{match_id}/runs` (:88) — the two
 * this screen reads. `ScopeAdmin` is not in `readOnlyScopes`
 * (apps/api/internal/apikeys/middleware.go:332-337), so the session path admits
 * owner and admin only. The generated routeauth manifest lists
 * `GET /api/v1/inbound-routes` as `admin` with `review_status: reviewed`, but
 * both drill-down rows as `viewer` with `policy_source: safe-default:read` and
 * `review_status: fail_closed_default` — auto-generated from the verb and never
 * checked. Both guards run; the stricter one decides, and it is the handler.
 *
 * This also corrects the premise of the finding that asked for this screen: it
 * reasoned that authoring is keyboard work while "did mail actually route" is
 * the phone-shaped half. The second half is true as product design and buys no
 * lower role floor, because the monitoring reads are admin-gated too.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { InboundRoutesScreen } from "@/components/inbound-routes/InboundRoutesScreen";

/**
 * Route-scoped boundary. This screen renders subjects, sender addresses and an
 * upstream's raw response snippet — all third-party text captured from inbound
 * mail — so a render crash on an unexpected shape must cost this tab and not
 * the app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function InboundRoutes() {
  return <InboundRoutesScreen />;
}
