// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestScopeMCPRegisteredInCatalog ensures the dashboard's scope picker
// (and IsValidScope) recognise the new MCP scope. A missing entry
// here would cause the API-keys CRUD to reject mcp-scoped keys with
// "unknown scope mcp".
func TestScopeMCPRegisteredInCatalog(t *testing.T) {
	if !IsValidScope(string(ScopeMCP)) {
		t.Fatalf("ScopeMCP %q not registered in AllScopes catalog", ScopeMCP)
	}
}

// TestSessionRoleAllowsScopes covers the D04#2 editor-tier fix: an
// editor session may exercise the content-write scopes but not
// admin-tier ones; viewers get neither; owner/admin get everything.
func TestSessionRoleAllowsScopes(t *testing.T) {
	cases := []struct {
		role   string
		scopes []Scope
		want   bool
	}{
		{"editor", []Scope{ScopeWriteSubscribers}, true},
		{"editor", []Scope{ScopeWriteCampaigns}, true},
		{"editor", []Scope{ScopeReadSubscribers}, true},
		{"editor", []Scope{ScopeWriteSubscribers, ScopeReadSubscribers}, true},
		{"editor", []Scope{ScopeSendTransactional}, false},
		{"editor", []Scope{ScopeAdmin}, false},
		{"editor", []Scope{ScopeAuditConfigureSinks}, false},
		{"editor", []Scope{ScopeWriteSubscribers, ScopeAdmin}, false},
		{"viewer", []Scope{ScopeWriteSubscribers}, false},
		{"viewer", []Scope{ScopeReadSubscribers}, true},
		{"admin", []Scope{ScopeSendTransactional}, true},
		{"owner", []Scope{ScopeAdmin}, true},
		{"", []Scope{ScopeWriteSubscribers}, false},
	}
	for _, c := range cases {
		if got := sessionRoleAllowsScopes(c.role, c.scopes); got != c.want {
			t.Errorf("sessionRoleAllowsScopes(%q, %v) = %v, want %v",
				c.role, c.scopes, got, c.want)
		}
	}
}

func TestRequireScopeHonorsViewerMode(t *testing.T) {
	called := false
	h := RequireScope(ScopeAdmin)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/admin", nil)
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID: "u-1", Role: "admin", EffectiveRole: "viewer",
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req.WithContext(ctx))
	if rec.Code != http.StatusForbidden || called {
		t.Fatalf("viewer-mode admin must be denied, status=%d called=%v", rec.Code, called)
	}
}

// Flow and campaign authoring share ScopeWriteCampaigns. Exercise the actual
// session middleware—not only its role helper—so web controls can mirror the
// authoritative owner/admin/editor policy and viewer-mode downgrade exactly.
func TestRequireScopeWriteCampaignsSessionRoles(t *testing.T) {
	tests := []struct {
		name          string
		role          string
		effectiveRole string
		want          int
	}{
		{name: "owner", role: "owner", want: http.StatusNoContent},
		{name: "admin", role: "admin", want: http.StatusNoContent},
		{name: "editor", role: "editor", want: http.StatusNoContent},
		{name: "viewer", role: "viewer", want: http.StatusForbidden},
		{name: "owner viewing as viewer", role: "owner", effectiveRole: "viewer", want: http.StatusForbidden},
		{name: "admin viewing as viewer", role: "admin", effectiveRole: "viewer", want: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := false
			handler := RequireScope(ScopeWriteCampaigns)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodPost, "/api/v1/flow-builder/flows", nil)
			request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
				ID: "user-1", Role: test.role, EffectiveRole: test.effectiveRole,
			}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != test.want || called != (test.want == http.StatusNoContent) {
				t.Fatalf("status=%d called=%v, want status=%d", response.Code, called, test.want)
			}
		})
	}
}

func TestRequireExactTenantAdminDoesNotAcceptCustomGrantsOrViewAs(t *testing.T) {
	tests := []struct {
		name   string
		user   *middleware.User
		apiKey bool
		scopes []Scope
		want   int
	}{
		{name: "admin key", apiKey: true, scopes: []Scope{ScopeAdmin}, want: http.StatusNoContent},
		{name: "mcp key", apiKey: true, scopes: []Scope{ScopeMCP}, want: http.StatusForbidden},
		{name: "owner session", user: &middleware.User{Role: "owner"}, want: http.StatusNoContent},
		{name: "admin session", user: &middleware.User{Role: "admin"}, want: http.StatusNoContent},
		{name: "custom role with additive admin grant", user: &middleware.User{Role: "custom-analyst"}, scopes: []Scope{ScopeAdmin}, want: http.StatusForbidden},
		{name: "durable admin viewing as viewer", user: &middleware.User{Role: "admin", EffectiveRole: "viewer"}, want: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := false
			handler := RequireExactTenantAdmin(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/api/v1/mcp/executions", nil)
			ctx := WithScopes(request.Context(), test.scopes)
			if test.apiKey {
				ctx = middleware.WithAPIKeyAuth(ctx)
			}
			if test.user != nil {
				ctx = middleware.WithUser(ctx, test.user)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request.WithContext(ctx))
			if response.Code != test.want || called != (test.want == http.StatusNoContent) {
				t.Fatalf("status=%d called=%v want status=%d", response.Code, called, test.want)
			}
		})
	}
}

// TestRequireAuthMethodAcceptsAPIKey is the happy path: an API-key
// authenticated request slips through RequireAuthMethod(AuthMethodAPIKey)
// and reaches the inner handler.
func TestRequireAuthMethodAcceptsAPIKey(t *testing.T) {
	called := false
	handler := RequireAuthMethod(AuthMethodAPIKey)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp/rpc", nil)
	req = req.WithContext(middleware.WithAPIKeyAuth(req.Context()))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent || !called {
		t.Fatalf("api-key request should pass, status=%d called=%v body=%s", rec.Code, called, rec.Body.String())
	}
}

// TestRequireAuthMethodRejectsSessionCookie is the regression test
// for p0-mcp-rbac: a session-cookie-authenticated request (i.e. a
// browser dashboard user) MUST NOT be able to drive the MCP RPC
// endpoint even if their role would otherwise satisfy RequireScope.
// Returns 403 insufficient_auth_method.
func TestRequireAuthMethodRejectsSessionCookie(t *testing.T) {
	handler := RequireAuthMethod(AuthMethodAPIKey)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp/rpc", nil)
	// Session-cookie context: a *User attached, no API-key flag.
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID:       "u-1",
		TenantID: "t-1",
		Email:    "owner@example.com",
		Role:     "owner",
	})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("session-cookie request should be 403, got %d body=%s",
			rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "insufficient_auth_method") {
		t.Fatalf("body should mention insufficient_auth_method, got %s", rec.Body.String())
	}
}

// TestRequireAuthMethodRejectsUnauthenticated covers the third path:
// no auth at all (no API key, no session) — still 403.
func TestRequireAuthMethodRejectsUnauthenticated(t *testing.T) {
	handler := RequireAuthMethod(AuthMethodAPIKey)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp/rpc", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("unauthenticated request should be 403, got %d body=%s",
			rec.Code, rec.Body.String())
	}
}

// TestMCPRPCRouterRejectsSessionOnly is the end-to-end regression
// test for the route wiring in main.go: a chi router that mirrors
// the production gate ordering must reject session-cookie callers
// with 403, NOT pass them through to the RPC handler.
//
// This catches the original p0-mcp-rbac bug: r.Post(...) with no
// gates meant any session-cookie caller (e.g. a member-role user)
// could POST to /api/v1/mcp/rpc and drive every MCP tool subject
// only to the per-tool scope checks inside the JSON-RPC frame.
func TestMCPRPCRouterRejectsSessionOnly(t *testing.T) {
	innerCalled := false
	r := chi.NewRouter()
	r.With(RequireAuthMethod(AuthMethodAPIKey)).
		With(RequireScope(ScopeMCP)).
		Post("/api/v1/mcp/rpc", func(w http.ResponseWriter, _ *http.Request) {
			innerCalled = true
			w.WriteHeader(http.StatusOK)
		})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp/rpc", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithUser(req.Context(), &middleware.User{
		ID:       "u-1",
		TenantID: "t-1",
		Email:    "owner@example.com",
		Role:     "owner",
	})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("session-only request to /mcp/rpc should be 403, got %d body=%s",
			rec.Code, rec.Body.String())
	}
	if innerCalled {
		t.Fatal("inner RPC handler must NOT run for session-cookie callers")
	}
	if !strings.Contains(rec.Body.String(), "insufficient_auth_method") {
		t.Fatalf("body should mention insufficient_auth_method, got %s", rec.Body.String())
	}
}

// TestMCPRPCRouterRejectsAPIKeyMissingScope confirms the second
// gate fires: an API-key caller without ScopeMCP must be rejected
// with insufficient_scope.
func TestMCPRPCRouterRejectsAPIKeyMissingScope(t *testing.T) {
	r := chi.NewRouter()
	r.With(RequireAuthMethod(AuthMethodAPIKey)).
		With(RequireScope(ScopeMCP)).
		Post("/api/v1/mcp/rpc", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp/rpc", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeReadSubscribers}) // no ScopeMCP, no ScopeAdmin
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("api-key without ScopeMCP should be 403, got %d body=%s",
			rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "insufficient_scope") {
		t.Fatalf("body should mention insufficient_scope, got %s", rec.Body.String())
	}
}

// TestMCPRPCRouterAdminAPIKeyPasses confirms ScopeAdmin still grants
// access (wildcard semantics — see HasScope). Without this, every
// existing admin-scoped API key would lose MCP access at the deploy
// of this change.
func TestMCPRPCRouterAdminAPIKeyPasses(t *testing.T) {
	innerCalled := false
	r := chi.NewRouter()
	r.With(RequireAuthMethod(AuthMethodAPIKey)).
		With(RequireScope(ScopeMCP)).
		Post("/api/v1/mcp/rpc", func(w http.ResponseWriter, _ *http.Request) {
			innerCalled = true
			w.WriteHeader(http.StatusOK)
		})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp/rpc", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = WithScopes(ctx, []Scope{ScopeAdmin})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req.WithContext(ctx))

	if rec.Code != http.StatusOK || !innerCalled {
		t.Fatalf("admin api-key should pass, status=%d called=%v body=%s",
			rec.Code, innerCalled, rec.Body.String())
	}
}

// TestAuthMethodFromContextSession exercises the helper directly to
// guard against future regressions in the session-vs-api-key
// discrimination logic.
func TestAuthMethodFromContextSession(t *testing.T) {
	ctx := middleware.WithUser(httptest.NewRequest(http.MethodGet, "/", nil).Context(),
		&middleware.User{ID: "u", Role: "admin"})
	if got := AuthMethodFromContext(ctx); got != AuthMethodSession {
		t.Fatalf("AuthMethodFromContext(session) = %q, want %q", got, AuthMethodSession)
	}
}

func TestAuthMethodFromContextAPIKey(t *testing.T) {
	ctx := middleware.WithAPIKeyAuth(httptest.NewRequest(http.MethodGet, "/", nil).Context())
	if got := AuthMethodFromContext(ctx); got != AuthMethodAPIKey {
		t.Fatalf("AuthMethodFromContext(apikey) = %q, want %q", got, AuthMethodAPIKey)
	}
}

func TestAuthMethodFromContextEmpty(t *testing.T) {
	ctx := httptest.NewRequest(http.MethodGet, "/", nil).Context()
	if got := AuthMethodFromContext(ctx); got != "" {
		t.Fatalf("AuthMethodFromContext(none) = %q, want empty", got)
	}
}
