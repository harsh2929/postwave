package lists

// Unit-level tests for the per-list suppressions read (§A2 /
// GAP-LS-143). The join against v_suppressions_unified is integration
// territory; here we pin the request-shape gates plus the metadata
// decode helper.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newSuppressionsRouter(d *Deps) *chi.Mux {
	router := chi.NewRouter()
	router.Get("/api/v1/lists/{id}/suppressions", d.GetSuppressions)
	return router
}

// TestGetSuppressions_RequiresTenant — 401 without a tenant.
func TestGetSuppressions_RequiresTenant(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("GET", "/api/v1/lists/7/suppressions", nil)
	w := httptest.NewRecorder()
	newSuppressionsRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

// TestGetSuppressions_RepoMissing — 503 (not a crash) when the
// Postgres sidecar isn't wired, mirroring the members read.
func TestGetSuppressions_RepoMissing(t *testing.T) {
	d := New("http://upstream.invalid", "u", "p")
	req := httptest.NewRequest("GET", "/api/v1/lists/7/suppressions", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	newSuppressionsRouter(d).ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	if !strings.Contains(w.Body.String(), "repo_unavailable") {
		t.Fatalf("body = %q, want repo_unavailable", w.Body.String())
	}
}

// TestDecodeMetadataJSON — malformed metadata degrades to an empty map
// rather than failing the page.
func TestDecodeMetadataJSON(t *testing.T) {
	if got := decodeMetadataJSON(nil); got == nil || len(got) != 0 {
		t.Errorf("nil input: got %v, want empty map", got)
	}
	if got := decodeMetadataJSON([]byte("not json")); got == nil || len(got) != 0 {
		t.Errorf("malformed input: got %v, want empty map", got)
	}
	got := decodeMetadataJSON([]byte(`{"smtp_code": "550"}`))
	if got["smtp_code"] != "550" {
		t.Errorf("valid input: got %v, want smtp_code=550", got)
	}
}
