/**
 * Retention offers — the cancel-flow save-offer funnel, read-only.
 *
 * A MONITOR, NOT AN EDITOR, AND NOT BY MOBILE'S CHOICE. The server registers
 * exactly three routes for this subsystem and all three are GETs
 * (`retention_offers.Deps.MountRoutes`, called once from the main composition).
 * `Upsert`, `Deactivate`, `LogEvent` and the three portal
 * handlers are written and mounted nowhere; the package header states the
 * reason — paid mutations and portal acceptance stay unmounted "until a real
 * Stripe adapter and reconciliation are certified". Authoring an offer also
 * needs a percent/fixed XOR, a tier picker and a coupon mirror, which is desk
 * work; but even if it were phone work, there is nothing to POST to.
 *
 * WHY minimumRole IS `admin`. The main composition wraps the three retention
 * reads in `apikeys.RequireExactTenantAdmin`; the supporting paywall-tier read
 * has the same owner/admin floor. The guard is invisible from handlers.go,
 * which is precisely why the mount site and query-level gate have to agree.
 *
 * NativeWind v4: static style objects only.
 */
import { RetentionOffersScreen } from "@/components/retention-offers/RetentionOffersScreen";

/**
 * Route-scoped boundary. Every figure on this screen is parsed from a payload
 * this app has never rendered before, so a shape surprise must cost this tab
 * and not the whole app shell.
 */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function RetentionOffers() {
  return <RetentionOffersScreen />;
}
