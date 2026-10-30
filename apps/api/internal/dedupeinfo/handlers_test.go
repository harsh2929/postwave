// SPDX-License-Identifier: AGPL-3.0-only
package dedupeinfo

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The validation branches (no-tenant, missing field, out-of-range) reject
// before any repo call, so they are reachable without a database. The full
// Load/Upsert round-trip needs postgres and follows the skip-on-unset-
// DATABASE_URL pattern used elsewhere in the codebase; here we cover the pure
// HTTP validation surface.

func TestUpdate_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/deduplication",
		strings.NewReader(`{"merge_confidence_threshold":0.9}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

func TestUpdate_RejectsMissingThreshold(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("PUT", "/api/v1/settings/deduplication",
		strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Update(w, r)
	if w.Code != 400 && w.Code != 422 {
		t.Errorf("status = %d, want 4xx for missing threshold", w.Code)
	}
	if !strings.Contains(w.Body.String(), "validation_failed") {
		t.Errorf("body = %q, want validation_failed", w.Body.String())
	}
}

func TestUpdate_RejectsOutOfRange(t *testing.T) {
	for _, body := range []string{
		`{"merge_confidence_threshold":1.5}`,
		`{"merge_confidence_threshold":-0.1}`,
	} {
		d := &Deps{Repo: &Repo{Pool: nil}}
		r := httptest.NewRequest("PUT", "/api/v1/settings/deduplication",
			strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
		w := httptest.NewRecorder()
		d.Update(w, r)
		if w.Code != 400 && w.Code != 422 {
			t.Errorf("body %s: status = %d, want 4xx out-of-range", body, w.Code)
		}
		if !strings.Contains(w.Body.String(), "invalid_threshold") {
			t.Errorf("body %s: response = %q, want invalid_threshold", body, w.Body.String())
		}
	}
}

func TestGet_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/settings/deduplication", nil)
	w := httptest.NewRecorder()
	d.Get(w, r)
	if w.Code != 401 {
		t.Errorf("status = %d, want 401 without tenant", w.Code)
	}
}

// TestGet_NilPoolReturnsDefault exercises the Load fallback: with a nil pool
// Load returns the default threshold (no DB), so Get serves a 200 with the
// historic 0.95 bar instead of failing.
func TestGet_NilPoolReturnsDefault(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	r := httptest.NewRequest("GET", "/api/v1/settings/deduplication", nil)
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.Get(w, r)
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), "merge_confidence_threshold") {
		t.Errorf("body = %q, want merge_confidence_threshold", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "0.95") {
		t.Errorf("body = %q, want default 0.95", w.Body.String())
	}
}
