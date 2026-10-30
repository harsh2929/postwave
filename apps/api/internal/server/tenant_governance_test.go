// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"go/scanner"
	"go/token"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/agency"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/auditsink"
	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/compliance"
	"github.com/postwave/postwave/apps/api/internal/cost"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/emailpreview"
	"github.com/postwave/postwave/apps/api/internal/feedback"
	"github.com/postwave/postwave/apps/api/internal/handlers"
	"github.com/postwave/postwave/apps/api/internal/idempotency"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
	"github.com/postwave/postwave/apps/api/internal/paywall"
	"github.com/postwave/postwave/apps/api/internal/privacy"
	"github.com/postwave/postwave/apps/api/internal/regions"
)

func TestMountTenantGovernanceSurfaceMatchesEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newTenantGovernanceDeps(actualRouter)
	MountTenantGovernanceSurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newTenantGovernanceDeps(referenceRouter)
	mountLegacyTenantGovernanceSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 61 {
		t.Fatalf("tenant-governance route count = %d, want 61", len(actual))
	}

	scopeSets := []struct {
		name   string
		scopes []apikeys.Scope
	}{
		{name: "none"},
		{name: "read reports", scopes: []apikeys.Scope{apikeys.ScopeReadReports}},
		{name: "admin", scopes: []apikeys.Scope{apikeys.ScopeAdmin}},
		{name: "both", scopes: []apikeys.Scope{apikeys.ScopeReadReports, apikeys.ScopeAdmin}},
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

func TestMountTenantGovernanceSurfacePreservesRegistrationOrder(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("tenant_governance.go")
	if err != nil {
		t.Fatalf("read tenant_governance.go: %v", err)
	}
	source := string(sourceBytes)
	ordered := []string{
		"governance.Security.Get",
		"governance.Security.Update",
		"governance.SendSettings.Get",
		"governance.SendSettings.Update",
		"governance.Paywall.List",
		"governance.Paywall.Grant",
		"governance.Paywall.Revoke",
		"governance.Paywall.MountTierRoutes",
		"governance.OutboxDLQ.List",
		"governance.OutboxDLQ.Replay",
		"governance.Feedback.HandleHistory",
		"governance.Regions.Get",
		"governance.EmailPreview.Render",
		"governance.Privacy.RequestExport",
		"governance.Privacy.ListRequests",
		"governance.Privacy.DownloadExport",
		"governance.Privacy.RequestDeletion",
		"governance.Privacy.CreateGenericRequest",
		"governance.Privacy.IssueVerification",
		"governance.Privacy.ConfirmVerification",
		"governance.Privacy.SetLegalHold",
		"governance.Privacy.ClearLegalHold",
		"governance.Privacy.DenyRequest",
		"governance.Privacy.CreateAppeal",
		"governance.Privacy.RecordSubprocessorAck",
		"governance.PrivacyIncidentIdempotency",
		"privacy.MountIncidentRoutes",
		"privacy.MountTabletopRoutes",
		"privacy.MountDPARoutes",
		"compliance.Deps",
		"agency.MountRoutes",
		"governance.Cost.Aggregate",
		"governance.Cost.Aggregate",
		"governance.Cost.Ledger",
		"governance.Billing.State",
		"governance.Billing.PlanSummary",
		"governance.Billing.Checkout",
		"governance.Billing.Portal",
		"governance.Billing.Invoices",
		"governance.Billing.Usage",
		"governance.Billing.SetOverage",
	}
	if len(ordered) != 41 {
		t.Fatalf("registration contract contains %d entries, want 41", len(ordered))
	}
	assertOrderedOccurrences(t, source, ordered)
	assertServerMarkersInOrder(t, source, []string{
		"func MountTenantGovernanceSurface(",
		"MountTenantPolicyRoutes(deps)",
		"MountPrivacyComplianceRoutes(deps)",
		"MountCommercialAdminRoutes(deps)",
	})
}

func TestPrivacyIncidentReplayBoundariesAreWiredAroundAdminAuthorization(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	mainSource := root.main
	start := strings.Index(mainSource, "// Generalized Idempotency-Key dedup.")
	if start < 0 {
		t.Fatal("authenticated idempotency composition marker is missing")
	}
	endOffset := strings.Index(mainSource[start:], "r.Use(middleware.AuditMiddleware(pool))")
	if endOffset < 0 {
		t.Fatal("authenticated idempotency composition boundary is missing")
	}
	composition := mainSource[start : start+endOffset]
	assertOrderedOccurrences(t, composition, []string{
		"r.Use(idempotency.ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(",
		"idempotencyRepo",
		"resolveTenantID",
		"privacy.BypassIncidentGlobalReplay",
		"sms.SuppressionExactQueryReplayBypass",
		"service_suite.MutationReplayBypass",
		"support_integrations.EffectReplayBypass",
		"service_suite.HandlerOwnedInternalNoteReplay",
		"resolveIdempotencyReplayScope",
	})
	// The legacy middleware replays without the privacy release-hold guard. It
	// may not be used in the region, nor in a helper the region calls, nor
	// anywhere else in the composition root, whichever router it would be
	// mounted on. Both are read as Go tokens, so a comment that names it (main.go
	// explains why step-up runs before it) does not count, and neither does a
	// ProcessWith... constructor.
	if uses := goSelectorUses(root.withCalledFunctions(composition), "idempotency", "Process"); uses != 0 {
		t.Fatalf("the authenticated idempotency region, or a helper it calls, uses idempotency.Process "+
			"%d time(s), so the router can still bypass the privacy release-hold replay guard", uses)
	}
	if uses := goSelectorUses(root.all, "idempotency", "Process"); uses != 0 {
		t.Fatalf("the composition root uses idempotency.Process %d time(s); it bypasses the privacy "+
			"release-hold replay guard, so build the middleware with a ProcessWith... constructor", uses)
	}
	for _, marker := range []string{
		"privacyIncidentIdempotency := idempotency.ProcessWithReplayBypass(",
		"privacy.BypassIncidentReleaseHoldReplay",
		"PrivacyIncidentIdempotency: privacyIncidentIdempotency",
	} {
		if !strings.Contains(mainSource, marker) {
			t.Fatalf("main privacy replay composition is missing %q", marker)
		}
	}
}

func TestPrivacyIncidentAuthorizationAlwaysPrecedesCachedReplay(t *testing.T) {
	mutations := []struct {
		name string
		path string
		body string
		key  string
	}{
		{
			name: "incident create",
			path: "/api/v1/privacy/incidents",
			body: `{"summary":"cached"}`,
			key:  "privacy-create-1",
		},
		{
			name: "tabletop create",
			path: "/api/v1/privacy/incidents/tabletops",
			body: `{"scenario":"cached","participants":["owner"]}`,
			key:  "privacy-tabletop-1",
		},
		{
			name: "non-close transition",
			path: "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/transition",
			body: `{"expected_from":"open","to":"contained","reason":"cached"}`,
			key:  "privacy-transition-1",
		},
	}

	principals := []struct {
		name       string
		apiKey     bool
		scopes     []apikeys.Scope
		user       *middleware.User
		wantStatus int
		wantGets   int
	}{
		{
			name:       "api key without current admin scope cannot replay",
			apiKey:     true,
			scopes:     []apikeys.Scope{apikeys.ScopeWriteCampaigns},
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "api key with current admin scope replays",
			apiKey:     true,
			scopes:     []apikeys.Scope{apikeys.ScopeAdmin},
			wantStatus: http.StatusCreated,
			wantGets:   1,
		},
		{
			name: "view as viewer cannot replay with durable admin role",
			user: &middleware.User{
				ID: "user-1", Role: "admin", EffectiveRole: "viewer",
			},
			wantStatus: http.StatusForbidden,
		},
		{
			name: "effective admin session replays",
			user: &middleware.User{
				ID: "user-1", Role: "admin", EffectiveRole: "admin",
			},
			wantStatus: http.StatusCreated,
			wantGets:   1,
		},
	}

	for _, mutation := range mutations {
		mutation := mutation
		for _, principal := range principals {
			principal := principal
			t.Run(mutation.name+"/"+principal.name, func(t *testing.T) {
				digest := sha256.Sum256([]byte(http.MethodPost + "\n" + mutation.path + "\n" + mutation.body))
				store := &privacyIncidentReplayStore{record: &idempotency.Record{
					Key:             mutation.key,
					TenantID:        "tenant-1",
					Route:           http.MethodPost + " " + mutation.path,
					RequestHash:     hex.EncodeToString(digest[:]),
					ResponseStatus:  http.StatusCreated,
					ResponseBody:    []byte(`{"id":"cached-incident"}`),
					ResponseHeaders: http.Header{"Content-Type": {"application/json"}},
				}}
				router := chi.NewRouter()
				deps := newTenantGovernanceDeps(router)
				deps.TenantGovernance.PrivacyIncidentIdempotency = idempotency.ProcessWithReplayBypass(
					store,
					func(r *http.Request) (string, bool) {
						tenant, ok := middleware.TenantFromContext(r.Context())
						if !ok {
							return "", false
						}
						return tenant.ID, true
					},
					privacy.BypassIncidentReleaseHoldReplay,
				)
				MountPrivacyComplianceRoutes(deps)

				request := httptest.NewRequest(http.MethodPost, mutation.path, strings.NewReader(mutation.body))
				request.Header.Set(idempotency.HeaderName, mutation.key)
				ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
				if principal.apiKey {
					ctx = middleware.WithAPIKeyAuth(ctx)
					ctx = apikeys.WithScopes(ctx, principal.scopes)
				} else {
					ctx = middleware.WithUser(ctx, principal.user)
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request.WithContext(ctx))

				if response.Code != principal.wantStatus {
					t.Fatalf("status=%d body=%s, want %d", response.Code, response.Body.String(), principal.wantStatus)
				}
				if store.gets != principal.wantGets {
					t.Fatalf("replay lookups=%d, want %d", store.gets, principal.wantGets)
				}
				if principal.wantGets == 1 && response.Header().Get(idempotency.ReplayedHeaderName) != "true" {
					t.Fatal("authorized cache hit did not preserve the public replay marker")
				}
				assertPrivacyIncidentSensitiveHeaders(t, response.Header())
			})
		}
	}
}

func TestPrivacyIncidentHeadersCoverRouteLocalIdempotencyAndReleaseHold(t *testing.T) {
	router := chi.NewRouter()
	deps := newTenantGovernanceDeps(router)
	deps.TenantGovernance.PrivacyIncidentIdempotency = idempotency.ProcessWithReplayBypass(
		&privacyIncidentReplayStore{},
		func(r *http.Request) (string, bool) {
			tenant, ok := middleware.TenantFromContext(r.Context())
			if !ok {
				return "", false
			}
			return tenant.ID, true
		},
		privacy.BypassIncidentReleaseHoldReplay,
	)
	MountPrivacyComplianceRoutes(deps)

	tests := []struct {
		name       string
		method     string
		path       string
		body       string
		prepare    func(*http.Request)
		wantStatus int
		wantCode   string
	}{
		{
			name:   "duplicate idempotency header",
			method: http.MethodPost,
			path:   "/api/v1/privacy/incidents",
			body:   `{"summary":"bounded"}`,
			prepare: func(request *http.Request) {
				request.Header.Add(idempotency.HeaderName, "first")
				request.Header.Add(idempotency.HeaderName, "second")
			},
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_idempotency_key",
		},
		{
			name:       "counsel sign-off release hold",
			method:     http.MethodPost,
			path:       "/api/v1/privacy/incidents/00000000-0000-0000-0000-000000000001/signoff",
			body:       `{}`,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   "counsel_signoff_release_hold",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
			if test.prepare != nil {
				test.prepare(request)
			}
			ctx := middleware.WithTenant(request.Context(), &middleware.Tenant{ID: "tenant-1"})
			ctx = middleware.WithAPIKeyAuth(ctx)
			ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})

			response := httptest.NewRecorder()
			router.ServeHTTP(response, request.WithContext(ctx))
			if response.Code != test.wantStatus || !strings.Contains(response.Body.String(), test.wantCode) {
				t.Fatalf("status=%d body=%s, want %d/%s", response.Code, response.Body.String(), test.wantStatus, test.wantCode)
			}
			assertPrivacyIncidentSensitiveHeaders(t, response.Header())
		})
	}
}

func TestNewAuditSinkAdminDepsPreservesDependencyIdentity(t *testing.T) {
	pool := new(db.Pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cipher := tenantGovernanceCipher{}
	deps := NewAuditSinkAdminDeps(pool, cipher, cipher, logger)
	if deps.Pool != pool || deps.Logger != logger || deps.Encrypt != cipher || deps.Cipher != cipher {
		t.Fatal("audit-sink factory changed dependency identity")
	}
}

func TestTenantGovernanceMountsUsePassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		MountTenantGovernanceSurface(newTenantGovernanceDeps(authenticated))
	})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/security/settings", http.NoBody)
	request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("tenant-governance route escaped the passed authenticated router")
	}
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "insufficient_scope") {
		t.Fatalf("status = %d body = %s, want scoped 403", response.Code, response.Body.String())
	}
}

func TestTenantGovernanceMountsRejectIncompleteDependencyBags(t *testing.T) {
	valid := newTenantGovernanceDeps(chi.NewRouter())
	tests := []struct {
		name  string
		deps  Deps
		mount func(Deps)
	}{
		{name: "policy missing graph", deps: Deps{Router: chi.NewRouter(), Pool: valid.Pool}, mount: MountTenantPolicyRoutes},
		{name: "privacy missing graph", deps: Deps{Router: chi.NewRouter(), Pool: valid.Pool}, mount: MountPrivacyComplianceRoutes},
		{name: "commercial missing graph", deps: Deps{Router: chi.NewRouter(), Pool: valid.Pool}, mount: MountCommercialAdminRoutes},
		{name: "privacy missing pool", deps: Deps{Router: chi.NewRouter(), TenantGovernance: valid.TenantGovernance}, mount: MountPrivacyComplianceRoutes},
		{name: "commercial missing pool", deps: Deps{Router: chi.NewRouter(), TenantGovernance: valid.TenantGovernance}, mount: MountCommercialAdminRoutes},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			test.mount(test.deps)
			if routeCount(t, test.deps.Router) != 0 {
				t.Fatal("incomplete dependencies registered partial routes")
			}
		})
	}

	for _, mutation := range []struct {
		name   string
		mutate func(*TenantGovernanceDeps)
	}{
		{name: "security", mutate: func(deps *TenantGovernanceDeps) { deps.Security = nil }},
		{name: "send settings", mutate: func(deps *TenantGovernanceDeps) { deps.SendSettings = nil }},
		{name: "paywall", mutate: func(deps *TenantGovernanceDeps) { deps.Paywall = nil }},
		{name: "outbox", mutate: func(deps *TenantGovernanceDeps) { deps.OutboxDLQ = nil }},
		{name: "feedback", mutate: func(deps *TenantGovernanceDeps) { deps.Feedback = nil }},
		{name: "regions", mutate: func(deps *TenantGovernanceDeps) { deps.Regions = nil }},
		{name: "email preview", mutate: func(deps *TenantGovernanceDeps) { deps.EmailPreview = nil }},
		{name: "privacy", mutate: func(deps *TenantGovernanceDeps) { deps.Privacy = nil }},
		{name: "privacy incidents", mutate: func(deps *TenantGovernanceDeps) { deps.PrivacyIncidents = nil }},
		{name: "privacy incident idempotency", mutate: func(deps *TenantGovernanceDeps) { deps.PrivacyIncidentIdempotency = nil }},
		{name: "cost", mutate: func(deps *TenantGovernanceDeps) { deps.Cost = nil }},
		{name: "billing", mutate: func(deps *TenantGovernanceDeps) { deps.Billing = nil }},
	} {
		t.Run("surface missing "+mutation.name, func(t *testing.T) {
			deps := newTenantGovernanceDeps(chi.NewRouter())
			copy := *deps.TenantGovernance
			deps.TenantGovernance = &copy
			mutation.mutate(deps.TenantGovernance)
			MountTenantGovernanceSurface(deps)
			if routeCount(t, deps.Router) != 0 {
				t.Fatal("incomplete governance graph registered a partial surface")
			}
		})
	}
}

func TestNewIncludesCompleteTenantGovernanceSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newTenantGovernanceDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newTenantGovernanceDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	mountLegacyTenantGovernanceSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("server.New route count = %d, want %d", len(actual), len(reference))
	}
	for index := range reference {
		if actual[index].method != reference[index].method || actual[index].path != reference[index].path {
			t.Fatalf("server.New route[%d] = %s %s, want %s %s", index, actual[index].method, actual[index].path, reference[index].method, reference[index].path)
		}
	}
}

func newTenantGovernanceDeps(router chi.Router) Deps {
	pool := new(db.Pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return Deps{
		Router: router,
		Pool:   pool,
		Logger: logger,
		TenantGovernance: &TenantGovernanceDeps{
			Security:                   &handlers.SecurityHandlers{Pool: pool},
			SendSettings:               &handlers.SendSettingsHandlers{Pool: pool},
			Paywall:                    &paywall.Deps{Repo: &paywall.Repo{Pool: pool}, Logger: logger},
			OutboxDLQ:                  &outbox.Deps{Repo: &outbox.Repo{Pool: pool}, Logger: logger},
			Feedback:                   &feedback.Deps{Pool: pool, Repo: &feedback.Repo{Pool: pool}, Logger: logger},
			Regions:                    &regions.Handlers{Pool: pool},
			EmailPreview:               &emailpreview.Deps{},
			Privacy:                    &privacy.Deps{Pool: pool, Logger: logger},
			PrivacyIncidents:           &privacy.IncidentsDeps{Pool: pool, Logger: logger},
			PrivacyIncidentIdempotency: func(next http.Handler) http.Handler { return next },
			Cost:                       &cost.Handlers{Repo: &cost.Repo{Pool: pool}, Logger: logger},
			Billing:                    &billing.Handlers{Repo: billing.NewRepo(pool), Logger: logger},
		},
	}
}

func mountLegacyTenantGovernanceSurface(deps Deps) {
	governance := deps.TenantGovernance
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	deps.Router.With(admin).Get("/api/v1/security/settings", governance.Security.Get)
	deps.Router.With(admin).Put("/api/v1/security/settings", governance.Security.Update)
	deps.Router.With(admin).Get("/api/v1/send-settings", governance.SendSettings.Get)
	deps.Router.With(admin).Put("/api/v1/send-settings", governance.SendSettings.Update)
	deps.Router.With(admin).Get("/api/v1/paid-members", governance.Paywall.List)
	deps.Router.With(admin).Post("/api/v1/paid-members", governance.Paywall.Grant)
	deps.Router.With(admin).Delete("/api/v1/paid-members/{email}", governance.Paywall.Revoke)
	governance.Paywall.MountTierRoutes(deps.Router.With(admin))
	deps.Router.With(admin).Get("/api/v1/dlq", governance.OutboxDLQ.List)
	deps.Router.With(admin).Post("/api/v1/dlq/{id}/replay", governance.OutboxDLQ.Replay)
	deps.Router.With(admin).Post("/api/v1/feedback/history", governance.Feedback.HandleHistory)
	deps.Router.Get("/api/v1/tenant/region", governance.Regions.Get)
	deps.Router.Post("/api/v1/email-preview/render", governance.EmailPreview.Render)
	deps.Router.With(admin).Post("/api/v1/privacy/export-requests", governance.Privacy.RequestExport)
	deps.Router.With(admin).Get("/api/v1/privacy/requests", governance.Privacy.ListRequests)
	deps.Router.With(admin).Get("/api/v1/privacy/export-requests/{request_id}/download", governance.Privacy.DownloadExport)
	deps.Router.With(admin).Post("/api/v1/privacy/deletion-requests", governance.Privacy.RequestDeletion)
	deps.Router.With(admin).Post("/api/v1/privacy/requests", governance.Privacy.CreateGenericRequest)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/verify", governance.Privacy.IssueVerification)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/verify/confirm", governance.Privacy.ConfirmVerification)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/hold", governance.Privacy.SetLegalHold)
	deps.Router.With(admin).Delete("/api/v1/privacy/requests/{request_id}/hold", governance.Privacy.ClearLegalHold)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/deny", governance.Privacy.DenyRequest)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/appeal", governance.Privacy.CreateAppeal)
	deps.Router.With(admin).Post("/api/v1/privacy/requests/{request_id}/subprocessors/{subprocessor}/ack", governance.Privacy.RecordSubprocessorAck)
	deps.Router.Group(func(router chi.Router) {
		router.Use(privacy.ProtectIncidentResponses)
		router.Use(admin)
		router.Use(governance.PrivacyIncidentIdempotency)
		privacy.MountIncidentRoutes(router, governance.PrivacyIncidents)
		privacy.MountTabletopRoutes(router, governance.PrivacyIncidents)
	})
	privacy.MountDPARoutes(deps.Router, &privacy.DPADeps{Pool: deps.Pool})
	deps.Router.Group(func(router chi.Router) {
		router.Use(admin)
		(&compliance.Deps{Pool: deps.Pool, Logger: deps.Log()}).MountRoutes(router)
	})
	agency.MountRoutes(deps.Router, &agency.Deps{Pool: deps.Pool, Logger: deps.Log()})
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	deps.Router.With(readReports).Get("/api/v1/costs", governance.Cost.Aggregate)
	deps.Router.With(readReports).Get("/api/v1/cost/aggregate", governance.Cost.Aggregate)
	deps.Router.With(readReports).Get("/api/v1/costs/ledger", governance.Cost.Ledger)
	deps.Router.With(readReports).Get("/api/v1/billing/state", governance.Billing.State)
	deps.Router.With(readReports).Get("/api/v1/billing/plan-summary", governance.Billing.PlanSummary)
	deps.Router.With(admin).Post("/api/v1/billing/checkout", governance.Billing.Checkout)
	deps.Router.With(admin).Post("/api/v1/billing/portal", governance.Billing.Portal)
	deps.Router.With(readReports).Get("/api/v1/billing/invoices", governance.Billing.Invoices)
	deps.Router.With(readReports).Get("/api/v1/billing/usage", governance.Billing.Usage)
	deps.Router.With(admin).Put("/api/v1/billing/overage", governance.Billing.SetOverage)
}

// goSelectorUses counts pkg.name in Go source, called or taken as a value. It
// reads tokens, not text, so a comment or a string literal that names the
// selector does not count, and neither does a longer name that starts with it.
func goSelectorUses(source, pkg, name string) int {
	fileSet := token.NewFileSet()
	file := fileSet.AddFile("", fileSet.Base(), len(source))
	var s scanner.Scanner
	s.Init(file, []byte(source), nil, 0)
	uses := 0
	var previous [2]struct {
		tok token.Token
		lit string
	}
	for {
		_, tok, lit := s.Scan()
		if tok == token.EOF {
			return uses
		}
		if tok == token.IDENT && lit == name && previous[1].tok == token.PERIOD &&
			previous[0].tok == token.IDENT && previous[0].lit == pkg {
			uses++
		}
		previous[0] = previous[1]
		previous[1].tok, previous[1].lit = tok, lit
	}
}

func assertOrderedOccurrences(t *testing.T, source string, ordered []string) {
	t.Helper()
	offset := 0
	for _, marker := range ordered {
		index := strings.Index(source[offset:], marker)
		if index < 0 {
			t.Fatalf("tenant_governance.go is missing ordered marker %q", marker)
		}
		offset += index + len(marker)
	}
}

func assertPrivacyIncidentSensitiveHeaders(t *testing.T, header http.Header) {
	t.Helper()
	if got := header.Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("Cache-Control = %q, want private, no-store", got)
	}
	vary := strings.Join(header.Values("Vary"), ",")
	for _, dimension := range []string{"Authorization", "Cookie"} {
		if !strings.Contains(vary, dimension) {
			t.Fatalf("Vary = %q, missing %s", vary, dimension)
		}
	}
}

type tenantGovernanceCipher struct{}

type privacyIncidentReplayStore struct {
	record *idempotency.Record
	gets   int
}

func (s *privacyIncidentReplayStore) Get(_ context.Context, _, _ string) (*idempotency.Record, error) {
	s.gets++
	return s.record, nil
}

func (*privacyIncidentReplayStore) Claim(_ context.Context, _ *idempotency.Record) (bool, error) {
	return false, nil
}

func (*privacyIncidentReplayStore) Complete(_ context.Context, _ *idempotency.Record) error {
	return nil
}

func (*privacyIncidentReplayStore) DeletePending(_ context.Context, _, _ string) error {
	return nil
}

func (tenantGovernanceCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	return plaintext, nil
}

func (tenantGovernanceCipher) Decrypt(_ context.Context, ciphertext []byte, _ []byte) ([]byte, error) {
	return ciphertext, nil
}

var _ auditsink.Encrypter = tenantGovernanceCipher{}
var _ auditsink.Cipher = tenantGovernanceCipher{}
