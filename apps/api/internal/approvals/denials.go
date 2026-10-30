// SPDX-License-Identifier: AGPL-3.0-only

package approvals

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// This surface's refusals, in the shared vocabulary.
//
// Five sites, four distinct causes, and one affordance between them: prose. A
// client could not tell "you personally cannot decide this one" from "you need
// the admin role", and those want opposite screens — the first is a rule no
// permission change resolves, the second is a person to go and ask.
//
// The CODES are unchanged; they are an existing client contract.

// writeSelfApprovalDenial refuses the requester deciding their own approval.
//
// ReasonPolicy, not ReasonRole. Separation of duties is the entire point of an
// approval: no role grants it and no plan buys it. Calling it a role problem
// would send the requester to an admin who also cannot grant it, and the
// admin's answer would have to be "no, that's the rule" — a round trip the
// classification could have saved.
func writeSelfApprovalDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "approval",
		Reason:  entitlement.ReasonPolicy,
		Code:    "self_approval",
		Message: "the user who requested an approval cannot decide it",
	})
}

// writeApproverMismatchDenial refuses a decision link issued to someone else.
//
// ReasonPolicy for the same reason: the link belongs to a specific recipient,
// which is a property of the link rather than a permission the caller lacks.
func writeApproverMismatchDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "approval",
		Reason:  entitlement.ReasonPolicy,
		Code:    "approver_mismatch",
		Message: "this approval link was issued to a different recipient",
	})
}

// writeApprovalsRoleDenial refuses a caller whose role is insufficient.
//
// The one refusal here that IS a person to go and ask, so it carries the role
// name: the client renders "ask a workspace <role>", and without the name the
// best it can say is "ask an administrator" — which is wrong whenever the
// required role is something else.
func writeApprovalsRoleDenial(w http.ResponseWriter, message string) {
	entitlement.Write(w, entitlement.Denial{
		Subject:      "approval",
		Reason:       entitlement.ReasonRole,
		Code:         "forbidden",
		Message:      message,
		RequiredRole: "admin",
	})
}
