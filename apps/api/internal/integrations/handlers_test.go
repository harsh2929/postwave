// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func authenticatedIntegrationRouter(d *Deps) *chi.Mux {
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u := &middleware.User{ID: "test-owner", Role: "owner", EffectiveRole: "owner", MFASatisfied: true}
			next.ServeHTTP(w, r.WithContext(middleware.WithUser(r.Context(), u)))
		})
	})
	MountRoutes(router, d)
	return router
}

func TestCatalogHasBreadthAndHonestBadges(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/catalog", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res catalogResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) < targetPublicEntries {
		t.Fatalf("catalog too small: got %d items", len(res.Items))
	}
	required := map[string]bool{
		"shopify":           false,
		"zapier":            false,
		"hubspot":           false,
		"typeform":          false,
		"surveymonkey":      false,
		"github":            false,
		"meta":              false,
		"snowflake":         false,
		"outbound-webhooks": false,
		"inbound-webhooks":  false,
	}
	for _, item := range res.Items {
		if _, ok := required[item.Slug]; ok {
			required[item.Slug] = true
		}
		if item.Native && item.RuntimeStatus == RuntimePlanned {
			t.Fatalf("%s claims native support while planned", item.Slug)
		}
		if item.Badge == BadgeNative && item.RuntimeStatus == RuntimePlanned {
			t.Fatalf("%s uses native badge while planned", item.Slug)
		}
	}
	for slug, seen := range required {
		if !seen {
			t.Fatalf("missing required catalog entry %q", slug)
		}
	}
}

func TestCatalogSupportsServerSideSearchAndFilters(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/catalog?q=shopify&category=ecommerce&badge=native&capability=orders", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res catalogResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].Slug != "shopify" {
		t.Fatalf("expected only shopify, got %+v", res.Items)
	}
}

func TestShippingNativeTilesUseShippingCategory(t *testing.T) {
	for _, slug := range []string{"aftership", "shipstation", "shippo", "easyship", "shipbob", "easypost", "narvar", "route", "malomo", "wonderment"} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing shipping catalog item %q", slug)
		}
		if item.Category != "shipping" {
			t.Fatalf("%s category = %q, want shipping", slug, item.Category)
		}
	}
}

func TestPartnerMarketplaceListingMapsToHonestCatalogItem(t *testing.T) {
	item, ok := catalogItemFromPartnerListing(partnerCatalogInput{
		AppID:                "app_123",
		AppType:              "public",
		Distribution:         "marketplace",
		AppStatus:            "active",
		PartnerProfileStatus: "certified",
		AppScopes:            []string{"read:subscribers", "write:events"},
		WebhookTopics:        []string{"profile.created", "support.ticket_updated"},
		Description:          "Syncs helpdesk and profile events.",
		Slug:                 "partner-helpdesk",
		Name:                 "Partner Helpdesk",
		Category:             "customer support",
		DocsURL:              "https://partner.example/docs",
		Tags:                 []string{"support", "automation"},
		Metadata: map[string]any{
			"capabilities": []any{"profiles", "events"},
		},
	})
	if !ok {
		t.Fatal("expected approved marketplace listing to map")
	}
	if item.Badge != BadgePartner || item.Native {
		t.Fatalf("partner listing must not claim native support: %+v", item)
	}
	if item.RuntimeStatus != RuntimeDelegated {
		t.Fatalf("runtime = %s, want delegated", item.RuntimeStatus)
	}
	if item.Category != "customer_service" {
		t.Fatalf("category = %q, want customer_service", item.Category)
	}
	for _, cap := range []Capability{CapabilityProfiles, CapabilityEvents, CapabilitySupport, CapabilityAutomationTriggers} {
		if !hasCapability(item, cap) {
			t.Fatalf("missing capability %s in %+v", cap, item.Capabilities)
		}
	}
	for _, source := range []string{"developer_marketplace", "partner_catalog", "app_listing", "oauth_app", "app_webhooks"} {
		if !hasSource(item, source) {
			t.Fatalf("missing source %q in %+v", source, item.Sources)
		}
	}
	if item.SetupPath != "/api-playground" {
		t.Fatalf("setup path = %q, want /api-playground", item.SetupPath)
	}
	if len(RecipesForItem(item)) != 1 {
		t.Fatalf("expected generic partner bridge recipe")
	}
}

func TestPartnerMarketplaceListingRequiresCertifiedPartnerProfile(t *testing.T) {
	if _, ok := catalogItemFromPartnerListing(partnerCatalogInput{
		AppID:                "app_123",
		AppType:              "public",
		Distribution:         "marketplace",
		AppStatus:            "active",
		PartnerProfileStatus: "submitted",
		Slug:                 "partner-helpdesk",
		Name:                 "Partner Helpdesk",
		Category:             "customer support",
	}); ok {
		t.Fatal("submitted partner profiles must not surface public catalog tiles")
	}
}

func TestPartnerCatalogMergePreservesStaticNativeClaims(t *testing.T) {
	base := []CatalogItem{{
		Slug:          "shopify",
		Name:          "Shopify",
		Badge:         BadgeNative,
		RuntimeStatus: RuntimeAvailable,
	}}
	extra := []CatalogItem{{
		Slug:          "shopify",
		Name:          "Partner Shopify App",
		Badge:         BadgePartner,
		RuntimeStatus: RuntimeDelegated,
	}, {
		Slug:          "partner-helpdesk",
		Name:          "Partner Helpdesk",
		Badge:         BadgePartner,
		RuntimeStatus: RuntimeDelegated,
	}}
	merged := mergeCatalogItems(base, extra)
	if len(merged) != 2 {
		t.Fatalf("merged len = %d, want 2: %+v", len(merged), merged)
	}
	if merged[0].Slug != "shopify" || merged[0].Badge != BadgeNative {
		t.Fatalf("static native catalog item should win on duplicate slug: %+v", merged[0])
	}
	if merged[1].Slug != "partner-helpdesk" || merged[1].Badge != BadgePartner {
		t.Fatalf("expected non-duplicate partner listing to append: %+v", merged[1])
	}
}

func TestPartnerCatalogContributesToCoverageReadinessAndRecipes(t *testing.T) {
	partner, ok := catalogItemFromPartnerListing(partnerCatalogInput{
		AppID:                "app_456",
		AppType:              "public",
		Distribution:         "partner_catalog",
		AppStatus:            "approved",
		PartnerProfileStatus: "certified",
		AppScopes:            []string{"read:subscribers", "write:events"},
		Slug:                 "partner-attribution",
		Name:                 "Partner Attribution",
		Category:             "analytics",
		Summary:              "Partner attribution sync for profile and event enrichment.",
		DocsURL:              "https://partner.example/attribution/docs",
		Tags:                 []string{"analytics", "events", "segments"},
	})
	if !ok {
		t.Fatal("expected partner listing to map")
	}
	items := mergeCatalogItems(CatalogItems(), []CatalogItem{partner})
	recipes := AllRecipesForItems(items)
	coverage := CoverageForItems(items, recipes)
	staticCoverage := Coverage()
	if coverage.PublicEntries != staticCoverage.PublicEntries+1 {
		t.Fatalf("partner listing should increase public entries, got dynamic=%d static=%d", coverage.PublicEntries, staticCoverage.PublicEntries)
	}
	if coverage.BadgeCounts[string(BadgePartner)] <= staticCoverage.BadgeCounts[string(BadgePartner)] {
		t.Fatalf("partner badge count did not increase: dynamic=%+v static=%+v", coverage.BadgeCounts, staticCoverage.BadgeCounts)
	}
	if coverage.AvailableRecipes <= staticCoverage.AvailableRecipes {
		t.Fatalf("partner generated recipe should increase available recipes, dynamic=%d static=%d", coverage.AvailableRecipes, staticCoverage.AvailableRecipes)
	}
	if recipe, ok := recipeByID(recipes, "partner-attribution-bridge-recipe"); !ok || !recipe.Available {
		t.Fatalf("missing available partner bridge recipe: %+v", recipe)
	}
	readiness := ReadinessForItems(items, recipes)
	if !readiness.Ready || readiness.IssueCounts["severity:blocker"] != 0 {
		t.Fatalf("partner overlay should preserve readiness, got issues=%+v", readiness.Issues)
	}
}

func TestPartnerMarketplaceLifecycleUsesCanonicalOAuthRoutes(t *testing.T) {
	partner, ok := catalogItemFromPartnerListing(partnerCatalogInput{
		AppID:                "app_789",
		AppType:              "public",
		Distribution:         "marketplace",
		AppStatus:            "active",
		PartnerProfileStatus: "certified",
		AppScopes:            []string{"read:subscribers", "write:events"},
		Slug:                 "partner-attribution",
		Name:                 "Partner Attribution",
		Category:             "analytics",
		Summary:              "Partner attribution sync for profile and event enrichment.",
		DocsURL:              "https://partner.example/attribution/docs",
		Tags:                 []string{"analytics", "events", "segments"},
	})
	if !ok {
		t.Fatal("expected partner listing to map")
	}

	start, code := lifecycleAction(partner, "connect/start")
	if code != http.StatusAccepted {
		t.Fatalf("status=%d response=%+v", code, start)
	}
	if start.DelegatedTo != "POST /api/v1/developer-marketplace/oauth/authorize" {
		t.Fatalf("connect/start delegated_to = %q", start.DelegatedTo)
	}
	for _, field := range []string{"client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"} {
		if !containsString(start.RequiredFields, field) {
			t.Fatalf("missing required field %q in %+v", field, start.RequiredFields)
		}
	}

	callback, _ := lifecycleAction(partner, "connect/callback")
	if callback.DelegatedTo != "POST /api/v1/developer-marketplace/oauth/token" {
		t.Fatalf("connect/callback delegated_to = %q", callback.DelegatedTo)
	}
	disconnect, _ := lifecycleAction(partner, "disconnect")
	if disconnect.DelegatedTo != "DELETE /api/v1/developer-marketplace/installations/{installation_id}" {
		t.Fatalf("disconnect delegated_to = %q", disconnect.DelegatedTo)
	}
	if !containsString(disconnect.RequiredFields, "installation_id") {
		t.Fatalf("disconnect should require installation_id: %+v", disconnect.RequiredFields)
	}

	setup := SetupGuide(partner)
	if len(setup) < 3 || setup[0].Action != "Install app" {
		t.Fatalf("unexpected partner setup guide: %+v", setup)
	}
	contract := runtimeConnectorContractFixture(partner)
	for _, channel := range []string{"marketplace_oauth", "app_webhooks"} {
		if !containsString(contract.BridgeChannels, channel) {
			t.Fatalf("missing bridge channel %q in %+v", channel, contract.BridgeChannels)
		}
	}
	for _, action := range dataDeleteFor(partner) {
		if action.Path == "/api/v1/developer-marketplace/apps/{id}/revoke" || action.Path == "/api/v1/developer/apps" {
			t.Fatalf("stale marketplace route in data delete actions: %+v", action)
		}
	}
}

func TestDeveloperMarketplaceFacadeRoutesUseCurrentAPI(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("developer-marketplace")
	if !ok {
		t.Fatal("developer-marketplace catalog item missing")
	}
	if got := delegatedEndpoint(item, "connect/start"); got != "POST /api/v1/developer-marketplace/apps" {
		t.Fatalf("developer marketplace connect endpoint = %q", got)
	}
	if got := delegatedEndpoint(item, "sync"); got != "GET /api/v1/developer-marketplace/apps/{id}/monitoring" {
		t.Fatalf("developer marketplace sync endpoint = %q", got)
	}
	recipe := Recipe{SetupPath: "/api-playground"}
	if got := recipeDelegatedEndpoint(recipe); got != "POST /api/v1/api-keys or POST /api/v1/developer-marketplace/apps" {
		t.Fatalf("recipe delegated endpoint = %q", got)
	}
}

func TestPromotedManagedConnectorsHaveNativeContracts(t *testing.T) {
	for _, slug := range []string{
		"freshdesk",
		"help-scout",
		"front",
		"zoho-desk",
		"judge-me",
		"okendo",
		"loox",
		"stamped",
		"trustpilot",
		"reviews-io",
		"bazaarvoice",
		"powerreviews",
		"loyaltylion",
		"rivo",
		"referralcandy",
		"growave",
		"marsello",
		"antavo",
		"friendbuy",
		"talkable",
		"shippo",
		"easyship",
		"shipbob",
		"easypost",
		"narvar",
		"route",
		"malomo",
		"wonderment",
		"bold-subscriptions",
		"ordergroove",
		"loop-subscriptions",
		"appstle",
		"seal-subscriptions",
		"chargebee",
		"posthog",
		"heap",
		"hotjar",
		"fullstory",
		"plausible",
		"tally",
		"zoho-crm",
		"microsoft-dynamics-365",
		"keap",
		"close",
		"copper",
		"freshsales",
		"highlevel",
		"google-forms",
		"microsoft-forms",
		"surveymonkey",
		"facebook-lead-ads",
		"linkedin-lead-gen",
		"google-lead-form-extensions",
		"tiktok-lead-generation",
		"snap-lead-ads",
		"reddit-lead-gen",
		"pinterest-lead-ads",
		"unbounce",
		"leadpages",
		"instapage",
		"carrd",
		"paperform",
		"formstack",
		"fillout",
		"optinmonster",
		"privy",
		"convertflow",
		"sleeknote",
		"wisepops",
		"poptin",
		"hello-bar",
		"unstack",
		"landingi",
		"kickofflabs",
		"shortstack",
		"formsite",
		"cognito-forms",
		"ninja-forms",
		"formidable-forms",
		"interact",
		"outgrow",
		"riddle",
		"qualtrics-forms",
		"feathery",
		"formaloo",
		"123formbuilder",
		"kustomer",
		"freshchat",
		"livechat",
		"crisp",
		"tidio",
		"olark",
		"drift",
		"ada",
		"gladly",
		"reamaze",
		"groove",
		"kayako",
		"helpcrunch",
		"hubspot-service-hub",
		"salesforce-service-cloud",
		"jira-service-management",
		"linear",
		"asana-support",
		"clickup-support",
		"fathom-analytics",
		"matomo",
		"adobe-analytics",
		"looker-studio",
		"looker",
		"tableau",
		"power-bi",
		"mode",
		"metabase",
		"sisense",
		"kissmetrics",
		"woopra",
		"chartmogul",
		"baremetrics",
		"profitwell",
		"triple-whale",
		"northbeam",
		"daasity",
		"glew",
		"peel-insights",
	} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		if hasSource(item, "support_integration") {
			live, found := CatalogItemBySlug(slug)
			if !found || live.Badge != BadgePlanned || live.RuntimeStatus != RuntimePlanned || len(LifecycleActions(live)) != 0 || ContractFor(live).RuntimeStatus != "held" {
				t.Fatalf("%s support provider did not remain release-held: item=%+v contract=%+v", slug, live, ContractFor(live))
			}
			continue
		}
		if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
			t.Fatalf("%s should be native partial, got badge=%s runtime=%s", slug, item.Badge, item.RuntimeStatus)
		}
		contract := runtimeConnectorContractFixture(item)
		if !contract.NativeManaged || contract.Owner != "postwave" {
			t.Fatalf("%s should expose postwave-owned contract, got %+v", slug, contract)
		}
		if delegatedEndpoint(item, "connect/start") == "" || len(LifecycleActions(item)) == 0 {
			t.Fatalf("%s missing lifecycle delegation", slug)
		}
	}
}

func TestAdAudienceCatalogItemsAreNativePartialUntilProviderVerificationLands(t *testing.T) {
	for _, slug := range []string{"meta", "google-ads", "tiktok", "linkedin", "snap"} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
			t.Fatalf("%s should be native partial, got badge=%s runtime=%s", slug, item.Badge, item.RuntimeStatus)
		}
		desc := strings.ToLower(item.Summary)
		if !strings.Contains(desc, "foundation") && !strings.Contains(desc, "local runtime") {
			t.Fatalf("%s should describe the current adapter foundation/runtime honestly: %q", slug, item.Summary)
		}
		if strings.Contains(desc, "credential-ref resolution") {
			t.Fatalf("%s should not describe credential-reference resolution as a platform-wide missing runtime after resolver wiring: %q", slug, item.Summary)
		}
		if strings.HasPrefix(desc, "sync ") {
			t.Fatalf("%s should not claim live sync before provider verification lands: %q", slug, item.Summary)
		}
		if slug == "google-ads" {
			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
				!strings.Contains(contract.PublicClaim, "Data Manager credential resolution") ||
				!strings.Contains(contract.PublicClaim, "add/remove delivery") ||
				strings.Contains(contract.PublicClaim, "webhook") {
				t.Fatalf("google-ads contract should expose Data Manager local-complete/live-cert-pending state without a webhook claim: %+v", contract)
			}
			if !strings.Contains(contract.RateLimitPolicy, "audienceMembers:remove") ||
				!strings.Contains(contract.RateLimitPolicy, "explicit OfflineUserDataJob worker gate") ||
				!strings.Contains(contract.RateLimitPolicy, "outside the Data Manager local-complete slice") {
				t.Fatalf("google-ads rate policy should separate Data Manager completion from legacy fallback: %+v", contract.RateLimitPolicy)
			}
		}
		if slug == "tiktok" {
			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
				!strings.Contains(contract.PublicClaim, "Customer File upload") ||
				!strings.Contains(contract.PublicClaim, "provider-status readback") ||
				strings.Contains(contract.PublicClaim, "webhook") {
				t.Fatalf("tiktok contract should expose Customer File local-complete/live-cert-pending state without a webhook claim: %+v", contract)
			}
			if !strings.Contains(contract.RateLimitPolicy, "/dmp/custom_audience/get/") ||
				!strings.Contains(contract.RateLimitPolicy, "Retry-After-aware") ||
				!strings.Contains(contract.RateLimitPolicy, "REMOVE/REPLACE") {
				t.Fatalf("tiktok rate policy should disclose retry/readback and remaining provider-cert gates: %+v", contract.RateLimitPolicy)
			}
		}
		if slug == "snap" {
			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
				!strings.Contains(contract.PublicClaim, "segment-user add/remove/replace delivery") ||
				!strings.Contains(contract.PublicClaim, "provider-status readback") ||
				strings.Contains(contract.PublicClaim, "webhook") {
				t.Fatalf("snap contract should expose segment-user local-complete/live-cert-pending state without a webhook claim: %+v", contract)
			}
			if !strings.Contains(contract.RateLimitPolicy, "GET /segments/{segment_id}") ||
				!strings.Contains(contract.RateLimitPolicy, "Retry-After-aware") ||
				!strings.Contains(contract.RateLimitPolicy, "REPLACE") {
				t.Fatalf("snap rate policy should disclose retry/readback and remaining provider-cert gates: %+v", contract.RateLimitPolicy)
			}
		}
		if slug == "linkedin" {
			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
				!strings.Contains(contract.PublicClaim, "DMP segment-user add/remove delivery") ||
				!strings.Contains(contract.PublicClaim, "provider-status readback") ||
				strings.Contains(contract.PublicClaim, "webhook") {
				t.Fatalf("linkedin contract should expose segment-user local-complete/live-cert-pending state without a webhook claim: %+v", contract)
			}
			if !strings.Contains(contract.RateLimitPolicy, "GET /dmpSegments/{segment_id}") ||
				!strings.Contains(contract.RateLimitPolicy, "Retry-After-aware") ||
				!strings.Contains(contract.RateLimitPolicy, "replacement semantics") {
				t.Fatalf("linkedin rate policy should disclose retry/readback and remaining provider-cert gates: %+v", contract.RateLimitPolicy)
			}
		}
	}
}

func TestMetaAudienceDestinationDisclosesResolverBackedPartialRuntime(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("meta")
	if !ok {
		t.Fatal("missing meta catalog item")
	}
	if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
		t.Fatalf("meta should stay native partial until live certification, got badge=%s runtime=%s", item.Badge, item.RuntimeStatus)
	}
	desc := strings.ToLower(item.Summary)
	for _, want := range []string{"vault-hydrated", "graph v25.0", "email_sha256", "provider certification"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("meta summary missing %q: %q", want, item.Summary)
		}
	}
	contract := runtimeConnectorContractFixture(item)
	for _, want := range []string{"ads_access_token_ref", "credential_ref"} {
		if !containsString(contract.AuthModes, want) {
			t.Fatalf("meta contract missing auth mode %q: %+v", want, contract.AuthModes)
		}
	}
	if !strings.Contains(strings.ToLower(contract.CredentialStorage), "runtime secret resolver") ||
		!strings.Contains(strings.ToLower(contract.SecretPolicy), "raw meta ads access tokens") ||
		!strings.Contains(strings.ToLower(contract.RateLimitPolicy), "graph v25.0") ||
		!strings.Contains(strings.ToLower(contract.RateLimitPolicy), "email_sha256") {
		t.Fatalf("meta contract should disclose resolver-backed Graph delivery: %+v", contract)
	}
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "consent-filtered Graph delivery") {
		t.Fatalf("meta contract should expose local-complete/live-cert-pending delivery state: %+v", contract)
	}
	report := healthReport(item, connectionFromItem(item))
	foundSync := false
	foundDisconnect := false
	for _, check := range report.Checks {
		msg := strings.ToLower(check.Message)
		if check.Key == "sync" && strings.Contains(msg, "graph v25.0") && strings.Contains(msg, "email_sha256") {
			foundSync = true
		}
		if check.Key == "disconnect" && strings.Contains(msg, "meta access-token revocation") {
			foundDisconnect = true
		}
	}
	if !foundSync || !foundDisconnect {
		t.Fatalf("meta health checks should disclose sync/disconnect boundaries: %+v", report.Checks)
	}
}

func TestSMSCatalogItemsStayReleaseHeldUntilProviderLifecycleIsDurable(t *testing.T) {
	for _, slug := range []string{"twilio", "telnyx", "bandwidth"} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		if item.Badge != BadgePlanned || item.RuntimeStatus != RuntimePlanned {
			t.Fatalf("%s should be release-held/planned, got badge=%s runtime=%s", slug, item.Badge, item.RuntimeStatus)
		}
		if item.SetupPath != "" {
			t.Fatalf("%s release-held provider must not advertise setup path %q", slug, item.SetupPath)
		}
		desc := strings.ToLower(item.Summary)
		for _, want := range []string{"release-held", "live sends", "tenant-bound provider-vault"} {
			if !strings.Contains(desc, want) {
				t.Fatalf("%s summary should mention %q: %q", slug, want, item.Summary)
			}
		}
		contract := runtimeConnectorContractFixture(item)
		if contract.ImplementationDepth != "planned" || contract.NativeManaged || contract.NativeVerified ||
			!strings.Contains(strings.ToLower(contract.PublicClaim), "planned integration") || len(contract.AuthModes) != 0 ||
			!strings.Contains(strings.ToLower(contract.CredentialStorage), "tenant-bound") {
			t.Fatalf("%s contract should expose a non-runnable release-held state: %+v", slug, contract)
		}
		for _, forbidden := range []string{"runtime-complete", "consent-gated sends", "provider callback verification"} {
			if strings.Contains(desc, forbidden) {
				t.Fatalf("%s summary overclaims SMS native scope: %q", slug, item.Summary)
			}
		}
	}
}

func TestReviewPullerCatalogItemsExposeLocalRuntimeCompleteUntilProviderCertification(t *testing.T) {
	for _, slug := range []string{"judge-me", "okendo", "loox", "stamped", "trustpilot", "reviews-io", "bazaarvoice", "powerreviews"} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
			t.Fatalf("%s should be native partial, got badge=%s runtime=%s", slug, item.Badge, item.RuntimeStatus)
		}
		desc := strings.ToLower(item.Summary)
		for _, want := range []string{"credential refs", "scheduled retry", "operator-managed provider_cleanup", "live"} {
			if !strings.Contains(desc, want) {
				t.Fatalf("%s summary should mention %q: %q", slug, want, item.Summary)
			}
		}
		contract := runtimeConnectorContractFixture(item)
		if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
			!strings.Contains(contract.PublicClaim, "REST review pulls") ||
			!strings.Contains(contract.PublicClaim, "webhook/Q&A/syndication expansion proof") ||
			containsString(contract.AuthModes, "webhook_secret_ref") ||
			!containsString(contract.Monitoring, "review_provider_backfill_worker") ||
			!containsString(contract.Monitoring, "provider_cleanup_evidence") ||
			!containsString(contract.ComplianceGates, "review_webhook_certification_pending") {
			t.Fatalf("%s contract should expose REST-puller local-runtime-complete/live-certification-pending state without webhook auth claims: %+v", slug, contract)
		}
		if strings.Contains(desc, "webhooks and scheduled continuation remain partial") {
			t.Fatalf("%s summary still has stale scheduled-continuation blocker copy: %q", slug, item.Summary)
		}
	}
}

func TestLoyaltyPullerCatalogItemsExposeLocalRuntimeCompleteUntilProviderCertification(t *testing.T) {
	for _, slug := range []string{"loyaltylion", "rivo", "referralcandy", "friendbuy"} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
			t.Fatalf("%s should be native partial, got badge=%s runtime=%s", slug, item.Badge, item.RuntimeStatus)
		}
		desc := strings.ToLower(item.Summary)
		for _, want := range []string{"credential refs", "scheduled retry", "operator-managed provider_cleanup", "live"} {
			if !strings.Contains(desc, want) {
				t.Fatalf("%s summary should mention %q: %q", slug, want, item.Summary)
			}
		}
		contract := runtimeConnectorContractFixture(item)
		if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
			!strings.Contains(contract.PublicClaim, "REST loyalty pulls") ||
			!strings.Contains(contract.PublicClaim, "webhook/reward/referral expansion proof") ||
			containsString(contract.AuthModes, "webhook_secret_ref") ||
			!containsString(contract.Monitoring, "loyalty_provider_backfill_worker") ||
			!containsString(contract.Monitoring, "provider_cleanup_evidence") ||
			!containsString(contract.ComplianceGates, "loyalty_webhook_certification_pending") {
			t.Fatalf("%s contract should expose loyalty REST-puller local-runtime-complete/live-certification-pending state without webhook auth claims: %+v", slug, contract)
		}
		if strings.Contains(desc, "scheduled continuation remain partial") {
			t.Fatalf("%s summary still has stale scheduled-continuation blocker copy: %q", slug, item.Summary)
		}
	}
}

func TestSubscriptionPullerCatalogItemsExposeLocalRuntimeCompleteUntilProviderCertification(t *testing.T) {
	cases := []struct {
		slug       string
		wantObject string
		wantPull   string
		blocked    []string
	}{
		{slug: "skio", wantObject: "subscriptions", wantPull: "Skio GraphQL Subscriptions", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "subscription/updated"}},
		{slug: "chargebee", wantObject: "subscriptions", wantPull: "Chargebee /api/v2/subscriptions", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "subscription/updated"}},
		{slug: "loop-subscriptions", wantObject: "subscriptions", wantPull: "Loop /admin/2023-10/subscription", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "subscription/updated"}},
		{slug: "appstle", wantObject: "subscriptions", wantPull: "Appstle /api/external/v2/subscription-contracts", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "subscription/updated"}},
		{slug: "seal-subscriptions", wantObject: "subscriptions", wantPull: "Seal /subscriptions", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "subscription/updated"}},
		{slug: "bold-subscriptions", wantObject: "subscriptions", wantPull: "Bold /subscriptions/v1/shops/{shop}/subscriptions", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "subscription/updated"}},
		{slug: "aftership", wantObject: "shipments", wantPull: "AfterShip /v4/trackings", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "tracking.updated"}},
		{slug: "shipstation", wantObject: "shipments", wantPull: "ShipStation /orders", blocked: []string{"orders", "invoices", "contracts", "rules", "fulfillments", "checkpoints", "shipment.delivered"}},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing catalog item %q", tc.slug)
			}
			if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
				t.Fatalf("%s should be native partial, got badge=%s runtime=%s", tc.slug, item.Badge, item.RuntimeStatus)
			}
			desc := strings.ToLower(item.Summary)
			for _, want := range []string{"local-runtime-complete/live-certification-pending", "scheduled retry", "operator-managed provider_cleanup", "live"} {
				if !strings.Contains(desc, want) {
					t.Fatalf("%s summary should mention %q: %q", tc.slug, want, item.Summary)
				}
			}
			if strings.Contains(desc, "scheduled continuation remain partial") ||
				strings.Contains(desc, "scheduled continuation remains partial") {
				t.Fatalf("%s summary still has stale scheduled-continuation blocker copy: %q", tc.slug, item.Summary)
			}

			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
				!strings.Contains(contract.PublicClaim, "read pulls") ||
				!strings.Contains(contract.PublicClaim, "implemented provider-puller slice") ||
				containsString(contract.AuthModes, "webhook_secret_ref") ||
				!containsString(contract.DataObjects, tc.wantObject) ||
				!containsString(contract.Monitoring, "subscription_provider_backfill_worker") ||
				!containsString(contract.Monitoring, "provider_cleanup_evidence") ||
				!containsString(contract.ComplianceGates, "subscription_webhook_certification_pending") ||
				!strings.Contains(contract.RateLimitPolicy, "provider_cleanup") {
				t.Fatalf("%s contract should expose provider-puller local-runtime-complete/live-certification-pending state without webhook auth claims: %+v", tc.slug, contract)
			}
			for _, blocked := range tc.blocked {
				if containsString(contract.DataObjects, blocked) || containsString(contract.EventTopics, blocked) {
					t.Fatalf("%s puller contract should not expose object/topic %q before certification: data=%+v topics=%+v", tc.slug, blocked, contract.DataObjects, contract.EventTopics)
				}
			}

			setup := SetupGuide(item)
			if len(setup) != 3 ||
				!strings.Contains(setup[1].Description, tc.wantPull) ||
				strings.Contains(setup[2].Description, "provider webhooks and scheduled sync runs") {
				t.Fatalf("%s setup guide should describe the concrete read puller without generic webhook fallback: %+v", tc.slug, setup)
			}
			sync, _ := lifecycleAction(item, "sync")
			token := strings.ReplaceAll(tc.slug, "-", "_")
			if !containsString(sync.RequiredFields, tc.wantObject+"|empty_"+token+"_provider_pull") ||
				!strings.Contains(sync.Message, tc.wantPull) ||
				strings.Contains(strings.ToLower(sync.Message), "ingest foundation") {
				t.Fatalf("%s sync action should describe concrete provider-puller state: %+v", tc.slug, sync)
			}
			disconnect, _ := lifecycleAction(item, "disconnect")
			if !strings.Contains(disconnect.Message, "provider_cleanup readiness evidence") ||
				!strings.Contains(disconnect.Message, "provider-cleanup/acknowledge") {
				t.Fatalf("%s disconnect action should disclose cleanup evidence and acknowledgement: %+v", tc.slug, disconnect)
			}
		})
	}
}

func TestAnalyticsPullerCatalogItemsExposeLocalRuntimeCompleteUntilProviderCertification(t *testing.T) {
	cases := []struct {
		slug     string
		wantPull string
		wantRate string
	}{
		{slug: "posthog", wantPull: "PostHog GET /api/projects/{project_id}/persons", wantRate: "/api/projects/{project_id}/persons"},
		{slug: "triple-whale", wantPull: "Triple Whale customer pages", wantRate: "customer pages"},
		{slug: "mixpanel", wantPull: "Mixpanel POST /api/query/engage", wantRate: "/api/query/engage"},
		{slug: "amplitude", wantPull: "Amplitude asynchronous Behavioral Cohort export", wantRate: "Behavioral Cohort export"},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing catalog item %q", tc.slug)
			}
			if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
				t.Fatalf("%s should be native partial, got badge=%s runtime=%s", tc.slug, item.Badge, item.RuntimeStatus)
			}
			desc := strings.ToLower(item.Summary)
			for _, want := range []string{"local-runtime-complete/live-certification-pending", "profile puller", "scheduled retry", "operator-managed provider_cleanup", "live provider certification"} {
				if !strings.Contains(desc, want) {
					t.Fatalf("%s summary should mention %q: %q", tc.slug, want, item.Summary)
				}
			}
			if strings.Contains(desc, "profile/event ingest foundation") {
				t.Fatalf("%s summary should not use generic analytics ingest-foundation copy: %q", tc.slug, item.Summary)
			}

			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
				!strings.Contains(contract.PublicClaim, "analytics connector") ||
				!strings.Contains(contract.PublicClaim, "profile pulls") ||
				strings.Contains(contract.PublicClaim, "webhook runtime complete") ||
				containsString(contract.AuthModes, "webhook_secret_ref") ||
				len(contract.DataObjects) != 1 ||
				!containsString(contract.DataObjects, "profiles") ||
				len(contract.EventTopics) != 1 ||
				!containsString(contract.EventTopics, "profile.upserted") ||
				!containsString(contract.Monitoring, "analytics_provider_backfill_worker") ||
				!containsString(contract.Monitoring, "analytics_provider_retry_cursors") ||
				!containsString(contract.Monitoring, "provider_cleanup_evidence") ||
				!containsString(contract.ComplianceGates, "analytics_credential_ref_required") ||
				!containsString(contract.ComplianceGates, "analytics_webhook_event_report_certification_pending") ||
				!containsString(contract.ComplianceGates, "live_provider_certification_pending") ||
				!strings.Contains(contract.RateLimitPolicy, tc.wantRate) ||
				!strings.Contains(contract.RateLimitPolicy, "Retry-After-aware") ||
				!strings.Contains(contract.RateLimitPolicy, "provider_cleanup") {
				t.Fatalf("%s contract should expose analytics profile-puller local-runtime-complete/live-certification-pending state without webhook claims: %+v", tc.slug, contract)
			}
			for _, blocked := range []string{"events", "reports", "webhooks", "warehouse_exports"} {
				if containsString(contract.DataObjects, blocked) || containsString(contract.EventTopics, blocked) {
					t.Fatalf("%s puller contract should not expose object/topic %q before certification: data=%+v topics=%+v", tc.slug, blocked, contract.DataObjects, contract.EventTopics)
				}
			}

			setup := SetupGuide(item)
			if len(setup) != 3 ||
				!strings.Contains(setup[1].Description, tc.wantPull) ||
				strings.Contains(setup[2].Description, "provider webhooks and scheduled sync runs") {
				t.Fatalf("%s setup guide should describe the concrete profile puller without generic webhook fallback: %+v", tc.slug, setup)
			}
			sync, _ := lifecycleAction(item, "sync")
			token := strings.ReplaceAll(tc.slug, "-", "_")
			if !containsString(sync.RequiredFields, "profiles|empty_"+token+"_provider_pull") ||
				!strings.Contains(sync.Message, tc.wantPull) ||
				strings.Contains(strings.ToLower(sync.Message), "ingest foundation") {
				t.Fatalf("%s sync action should describe concrete analytics provider-puller state: %+v", tc.slug, sync)
			}
			backfill, _ := lifecycleAction(item, "backfill")
			if !containsString(backfill.RequiredFields, "empty_"+token+"_provider_pull") ||
				!strings.Contains(backfill.Message, tc.wantPull) ||
				!strings.Contains(backfill.Message, "analytics provider retry cursors") {
				t.Fatalf("%s backfill action should describe analytics retry/backfill state: %+v", tc.slug, backfill)
			}
			disconnect, _ := lifecycleAction(item, "disconnect")
			if !strings.Contains(disconnect.Message, "provider_cleanup readiness evidence") ||
				!strings.Contains(disconnect.Message, "provider-cleanup/acknowledge") ||
				!strings.Contains(disconnect.Message, "manual sync/backfill rejects disconnected rows") {
				t.Fatalf("%s disconnect action should disclose cleanup evidence and disconnected guards: %+v", tc.slug, disconnect)
			}
		})
	}
}

func TestCRMPullerCatalogItemsExposeLocalRuntimeCompleteUntilProviderCertification(t *testing.T) {
	for _, slug := range []string{"zoho-crm", "microsoft-dynamics-365", "keap"} {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		if item.Badge != BadgeNative || item.RuntimeStatus != RuntimePartial {
			t.Fatalf("%s should be native partial, got badge=%s runtime=%s", slug, item.Badge, item.RuntimeStatus)
		}
		desc := strings.ToLower(item.Summary)
		for _, want := range []string{"local-runtime-complete/live-certification-pending", "scheduled retry", "disconnect-safe writes", "live certification"} {
			if !strings.Contains(desc, want) {
				t.Fatalf("%s summary should mention %q: %q", slug, want, item.Summary)
			}
		}
		contract := runtimeConnectorContractFixture(item)
		if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
			!strings.Contains(contract.PublicClaim, "REST read pulls") ||
			!strings.Contains(contract.PublicClaim, "implemented puller slice") ||
			strings.Contains(contract.PublicClaim, "webhook runtime complete") ||
			containsString(contract.AuthModes, "webhook_secret_ref") ||
			!containsString(contract.Monitoring, "crm_provider_backfill_worker") ||
			!containsString(contract.Monitoring, "provider_cleanup_evidence") ||
			!containsString(contract.ComplianceGates, "crm_webhook_and_extended_object_certification_pending") {
			t.Fatalf("%s contract should expose CRM REST-puller local-runtime-complete/live-certification-pending state without webhook auth claims: %+v", slug, contract)
		}
		for _, blockedTopic := range []string{"webhook", "contact.created", "lead.created", "deal", "opportunity", "tag.add", "order.add", "appointment.add"} {
			if containsString(contract.EventTopics, blockedTopic) {
				t.Fatalf("%s puller contract should not expose provider topic %q before certification: %+v", slug, blockedTopic, contract.EventTopics)
			}
		}
	}
}

func TestCoverageEndpointReportsParityAndPriorityGaps(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/coverage", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res CoverageReport
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if !res.PublicParity || res.PublicEntries < targetPublicEntries || res.PublicGap != 0 {
		t.Fatalf("expected public parity, got %+v", res)
	}
	if res.TargetNativeManaged != targetNativeManaged || res.NativeManaged == 0 || res.NativeManaged < targetNativeManaged {
		t.Fatalf("expected native-managed progress and gap, got %+v", res)
	}
	if res.TargetNativeVerified != targetNativeManaged || res.NativeVerified >= res.TargetNativeVerified || res.NativeVerificationParity {
		t.Fatalf("expected native verification to lag managed foundations, got %+v", res)
	}
	if res.NativePartial == 0 || res.NativeDelegated == 0 {
		t.Fatalf("expected partial and delegated native counts, got %+v", res)
	}
	if res.AvailableRecipes == 0 || res.GeneratedRecipes == 0 || res.BridgeReady == 0 {
		t.Fatalf("expected recipe and bridge coverage, got %+v", res)
	}
	if len(res.Categories) == 0 {
		t.Fatalf("expected category coverage and priority gaps, got %+v", res)
	}
	if !res.NativeParity && len(res.PriorityGaps) == 0 {
		t.Fatalf("expected priority gaps before native parity, got %+v", res)
	}
	if res.MaturityCounts["foundation_hybrid_ready"] == 0 {
		t.Fatalf("expected at least one hybrid-ready category, got %+v", res.MaturityCounts)
	}
}

func TestStacksEndpointReportsCustomerStackCoverage(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/stacks", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res StackReport
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.TargetCoveragePct != targetStackCoveragePercent {
		t.Fatalf("wrong target coverage: %+v", res)
	}
	if res.TotalStacks < 8 || len(res.Stacks) != res.TotalStacks {
		t.Fatalf("expected stack archetypes, got %+v", res)
	}
	if res.CoveredPct >= targetStackCoveragePercent || res.NewsletterCommerceOK {
		t.Fatalf("release-held support providers must prevent a complete stack-coverage claim, got %+v", res)
	}
	if len(res.HighestImpactGaps) == 0 {
		t.Fatalf("expected highest-impact gaps, got %+v", res)
	}
	for _, stack := range res.Stacks {
		if stack.RequiredTotal == 0 || len(stack.Components) == 0 || len(stack.NextActions) == 0 {
			t.Fatalf("incomplete stack coverage row: %+v", stack)
		}
	}
}

func TestReadinessEndpointProtectsPublicParityClaim(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/readiness", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res ReadinessReport
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if !res.Ready {
		t.Fatalf("expected readiness checks to pass, got issues=%+v recommendations=%+v", res.Issues, res.Recommendations)
	}
	if res.MarketablePublicClaim || res.PublicClaim == "" {
		t.Fatalf("expected public claim to wait for native API verification, got %+v", res)
	}
	if !res.PublicParity || !res.NativeParity {
		t.Fatalf("expected parity metrics to pass, got %+v", res)
	}
	if res.NativeVerificationParity || res.NativeVerified >= res.TargetNativeVerified {
		t.Fatalf("expected native API verification to remain incomplete, got %+v", res)
	}
	if res.IssueCounts["severity:blocker"] != 0 {
		t.Fatalf("expected no blockers, got %+v", res.IssueCounts)
	}
	if len(res.Checks) < 4 || len(res.Recommendations) == 0 {
		t.Fatalf("expected checks and recommendations, got %+v", res)
	}
	seenVerificationCheck := false
	for _, check := range res.Checks {
		if check.Key == "native_api_verified_parity" {
			seenVerificationCheck = true
			if check.State != "fail" || check.Severity != "warning" {
				t.Fatalf("expected verification warning check, got %+v", check)
			}
			continue
		}
		if check.State != "pass" {
			t.Fatalf("expected passing readiness check, got %+v", check)
		}
	}
	if !seenVerificationCheck {
		t.Fatalf("missing native API verification check: %+v", res.Checks)
	}
}

func TestDetailIncludesSetupRecipesAndLifecycle(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/typeform", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res detailResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.Item.Slug != "typeform" {
		t.Fatalf("wrong item: %+v", res.Item)
	}
	if len(res.Setup) == 0 {
		t.Fatal("expected setup guide")
	}
	if len(res.Recipes) == 0 {
		t.Fatal("expected bridge recipes")
	}
	if len(res.LifecycleActions) == 0 {
		t.Fatal("expected lifecycle actions")
	}
	if res.Health.State == "" || len(res.Health.Checks) == 0 || len(res.Health.SyncHistory) == 0 {
		t.Fatalf("expected health report, got %+v", res.Health)
	}
	if res.Connection.HealthState == "" {
		t.Fatalf("expected connection health state, got %+v", res.Connection)
	}
	if res.Contract.Slug != "typeform" || res.Contract.PublicClaim == "" {
		t.Fatalf("expected connector contract, got %+v", res.Contract)
	}
}

func TestHealthEndpointIncludesOperationalContract(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/shopify/health", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res HealthReport
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.State == "" || res.RetryPolicy.Mode == "" {
		t.Fatalf("expected state and retry policy, got %+v", res)
	}
	if len(res.Checks) < 4 {
		t.Fatalf("expected health checks, got %+v", res.Checks)
	}
	if len(res.SyncHistory) == 0 {
		t.Fatalf("expected sync history summary, got %+v", res.SyncHistory)
	}
	if len(res.AuditTrail) == 0 {
		t.Fatalf("expected audit trail summary, got %+v", res.AuditTrail)
	}
	if len(res.DataDelete) == 0 {
		t.Fatalf("expected data-delete actions, got %+v", res.DataDelete)
	}
}

func TestCommerceFoundationHealthDoesNotClaimProviderPull(t *testing.T) {
	item := CatalogItem{
		Slug:          "example-commerce-foundation",
		Name:          "Example Commerce Foundation",
		Badge:         BadgeNative,
		RuntimeStatus: RuntimePartial,
		Capabilities:  caps(CapabilityCommerce, CapabilityOrders, CapabilityProducts),
		Sources:       []string{"commerce"},
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "canonical") {
		t.Fatalf("foundation commerce health overclaimed: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check must disclose provider-puller gap: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "canonical customers") {
		t.Fatalf("sync check must require canonical rows: %+v", checks["sync"])
	}
}

func TestWooCommerceHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("woocommerce")
	if !ok {
		t.Fatal("missing woocommerce catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "variation") || !strings.Contains(report.Message, "live WooCommerce") {
		t.Fatalf("woocommerce health must disclose runtime plus live-certification gap: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "X-WC-Webhook-Signature") || !strings.Contains(checks["ownership"].Message, "manual and scheduled retries") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be WooCommerce-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "X-WP-TotalPages") || !strings.Contains(checks["sync"].Message, "Subscriptions") || !strings.Contains(checks["sync"].Message, "woocommerce_retry") {
		t.Fatalf("sync check should describe WooCommerce pull/runtime: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
		t.Fatalf("WooCommerce contract should expose local-complete/live-cert-pending state: %+v", contract)
	}
	if !strings.Contains(contract.RateLimitPolicy, "X-WP-TotalPages") ||
		!strings.Contains(contract.RateLimitPolicy, "manual provider pulls") ||
		!containsString(contract.DataObjects, "refunds") ||
		!containsString(contract.DataObjects, "subscriptions") ||
		!containsString(contract.EventTopics, "subscription.updated") {
		t.Fatalf("contract should expose WooCommerce retry, refund, subscription, and webhook metadata: %+v", contract)
	}
}

func TestWooCommerceLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("woocommerce")
	if !ok {
		t.Fatal("missing woocommerce catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "/wp-json/wc/v3") || !strings.Contains(setup[1].Description, "product variation") {
		t.Fatalf("woocommerce setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_woocommerce_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || !strings.Contains(sync.Message, "woocommerce_retry") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("woocommerce sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_woocommerce_provider_pull") || !strings.Contains(backfill.Message, "X-WP-TotalPages") || !strings.Contains(backfill.Message, "manual/scheduled") {
		t.Fatalf("woocommerce backfill should expose pagination-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "WooCommerce REST API key") || !strings.Contains(disconnect.Message, "force=true") {
		t.Fatalf("woocommerce disconnect should disclose provider cleanup: %+v", disconnect)
	}
}

func TestBigCommerceHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("bigcommerce")
	if !ok {
		t.Fatal("missing bigcommerce catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "variant") || !strings.Contains(report.Message, "live BigCommerce") {
		t.Fatalf("bigcommerce health must disclose runtime plus live-certification gap: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "X-Postwave-Webhook-Secret") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be BigCommerce-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "order products/coupons") {
		t.Fatalf("sync check should describe BigCommerce pull/enrichment runtime: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "BigCommerce", contract)
	if !strings.Contains(contract.RateLimitPolicy, "X-Rate-Limit-Time-Reset-Ms") ||
		!containsString(contract.DataObjects, "transactions") ||
		!containsString(contract.EventTopics, "store/order/refund/created") {
		t.Fatalf("contract should expose BigCommerce retry, transaction, and webhook metadata: %+v", contract)
	}
}

func TestBigCommerceLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("bigcommerce")
	if !ok {
		t.Fatal("missing bigcommerce catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "V3 customer/product") || !strings.Contains(setup[1].Description, "order products/coupons") {
		t.Fatalf("bigcommerce setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_bigcommerce_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("bigcommerce sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_bigcommerce_provider_pull") || !strings.Contains(backfill.Message, "X-Rate-Limit-Time-Reset-Ms") {
		t.Fatalf("bigcommerce backfill should expose rate-limit-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "BigCommerce API account") {
		t.Fatalf("bigcommerce disconnect should disclose provider cleanup: %+v", disconnect)
	}
}

func TestShopifyHealthDisclosesRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("shopify")
	if !ok {
		t.Fatal("missing shopify catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "async Bulk Operation launch/poll/import") || !strings.Contains(report.Message, "live provider verification") {
		t.Fatalf("shopify health must disclose remaining native gaps: %+v", report)
	}
	for _, check := range report.Checks {
		if check.Key == "ownership" && (!strings.Contains(check.Message, "webhook subscription reconciliation") || check.State != "warning") {
			t.Fatalf("shopify ownership check must be precise: %+v", check)
		}
		if check.Key == "ownership" && (!strings.Contains(check.Message, "bulk_operations/finish") || strings.Contains(check.Message, "Bulk Operations remain incomplete")) {
			t.Fatalf("shopify ownership check must claim built async bulk runtime without stale incomplete copy: %+v", check)
		}
		if check.Key == "sync" && (!strings.Contains(check.Message, "mode=bulk_async") || strings.Contains(check.Message, "Bulk Operations remain incomplete")) {
			t.Fatalf("shopify sync check must describe async bulk runtime without stale incomplete copy: %+v", check)
		}
	}
}

func TestHubSpotHealthDisclosesContactPullAndRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("hubspot")
	if !ok {
		t.Fatal("missing hubspot catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "contact REST backfill") || !strings.Contains(report.Message, "configured Lists API membership fanout") || !strings.Contains(report.Message, "native Moosewave list membership adds") || !strings.Contains(report.Message, "deal association event fanout") || !strings.Contains(report.Message, "app-level signed contact webhooks") {
		t.Fatalf("HubSpot health must disclose built contact pull and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "managed refresh-token revocation") || !strings.Contains(checks["ownership"].Message, "/crm/v3/lists") || !strings.Contains(checks["ownership"].Message, "list_membership_map") || !strings.Contains(checks["ownership"].Message, "contact/company associations") {
		t.Fatalf("ownership check must disclose HubSpot boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "/crm/objects/2026-03/contacts") || !strings.Contains(checks["sync"].Message, "/crm/v3/lists") || !strings.Contains(checks["sync"].Message, "list_membership_map") || !strings.Contains(checks["sync"].Message, "sync_deals") || !strings.Contains(checks["sync"].Message, "Signed app webhooks") {
		t.Fatalf("sync check must describe HubSpot contact provider pull and webhook runtime: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "revokes managed OAuth refresh tokens") {
		t.Fatalf("disconnect check must describe HubSpot OAuth cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
		t.Fatalf("HubSpot contract should expose local-complete/live-cert-pending state: %+v", contract)
	}
	if strings.Contains(contract.RateLimitPolicy, "remain implementation work") || !strings.Contains(contract.RateLimitPolicy, "optional operator migration") {
		t.Fatalf("HubSpot rate-limit policy should keep stale local blockers out of the promotion gate: %q", contract.RateLimitPolicy)
	}
}

func TestRechargeHealthDisclosesNativePullAndWebhookBoundary(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("recharge")
	if !ok {
		t.Fatal("missing recharge catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" ||
		!strings.Contains(report.Message, "/subscriptions REST backfill") ||
		!strings.Contains(report.Message, "tokenized subscription/charge webhook ingest") ||
		!strings.Contains(report.Message, "durable delivery claims") ||
		!strings.Contains(report.Message, "persisted operator-managed provider_cleanup readiness evidence") ||
		!strings.Contains(report.Message, "local cleanup acknowledgment") {
		t.Fatalf("Recharge health must disclose native pull/webhook runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "X-Recharge-Hmac-Sha256") || !strings.Contains(checks["sync"].Message, "claim deliveries durably") {
		t.Fatalf("sync check must describe Recharge tokenized webhook ingest: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" ||
		!strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness evidence") ||
		!strings.Contains(checks["disconnect"].Message, "provider-cleanup/acknowledge") ||
		!strings.Contains(checks["disconnect"].Message, "Recharge API-token revocation") {
		t.Fatalf("disconnect check must describe Recharge provider cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Recharge", contract)
	if strings.Contains(contract.RateLimitPolicy, "implementation work") ||
		!strings.Contains(contract.RateLimitPolicy, "operator-managed provider_cleanup") ||
		!strings.Contains(contract.RateLimitPolicy, "local provider-cleanup acknowledgment") {
		t.Fatalf("Recharge contract should expose operator-managed cleanup as current posture: %q", contract.RateLimitPolicy)
	}
}

func TestYotpoHealthDisclosesNativePullAndRemainingGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("yotpo")
	if !ok {
		t.Fatal("missing yotpo catalog item")
	}
	assertLocalCompleteLiveCertPending(t, "Yotpo", runtimeConnectorContractFixture(item))
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "/v1/apps/{app_key}/reviews REST backfill") || !strings.Contains(report.Message, "lookup-only") || !strings.Contains(report.Message, "order-line product fallback") || !strings.Contains(report.Message, "review_create/review_updated") || !strings.Contains(report.Message, "WebhookMessageId") || !strings.Contains(report.Message, "product-refresh handoff metadata") || !strings.Contains(report.Message, "persisted operator-managed provider_cleanup readiness evidence") || !strings.Contains(report.Message, "local cleanup acknowledgment") || !strings.Contains(report.Message, "signed verification") {
		t.Fatalf("Yotpo health must disclose native review pull runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/oauth/token") || !strings.Contains(checks["ownership"].Message, "order-line product fallback") || !strings.Contains(checks["ownership"].Message, "review_create/review_updated") || !strings.Contains(checks["ownership"].Message, "provider_cleanup readiness plus local acknowledgment") || !strings.Contains(checks["ownership"].Message, "live Yotpo brand certification") {
		t.Fatalf("ownership check must describe Yotpo native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "/v1/apps/{app_key}/reviews") || !strings.Contains(checks["sync"].Message, "lookup-only") || !strings.Contains(checks["sync"].Message, "order line items") || !strings.Contains(checks["sync"].Message, "does not create or refresh commerce product rows") || !strings.Contains(checks["sync"].Message, "product_refresh_required") || !strings.Contains(checks["sync"].Message, "yotpo:") || !strings.Contains(checks["sync"].Message, "WebhookMessageId") {
		t.Fatalf("sync check must describe Yotpo review cursor pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness") || !strings.Contains(checks["disconnect"].Message, "review integration settings") || !strings.Contains(checks["disconnect"].Message, "provider-cleanup acknowledgment endpoint") || !strings.Contains(checks["disconnect"].Message, "Yotpo app secret rotation") || !strings.Contains(checks["disconnect"].Message, "operator-managed provider-console") {
		t.Fatalf("disconnect check must describe Yotpo provider cleanup: %+v", checks["disconnect"])
	}
}

func TestSmileHealthDisclosesNativePullAndRemainingGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("smile")
	if !ok {
		t.Fatal("missing smile catalog item")
	}
	assertLocalCompleteLiveCertPending(t, "Smile.io", runtimeConnectorContractFixture(item))
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "/v1/customers REST backfill") || !strings.Contains(report.Message, "incremental event polling") || !strings.Contains(report.Message, "updated_at_min") || !strings.Contains(report.Message, "account-id-routed signed Smile app webhook ingest") || !strings.Contains(report.Message, "persisted operator-managed provider_cleanup readiness") || !strings.Contains(report.Message, "local operator acknowledgment") {
		t.Fatalf("Smile health must disclose native customer/event pull runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "account_id routing") || !strings.Contains(checks["ownership"].Message, "Smile-Signature") || !strings.Contains(checks["ownership"].Message, "loyalty_webhook_events") || !strings.Contains(checks["ownership"].Message, "provider_cleanup readiness plus acknowledgment") || !strings.Contains(checks["ownership"].Message, "live Smile.io store certification") {
		t.Fatalf("ownership check must describe Smile native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "/v1/customers") || !strings.Contains(checks["sync"].Message, "/v1/reward_fulfillments") || !strings.Contains(checks["sync"].Message, "updated_at_min") || !strings.Contains(checks["sync"].Message, "account_id routing") || !strings.Contains(checks["sync"].Message, "Smile-Signature") || !strings.Contains(checks["sync"].Message, "loyalty_webhook_events") {
		t.Fatalf("sync check must describe Smile customer/event cursor pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness") || !strings.Contains(checks["disconnect"].Message, "integration settings") || !strings.Contains(checks["disconnect"].Message, "acknowledgment endpoint records local operator attestation") || !strings.Contains(checks["disconnect"].Message, "Smile.io API-token revocation") {
		t.Fatalf("disconnect check must describe Smile provider cleanup: %+v", checks["disconnect"])
	}
}

func TestZendeskHealthDisclosesNativePullAndRemainingGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("zendesk")
	if !ok {
		t.Fatal("missing zendesk catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Tickets API REST backfill") || !strings.Contains(report.Message, "signed Zendesk webhook ingest") || !strings.Contains(report.Message, "sparse ticket-id callback refresh") || !strings.Contains(report.Message, "best-effort stored-webhook deletion") {
		t.Fatalf("Zendesk health must disclose native pull runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "include=users requester side-loading") || !strings.Contains(checks["ownership"].Message, "/api/v2/tickets/{id}.json") || !strings.Contains(checks["ownership"].Message, "DELETE /api/v2/webhooks/{id}") || !strings.Contains(checks["ownership"].Message, "provider_cleanup evidence") {
		t.Fatalf("ownership check must describe Zendesk native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "/api/v2/tickets.json") || !strings.Contains(checks["sync"].Message, "X-Zendesk-Webhook-Signature") || !strings.Contains(checks["sync"].Message, "sparse ticket-id") {
		t.Fatalf("sync check must describe Zendesk cursor pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup evidence") || !strings.Contains(checks["disconnect"].Message, "support integration settings") || !strings.Contains(checks["disconnect"].Message, "DELETE /api/v2/webhooks/{id}") || !strings.Contains(checks["disconnect"].Message, "Zendesk OAuth/API-token revocation") || !strings.Contains(checks["disconnect"].Message, "operator-managed provider-console") {
		t.Fatalf("disconnect check must describe Zendesk provider cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Zendesk", contract)
}

func TestIntercomHealthDisclosesNativePullAndRemainingGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("intercom")
	if !ok {
		t.Fatal("missing intercom catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Conversations REST backfill") || !strings.Contains(report.Message, "contact lookup fallback") || !strings.Contains(report.Message, "signed app webhook ingest") || !strings.Contains(report.Message, "source plus conversation-part support-message rows") || !strings.Contains(report.Message, "500-part API limit") || !strings.Contains(report.Message, "scheduled intercom_retry") || !strings.Contains(report.Message, "persisted operator-managed provider_cleanup readiness evidence") {
		t.Fatalf("Intercom health must disclose native pull runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/conversations REST backfill") || !strings.Contains(checks["ownership"].Message, "/contacts/{id}") || !strings.Contains(checks["ownership"].Message, "source plus conversation-part support-message rows") || !strings.Contains(checks["ownership"].Message, "500-part API limit") || !strings.Contains(checks["ownership"].Message, "X-Hub-Signature") || !strings.Contains(checks["ownership"].Message, "support_webhook_events") || !strings.Contains(checks["ownership"].Message, "provider_cleanup readiness evidence") {
		t.Fatalf("ownership check must describe Intercom native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "starting_after") || !strings.Contains(checks["sync"].Message, "contact lookup") || !strings.Contains(checks["sync"].Message, "source plus conversation-part support-message rows") || !strings.Contains(checks["sync"].Message, "500-part API limit") || !strings.Contains(checks["sync"].Message, "X-Hub-Signature") || !strings.Contains(checks["sync"].Message, "intercom_retry") {
		t.Fatalf("sync check must describe Intercom cursor pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness") || !strings.Contains(checks["disconnect"].Message, "support integration settings") || !strings.Contains(checks["disconnect"].Message, "Intercom OAuth-token revocation") || !strings.Contains(checks["disconnect"].Message, "operator-managed provider-console") {
		t.Fatalf("disconnect check must describe Intercom provider cleanup: %+v", checks["disconnect"])
	}
}

func TestHelpScoutHealthDisclosesNativePullAndRemainingGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("help-scout")
	if !ok {
		t.Fatal("missing help-scout catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Conversations REST backfill") || !strings.Contains(report.Message, "thread message pulls") || !strings.Contains(report.Message, "signed app webhook ingest") || !strings.Contains(report.Message, "scheduled help_scout_retry") || !strings.Contains(report.Message, "persisted operator-managed provider_cleanup readiness evidence") {
		t.Fatalf("Help Scout health must disclose native pull runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/v2/conversations REST backfill") || !strings.Contains(checks["ownership"].Message, "/v2/conversations/{id}/threads") || !strings.Contains(checks["ownership"].Message, "X-HelpScout-Signature") || !strings.Contains(checks["ownership"].Message, "support_webhook_events") || !strings.Contains(checks["ownership"].Message, "provider_cleanup readiness evidence") {
		t.Fatalf("ownership check must describe Help Scout native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "mailbox-scoped Conversations") || !strings.Contains(checks["sync"].Message, "threads") || !strings.Contains(checks["sync"].Message, "X-HelpScout-Signature") || !strings.Contains(checks["sync"].Message, "help_scout_retry") {
		t.Fatalf("sync check must describe Help Scout cursor pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness") || !strings.Contains(checks["disconnect"].Message, "support integration settings") || !strings.Contains(checks["disconnect"].Message, "Help Scout OAuth app credential rotation") || !strings.Contains(checks["disconnect"].Message, "operator-managed provider-console") {
		t.Fatalf("disconnect check must describe Help Scout provider cleanup: %+v", checks["disconnect"])
	}
	assertLocalCompleteLiveCertPending(t, "Help Scout", runtimeConnectorContractFixture(item))
}

func TestFreshdeskHealthDisclosesNativePullAndRemainingGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("freshdesk")
	if !ok {
		t.Fatal("missing freshdesk catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Tickets REST backfill") || !strings.Contains(report.Message, "include=requester") || !strings.Contains(report.Message, "product_id filtering") || !strings.Contains(report.Message, "authenticated automation-webhook ingest") || !strings.Contains(report.Message, "scheduled freshdesk_retry") || !strings.Contains(report.Message, "persisted operator-managed provider_cleanup readiness evidence") {
		t.Fatalf("Freshdesk health must disclose native pull runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "account_domain normalization") || !strings.Contains(checks["ownership"].Message, "include=requester") || !strings.Contains(checks["ownership"].Message, "product_id") || !strings.Contains(checks["ownership"].Message, "support_webhook_events") || !strings.Contains(checks["ownership"].Message, "provider_cleanup readiness evidence") {
		t.Fatalf("ownership check must describe Freshdesk native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "/api/v2/tickets?include=requester") || !strings.Contains(checks["sync"].Message, "product_id filtering") || !strings.Contains(checks["sync"].Message, "shared secret header") || !strings.Contains(checks["sync"].Message, "freshdesk_retry") {
		t.Fatalf("sync check must describe Freshdesk page pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness") || !strings.Contains(checks["disconnect"].Message, "support integration settings") || !strings.Contains(checks["disconnect"].Message, "Freshdesk API-key rotation") || !strings.Contains(checks["disconnect"].Message, "operator-managed provider-console") {
		t.Fatalf("disconnect check must describe Freshdesk provider cleanup: %+v", checks["disconnect"])
	}
	assertLocalCompleteLiveCertPending(t, "Freshdesk", runtimeConnectorContractFixture(item))
}

func TestLiveChatContractDisclosesLocalCompleteLiveCertificationGate(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("livechat")
	if !ok {
		t.Fatal("missing livechat catalog item")
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "LiveChat", contract)
	if !strings.Contains(contract.RateLimitPolicy, "/v3.6/agent/action/list_archives") ||
		!strings.Contains(contract.RateLimitPolicy, "register_webhook") ||
		!strings.Contains(contract.RateLimitPolicy, "unregisters stored provider webhook IDs") ||
		!strings.Contains(contract.RateLimitPolicy, "support_webhook_events") ||
		!strings.Contains(contract.RateLimitPolicy, "RuntimeAvailable promotion") {
		t.Fatalf("LiveChat contract should describe Archives pull, managed webhook lifecycle, retry, and live-cert gate: %+v", contract)
	}
}

func TestSupportChatContractsDiscloseLocalCompleteLiveCertificationGate(t *testing.T) {
	cases := []struct {
		slug    string
		name    string
		needles []string
	}{
		{
			slug: "front",
			name: "Front",
			needles: []string{
				"/inboxes/{inbox_id}/conversations",
				"X-Front-Signature",
				"front_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "crisp",
			name: "Crisp",
			needles: []string{
				"/v1/website/{website_id}/conversations/{page}",
				"X-Crisp-Signature",
				"crisp_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "drift",
			name: "Drift",
			needles: []string{
				"/conversations/list",
				"X-Verification-Token",
				"drift_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "kustomer",
			name: "Kustomer",
			needles: []string{
				"/v1/conversations",
				"HMAC-SHA256",
				"kustomer_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "freshchat",
			name: "Freshchat",
			needles: []string{
				"/v2/users",
				"X-Freshchat-Signature",
				"freshchat_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "tidio",
			name: "Tidio",
			needles: []string{
				"/tickets",
				"x-tidio-signature",
				"tidio_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "gladly",
			name: "Gladly",
			needles: []string{
				"/api/v1/customer-profiles/{customerId}",
				"Gladly-Limited-Data",
				"gladly_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "intercom",
			name: "Intercom",
			needles: []string{
				"/conversations/{id}",
				"500-part API limit",
				"X-Hub-Signature",
				"intercom_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "groove",
			name: "Groove",
			needles: []string{
				"GET /tickets",
				"/tickets/{ticket_number}/messages",
				"groove_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "reamaze",
			name: "Reamaze",
			needles: []string{
				"/api/v1/conversations/{slug}/messages",
				"Route-token",
				"reamaze_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "jira-service-management",
			name: "Jira Service Management",
			needles: []string{
				"/rest/servicedeskapi/request",
				"jira_service_management_retry",
				"support_webhook_events",
				"OAuth dynamic-webhook JWT",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "linear",
			name: "Linear",
			needles: []string{
				"issues(first, after",
				"Linear-Signature",
				"linear_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "asana-support",
			name: "Asana Support",
			needles: []string{
				"/projects/{project_gid}/tasks",
				"X-Hook-Signature",
				"asana_support_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "clickup-support",
			name: "ClickUp Support",
			needles: []string{
				"/list/{list_id}/task",
				"X-Signature",
				"clickup_support_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "helpcrunch",
			name: "HelpCrunch",
			needles: []string{
				"/chats",
				"X-HelpCrunch-Signature",
				"helpcrunch_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "ada",
			name: "Ada",
			needles: []string{
				"/v2/export/conversations",
				"webhook-signature",
				"ada_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "olark",
			name: "Olark",
			needles: []string{
				"/api/v1/transcripts",
				"route tokens",
				"olark_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "kayako",
			name: "Kayako",
			needles: []string{
				"/api/v1/cases.json?include=requester",
				"route-token",
				"kayako_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "zoho-desk",
			name: "Zoho Desk",
			needles: []string{
				"/api/v1/tickets?include=contacts",
				"X-ZDesk-JWT",
				"zoho_desk_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing %s catalog item", tc.slug)
			}
			contract := runtimeConnectorContractFixture(item)
			assertLocalCompleteLiveCertPending(t, tc.name, contract)
			for _, needle := range tc.needles {
				if !strings.Contains(contract.RateLimitPolicy, needle) {
					t.Fatalf("%s contract missing %q in rate policy: %+v", tc.name, needle, contract)
				}
			}
		})
	}
}

func TestSupportServiceCloudContractsDiscloseLocalCompleteLiveCertificationGate(t *testing.T) {
	cases := []struct {
		slug    string
		name    string
		needles []string
	}{
		{
			slug: "hubspot-service-hub",
			name: "HubSpot Service Hub",
			needles: []string{
				"/crm/v3/objects/tickets",
				"app-level target",
				"hubspot_service_hub_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
		{
			slug: "salesforce-service-cloud",
			name: "Salesforce Service Cloud",
			needles: []string{
				"/services/data/{version}/query",
				"CDC/Pub/Sub relay",
				"salesforce_service_cloud_retry",
				"support_webhook_events",
				"RuntimeAvailable promotion",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing %s catalog item", tc.slug)
			}
			contract := runtimeConnectorContractFixture(item)
			assertLocalCompleteLiveCertPending(t, tc.name, contract)
			for _, needle := range tc.needles {
				if !strings.Contains(contract.RateLimitPolicy, needle) {
					t.Fatalf("%s contract missing %q in rate policy: %+v", tc.name, needle, contract)
				}
			}
		})
	}
}

func TestGorgiasHealthDisclosesNativePullAndLiveCertificationGate(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("gorgias")
	if !ok {
		t.Fatal("missing gorgias catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Tickets API REST backfill") || !strings.Contains(report.Message, "Shopify/Recharge/order evidence") || !strings.Contains(report.Message, "lookup-only commerce order/customer/product UUID resolution") || !strings.Contains(report.Message, "authenticated HTTP integration callbacks") || !strings.Contains(report.Message, "sparse ticket-id callback refresh") || !strings.Contains(report.Message, "best-effort stored HTTP integration deletion") || !strings.Contains(report.Message, "live helpdesk certification") {
		t.Fatalf("Gorgias health must disclose native pull runtime and live-certification gate: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "embedded customer email mapping") || !strings.Contains(checks["ownership"].Message, "Shopify/Recharge/order evidence extraction") || !strings.Contains(checks["ownership"].Message, "lookup-only commerce order/customer/product UUID resolution") || !strings.Contains(checks["ownership"].Message, "/api/tickets/{id}") || !strings.Contains(checks["ownership"].Message, "DELETE /api/integrations/{id}") {
		t.Fatalf("ownership check must describe Gorgias native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "/api/tickets") || !strings.Contains(checks["sync"].Message, "Shopify/Recharge/order evidence") || !strings.Contains(checks["sync"].Message, "lookup-only commerce order/customer/product UUID resolution") || !strings.Contains(checks["sync"].Message, "compatible HMAC") || !strings.Contains(checks["sync"].Message, "sparse ticket-id") {
		t.Fatalf("sync check must describe Gorgias cursor pull and callback auth: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup evidence") || !strings.Contains(checks["disconnect"].Message, "support integration settings") || !strings.Contains(checks["disconnect"].Message, "DELETE /api/integrations/{id}") || !strings.Contains(checks["disconnect"].Message, "Gorgias API-key revocation") || !strings.Contains(checks["disconnect"].Message, "operator-managed provider-console") {
		t.Fatalf("disconnect check must describe Gorgias provider cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Gorgias", contract)
	if strings.Contains(contract.RateLimitPolicy, "true commerce order/customer resolution") || strings.Contains(contract.RateLimitPolicy, "implementation work") {
		t.Fatalf("Gorgias contract should not describe commerce resolution as implementation work anymore: %+v", contract)
	}
}

func TestSnowflakeHealthDisclosesManifestWorkerBoundary(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("snowflake")
	if !ok {
		t.Fatal("missing snowflake catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "provider_driver_attachment=manifest_worker") || !strings.Contains(report.Message, "SnowflakeSQLExecutor") || !strings.Contains(report.Message, "ordered statement plans") || !strings.Contains(report.Message, "local cleanup acknowledgment") || !strings.Contains(report.Message, "live SQL/COPY") {
		t.Fatalf("Snowflake health must disclose manifest-worker runtime and remaining driver gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "account/database/schema/warehouse validation") || !strings.Contains(checks["ownership"].Message, "destination schema DDL/validation previews") || !strings.Contains(checks["ownership"].Message, "ordered statement plans") || !strings.Contains(checks["ownership"].Message, "local executor artifact verification") || !strings.Contains(checks["ownership"].Message, "live account certification") {
		t.Fatalf("ownership check must describe Snowflake native boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "delivery_state=prepared_manifest") || !strings.Contains(checks["sync"].Message, "destination schema DDL/validation previews") || !strings.Contains(checks["sync"].Message, "ordered snowflake_provider_job statement plans") || !strings.Contains(checks["sync"].Message, "snowflake_provider_execution_state") || !strings.Contains(checks["sync"].Message, "loader_state=import_plan_ready") || !strings.Contains(checks["sync"].Message, "waiting_for_provider_driver") {
		t.Fatalf("sync check must describe Snowflake manifest run states: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider-cleanup/acknowledge") || !strings.Contains(checks["disconnect"].Message, "Snowflake users, roles, grants") {
		t.Fatalf("disconnect check must describe Snowflake account-side cleanup: %+v", checks["disconnect"])
	}
}

func TestKlaviyoMigrationSurfaceDisclosesAPIBackedCutoverWithoutNativeClaim(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("klaviyo-migration")
	if !ok {
		t.Fatal("missing klaviyo-migration catalog item")
	}
	if item.Badge != BadgeMigrationOnly || item.Native || item.RuntimeStatus != RuntimeAvailable || item.SetupPath != "/migrations" {
		t.Fatalf("klaviyo must remain migration-only until a managed provider connector lands: %+v", item)
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.NativeManaged || contract.Owner != "postwave_migration" || contract.ImplementationDepth != "migration_adapter" {
		t.Fatalf("klaviyo contract must stay migration adapter, got %+v", contract)
	}
	if !containsString(contract.AuthModes, "api_key") || !containsString(contract.DataObjects, "profile_source_events") || !containsString(contract.EventTopics, "migration.source_event.profile_changed") {
		t.Fatalf("klaviyo contract should expose API-backed migration/source-event scope, got %+v", contract)
	}
	if !strings.Contains(contract.RateLimitPolicy, "revision header") || !strings.Contains(contract.RateLimitPolicy, "Retry-After") {
		t.Fatalf("klaviyo rate policy should describe adapter behavior, got %q", contract.RateLimitPolicy)
	}

	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "migration-to-live source") || !strings.Contains(report.Message, "native-provider Webhooks API live certification") {
		t.Fatalf("klaviyo health must disclose migration-to-live boundary: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "migration adapter") || !strings.Contains(checks["ownership"].Message, "native-provider Webhooks API live certification") {
		t.Fatalf("klaviyo ownership should avoid native-provider claim: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "source-event monitoring") || !strings.Contains(checks["sync"].Message, "filter=greater-than") {
		t.Fatalf("klaviyo sync should describe source-event monitor: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "Klaviyo private API-key revocation") {
		t.Fatalf("klaviyo disconnect should describe provider-side cleanup: %+v", checks["disconnect"])
	}

	actions := LifecycleActions(item)
	for _, want := range []string{"connect/start", "sync", "backfill", "pause", "disconnect"} {
		if !containsString(actions, want) {
			t.Fatalf("klaviyo lifecycle actions missing %q: %+v", want, actions)
		}
	}
	if containsString(actions, "connect/callback") {
		t.Fatalf("klaviyo API-key migration must not advertise OAuth callback: %+v", actions)
	}
	sync, _ := lifecycleAction(item, "sync")
	if sync.DelegatedTo != "POST /api/v1/migrations/sources/klaviyo/source-events" || !strings.Contains(sync.Message, "changed profiles") {
		t.Fatalf("klaviyo sync action should route to source events, got %+v", sync)
	}

	foundRecipe := false
	for _, recipe := range RecipesForItem(item) {
		if recipe.ID == "klaviyo-migration-cutover" {
			foundRecipe = true
			if recipe.Badge != BadgeMigrationOnly || !strings.Contains(recipe.Summary, "migration-to-live") {
				t.Fatalf("bad klaviyo cutover recipe: %+v", recipe)
			}
		}
	}
	if !foundRecipe {
		t.Fatalf("missing klaviyo cutover recipe in %+v", RecipesForItem(item))
	}
}

func TestKlaviyoNativeSurfaceIsSeparateLiveCertificationPendingPartial(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("klaviyo")
	if !ok {
		t.Fatal("missing klaviyo catalog item")
	}
	if item.Badge != BadgeNative || !item.Native || item.RuntimeStatus != RuntimePartial || item.SetupPath != "/integrations" {
		t.Fatalf("klaviyo must be a separate native partial foundation: %+v", item)
	}
	if !containsString(item.Sources, "marketing_integration") {
		t.Fatalf("klaviyo native row should use the marketing integration source, got %+v", item.Sources)
	}
	if !isManagedProviderFamily(item) {
		t.Fatalf("klaviyo native row should participate in managed-provider metadata tracking")
	}
	meta, ok := managedProviderMetadataForItem(item)
	if !ok {
		t.Fatal("klaviyo native row missing marketing managed-provider metadata")
	}
	if meta.Provider != "klaviyo" ||
		meta.Surface != "Marketing integrations" ||
		meta.BasePath != "/api/v1/marketing-integrations" ||
		meta.AuthMode != "klaviyo_private_api_key_ref_or_oauth_public_app" ||
		meta.RuntimeStatus != string(RuntimePartial) ||
		meta.SyncModel != "klaviyo_native_provider_row_json_api_profiles_source_events_signed_webhooks_managed_subscription_scheduled" ||
		meta.ActionPaths["sync"] != "POST /api/v1/marketing-integrations/{id}/sync" ||
		meta.ActionPaths["backfill"] != "POST /api/v1/marketing-integrations/{id}/backfill" ||
		meta.ActionPaths["disconnect"] != "DELETE /api/v1/marketing-integrations/{id}" ||
		meta.ActionPaths["oauth/start"] != "GET /api/v1/marketing-integrations/klaviyo/oauth/start" ||
		!providerHasField(meta.RequiredFields, "credentials_ref") ||
		!containsString(meta.SyncObjects, "profile_source_events") ||
		!containsString(meta.SyncObjects, "system_webhook_events") ||
		!containsString(meta.WebhookTopics, "klaviyo.system_webhook.event") {
		t.Fatalf("klaviyo marketing metadata not aligned with native foundation: %+v", meta)
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || setup[0].Title != "Create the native Klaviyo provider row" || !containsString(setup[0].RequiredFields, "credentials_ref") {
		t.Fatalf("klaviyo bespoke setup guide should be preserved ahead of generic metadata copy: %+v", setup)
	}

	migration, ok := archivedSupportCatalogItemFixture("klaviyo-migration")
	if !ok {
		t.Fatal("missing klaviyo-migration catalog item")
	}
	if migration.Badge != BadgeMigrationOnly || migration.Native || migration.Name == item.Name {
		t.Fatalf("klaviyo migration row must remain distinct and migration-only: native=%+v migration=%+v", item, migration)
	}

	contract := runtimeConnectorContractFixture(item)
	if !contract.NativeManaged || contract.Owner != "postwave" {
		t.Fatalf("klaviyo native contract should stay Moosewave-managed, got %+v", contract)
	}
	assertLocalCompleteLiveCertPending(t, "Klaviyo", contract)
	if !containsString(contract.AuthModes, "klaviyo_private_api_key_ref") || !containsString(contract.AuthModes, "klaviyo_signed_webhook_secret_ref") || !containsString(contract.AuthModes, "klaviyo_oauth_public_app") || !containsString(contract.AuthModes, "klaviyo_managed_oauth_credential_ref") || !containsString(contract.AuthModes, "credentials_ref") {
		t.Fatalf("klaviyo native contract should expose ref auth and managed OAuth, got %+v", contract.AuthModes)
	}
	if !strings.Contains(contract.CredentialStorage, "credential references") || !strings.Contains(contract.CredentialStorage, "marketing_sync_runs") || !strings.Contains(contract.CredentialStorage, "marketing_webhook_events") {
		t.Fatalf("klaviyo credential storage must disclose temporary foundation, got %q", contract.CredentialStorage)
	}
	if !containsString(contract.DataObjects, "profile_source_events") || !containsString(contract.DataObjects, "system_webhook_events") || !containsString(contract.EventTopics, "klaviyo.system_webhook.event") {
		t.Fatalf("klaviyo native contract should expose reusable source-event evidence, got %+v", contract)
	}
	if !containsString(contract.Monitoring, "marketing_sync_runs") || !containsString(contract.Monitoring, "marketing_webhook_events") || !containsString(contract.Monitoring, "writeback_runs") || !containsString(contract.Monitoring, "native_provider_row_lifecycle") || !containsString(contract.Monitoring, "klaviyo_writeback_adapter") || !containsString(contract.ComplianceGates, "managed_webhook_subscription_reconcile_cleanup") || !containsString(contract.ComplianceGates, "klaviyo_writeback_no_create") || !containsString(contract.ComplianceGates, "klaviyo_webhooks_api_live_certification_pending") {
		t.Fatalf("klaviyo native contract should expose readiness gates, got %+v", contract)
	}
	if !strings.Contains(contract.RateLimitPolicy, "marketing_sync_runs") || !strings.Contains(contract.RateLimitPolicy, "revision-pinned") || !strings.Contains(contract.RateLimitPolicy, "timestamped changed-profile source-event IDs") || !strings.Contains(contract.RateLimitPolicy, "Retry-After") {
		t.Fatalf("klaviyo native rate policy should describe adapter behavior, got %q", contract.RateLimitPolicy)
	}

	actions := LifecycleActions(item)
	for _, want := range []string{"connect/start", "oauth/availability", "oauth/start", "oauth/callback", "sync", "backfill", "pause", "disconnect", "provider-cleanup/acknowledge"} {
		if !containsString(actions, want) {
			t.Fatalf("klaviyo native lifecycle actions missing %q: %+v", want, actions)
		}
	}
	connect, _ := lifecycleAction(item, "connect/start")
	if !containsString(connect.RequiredFields, "credentials_ref") || connect.DelegatedTo != "POST /api/v1/marketing-integrations" {
		t.Fatalf("klaviyo connect should require a credential ref and target marketing integrations, got %+v", connect)
	}
	sync, _ := lifecycleAction(item, "sync")
	if sync.DelegatedTo != "POST /api/v1/marketing-integrations/{id}/sync" || !containsString(sync.RequiredFields, "id") || !strings.Contains(sync.Message, "source-event pull") {
		t.Fatalf("klaviyo native sync should route to marketing integrations, got %+v", sync)
	}

	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "provider-row lifecycle") || !strings.Contains(report.Message, "marketing sync run history") || !strings.Contains(report.Message, "scheduled provider-row polling") {
		t.Fatalf("klaviyo native health must disclose partial foundation boundary: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "marketing sync run history") || !strings.Contains(checks["ownership"].Message, "scheduled provider-row polling") {
		t.Fatalf("klaviyo ownership should disclose native provider-row gaps: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "filter=greater-than") || !strings.Contains(checks["sync"].Message, "klaviyo:profile:{id}:{updated}") || !strings.Contains(checks["sync"].Message, "marketing_webhook_events") || !strings.Contains(checks["sync"].Message, "Webhooks API") || !strings.Contains(checks["sync"].Message, "integration-writeback") || !strings.Contains(checks["sync"].Message, "no-create") {
		t.Fatalf("klaviyo sync should describe source-event polling and signed-webhook boundary: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider-cleanup/acknowledge") || !strings.Contains(checks["disconnect"].Message, "provider-side writeback cleanup") {
		t.Fatalf("klaviyo disconnect should describe provider-side cleanup gaps: %+v", checks["disconnect"])
	}
	if retryPolicyFor(item).Mode != "klaviyo_native_json_api_provider_row_scheduled_signed_webhooks_managed_subscription" || !strings.Contains(retryPolicyFor(item).Idempotency, "marketing_sync_runs") || !strings.Contains(retryPolicyFor(item).Idempotency, "Klaviyo-Webhook-Id") || !strings.Contains(retryPolicyFor(item).Idempotency, "klaviyo:profile:{id}:{updated}") || !strings.Contains(retryPolicyFor(item).Idempotency, "klaviyo_webhook_id") {
		t.Fatalf("klaviyo native retry policy should be specific, got %+v", retryPolicyFor(item))
	}

	foundRecipe := false
	for _, recipe := range RecipesForItem(item) {
		if recipe.ID == "klaviyo-native-foundation" {
			foundRecipe = true
			if recipe.Badge != BadgeNative || !strings.Contains(recipe.Summary, "marketing_sync_runs") {
				t.Fatalf("bad klaviyo native recipe: %+v", recipe)
			}
		}
	}
	if !foundRecipe {
		t.Fatalf("missing klaviyo native foundation recipe in %+v", RecipesForItem(item))
	}
}

func TestMarketingProviderBatchNativeFoundationsAreSeparateFromMigrations(t *testing.T) {
	cases := map[string]struct {
		authMode        string
		syncObject      string
		migrationObject string
	}{
		"mailchimp":        {authMode: "mailchimp_oauth_or_api_key_ref", syncObject: "source_archive_rebuild_tasks", migrationObject: "templates"},
		"activecampaign":   {authMode: "activecampaign_api_token_ref", syncObject: "automation_rebuild_tasks", migrationObject: "automation_rebuild_tasks"},
		"customerio":       {authMode: "customerio_app_api_key_ref", syncObject: "sent_email_newsletter_archive", migrationObject: "sent_email_newsletter_archive"},
		"brevo":            {authMode: "brevo_api_key_ref", syncObject: "campaigns", migrationObject: "campaigns"},
		"convertkit":       {authMode: "convertkit_oauth_or_api_secret_ref", syncObject: "paid_subscriptions_stripe_connect", migrationObject: "broadcasts"},
		"substack":         {authMode: "substack_export_bundle_ref", syncObject: "migration_parity_evidence", migrationObject: "posts"},
		"beehiiv":          {authMode: "beehiiv_api_key_ref", syncObject: "premium_membership_metadata", migrationObject: "automation_rebuild_tasks"},
		"mailerlite":       {authMode: "mailerlite_api_key_ref", syncObject: "groups", migrationObject: "automations"},
		"sendy":            {authMode: "sendy_csv_export_ref", syncObject: "csv_export", migrationObject: "csv_export"},
		"constant-contact": {authMode: "constant_contact_csv_export_ref", syncObject: "csv_export", migrationObject: "contacts"},
		"aweber":           {authMode: "aweber_csv_export_ref", syncObject: "csv_export", migrationObject: "subscribers"},
		"drip":             {authMode: "drip_csv_export_ref", syncObject: "csv_export", migrationObject: "people"},
		"campaign-monitor": {authMode: "campaign_monitor_csv_export_ref", syncObject: "csv_export", migrationObject: "subscribers"},
		"omnisend":         {authMode: "omnisend_csv_export_ref", syncObject: "csv_export", migrationObject: "contacts"},
		"loops":            {authMode: "loops_csv_export_ref", syncObject: "csv_export", migrationObject: "contacts"},
	}
	for slug, tc := range cases {
		t.Run(slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(slug)
			if !ok {
				t.Fatalf("missing native catalog item %q", slug)
			}
			if item.Badge != BadgeNative || !item.Native || item.RuntimeStatus != RuntimePartial || item.Category != "marketing" || !containsString(item.Sources, "marketing_integration") {
				t.Fatalf("%s should be a native partial marketing row, got %+v", slug, item)
			}
			migration, ok := archivedSupportCatalogItemFixture(slug + "-migration")
			if !ok {
				t.Fatalf("missing migration catalog item %q", slug+"-migration")
			}
			if migration.Badge != BadgeMigrationOnly || migration.Native || !containsString(migration.Sources, "migration") {
				t.Fatalf("%s migration row should remain migration-only, got %+v", slug, migration)
			}

			meta, ok := managedProviderMetadataForItem(item)
			if !ok {
				t.Fatalf("%s missing marketing provider metadata", slug)
			}
			if meta.Provider != slug || meta.Surface != "Marketing integrations" || meta.BasePath != "/api/v1/marketing-integrations" || meta.AuthMode != tc.authMode {
				t.Fatalf("%s metadata mismatch: %+v", slug, meta)
			}
			if !providerHasField(meta.RequiredFields, "credentials_ref") || !containsString(meta.SyncObjects, tc.syncObject) {
				t.Fatalf("%s metadata missing expected fields/objects: %+v", slug, meta)
			}

			actions := LifecycleActions(item)
			for _, want := range []string{"connect/start", "sync", "backfill", "pause", "disconnect"} {
				if !containsString(actions, want) {
					t.Fatalf("%s lifecycle actions missing %q: %+v", slug, want, actions)
				}
			}
			if containsString(actions, "connect/callback") {
				t.Fatalf("%s native foundation should not advertise OAuth callback before certification: %+v", slug, actions)
			}
			connect, _ := lifecycleAction(item, "connect/start")
			if connect.DelegatedTo != "POST /api/v1/marketing-integrations" || !containsString(connect.RequiredFields, "credentials_ref") || !strings.Contains(connect.Message, "provider row") {
				t.Fatalf("%s connect action mismatch: %+v", slug, connect)
			}
			sync, _ := lifecycleAction(item, "sync")
			if sync.DelegatedTo != "POST /api/v1/marketing-integrations/{id}/sync" || !strings.Contains(sync.Message, slug+"_handoff") {
				t.Fatalf("%s sync action mismatch: %+v", slug, sync)
			}

			contract := runtimeConnectorContractFixture(item)
			if !contract.NativeManaged || contract.Owner != "postwave" || contract.ImplementationDepth != "native_foundation" || !containsString(contract.AuthModes, tc.authMode) {
				t.Fatalf("%s contract mismatch: %+v", slug, contract)
			}
			if !strings.Contains(contract.CredentialStorage, "marketing_sync_runs") || !containsString(contract.Monitoring, "marketing_sync_runs") || !containsString(contract.ComplianceGates, "credential_ref_required") {
				t.Fatalf("%s contract should describe provider-row foundation: %+v", slug, contract)
			}
			if !containsString(contract.DataObjects, tc.syncObject) {
				t.Fatalf("%s contract data objects missing %q: %+v", slug, tc.syncObject, contract.DataObjects)
			}
			migrationContract := runtimeConnectorContractFixture(migration)
			if migrationContract.NativeManaged || migrationContract.Owner != "postwave_migration" || !containsString(migrationContract.DataObjects, tc.migrationObject) {
				t.Fatalf("%s migration contract should stay migration-only: %+v", slug, migrationContract)
			}
			if slug == "activecampaign" {
				if containsString(contract.DataObjects, "automations") || containsString(migrationContract.DataObjects, "automations") {
					t.Fatalf("activecampaign should advertise automation rebuild tasks, not runtime automations: native=%+v migration=%+v", contract.DataObjects, migrationContract.DataObjects)
				}
				if !strings.Contains(migration.Summary, "automation rebuild evidence") {
					t.Fatalf("activecampaign migration summary should describe rebuild evidence: %q", migration.Summary)
				}
			}

			report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
			if report.State != "needs_attention" || !strings.Contains(report.Message, slug+"_handoff") || !strings.Contains(report.RetryPolicy.Idempotency, slug+"_handoff") {
				t.Fatalf("%s health should disclose provider-row boundary: %+v", slug, report)
			}
		})
	}
}

func TestBeehiivCatalogDisclosesMigrationBoundaries(t *testing.T) {
	native, ok := archivedSupportCatalogItemFixture("beehiiv")
	if !ok {
		t.Fatal("missing beehiiv native catalog item")
	}
	migration, ok := archivedSupportCatalogItemFixture("beehiiv-migration")
	if !ok {
		t.Fatal("missing beehiiv migration catalog item")
	}

	for _, item := range []CatalogItem{native, migration} {
		if hasCapability(item, CapabilityAutomationTriggers) {
			t.Fatalf("%s must not advertise executable automation triggers: %+v", item.Slug, item.Capabilities)
		}
		summary := strings.ToLower(item.Summary)
		for _, want := range []string{"rebuild-only automation", "premium-membership metadata", "explicit publication id", "stripe billing objects"} {
			if !strings.Contains(summary, want) {
				t.Fatalf("%s summary must disclose %q: %q", item.Slug, want, item.Summary)
			}
		}
		if strings.Contains(summary, "stripe connect") || strings.Contains(summary, "paid-subscription evidence") {
			t.Fatalf("%s summary must not claim a Stripe/paid-subscription import: %q", item.Slug, item.Summary)
		}
	}

	meta, ok := managedProviderMetadataForItem(native)
	if !ok {
		t.Fatal("missing beehiiv managed-provider metadata")
	}
	if providerHasField(meta.OptionalFields, "stripe_account_id") {
		t.Fatalf("beehiiv must not expose an unsupported Stripe field: %+v", meta.OptionalFields)
	}
	for _, want := range []string{"newsletter_lists:read", "custom_fields:read"} {
		if !containsString(meta.Scopes, want) {
			t.Fatalf("beehiiv metadata missing required source scope %q: %+v", want, meta.Scopes)
		}
	}
	nativeContract := runtimeConnectorContractFixture(native)
	migrationContract := runtimeConnectorContractFixture(migration)
	for _, want := range []string{"newsletter_list_subscription_history", "segment_membership_snapshots", "custom_field_definitions", "automation_rebuild_tasks", "campaign_archive", "premium_membership_metadata"} {
		if !containsString(nativeContract.DataObjects, want) || !containsString(migrationContract.DataObjects, want) {
			t.Fatalf("beehiiv contracts must include %q: native=%+v migration=%+v", want, nativeContract.DataObjects, migrationContract.DataObjects)
		}
	}
	for _, forbidden := range []string{"automations", "paid_subscriptions", "paid_subscriptions_stripe_connect"} {
		if containsString(nativeContract.DataObjects, forbidden) || containsString(migrationContract.DataObjects, forbidden) {
			t.Fatalf("beehiiv contracts must not claim %q: native=%+v migration=%+v", forbidden, nativeContract.DataObjects, migrationContract.DataObjects)
		}
	}
	if containsString(migrationContract.EventTopics, "automation.triggered") {
		t.Fatalf("beehiiv migration contract must not advertise executable automation events: %+v", migrationContract.EventTopics)
	}
}

func TestCustomerIOCatalogDisclosesRebuildOnlyWorkflowBoundaries(t *testing.T) {
	native, ok := archivedSupportCatalogItemFixture("customerio")
	if !ok {
		t.Fatal("missing Customer.io native catalog item")
	}
	migration, ok := archivedSupportCatalogItemFixture("customerio-migration")
	if !ok {
		t.Fatal("missing Customer.io migration catalog item")
	}

	for _, item := range []CatalogItem{native, migration} {
		if hasCapability(item, CapabilityAutomationTriggers) {
			t.Fatalf("%s must not advertise executable automation triggers: %+v", item.Slug, item.Capabilities)
		}
		summary := strings.ToLower(item.Summary)
		if !strings.Contains(summary, "rebuild") {
			t.Fatalf("%s must disclose rebuild-only workflow handling: %q", item.Slug, item.Summary)
		}
	}
	for _, required := range []string{
		`at least one explicit language="" default`,
		"lowest stable content ID represents a multi-default/A-B set",
		"translations are never silently selected",
		"neither newsletter nor Design Studio HTML is provider-rendered output",
	} {
		if !strings.Contains(migration.Summary, required) {
			t.Fatalf("Customer.io migration summary must disclose newsletter/template fidelity %q: %q", required, migration.Summary)
		}
	}

	nativeContract := runtimeConnectorContractFixture(native)
	migrationContract := runtimeConnectorContractFixture(migration)
	for _, contract := range []ConnectorContract{nativeContract, migrationContract} {
		if containsString(contract.EventTopics, "automation.triggered") || containsString(contract.DataObjects, "automation_triggers") {
			t.Fatalf("Customer.io contract must not advertise executable automation behavior: %+v", contract)
		}
	}
	if !containsString(nativeContract.DataObjects, "subscription_channels") {
		t.Fatalf("Customer.io native contract must expose subscription-channel definitions separately: %+v", nativeContract.DataObjects)
	}
	if !containsString(migrationContract.DataObjects, "subscription_channels") {
		t.Fatalf("Customer.io migration contract must expose subscription-channel definitions separately: %+v", migrationContract.DataObjects)
	}
}

func TestSalesforceHealthDisclosesSOQLRuntimeAndLiveCertificationGate(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("salesforce")
	if !ok {
		t.Fatal("missing salesforce catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "native runtime is locally complete") || !strings.Contains(report.Message, "SOQL Contact and Lead backfill") || !strings.Contains(report.Message, "CampaignMember event fanout") || !strings.Contains(report.Message, "native Moosewave list membership adds") || !strings.Contains(report.Message, "removal-signal native list cleanup") || !strings.Contains(report.Message, "complete-scan stale repair") || !strings.Contains(report.Message, "Task activity fanout") || !strings.Contains(report.Message, "reactive INVALID_SESSION_ID refresh") || !strings.Contains(report.Message, "live Salesforce org certification remains") {
		t.Fatalf("Salesforce health must disclose local-complete SOQL runtime and live-certification gate: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/services/data/v67.0/query") || !strings.Contains(checks["ownership"].Message, "salesforce_retry") || !strings.Contains(checks["ownership"].Message, "refresh-token revocation") || !strings.Contains(checks["ownership"].Message, "reactive INVALID_SESSION_ID refresh") || !strings.Contains(checks["ownership"].Message, "CampaignMember CRM event fanout") || !strings.Contains(checks["ownership"].Message, "soft-removes") || !strings.Contains(checks["ownership"].Message, "complete-scan stale repair") || !strings.Contains(checks["ownership"].Message, "campaign_membership_map") || !strings.Contains(checks["ownership"].Message, "Task CRM activity fanout") {
		t.Fatalf("ownership check must disclose Salesforce boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "nextRecordsUrl") || !strings.Contains(checks["sync"].Message, "campaign_membership_map") || !strings.Contains(checks["sync"].Message, "soft-removes") || !strings.Contains(checks["sync"].Message, "complete-scan stale repair") || !strings.Contains(checks["sync"].Message, "salesforce_retry") || !strings.Contains(checks["sync"].Message, "Live Salesforce certification remains") {
		t.Fatalf("sync check must describe Salesforce SOQL provider pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "managed OAuth refresh tokens") || !strings.Contains(checks["disconnect"].Message, "local managed OAuth credential") {
		t.Fatalf("disconnect check must describe Salesforce managed credential cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "local connected-app OAuth, SOQL sync, monitoring, retry, and lifecycle runtime complete") {
		t.Fatalf("Salesforce contract should expose local-complete/live-cert-pending state: %+v", contract)
	}
	if !strings.Contains(contract.RateLimitPolicy, "reactively after INVALID_SESSION_ID") || !strings.Contains(contract.RateLimitPolicy, "future streaming enhancement") {
		t.Fatalf("Salesforce contract should disclose reactive refresh and future CDC boundary: %q", contract.RateLimitPolicy)
	}
}

func TestPipedriveHealthDisclosesNativeCRMRuntimeAndRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("pipedrive")
	if !ok {
		t.Fatal("missing pipedrive catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "/api/v2/persons") || !strings.Contains(report.Message, "/api/v2/deals") || !strings.Contains(report.Message, "/api/v2/organizations") || !strings.Contains(report.Message, "/api/v2/activities") || !strings.Contains(report.Message, "managed person/deal/organization/activity webhooks") || !strings.Contains(report.Message, "scheduled retry cursors") {
		t.Fatalf("Pipedrive health must disclose built CRM runtime and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/api/v2/deals") || !strings.Contains(checks["ownership"].Message, "Basic Auth verification") {
		t.Fatalf("ownership check must disclose Pipedrive boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "deal event mapping") || !strings.Contains(checks["sync"].Message, "organization enrichment") || !strings.Contains(checks["sync"].Message, "activity event mapping") || !strings.Contains(checks["sync"].Message, "pipedrive_retry") {
		t.Fatalf("sync check must describe Pipedrive provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
		t.Fatalf("Pipedrive contract should expose local-complete/live-cert-pending state: %+v", contract)
	}
}

func TestCloseHealthDisclosesSignedWebhookRuntimeAndLiveCertificationGate(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("close")
	if !ok {
		t.Fatal("missing close catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "/api/v1/contact/") || !strings.Contains(report.Message, "route-token signed webhook ingest") || !strings.Contains(report.Message, "contact hydration") || !strings.Contains(report.Message, "live Close workspace certification remains") {
		t.Fatalf("Close health must disclose signed webhook runtime and live-certification gate: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "close-sig-hash") || !strings.Contains(checks["ownership"].Message, "crm_webhook_events") && !strings.Contains(checks["ownership"].Message, "webhook idempotency") {
		t.Fatalf("ownership check must disclose Close signed webhook boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "close_retry") || !strings.Contains(checks["sync"].Message, "/api/v1/contact/{id}") {
		t.Fatalf("sync check must describe Close REST/webhook provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.RateLimitPolicy, "close-sig-timestamp") || !containsString(contract.AuthModes, "webhook_route_token") {
		t.Fatalf("Close contract should expose local-complete/live-cert-pending state: %+v", contract)
	}
}

func TestZohoCRMHealthDisclosesV8PullAndRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("zoho-crm")
	if !ok {
		t.Fatal("missing zoho-crm catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "/crm/v8") || !strings.Contains(report.Message, "Notification API") {
		t.Fatalf("Zoho health must disclose built V8 pull and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "Contacts and Leads") || !strings.Contains(checks["ownership"].Message, "Accounts/Deals") {
		t.Fatalf("ownership check must disclose Zoho boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "page_token") {
		t.Fatalf("sync check must describe Zoho V8 provider pull: %+v", checks["sync"])
	}
}

func TestDynamics365HealthDisclosesDataversePullAndRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("microsoft-dynamics-365")
	if !ok {
		t.Fatal("missing microsoft-dynamics-365 catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "/api/data/v9.2") || !strings.Contains(report.Message, "change tracking") {
		t.Fatalf("Dynamics health must disclose built Dataverse pull and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "Contacts and Leads") || !strings.Contains(checks["ownership"].Message, "Accounts/Opportunities") {
		t.Fatalf("ownership check must disclose Dynamics boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "@odata.nextLink") {
		t.Fatalf("sync check must describe Dataverse provider pull: %+v", checks["sync"])
	}
}

func TestKeapHealthDisclosesRESTV2PullAndRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("keap")
	if !ok {
		t.Fatal("missing keap catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "REST v2 Contacts") || !strings.Contains(report.Message, "campaign") {
		t.Fatalf("Keap health must disclose built REST v2 pull and remaining gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/rest/v2/contacts") || !strings.Contains(checks["ownership"].Message, "tag/campaign") {
		t.Fatalf("ownership check must disclose Keap boundary: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "page_token") {
		t.Fatalf("sync check must describe Keap REST v2 provider pull: %+v", checks["sync"])
	}
}

func TestTypeformHealthDisclosesRemainingNativeGaps(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("typeform")
	if !ok {
		t.Fatal("missing typeform catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "managed webhook tag upsert/delete") || !strings.Contains(report.Message, "live Typeform") {
		t.Fatalf("typeform health must disclose remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/forms/{form_id}/webhooks/{tag}") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check must describe Typeform native runtime and gap: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "after-cursor") || !strings.Contains(checks["sync"].Message, "form_response_partial") {
		t.Fatalf("sync check must describe Typeform pull/webhook runtime: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "/forms/{form_id}/webhooks/{tag}") {
		t.Fatalf("disconnect check should describe managed Typeform webhook cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Typeform", contract)
}

func TestTypeformLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("typeform")
	if !ok {
		t.Fatal("missing typeform catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "/forms/{form_id}/responses") || !strings.Contains(setup[1].Description, "after-cursor") {
		t.Fatalf("typeform setup should describe native Responses API provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_typeform_provider_pull") || !strings.Contains(sync.Message, "Responses API provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("typeform sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_typeform_provider_pull") || !strings.Contains(backfill.Message, "typeform_retry") {
		t.Fatalf("typeform backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "/forms/{form_id}/webhooks/{tag}") || !strings.Contains(disconnect.Message, "externally managed OAuth access-token") {
		t.Fatalf("typeform disconnect should disclose provider cleanup: %+v", disconnect)
	}
}

func TestFilloutHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("fillout")
	if !ok {
		t.Fatal("missing fillout catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "URL-token") || !strings.Contains(report.Message, "live Fillout") {
		t.Fatalf("fillout health must disclose runtime plus live-certification gap: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/webhook/create") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Fillout-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "limit/offset") || !strings.Contains(checks["sync"].Message, "URL-token") {
		t.Fatalf("sync check should describe Fillout REST/webhook runtime: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "/webhook/delete") {
		t.Fatalf("disconnect check should describe managed Fillout webhook cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	if !strings.Contains(contract.RateLimitPolicy, "5 requests/second") ||
		!containsString(contract.AuthModes, "webhook_secret_ref") ||
		!containsString(contract.DataObjects, "submissions") ||
		!containsString(contract.EventTopics, "submission.created") {
		t.Fatalf("contract should expose Fillout retry, auth, data, and webhook metadata: %+v", contract)
	}
	assertLocalCompleteLiveCertPending(t, "Fillout", contract)
}

func TestFilloutLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("fillout")
	if !ok {
		t.Fatal("missing fillout catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "form metadata") || !strings.Contains(setup[1].Description, "limit/offset") {
		t.Fatalf("fillout setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_fillout_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("fillout sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_fillout_provider_pull") || !strings.Contains(backfill.Message, "fillout_retry") {
		t.Fatalf("fillout backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "/webhook/delete") || !strings.Contains(disconnect.Message, "Fillout API-key") {
		t.Fatalf("fillout disconnect should disclose provider cleanup: %+v", disconnect)
	}
}

func TestJotformHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("jotform")
	if !ok {
		t.Fatal("missing jotform catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "APIKEY") || !strings.Contains(report.Message, "live Jotform") {
		t.Fatalf("jotform health must disclose runtime plus live-certification gap: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/form/{formID}/webhooks") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Jotform-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "offset/limit") || !strings.Contains(checks["sync"].Message, "multipart") {
		t.Fatalf("sync check should describe Jotform REST/webhook runtime: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "/form/{formID}/webhooks/{webhookID}") {
		t.Fatalf("disconnect check should describe managed Jotform webhook cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	if !strings.Contains(contract.RateLimitPolicy, "plan-based daily API call limits") ||
		!containsString(contract.AuthModes, "webhook_secret_ref") ||
		!containsString(contract.DataObjects, "questions") ||
		!containsString(contract.DataObjects, "submissions") ||
		!containsString(contract.EventTopics, "submission.created") {
		t.Fatalf("contract should expose Jotform retry, auth, data, and webhook metadata: %+v", contract)
	}
	assertLocalCompleteLiveCertPending(t, "Jotform", contract)
}

func TestJotformLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("jotform")
	if !ok {
		t.Fatal("missing jotform catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "/form/{formID}/questions") || !strings.Contains(setup[1].Description, "offset/limit") {
		t.Fatalf("jotform setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_jotform_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("jotform sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_jotform_provider_pull") || !strings.Contains(backfill.Message, "jotform_retry") {
		t.Fatalf("jotform backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "/form/{formID}/webhooks/{webhookID}") || !strings.Contains(disconnect.Message, "Jotform API-key") {
		t.Fatalf("jotform disconnect should disclose provider cleanup: %+v", disconnect)
	}
}

func TestWebflowHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("webflow")
	if !ok {
		t.Fatal("missing webflow catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Data API v2") || !strings.Contains(report.Message, "live Webflow") {
		t.Fatalf("webflow health must disclose runtime plus live-certification gap: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "/v2/sites/{site_id}/webhooks") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Webflow-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "elementId") || !strings.Contains(checks["sync"].Message, "form_submission") {
		t.Fatalf("sync check should describe Webflow Data API/webhook runtime: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "/v2/webhooks/{webhook_id}") {
		t.Fatalf("disconnect check should describe managed Webflow webhook cleanup: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Webflow", contract)
	if !strings.Contains(contract.RateLimitPolicy, "max page size 100") ||
		!containsString(contract.AuthModes, "webhook_secret_ref") ||
		!containsString(contract.DataObjects, "submissions") ||
		!containsString(contract.EventTopics, "form_submission") {
		t.Fatalf("contract should expose Webflow retry, auth, data, and webhook metadata: %+v", contract)
	}
}

func TestWebflowLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("webflow")
	if !ok {
		t.Fatal("missing webflow catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "/v2/sites/{site_id}/form_submissions") || !strings.Contains(setup[1].Description, "elementId") {
		t.Fatalf("webflow setup should describe native Data API provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_webflow_provider_pull") || !strings.Contains(sync.Message, "Data API provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("webflow sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_webflow_provider_pull") || !strings.Contains(backfill.Message, "webflow_retry") {
		t.Fatalf("webflow backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "/v2/webhooks/{webhook_id}") || !strings.Contains(disconnect.Message, "Webflow OAuth") {
		t.Fatalf("webflow disconnect should disclose provider cleanup: %+v", disconnect)
	}
}

func TestWixHealthDisclosesBuiltRuntimeAndLiveCertificationGap(t *testing.T) {
	cases := []struct {
		slug        string
		message     string
		ownership   string
		sync        string
		ratePolicy  string
		dataObjects []string
		eventTopics []string
	}{
		{
			slug:        "wix-stores",
			message:     "Contacts/Catalog/Orders backfill",
			ownership:   "signed JWT app webhooks",
			sync:        "Catalog V1/V3",
			ratePolicy:  "Retry-After",
			dataObjects: []string{"orders", "products", "subscriptions", "tickets"},
			eventTopics: []string{"wix.ecom.v1.order.canceled", "wix.stores.catalog.v3.product.deleted", "wix.contacts.v4.contact.deleted"},
		},
		{
			slug:        "wix",
			message:     "Wix Forms and Contacts native runtime",
			ownership:   "signed JWT app webhooks",
			sync:        "Forms submissions and Contacts",
			ratePolicy:  "Retry-After",
			dataObjects: []string{"contacts", "forms", "submissions"},
			eventTopics: []string{"wix.forms.v4.submission.created", "wix.contacts.v4.contact.updated", "wix.contacts.v4.contact.deleted"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing catalog item %q", tc.slug)
			}
			report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
			if report.State != "needs_attention" || !strings.Contains(report.Message, tc.message) || !strings.Contains(report.Message, "live Wix") {
				t.Fatalf("%s health must disclose runtime plus live-certification gap: %+v", tc.slug, report)
			}
			checks := map[string]HealthCheck{}
			for _, check := range report.Checks {
				checks[check.Key] = check
			}
			if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, tc.ownership) || strings.Contains(checks["ownership"].Message, "provider pullers") {
				t.Fatalf("%s ownership check should be Wix-specific: %+v", tc.slug, checks["ownership"])
			}
			if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, tc.sync) {
				t.Fatalf("%s sync check should be Wix-specific: %+v", tc.slug, checks["sync"])
			}
			contract := runtimeConnectorContractFixture(item)
			if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
				t.Fatalf("%s contract should expose Wix local-complete/live-cert-pending state: %+v", tc.slug, contract)
			}
			if !strings.Contains(contract.RateLimitPolicy, tc.ratePolicy) {
				t.Fatalf("%s rate-limit policy should mention Wix retry behavior: %q", tc.slug, contract.RateLimitPolicy)
			}
			if !containsString(contract.PrivacyActions, "wix_app_uninstall_lifecycle") {
				t.Fatalf("%s contract missing Wix uninstall lifecycle privacy action: %+v", tc.slug, contract.PrivacyActions)
			}
			for _, object := range tc.dataObjects {
				if !containsString(contract.DataObjects, object) {
					t.Fatalf("%s contract data objects missing %q in %+v", tc.slug, object, contract.DataObjects)
				}
			}
			for _, topic := range tc.eventTopics {
				if !containsString(contract.EventTopics, topic) {
					t.Fatalf("%s contract event topics missing %q in %+v", tc.slug, topic, contract.EventTopics)
				}
			}
			deleteActions := dataDeleteFor(item)
			if !dataDeleteActionsContain(deleteActions, "Wix app dashboard uninstall") {
				t.Fatalf("%s data-delete actions should expose Wix provider uninstall: %+v", tc.slug, deleteActions)
			}
		})
	}
}

func TestWixLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	stores, ok := archivedSupportCatalogItemFixture("wix-stores")
	if !ok {
		t.Fatal("missing wix-stores catalog item")
	}
	setup := SetupGuide(stores)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "Catalog V1/V3") {
		t.Fatalf("wix stores setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(stores, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_wix_provider_pull") || !strings.Contains(sync.Message, "app-instance REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("wix stores sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(stores, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_wix_provider_pull") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("wix stores backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(stores, "disconnect")
	if !strings.Contains(disconnect.Message, "Wix app/dashboard webhook subscriptions") {
		t.Fatalf("wix stores disconnect should disclose provider-console cleanup: %+v", disconnect)
	}

	lead, ok := archivedSupportCatalogItemFixture("wix")
	if !ok {
		t.Fatal("missing wix catalog item")
	}
	leadSetup := SetupGuide(lead)
	if len(leadSetup) != 3 || !strings.Contains(leadSetup[1].Description, "cursor checkpoints") {
		t.Fatalf("wix lead setup should describe native REST provider pull: %+v", leadSetup)
	}
	leadSync, _ := lifecycleAction(lead, "sync")
	if !strings.Contains(leadSync.Message, "Wix Forms and Contacts provider pull") {
		t.Fatalf("wix lead sync should expose native provider pull: %+v", leadSync)
	}
	leadContract := runtimeConnectorContractFixture(lead)
	if !containsString(leadContract.AuthModes, "oauth_app_instance_ref") {
		t.Fatalf("wix lead contract should expose app-instance auth: %+v", leadContract.AuthModes)
	}
}

func TestAdobeCommerceHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("adobe-commerce")
	if !ok {
		t.Fatal("missing adobe-commerce catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "credit memos") || !strings.Contains(report.Message, "live Adobe Commerce") {
		t.Fatalf("adobe commerce health must disclose runtime plus remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "Store-header") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Adobe-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "searchCriteria") {
		t.Fatalf("sync check should describe Adobe Commerce provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Adobe Commerce", contract)
	if !strings.Contains(contract.RateLimitPolicy, "Credit Memos") ||
		!strings.Contains(contract.RateLimitPolicy, "provider_cleanup readiness evidence") ||
		!containsString(contract.DataObjects, "creditmemos") ||
		!containsString(contract.EventTopics, "sales_order_creditmemo_refund") {
		t.Fatalf("contract should expose Adobe retry, credit memo, and webhook metadata: %+v", contract)
	}
}

func TestAdobeCommerceLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("adobe-commerce")
	if !ok {
		t.Fatal("missing adobe-commerce catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "searchCriteria") || !strings.Contains(setup[1].Description, "Store-header") {
		t.Fatalf("adobe commerce setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_adobe_commerce_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("adobe commerce sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_adobe_commerce_provider_pull") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("adobe commerce backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "Adobe/Magento access-token") {
		t.Fatalf("adobe commerce disconnect should disclose provider-admin cleanup: %+v", disconnect)
	}
}

func TestSquarespaceHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("squarespace-commerce")
	if !ok {
		t.Fatal("missing squarespace-commerce catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "product detail enrichment") || !strings.Contains(report.Message, "managed webhook subscription") {
		t.Fatalf("squarespace health must disclose runtime plus remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "raw-body HMAC") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Squarespace-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "product-detail enrichment") {
		t.Fatalf("sync check should describe Squarespace provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Squarespace Commerce", contract)
	if !strings.Contains(contract.RateLimitPolicy, "product list/detail") ||
		!strings.Contains(contract.RateLimitPolicy, "provider_cleanup readiness evidence") ||
		!containsString(contract.EventTopics, "contact.delete") {
		t.Fatalf("contract should expose Squarespace retry and webhook metadata: %+v", contract)
	}
}

func TestSquarespaceLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("squarespace-commerce")
	if !ok {
		t.Fatal("missing squarespace-commerce catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "product-detail enrichment") {
		t.Fatalf("squarespace setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_squarespace_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("squarespace sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_squarespace_provider_pull") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("squarespace backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "OAuth-only Squarespace webhook subscriptions") {
		t.Fatalf("squarespace disconnect should disclose provider-console cleanup: %+v", disconnect)
	}
}

func TestStripeHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("stripe")
	if !ok {
		t.Fatal("missing stripe catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "disputes") || !strings.Contains(report.Message, "credit notes") || !strings.Contains(report.Message, "paginated line-item enrichment") || !strings.Contains(report.Message, "provider_cleanup readiness evidence") || !strings.Contains(report.Message, "live Stripe") {
		t.Fatalf("stripe health must disclose runtime plus remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "disputes") || !strings.Contains(checks["ownership"].Message, "credit notes") || !strings.Contains(checks["ownership"].Message, "Stripe-Signature") || !strings.Contains(checks["ownership"].Message, "provider_cleanup readiness evidence") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Stripe-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "disputes") || !strings.Contains(checks["sync"].Message, "credit notes") || !strings.Contains(checks["sync"].Message, "full line-item pagination") {
		t.Fatalf("sync check should describe Stripe provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" || !strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
		t.Fatalf("Stripe contract should expose local-complete/live-cert-pending state: %+v", contract)
	}
	if !strings.Contains(contract.RateLimitPolicy, "disputes") || !strings.Contains(contract.RateLimitPolicy, "credit notes") || !strings.Contains(contract.RateLimitPolicy, "invoice line pagination") || !strings.Contains(contract.RateLimitPolicy, "provider_cleanup readiness evidence") || !containsString(contract.EventTopics, "charge.dispute.created") || !containsString(contract.EventTopics, "credit_note.voided") || !containsString(contract.DataObjects, "disputes") || !containsString(contract.DataObjects, "credit_notes") {
		t.Fatalf("contract should expose Stripe retry and webhook metadata: %+v", contract)
	}
}

func TestStripeLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("stripe")
	if !ok {
		t.Fatal("missing stripe catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "disputes") || !strings.Contains(setup[1].Description, "credit notes") || !strings.Contains(setup[1].Description, "invoice line-item pagination") {
		t.Fatalf("stripe setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_stripe_provider_pull") || !strings.Contains(sync.Message, "Disputes") || !strings.Contains(sync.Message, "Credit Notes") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("stripe sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_stripe_provider_pull") || !strings.Contains(backfill.Message, "dispute evidence") || !strings.Contains(backfill.Message, "credit-note evidence") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("stripe backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "provider_cleanup readiness evidence") || !strings.Contains(disconnect.Message, "Stripe restricted-key revocation") {
		t.Fatalf("stripe disconnect should disclose provider-dashboard cleanup: %+v", disconnect)
	}
}

func TestSquareHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("square")
	if !ok {
		t.Fatal("missing square catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "catalog products") || !strings.Contains(report.Message, "live Square") {
		t.Fatalf("square health must disclose runtime plus remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "exact notification URL") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Square-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "Catalog ITEM products") || !strings.Contains(checks["sync"].Message, "bounded catalog product page") {
		t.Fatalf("sync check should describe Square provider pull: %+v", checks["sync"])
	}
	if checks["disconnect"].State != "warning" || !strings.Contains(checks["disconnect"].Message, "provider_cleanup readiness") || !strings.Contains(checks["disconnect"].Message, "signature-key rotation") {
		t.Fatalf("square disconnect check should disclose provider cleanup readiness: %+v", checks["disconnect"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "Square", contract)
	if !strings.Contains(contract.RateLimitPolicy, "Catalog Search") || !containsString(contract.DataObjects, "catalog_products") || !containsString(contract.EventTopics, "customer.deleted") || !containsString(contract.EventTopics, "catalog.version.updated") {
		t.Fatalf("contract should expose Square retry, product, and webhook metadata: %+v", contract)
	}
}

func TestSquareLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("square")
	if !ok {
		t.Fatal("missing square catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "Catalog ITEM product") {
		t.Fatalf("square setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_square_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("square sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_square_provider_pull") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("square backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "provider_cleanup readiness") || !strings.Contains(disconnect.Message, "Square Developer Console") {
		t.Fatalf("square disconnect should disclose provider cleanup readiness: %+v", disconnect)
	}
}

func TestPayPalHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("paypal")
	if !ok {
		t.Fatal("missing paypal catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "Transaction Search") || !strings.Contains(report.Message, "resource hydration") || !strings.Contains(report.Message, "live PayPal") {
		t.Fatalf("paypal health must disclose runtime plus remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "Verify Webhook Signature") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be PayPal-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "31-day windowing") {
		t.Fatalf("sync check should describe PayPal provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	assertLocalCompleteLiveCertPending(t, "PayPal", contract)
	if !strings.Contains(contract.RateLimitPolicy, "reporting window") ||
		!strings.Contains(contract.RateLimitPolicy, "resource hydration") ||
		!containsString(contract.DataObjects, "transactions") ||
		!containsString(contract.EventTopics, "PAYMENT.CAPTURE.COMPLETED") ||
		!containsString(contract.EventTopics, "INVOICING.INVOICE.PAID") {
		t.Fatalf("contract should expose PayPal retry, transaction, and webhook metadata: %+v", contract)
	}
}

func TestPayPalLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("paypal")
	if !ok {
		t.Fatal("missing paypal catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "Transaction Search") || !strings.Contains(setup[1].Description, "31-day reporting windows") || !strings.Contains(setup[2].Description, "sparse resource hydration") {
		t.Fatalf("paypal setup should describe native Transaction Search provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_paypal_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || !strings.Contains(sync.Message, "hydrate sparse") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("paypal sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_paypal_provider_pull") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("paypal backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "provider_cleanup") || !strings.Contains(disconnect.Message, "PayPal REST app credentials") {
		t.Fatalf("paypal disconnect should disclose provider-dashboard cleanup: %+v", disconnect)
	}
}

func TestRazorpayHealthDisclosesBuiltRuntimeAndCertificationGap(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("razorpay")
	if !ok {
		t.Fatal("missing razorpay catalog item")
	}
	report := healthReport(item, Connection{Count: 1, Connected: true, Status: "connected"})
	if report.State != "needs_attention" || !strings.Contains(report.Message, "payments, refunds") || !strings.Contains(report.Message, "live Razorpay") {
		t.Fatalf("razorpay health must disclose runtime plus remaining native gaps: %+v", report)
	}
	checks := map[string]HealthCheck{}
	for _, check := range report.Checks {
		checks[check.Key] = check
	}
	if checks["ownership"].State != "warning" || !strings.Contains(checks["ownership"].Message, "X-Razorpay-Signature") || strings.Contains(checks["ownership"].Message, "provider pullers") {
		t.Fatalf("ownership check should be Razorpay-specific: %+v", checks["ownership"])
	}
	if checks["sync"].State != "warning" || !strings.Contains(checks["sync"].Message, "count/skip") {
		t.Fatalf("sync check should describe Razorpay provider pull: %+v", checks["sync"])
	}
	contract := runtimeConnectorContractFixture(item)
	if !strings.Contains(contract.RateLimitPolicy, "skip cursor") ||
		!strings.Contains(contract.RateLimitPolicy, "provider_cleanup readiness evidence") ||
		!containsString(contract.DataObjects, "refunds") ||
		!containsString(contract.EventTopics, "refund.processed") {
		t.Fatalf("contract should expose Razorpay retry, refund, and webhook metadata: %+v", contract)
	}
	assertLocalCompleteLiveCertPending(t, "Razorpay", contract)
}

func TestRazorpayLifecycleActionsUseNativeProviderPulls(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("razorpay")
	if !ok {
		t.Fatal("missing razorpay catalog item")
	}
	setup := SetupGuide(item)
	if len(setup) != 3 || !strings.Contains(setup[1].Description, "count/skip") {
		t.Fatalf("razorpay setup should describe native REST provider pull: %+v", setup)
	}
	sync, _ := lifecycleAction(item, "sync")
	if !strings.Contains(strings.Join(sync.RequiredFields, ","), "empty_razorpay_provider_pull") || !strings.Contains(sync.Message, "REST provider pull") || strings.Contains(sync.Message, "not implemented") {
		t.Fatalf("razorpay sync should expose native provider pull: %+v", sync)
	}
	backfill, _ := lifecycleAction(item, "backfill")
	if !strings.Contains(strings.Join(backfill.RequiredFields, ","), "empty_razorpay_provider_pull") || !strings.Contains(backfill.Message, "Retry-After") {
		t.Fatalf("razorpay backfill should expose retry-aware provider pull: %+v", backfill)
	}
	disconnect, _ := lifecycleAction(item, "disconnect")
	if !strings.Contains(disconnect.Message, "Razorpay keys") {
		t.Fatalf("razorpay disconnect should disclose provider-dashboard cleanup: %+v", disconnect)
	}
}

func TestManagedIngestFoundationContractUsesCanonicalObjects(t *testing.T) {
	cases := []struct {
		slug       string
		wantObject string
		blocked    []string
	}{
		{slug: "hubspot", wantObject: "deal_events", blocked: []string{"segments", "automation_triggers"}},
		{slug: "salesforce", wantObject: "tasks", blocked: []string{"change_data_capture", "automation_triggers"}},
		{slug: "pipedrive", wantObject: "activities", blocked: []string{}},
		{slug: "zoho-crm", wantObject: "leads", blocked: []string{"accounts", "deals", "campaigns", "activities", "webhooks", "automation_triggers"}},
		{slug: "microsoft-dynamics-365", wantObject: "leads", blocked: []string{"accounts", "opportunities", "marketing_lists", "activities", "webhooks", "automation_triggers"}},
		{slug: "keap", wantObject: "contacts", blocked: []string{"tags", "campaigns", "orders", "appointments", "webhooks", "automation_triggers"}},
	}
	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing %s catalog item", tc.slug)
			}
			contract := runtimeConnectorContractFixture(item)
			if !containsString(contract.DataObjects, tc.wantObject) {
				t.Fatalf("contract missing canonical object %q: %+v", tc.wantObject, contract.DataObjects)
			}
			for _, blocked := range tc.blocked {
				if containsString(contract.DataObjects, blocked) {
					t.Fatalf("contract should not expose roadmap object %q: %+v", blocked, contract.DataObjects)
				}
				if containsString(contract.EventTopics, blocked) {
					t.Fatalf("contract should not expose roadmap topic %q: %+v", blocked, contract.EventTopics)
				}
			}
			if tc.slug == "pipedrive" {
				for _, topic := range []string{"create.person", "change.person", "delete.person", "create.deal", "change.deal", "delete.deal", "create.organization", "change.organization", "delete.organization", "create.activity", "change.activity", "delete.activity"} {
					if !containsString(contract.EventTopics, topic) {
						t.Fatalf("pipedrive contract should expose managed webhook topic %q: %+v", topic, contract.EventTopics)
					}
				}
			}
			allowedProviderTopics := map[string]bool{}
			if tc.slug == "hubspot" {
				for _, topic := range []string{"contact.creation", "contact.propertyChange", "contact.deletion"} {
					if !containsString(contract.EventTopics, topic) {
						t.Fatalf("hubspot contract should expose managed app-webhook topic %q: %+v", topic, contract.EventTopics)
					}
					allowedProviderTopics[topic] = true
				}
			}
			for _, providerTopic := range []string{"contact.creation", "contact.propertyChange", "contact.deletion", "/data/ContactChangeEvent", "/data/LeadChangeEvent", "update.person", "update.deal", "contacts.create", "contacts.edit", "leads.create", "leads.edit", "contact.created", "contact.updated", "lead.created", "lead.updated", "opportunity.updated", "contact.add", "contact.edit", "tag.add", "order.add", "appointment.add"} {
				if allowedProviderTopics[providerTopic] {
					continue
				}
				if containsString(contract.EventTopics, providerTopic) {
					t.Fatalf("%s contract should not publish provider webhook topic %q before provider handlers exist: %+v", tc.slug, providerTopic, contract.EventTopics)
				}
			}
		})
	}
}

func TestTypeformContractUsesProviderRuntimeObjects(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("typeform")
	if !ok {
		t.Fatal("missing typeform catalog item")
	}
	contract := runtimeConnectorContractFixture(item)
	for _, want := range []string{"profiles", "events", "lists", "forms", "responses"} {
		if !containsString(contract.DataObjects, want) {
			t.Fatalf("contract missing Typeform object %q: %+v", want, contract.DataObjects)
		}
	}
	if !containsString(contract.EventTopics, "form_response") {
		t.Fatalf("contract missing Typeform webhook topic: %+v", contract.EventTopics)
	}
	if !containsString(contract.AuthModes, "webhook_secret_ref") || !strings.Contains(contract.RateLimitPolicy, "page_size maximum of 1000") {
		t.Fatalf("contract missing Typeform webhook auth or rate policy: %+v", contract)
	}
}

func TestContractEndpointDescribesOwnershipAndAuth(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/shopify/contract", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var native ConnectorContract
	if err := json.NewDecoder(rec.Body).Decode(&native); err != nil {
		t.Fatal(err)
	}
	if native.Owner != "postwave" || !native.NativeManaged {
		t.Fatalf("expected native postwave contract, got %+v", native)
	}
	if native.NativeVerified {
		t.Fatalf("shopify is partial and must not claim verified-native completion yet: %+v", native)
	}
	if native.ImplementationDepth != "native_runtime_complete_live_certification_pending" {
		t.Fatalf("unexpected shopify implementation depth: %+v", native)
	}
	if containsString(native.DataObjects, "carts") {
		t.Fatalf("shopify contract must not claim dedicated cart sync until the commerce surface implements it: %+v", native.DataObjects)
	}
	if !strings.Contains(native.RateLimitPolicy, "mode=bulk_async") || !strings.Contains(native.RateLimitPolicy, "shopify_bulk:") || strings.Contains(native.RateLimitPolicy, "implementation work") {
		t.Fatalf("shopify contract must expose built async bulk runtime truthfully: %+v", native.RateLimitPolicy)
	}
	if len(native.AuthModes) == 0 || len(native.Monitoring) == 0 || len(native.ComplianceGates) == 0 {
		t.Fatalf("expected auth/monitoring/compliance, got %+v", native)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/integrations/snowflake/contract", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("snowflake status=%d body=%s", rec.Code, rec.Body.String())
	}
	var warehouse ConnectorContract
	if err := json.NewDecoder(rec.Body).Decode(&warehouse); err != nil {
		t.Fatal(err)
	}
	if !warehouse.NativeManaged || warehouse.Owner != "postwave" {
		t.Fatalf("expected managed warehouse contract, got %+v", warehouse)
	}
	if warehouse.NativeVerified || warehouse.ImplementationDepth != "native_runtime_complete_live_certification_pending" {
		t.Fatalf("snowflake must expose local-complete/live-cert-pending warehouse export-health slice without claiming verified native, got %+v", warehouse)
	}
	if !strings.Contains(warehouse.PublicClaim, "SQL executor") || !strings.Contains(warehouse.PublicClaim, "implemented warehouse export/health slice") || strings.Contains(warehouse.PublicClaim, "webhook") {
		t.Fatalf("snowflake public claim must describe export/health slice without generic webhook language, got %+v", warehouse.PublicClaim)
	}
	if !strings.Contains(warehouse.RateLimitPolicy, "manifest-worker") || !strings.Contains(warehouse.RateLimitPolicy, "linked database/sql Snowflake execution") {
		t.Fatalf("snowflake rate-limit policy must disclose manifest-worker boundary, got %+v", warehouse.RateLimitPolicy)
	}
}

func TestNativeConnectorsExposeLifecycleAndHealthMetadata(t *testing.T) {
	for _, item := range CatalogItems() {
		if item.Badge != BadgeNative {
			continue
		}
		if item.DocsURL == "" {
			t.Fatalf("%s missing docs url", item.Slug)
		}
		actions := LifecycleActions(item)
		if item.RuntimeStatus != RuntimePlanned && !containsString(actions, "disconnect") {
			t.Fatalf("%s missing disconnect lifecycle action: %+v", item.Slug, actions)
		}
		report := healthReport(item, connectionFromItem(item))
		if report.RetryPolicy.Mode == "" || len(report.SyncHistory) == 0 || len(report.DataDelete) == 0 {
			t.Fatalf("%s incomplete health report: %+v", item.Slug, report)
		}
		contract := runtimeConnectorContractFixture(item)
		if contract.Owner != "postwave" || !contract.NativeManaged || contract.PublicClaim == "" {
			t.Fatalf("%s incomplete native contract: %+v", item.Slug, contract)
		}
	}
}

func TestNativeRunHistoryTablesCoverManagedFamilies(t *testing.T) {
	cases := map[string]struct {
		integrationTable string
		runTable         string
		provider         string
	}{
		"hubspot":             {integrationTable: "crm_integrations", runTable: "crm_sync_runs", provider: "hubspot"},
		"typeform":            {integrationTable: "lead_integrations", runTable: "lead_sync_runs", provider: "typeform"},
		"yotpo":               {integrationTable: "review_integrations", runTable: "review_sync_runs", provider: "yotpo"},
		"smile":               {integrationTable: "loyalty_integrations", runTable: "loyalty_sync_runs", provider: "smile"},
		"recharge":            {integrationTable: "subscription_integrations", runTable: "subscription_sync_runs", provider: "recharge"},
		"zendesk":             {},
		"front":               {},
		"reamaze":             {},
		"crisp":               {},
		"kustomer":            {},
		"drift":               {},
		"livechat":            {},
		"zoho-desk":           {},
		"olark":               {},
		"kayako":              {},
		"hubspot-service-hub": {},
		"posthog":             {integrationTable: "analytics_integrations", runTable: "analytics_sync_runs", provider: "posthog"},
		"klaviyo":             {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "klaviyo"},
		"mailchimp":           {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "mailchimp"},
		"activecampaign":      {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "activecampaign"},
		"customerio":          {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "customerio"},
		"brevo":               {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "brevo"},
		"convertkit":          {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "convertkit"},
		"substack":            {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "substack"},
		"beehiiv":             {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "beehiiv"},
		"mailerlite":          {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "mailerlite"},
		"sendy":               {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "sendy"},
		"constant-contact":    {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "constant-contact"},
		"aweber":              {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "aweber"},
		"drip":                {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "drip"},
		"campaign-monitor":    {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "campaign-monitor"},
		"omnisend":            {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "omnisend"},
		"loops":               {integrationTable: "marketing_integrations", runTable: "marketing_sync_runs", provider: "loops"},
		"snowflake":           {integrationTable: "", runTable: "", provider: ""},
	}
	for slug, want := range cases {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		integrationTable, runTable, provider, ok := nativeRunHistoryTables(item)
		if want.integrationTable == "" {
			if ok {
				t.Fatalf("%s should use non-native-table history, got %s/%s", slug, integrationTable, runTable)
			}
			continue
		}
		if !ok || integrationTable != want.integrationTable || runTable != want.runTable || provider != want.provider {
			t.Fatalf("%s table mapping mismatch: got %q/%q/%q ok=%v want %+v", slug, integrationTable, runTable, provider, ok, want)
		}
	}
}

func TestHealthReportUsesRuntimeRunHistoryWhenAvailable(t *testing.T) {
	item, ok := archivedSupportCatalogItemFixture("typeform")
	if !ok {
		t.Fatal("missing typeform catalog item")
	}
	at := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	report := healthReportWithHistory(item, connectionFromItem(item), []SyncHistoryEntry{{
		At:       &at,
		Action:   "lead_capture_sync",
		Status:   "partial",
		Attempts: 2,
		Message:  "Latest webhook run recorded by Integrations. 1 row(s) failed.",
		Error:    "email is required",
	}})
	if len(report.SyncHistory) != 1 {
		t.Fatalf("expected runtime history override, got %+v", report.SyncHistory)
	}
	if report.SyncHistory[0].Status != "partial" || report.SyncHistory[0].Error != "email is required" {
		t.Fatalf("expected actual run details, got %+v", report.SyncHistory[0])
	}
}

func TestConnectionIDLookupMapsCatalogSlugsToOwningTables(t *testing.T) {
	cases := map[string]struct {
		provider             string
		ok                   bool
		excludesDisconnected bool
	}{
		"hubspot":             {provider: "hubspot", ok: true, excludesDisconnected: true},
		"typeform":            {provider: "typeform", ok: true, excludesDisconnected: true},
		"yotpo":               {provider: "yotpo", ok: true, excludesDisconnected: true},
		"smile":               {provider: "smile", ok: true, excludesDisconnected: true},
		"recharge":            {provider: "recharge", ok: true, excludesDisconnected: true},
		"zendesk":             {},
		"front":               {},
		"reamaze":             {},
		"crisp":               {},
		"kustomer":            {},
		"drift":               {},
		"livechat":            {},
		"zoho-desk":           {},
		"olark":               {},
		"kayako":              {},
		"hubspot-service-hub": {},
		"klaviyo":             {provider: "klaviyo", ok: true, excludesDisconnected: true},
		"mailchimp":           {provider: "mailchimp", ok: true, excludesDisconnected: true},
		"activecampaign":      {provider: "activecampaign", ok: true, excludesDisconnected: true},
		"customerio":          {provider: "customerio", ok: true, excludesDisconnected: true},
		"brevo":               {provider: "brevo", ok: true, excludesDisconnected: true},
		"convertkit":          {provider: "convertkit", ok: true, excludesDisconnected: true},
		"substack":            {provider: "substack", ok: true, excludesDisconnected: true},
		"beehiiv":             {provider: "beehiiv", ok: true, excludesDisconnected: true},
		"mailerlite":          {provider: "mailerlite", ok: true, excludesDisconnected: true},
		"sendy":               {provider: "sendy", ok: true, excludesDisconnected: true},
		"constant-contact":    {provider: "constant-contact", ok: true, excludesDisconnected: true},
		"aweber":              {provider: "aweber", ok: true, excludesDisconnected: true},
		"drip":                {provider: "drip", ok: true, excludesDisconnected: true},
		"campaign-monitor":    {provider: "campaign-monitor", ok: true, excludesDisconnected: true},
		"omnisend":            {provider: "omnisend", ok: true, excludesDisconnected: true},
		"loops":               {provider: "loops", ok: true, excludesDisconnected: true},
		"google-ads":          {provider: "google_ads", ok: true, excludesDisconnected: true},
		"snowflake":           {provider: "snowflake", ok: true, excludesDisconnected: true},
		"outbound-webhooks":   {ok: true},
	}
	for slug, want := range cases {
		item, ok := archivedSupportCatalogItemFixture(slug)
		if !ok {
			t.Fatalf("missing catalog item %q", slug)
		}
		query, args, ok := connectionIDQuery(item)
		if ok != want.ok {
			t.Fatalf("%s ok=%v want %v query=%q", slug, ok, want.ok, query)
		}
		if !ok {
			continue
		}
		if query == "" {
			t.Fatalf("%s returned empty id query", slug)
		}
		if want.excludesDisconnected && !strings.Contains(query, "status <> 'disconnected'") {
			t.Fatalf("%s connection lookup should exclude disconnected rows, got %q", slug, query)
		}
		if want.provider != "" && (len(args) == 0 || args[0] != want.provider) {
			t.Fatalf("%s provider arg=%+v want %q", slug, args, want.provider)
		}
	}
}

func TestActionResponseUsesConcreteConnectionIDs(t *testing.T) {
	resp := actionResponseWithConnection(actionResponse{
		Slug:           "hubspot",
		Action:         "pause",
		DelegatedTo:    "POST /api/v1/crm/integrations/{id}/pause",
		RequiredFields: []string{"id"},
	}, Connection{
		PrimaryConnectionID: "crm_1",
		ConnectionIDs:       []string{"crm_1", "crm_2"},
	})
	if resp.PrimaryConnectionID != "crm_1" {
		t.Fatalf("expected primary connection id, got %+v", resp)
	}
	if len(resp.ConnectionIDs) != 2 || resp.ConnectionIDs[1] != "crm_2" {
		t.Fatalf("expected connection id list, got %+v", resp)
	}
	if resp.DelegatedTo != "POST /api/v1/crm/integrations/crm_1/pause" {
		t.Fatalf("expected concrete delegated endpoint, got %+v", resp)
	}
	if containsString(resp.RequiredFields, "id") {
		t.Fatalf("concrete primary connection should remove id requirement: %+v", resp)
	}
}

func TestActionResponseRequiresConnectionIDWhenTemplateRemains(t *testing.T) {
	resp := actionResponseWithConnection(actionResponse{
		Slug:        "hubspot",
		Action:      "sync",
		DelegatedTo: "POST /api/v1/crm/integrations/{id}/sync",
	}, Connection{})
	if !containsString(resp.RequiredFields, "id") {
		t.Fatalf("templated delegated endpoint should require id: %+v", resp)
	}

	partnerResp := actionResponseWithConnection(actionResponse{
		Slug:           "partner-helpdesk",
		Action:         "disconnect",
		DelegatedTo:    "DELETE /api/v1/developer-marketplace/installations/{installation_id}",
		RequiredFields: []string{"installation_id"},
	}, Connection{})
	if len(partnerResp.RequiredFields) != 1 || partnerResp.RequiredFields[0] != "installation_id" {
		t.Fatalf("expected deduped installation_id requirement: %+v", partnerResp)
	}
}

func TestRecipesEndpointIndexesCuratedAndGeneratedRecipes(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/recipes?q=typeform&available=true", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res recipesResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) == 0 {
		t.Fatal("expected typeform recipes")
	}
	if res.Summary["available"] != len(res.Items) {
		t.Fatalf("expected only available recipes, got summary=%+v items=%+v", res.Summary, res.Items)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/integrations/recipes?source=calendly", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("generated status=%d body=%s", rec.Code, rec.Body.String())
	}
	res = recipesResponse{}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].SourceSlug != "calendly" {
		t.Fatalf("expected generated calendly bridge recipe, got %+v", res.Items)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/integrations/recipes?source=littledata", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expanded generated status=%d body=%s", rec.Code, rec.Body.String())
	}
	res = recipesResponse{}
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 1 || res.Items[0].SourceSlug != "littledata" || !res.Items[0].Available {
		t.Fatalf("expected generated littledata bridge recipe, got %+v", res.Items)
	}
}

func TestRecipeDetailAndApplyExposeBlueprint(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/recipes/typeform-leads-inbound-webhook", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("detail status=%d body=%s", rec.Code, rec.Body.String())
	}
	var detail recipeDetailResponse
	if err := json.NewDecoder(rec.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if detail.Recipe.Blueprint.Trigger == "" || len(detail.Recipe.Blueprint.FieldMappings) == 0 {
		t.Fatalf("expected blueprint, got %+v", detail.Recipe.Blueprint)
	}
	if detail.Source.Slug != "typeform" {
		t.Fatalf("expected typeform source, got %+v", detail.Source)
	}
	if detail.Recipe.Provider != "Moosewave native" || detail.Recipe.Badge != BadgeNative || detail.Recipe.SetupPath != "/integrations" || detail.Recipe.TargetSlug != "" {
		t.Fatalf("expected native Typeform recipe, got %+v", detail.Recipe)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/integrations/recipes/typeform-leads-inbound-webhook/apply", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("apply status=%d body=%s", rec.Code, rec.Body.String())
	}
	var applied recipeApplyResponse
	if err := json.NewDecoder(rec.Body).Decode(&applied); err != nil {
		t.Fatal(err)
	}
	if applied.Status != "delegated" || applied.DelegatedTo != "POST /api/v1/lead-integrations" || applied.ManagePath != "/integrations" {
		t.Fatalf("expected delegated apply response, got %+v", applied)
	}
	for _, field := range []string{"form_id", "credentials_ref", "webhook_secret_ref"} {
		if !containsString(applied.RequiredFields, field) {
			t.Fatalf("missing required field %q in %+v", field, applied.RequiredFields)
		}
	}
	if applied.Blueprint.PostwaveSurface != "/integrations" || !containsString(applied.Blueprint.RequiredScopes, "webhooks:write") {
		t.Fatalf("expected required fields, got %+v", applied)
	}
}

func TestWarehouseRecipeApplyDelegatesToDataPlatform(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/integrations/recipes/snowflake-export-roadmap/apply", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var res recipeApplyResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if res.Status != "delegated" || res.DelegatedTo != "POST /api/v1/warehouse/connections" {
		t.Fatalf("expected warehouse delegated response, got %+v", res)
	}
}

func TestLifecycleActionsDelegateOrReturnPlanned(t *testing.T) {
	router := authenticatedIntegrationRouter(&Deps{})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/integrations/shopify/connect/start", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("shopify status=%d body=%s", rec.Code, rec.Body.String())
	}
	var delegated actionResponse
	if err := json.NewDecoder(rec.Body).Decode(&delegated); err != nil {
		t.Fatal(err)
	}
	if delegated.Status != "delegated" || delegated.DelegatedTo == "" {
		t.Fatalf("expected delegated shopify response, got %+v", delegated)
	}
	if len(delegated.RequiredFields) != 1 || delegated.RequiredFields[0] != "shop_domain" {
		t.Fatalf("expected shop_domain requirement, got %+v", delegated.RequiredFields)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/integrations/snowflake/sync", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("snowflake status=%d body=%s", rec.Code, rec.Body.String())
	}
	var warehouse actionResponse
	if err := json.NewDecoder(rec.Body).Decode(&warehouse); err != nil {
		t.Fatal(err)
	}
	if warehouse.Status != "delegated" || warehouse.DelegatedTo != "POST /api/v1/warehouse/connections/{id}/runs" {
		t.Fatalf("expected delegated snowflake response, got %+v", warehouse)
	}
	if !strings.Contains(warehouse.Message, "manifest run") || !strings.Contains(warehouse.Message, "provider_driver_attachment=manifest_worker") {
		t.Fatalf("snowflake sync response must disclose manifest-worker boundary, got %+v", warehouse)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/integrations/hubspot/pause", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("hubspot pause status=%d body=%s", rec.Code, rec.Body.String())
	}
	var crm actionResponse
	if err := json.NewDecoder(rec.Body).Decode(&crm); err != nil {
		t.Fatal(err)
	}
	if crm.Status != "delegated" || crm.DelegatedTo != "POST /api/v1/crm/integrations/{id}/pause" {
		t.Fatalf("expected action-aware crm delegated response, got %+v", crm)
	}

	// Planned catalog entries expose only the non-executable "roadmap"
	// marker. A direct lifecycle call is an explicit capability conflict,
	// never an accepted or delegated operation.
	req = httptest.NewRequest(http.MethodPost, "/api/v1/integrations/azure-blob/sync", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("planned integration status=%d body=%s", rec.Code, rec.Body.String())
	}
	var unavailable actionResponse
	if err := json.NewDecoder(rec.Body).Decode(&unavailable); err != nil {
		t.Fatal(err)
	}
	if unavailable.Status != "unavailable" || unavailable.DelegatedTo != "" {
		t.Fatalf("planned integration falsely delegated: %+v", unavailable)
	}
	item, ok := catalogItemBySlug(CatalogItems(), "azure-blob")
	if !ok || len(LifecycleActions(item)) != 1 || LifecycleActions(item)[0] != "roadmap" {
		t.Fatalf("planned lifecycle advertisement = %+v", LifecycleActions(item))
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/integrations/recipes/azure-blob-bridge-recipe/apply", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unadvertised planned recipe status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, recipe := range AllRecipes() {
		if !recipe.Available {
			t.Fatalf("recipe catalog advertised an unavailable apply contract: %+v", recipe)
		}
	}
}

func TestManagedNativeProviderMetadataDrivesFacadeSetupLifecycleAndContract(t *testing.T) {
	cases := []struct {
		slug               string
		endpoint           string
		startEndpoint      string
		syncEndpoint       string
		disconnectEndpoint string
		required           []string
		authMode           string
		extraAuthMode      string
		syncObject         string
		webhookTopic       string
		disconnectMsg      string
	}{
		{
			slug:          "shopify",
			endpoint:      "POST /api/v1/commerce/integrations",
			startEndpoint: "GET /api/v1/commerce/shopify/oauth/start?shop={shop_domain}",
			required:      []string{"shop_domain"},
			authMode:      "oauth",
			syncObject:    "customers",
			webhookTopic:  "customers/create",
			disconnectMsg: "Disconnect deletes Moosewave-owned Shopify webhook subscriptions",
		},
		{
			slug:          "woocommerce",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"store_url", "credential_ref"},
			authMode:      "api_key_ref",
			syncObject:    "refunds",
			webhookTopic:  "subscription.updated",
			disconnectMsg: "WooCommerce REST API key",
		},
		{
			slug:          "bigcommerce",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"store_hash", "credential_ref"},
			authMode:      "api_key_ref",
			extraAuthMode: "webhook_auth_ref",
			syncObject:    "transactions",
			webhookTopic:  "store/order/refund/created",
			disconnectMsg: "BigCommerce API account",
		},
		{
			slug:          "adobe-commerce",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"base_url", "credential_ref"},
			authMode:      "access_token_ref",
			syncObject:    "products",
			webhookTopic:  "sales_order_creditmemo_refund",
			disconnectMsg: "Adobe/Magento access-token",
		},
		{
			slug:          "wix-stores",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"site_id", "instance_id", "store_id", "credential_ref"},
			authMode:      "oauth_app_instance_ref",
			syncObject:    "products",
			disconnectMsg: "Wix app/dashboard webhook subscriptions",
		},
		{
			slug:          "squarespace-commerce",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"site_id", "credential_ref"},
			authMode:      "api_key_or_oauth_ref",
			syncObject:    "products",
			disconnectMsg: "OAuth-only Squarespace webhook subscriptions",
		},
		{
			slug:          "stripe",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"account_id", "credential_ref"},
			authMode:      "api_key_ref",
			syncObject:    "customers",
			disconnectMsg: "provider_cleanup readiness evidence",
		},
		{
			slug:          "square",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"merchant_id", "credential_ref"},
			authMode:      "oauth_or_app_token_ref",
			syncObject:    "payments",
			webhookTopic:  "payment.created",
			disconnectMsg: "Square OAuth",
		},
		{
			slug:          "paypal",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"merchant_id", "credential_ref"},
			authMode:      "client_credentials_ref",
			syncObject:    "orders",
			webhookTopic:  "PAYMENT.CAPTURE.COMPLETED",
			disconnectMsg: "PayPal REST app credentials",
		},
		{
			slug:          "razorpay",
			endpoint:      "POST /api/v1/commerce/integrations",
			required:      []string{"account_id", "credential_ref"},
			authMode:      "api_key_ref",
			syncObject:    "orders",
			webhookTopic:  "payment.captured",
			disconnectMsg: "Razorpay keys",
		},
		{
			slug:          "hubspot",
			endpoint:      "POST /api/v1/crm/integrations",
			required:      []string{"portal_id", "credentials_ref"},
			authMode:      "private_app_ref_or_managed_oauth",
			syncObject:    "contacts",
			disconnectMsg: "managed OAuth refresh tokens",
		},
		{
			slug:          "salesforce",
			endpoint:      "POST /api/v1/crm/integrations",
			required:      []string{"org_id", "credentials_ref"},
			authMode:      "connected_app_ref",
			syncObject:    "leads",
			disconnectMsg: "managed OAuth refresh tokens",
		},
		{
			slug:          "pipedrive",
			endpoint:      "POST /api/v1/crm/integrations",
			required:      []string{"company_domain", "credentials_ref"},
			authMode:      "managed_oauth_or_api_token_ref",
			syncObject:    "deals",
			disconnectMsg: "Moosewave-owned webhook",
		},
		{
			slug:          "zoho-crm",
			endpoint:      "POST /api/v1/crm/integrations",
			required:      []string{"organization_id", "credentials_ref"},
			authMode:      "oauth_ref",
			syncObject:    "leads",
			disconnectMsg: "revokes managed Zoho refresh tokens",
		},
		{
			slug:          "microsoft-dynamics-365",
			endpoint:      "POST /api/v1/crm/integrations",
			required:      []string{"environment_url", "credentials_ref"},
			authMode:      "oauth_ref",
			syncObject:    "leads",
			disconnectMsg: "deletes local managed OAuth credential envelopes",
		},
		{
			slug:          "keap",
			endpoint:      "POST /api/v1/crm/integrations",
			required:      []string{"account_id", "credentials_ref"},
			authMode:      "oauth_or_api_key_ref",
			syncObject:    "contacts",
			disconnectMsg: "deletes local managed OAuth/PAT/SAK credential envelopes",
		},
		{
			slug:          "typeform",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"form_id", "credentials_ref"},
			authMode:      "personal_token_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "responses",
			webhookTopic:  "form_response",
			disconnectMsg: "/forms/{form_id}/webhooks/{tag}",
		},
		{
			slug:          "fillout",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"form_id", "credentials_ref"},
			authMode:      "api_key_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "submissions",
			webhookTopic:  "submission.created",
			disconnectMsg: "/webhook/delete",
		},
		{
			slug:          "jotform",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"form_id", "credentials_ref"},
			authMode:      "api_key_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "questions",
			webhookTopic:  "submission.created",
			disconnectMsg: "/form/{formID}/webhooks/{webhookID}",
		},
		{
			slug:          "webflow",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"site_id", "credentials_ref"},
			authMode:      "oauth_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "submissions",
			webhookTopic:  "form_submission",
			disconnectMsg: "/v2/webhooks/{webhook_id}",
		},
		{
			slug:          "carrd",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"site_id", "form_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "custom_url_submissions",
			webhookTopic:  "form.submitted",
			disconnectMsg: "Custom URL destination",
		},
		{
			slug:          "optinmonster",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "leads",
			webhookTopic:  "lead.created",
			disconnectMsg: "OptinMonster Webhook destination",
		},
		{
			slug:          "privy",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "basic_auth_ref_webhook",
			syncObject:    "signups",
			webhookTopic:  "signup.created",
			disconnectMsg: "Privy custom Webhook destination",
		},
		{
			slug:          "convertflow",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "submissions",
			webhookTopic:  "fields.submitted",
			disconnectMsg: "ConvertFlow webhook automation",
		},
		{
			slug:          "sleeknote",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "signups",
			webhookTopic:  "signup.created",
			disconnectMsg: "Sleeknote custom integration removal",
		},
		{
			slug:          "wisepops",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "api_key_ref_hmac_webhook",
			syncObject:    "contacts",
			webhookTopic:  "email.collected",
			disconnectMsg: "Wisepops hook removal",
		},
		{
			slug:          "poptin",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "popup_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "leads",
			webhookTopic:  "lead.created",
			disconnectMsg: "Poptin Webhooks integration removal",
		},
		{
			slug:          "hello-bar",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"site_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "subscribers",
			webhookTopic:  "subscriber.created",
			disconnectMsg: "Hello Bar Webhook removal",
		},
		{
			slug:          "landingi",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "page_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "leads",
			webhookTopic:  "lead.created",
			disconnectMsg: "Landingi Webhook integration removal",
		},
		{
			slug:          "kickofflabs",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "referrals",
			webhookTopic:  "referral.created",
			disconnectMsg: "KickoffLabs outbound Webhook removal",
		},
		{
			slug:          "ninja-forms",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"site_url", "form_id", "credentials_ref"},
			authMode:      "webhook_route_token_ref",
			syncObject:    "submissions",
			webhookTopic:  "submission.created",
			disconnectMsg: "Ninja Forms Webhooks action removal",
		},
		{
			slug:          "outgrow",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_basic_or_route_token_ref",
			syncObject:    "leads",
			webhookTopic:  "lead.created",
			disconnectMsg: "Outgrow Webhook removal",
		},
		{
			slug:          "shortstack",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "campaign_id", "credentials_ref"},
			authMode:      "webhook_secret_ref_hmac_sha1",
			syncObject:    "entries",
			webhookTopic:  "entry.created",
			disconnectMsg: "ShortStack Webhook form integration removal",
		},
		{
			slug:          "riddle",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"account_id", "quiz_id", "credentials_ref"},
			authMode:      "webhook_signature_or_route_token_ref",
			syncObject:    "leads",
			webhookTopic:  "lead.created",
			disconnectMsg: "Riddle Webhook cleanup",
		},
		{
			slug:          "facebook-lead-ads",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"page_id", "form_id", "credentials_ref"},
			authMode:      "oauth_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "leads",
			webhookTopic:  "leadgen",
			disconnectMsg: "Meta OAuth token revocation",
		},
		{
			slug:          "google-lead-form-extensions",
			endpoint:      "POST /api/v1/lead-integrations",
			required:      []string{"customer_id", "lead_form_asset_id", "credentials_ref"},
			authMode:      "oauth_ref",
			syncObject:    "lead_form_submission_data",
			disconnectMsg: "Google Ads OAuth token revocation",
		},
		{
			slug:          "yotpo",
			endpoint:      "POST /api/v1/review-integrations",
			required:      []string{"store_id", "credentials_ref"},
			authMode:      "api_key_ref",
			syncObject:    "product_reviews",
			disconnectMsg: "provider-cleanup/acknowledge",
		},
		{
			slug:          "smile",
			endpoint:      "POST /api/v1/loyalty-integrations",
			required:      []string{"shop_domain", "credentials_ref"},
			authMode:      "api_key_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "points",
			disconnectMsg: "provider_cleanup",
		},
		{
			slug:          "referralcandy",
			endpoint:      "POST /api/v1/loyalty-integrations",
			required:      []string{"access_id", "credentials_ref"},
			authMode:      "api_signature_ref",
			syncObject:    "referrals",
			disconnectMsg: "Disconnect the managed Loyalty integrations connection",
		},
		{
			slug:          "recharge",
			endpoint:      "POST /api/v1/subscription-integrations",
			required:      []string{"store_domain", "credentials_ref"},
			authMode:      "api_key_ref",
			extraAuthMode: "webhook_secret_ref",
			syncObject:    "subscriptions",
			webhookTopic:  "subscription/updated",
			disconnectMsg: "provider_cleanup readiness evidence",
		},
		{
			slug:          "zendesk",
			endpoint:      "POST /api/v1/support-integrations",
			required:      []string{"subdomain", "credentials_ref"},
			authMode:      "oauth_or_api_token_ref",
			syncObject:    "tickets",
			disconnectMsg: "stored zendesk_webhook_id",
		},
		{
			slug:          "gorgias",
			endpoint:      "POST /api/v1/support-integrations",
			required:      []string{"account_domain", "credentials_ref"},
			authMode:      "api_key_ref",
			syncObject:    "tickets",
			disconnectMsg: "stored gorgias_http_integration_id",
		},
		{
			slug:          "freshdesk",
			endpoint:      "POST /api/v1/support-integrations",
			required:      []string{"account_domain", "credentials_ref"},
			authMode:      "api_key_ref",
			syncObject:    "tickets",
			disconnectMsg: "provider_cleanup readiness",
		},
		{
			slug:          "ga4",
			endpoint:      "POST /api/v1/analytics-integrations",
			required:      []string{"measurement_id", "credentials_ref"},
			authMode:      "api_secret_ref",
			syncObject:    "events",
			webhookTopic:  "",
			disconnectMsg: "Disconnect the managed Analytics integrations connection",
		},
		{
			slug:          "snowflake",
			endpoint:      "POST /api/v1/warehouse/connections",
			syncEndpoint:  "POST /api/v1/warehouse/connections/{id}/runs",
			required:      []string{"account", "warehouse", "database", "schema", "credentials_ref"},
			authMode:      "snowflake_auth_ref",
			syncObject:    "events",
			disconnectMsg: "Snowflake user, role, grant",
		},
		{
			slug:          "bigquery",
			endpoint:      "POST /api/v1/warehouse/connections",
			syncEndpoint:  "POST /api/v1/warehouse/connections/{id}/runs",
			required:      []string{"project_id", "dataset", "credentials_ref"},
			authMode:      "service_account_ref",
			syncObject:    "events",
			disconnectMsg: "Disconnect the managed Warehouse connection",
		},
	}

	for _, tc := range cases {
		t.Run(tc.slug, func(t *testing.T) {
			item, ok := archivedSupportCatalogItemFixture(tc.slug)
			if !ok {
				t.Fatalf("missing catalog item %q", tc.slug)
			}
			if hasSource(item, "support_integration") {
				live, found := CatalogItemBySlug(tc.slug)
				contract := ContractFor(live)
				if !found || len(SetupGuide(live)) != 0 || len(LifecycleActions(live)) != 0 || contract.RuntimeStatus != "held" || len(contract.AuthModes) != 0 || len(contract.DataObjects) != 0 {
					t.Fatalf("%s support-provider facade is not static-held: item=%+v contract=%+v", tc.slug, live, contract)
				}
				return
			}
			if item.Badge != BadgeNative {
				t.Fatalf("%s should be native, got %s", tc.slug, item.Badge)
			}

			setup := SetupGuide(item)
			secondAction := "Sync"
			meta, metaOK := managedProviderMetadataForItem(item)
			if metaOK && isPostwaveIngestSyncModel(meta.SyncModel) {
				secondAction = "Import"
				if containsString(LifecycleActions(item), "connect/callback") {
					t.Fatalf("%s ingest/import foundation should not advertise OAuth callback lifecycle actions", tc.slug)
				}
			}
			if (tc.slug == "yotpo" || tc.slug == "smile") && containsString(LifecycleActions(item), "connect/callback") {
				t.Fatalf("%s API-token native slice should not advertise OAuth callback lifecycle actions", tc.slug)
			}
			if len(setup) != 3 || setup[0].Action != "Connect" || setup[1].Action != secondAction {
				t.Fatalf("unexpected managed setup guide: %+v", setup)
			}
			for _, field := range tc.required {
				if !containsString(setup[0].RequiredFields, field) {
					t.Fatalf("setup missing required field %q in %+v", field, setup[0].RequiredFields)
				}
			}

			start, code := lifecycleAction(item, "connect/start")
			if code != http.StatusAccepted {
				t.Fatalf("connect/start status=%d response=%+v", code, start)
			}
			startEndpoint := tc.startEndpoint
			if startEndpoint == "" {
				startEndpoint = tc.endpoint
			}
			if start.DelegatedTo != startEndpoint {
				t.Fatalf("connect/start delegated_to=%q want %q", start.DelegatedTo, startEndpoint)
			}
			for _, field := range tc.required {
				if !containsString(start.RequiredFields, field) {
					t.Fatalf("connect/start missing required field %q in %+v", field, start.RequiredFields)
				}
			}

			sync, _ := lifecycleAction(item, "sync")
			syncEndpoint := tc.syncEndpoint
			if syncEndpoint == "" {
				syncEndpoint = tc.endpoint + "/{id}/sync"
			}
			if sync.DelegatedTo != syncEndpoint {
				t.Fatalf("sync delegated_to=%q want %q", sync.DelegatedTo, syncEndpoint)
			}
			if metaOK && isPostwaveIngestSyncModel(meta.SyncModel) && !strings.Contains(strings.ToLower(sync.Message), "import") {
				t.Fatalf("ingest sync action should describe import/ingest, got %+v", sync)
			}
			if hasSource(item, "commerce") && metaOK && isPostwaveIngestSyncModel(meta.SyncModel) {
				lowerMessage := strings.ToLower(sync.Message)
				if !strings.Contains(lowerMessage, "canonical customers") || !strings.Contains(lowerMessage, "empty requests") {
					t.Fatalf("commerce ingest sync action must require canonical non-empty payloads, got %+v", sync)
				}
				if !containsString(sync.RequiredFields, "customers|products|orders") {
					t.Fatalf("commerce ingest sync action missing canonical row requirement: %+v", sync.RequiredFields)
				}
			}
			if tc.slug == "shopify" && !strings.Contains(sync.Message, "Admin GraphQL provider pull") {
				t.Fatalf("shopify sync action should disclose Admin GraphQL provider-pull state, got %+v", sync)
			}
			if tc.slug == "shopify" && (!strings.Contains(sync.Message, "mode=bulk_async") || strings.Contains(sync.Message, "Bulk Operations remain incomplete")) {
				t.Fatalf("shopify sync action should expose built async bulk runtime without stale incomplete copy, got %+v", sync)
			}
			if tc.slug == "woocommerce" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("woocommerce sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "bigcommerce" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("bigcommerce sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "adobe-commerce" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("adobe commerce sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "squarespace-commerce" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("squarespace sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "stripe" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("stripe sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "square" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("square sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "paypal" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("paypal sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "razorpay" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("razorpay sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "hubspot" && (!strings.Contains(sync.Message, "HubSpot CRM provider pull") || !strings.Contains(sync.Message, "sync_list_memberships") || !strings.Contains(sync.Message, "list_membership_map") || !strings.Contains(sync.Message, "sync_deals") || !containsString(sync.RequiredFields, "contacts|list_memberships|deal_events|empty_hubspot_provider_pull")) {
				t.Fatalf("hubspot sync action should disclose native contact provider-pull state, got %+v", sync)
			}
			if tc.slug == "salesforce" && (!strings.Contains(sync.Message, "SOQL provider pull") || !strings.Contains(sync.Message, "CampaignMember-to-CRM-event mapping") || !strings.Contains(sync.Message, "campaign_membership_map") || !strings.Contains(sync.Message, "soft-removes") || !strings.Contains(sync.Message, "Task-to-CRM-activity mapping") || !strings.Contains(sync.Message, "salesforce_retry") || !containsString(sync.RequiredFields, "contacts|leads|campaign_member_events|task_events|empty_salesforce_provider_pull")) {
				t.Fatalf("salesforce sync action should disclose native SOQL provider-pull state, got %+v", sync)
			}
			if tc.slug == "pipedrive" && (!strings.Contains(sync.Message, "Pipedrive CRM provider pull") || !containsString(sync.RequiredFields, "persons|deals|organizations|activities|empty_pipedrive_provider_pull")) {
				t.Fatalf("pipedrive sync action should disclose native CRM provider-pull state, got %+v", sync)
			}
			if tc.slug == "zoho-crm" && (!strings.Contains(sync.Message, "Zoho CRM V8 records provider pull") || !containsString(sync.RequiredFields, "contacts|leads|empty_zoho_provider_pull")) {
				t.Fatalf("zoho sync action should disclose native V8 records provider-pull state, got %+v", sync)
			}
			if tc.slug == "microsoft-dynamics-365" && (!strings.Contains(sync.Message, "Dataverse provider pull") || !containsString(sync.RequiredFields, "contacts|leads|empty_dynamics365_provider_pull")) {
				t.Fatalf("dynamics sync action should disclose native Dataverse provider-pull state, got %+v", sync)
			}
			if tc.slug == "keap" && (!strings.Contains(sync.Message, "Keap REST v2 Contacts provider pull") || !containsString(sync.RequiredFields, "contacts|empty_keap_provider_pull")) {
				t.Fatalf("keap sync action should disclose native REST v2 provider-pull state, got %+v", sync)
			}
			if tc.slug == "yotpo" && (!strings.Contains(sync.Message, "Yotpo Reviews REST provider pull") || !strings.Contains(sync.Message, "lookup-only") || !strings.Contains(sync.Message, "order line items") || !strings.Contains(sync.Message, "does not create or refresh commerce product rows") || !strings.Contains(sync.Message, "product_refresh_required") || !strings.Contains(sync.Message, "review_create/review_updated") || !containsString(sync.RequiredFields, "reviews|empty_yotpo_provider_pull")) {
				t.Fatalf("yotpo sync action should disclose native Reviews REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "smile" && (!strings.Contains(sync.Message, "Smile.io Customers/points/rewards REST provider pull") || !strings.Contains(sync.Message, "account-id-routed signed Smile app webhooks") || !strings.Contains(sync.Message, "updated_at_min") || !containsString(sync.RequiredFields, "members|events|empty_smile_provider_pull")) {
				t.Fatalf("smile sync action should disclose native Customers/events REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "zendesk" && (!strings.Contains(sync.Message, "Zendesk Tickets API provider pull") || !strings.Contains(sync.Message, "sparse ticket-id refresh") || !containsString(sync.RequiredFields, "tickets|empty_zendesk_provider_pull")) {
				t.Fatalf("zendesk sync action should disclose native Tickets API provider-pull state, got %+v", sync)
			}
			if tc.slug == "intercom" && (!strings.Contains(sync.Message, "Intercom Conversations REST provider pull") || !strings.Contains(sync.Message, "signed Intercom app webhooks") || !strings.Contains(sync.Message, "contact lookup") || !strings.Contains(sync.Message, "source plus conversation-part support-message rows") || !strings.Contains(sync.Message, "500-part API limit") || !strings.Contains(sync.Message, "intercom_retry") || !containsString(sync.RequiredFields, "conversations|empty_intercom_provider_pull")) {
				t.Fatalf("intercom sync action should disclose native Conversations REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "help-scout" && (!strings.Contains(sync.Message, "Help Scout Conversations REST provider pull") || !strings.Contains(sync.Message, "signed Help Scout app webhooks") || !strings.Contains(sync.Message, "embed=threads") || !strings.Contains(sync.Message, "help_scout_retry") || !containsString(sync.RequiredFields, "conversations|empty_helpscout_provider_pull")) {
				t.Fatalf("help scout sync action should disclose native Conversations REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "freshdesk" && (!strings.Contains(sync.Message, "Freshdesk Tickets REST provider pull") || !strings.Contains(sync.Message, "authenticated Freshdesk automation webhooks") || !strings.Contains(sync.Message, "include=requester") || !strings.Contains(sync.Message, "product_id") || !strings.Contains(sync.Message, "freshdesk_retry") || !containsString(sync.RequiredFields, "tickets|empty_freshdesk_provider_pull")) {
				t.Fatalf("freshdesk sync action should disclose native Tickets REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "gorgias" && (!strings.Contains(sync.Message, "Gorgias Tickets API provider pull") || !strings.Contains(sync.Message, "Shopify/Recharge/order evidence") || !strings.Contains(sync.Message, "sparse ticket-id refresh") || !containsString(sync.RequiredFields, "tickets|empty_gorgias_provider_pull")) {
				t.Fatalf("gorgias sync action should disclose native Tickets API provider-pull state, got %+v", sync)
			}
			if tc.slug == "snowflake" && (!strings.Contains(sync.Message, "manifest run") || !strings.Contains(sync.Message, "provider_driver_attachment=manifest_worker")) {
				t.Fatalf("snowflake sync action should disclose manifest-worker boundary, got %+v", sync)
			}
			if tc.slug == "typeform" && !strings.Contains(sync.Message, "Responses API provider pull") {
				t.Fatalf("typeform sync action should disclose Responses API provider-pull state, got %+v", sync)
			}
			if tc.slug == "fillout" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("fillout sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "jotform" && !strings.Contains(sync.Message, "REST provider pull") {
				t.Fatalf("jotform sync action should disclose REST provider-pull state, got %+v", sync)
			}
			if tc.slug == "webflow" && !strings.Contains(sync.Message, "Data API provider pull") {
				t.Fatalf("webflow sync action should disclose Data API provider-pull state, got %+v", sync)
			}
			if tc.slug == "carrd" && (!strings.Contains(sync.Message, "Custom URL receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("carrd sync action should disclose Custom URL receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "optinmonster" && (!strings.Contains(sync.Message, "Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("optinmonster sync action should disclose Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "privy" && (!strings.Contains(sync.Message, "custom Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("privy sync action should disclose custom Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "convertflow" && (!strings.Contains(sync.Message, "custom Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("convertflow sync action should disclose custom Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "sleeknote" && (!strings.Contains(sync.Message, "custom integration receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("sleeknote sync action should disclose custom integration receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "wisepops" && (!strings.Contains(sync.Message, "signed Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("wisepops sync action should disclose signed Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "poptin" && (!strings.Contains(sync.Message, "Webhooks receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("poptin sync action should disclose Webhooks receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "hello-bar" && (!strings.Contains(sync.Message, "Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("hello bar sync action should disclose Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "landingi" && (!strings.Contains(sync.Message, "Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("landingi sync action should disclose Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "kickofflabs" && (!strings.Contains(sync.Message, "outbound Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("kickofflabs sync action should disclose outbound Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "ninja-forms" && (!strings.Contains(sync.Message, "Webhooks add-on receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("ninja forms sync action should disclose Webhooks action receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "outgrow" && (!strings.Contains(sync.Message, "Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("outgrow sync action should disclose Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "shortstack" && (!strings.Contains(sync.Message, "signed Webhook form integration receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("shortstack sync action should disclose signed Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "riddle" && (!strings.Contains(sync.Message, "Webhook receiver") || strings.Contains(sync.Message, "REST provider pull")) {
				t.Fatalf("riddle sync action should disclose Webhook receiver state without REST-puller claims, got %+v", sync)
			}
			if tc.slug == "facebook-lead-ads" && (!strings.Contains(sync.Message, "Graph provider pull") || !containsString(sync.RequiredFields, "leads|empty_facebook_lead_ads_provider_pull")) {
				t.Fatalf("facebook lead ads sync action should disclose Graph provider-pull state, got %+v", sync)
			}
			if tc.slug == "google-lead-form-extensions" && (!strings.Contains(sync.Message, "Google Ads API provider pull") || !containsString(sync.RequiredFields, "lead_form_submission_data|empty_google_lead_forms_provider_pull")) {
				t.Fatalf("google lead forms sync action should disclose Google Ads provider-pull state, got %+v", sync)
			}

			disconnect, _ := lifecycleAction(item, "disconnect")
			disconnectEndpoint := tc.disconnectEndpoint
			if disconnectEndpoint == "" {
				disconnectEndpoint = strings.Replace(tc.endpoint, "POST ", "DELETE ", 1) + "/{id}"
			}
			if disconnect.DelegatedTo != disconnectEndpoint {
				t.Fatalf("disconnect delegated_to=%q want %q", disconnect.DelegatedTo, disconnectEndpoint)
			}
			if !containsString(disconnect.RequiredFields, "id") || !strings.Contains(disconnect.Message, tc.disconnectMsg) {
				t.Fatalf("unexpected disconnect response: %+v", disconnect)
			}

			contract := runtimeConnectorContractFixture(item)
			if !containsString(contract.AuthModes, tc.authMode) {
				t.Fatalf("contract auth modes missing %q in %+v", tc.authMode, contract.AuthModes)
			}
			if tc.extraAuthMode != "" && !containsString(contract.AuthModes, tc.extraAuthMode) {
				t.Fatalf("contract auth modes missing %q in %+v", tc.extraAuthMode, contract.AuthModes)
			}
			if metaOK && isPostwaveIngestSyncModel(meta.SyncModel) && containsString(contract.AuthModes, "webhook_secret_ref") {
				t.Fatalf("ingest contract should not claim webhook-secret auth before raw-body verification is wired: %+v", contract.AuthModes)
			}
			if metaOK && isPostwaveIngestSyncModel(meta.SyncModel) && !strings.Contains(strings.ToLower(contract.CredentialStorage), "raw credential material") {
				t.Fatalf("ingest contract should clarify reference-only credential handling, got %q", contract.CredentialStorage)
			}
			if metaOK && isPostwaveIngestSyncModel(meta.SyncModel) && !strings.Contains(strings.ToLower(contract.SecretPolicy), "credential reference ids") {
				t.Fatalf("ingest contract should clarify visible reference IDs, got %q", contract.SecretPolicy)
			}
			if metaOK && isPostwaveIngestSyncModel(meta.SyncModel) && !strings.Contains(strings.ToLower(contract.RateLimitPolicy), "ingest") {
				t.Fatalf("ingest contract should use ingest/import rate policy, got %q", contract.RateLimitPolicy)
			}
			if !containsString(contract.DataObjects, tc.syncObject) {
				t.Fatalf("contract data objects missing %q in %+v", tc.syncObject, contract.DataObjects)
			}
			if tc.webhookTopic != "" && !containsString(contract.EventTopics, tc.webhookTopic) {
				t.Fatalf("contract event topics missing %q in %+v", tc.webhookTopic, contract.EventTopics)
			}
			if tc.slug == "snowflake" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "SQL executor") ||
					!strings.Contains(contract.RateLimitPolicy, "remote table polling/materialization") ||
					!containsString(contract.Monitoring, "snowflake_provider_execution") ||
					!containsString(contract.ComplianceGates, "snowflake_live_account_certification_pending") {
					t.Fatalf("snowflake contract should expose local-complete/live-cert-pending export-health slice and remaining gates: %+v", contract)
				}
			}
			if tc.slug == "facebook-lead-ads" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
					t.Fatalf("facebook lead ads contract should expose local-complete/live-cert-pending state: %+v", contract)
				}
				if !strings.Contains(contract.RateLimitPolicy, "/{form_id}/leads") ||
					!strings.Contains(contract.RateLimitPolicy, "explicit sync/backfill") ||
					!strings.Contains(contract.RateLimitPolicy, "X-Hub-Signature-256") ||
					!strings.Contains(contract.RateLimitPolicy, "lead_webhook_events") ||
					!strings.Contains(contract.RateLimitPolicy, "/{leadgen_id}") {
					t.Fatalf("facebook lead ads contract should describe explicit Graph pull rate policy: %+v", contract)
				}
			}
			if tc.slug == "google-lead-form-extensions" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "GoogleAdsService.Search lead_form_submission_data pull/import") ||
					strings.Contains(contract.PublicClaim, "webhook") {
					t.Fatalf("google lead forms contract should expose local-complete/live-cert-pending Search API state without a webhook claim: %+v", contract)
				}
				if containsString(contract.EventTopics, "lead_form_submission") || containsString(contract.EventTopics, "lead.created") {
					t.Fatalf("google lead forms contract should not claim provider lead webhooks yet: %+v", contract.EventTopics)
				}
				if !strings.Contains(contract.RateLimitPolicy, "GoogleAdsService.Search") ||
					!strings.Contains(contract.RateLimitPolicy, "GAQL LIMIT 1000") ||
					!strings.Contains(contract.RateLimitPolicy, "60 days") ||
					!strings.Contains(contract.RateLimitPolicy, "provider_cleanup") {
					t.Fatalf("google lead forms contract should describe Search pull policy: %+v", contract)
				}
			}
			if tc.slug == "carrd" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Carrd Custom URL form receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "webhook_route_token_required") ||
					!containsString(contract.PrivacyActions, "route_token_rotation") {
					t.Fatalf("carrd contract should expose Custom URL receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "optinmonster" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "OptinMonster Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated JSON") ||
					!containsString(contract.ComplianceGates, "optinmonster_webhook_destination_cleanup_operator_managed") ||
					!containsString(contract.PrivacyActions, "optinmonster_webhook_disable") {
					t.Fatalf("optinmonster contract should expose Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "privy" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Privy custom Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "Basic-authenticated JSON") ||
					!containsString(contract.ComplianceGates, "privy_basic_auth_required") ||
					!containsString(contract.PrivacyActions, "privy_custom_webhook_disable") {
					t.Fatalf("privy contract should expose custom Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "convertflow" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "ConvertFlow custom Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated JSON") ||
					!containsString(contract.ComplianceGates, "convertflow_route_token_required") ||
					!containsString(contract.PrivacyActions, "convertflow_webhook_automation_disable") {
					t.Fatalf("convertflow contract should expose custom Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "sleeknote" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Sleeknote custom integration receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "sleeknote_route_token_required") ||
					!containsString(contract.PrivacyActions, "sleeknote_custom_integration_disable") {
					t.Fatalf("sleeknote contract should expose custom integration receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "wisepops" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Wisepops signed Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "X-Wisepops-Signature") ||
					!containsString(contract.ComplianceGates, "wisepops_hmac_signature_required") ||
					!containsString(contract.PrivacyActions, "wisepops_hook_disable") {
					t.Fatalf("wisepops contract should expose signed Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "poptin" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Poptin Webhooks receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "poptin_route_token_required") ||
					!containsString(contract.PrivacyActions, "poptin_webhook_integration_disable") {
					t.Fatalf("poptin contract should expose Webhooks receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "hello-bar" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Hello Bar Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "hello_bar_route_token_required") ||
					!containsString(contract.PrivacyActions, "hello_bar_webhook_disable") {
					t.Fatalf("hello bar contract should expose Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "landingi" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Landingi Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "landingi_route_token_required") ||
					!containsString(contract.PrivacyActions, "landingi_webhook_disable") {
					t.Fatalf("landingi contract should expose Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "kickofflabs" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "KickoffLabs outbound Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "kickofflabs_route_token_required") ||
					!containsString(contract.PrivacyActions, "kickofflabs_outbound_webhook_disable") {
					t.Fatalf("kickofflabs contract should expose outbound Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "ninja-forms" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Ninja Forms Webhooks add-on receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "route-token authenticated GET") ||
					!containsString(contract.ComplianceGates, "ninja_forms_route_token_required") ||
					!containsString(contract.PrivacyActions, "ninja_forms_webhook_action_disable") {
					t.Fatalf("ninja forms contract should expose Webhooks action receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "outgrow" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Outgrow Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "Basic-authenticated or route-token authenticated") ||
					!containsString(contract.ComplianceGates, "outgrow_basic_or_route_token_required") ||
					!containsString(contract.PrivacyActions, "outgrow_webhook_disable") {
					t.Fatalf("outgrow contract should expose Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "shortstack" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "ShortStack Webhook form integration receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "X-SS-Signature") ||
					!containsString(contract.ComplianceGates, "shortstack_hmac_signature_required") ||
					!containsString(contract.PrivacyActions, "shortstack_webhook_integration_disable") {
					t.Fatalf("shortstack contract should expose signed Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
			if tc.slug == "riddle" {
				if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
					!strings.Contains(contract.PublicClaim, "Riddle Webhook receiver") ||
					!strings.Contains(contract.RateLimitPolicy, "signature-key or route-token authenticated") ||
					!containsString(contract.ComplianceGates, "riddle_signature_or_route_token_required") ||
					!containsString(contract.PrivacyActions, "riddle_webhook_disable") {
					t.Fatalf("riddle contract should expose Webhook receiver local-complete/live-cert-pending state: %+v", contract)
				}
			}
		})
	}
}

func TestFirstPartyCommerceWarehouseCatalogTilesHaveProviderMetadata(t *testing.T) {
	for _, item := range CatalogItems() {
		if item.Badge != BadgeNative || item.RuntimeStatus == RuntimePlanned {
			continue
		}
		if !hasSource(item, "commerce") && !hasSource(item, "warehouse") {
			continue
		}
		t.Run(item.Slug, func(t *testing.T) {
			meta, ok := managedProviderMetadataForItem(item)
			if !ok {
				t.Fatalf("native %s tile must be backed by provider metadata", item.Slug)
			}
			if meta.Provider == "" || meta.Name == "" || meta.AuthMode == "" || meta.BasePath == "" {
				t.Fatalf("incomplete provider metadata for %s: %+v", item.Slug, meta)
			}
			if len(meta.RequiredFields) == 0 {
				t.Fatalf("provider metadata for %s should expose setup fields", item.Slug)
			}
			if len(meta.SyncObjects) == 0 {
				t.Fatalf("provider metadata for %s should expose sync objects", item.Slug)
			}
			contract := runtimeConnectorContractFixture(item)
			if !containsString(contract.AuthModes, meta.AuthMode) {
				t.Fatalf("contract for %s missing auth mode %q: %+v", item.Slug, meta.AuthMode, contract.AuthModes)
			}
			if !containsString(contract.DataObjects, meta.SyncObjects[0]) {
				t.Fatalf("contract for %s missing provider sync object %q: %+v", item.Slug, meta.SyncObjects[0], contract.DataObjects)
			}
		})
	}
}

func dataDeleteActionsContain(actions []DataDeleteAction, needle string) bool {
	for _, action := range actions {
		if strings.Contains(action.Path, needle) || strings.Contains(action.Description, needle) {
			return true
		}
	}
	return false
}

func assertLocalCompleteLiveCertPending(t *testing.T, name string, contract ConnectorContract) {
	t.Helper()
	if contract.ImplementationDepth != "native_runtime_complete_live_certification_pending" ||
		!strings.Contains(contract.PublicClaim, "local auth, sync, monitoring, webhook, retry, and lifecycle runtime complete") {
		t.Fatalf("%s contract should expose local-complete/live-cert-pending state: %+v", name, contract)
	}
}
