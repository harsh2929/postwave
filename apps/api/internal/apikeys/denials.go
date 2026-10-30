// SPDX-License-Identifier: AGPL-3.0-only

package apikeys

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// The route gate's refusals: eight sites, two distinct causes, one affordance.
//
// `insufficient_role` is about a PERSON — someone with a higher role can do
// this, so the answer is to go and ask them. `insufficient_scope` is about a
// CREDENTIAL: the API key was minted without the permission, and no colleague
// can fix that; its owner has to issue a new one.
//
// Both shipped as 403-with-prose, so a client had one answer for both — and the
// wrong one sends an integrator to their workspace admin instead of to their own
// key settings, where the actual fix is.
//
// The CODES are unchanged; they are an existing client contract.

// writeInsufficientRoleDenial refuses a caller whose ROLE is too low.
//
// The message is a parameter because the five sites refuse different things
// ("requires an authenticated dashboard user", "requires a higher role", "your
// role does not have permission for this audit route") and the wording is what
// tells an operator which.
func writeInsufficientRoleDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonRole,
		Code:    "insufficient_role",
		Message: message,
	})
}

// writeInsufficientScopeDenial refuses a caller whose API KEY lacks a scope.
//
// ReasonPolicy, deliberately not ReasonRole. A scoped key is a deliberate
// narrowing its owner chose, and no role change widens it — presenting it as a
// role problem produces the one piece of advice guaranteed not to work.
func writeInsufficientScopeDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonPolicy,
		Code:    "insufficient_scope",
		Message: message,
	})
}

// writeAuthMethodDenial refuses a credential TYPE the route does not accept.
//
// Neither a role nor a scope fixes it — the caller has to authenticate
// differently — so it needs its own code rather than collapsing into either.
// The message lists the accepted methods, which is the only actionable part.
func writeAuthMethodDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "route",
		Reason:  entitlement.ReasonPolicy,
		Code:    "insufficient_auth_method",
		Message: message,
	})
}
