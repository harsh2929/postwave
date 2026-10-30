/**
 * Flow A/B tests — the in-flow split monitor.
 *
 * WHY THIS EXISTS. `apps/api/internal/flowabtests` is a complete in-flow
 * experiment subsystem: a config table per automation node
 * (`automation_flow_ab_tests`, migration 0202), live per-variant counters the
 * automation runtime increments on every bucketing and every goal-met
 * (`flow_ab_test_results`, migration 1631, written at
 * services/automation/internal/runtime/postgres_store.go:466 and :516), and a
 * two-proportion z-test that records a winner. Seven routes are mounted and
 * NOTHING on this device consumed any of them — `src/api/flows.ts` explicitly
 * excluded the family with "a separate subsystem with its own results
 * surface", and that surface did not exist. Campaign A/B reporting on
 * app/(tabs)/campaigns is a DIFFERENT subsystem over a different table.
 *
 * THIS IS BACKED, AND I CHECKED THAT SPECIFICALLY. The flow-BUILDER runtime is
 * contained (`flowRuntimeQualified = false`, flowbuilder.go:27), which is why
 * app/(tabs)/flows refuses to render a runs tab. The counters here are written
 * by a DIFFERENT process — the automation service's engine
 * (services/automation/internal/runtime/engine.go:1169) over the older
 * `automations` spine — so unlike `/flows/{id}/runs` this table is not empty by
 * construction. That distinction is the whole reason this screen is honest and
 * a flow-runs screen would not be.
 *
 * WHAT THIS SCREEN DOES, AND WHY THAT AND NOT MORE
 *
 *   READ the splits, floated so the ones still collecting are on top; open one
 *   to see per-arm assignment and conversion counters joined to the authored
 *   variant list, plus any recorded verdict WITH THE DATE IT WAS TAKEN.
 *
 * Deliberately NOT here, each for a reason rather than for time:
 *   - CREATE / PATCH / DELETE (`POST|PATCH|DELETE /ab-tests[/{id}]`). A split
 *     is defined by an automation id, a node id inside that automation's graph
 *     and at least two weighted variants (`Create` rejects fewer,
 *     flowabtests.go:371). None of those is knowable without the canvas that
 *     produced them, and PATCH can silently replace the variant set the
 *     counters are keyed on.
 *   - EVALUATE (`POST /{id}/evaluate`). This is the one that looks like a read
 *     and is not: it computes the verdict AND writes `status='completed'`,
 *     `ended_at=now()` (`setWinner`, :205). Declaring a winner ENDS the
 *     experiment, one way, for the whole workspace. A phone at 2am is the
 *     wrong place to take that, so the screen says where it lives instead of
 *     offering a button that quietly stops a test.
 *
 * AUTHORIZATION: A SCOPE GATE, NOT A ROLE GATE. All three reads are mounted
 * `r.With(read)` where `read = apikeys.RequireScope(apikeys.ScopeReadCampaigns)`
 * (flowabtests.go:319-326). Nothing in the package calls `requireAdmin`. On the
 * session path that middleware looks the scope up in `readOnlyScopes`
 * (apikeys/middleware.go:332), finds `read:campaigns`, and so
 * `requireAdminRoleForScopes` returns false and applies NO role check — any
 * authenticated dashboard user, viewer included, may read. The route row
 * therefore carries no `minimumRole`, exactly like app/(tabs)/flows next door.
 * (The generated manifest agrees for once; the mount is still the evidence.)
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { FlowAbTestsScreen } from "@/components/flow-ab/FlowAbTestsScreen";

/**
 * Route-scoped boundary. The variant list is free-form JSON authored on a
 * canvas and the counters are joined to it by id, so a malformed config must
 * cost this tab and not the whole app shell.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function FlowAbTests() {
  return <FlowAbTestsScreen />;
}
