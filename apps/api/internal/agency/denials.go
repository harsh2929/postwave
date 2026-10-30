// SPDX-License-Identifier: AGPL-3.0-only

package agency

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// writeNotAgencyDenial refuses a caller whose workspace is not an agency
// account.
//
// ReasonFlag: `is_agency_account` is workspace configuration. No plan includes
// it, so `upgrade_plan` would send someone to a billing page that cannot turn it
// on — and no role grants it either, so "ask an admin" would be equally wrong.
// The remedy is deliberately empty: for this refusal the honest answer is that
// nothing the caller does in-product resolves it.
func writeNotAgencyDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "agency",
		Reason:  entitlement.ReasonFlag,
		Code:    "not_agency",
		Message: "current tenant is not flagged is_agency_account",
	})
}
