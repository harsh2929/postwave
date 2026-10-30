// SPDX-License-Identifier: AGPL-3.0-only
package routeauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestMiddlewareDefensivelyEnforcesAgentInteractiveReleaseHold(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/ai-agent/chat"},
		{method: http.MethodGet, path: "/api/v1/ai-agent/sessions"},
		{method: http.MethodGet, path: "/api/v1/ai-agent/sessions/session-secret/messages"},
		{method: http.MethodPut, path: "/api/v1/ai-agent/config"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			t.Parallel()
			called := false
			response := httptest.NewRecorder()
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(`{"secret":"password"}`))
			request.Header.Set("Authorization", "Bearer pw_live_secret")
			Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(response, request)

			if called {
				t.Fatal("release-held request reached the next handler")
			}
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", response.Code)
			}
			if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			var frame struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &frame); err != nil {
				t.Fatal(err)
			}
			if frame.Code != "agent_interactive_release_held" {
				t.Fatalf("code = %q", frame.Code)
			}
			for _, secret := range []string{"pw_live_secret", "session-secret", "password"} {
				if strings.Contains(response.Body.String(), secret) {
					t.Fatalf("release-hold frame leaked %q: %s", secret, response.Body.String())
				}
			}
		})
	}
}

func TestMiddlewareSessionRoleMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		role   string
		method string
		path   string
		want   int
	}{
		{name: "anonymous read", method: http.MethodGet, path: "/api/v1/lists", want: http.StatusUnauthorized},
		{name: "viewer read", role: "viewer", method: http.MethodGet, path: "/api/v1/lists", want: http.StatusNoContent},
		{name: "viewer write", role: "viewer", method: http.MethodPost, path: "/api/v1/lists", want: http.StatusForbidden},
		{name: "member legacy read", role: "member", method: http.MethodGet, path: "/api/v1/lists", want: http.StatusNoContent},
		{name: "member legacy write", role: "member", method: http.MethodPost, path: "/api/v1/lists", want: http.StatusForbidden},
		{name: "editor audience write", role: "editor", method: http.MethodPost, path: "/api/v1/lists", want: http.StatusNoContent},
		{name: "editor webhook admin write", role: "editor", method: http.MethodPost, path: "/api/v1/webhooks", want: http.StatusForbidden},
		{name: "admin webhook write", role: "admin", method: http.MethodPost, path: "/api/v1/webhooks", want: http.StatusNoContent},
		{name: "owner webhook write", role: "owner", method: http.MethodPost, path: "/api/v1/webhooks", want: http.StatusNoContent},
		{name: "unknown role denied", role: "superuser", method: http.MethodGet, path: "/api/v1/lists", want: http.StatusForbidden},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(test.method, test.path, nil)
			if test.role != "" {
				request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
					ID:       "user-1",
					TenantID: "tenant-1",
					Role:     test.role,
				}))
			}
			response := httptest.NewRecorder()
			Middleware(noContentHandler()).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestMiddlewareAPIKeyScopeAndAuthMethodMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		path   string
		scopes []apikeys.Scope
		want   int
	}{
		{name: "subscriber read scope reads lists", method: http.MethodGet, path: "/api/v1/lists", scopes: []apikeys.Scope{apikeys.ScopeReadSubscribers}, want: http.StatusNoContent},
		{name: "subscriber write does not imply read", method: http.MethodGet, path: "/api/v1/lists", scopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers}, want: http.StatusForbidden},
		{name: "subscriber write mutates lists", method: http.MethodPost, path: "/api/v1/lists", scopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers}, want: http.StatusNoContent},
		{name: "subscriber read cannot mutate lists", method: http.MethodPost, path: "/api/v1/lists", scopes: []apikeys.Scope{apikeys.ScopeReadSubscribers}, want: http.StatusForbidden},
		{name: "admin wildcard mutates webhook", method: http.MethodPost, path: "/api/v1/webhooks", scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusNoContent},
		{name: "subscriber scope cannot mutate webhook", method: http.MethodPost, path: "/api/v1/webhooks", scopes: []apikeys.Scope{apikeys.ScopeWriteSubscribers}, want: http.StatusForbidden},
		{name: "any verified key can inspect itself", method: http.MethodGet, path: "/api/v1/api-keys/me", want: http.StatusNoContent},
		{name: "API key rejected from mobile device registration", method: http.MethodPost, path: "/api/v1/mobile/push/devices", scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusForbidden},
		{name: "API key rejected from presence event publishing", method: http.MethodPost, path: "/api/v1/events/publish", scopes: []apikeys.Scope{apikeys.ScopeReadReports}, want: http.StatusForbidden},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(test.method, test.path, nil)
			ctx := middleware.WithAPIKeyAuth(request.Context())
			ctx = apikeys.WithScopes(ctx, test.scopes)
			response := httptest.NewRecorder()
			Middleware(noContentHandler()).ServeHTTP(response, request.WithContext(ctx))
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestVanityConversionReportRequiresAdminAPIKey(t *testing.T) {
	t.Parallel()

	const path = "/api/v1/vanity-visits/00000000-0000-4000-8000-000000000001/conversion"
	tests := []struct {
		name string
		ctx  func(context.Context) context.Context
		want int
		code string
	}{
		{
			name: "owner dashboard session is rejected",
			ctx: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{
					ID: "owner-1", TenantID: "tenant-1", Role: "owner",
				})
			},
			want: http.StatusForbidden,
			code: "insufficient_auth_method",
		},
		{
			name: "campaign writer API key is rejected",
			ctx: func(ctx context.Context) context.Context {
				ctx = middleware.WithAPIKeyAuth(ctx)
				return apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeWriteCampaigns})
			},
			want: http.StatusForbidden,
			code: "insufficient_scope",
		},
		{
			name: "admin API key is accepted",
			ctx: func(ctx context.Context) context.Context {
				ctx = middleware.WithAPIKeyAuth(ctx)
				return apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
			},
			want: http.StatusNoContent,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodPost, path, nil)
			response := httptest.NewRecorder()
			Middleware(noContentHandler()).ServeHTTP(
				response, request.WithContext(test.ctx(request.Context())),
			)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.want, response.Body.String())
			}
			if test.code != "" && !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("body = %s, want error code %q", response.Body.String(), test.code)
			}
		})
	}
}

func TestVoiceProfileGovernanceRoutesRequireAdmin(t *testing.T) {
	t.Parallel()
	routes := []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/voice/sources"},
		{method: http.MethodPost, path: "/api/v1/voice/sources/source-1/ingest"},
		{method: http.MethodDelete, path: "/api/v1/voice/sources/source-1"},
		{method: http.MethodPost, path: "/api/v1/voice/profile/build"},
	}
	principals := []struct {
		name   string
		role   string
		scopes []apikeys.Scope
		want   int
	}{
		{name: "editor session", role: "editor", want: http.StatusForbidden},
		{name: "admin session", role: "admin", want: http.StatusNoContent},
		{name: "campaign-writer key", scopes: []apikeys.Scope{apikeys.ScopeWriteCampaigns}, want: http.StatusForbidden},
		{name: "admin key", scopes: []apikeys.Scope{apikeys.ScopeAdmin}, want: http.StatusNoContent},
	}

	for _, route := range routes {
		route := route
		for _, principal := range principals {
			principal := principal
			t.Run(principal.name+" "+route.method+" "+route.path, func(t *testing.T) {
				t.Parallel()
				request := httptest.NewRequest(route.method, route.path, nil)
				if principal.role != "" {
					request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
						ID:       "user-1",
						TenantID: "tenant-1",
						Role:     principal.role,
					}))
				} else {
					ctx := middleware.WithAPIKeyAuth(request.Context())
					request = request.WithContext(apikeys.WithScopes(ctx, principal.scopes))
				}
				response := httptest.NewRecorder()
				Middleware(noContentHandler()).ServeHTTP(response, request)
				if response.Code != principal.want {
					t.Fatalf("status = %d, want %d; body=%s", response.Code, principal.want, response.Body.String())
				}
			})
		}
	}
}

func TestMiddlewareAndHandlerScopeContractsStayAligned(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		method  string
		path    string
		handler func(http.Handler) http.Handler
		scopes  []apikeys.Scope
		want    int
	}{
		{
			name:   "STO report key passes central and handler gates",
			method: http.MethodGet,
			path:   "/api/v1/send-time-opt",
			handler: apikeys.RequireScope(
				apikeys.ScopeReadReports,
				apikeys.ScopeAdmin,
			),
			scopes: []apikeys.Scope{apikeys.ScopeReadReports},
			want:   http.StatusNoContent,
		},
		{
			name:   "STO campaign-read key fails truthful contract",
			method: http.MethodGet,
			path:   "/api/v1/send-time-opt",
			handler: apikeys.RequireScope(
				apikeys.ScopeReadReports,
				apikeys.ScopeAdmin,
			),
			scopes: []apikeys.Scope{apikeys.ScopeReadCampaigns},
			want:   http.StatusForbidden,
		},
		{
			name:    "campaign send rejects write scope alone",
			method:  http.MethodPost,
			path:    "/api/v1/campaigns/campaign-1/send",
			handler: apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional),
			scopes:  []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			want:    http.StatusForbidden,
		},
		{
			name:    "campaign send rejects transactional scope alone",
			method:  http.MethodPost,
			path:    "/api/v1/campaigns/campaign-1/send",
			handler: apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional),
			scopes:  []apikeys.Scope{apikeys.ScopeSendTransactional},
			want:    http.StatusForbidden,
		},
		{
			name:    "campaign send passes both central and handler gates",
			method:  http.MethodPost,
			path:    "/api/v1/campaigns/campaign-1/send",
			handler: apikeys.RequireAllScopes(apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional),
			scopes:  []apikeys.Scope{apikeys.ScopeWriteCampaigns, apikeys.ScopeSendTransactional},
			want:    http.StatusNoContent,
		},
		{
			name:    "sequence participants reject campaign read without subscriber read",
			method:  http.MethodGet,
			path:    "/api/v1/voice/sequences/sequence-1/participants",
			handler: apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers),
			scopes:  []apikeys.Scope{apikeys.ScopeReadCampaigns},
			want:    http.StatusForbidden,
		},
		{
			name:    "sequence participants reject subscriber read without campaign read",
			method:  http.MethodGet,
			path:    "/api/v1/voice/sequences/sequence-1/participants",
			handler: apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers),
			scopes:  []apikeys.Scope{apikeys.ScopeReadSubscribers},
			want:    http.StatusForbidden,
		},
		{
			name:    "sequence participants pass both PII read gates",
			method:  http.MethodGet,
			path:    "/api/v1/voice/sequences/sequence-1/participants",
			handler: apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers),
			scopes:  []apikeys.Scope{apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers},
			want:    http.StatusNoContent,
		},
		{
			name:    "stuck participants reject campaign read without subscriber read",
			method:  http.MethodGet,
			path:    "/api/v1/voice/sequences/sequence-1/stuck",
			handler: apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers),
			scopes:  []apikeys.Scope{apikeys.ScopeReadCampaigns},
			want:    http.StatusForbidden,
		},
		{
			name:    "stuck participants reject subscriber read without campaign read",
			method:  http.MethodGet,
			path:    "/api/v1/voice/sequences/sequence-1/stuck",
			handler: apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers),
			scopes:  []apikeys.Scope{apikeys.ScopeReadSubscribers},
			want:    http.StatusForbidden,
		},
		{
			name:    "stuck participants pass both PII read gates",
			method:  http.MethodGet,
			path:    "/api/v1/voice/sequences/sequence-1/stuck",
			handler: apikeys.RequireAllScopes(apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers),
			scopes:  []apikeys.Scope{apikeys.ScopeReadCampaigns, apikeys.ScopeReadSubscribers},
			want:    http.StatusNoContent,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(test.method, test.path, nil)
			ctx := middleware.WithAPIKeyAuth(request.Context())
			ctx = apikeys.WithScopes(ctx, test.scopes)
			response := httptest.NewRecorder()
			Middleware(test.handler(noContentHandler())).ServeHTTP(response, request.WithContext(ctx))
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

// Authorization binds twice: the mount-site apikeys.RequireScope wrapper in
// internal/server/tenant_governance.go and the central manifest Middleware.
// The effective floor is the stricter of the two, so proving the endpoint is
// reachable means driving a request through BOTH in the order main.go
// composes them. Asserting the manifest row alone would not have caught the
// original defect from the other direction.
func TestMiddlewareBillingReadsReachableThroughBothGates(t *testing.T) {
	t.Parallel()
	// The exact wrapper the billing read cohort is mounted with.
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	billingReads := []string{
		"/api/v1/billing/state",
		"/api/v1/billing/usage",
		"/api/v1/billing/invoices",
		"/api/v1/billing/plan-summary",
	}
	for _, path := range billingReads {
		path := path
		t.Run("viewer session reaches "+path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
				ID: "user-1", TenantID: "tenant-1", Role: "viewer",
			}))
			response := httptest.NewRecorder()
			Middleware(readReports(noContentHandler())).ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, http.StatusNoContent, response.Body.String())
			}
		})
		t.Run("legacy member session reaches "+path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
				ID: "user-1", TenantID: "tenant-1", Role: "member",
			}))
			response := httptest.NewRecorder()
			Middleware(readReports(noContentHandler())).ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, http.StatusNoContent, response.Body.String())
			}
		})
		t.Run("report-scoped key reaches "+path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, path, nil)
			ctx := middleware.WithAPIKeyAuth(request.Context())
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
			response := httptest.NewRecorder()
			Middleware(readReports(noContentHandler())).ServeHTTP(response, request.WithContext(ctx))
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, http.StatusNoContent, response.Body.String())
			}
		})
		t.Run("unrelated read scope is refused at "+path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, path, nil)
			ctx := middleware.WithAPIKeyAuth(request.Context())
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadSubscribers})
			response := httptest.NewRecorder()
			Middleware(readReports(noContentHandler())).ServeHTTP(response, request.WithContext(ctx))
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, http.StatusForbidden, response.Body.String())
			}
		})
		t.Run("anonymous is refused at "+path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, path, nil)
			response := httptest.NewRecorder()
			Middleware(readReports(noContentHandler())).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, http.StatusUnauthorized, response.Body.String())
			}
		})
	}
	// The blast radius of the loosening stops at the reads: a viewer must
	// still not be able to open a checkout session or change the overage
	// preference.
	for _, mutation := range []struct {
		method string
		path   string
	}{
		{method: http.MethodPost, path: "/api/v1/billing/checkout"},
		{method: http.MethodPost, path: "/api/v1/billing/portal"},
		{method: http.MethodPut, path: "/api/v1/billing/overage"},
	} {
		mutation := mutation
		t.Run("viewer refused at "+mutation.path, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(mutation.method, mutation.path, nil)
			request = request.WithContext(middleware.WithUser(request.Context(), &middleware.User{
				ID: "user-1", TenantID: "tenant-1", Role: "viewer",
			}))
			response := httptest.NewRecorder()
			Middleware(admin(noContentHandler())).ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d; body=%s",
					response.Code, http.StatusForbidden, response.Body.String())
			}
		})
	}
}

func TestMiddlewareSessionOnlyAndDefaultDeny(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		path   string
		ctx    func(context.Context) context.Context
		want   int
		code   string
	}{
		{
			name:   "session can register mobile device",
			method: http.MethodPost,
			path:   "/api/v1/mobile/push/devices",
			ctx: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{ID: "u", TenantID: "t", Role: "viewer"})
			},
			want: http.StatusNoContent,
		},
		{
			name:   "session rejected from API key self projection",
			method: http.MethodGet,
			path:   "/api/v1/api-keys/me",
			ctx: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{ID: "u", TenantID: "t", Role: "owner"})
			},
			want: http.StatusForbidden,
			code: "insufficient_auth_method",
		},
		{
			name:   "unclassified route fails closed",
			method: http.MethodPost,
			path:   "/api/v1/not-a-real-route",
			ctx: func(ctx context.Context) context.Context {
				return middleware.WithUser(ctx, &middleware.User{ID: "u", TenantID: "t", Role: "owner"})
			},
			want: http.StatusForbidden,
			code: "route_authorization_unclassified",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(test.method, test.path, nil)
			request = request.WithContext(test.ctx(request.Context()))
			response := httptest.NewRecorder()
			Middleware(noContentHandler()).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.want, response.Body.String())
			}
			if test.code != "" && !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("body = %s, want error code %q", response.Body.String(), test.code)
			}
		})
	}
}

func noContentHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
}
