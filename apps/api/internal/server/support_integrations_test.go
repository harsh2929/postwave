// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/flowbuilder"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/service_suite"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
	"github.com/postwave/postwave/apps/api/internal/track"
)

func TestMountSupportIntegrationsSurfaceMatchesAuthenticatedHelpdeskAndControlRoutes(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSupportIntegrationsDeps(actualRouter)
	MountSupportIntegrationsSurface(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSupportIntegrationsDeps(referenceRouter)
	referenceSurface := newSupportIntegrationsSurface(referenceDeps)
	service_suite.MountRoutes(referenceRouter, referenceSurface.ServiceSuite)
	support_integrations.MountRoutes(referenceRouter, referenceSurface.Dependencies)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 43 {
		t.Fatalf("authenticated helpdesk/control route count = %d, want 43", len(actual))
	}

	scopeSets := [][]apikeys.Scope{
		nil,
		{apikeys.ScopeReadReports},
		{apikeys.ScopeAdmin},
		{apikeys.ScopeReadReports, apikeys.ScopeAdmin},
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

func TestMountSupportIntegrationsSurfacePreservesRegistrationAndDependencyIdentity(t *testing.T) {
	t.Parallel()

	sourceBytes, err := os.ReadFile("support_integrations.go")
	if err != nil {
		t.Fatalf("read support_integrations.go: %v", err)
	}
	source := string(sourceBytes)
	assertOrderedOccurrences(t, source, []string{
		"service_suite.MountRoutes(",
		"support_integrations.MountRoutes(",
	})
	if strings.Contains(source, "support_integrations.MountPublicRoutes(") {
		t.Fatal("provider callbacks must not inherit the authenticated support surface")
	}
	for _, marker := range []string{
		"ServiceSuiteSink{Repo: serviceSuiteRepo, Pool: deps.Pool}",
		"SubscriberSupportSink{Repo: graph.SubscriberProfiles}",
		"TrackEventSink{Repo: &track.Repo{Pool: deps.Pool, FlowRuns: &flowbuilder.Repo{Pool: deps.Pool}}}",
		"PublicBaseURL:              graph.PublicBaseURL",
		"HubSpotWebhookClientSecret: graph.HubSpotClientSecret",
		"WebhookSecrets:             graph.Secrets",
		"Store:   graph.SalesforceCredentialStore",
		"LoginURL:  graph.SalesforceOAuthLoginURL",
		"UserAgent: \"Moosewave Salesforce Service Cloud Integration\"",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("support-integrations identity contract missing %q", marker)
		}
	}

	deps := newSupportIntegrationsDeps(chi.NewRouter())
	surface := MountSupportIntegrationsSurface(deps)
	if surface.ServiceSuite == nil || surface.ServiceSuite.Repo == nil || surface.Repository == nil ||
		surface.Dependencies == nil || len(surface.Backfills) != 26 {
		t.Fatal("support-integrations surface returned an incomplete graph")
	}
	if surface.ServiceSuite.Repo.Pool != deps.Pool || surface.Repository.Pool != deps.Pool ||
		surface.Dependencies.Repo != surface.Repository || surface.Dependencies.Logger != deps.Logger {
		t.Fatal("support-integrations surface changed repo, pool, or logger identity")
	}

	suite, ok := surface.Dependencies.Suite.(support_integrations.ServiceSuiteSink)
	if !ok || suite.Repo != surface.ServiceSuite.Repo || suite.Pool != deps.Pool {
		t.Fatal("support integration changed service-suite sink identity")
	}
	profiles, ok := surface.Dependencies.Profiles.(support_integrations.SubscriberSupportSink)
	if !ok || profiles.Repo != deps.SupportIntegrations.SubscriberProfiles {
		t.Fatal("support integration changed subscriber-profile sink identity")
	}
	events, ok := surface.Dependencies.Events.(support_integrations.TrackEventSink)
	if !ok {
		t.Fatal("support integration changed event sink type")
	}
	eventRepo, ok := events.Repo.(*track.Repo)
	if !ok || eventRepo.Pool != deps.Pool {
		t.Fatal("support integration changed event repo identity")
	}
	flowRepo, ok := eventRepo.FlowRuns.(*flowbuilder.Repo)
	if !ok || flowRepo.Pool != deps.Pool {
		t.Fatal("support integration changed flow-run repo identity")
	}
	if surface.Dependencies.WebhookSecrets != deps.SupportIntegrations.Secrets ||
		surface.Dependencies.PublicBaseURL != "https://public.example" ||
		surface.Dependencies.HubSpotWebhookClientSecret != "hubspot-secret" {
		t.Fatal("support integration changed webhook configuration identity")
	}

	wantNames := []string{
		"zendesk", "intercom", "helpscout", "freshdesk", "freshchat", "tidio", "ada", "gladly",
		"groove", "helpcrunch", "jira-service-management", "linear", "asana-support", "clickup-support",
		"gorgias", "front", "reamaze", "crisp", "kustomer", "drift", "livechat", "zoho-desk",
		"olark", "kayako", "hubspot-service-hub", "salesforce-service-cloud",
	}
	wantProviders := []string{
		support_integrations.ProviderZendesk,
		support_integrations.ProviderIntercom,
		support_integrations.ProviderHelpScout,
		support_integrations.ProviderFreshdesk,
		support_integrations.ProviderFreshchat,
		support_integrations.ProviderTidio,
		support_integrations.ProviderAda,
		support_integrations.ProviderGladly,
		support_integrations.ProviderGroove,
		support_integrations.ProviderHelpCrunch,
		support_integrations.ProviderJiraServiceManagement,
		support_integrations.ProviderLinear,
		support_integrations.ProviderAsanaSupport,
		support_integrations.ProviderClickUpSupport,
		support_integrations.ProviderGorgias,
		support_integrations.ProviderFront,
		support_integrations.ProviderReamaze,
		support_integrations.ProviderCrisp,
		support_integrations.ProviderKustomer,
		support_integrations.ProviderDrift,
		support_integrations.ProviderLiveChat,
		support_integrations.ProviderZohoDesk,
		support_integrations.ProviderOlark,
		support_integrations.ProviderKayako,
		support_integrations.ProviderHubSpotServiceHub,
		support_integrations.ProviderSalesforceServiceCloud,
	}
	wantBackfillers := supportIntegrationBackfillerInventory(surface.Dependencies)
	for index, backfill := range surface.Backfills {
		if backfill.Name != wantNames[index] || backfill.Provider != wantProviders[index] {
			t.Fatalf("backfill[%d] = %q/%q, want %q/%q", index, backfill.Name, backfill.Provider, wantNames[index], wantProviders[index])
		}
		if !reflect.DeepEqual(backfill.Backfiller, wantBackfillers[index]) {
			t.Fatalf("backfill[%d] does not reuse the HTTP dependency identity", index)
		}
	}
}

func TestSupportIntegrationsSurfaceUsesPassedAuthenticatedRouter(t *testing.T) {
	root := chi.NewRouter()
	root.Group(func(authenticated chi.Router) {
		authenticated.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Test-Authenticated-Boundary", "applied")
				next.ServeHTTP(w, r)
			})
		})
		MountSupportIntegrationsSurface(newSupportIntegrationsDeps(authenticated))
	})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/service-suite/catalog", http.NoBody)
	ctx := middleware.WithAPIKeyAuth(request.Context())
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeReadReports})
	response := httptest.NewRecorder()
	root.ServeHTTP(response, request.WithContext(ctx))
	if response.Header().Get("X-Test-Authenticated-Boundary") != "applied" {
		t.Fatal("support-integrations route escaped the passed authenticated router")
	}
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s, want 200", response.Code, response.Body.String())
	}
}

func TestSupportIntegrationsSurfaceRejectsOnlyStructuralDependencyGaps(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Deps)
	}{
		{name: "router", mutate: func(deps *Deps) { deps.Router = nil }},
		{name: "pool", mutate: func(deps *Deps) { deps.Pool = nil }},
		{name: "graph", mutate: func(deps *Deps) { deps.SupportIntegrations = nil }},
	} {
		t.Run(test.name, func(t *testing.T) {
			deps := newSupportIntegrationsDeps(chi.NewRouter())
			test.mutate(&deps)
			surface := MountSupportIntegrationsSurface(deps)
			if surface.ServiceSuite != nil || surface.Repository != nil || surface.Dependencies != nil || surface.Backfills != nil {
				t.Fatal("structurally incomplete dependencies returned a partial graph")
			}
			if deps.Router != nil && routeCount(t, deps.Router) != 0 {
				t.Fatal("structurally incomplete dependencies registered partial routes")
			}
		})
	}

	deps := newSupportIntegrationsDeps(chi.NewRouter())
	deps.SupportIntegrations.Secrets = nil
	deps.SupportIntegrations.SalesforceCredentialStore = nil
	surface := MountSupportIntegrationsSurface(deps)
	if surface.Dependencies == nil || len(surface.Backfills) != 26 || routeCount(t, deps.Router) == 0 {
		t.Fatal("optional provider integrations disabled the structural support surface")
	}
}

func TestNewIncludesCompleteSupportIntegrationsSurface(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newSupportIntegrationsDeps(actualRouter)
	New(actualDeps)

	referenceRouter := chi.NewRouter()
	referenceDeps := newSupportIntegrationsDeps(referenceRouter)
	MountDeliverabilitySurface(referenceDeps)
	referenceSurface := newSupportIntegrationsSurface(referenceDeps)
	service_suite.MountRoutes(referenceRouter, referenceSurface.ServiceSuite)
	support_integrations.MountRoutes(referenceRouter, referenceSurface.Dependencies)

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

func TestSupportIntegrationsMainPlacementAndWorkerIdentity(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main
	assertOrderedOccurrences(t, source, []string{
		"apiserver.MountPlatformCatalogRoutes(",
		"supportIntegrationsSurface := apiserver.MountSupportIntegrationsSurface(",
		"apiworkers.StartSupportIntegrationBackfills(outboxCtx, logger, supportIntegrationsSurface)",
		"apiserver.MountSubscriberProtectionUtilities(",
	})
	for _, marker := range []string{
		"SubscriberProfiles:        subscriberDeps.Repo",
		"Secrets:                   secretsResolver",
		"SalesforceCredentialStore: salesforceServiceCloudCredentialStoreAdapter{store: crmIntegrationsRepo}",
		"PublicBaseURL:             os.Getenv(\"POSTWAVE_PUBLIC_BASE_URL\")",
		"HubSpotClientSecret:       os.Getenv(\"HUBSPOT_OAUTH_CLIENT_SECRET\")",
		"SalesforceOAuthLoginURL:   os.Getenv(\"SALESFORCE_OAUTH_LOGIN_URL\")",
	} {
		if !strings.Contains(source, marker) {
			t.Fatalf("main.go support composition missing %q", marker)
		}
	}
	for _, forbidden := range []string{
		"service_suite.MountRoutes(r,",
		"support_integrations.MountRoutes(r,",
		"supportIntegrationsDeps := &support_integrations.Deps{",
		"SupportBackfillWorker{",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated support-integrations composition %q", forbidden)
		}
	}
	const publicHoldMount = "support_integrations.MountPublicRoutes(r, nil)"
	if inRun, inRoot := strings.Count(root.run, publicHoldMount), strings.Count(root.all, publicHoldMount); inRun != 1 ||
		inRoot != 1 {
		t.Fatalf("root pre-auth provider-family hold mount count = %d in run() and %d in the composition root, "+
			"want 1 and 1", inRun, inRoot)
	}
	if publicHold := strings.Index(source, "support_integrations.MountPublicRoutes(r, nil)"); publicHold < 0 || publicHold > strings.Index(source, "supportIntegrationsSurface := apiserver.MountSupportIntegrationsSurface(") {
		t.Fatal("provider-family hold must be mounted at root before the authenticated support surface")
	}
}

func newSupportIntegrationsDeps(router chi.Router) Deps {
	pool := &db.Pool{}
	return Deps{
		Router: router,
		Pool:   pool,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		SupportIntegrations: &SupportIntegrationsDeps{
			SubscriberProfiles:        &subscribers.Repo{Pool: pool},
			Secrets:                   supportIntegrationSecretStub{},
			SalesforceCredentialStore: &supportIntegrationSalesforceStoreStub{},
			PublicBaseURL:             "https://public.example",
			HubSpotClientSecret:       "hubspot-secret",
			SalesforceOAuthLoginURL:   "https://login.salesforce.example",
		},
	}
}

func supportIntegrationBackfillerInventory(deps *support_integrations.Deps) []support_integrations.SupportProviderBackfiller {
	return []support_integrations.SupportProviderBackfiller{
		deps.ZendeskBackfiller,
		deps.IntercomBackfiller,
		deps.HelpScoutBackfiller,
		deps.FreshdeskBackfiller,
		deps.FreshchatBackfiller,
		deps.TidioBackfiller,
		deps.AdaBackfiller,
		deps.GladlyBackfiller,
		deps.GrooveBackfiller,
		deps.HelpCrunchBackfiller,
		deps.JiraServiceManagementBackfiller,
		deps.LinearBackfiller,
		deps.AsanaSupportBackfiller,
		deps.ClickUpSupportBackfiller,
		deps.GorgiasBackfiller,
		deps.FrontBackfiller,
		deps.ReamazeBackfiller,
		deps.CrispBackfiller,
		deps.KustomerBackfiller,
		deps.DriftBackfiller,
		deps.LiveChatBackfiller,
		deps.ZohoDeskBackfiller,
		deps.OlarkBackfiller,
		deps.KayakoBackfiller,
		deps.HubSpotServiceHubBackfiller,
		deps.SalesforceServiceCloudBackfiller,
	}
}

type supportIntegrationSecretStub struct{}

func (supportIntegrationSecretStub) Get(context.Context, string) (string, error) {
	return "secret", nil
}

func (supportIntegrationSecretStub) GetJSON(context.Context, string, any) error {
	return nil
}

type supportIntegrationSalesforceStoreStub struct{}

func (*supportIntegrationSalesforceStoreStub) GetSalesforceServiceCloudCredentialSecret(context.Context, string, string) (string, error) {
	return "credential", nil
}

func (*supportIntegrationSalesforceStoreStub) PutSalesforceServiceCloudCredentialSecret(context.Context, string, string, support_integrations.SalesforceServiceCloudCredentials) error {
	return nil
}
