package customfields

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// tenantReq builds a request carrying a tenant in context so handler guards
// past the no-tenant check.
func tenantReq(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "tenant_test"}))
}

// TestUpdateSettings_RequiresTenant confirms the PUT handler returns 401 when
// no tenant is in context (the guard runs before any DB access).
func TestUpdateSettings_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings/custom-fields",
		strings.NewReader(`{"max_custom_fields":10}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	d.UpdateSettings(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestUpdateSettings_RejectsEmptyBody confirms a body with neither cap is a
// 400 — the validation guard fires before any DB access (Pool is nil).
func TestUpdateSettings_RejectsEmptyBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.UpdateSettings(rec, tenantReq(http.MethodPut, "/api/v1/settings/custom-fields", `{}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no_fields") {
		t.Fatalf("body = %s, want no_fields", rec.Body.String())
	}
}

// TestUpdateSettings_RejectsNegativeLimits confirms negative caps are a 400
// before any DB access.
func TestUpdateSettings_RejectsNegativeLimits(t *testing.T) {
	cases := []string{
		`{"max_custom_fields":-1}`,
		`{"max_searchable_fields":-5}`,
	}
	for _, body := range cases {
		d := &Deps{Repo: &Repo{Pool: nil}}
		rec := httptest.NewRecorder()
		d.UpdateSettings(rec, tenantReq(http.MethodPut, "/api/v1/settings/custom-fields", body))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "invalid_limit") {
			t.Fatalf("body %s: response = %s, want invalid_limit", body, rec.Body.String())
		}
	}
}

// TestUpdateSettings_RejectsOversizedBody confirms the body-size guard fires
// before any DB access.
func TestUpdateSettings_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"max_custom_fields":10,"junk":"` + strings.Repeat("x", int(customFieldJSONMaxBodyBytes)) + `"}`
	rec := httptest.NewRecorder()
	d.UpdateSettings(rec, tenantReq(http.MethodPut, "/api/v1/settings/custom-fields", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

// TestGetSettings_RequiresTenant confirms the GET handler returns 401 with no
// tenant in context.
func TestGetSettings_RequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings/custom-fields", nil)
	rec := httptest.NewRecorder()
	d.GetSettings(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

// TestErrLimitExceeded_WrapsCleanly confirms the soft-limit sentinel survives
// fmt.Errorf wrapping so the handler's errors.Is check (→ 422) works and the
// detail message carries the used/max counts.
func TestErrLimitExceeded_WrapsCleanly(t *testing.T) {
	err := wrapWithLimit(12, 10)
	if !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("errors.Is(err, ErrLimitExceeded) = false for %v", err)
	}
	if !strings.Contains(err.Error(), "12/10") {
		t.Fatalf("error message = %q, want used/max detail", err.Error())
	}
}

// wrapWithLimit mirrors the wrapping shape used inside checkCreateLimit so the
// test exercises the same sentinel-wrapping contract without needing a DB tx.
func wrapWithLimit(used, max int) error {
	return errLimitf(used, max)
}
