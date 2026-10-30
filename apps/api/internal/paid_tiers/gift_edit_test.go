// SPDX-License-Identifier: AGPL-3.0-only

package paid_tiers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// reqWithIDAndTenant builds a request carrying a chi {id} route param and a
// resolved tenant, so the handler's pre-DB validation runs. Validation
// rejections (422/400) fire before any Repo call, so no pool is needed.
func reqWithIDAndTenant(method, id, body string) *http.Request {
	req := httptest.NewRequest(method, "/api/v1/gift-subscriptions/"+id, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "t-1"})
	return req.WithContext(ctx)
}

func TestGiftUpdate_ValidationRejections(t *testing.T) {
	h := &GiftHandlers{} // nil repo: validation rejects before any DB call
	cases := []struct {
		name string
		body string
	}{
		{"no fields", `{}`},
		{"bad email", `{"recipient_email":"not-an-email"}`},
		{"blank email", `{"recipient_email":"   "}`},
		{"malformed json", `{nope`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.Update(rec, reqWithIDAndTenant(http.MethodPatch, "abc", c.body))
			if rec.Code < 400 || rec.Code >= 500 {
				t.Fatalf("%s: want 4xx, got %d (%s)", c.name, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestGiftEdit_NoTenantUnauthorized(t *testing.T) {
	h := &GiftHandlers{}
	for _, tc := range []struct {
		name string
		fn   http.HandlerFunc
		m    string
	}{
		{"detail", h.Detail, http.MethodGet},
		{"update", h.Update, http.MethodPatch},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.m, "/api/v1/gift-subscriptions/abc", strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		tc.fn(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: want 401 without tenant, got %d", tc.name, rec.Code)
		}
	}
}
