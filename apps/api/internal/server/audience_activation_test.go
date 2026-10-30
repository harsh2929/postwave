// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audience_destinations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/integration_writeback"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

func TestMountAudienceActivationSurfaceMatchesEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAudienceActivationDeps(actualRouter)
	MountAudienceActivationSurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAudienceActivationDeps(referenceRouter)
	mountLegacyAudienceActivationSurface(referenceDeps)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 30 {
		t.Fatalf("audience-activation route count = %d, want 30", len(actual))
	}

	scopeSets := [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadSubscribers},
		{apikeys.ScopeWriteSubscribers},
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{
			apikeys.ScopeReadSubscribers,
			apikeys.ScopeWriteSubscribers,
			apikeys.ScopeReadReports,
			apikeys.ScopeAdmin,
		},
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
		for _, scopes := range scopeSets {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf(
					"%s %s with scopes %v = (%d, %q), want (%d, %q)",
					got.method,
					got.path,
					scopes,
					gotResponse.Code,
					gotResponse.Body.String(),
					wantResponse.Code,
					wantResponse.Body.String(),
				)
			}
		}
	}
}

func TestMountAudienceActivationSurfacePreservesRegistrationOrderAndIdentity(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("audience_activation.go")
	if err != nil {
		t.Fatalf("read audience_activation.go: %v", err)
	}
	source := string(sourceBytes)
	assertOrderedOccurrences(t, source, []string{
		"audience_destinations.MountSyncRoutes(",
		"audience_destinations.MountRoutes(",
		"integration_writeback.MountRoutes(",
		"activation_firewall.MountSyncRoutes(",
		"activation_firewall.MountRoutes(",
	})
	for _, marker := range []string{
		"PurposeBatchAdapter{Pool: deps.Pool}",
		"suppressions.NewConverger(graph.Suppressions, logger)",
		"activation_firewall.NewRepo(deps.Pool)",
		"Repo:               syncRepo",
		"HTTPClient:         graph.HTTPClient",
		"Firewall:           filter",
		"ReceiptStore:       receiptStore",
		"ReceiptSignKey:     receiptKey",
		"Adapters:           adapters",
		"Secrets: graph.Secrets",
		"KlaviyoStore: graph.KlaviyoStore",
		"audience_destinations.NewFirewallMemberSource(syncRunner)",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("audience-activation identity contract missing %q", marker)
		}
	}

	deps := newAudienceActivationDeps(chi.NewRouter())
	surface := MountAudienceActivationSurface(deps)
	graph := deps.AudienceActivation
	if surface.Filter == nil || surface.ReceiptStore == nil || surface.SyncRepo == nil ||
		surface.SyncRunner == nil || surface.Writeback == nil {
		t.Fatal("audience-activation surface returned an incomplete graph")
	}
	consentAdapter, ok := surface.Filter.Consent.(*activation_firewall.PurposeBatchAdapter)
	if !ok || consentAdapter.Pool != deps.Pool {
		t.Fatal("activation firewall changed consent-adapter pool identity")
	}
	converger, ok := surface.Filter.Suppression.(*suppressions.SuppressionConverger)
	if !ok || converger.Store != graph.Suppressions || converger.Pool != deps.Pool || converger.Logger != deps.Logger {
		t.Fatal("activation firewall changed suppression-converger identity")
	}
	if surface.ReceiptStore.Pool != deps.Pool || surface.SyncRepo.Pool != deps.Pool {
		t.Fatal("audience activation changed repository pool identity")
	}
	if surface.ReceiptKey != "receipt-key" {
		t.Fatalf("trimmed receipt key = %q, want receipt-key", surface.ReceiptKey)
	}
	if surface.SyncRunner.Repo != surface.SyncRepo || surface.SyncRunner.HTTPClient != graph.HTTPClient ||
		surface.SyncRunner.Logger != deps.Logger || surface.SyncRunner.Firewall != surface.Filter ||
		surface.SyncRunner.ReceiptStore != surface.ReceiptStore ||
		surface.SyncRunner.ReceiptSignKey != surface.ReceiptKey {
		t.Fatal("audience sync runner changed shared dependency identity")
	}
	resolver, ok := surface.SyncRunner.CredentialResolver.(audience_destinations.SecretsAudienceCredentialResolver)
	if !ok || resolver.Secrets != graph.Secrets {
		t.Fatal("audience sync runner changed secrets-resolver identity")
	}
	metaKey := string(audience_destinations.ProviderMeta)
	metaAdapter := surface.Adapters[metaKey]
	delete(surface.Adapters, metaKey)
	if surface.SyncRunner.Adapters[metaKey] != nil {
		t.Fatal("audience sync runner received a divergent adapter registry")
	}
	surface.Adapters[metaKey] = metaAdapter

	writebackRepo, ok := surface.Writeback.Repo.(*integration_writeback.Repo)
	if !ok || writebackRepo.Pool != deps.Pool || surface.Writeback.Logger != deps.Logger {
		t.Fatal("integration write-back changed repo or logger identity")
	}
	writebackCredentials, ok := surface.Writeback.Credentials.(integration_writeback.MarketingAwareCredentialResolver)
	if !ok || writebackCredentials.Secrets != graph.Secrets || writebackCredentials.KlaviyoStore != graph.KlaviyoStore {
		t.Fatal("integration write-back changed credential identity")
	}
	if len(surface.Writeback.Adapters) != 7 {
		t.Fatalf("write-back adapter count = %d, want 7", len(surface.Writeback.Adapters))
	}
}

func TestAudienceActivationSurfaceUsesPassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		MountAudienceActivationSurface(newAudienceActivationDeps(authenticated))
	})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/audience-syncs", http.NoBody)
	request = request.WithContext(middleware.WithAPIKeyAuth(request.Context()))
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request)
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("audience-activation route escaped the passed authenticated router")
	}
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "insufficient_scope") {
		t.Fatalf("status = %d body = %s, want scoped 403", response.Code, response.Body.String())
	}
}

func TestAudienceActivationSurfaceRejectsOnlyStructuralDependencyGaps(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "router", mutate: func(deps *Deps) { deps.Router = nil }},
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "graph", mutate: func(deps *Deps) { deps.AudienceActivation = nil }},
	} {
		t.Run(test.name, func(t *testing.T) {
			deps := newAudienceActivationDeps(chi.NewRouter())
			test.mutate(&deps)
			surface := MountAudienceActivationSurface(deps)
			if surface.Filter != nil || surface.ReceiptStore != nil || surface.ReceiptKey != "" ||
				surface.SyncRepo != nil || surface.Adapters != nil || surface.SyncRunner != nil || surface.Writeback != nil {
				t.Fatal("structurally incomplete dependencies returned a partial graph")
			}
			if deps.Router != nil && routeCount(t, deps.Router) != 0 {
				t.Fatal("structurally incomplete dependencies registered partial routes")
			}
		})
	}

	deps := newAudienceActivationDeps(chi.NewRouter())
	deps.AudienceActivation.Suppressions = nil
	deps.AudienceActivation.Secrets = nil
	deps.AudienceActivation.HTTPClient = nil
	deps.AudienceActivation.KlaviyoStore = nil
	if surface := MountAudienceActivationSurface(deps); surface.SyncRunner == nil {
		t.Fatal("optional degraded-mode dependencies prevented graph construction")
	}
	if got := routeCount(t, deps.Router); got != 30 {
		t.Fatalf("optional degraded-mode dependency route count = %d, want 30", got)
	}
}

func TestAudienceActivationSurfaceWarnsForUnsignedReceipts(t *testing.T) {
	var logs bytes.Buffer
	deps := newAudienceActivationDeps(chi.NewRouter())
	deps.Logger = slog.New(slog.NewTextHandler(&logs, nil))
	deps.AudienceActivation.ReceiptSignKey = "  "
	surface := MountAudienceActivationSurface(deps)
	if surface.ReceiptKey != "" {
		t.Fatalf("receipt key = %q, want empty", surface.ReceiptKey)
	}
	if !strings.Contains(logs.String(), "POSTWAVE_RECEIPT_SIGNING_KEY unset") {
		t.Fatalf("missing unsigned-receipt warning: %s", logs.String())
	}
}

func TestNewIncludesCompleteAudienceActivationSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAudienceActivationDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAudienceActivationDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	mountLegacyAudienceActivationSurface(referenceDeps)

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

func TestAudienceActivationMainPlacementAndWorkerIdentity(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main
	assertOrderedOccurrences(t, source, []string{
		"audienceActivation := apiserver.MountAudienceActivationSurface(",
		"apiworkers.StartAudienceActivationWorkers(outboxCtx,",
		"Surface: audienceActivation",
		"Firewall:       audienceActivation.Filter",
		"ReceiptStore:   audienceActivation.ReceiptStore",
		"ReceiptSignKey: audienceActivation.ReceiptKey",
	})
	for _, forbidden := range []string{
		"activation_firewall.New(",
		"audience_destinations.MountSyncRoutes(",
		"integration_writeback.MountRoutes(",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated audience-activation composition %q", forbidden)
		}
	}
}

func newAudienceActivationDeps(router chi.Router) Deps {
	pool := new(db.Pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	secrets := &audienceActivationSecretStub{}
	return Deps{
		Router: router,
		Pool:   pool,
		Logger: logger,
		AudienceActivation: &AudienceActivationDeps{
			Suppressions:   &suppressions.Store{Pool: pool},
			Secrets:        secrets,
			HTTPClient:     &http.Client{},
			KlaviyoStore:   secrets,
			RequireHTTPS:   true,
			ReceiptSignKey: "  receipt-key  ",
		},
	}
}

func mountLegacyAudienceActivationSurface(deps Deps) AudienceActivationSurface {
	graph := deps.AudienceActivation
	logger := deps.Log()
	filter := activation_firewall.New(
		&activation_firewall.PurposeBatchAdapter{Pool: deps.Pool},
		suppressions.NewConverger(graph.Suppressions, logger),
	)
	receiptStore := activation_firewall.NewRepo(deps.Pool)
	receiptKey := strings.TrimSpace(graph.ReceiptSignKey)
	syncRepo := &audience_destinations.Repo{Pool: deps.Pool}
	adapters := audience_destinations.DefaultAdapterRegistry()
	credentialResolver := audience_destinations.SecretsAudienceCredentialResolver{Secrets: graph.Secrets}
	syncRunner := &audience_destinations.SyncRunner{
		Repo:               syncRepo,
		HTTPClient:         graph.HTTPClient,
		Logger:             logger,
		Firewall:           filter,
		ReceiptStore:       receiptStore,
		ReceiptSignKey:     receiptKey,
		Adapters:           adapters,
		CredentialResolver: credentialResolver,
	}
	audience_destinations.MountSyncRoutes(deps.Router, &audience_destinations.SyncDeps{
		Repo:         syncRepo,
		Runner:       syncRunner,
		Logger:       logger,
		RequireHTTPS: graph.RequireHTTPS,
	})
	audience_destinations.MountRoutes(deps.Router, &audience_destinations.Deps{
		Repo:               syncRepo,
		CredentialResolver: credentialResolver,
		Logger:             logger,
		Adapters:           adapters,
		Runner:             syncRunner,
	})
	writeback := &integration_writeback.Deps{
		Repo: &integration_writeback.Repo{Pool: deps.Pool},
		Credentials: integration_writeback.MarketingAwareCredentialResolver{
			Secrets:      graph.Secrets,
			KlaviyoStore: graph.KlaviyoStore,
		},
		Adapters: map[string]integration_writeback.Adapter{
			integration_writeback.ProviderShopify:     integration_writeback.ShopifyWritebackAdapter{},
			integration_writeback.ProviderHubSpot:     integration_writeback.HubSpotWritebackAdapter{},
			integration_writeback.ProviderSalesforce:  integration_writeback.SalesforceWritebackAdapter{},
			integration_writeback.ProviderPipedrive:   integration_writeback.PipedriveWritebackAdapter{},
			integration_writeback.ProviderWooCommerce: integration_writeback.WooCommerceWritebackAdapter{},
			integration_writeback.ProviderZoho:        integration_writeback.ZohoWritebackAdapter{},
			integration_writeback.ProviderKlaviyo:     integration_writeback.KlaviyoWritebackAdapter{},
		},
		Logger: logger,
	}
	integration_writeback.MountRoutes(deps.Router, writeback)
	activation_firewall.MountSyncRoutes(deps.Router, &activation_firewall.SyncDeps{
		Filter:  filter,
		Store:   receiptStore,
		Source:  audience_destinations.NewFirewallMemberSource(syncRunner),
		SignKey: receiptKey,
		Logger:  logger,
	})
	activation_firewall.MountRoutes(deps.Router, &activation_firewall.Deps{
		Store:  receiptStore,
		Logger: logger,
	})
	return AudienceActivationSurface{
		Filter:       filter,
		ReceiptStore: receiptStore,
		ReceiptKey:   receiptKey,
		SyncRepo:     syncRepo,
		Adapters:     adapters,
		SyncRunner:   syncRunner,
		Writeback:    writeback,
	}
}

type audienceActivationSecretStub struct{}

func (*audienceActivationSecretStub) Get(context.Context, string) (string, error) {
	return "", errors.New("not configured")
}

func (*audienceActivationSecretStub) GetJSON(context.Context, string, any) error {
	return errors.New("not configured")
}

func (*audienceActivationSecretStub) GetKlaviyoCredentialSecret(context.Context, string, string) (string, error) {
	return "", errors.New("not configured")
}
