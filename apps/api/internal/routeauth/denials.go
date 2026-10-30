// SPDX-License-Identifier: AGPL-3.0-only

package routeauth

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The manifest gate's refusals: five sites, three distinct causes.
//
// Two mirror the apikeys gate — a role a colleague holds, versus a scope only
// the key's owner can widen. The third is different in kind and is the one most
// worth classifying: `route_authorization_unclassified` fires when the manifest
// has no approved policy for a route. Nothing about the caller is wrong. It is a
// deployment gap, and reporting it as a permission problem sends someone hunting
// a permission that was never the issue.
//
// The CODES are unchanged; they are an existing client contract.

// writeUnclassifiedRouteDenial is the fail-closed path for a route the manifest
// does not describe.
//
// Still a refusal, deliberately: an unclassified route must never default to
// allowed. ReasonPolicy rather than Role because no role change makes an
// unclassified route classified — the fix is in the manifest, not the caller.
func writeUnclassifiedRouteDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonPolicy,
		Code:    "route_authorization_unclassified",
		Message: "this route has no approved authorization policy",
	})
}

// writeAuthMethodDenial refuses a credential TYPE the route does not accept —
// an API key on a session-only route, say.
//
// No scope and no role fix it; the caller has to authenticate differently,
// which is why it needs its own code rather than collapsing into either.
func writeAuthMethodDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonPolicy,
		Code:    "insufficient_auth_method",
		Message: "this authentication method is not permitted for the route",
	})
}

// writeRouteRoleDenial refuses a caller whose role is too low.
func writeRouteRoleDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonRole,
		Code:    "insufficient_role",
		Message: "your role does not have permission for this route",
	})
}

// writeRouteScopeDenial refuses a key missing one or all required scopes.
//
// The message is a parameter because the two sites say different things ("does
// not have permission" vs "does not have EVERY permission"), and for an
// integrator debugging a conjunctive scope requirement that distinction is the
// entire content of the error.
func writeRouteScopeDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonPolicy,
		Code:    "insufficient_scope",
		Message: message,
	})
}
