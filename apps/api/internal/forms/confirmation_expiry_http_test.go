// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The expired/missing distinction must reach a PAGE.
//
// The repo layer returning a distinct ErrConfirmationExpired is worth nothing if
// the handler does not map it: before this, the new error fell through to
// WriteInternal and a person who clicked a real confirmation link they had
// simply left too long was told "an internal error occurred", with nothing to
// act on. An adversarial review caught exactly that, and this keeps it caught.

func TestAnExpiredLinkRendersAsGoneNotAsAServerError(t *testing.T) {
	pool := newFormsExpiryPool(t)
	_, token := seedPendingSubmission(t, pool, true)

	d := &Deps{Repo: &Repo{Pool: pool}}
	req := httptest.NewRequest(http.MethodGet, "/api/public/forms/confirm/"+token, nil)
	rc := chi.NewRouteContext()
	rc.URLParams.Add("token", token)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	rec := httptest.NewRecorder()
	d.PublicConfirm(rec, req)
	t.Logf("EXPIRED LINK -> HTTP %d body=%s", rec.Code, rec.Body.String())
	// Asserted as the exact status and body. An earlier version checked only
	// "not 500", which a 200 `confirmed` would have satisfied — i.e. the test
	// would have passed over the original bug.
	if rec.Code != http.StatusGone {
		t.Fatalf("expired link -> HTTP %d, want 410 Gone. body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %s", rec.Body.String())
	}
	if body["state"] != "expired" {
		t.Fatalf("state = %q, want \"expired\" — the web client switches on this "+
			"to choose between \"sign up again\" and \"refresh in a moment\"", body["state"])
	}
}
