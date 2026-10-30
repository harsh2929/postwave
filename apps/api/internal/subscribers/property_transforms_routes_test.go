// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func serveTransformRuleAPIKey(t *testing.T, method, path, body string, tenant bool, scopes ...apikeys.Scope) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	MountTransformRuleRoutes(router, &Deps{})
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	if tenant {
		ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func TestTransformRuleRoutesEnforceSubscriberScopes(t *testing.T) {
	tests := []struct {
		name         string
		method       string
		path         string
		body         string
		allowedScope apikeys.Scope
	}{
		{"list", http.MethodGet, "/api/v1/profile-transform-rules", "", apikeys.ScopeReadSubscribers},
		{"upsert", http.MethodPost, "/api/v1/profile-transform-rules", `{}`, apikeys.ScopeWriteSubscribers},
		{"delete", http.MethodDelete, "/api/v1/profile-transform-rules/not-a-uuid", "", apikeys.ScopeWriteSubscribers},
	}
	for _, tc := range tests {
		t.Run(tc.name+" rejects unrelated scope", func(t *testing.T) {
			rec := serveTransformRuleAPIKey(t, tc.method, tc.path, tc.body, true, apikeys.ScopeReadReports)
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "insufficient_scope") {
				t.Fatalf("status=%d body=%q, want 403 insufficient_scope", rec.Code, rec.Body.String())
			}
		})
		t.Run(tc.name+" admits required scope", func(t *testing.T) {
			// The no-tenant/invalid-input response proves the scope middleware
			// admitted the request without requiring a database fixture.
			tenant := tc.method != http.MethodGet
			rec := serveTransformRuleAPIKey(t, tc.method, tc.path, tc.body, tenant, tc.allowedScope)
			if rec.Code == http.StatusForbidden {
				t.Fatalf("required scope was rejected: body=%q", rec.Body.String())
			}
		})
	}
}
