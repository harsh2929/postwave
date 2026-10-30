package suppressions

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestLegacySuppressionAdaptersEnforceSubscriberScopes(t *testing.T) {
	t.Parallel()
	router := chi.NewRouter()
	deps := &Deps{Repo: &Repo{}}
	deps.MountLegacyRoutes(router)
	deps.MountImportExportRoutes(router)

	tests := []struct {
		name         string
		method       string
		path         string
		body         string
		deniedScope  apikeys.Scope
		allowedScope apikeys.Scope
	}{
		{
			name:         "bulk add",
			method:       http.MethodPost,
			path:         "/api/v1/suppressions/bulk",
			body:         `{"emails":["one@example.com"]}`,
			deniedScope:  apikeys.ScopeReadSubscribers,
			allowedScope: apikeys.ScopeWriteSubscribers,
		},
		{
			name:         "CSV import",
			method:       http.MethodPost,
			path:         "/api/v1/suppressions/import",
			deniedScope:  apikeys.ScopeReadSubscribers,
			allowedScope: apikeys.ScopeWriteSubscribers,
		},
		{
			name:         "CSV export",
			method:       http.MethodGet,
			path:         "/api/v1/suppressions/export",
			deniedScope:  apikeys.ScopeWriteSubscribers,
			allowedScope: apikeys.ScopeReadSubscribers,
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			denied := serveSuppressionAdapter(router, test.method, test.path, test.body, test.deniedScope)
			if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "insufficient_scope") {
				t.Fatalf("denied scope status=%d body=%q, want 403 insufficient_scope", denied.Code, denied.Body.String())
			}

			allowed := serveSuppressionAdapter(router, test.method, test.path, test.body, test.allowedScope)
			if allowed.Code != http.StatusUnauthorized {
				t.Fatalf("allowed scope status=%d body=%q, want tenant gate 401", allowed.Code, allowed.Body.String())
			}
		})
	}
}

func serveSuppressionAdapter(
	router http.Handler,
	method string,
	path string,
	body string,
	scopes ...apikeys.Scope,
) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req.WithContext(ctx))
	return recorder
}
