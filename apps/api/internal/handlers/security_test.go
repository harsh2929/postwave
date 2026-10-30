package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Pre-DB validation paths for SecurityHandlers. The PUT happy path
// requires Postgres + RLS and is exercised by the smoke spec
// (tests/smoke/local-docker.spec.ts → "admin surfaces … respond").

func TestSecurity_Get_NoTenantReturns401(t *testing.T) {
	h := &SecurityHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/security/settings", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "no_tenant") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSecurity_Update_NoTenantReturns401(t *testing.T) {
	h := &SecurityHandlers{Pool: nil}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/security/settings",
		strings.NewReader(`{"require_2fa_for_admins":true}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Update(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestSecurity_Update_BadJSONReturns400(t *testing.T) {
	h := &SecurityHandlers{Pool: nil}
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{
		ID:   "00000000-0000-0000-0000-000000000001",
		Slug: "test",
	})
	req := httptest.NewRequestWithContext(ctx, http.MethodPut,
		"/api/v1/security/settings", strings.NewReader(`{not json`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Update(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "bad_json") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestNullStr_Helper(t *testing.T) {
	if v := nullStr(nil); v != nil {
		t.Errorf("nil pointer: got %v, want nil", v)
	}
	empty := ""
	if v := nullStr(&empty); v != nil {
		t.Errorf("empty string: got %v, want nil", v)
	}
	val := "okta"
	if v := nullStr(&val); v != "okta" {
		t.Errorf("set value: got %v, want okta", v)
	}
}

func TestNullInt_Helper(t *testing.T) {
	if v := nullInt(nil); v != nil {
		t.Errorf("nil pointer: got %v, want nil", v)
	}
	zero := 0
	if v := nullInt(&zero); v != 0 {
		t.Errorf("zero: got %v, want 0", v)
	}
	val := 60
	if v := nullInt(&val); v != 60 {
		t.Errorf("set value: got %v, want 60", v)
	}
}
