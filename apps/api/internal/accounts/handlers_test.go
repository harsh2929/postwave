// SPDX-License-Identifier: AGPL-3.0-only
package accounts

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func tenantReq(method, path, body string) *http.Request {
	ctx := middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "t1"})
	req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return req
}

// tenantReqWithID is tenantReq plus a chi route context carrying {id}, for
// the by-id handlers (Get/Update/Delete) that read chi.URLParam.
func tenantReqWithID(method, path, id, body string) *http.Request {
	r := tenantReq(method, path, body)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// All handlers must 401 without a tenant in context, before any DB touch.
func TestHandlers_RequireTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	cases := []struct {
		name string
		fn   http.HandlerFunc
		m    string
		path string
	}{
		{"list", d.List, http.MethodGet, "/api/v1/accounts"},
		{"get", d.Get, http.MethodGet, "/api/v1/accounts/x"},
		{"create", d.Create, http.MethodPost, "/api/v1/accounts"},
		{"update", d.Update, http.MethodPatch, "/api/v1/accounts/x"},
		{"delete", d.Delete, http.MethodDelete, "/api/v1/accounts/x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tc.fn(rec, httptest.NewRequest(tc.m, tc.path, nil))
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("%s status = %d, want 401", tc.name, rec.Code)
			}
		})
	}
}

// Create with an empty name → 400 invalid_name, before any DB call.
func TestCreate_RejectsEmptyName(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	rec := httptest.NewRecorder()
	d.Create(rec, tenantReq(http.MethodPost, "/api/v1/accounts", `{"name":"   "}`))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_name") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

// Create with an over-long name → 400 invalid_name.
func TestCreate_RejectsLongName(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"name":"` + strings.Repeat("a", MaxNameLength+1) + `"}`
	rec := httptest.NewRecorder()
	d.Create(rec, tenantReq(http.MethodPost, "/api/v1/accounts", body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

// Create with an oversized body → 413.
func TestCreate_RejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"name":"acme","industry":"` + strings.Repeat("x", int(accountJSONMaxBodyBytes)) + `"}`
	rec := httptest.NewRecorder()
	d.Create(rec, tenantReq(http.MethodPost, "/api/v1/accounts", body))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
}

// Update with a bad country length → 400 invalid_country.
func TestUpdate_RejectsLongCountry(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil}}
	body := `{"country":"` + strings.Repeat("Z", MaxCountryLength+1) + `"}`
	rec := httptest.NewRecorder()
	r := tenantReqWithID(http.MethodPatch, "/api/v1/accounts/abc", "abc", body)
	d.Update(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_country") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
