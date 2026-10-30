// SPDX-License-Identifier: AGPL-3.0-only

package predictive

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func predictiveAPIKeyRequest(
	t *testing.T,
	path string,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Repo: &Repo{}})
	req := httptest.NewRequest(http.MethodGet, path, nil)
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func predictiveSessionRequest(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	router := chi.NewRouter()
	MountRoutes(router, &Deps{Repo: &Repo{}})
	req := httptest.NewRequest(http.MethodGet, path, nil)
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID:       "viewer-1",
		TenantID: "tenant-1",
		Role:     "viewer",
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

func TestPredictiveProfileRoutesRequireReportsAndSubscribers(t *testing.T) {
	paths := []string{
		"/api/v1/predictive/profiles",
		"/api/v1/predictive/profiles/buyer@example.test",
		"/api/v1/clv-dashboard",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			for _, scopes := range [][]apikeys.Scope{
				{apikeys.ScopeReadReports},
				{apikeys.ScopeReadSubscribers},
			} {
				rec := predictiveAPIKeyRequest(t, path, scopes...)
				if rec.Code != http.StatusForbidden ||
					!strings.Contains(rec.Body.String(), "insufficient_scope") {
					t.Fatalf("partial scopes %v: status=%d body=%q",
						scopes, rec.Code, rec.Body.String())
				}
			}

			rec := predictiveAPIKeyRequest(
				t,
				path,
				apikeys.ScopeReadReports,
				apikeys.ScopeReadSubscribers,
			)
			if rec.Code != http.StatusUnauthorized ||
				!strings.Contains(rec.Body.String(), "no_tenant") {
				t.Fatalf("both scopes did not reach handler: status=%d body=%q",
					rec.Code, rec.Body.String())
			}

			session := predictiveSessionRequest(t, path)
			if session.Code != http.StatusUnauthorized ||
				!strings.Contains(session.Body.String(), "no_tenant") {
				t.Fatalf("viewer session did not reach handler: status=%d body=%q",
					session.Code, session.Body.String())
			}
		})
	}
}

func TestPredictiveAggregateRoutesRemainReadReportsOnly(t *testing.T) {
	paths := []string{
		"/api/v1/predictive/catalog",
		"/api/v1/predictive/rfm/segments",
		"/api/v1/predictive/data-sufficiency",
	}
	for _, path := range paths {
		rec := predictiveAPIKeyRequest(t, path, apikeys.ScopeReadSubscribers)
		if rec.Code != http.StatusForbidden ||
			!strings.Contains(rec.Body.String(), "insufficient_scope") {
			t.Fatalf("%s unrelated scope: status=%d body=%q", path, rec.Code, rec.Body.String())
		}

		rec = predictiveAPIKeyRequest(t, path, apikeys.ScopeReadReports)
		if rec.Code == http.StatusForbidden {
			t.Fatalf("%s rejected read:reports: body=%q", path, rec.Body.String())
		}
	}
}
