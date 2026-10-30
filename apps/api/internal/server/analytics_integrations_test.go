// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/analytics_integrations"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

func TestAnalyticsIntegrationMountsMatchEveryLegacyRouteAndScope(t *testing.T) {
	actualRouter := chi.NewRouter()
	actualDeps := newAnalyticsIntegrationDeps(actualRouter)
	actualSurface := NewAnalyticsIntegrationsSurface(actualDeps)
	MountAuthenticatedAnalyticsIntegrationRoutes(actualRouter, actualSurface)
	MountPublicAnalyticsIntegrationRoutes(actualRouter, actualSurface)

	referenceRouter := chi.NewRouter()
	referenceDeps := newAnalyticsIntegrationDeps(referenceRouter)
	referenceSurface := NewAnalyticsIntegrationsSurface(referenceDeps)
	analytics_integrations.MountRoutes(referenceRouter, referenceSurface.Dependencies)
	analytics_integrations.MountPublicRoutes(referenceRouter, referenceSurface.Dependencies)

	actual := subscriberListSegmentRoutes(t, actualRouter)
	reference := subscriberListSegmentRoutes(t, referenceRouter)
	if len(actual) != len(reference) {
		t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
	}
	if len(actual) != 18 {
		t.Fatalf("analytics-integration route count = %d, want 18", len(actual))
	}
	for index := range reference {
		got, want := actual[index], reference[index]
		if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
			t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
		}
		for _, scopes := range [][]apikeys.Scope{nil, {apikeys.ScopeReadReports}, {apikeys.ScopeAdmin}, {apikeys.ScopeReadReports, apikeys.ScopeAdmin}} {
			gotResponse := serveRouteMiddleware(got, scopes)
			wantResponse := serveRouteMiddleware(want, scopes)
			if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
				t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
			}
		}
	}
}

func TestAnalyticsIntegrationSurfacePreservesGraphIdentity(t *testing.T) {
	t.Parallel()

	deps := newAnalyticsIntegrationDeps(chi.NewRouter())
	surface := NewAnalyticsIntegrationsSurface(deps)
	if surface.Repository == nil || surface.Repository.Pool != deps.Pool || surface.Dependencies == nil ||
		surface.Dependencies.Repo != surface.Repository || surface.Dependencies.Logger != deps.Logger ||
		surface.Dependencies.SegmentSecrets != deps.Secrets {
		t.Fatal("analytics integration surface changed shared graph identity")
	}
	if _, ok := surface.Dependencies.Profiles.(analytics_integrations.SubscriberProfileSink); !ok {
		t.Fatalf("analytics profile sink type = %T", surface.Dependencies.Profiles)
	}
	if _, ok := surface.Dependencies.Events.(analytics_integrations.TrackEventSink); !ok {
		t.Fatalf("analytics event sink type = %T", surface.Dependencies.Events)
	}
	assertAnalyticsBackfillerSecretIdentity(t, surface.Dependencies.PostHogBackfiller, deps.Secrets)
	assertAnalyticsBackfillerSecretIdentity(t, surface.Dependencies.TripleWhaleBackfiller, deps.Secrets)
	assertAnalyticsBackfillerSecretIdentity(t, surface.Dependencies.MixpanelBackfiller, deps.Secrets)
	assertAnalyticsBackfillerSecretIdentity(t, surface.Dependencies.AmplitudeBackfiller, deps.Secrets)

	for _, incomplete := range []AnalyticsIntegrationsDeps{
		{SubscriberProfiles: deps.SubscriberProfiles},
		{Pool: deps.Pool},
	} {
		if got := NewAnalyticsIntegrationsSurface(incomplete); got != (AnalyticsIntegrationsSurface{}) {
			t.Fatal("structurally incomplete analytics dependencies returned a partial surface")
		}
	}
}

func TestAnalyticsIntegrationRegistrationOrderAndMainOwnership(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	mainSource := root.main
	assertOrderedOccurrences(t, mainSource, []string{
		"apiserver.MountAuthenticatedProviderIntegrationRoutes(",
		"apiserver.NewAnalyticsIntegrationsSurface(",
		"apiserver.MountAuthenticatedAnalyticsIntegrationRoutes(",
		"apiworkers.StartAnalyticsIntegrationBackfills(",
		"apiserver.MountPublicAnalyticsIntegrationRoutes(",
		"mailchimpv3.Mount(",
	})
	for _, forbidden := range []string{
		"analyticsIntegrationRepo :=",
		"analyticsIntegrationsDeps :=",
		"analytics_integrations.MountRoutes(r,",
		"analyticsBackfillWorkers :=",
		"analytics_integrations.MountPublicRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated analytics integration composition %q", forbidden)
		}
	}
}

func newAnalyticsIntegrationDeps(_ chi.Router) AnalyticsIntegrationsDeps {
	pool := &db.Pool{}
	return AnalyticsIntegrationsDeps{
		Pool:               pool,
		Logger:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		SubscriberProfiles: &subscribers.Repo{Pool: pool},
		Secrets:            supportIntegrationSecretStub{},
	}
}

func assertAnalyticsBackfillerSecretIdentity(t *testing.T, backfiller analytics_integrations.AnalyticsBackfiller, secrets AnalyticsIntegrationSecretResolver) {
	t.Helper()
	var got analytics_integrations.AnalyticsPullerSecretResolver
	switch value := backfiller.(type) {
	case analytics_integrations.PostHogRESTBackfiller:
		got = value.Credentials.(analytics_integrations.PostHogSecretsCredentialResolver).Secrets
	case analytics_integrations.TripleWhaleRESTBackfiller:
		got = value.Credentials.(analytics_integrations.TripleWhaleSecretsCredentialResolver).Secrets
	case analytics_integrations.MixpanelRESTBackfiller:
		got = value.Credentials.(analytics_integrations.MixpanelSecretsCredentialResolver).Secrets
	case analytics_integrations.AmplitudeRESTBackfiller:
		got = value.Credentials.(analytics_integrations.AmplitudeSecretsCredentialResolver).Secrets
	default:
		t.Fatalf("unexpected analytics backfiller type %T", backfiller)
	}
	if got != secrets {
		t.Fatalf("analytics backfiller %T changed secret-resolver identity", backfiller)
	}
}
