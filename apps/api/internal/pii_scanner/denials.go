// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/entitlement"
)

// writeStableReviewerRequiredDenial refuses a review decision from a caller
// with no stable identity.
//
// A PII finding's review has to be attributable to a person — that is the point
// of recording it. An API key is not a person, so the decision would land with
// nobody's name on it.
//
// ReasonPolicy, not ReasonRole: no role turns an anonymous credential into a
// person, so "ask an admin" would send someone somewhere that cannot help. It
// is a property of HOW they authenticated, and the answer is to sign in as
// themselves.
func writeStableReviewerRequiredDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject: "pii_finding_review",
		Reason:  entitlement.ReasonPolicy,
		Code:    "stable_reviewer_required",
		Message: "a stable authenticated reviewer identity is required",
	})
}
