// SPDX-License-Identifier: AGPL-3.0-only

package impersonate

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// writeImpersonationReadOnlyDenial refuses a write inside a read-only support
// session.
//
// ReasonPolicy, deliberately not ReasonRole: the support engineer's own role may
// be unlimited. What limits them is the SESSION they chose to start, and calling
// it a role problem invites the two wrong readings — "ask for more access" and
// "your account is limited" — when the answer is specific and immediate: change
// the scope, or end and restart.
func writeImpersonationReadOnlyDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "impersonation",
		Reason:  entitlement.ReasonPolicy,
		Code:    "impersonation_read_only",
		Message: "this impersonation session is read-only; switch scope or end + re-start",
	})
}
