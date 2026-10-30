// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for GET/PUT /api/v1/settings/send-time-optimization (desktop
// gap A24). Covers the validation branches that fire before any DB
// call — tenant gate and the required {"enabled": bool} body.
package settings

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestSendTimeOptimizationGet_RequiresTenant(t *testing.T) {
	d := &SendTimeOptimizationDeps{Repo: &SendTimeOptimizationRepo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings/send-time-optimization", nil)
	rec := httptest.NewRecorder()
	d.Get(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestSendTimeOptimizationPut_RequiresTenant(t *testing.T) {
	d := &SendTimeOptimizationDeps{Repo: &SendTimeOptimizationRepo{}}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings/send-time-optimization",
		strings.NewReader(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Put(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestSendTimeOptimizationPut_RejectsMissingEnabled(t *testing.T) {
	d := &SendTimeOptimizationDeps{Repo: &SendTimeOptimizationRepo{}}
	for _, body := range []string{`{}`, `{"enable":true}`} {
		ctx := middleware.WithTenant(context.Background(),
			&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
		req := httptest.NewRequestWithContext(ctx, http.MethodPut,
			"/api/v1/settings/send-time-optimization", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		d.Put(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400; resp=%s", body, rec.Code, rec.Body.String())
		}
		wantCode := "missing_enabled"
		if strings.Contains(body, `"enable"`) {
			wantCode = "unknown_field"
		}
		if !strings.Contains(rec.Body.String(), wantCode) {
			t.Errorf("body %s: expected %s error code, got %s", body, wantCode, rec.Body.String())
		}
	}
}

func TestSendTimeOptimizationPut_RejectsBadJSON(t *testing.T) {
	d := &SendTimeOptimizationDeps{Repo: &SendTimeOptimizationRepo{}}
	ctx := middleware.WithTenant(context.Background(),
		&middleware.Tenant{ID: "00000000-0000-0000-0000-000000000001"})
	req := httptest.NewRequestWithContext(ctx, http.MethodPut,
		"/api/v1/settings/send-time-optimization", strings.NewReader(`{"enabled":`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.Put(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}
