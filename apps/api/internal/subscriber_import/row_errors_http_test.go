// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func rowErrorsUnitRequest(target, importID string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("id", importID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, route)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: uuid.NewString()})
	return req.WithContext(ctx)
}

func TestRowErrorsRejectsMalformedImportIDBeforeDatabaseAccess(t *testing.T) {
	recorder := httptest.NewRecorder()
	req := rowErrorsUnitRequest("/api/v1/subscriber-imports/not-a-uuid/errors", "not-a-uuid")

	(&Deps{}).RowErrors(recorder, req)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "invalid_id") {
		t.Fatalf("body=%s, want invalid_id", recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control=%q, want no-store", recorder.Header().Get("Cache-Control"))
	}
}

func TestRowErrorsRejectsUnboundedPaginationBeforeDatabaseAccess(t *testing.T) {
	id := uuid.NewString()
	tests := []struct {
		name  string
		query string
		code  string
	}{
		{name: "non-numeric limit", query: "limit=lots", code: "invalid_limit"},
		{name: "blank limit", query: "limit=", code: "invalid_limit"},
		{name: "plus limit", query: "limit=+", code: "invalid_limit"},
		{name: "whitespace limit", query: "limit=%201", code: "invalid_limit"},
		{name: "non-canonical limit", query: "limit=01", code: "invalid_limit"},
		{name: "duplicate limit", query: "limit=1&limit=2", code: "invalid_limit"},
		{name: "zero limit", query: "limit=0", code: "invalid_limit"},
		{name: "oversized limit", query: "limit=1001", code: "invalid_limit"},
		{name: "blank offset", query: "offset=", code: "invalid_offset"},
		{name: "plus offset", query: "offset=+", code: "invalid_offset"},
		{name: "whitespace offset", query: "offset=%200", code: "invalid_offset"},
		{name: "non-canonical offset", query: "offset=00", code: "invalid_offset"},
		{name: "duplicate offset", query: "offset=0&offset=1", code: "invalid_offset"},
		{name: "negative offset", query: "offset=-1", code: "invalid_offset"},
		{name: "offset beyond possible import", query: "offset=250001", code: "invalid_offset"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			target := "/api/v1/subscriber-imports/" + id + "/errors?" + test.query
			(&Deps{}).RowErrors(recorder, rowErrorsUnitRequest(target, id))

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s, want 400", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), test.code) {
				t.Fatalf("body=%s, want %s", recorder.Body.String(), test.code)
			}
		})
	}
}

func TestRowErrorsRejectsUnsupportedOrAmbiguousFormatsBeforeDatabaseAccess(t *testing.T) {
	id := uuid.NewString()
	for _, query := range []string{
		"format=garbage",
		"format=CSV",
		"format=%20csv%20",
		"format=json&format=csv",
	} {
		t.Run(query, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			target := "/api/v1/subscriber-imports/" + id + "/errors?" + query
			(&Deps{}).RowErrors(recorder, rowErrorsUnitRequest(target, id))

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s, want 400", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), "invalid_format") {
				t.Fatalf("body=%s, want invalid_format", recorder.Body.String())
			}
		})
	}
}

func TestRowErrorsRouteRequiresAdminAuthorizationBeforeTheHandler(t *testing.T) {
	// A zero-value pool is enough to mount the route. Every case below must be
	// rejected by the admin middleware before the handler can touch it.
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Pool: new(db.Pool)})
	id := uuid.NewString()
	tests := []struct {
		name   string
		user   *middleware.User
		apiKey bool
		scopes []apikeys.Scope
		want   int
	}{
		{name: "missing principal", want: http.StatusUnauthorized},
		{name: "viewer", user: &middleware.User{ID: uuid.NewString(), Role: "viewer"}, want: http.StatusForbidden},
		{name: "editor", user: &middleware.User{ID: uuid.NewString(), Role: "editor"}, want: http.StatusForbidden},
		{
			name:   "read-only API key",
			apiKey: true,
			scopes: []apikeys.Scope{apikeys.ScopeReadSubscribers},
			want:   http.StatusForbidden,
		},
		{
			name: "admin viewing as viewer",
			user: &middleware.User{ID: uuid.NewString(), Role: "admin", EffectiveRole: "viewer"},
			want: http.StatusForbidden,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet,
				"/api/v1/subscriber-imports/"+id+"/errors", nil)
			ctx := apikeys.WithScopes(req.Context(), test.scopes)
			if test.apiKey {
				ctx = middleware.WithAPIKeyAuth(ctx)
			}
			if test.user != nil {
				ctx = middleware.WithUser(ctx, test.user)
			}
			req = req.WithContext(ctx)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			if recorder.Code != test.want {
				t.Fatalf("status=%d body=%s, want %d", recorder.Code, recorder.Body.String(), test.want)
			}
		})
	}
}
