/**
 * Compliance — which frameworks are attested, and what is about to lapse.
 *
 * A MONITOR, NOT AN ATTESTATION CONSOLE. The desktop's
 * `apps/desktop/src/pages/Compliance.tsx` is 1,153 lines of posture strip,
 * framework grid, gate checklists, an attest modal with document path + SHA-256
 * fields, and an event ledger. The authoring half of that does not port:
 * signing an attestation is a legal act that wants the auditor's report open
 * and the document hash to hand, and a phone can supply neither. What DOES
 * port is the renewal clock — "SOC 2 renews in nine days" is a glance, and the
 * cost of missing it is the weeks between the lapse and somebody noticing.
 *
 * ONE WRITE, ADDED DELIBERATELY: assurance LEGAL HOLDS (ASSURE#6). It passes the
 * test this docstring already sets rather than breaking the rule — placing a hold
 * stops retention sweeps TONIGHT, and evidence a sweep has taken cannot be
 * recreated. It also needs no document hash, only a reason, which is the other
 * reason attestation does not port. Its three routes were mounted with no client
 * on ANY surface.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT OFFER: attesting, renewing, or
 * withdrawing. All three write a permanent row to an auditable ledger. The
 * first two would produce a compliance claim with no document hash attached
 * (the upsert only preserves a prior hash on a renewal — compliance.go:250-251,
 * so a first attestation sent without one stores empty strings). The third has
 * the same legal weight with none of the urgency: revoking a tracker row stops
 * nothing tonight, unlike the warehouse monitor's `pause`, which is why that
 * surface carries a write and this one does not.
 *
 * ROLE. Owner/admin only, and unusually BOTH authorization layers say so.
 * `compliance.Deps.MountRoutes` (apps/api/internal/compliance/compliance.go
 * :111-117) registers the routes with no guard of its own — its comment says
 * "the caller is expected to wrap them with the admin scope" — and the caller,
 * `MountPrivacyComplianceRoutes` (apps/api/internal/server/tenant_governance.go
 * :125-128), wraps the group in `apikeys.RequireScope(apikeys.ScopeAdmin)`.
 * `ScopeAdmin` is not in the `readOnlyScopes` allow-list
 * (apps/api/internal/apikeys/middleware.go:332-337), so on the session path
 * `RequireScope` degenerates into an owner|admin ROLE check (:211-220, :353-356).
 * The generated `routeauth` manifest independently carries
 * `"session_minimum_role": "admin"` with `"review_status": "reviewed"` on all
 * five rows. An API key would need the literal `admin` scope, which mobile
 * never holds.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { CompliancePostureScreen } from "@/components/compliance/CompliancePostureScreen";

/**
 * Route-scoped boundary. Every value on this screen is a legal claim about the
 * workspace, so a render crash on an unexpected payload shape must cost this
 * tab and not the app shell — and must never be recoverable by showing a
 * partially-painted posture.
 */
export { AppErrorBoundary as ErrorBoundary };

export default function Compliance() {
  return <CompliancePostureScreen />;
}
