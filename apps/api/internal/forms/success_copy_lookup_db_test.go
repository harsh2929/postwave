// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The hosted success page shows the form's own Success message, which it can
// only get by reading the published form. That read happens once per accepted
// submission, and form_visits is the denominator of the conversion rate the
// forms list shows — so counting it would add a visit per conversion and
// depress every hosted form's rate. The public read therefore honours the
// caller's statement that a lookup is not a render, and counts everything else.
func TestASuccessPageCopyLookupIsNotCountedAsAFormView(t *testing.T) {
	h := newSignupHarness(t, harnessForm{
		settings: map[string]any{"successMessage": "You're in. The next letter goes out on Friday."},
	})
	router := chi.NewRouter()
	router.Get("/api/public/forms/{slug}", h.deps.PublicGet)

	read := func(purpose string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/public/forms/"+h.slug, nil)
		if purpose != "" {
			req.Header.Set(PublicLookupPurposeHeader, purpose)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("public form read = %d %s", rec.Code, rec.Body.String())
		}
		return rec
	}
	visits := func() int {
		t.Helper()
		return h.count(`SELECT COALESCE(SUM(count), 0)::int FROM form_visits WHERE form_id = $1::uuid`, h.formID)
	}

	// A hosted render is a visit.
	rendered := read("")
	if got := visits(); got != 1 {
		t.Fatalf("visits after one hosted render = %d, want 1", got)
	}
	// The page needs the authored message to be in that answer at all.
	if !strings.Contains(rendered.Body.String(), "The next letter goes out on Friday.") {
		t.Fatalf("the public form answer does not carry the form's success message:\n%s", rendered.Body.String())
	}

	// The success page reading that message after a submission is not.
	copyLookup := read(PublicLookupPurposeSuccessCopy)
	if got := visits(); got != 1 {
		t.Fatalf("visits after a success-copy lookup = %d, want the render's 1 (a conversion is not a view)", got)
	}
	if copyLookup.Body.String() != rendered.Body.String() {
		t.Fatalf("the lookup changed the answer:\n got %s\nwant %s", copyLookup.Body.String(), rendered.Body.String())
	}

	// An unrelated header value is not a licence to stop counting.
	read("render")
	if got := visits(); got != 2 {
		t.Fatalf("visits after another render = %d, want 2", got)
	}
}
