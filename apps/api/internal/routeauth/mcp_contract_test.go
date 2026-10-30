// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMCPPoliciesMatchRuntimeAuthBoundaries(t *testing.T) {
	t.Parallel()
	rpc, ok := PolicyFor(http.MethodPost, "/api/v1/mcp/rpc")
	if !ok {
		t.Fatal("missing native RPC policy")
	}
	if len(rpc.AuthMethods) != 1 || rpc.AuthMethods[0] != string(apikeys.AuthMethodAPIKey) ||
		rpc.SessionMinimumRole != RoleNotApplicable || rpc.APIKeyScopeMode != ScopeModeAny ||
		len(rpc.APIKeyScopes) != 1 || rpc.APIKeyScopes[0] != string(apikeys.ScopeMCP) ||
		rpc.ReviewStatus != "reviewed" {
		t.Fatalf("native RPC policy drifted: %+v", rpc)
	}

	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/mcp/executions"},
		{http.MethodGet, "/api/v1/mcp/executions/stream"},
		{http.MethodGet, "/api/v1/mcp/executions.csv"},
		{http.MethodGet, "/api/v1/mcp/catalog"},
		{http.MethodGet, "/api/v1/mcp/quotas"},
		{http.MethodPut, "/api/v1/mcp/quotas"},
		{http.MethodDelete, "/api/v1/mcp/quotas/example_tool"},
		{http.MethodGet, "/api/v1/mcp/stats"},
		{http.MethodGet, "/api/v1/mcp/trend"},
		{http.MethodGet, "/api/v1/mcp/server/settings"},
		{http.MethodPatch, "/api/v1/mcp/server/settings"},
		{http.MethodGet, "/api/v1/mcp/server/catalog"},
		{http.MethodGet, "/api/v1/mcp/server/calls"},
	} {
		policy, ok := PolicyFor(route.method, route.path)
		if !ok {
			t.Fatalf("missing policy for %s %s", route.method, route.path)
		}
		if policy.SessionMinimumRole != "admin" || policy.APIKeyScopeMode != ScopeModeAny ||
			len(policy.APIKeyScopes) != 1 || policy.APIKeyScopes[0] != string(apikeys.ScopeAdmin) ||
			policy.ReviewStatus != "reviewed" {
			t.Fatalf("admin MCP policy drifted for %s %s: %+v", route.method, route.path, policy)
		}
	}
}

func TestMCPRouteauthComposition(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		path   string
		user   *middleware.User
		apiKey bool
		scopes []apikeys.Scope
		want   int
	}{
		{name: "mcp scoped key reaches native rpc", method: http.MethodPost, path: "/api/v1/mcp/rpc", apiKey: true, scopes: []apikeys.Scope{apikeys.ScopeMCP}, want: http.StatusNoContent},
		{name: "admin key without mcp denied native rpc", method: http.MethodPost, path: "/api/v1/mcp/rpc", apiKey: true, scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusNoContent},
		{name: "session admin denied native rpc", method: http.MethodPost, path: "/api/v1/mcp/rpc", user: &middleware.User{Role: "admin"}, want: http.StatusForbidden},
		{name: "admin key reads telemetry", method: http.MethodGet, path: "/api/v1/mcp/executions", apiKey: true, scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusNoContent},
		{name: "mcp key cannot read telemetry", method: http.MethodGet, path: "/api/v1/mcp/executions", apiKey: true, scopes: []apikeys.Scope{apikeys.ScopeMCP}, want: http.StatusForbidden},
		{name: "effective admin reads telemetry", method: http.MethodGet, path: "/api/v1/mcp/executions", user: &middleware.User{Role: "admin"}, want: http.StatusNoContent},
		{name: "admin viewing as custom role denied", method: http.MethodGet, path: "/api/v1/mcp/executions", user: &middleware.User{Role: "admin", EffectiveRole: "custom-analyst"}, want: http.StatusForbidden},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, nil)
			ctx := request.Context()
			if test.apiKey {
				ctx = middleware.WithAPIKeyAuth(ctx)
				ctx = apikeys.WithScopes(ctx, test.scopes)
			}
			if test.user != nil {
				ctx = middleware.WithUser(ctx, test.user)
			}
			response := httptest.NewRecorder()
			Middleware(noContentHandler()).ServeHTTP(response, request.WithContext(ctx))
			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}
