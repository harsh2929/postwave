// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/admin"
	"github.com/postwave/postwave/apps/api/internal/admin_ip"
	"github.com/postwave/postwave/apps/api/internal/apidocs"
	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/auth"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/scim"
	"github.com/postwave/postwave/apps/api/internal/scoring"
)

func TestMountIdentityAPISurfaceMatchesEveryLegacyRouteAndMiddleware(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newIdentityAPIDeps(actualRouter)
	MountIdentityAPISurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newIdentityAPIDeps(referenceRouter)
	mountLegacyIdentityAPISurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	// 108 includes the two Google workspace-signup routes. Bump
	// deliberately: this count is the tripwire that catches a route added to
	// one mount path and not the other.
	if len(actual) != 108 {
		t.Fatalf("identity/API route count = %d, want 108", len(actual))
	}

	scopeSets := []struct {
		name   string
		scopes []apikeys.Scope
	}{
		{name: "none"},
		{name: "admin", scopes: []apikeys.Scope{apikeys.ScopeAdmin}},
		{name: "audit read", scopes: []apikeys.Scope{apikeys.ScopeAuditRead}},
		{name: "configure sinks", scopes: []apikeys.Scope{apikeys.ScopeAuditConfigureSinks}},
		{name: "execute audit actions", scopes: []apikeys.Scope{apikeys.ScopeAuditExecuteActions}},
		{name: "all audit scopes", scopes: []apikeys.Scope{
			apikeys.ScopeAuditRead,
			apikeys.ScopeAuditConfigureSinks,
			apikeys.ScopeAuditExecuteActions,
		}},
	}

	for index := range reference {
		want := reference[index]
		got := actual[index]
		if got.method != want.method || got.path != want.path {
			t.Fatalf("route[%d] = %s %s, want %s %s", index, got.method, got.path, want.method, want.path)
		}
		if len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("%s %s middleware count = %d, want %d", got.method, got.path, len(got.middlewares), len(want.middlewares))
		}

		// SCIM's bearer middleware resolves a tenant against PostgreSQL before
		// dispatch. Its exact protected/discovery placement is asserted by count;
		// executing it against a deliberately inert test pool would test pgx, not
		// composition. Every regular API scope and auth limiter is probed below.
		if strings.HasPrefix(got.path, "/scim/v2/") && len(got.middlewares) != 0 {
			continue
		}
		for _, scopeSet := range scopeSets {
			gotResponse := serveRouteMiddleware(got, scopeSet.scopes)
			wantResponse := serveRouteMiddleware(want, scopeSet.scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf(
					"%s %s with %s scopes = (%d, %q), want (%d, %q)",
					got.method,
					got.path,
					scopeSet.name,
					gotResponse.Code,
					gotResponse.Body.String(),
					wantResponse.Code,
					wantResponse.Body.String(),
				)
			}
		}
	}
}

func TestMountIdentityAPISurfacePinsBruteforceAndSCIMBearerBoundaries(t *testing.T) {
	router := chi.NewRouter()
	MountIdentityAPISurface(newIdentityAPIDeps(router))
	routes := subscriberListSegmentRoutes(t, router)

	limited := map[string]bool{
		"GET /api/v1/auth/oauth/{provider}/signup":  true,
		"POST /api/v1/auth/oauth/{provider}/signup": true,
		"POST /api/v1/auth/signup":                  true,
		"POST /api/v1/auth/accept-invite":           true,
		"GET /api/v1/auth/slug-available":           true,
		"POST /api/v1/auth/login":                   true,
		"POST /api/v1/auth/verify-email":            true,
		"POST /api/v1/auth/magic-link/start":        true,
		"POST /api/v1/auth/magic-link/consume":      true,
		"POST /api/v1/auth/password-reset/start":    true,
		"POST /api/v1/auth/password-reset/confirm":  true,
		"POST /api/v1/auth/cli/device/start":        true,
		"POST /api/v1/auth/totp/verify":             true,
		"POST /api/v1/auth/totp/challenge":          true,
		"POST /api/v1/auth/webauthn/login/begin":    true,
		"POST /api/v1/auth/webauthn/login/finish":   true,
		"POST /api/v1/auth/cli/device/approve":      true,
	}
	seenLimited := make(map[string]bool, len(limited))
	for _, route := range routes {
		if strings.HasPrefix(route.path, "/scim/v2/") {
			wantBearer := route.path != "/scim/v2/ServiceProviderConfig" &&
				route.path != "/scim/v2/ResourceTypes" &&
				route.path != "/scim/v2/Schemas"
			if gotBearer := len(route.middlewares) == 1; gotBearer != wantBearer {
				t.Errorf("%s %s bearer middleware = %v, want %v", route.method, route.path, gotBearer, wantBearer)
			}
			continue
		}

		response := serveIdentityMiddleware(route, []apikeys.Scope{apikeys.ScopeAdmin})
		key := route.method + " " + route.path
		gotLimited := response.Header().Get("X-Test-Auth-Bruteforce") == "applied"
		if gotLimited != limited[key] {
			t.Errorf("%s brute-force middleware = %v, want %v", key, gotLimited, limited[key])
		}
		if gotLimited {
			seenLimited[key] = true
		}
	}
	if len(seenLimited) != len(limited) {
		t.Fatalf("observed %d brute-force routes, want %d", len(seenLimited), len(limited))
	}
}

func TestMountIdentityAPISurfacePreservesRegistrationOrderAndIdentity(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("identity_api.go")
	if err != nil {
		t.Fatalf("read identity_api.go: %v", err)
	}
	source := string(sourceBytes)
	ordered := []string{
		"Post(\"/api/v1/auth/signup\"",
		"Post(\"/api/v1/auth/login\"",
		"Post(\"/api/v1/auth/logout\"",
		"Post(\"/api/v1/auth/verify-email\"",
		"Post(\"/api/v1/auth/magic-link/start\"",
		"Post(\"/api/v1/auth/magic-link/consume\"",
		"Post(\"/api/v1/auth/password-reset/start\"",
		"Post(\"/api/v1/auth/password-reset/confirm\"",
		"deps.Auth.MountCLITokenRoute(deps.Router)",
		"deps.Auth.MountCLIDeviceStartRoute(deps.Router.With(limited))",
		"deps.Auth.MountCLIDeviceTokenRoute(deps.Router)",
		"Get(\"/api/v1/auth/oauth/{provider}/start\"",
		"Get(\"/api/v1/auth/oauth/{provider}/callback\"",
		"Get(\"/api/v1/auth/me\"",
		"deps.Auth.MountViewerModeRoutes(deps.Router)",
		"Get(\"/api/v1/auth/workspaces\"",
		"Post(\"/api/v1/auth/workspaces/switch\"",
		"Post(\"/api/v1/auth/send-verification\"",
		"Post(\"/api/v1/auth/totp/enroll\"",
		"Post(\"/api/v1/auth/totp/verify\"",
		"Post(\"/api/v1/auth/totp/challenge\"",
		"Delete(\"/api/v1/auth/totp\"",
		"deps.Auth.MountRecoveryCodeRoutes(deps.Router)",
		"deps.Auth.MountSessionRoutes(deps.Router)",
		"deps.Auth.MountTrustedDeviceRoutes(deps.Router)",
		"deps.Auth.MountCLIAuthorizeRoute(deps.Router)",
		"deps.Auth.MountCLIDeviceApproveRoute(deps.Router.With(limited))",
		"admin_ip.MountRoutes(deps.Router,",
		"Get(\"/api/v1/api-keys\"",
		"Get(\"/api/v1/api-keys/{id}\"",
		"Post(\"/api/v1/api-keys\"",
		"Post(\"/api/v1/api-keys/{id}/rotate\"",
		"Patch(\"/api/v1/api-keys/{id}\"",
		"Delete(\"/api/v1/api-keys/{id}\"",
		"Get(\"/api/v1/mcp/executions\"",
		"Get(\"/api/v1/mcp/executions/stream\"",
		"Get(\"/api/v1/mcp/executions.csv\"",
		"Get(\"/api/v1/mcp/stats\"",
		"Get(\"/api/v1/mcp/trend\"",
		"Get(\"/api/v1/mcp/catalog\"",
		"Get(\"/api/v1/mcp/quotas\"",
		"Put(\"/api/v1/mcp/quotas\"",
		"Delete(\"/api/v1/mcp/quotas/{tool}\"",
		"Get(\"/api/v1/openapi.json\"",
		"scoring.MountRoutes(deps.Router,",
		"deps.AuditSinkAdmin.MountAdminRoutes(deps.Router)",
		"deps.AuditSinkAdmin.MountDLQRoutes(deps.Router)",
		"deps.AuditSinkAdmin.MountTestRoutes(deps.Router)",
		"deps.AuditSinkAdmin.MountSigningKeyRoutes(deps.Router)",
		"deps.SCIMAdmin.MountAdminRoutes(deps.Router)",
		"scim.MountRoutes(deps.Router, deps.SCIMPublic)",
		"deps.AdminKMS.MountRoutes(deps.Router)",
		"deps.SpamCorpusAdmin.MountRoutes(deps.Router)",
	}
	// 53 = the prior 52 plus deps.Auth.MountTrustedDeviceRoutes (AUTH#48).
	// The count is here so a marker cannot be dropped from the list to make
	// an ordering failure disappear.
	if len(ordered) != 53 {
		t.Fatalf("registration contract contains %d entries, want 53", len(ordered))
	}
	assertServerMarkersInOrder(t, source, ordered)

	for _, marker := range []string{
		"deps.Auth.Signup",
		"deps.OAuth.Start",
		"deps.APIKeys.List",
		"deps.APIKeyCalls.StreamExecutions",
		"deps.APIDocs.GetSpec",
		"deps.AuditSinkAdmin.MountAdminRoutes(deps.Router)",
		"deps.SCIMAdmin.MountAdminRoutes(deps.Router)",
		"scim.MountRoutes(deps.Router, deps.SCIMPublic)",
		"deps.AdminKMS.MountRoutes(deps.Router)",
		"deps.SpamCorpusAdmin.MountRoutes(deps.Router)",
		"admin_ip.Deps{Pool: deps.Pool}",
		"scoring.Deps{Pool: deps.Pool}",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("dependency identity contract missing %q", marker)
		}
	}
}

func TestIdentityAPIMountsUsePassedSecurityRouters(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		deps := newIdentityAPIDeps(authenticated)
		MountAuthenticatedAuthMeRoute(deps)
		MountAPIKeyRoutes(deps)
		MountAuditSinkRoutes(deps)
		MountSCIMAdminRoutes(deps)
	})

	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", http.NoBody),
		httptest.NewRequest(http.MethodGet, "/api/v1/api-keys", http.NoBody),
		httptest.NewRequest(http.MethodGet, "/api/v1/audit-sinks", http.NoBody),
		httptest.NewRequest(http.MethodGet, "/api/v1/scim/tokens", http.NoBody),
	} {
		request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
		response := httptest.NewRecorder()
		root.ServeHTTP(response, request)
		if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
			t.Errorf("%s escaped the passed authenticated router", request.URL.Path)
		}
	}
}

func TestMCPControlPlaneMountRequiresExactEffectiveTenantAdmin(t *testing.T) {
	tests := []struct {
		name       string
		user       *middleware.User
		apiKeyAuth bool
		scopes     []apikeys.Scope
		want       int
	}{
		{
			name:       "admin scoped api key",
			apiKeyAuth: true,
			scopes:     []apikeys.Scope{apikeys.ScopeAdmin},
			want:       http.StatusOK,
		},
		{
			name:       "mcp scoped api key",
			apiKeyAuth: true,
			scopes:     []apikeys.Scope{apikeys.ScopeMCP},
			want:       http.StatusForbidden,
		},
		{
			name: "durable admin session",
			user: &middleware.User{ID: "user-admin", Role: "admin"},
			want: http.StatusOK,
		},
		{
			name:   "custom role cannot inherit stored-style admin scope",
			user:   &middleware.User{ID: "user-custom", Role: "custom-analyst"},
			scopes: []apikeys.Scope{apikeys.ScopeAdmin},
			want:   http.StatusForbidden,
		},
		{
			name: "durable admin viewing as custom role",
			user: &middleware.User{ID: "user-view-as", Role: "admin", EffectiveRole: "custom-analyst"},
			want: http.StatusForbidden,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := chi.NewRouter()
			MountAPIKeyCallRoutes(Deps{
				Router:      router,
				APIKeyCalls: &apikeycalls.Deps{},
			})

			request := httptest.NewRequest(http.MethodGet, "/api/v1/mcp/catalog", http.NoBody)
			ctx := apikeys.WithScopes(request.Context(), test.scopes)
			if test.apiKeyAuth {
				ctx = middleware.WithAPIKeyAuth(ctx)
			}
			if test.user != nil {
				ctx = middleware.WithUser(ctx, test.user)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request.WithContext(ctx))

			if response.Code != test.want {
				t.Fatalf("status=%d want=%d body=%s", response.Code, test.want, response.Body.String())
			}
			if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
				t.Fatalf("MCP response missing no-store: %q", got)
			}
		})
	}
}

func TestIdentityAPIMountsRejectMissingStructuralDependencies(t *testing.T) {
	valid := newIdentityAPIDeps(chi.NewRouter())
	tests := []struct {
		name  string
		deps  Deps
		mount func(Deps)
	}{
		{name: "public auth missing auth", deps: Deps{Router: chi.NewRouter(), AuthBruteforceMiddleware: identityTestBruteforce}, mount: MountPublicAuthRoutes},
		{name: "public auth missing limiter", deps: Deps{Router: chi.NewRouter(), Auth: valid.Auth}, mount: MountPublicAuthRoutes},
		{name: "oauth missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountOAuthRoutes},
		{name: "auth me missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountAuthenticatedAuthMeRoute},
		{name: "authenticated auth missing auth", deps: Deps{Router: chi.NewRouter(), AuthBruteforceMiddleware: identityTestBruteforce}, mount: MountAuthenticatedAuthRoutes},
		{name: "authenticated auth missing limiter", deps: Deps{Router: chi.NewRouter(), Auth: valid.Auth}, mount: MountAuthenticatedAuthRoutes},
		{name: "admin ip missing pool", deps: Deps{Router: chi.NewRouter()}, mount: MountAdminIPRoutes},
		{name: "api keys missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountAPIKeyRoutes},
		{name: "api calls missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountAPIKeyCallRoutes},
		{name: "api docs missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountAPIDocRoutes},
		{name: "scoring missing pool", deps: Deps{Router: chi.NewRouter()}, mount: MountScoringRoutes},
		{name: "audit sink missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountAuditSinkRoutes},
		{name: "scim admin missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSCIMAdminRoutes},
		{name: "scim public missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSCIMPublicRoutes},
		{name: "admin kms missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountAdminKMSRoutes},
		{name: "spam corpus missing deps", deps: Deps{Router: chi.NewRouter()}, mount: MountSpamCorpusAdminRoutes},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.mount(test.deps)
			if routeCount(t, test.deps.Router) != 0 {
				t.Fatal("invalid dependencies registered partial routes")
			}
		})
	}

	routerless := valid
	routerless.Router = nil
	for _, helper := range []struct {
		name  string
		mount func(Deps)
	}{
		{name: "public auth", mount: MountPublicAuthRoutes},
		{name: "oauth", mount: MountOAuthRoutes},
		{name: "auth me", mount: MountAuthenticatedAuthMeRoute},
		{name: "authenticated auth", mount: MountAuthenticatedAuthRoutes},
		{name: "admin ip", mount: MountAdminIPRoutes},
		{name: "api keys", mount: MountAPIKeyRoutes},
		{name: "api calls", mount: MountAPIKeyCallRoutes},
		{name: "api docs", mount: MountAPIDocRoutes},
		{name: "scoring", mount: MountScoringRoutes},
		{name: "audit sink", mount: MountAuditSinkRoutes},
		{name: "scim admin", mount: MountSCIMAdminRoutes},
		{name: "scim public", mount: MountSCIMPublicRoutes},
		{name: "admin kms", mount: MountAdminKMSRoutes},
		{name: "spam corpus", mount: MountSpamCorpusAdminRoutes},
	} {
		t.Run(helper.name+" missing router", func(t *testing.T) {
			helper.mount(routerless)
		})
	}
}

func TestMountIdentityAPISurfaceRejectsEveryIncompleteDependencyBag(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "router", mutate: func(deps *Deps) { deps.Router = nil }},
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "auth", mutate: func(deps *Deps) { deps.Auth = nil }},
		{name: "limiter", mutate: func(deps *Deps) { deps.AuthBruteforceMiddleware = nil }},
		{name: "api keys", mutate: func(deps *Deps) { deps.APIKeys = nil }},
		{name: "api calls", mutate: func(deps *Deps) { deps.APIKeyCalls = nil }},
		{name: "api docs", mutate: func(deps *Deps) { deps.APIDocs = nil }},
		{name: "scim admin", mutate: func(deps *Deps) { deps.SCIMAdmin = nil }},
		{name: "scim public", mutate: func(deps *Deps) { deps.SCIMPublic = nil }},
		{name: "audit sink", mutate: func(deps *Deps) { deps.AuditSinkAdmin = nil }},
		{name: "admin kms", mutate: func(deps *Deps) { deps.AdminKMS = nil }},
		{name: "spam corpus", mutate: func(deps *Deps) { deps.SpamCorpusAdmin = nil }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			deps := newIdentityAPIDeps(chi.NewRouter())
			test.mutate(&deps)
			MountIdentityAPISurface(deps)
			if deps.Router != nil && routeCount(t, deps.Router) != 0 {
				t.Fatal("incomplete dependency bag registered a partial surface")
			}
		})
	}
}

func TestMountIdentityAPISurfaceSupportsOAuthDisabled(t *testing.T) {
	deps := newIdentityAPIDeps(chi.NewRouter())
	deps.OAuth = nil
	MountIdentityAPISurface(deps)
	// 92 = the prior 91 (AUTH#6 workspace-switch) plus SETC-010 accept-invite;
	// +7 for AUTH-023 WebAuthn passkey routes; +3 for AUTH#48 trusted devices.
	if got := routeCount(t, deps.Router); got != 104 {
		t.Fatalf("password-only identity/API route count = %d, want 104", got)
	}
}

func TestNewIncludesCompleteIdentityAPISurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newIdentityAPIDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newIdentityAPIDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	mountLegacyIdentityAPISurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("server.New route count = %d, want %d", len(actual), len(reference))
	}
	for index := range reference {
		if actual[index].method != reference[index].method || actual[index].path != reference[index].path {
			t.Fatalf(
				"server.New route[%d] = %s %s, want %s %s",
				index,
				actual[index].method,
				actual[index].path,
				reference[index].method,
				reference[index].path,
			)
		}
	}
}

func newIdentityAPIDeps(router chi.Router) Deps {
	pool := new(db.Pool)
	authDeps := &auth.Deps{Repo: &auth.Repo{Pool: pool}}
	return Deps{
		Router:                   router,
		Pool:                     pool,
		Auth:                     authDeps,
		OAuth:                    &auth.OAuthDeps{Deps: authDeps},
		AuthBruteforceMiddleware: identityTestBruteforce,
		APIKeys:                  &apikeys.Deps{Repo: &apikeys.Repo{Pool: pool}},
		APIKeyCalls:              &apikeycalls.Deps{Repo: &apikeycalls.Repo{Pool: pool}},
		APIDocs:                  &apidocs.Deps{},
		SCIMAdmin:                &scim.Deps{Pool: pool},
		SCIMPublic:               &scim.Deps{Pool: pool},
		AuditSinkAdmin:           &auditsink.AdminDeps{Pool: pool},
		AdminKMS:                 &admin.Deps{Pool: pool},
		SpamCorpusAdmin:          &admin.SpamCorpusDeps{},
	}
}

func mountLegacyIdentityAPISurface(deps Deps) {
	limited := deps.AuthBruteforceMiddleware
	deps.Router.With(limited).Post("/api/v1/auth/signup", deps.Auth.Signup)
	deps.Router.With(limited).Post("/api/v1/auth/accept-invite", deps.Auth.AcceptInvite)
	deps.Router.With(limited).Get("/api/v1/auth/slug-available", deps.Auth.SlugAvailable)
	deps.Router.With(limited).Post("/api/v1/auth/login", deps.Auth.Login)
	deps.Router.Post("/api/v1/auth/logout", deps.Auth.Logout)
	deps.Router.With(limited).Post("/api/v1/auth/verify-email", deps.Auth.VerifyEmail)
	deps.Router.With(limited).Post("/api/v1/auth/magic-link/start", deps.Auth.MagicLinkStart)
	deps.Router.With(limited).Post("/api/v1/auth/magic-link/consume", deps.Auth.MagicLinkConsume)
	deps.Router.With(limited).Post("/api/v1/auth/password-reset/start", deps.Auth.PasswordResetStart)
	deps.Router.With(limited).Post("/api/v1/auth/password-reset/confirm", deps.Auth.PasswordResetConfirm)
	deps.Auth.MountCLITokenRoute(deps.Router)
	deps.Auth.MountCLIDeviceStartRoute(deps.Router.With(limited))
	deps.Auth.MountCLIDeviceTokenRoute(deps.Router)
	deps.Router.Get("/api/v1/auth/oauth/{provider}/start", deps.OAuth.Start)
	deps.Router.Get("/api/v1/auth/oauth/{provider}/callback", deps.OAuth.Callback)
	deps.Router.With(limited).Get("/api/v1/auth/oauth/{provider}/signup", deps.OAuth.SignupInfo)
	deps.Router.With(limited).Post("/api/v1/auth/oauth/{provider}/signup", deps.OAuth.CompleteSignup)
	deps.Router.Get("/api/v1/auth/me", deps.Auth.Me)
	deps.Auth.MountViewerModeRoutes(deps.Router)
	deps.Router.Get("/api/v1/auth/workspaces", deps.Auth.Workspaces)
	deps.Router.Post("/api/v1/auth/workspaces/switch", deps.Auth.SwitchWorkspace)
	deps.Router.Post("/api/v1/auth/send-verification", deps.Auth.SendVerification)
	deps.Router.Post("/api/v1/auth/totp/enroll", deps.Auth.TOTPEnroll)
	deps.Router.With(limited).Post("/api/v1/auth/totp/verify", deps.Auth.TOTPVerify)
	deps.Router.With(limited).Post("/api/v1/auth/totp/challenge", deps.Auth.TOTPChallenge)
	deps.Router.Delete("/api/v1/auth/totp", deps.Auth.TOTPDisable)
	deps.Router.With(limited).Post("/api/v1/auth/webauthn/login/begin", deps.Auth.WebauthnLoginBegin)
	deps.Router.With(limited).Post("/api/v1/auth/webauthn/login/finish", deps.Auth.WebauthnLoginFinish)
	deps.Router.Post("/api/v1/auth/webauthn/register/begin", deps.Auth.WebauthnRegisterBegin)
	deps.Router.Post("/api/v1/auth/webauthn/register/finish", deps.Auth.WebauthnRegisterFinish)
	deps.Router.Get("/api/v1/auth/webauthn/credentials", deps.Auth.WebauthnListPasskeys)
	deps.Router.Patch("/api/v1/auth/webauthn/credentials/{id}", deps.Auth.WebauthnRenamePasskey)
	deps.Router.Delete("/api/v1/auth/webauthn/credentials/{id}", deps.Auth.WebauthnDeletePasskey)
	deps.Router.Get("/api/v1/auth/oauth/identities", deps.Auth.ListOAuthIdentities)
	deps.Router.Delete("/api/v1/auth/oauth/{provider}/link", deps.Auth.UnlinkOAuthIdentity)
	deps.Auth.MountRecoveryCodeRoutes(deps.Router)
	deps.Auth.MountSessionRoutes(deps.Router)
	deps.Auth.MountTrustedDeviceRoutes(deps.Router)
	deps.Auth.MountCLIAuthorizeRoute(deps.Router)
	deps.Auth.MountCLIDeviceApproveRoute(deps.Router.With(limited))
	admin_ip.MountRoutes(deps.Router, &admin_ip.Deps{Pool: deps.Pool})
	adminGate := apikeys.RequireExactTenantAdmin
	deps.Router.With(adminGate).Get("/api/v1/api-keys", deps.APIKeys.List)
	deps.Router.With(adminGate).Get("/api/v1/api-keys/{id}", deps.APIKeys.Get)
	deps.Router.With(adminGate).Post("/api/v1/api-keys", deps.APIKeys.Create)
	deps.Router.With(adminGate).Post("/api/v1/api-keys/{id}/rotate", deps.APIKeys.Rotate)
	deps.Router.With(adminGate).Patch("/api/v1/api-keys/{id}", deps.APIKeys.Update)
	deps.Router.With(adminGate).Delete("/api/v1/api-keys/{id}", deps.APIKeys.Delete)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/executions", deps.APIKeyCalls.ListExecutions)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/executions/stream", deps.APIKeyCalls.StreamExecutions)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/executions.csv", deps.APIKeyCalls.ExportExecutionsCSV)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/stats", deps.APIKeyCalls.GetStats)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/trend", deps.APIKeyCalls.GetTrend)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/catalog", deps.APIKeyCalls.GetCatalog)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Get("/api/v1/mcp/quotas", deps.APIKeyCalls.ListQuotasHandler)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Put("/api/v1/mcp/quotas", deps.APIKeyCalls.UpsertQuotaHandler)
	deps.Router.With(apikeycalls.ProtectMCPResponses, adminGate).Delete("/api/v1/mcp/quotas/{tool}", deps.APIKeyCalls.DeleteQuotaHandler)
	deps.Router.Get("/api/v1/openapi.json", deps.APIDocs.GetSpec)
	scoring.MountRoutes(deps.Router, &scoring.Deps{Pool: deps.Pool})
	deps.AuditSinkAdmin.MountAdminRoutes(deps.Router)
	deps.AuditSinkAdmin.MountDLQRoutes(deps.Router)
	deps.AuditSinkAdmin.MountTestRoutes(deps.Router)
	deps.AuditSinkAdmin.MountSigningKeyRoutes(deps.Router)
	deps.SCIMAdmin.MountAdminRoutes(deps.Router)
	scim.MountRoutes(deps.Router, deps.SCIMPublic)
	deps.AdminKMS.MountRoutes(deps.Router)
	deps.SpamCorpusAdmin.MountRoutes(deps.Router)
}

func identityTestBruteforce(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test-Auth-Bruteforce", "applied")
		next.ServeHTTP(w, r)
	})
}

func serveIdentityMiddleware(route subscriberListSegmentRoute, scopes []apikeys.Scope) *httptest.ResponseRecorder {
	terminal := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(299)
		_, _ = w.Write([]byte("middleware-passed"))
	})
	var handler http.Handler = terminal
	for index := len(route.middlewares) - 1; index >= 0; index-- {
		handler = route.middlewares[index](handler)
	}
	request := httptest.NewRequest(route.method, materializeRoutePath(route.path), http.NoBody)
	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, scopes)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request.WithContext(ctx))
	return response
}
