// handlers_gaps_test.go — unit coverage for the desktop-audit gap
// endpoints (A3 audit read, A4 bulk emails, A5 trend). DB-backed paths
// are covered by the integration tests when DATABASE_URL is set; these
// pin the validation + auth short-circuits and the wire-shape helpers.

package suppressions

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestMountAllX1Routes_NoChiCollision registers every X1 mount group
// on one router alongside the legacy wildcard route the subscribers
// package puts at DELETE /api/v1/suppressions/{id} — chi panics at
// registration time on wildcard-name conflicts, so a clean pass here
// proves the main.go composition can't crash at startup.
func TestMountAllX1Routes_NoChiCollision(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := chi.NewRouter()
	h.MountX1Routes(r)
	h.MountX1ReadRoutes(r)
	h.MountX1BulkRoutes(r)
	h.MountX1MirrorRoutes(r)
	// Stand-ins for the legacy routes sharing the /api/v1/suppressions
	// prefix on the same protected router in main.go.
	noop := func(http.ResponseWriter, *http.Request) {}
	r.Delete("/api/v1/suppressions/{id}", noop)
	r.Get("/api/v1/suppressions", noop)
	r.Post("/api/v1/suppressions", noop)
	r.Post("/api/v1/suppressions/bulk", noop)
	r.Post("/api/v1/suppressions/import", noop)
	r.Get("/api/v1/suppressions/export", noop)
}

/* ---------- A5: trend ---------------------------------------------- */

// TestTrend_RequiresTenant guards the unauthenticated path.
func TestTrend_RequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/suppressions/trend?days=30", nil)
	w := httptest.NewRecorder()
	h.Trend(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

/* ---------- A3: audit read ----------------------------------------- */

// TestAuditList_RequiresTenant guards the unauthenticated path.
func TestAuditList_RequiresTenant(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/suppressions/x@y.z/audit", nil)
	w := httptest.NewRecorder()
	h.AuditList(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

// TestAuditList_RejectsMissingKey covers the empty-{id} short-circuit.
func TestAuditList_RejectsMissingKey(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/suppressions//audit", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.AuditList(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

// TestLooksLikeUUID pins the {email-or-id} disambiguator.
func TestLooksLikeUUID(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"3b4c0c1e-9a2f-4f6e-8a3b-1c2d3e4f5a6b", true},
		{"user@example.com", false},
		// 36-char email with 4 hyphens must still route as an email.
		{"a-b-c-d@looks-like.example.comzzzzzz", false},
		{"not-a-uuid", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := looksLikeUUID(tc.in); got != tc.want {
			t.Errorf("looksLikeUUID(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

/* ---------- A4: bulk emails ---------------------------------------- */

// TestBulkDelete_AcceptsEmailsOnly verifies an emails-only selection
// passes validation (the A4 id-reconciliation path) — the nil-pool
// store makes resolution fail per-address, which must surface inside
// the 200 envelope's errors[] rather than 400.
func TestBulkDelete_AcceptsEmailsOnly(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-delete",
		strings.NewReader(`{"emails":["a@b.c"]}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkDelete(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"deleted_count":0`) {
		t.Errorf("body = %s, want deleted_count 0", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "a@b.c:") {
		t.Errorf("body = %s, want per-email resolution error", w.Body.String())
	}
}

// TestBulkDelete_CombinedCapAppliesAcrossIDsAndEmails — the 500-row
// ceiling counts ids + emails together.
func TestBulkDelete_CombinedCapAppliesAcrossIDsAndEmails(t *testing.T) {
	ids := strings.Repeat(`"i",`, 300)
	emails := strings.Repeat(`"e@x.y",`, 300)
	body := `{"ids":[` + strings.TrimSuffix(ids, ",") + `],"emails":[` + strings.TrimSuffix(emails, ",") + `]}`
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-delete", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkDelete(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
}

// TestBulkAction_ChangeReasonRejectsBadReason pins enum validation on
// the change_reason branch.
func TestBulkAction_ChangeReasonRejectsBadReason(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-action",
		strings.NewReader(`{"ids":["x"],"action":"change_reason","reason":"nope"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkAction(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "invalid_reason") {
		t.Errorf("body = %s, want invalid_reason", w.Body.String())
	}
}

// TestBulkAction_AcceptsEmailsOnlySelection mirrors the bulk-delete
// email-selection test for the bulk-action body shape.
func TestBulkAction_AcceptsEmailsOnlySelection(t *testing.T) {
	h := &StoreHandlers{Store: &Store{Pool: nil}}
	r := httptest.NewRequest("POST", "/api/v1/suppressions/bulk-action",
		strings.NewReader(`{"emails":["a@b.c"],"action":"change_reason","reason":"list_manual"}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	h.BulkAction(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"updated_count":0`) {
		t.Errorf("body = %s, want updated_count 0", w.Body.String())
	}
}
