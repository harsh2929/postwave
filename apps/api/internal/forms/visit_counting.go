// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"net/http"
	"strings"
)

// PublicLookupPurposeHeader lets a caller say what a public form-definition
// read is for. The one value it recognises is PublicLookupPurposeSuccessCopy:
// the hosted success page reading the form's own success message to show
// somebody who has just submitted it.
//
// It exists because form_visits counts hosted RENDERS, and the conversion rate
// the forms list shows divides submissions by that count. A page that is only
// reached after a submission is not a view of the form, so counting its lookup
// would add one visit per conversion and quietly depress every hosted form's
// conversion rate.
//
// This is a hint from an unauthenticated caller and is treated as one. The only
// thing setting it can do is decline to be counted: it changes no answer, gains
// the caller nothing, and cannot inflate anybody's numbers.
const (
	PublicLookupPurposeHeader      = "X-Postwave-Form-Lookup"
	PublicLookupPurposeSuccessCopy = "success-copy"
)

// recordRenderVisit counts the read as a hosted-form view unless the caller
// declared it something other than a render.
func (d *Deps) recordRenderVisit(r *http.Request, f *Form) {
	if strings.EqualFold(
		strings.TrimSpace(r.Header.Get(PublicLookupPurposeHeader)),
		PublicLookupPurposeSuccessCopy,
	) {
		return
	}
	d.recordVisit(r.Context(), f)
}
