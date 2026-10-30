package subscribers

// Activity-handler tests that don't need postgres. The repo.Activity
// method runs SQL against subscriber_events; that's covered by
// integration tests in services/automation. Here we exercise the
// HTTP-level branches.

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestActivity_RequiresTenant — without a tenant the handler must
// 401 before any pool access, so we can pass a nil Repo.
func TestActivity_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/subscribers/abc/activity", nil)
	w := httptest.NewRecorder()
	d.Activity(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}
