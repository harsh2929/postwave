// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/commerce"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/crm_integrations"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/lead_integrations"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/marketing_integrations"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

func TestProviderIntegrationMountsMatchEveryLegacyRouteAndScope(t *testing.T) {
	tests := []struct {
		name       string
		wantRoutes int
		mount      func(chi.Router, ProviderIntegrationsSurface)
		reference  func(chi.Router, ProviderIntegrationsSurface)
	}{
		{
			name:       "authenticated",
			wantRoutes: 66,
			mount:      MountAuthenticatedProviderIntegrationRoutes,
			reference: func(router chi.Router, surface ProviderIntegrationsSurface) {
				commerce.Mount(router, surface.CommerceDependencies)
				crm_integrations.MountRoutes(router, surface.CRMDependencies)
				lead_integrations.MountRoutes(router, surface.LeadDependencies)
				marketing_integrations.MountRoutes(router, surface.MarketingDependencies)
			},
		},
		{
			name:       "oauth callbacks",
			wantRoutes: 1,
			mount:      MountProviderOAuthCallbackRoutes,
			reference: func(router chi.Router, surface ProviderIntegrationsSurface) {
				crm_integrations.MountOAuthCallbackRoutes(router, surface.CRMDependencies)
			},
		},
		{
			name:       "provider callbacks",
			wantRoutes: 38,
			mount:      MountPublicProviderIntegrationRoutes,
			reference: func(router chi.Router, surface ProviderIntegrationsSurface) {
				crm_integrations.MountPublicRoutes(router, surface.CRMDependencies)
				lead_integrations.MountPublicRoutes(router, surface.LeadDependencies)
				marketing_integrations.MountPublicRoutes(router, surface.MarketingDependencies)
			},
		},
		{
			name:       "commerce callbacks",
			wantRoutes: 12,
			mount:      MountCommercePublicRoutes,
			reference: func(router chi.Router, surface ProviderIntegrationsSurface) {
				commerce.MountPublic(router, surface.CommerceDependencies)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actualRouter := chi.NewRouter()
			actualSurface := NewProviderIntegrationsSurface(newProviderIntegrationsDeps())
			test.mount(actualRouter, actualSurface)

			referenceRouter := chi.NewRouter()
			referenceSurface := NewProviderIntegrationsSurface(newProviderIntegrationsDeps())
			test.reference(referenceRouter, referenceSurface)

			actual := subscriberListSegmentRoutes(t, actualRouter)
			reference := subscriberListSegmentRoutes(t, referenceRouter)
			if len(actual) != len(reference) {
				t.Fatalf("migrated route count = %d, legacy route count = %d", len(actual), len(reference))
			}
			if len(actual) != test.wantRoutes {
				t.Fatalf("%s route count = %d, want %d", test.name, len(actual), test.wantRoutes)
			}
			for index := range reference {
				got, want := actual[index], reference[index]
				if got.method != want.method || got.path != want.path || len(got.middlewares) != len(want.middlewares) {
					t.Fatalf("route[%d] = %s %s (%d middleware), want %s %s (%d)", index, got.method, got.path, len(got.middlewares), want.method, want.path, len(want.middlewares))
				}
				for _, scopes := range [][]apikeys.Scope{nil, {apikeys.ScopeReadReports}, {apikeys.ScopeAdmin}, {apikeys.ScopeWriteSubscribers, apikeys.ScopeAdmin}} {
					gotResponse := serveRouteMiddleware(got, scopes)
					wantResponse := serveRouteMiddleware(want, scopes)
					if gotResponse.Code != wantResponse.Code || gotResponse.Body.String() != wantResponse.Body.String() {
						t.Errorf("%s %s scopes %v = (%d,%q), want (%d,%q)", got.method, got.path, scopes, gotResponse.Code, gotResponse.Body.String(), wantResponse.Code, wantResponse.Body.String())
					}
				}
			}
		})
	}
}

func TestProviderIntegrationsPreserveDependencyGraphAndConfiguration(t *testing.T) {
	t.Parallel()

	deps := newProviderIntegrationsDeps()
	surface := NewProviderIntegrationsSurface(deps)
	if surface.CommerceRepository == nil || surface.CommerceDependencies == nil ||
		surface.CRMRepository == nil || surface.CRMDependencies == nil ||
		surface.LeadRepository == nil || surface.LeadDependencies == nil ||
		surface.MarketingRepository == nil || surface.MarketingDependencies == nil {
		t.Fatal("provider-integration surface returned an incomplete graph")
	}
	if surface.CommerceRepository.Pool != deps.Pool || surface.CRMRepository.Pool != deps.Pool ||
		surface.LeadRepository.Pool != deps.Pool || surface.MarketingRepository.Pool != deps.Pool {
		t.Fatal("provider-integration repositories changed pool identity")
	}
	if surface.CommerceRepository.Cipher != deps.Cipher || surface.CRMRepository.Cipher != deps.Cipher ||
		surface.MarketingRepository.Cipher != deps.Cipher {
		t.Fatal("provider-integration repositories changed cipher identity")
	}
	if surface.CommerceDependencies.Repo != surface.CommerceRepository ||
		surface.CRMDependencies.Repo != surface.CRMRepository ||
		surface.LeadDependencies.Repo != surface.LeadRepository ||
		surface.MarketingDependencies.Repo != surface.MarketingRepository {
		t.Fatal("provider handlers changed repository identity")
	}
	if surface.CommerceRepository.CatalogBackfill == nil || surface.CommerceRepository.CadenceBackfill == nil {
		t.Fatal("commerce computed-trait listeners were not retained")
	}
	if surface.CommerceDependencies.Config.ShopifyClientID != deps.Config.ShopifyClientID ||
		surface.CommerceDependencies.Config.ShopifyWebhookSecret != deps.Config.ShopifyWebhookSecret ||
		surface.CommerceDependencies.Config.AllowUnsignedShopifyWebhooks != deps.Config.AllowUnsignedShopifyWebhooks {
		t.Fatal("commerce runtime configuration changed")
	}
	if surface.CRMDependencies.PublicBaseURL != "https://public.example" ||
		surface.LeadDependencies.PublicBaseURL != "https://public.example" ||
		surface.MarketingDependencies.PublicBaseURL != "https://public.example" {
		t.Fatal("provider public-base configuration changed")
	}
	hubSpotCredentials, ok := surface.CRMDependencies.HubSpotCredentials.(*crm_integrations.HubSpotSecretsCredentialResolver)
	if !ok || hubSpotCredentials.Store != surface.CRMRepository || hubSpotCredentials.OAuthClient.OAuthBaseURL != "https://hubspot-oauth.example" {
		t.Fatal("HubSpot credential refresh graph changed")
	}
	klaviyoCredentials, ok := surface.MarketingDependencies.KlaviyoCredentials.(*marketing_integrations.KlaviyoSecretsCredentialResolver)
	if !ok || klaviyoCredentials.Store != surface.MarketingRepository || klaviyoCredentials.OAuthClient.OAuthBaseURL != "https://klaviyo-oauth.example" {
		t.Fatal("Klaviyo credential refresh graph changed")
	}
	if surface.CRMDependencies.Profiles == nil || surface.LeadDependencies.Profiles == nil {
		t.Fatal("subscriber profile sinks were not retained")
	}
	membershipSink, ok := surface.CRMDependencies.ListMemberships.(crm_integrations.NativeListMembershipSink)
	if !ok {
		t.Fatalf("CRM membership sink type = %T", surface.CRMDependencies.ListMemberships)
	}
	membershipRepo, ok := membershipSink.Repo.(*lists.Repo)
	if !ok || membershipRepo.MembershipWebhooks != deps.ListMemberships {
		t.Fatal("CRM list membership writes lost transactional webhook fanout")
	}

	if got := NewProviderIntegrationsSurface(ProviderIntegrationsDeps{}); got.CommerceRepository != nil || got.CRMRepository != nil || got.LeadRepository != nil || got.MarketingRepository != nil {
		t.Fatal("nil pool returned a partial provider graph")
	}
	optional := deps
	optional.Secrets = nil
	if got := NewProviderIntegrationsSurface(optional); got.CommerceDependencies == nil || got.CRMDependencies == nil || got.LeadDependencies == nil || got.MarketingDependencies == nil {
		t.Fatal("optional secret resolver disabled the structural provider graph")
	}
}

func TestProviderIntegrationsMainPlacementAndOwnership(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main
	assertOrderedOccurrences(t, source, []string{
		"providerIntegrationsSurface := apiserver.NewProviderIntegrationsSurface(",
		"apiworkers.StartMarketingIntegrationBackfills(outboxCtx,",
		"apiworkers.StartCommerceProviderBackfills(outboxCtx,",
		"apiserver.MountAuthenticatedProviderIntegrationRoutes(r, providerIntegrationsSurface)",
		"apiserver.MountProviderOAuthCallbackRoutes(r, providerIntegrationsSurface)",
		"apiserver.MountPublicProviderIntegrationRoutes(r, providerIntegrationsSurface)",
		"apiserver.MountCommercePublicRoutes(r, providerIntegrationsSurface)",
	})
	for _, forbidden := range []string{
		"commerceRepo := &commerce.Repo{",
		"crmIntegrationsDeps := &crm_integrations.Deps{",
		"leadIntegrationsDeps := &lead_integrations.Deps{",
		"marketingIntegrationsDeps := &marketing_integrations.Deps{",
		"commerce.Mount(r, commerceDeps)",
		"crm_integrations.MountPublicRoutes(r, crmIntegrationsDeps)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root retained migrated provider composition %q", forbidden)
		}
	}
}

func newProviderIntegrationsDeps() ProviderIntegrationsDeps {
	values := map[string]string{
		"POSTWAVE_PUBLIC_BASE_URL":  "https://public.example",
		"HUBSPOT_OAUTH_BASE_URL":    "https://hubspot-oauth.example",
		"KLAVIYO_OAUTH_BASE_URL":    "https://klaviyo-oauth.example",
		"HUBSPOT_APP_ID":            "app-id",
		"HUBSPOT_DEVELOPER_API_KEY": "developer-key",
	}
	pool := &db.Pool{}
	return ProviderIntegrationsDeps{
		Pool:               pool,
		Cipher:             providerIntegrationCipherStub{},
		SubscriberProfiles: &subscribers.Repo{Pool: pool},
		ListMemberships:    providerMembershipFanoutStub{},
		Secrets:            providerIntegrationSecretStub{},
		Config: config.Config{
			SendingKEK:                   []byte("legacy-key"),
			ShopifyClientID:              "shopify-client",
			ShopifyClientSecret:          "shopify-secret",
			ShopifyScopes:                []string{"read_customers"},
			ShopifyOAuthRedirectURL:      "https://public.example/shopify/callback",
			ShopifyStateSecret:           "state-secret",
			ShopifyWebhookSecret:         "webhook-secret",
			AllowUnsignedShopifyWebhooks: true,
		},
		Getenv: func(key string) string { return values[key] },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

type providerMembershipFanoutStub struct{}

func (providerMembershipFanoutStub) FireListSubscriberAddedBatch(
	context.Context,
	pgx.Tx,
	string,
	[]lists.SubscriberAddedMembership,
) (int, error) {
	return 0, nil
}

type providerIntegrationCipherStub struct{}

func (providerIntegrationCipherStub) Encrypt(context.Context, []byte) ([]byte, error) {
	return []byte("ciphertext"), nil
}

func (providerIntegrationCipherStub) Decrypt(context.Context, []byte, []byte) ([]byte, error) {
	return []byte("plaintext"), nil
}

type providerIntegrationSecretStub struct{}

func (providerIntegrationSecretStub) Get(context.Context, string) (string, error) { return "", nil }
func (providerIntegrationSecretStub) GetJSON(context.Context, string, any) error  { return nil }
