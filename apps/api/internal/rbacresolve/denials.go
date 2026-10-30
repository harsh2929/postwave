// SPDX-License-Identifier: AGPL-3.0-only

package rbacresolve

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// Two refusals side by side that mean opposite things.
//
// `insufficient_permission` is a role denial — someone with the right role can
// do this, so the affordance is to go and ask them. `permission_check_failed` is
// the fail-closed path taken when the grant store cannot be READ: nothing about
// the caller is wrong, and "ask an admin to change your role" is useless advice
// for an outage.
//
// Both went out as a 403 carrying prose, so a client could render only one
// answer for both — and the wrong one is the more damaging, because it tells a
// user their permissions are lacking when the system simply could not look.
//
// The CODES are unchanged; they are an existing client contract.

// writeInsufficientPermissionDenial refuses a caller whose role lacks a
// permission.
//
// The permission name stays in the message: "your role does not have the X
// permission" is the only part of this that helps anyone work out what to ask
// for.
func writeInsufficientPermissionDenial(w http.ResponseWriter, permission string) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "permission",
		Reason:  entitlement.ReasonRole,
		Code:    "insufficient_permission",
		Message: "your role does not have the " + permission + " permission",
	})
}

// writePermissionCheckFailedDenial is the fail-closed path when the grant store
// cannot be read.
//
// ReasonRuntime: nothing the caller does changes it. Deliberately still a
// refusal rather than a 500 — an inability to resolve grants must deny, never
// allow, or a store outage becomes an escalation. Classifying it correctly is
// what lets a client say "try again shortly" instead of sending someone to
// their admin.
func writePermissionCheckFailedDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "permission",
		Reason:  entitlement.ReasonRuntime,
		Code:    "permission_check_failed",
		Message: "could not resolve your role's permissions",
	})
}
