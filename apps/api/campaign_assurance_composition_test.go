// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceapi"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/routeauth"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

func TestCampaignAssuranceControlPlaneQueueOwnerIsCanonicalUUID(t *testing.T) {
	t.Parallel()
	parsed, err := uuid.Parse(campaignAssuranceControlPlaneOwnerID)
	if err != nil || parsed.String() != campaignAssuranceControlPlaneOwnerID {
		t.Fatalf("control-plane queue owner=%q err=%v", campaignAssuranceControlPlaneOwnerID, err)
	}
}

func TestCampaignAssuranceProductionRegistryFreezesHonestProfiles(t *testing.T) {
	t.Parallel()
	registry, err := newCampaignAssuranceSuiteRegistry()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		profile string
		want    []string
	}{
		{campaignassurance.ProfileFast, []string{campaignassurance.SourceDeterministic}},
		{campaignassurance.ProfileFull, []string{
			campaignassurance.SourceDeterministic, campaignassurance.SourceModeled,
		}},
		{campaignassurance.ProfileCalibration, []string{
			campaignassurance.SourceDeterministic, campaignassurance.SourceModeled,
			campaignassurance.SourceControlledObservation,
		}},
	}
	for _, test := range tests {
		definition, ok := registry.Resolve(test.profile)
		if !ok {
			t.Fatalf("profile %q missing", test.profile)
		}
		var sources []string
		for _, configuration := range definition.Configurations {
			sources = append(sources, configuration.SourceClass)
		}
		if !reflect.DeepEqual(sources, test.want) {
			t.Fatalf("profile %q sources=%v want=%v", test.profile, sources, test.want)
		}
		if definition.Configurations[0].ID != campaignassuranceworker.DeterministicConfigurationID ||
			definition.GatePolicyVersion == "" || len(definition.PromptSuiteHash) != 64 {
			t.Fatalf("profile %q methodology=%+v", test.profile, definition)
		}
	}
}

func TestCampaignAssuranceRuntimeDefaultsOffWithoutTouchingDependencies(t *testing.T) {
	t.Parallel()
	runtime, err := initializeCampaignAssuranceRuntime(context.Background(), false, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.enabled() || runtime.http == nil || runtime.http.Service != nil {
		t.Fatalf("default-off runtime=%+v", runtime)
	}
}

func TestCampaignAssuranceRuntimeFailsClosedWhenEnabledWithoutPrerequisites(t *testing.T) {
	t.Parallel()
	if _, err := initializeCampaignAssuranceRuntime(context.Background(), true, nil, nil, nil); err == nil {
		t.Fatal("enabled runtime accepted missing database/object store")
	}
}

func TestCampaignAssuranceModeledRuntimeRequiresExplicitCompleteConfiguration(t *testing.T) {
	keys := []string{
		"POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED",
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_ID",
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_VERSION",
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION",
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS",
		"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS",
		"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_TIMEOUT",
	}
	for _, key := range keys {
		t.Setenv(key, "")
	}
	disabled, err := loadCampaignAssuranceModeledRuntimeFromEnvironment()
	if err != nil || disabled.enabled || disabled.executor != nil || len(disabled.configurations) != 0 {
		t.Fatalf("disabled runtime=%+v err=%v", disabled, err)
	}
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED", "true")
	if _, err := loadCampaignAssuranceModeledRuntimeFromEnvironment(); err == nil {
		t.Fatal("explicitly enabled modeled runtime accepted missing pricing and model contract")
	}
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_ID", "gemini-test")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_MODEL_VERSION", "gemini-test-001")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_PRICING_VERSION", "test-pricing-v1")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_INPUT_MICROUSD_PER_MILLION_TOKENS", "1000")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_OUTPUT_MICROUSD_PER_MILLION_TOKENS", "2000")
	t.Setenv("POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_TIMEOUT", "30s")
	modeled, err := loadCampaignAssuranceModeledRuntimeFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if !modeled.enabled || modeled.executor != nil || modeled.identity.ID != campaignassuranceworker.GeminiModelExecutorID ||
		modeled.modelID != "gemini-test" ||
		modeled.modelVersion != "gemini-test-001" || modeled.pricingVersion != "test-pricing-v1" ||
		// Each profile is its analyzer ensemble plus the one reviewed
		// summarisation configuration that makes SUMMARY_UNSTABLE reachable.
		len(modeled.configurations[campaignassurance.ProfileFast]) != 4 ||
		len(modeled.configurations[campaignassurance.ProfileFull]) != 9 ||
		len(modeled.configurations[campaignassurance.ProfileCalibration]) != 9 {
		t.Fatalf("modeled runtime=%+v", modeled)
	}
	registry, err := newCampaignAssuranceSuiteRegistryWithModeled(modeled)
	if err != nil {
		t.Fatal(err)
	}
	wantCounts := map[string]int{
		campaignassurance.ProfileFast:        5,
		campaignassurance.ProfileFull:        10,
		campaignassurance.ProfileCalibration: 11,
	}
	for profile, wantCount := range wantCounts {
		definition, ok := registry.Resolve(profile)
		if !ok || len(definition.Configurations) != wantCount ||
			definition.ModelSuiteVersion != campaignassuranceworker.ProductionModelSuiteVersionV1 ||
			definition.PromptSuiteVersion != campaignassuranceworker.ProductionPromptSuiteVersionV1 ||
			definition.PromptSuiteHash != campaignassuranceworker.ProductionPromptSuiteHashV1() ||
			definition.NormalizationVersion != "campaign-comprehension-extraction-normalization-v1" ||
			definition.ScoringVersion != "campaign-comprehension-score-v1" {
			t.Fatalf("profile=%s definition=%+v found=%v", profile, definition, ok)
		}
	}
	t.Setenv("POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_MODELED", "not-a-boolean")
	if _, err := loadCampaignAssuranceModeledRuntimeFromEnvironment(); err == nil {
		t.Fatal("invalid enable flag was accepted")
	}
}

func TestCampaignAssuranceRuntimeStartsWithValidatedDurableDependencies_DB(t *testing.T) {
	url := compositionTestDatabaseURL(t, "POSTWAVE_ASSURANCE_QUEUE_TEST_DATABASE_URL")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	runtime, err := initializeCampaignAssuranceRuntime(
		ctx, true, pool, uploads.NewMemoryStore(), nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !runtime.enabled() || runtime.http.Preparer == nil || runtime.http.Service == nil {
		t.Fatalf("enabled runtime=%+v", runtime)
	}
}

func TestCampaignAssurancePromptIdentityIsStableAndProfileSpecific(t *testing.T) {
	t.Parallel()
	fast := campaignAssurancePromptSuiteHash(campaignassurance.ProfileFast)
	if fast != campaignAssurancePromptSuiteHash(campaignassurance.ProfileFast) ||
		fast == campaignAssurancePromptSuiteHash(campaignassurance.ProfileFull) || len(fast) != 64 {
		t.Fatalf("prompt hash identities fast=%q full=%q", fast,
			campaignAssurancePromptSuiteHash(campaignassurance.ProfileFull))
	}
}

// Lean deployments (staging) run without the assurance runtime, and the
// campaign editor asks for the receipt on every load. The answer used to be
// the sanitized {"code":"internal_error"} envelope, cached for ten seconds
// under the authenticated-read policy — indistinguishable from a crash, so
// the editor showed a red error and a Retry button that could never work.
// This serves the disabled runtime through route authorization and the
// authenticated read-cache middleware, as production mounts it.
func TestCampaignAssuranceAnswersNotEnabledThroughTheStackWhenRuntimeIsOff(t *testing.T) {
	t.Parallel()
	runtime, err := initializeCampaignAssuranceRuntime(context.Background(), false, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			const tenantID = "4f7c2d1e-8a9b-4c3d-9e2f-1a0b3c4d5e6f"
			ctx := middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID})
			ctx = middleware.WithUser(ctx, &middleware.User{
				ID: "8d6e5f4a-3b2c-4d1e-8f9a-0b1c2d3e4f5a", TenantID: tenantID, Role: "editor",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	router.Use(routeauth.Middleware)
	router.Use(httpcache.Conditional())
	router.Use(httpcache.WithPolicy(httpcache.AuthRead()))
	runtime.MountRead(router)
	runtime.MountWrite(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	campaign := uuid.NewString()
	for _, request := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/campaigns/" + campaign + "/assurance"},
		{http.MethodPost, "/api/v1/campaigns/" + campaign + "/assurance-runs"},
	} {
		outgoing, err := http.NewRequest(request.method, server.URL+request.path, strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		outgoing.Header.Set("Content-Type", "application/json")
		outgoing.Header.Set("Idempotency-Key", uuid.NewString())
		response, err := http.DefaultClient.Do(outgoing)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("%s %s: status = %d, want 503; body=%s", request.method, request.path, response.StatusCode, raw)
		}
		if got := response.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("%s %s: Cache-Control = %q, want no-store", request.method, request.path, got)
		}
		var body struct {
			Error struct {
				Code      string `json:"code"`
				Message   string `json:"message"`
				Retryable *bool  `json:"retryable"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode: %v; body=%s", err, raw)
		}
		if body.Error.Code != campaignassuranceapi.NotEnabledCode ||
			body.Error.Retryable == nil || *body.Error.Retryable {
			t.Fatalf("%s %s: error = %+v; body=%s", request.method, request.path, body.Error, raw)
		}
	}
}

func TestCampaignAssuranceRoutesStayMountedAndAuthorizationClassifiedWhenRuntimeIsOff(t *testing.T) {
	t.Parallel()
	runtime, err := initializeCampaignAssuranceRuntime(context.Background(), false, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	runtime.MountRead(router)
	runtime.MountWrite(router)
	mounted := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	wantMounted := []string{
		"GET /api/v1/campaigns/{id}/assurance",
		"GET /api/v1/campaigns/{id}/assurance-runs/{runID}",
		"GET /api/v1/campaigns/{id}/assurance-runs/{runID}/manifest",
		"GET /api/v1/campaigns/{id}/assurance-runs/{runID}/evidence",
		"GET /api/v1/campaigns/{id}/assurance-runs/{runID}/events",
		"POST /api/v1/campaigns/{id}/assurance-runs",
		"POST /api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/overrides",
		"POST /api/v1/campaigns/{id}/assurance-runs/{runID}/findings/{findingID}/appeals",
		"POST /api/v1/campaigns/{id}/assurance-runs/{runID}/cancel",
	}
	for _, want := range wantMounted {
		if !mounted[want] {
			t.Errorf("route %q is not mounted: %v", want, mounted)
		}
	}
	// Routeauth remains the authoritative exact inventory. This test pins the
	// public set and its least-privilege floors even while handlers return 503.
	tests := []struct {
		method, path, role, mode string
		scopes                   []string
	}{
		{"GET", "/api/v1/campaigns/c/assurance", "viewer", routeauth.ScopeModeAny, []string{"read:campaigns"}},
		{"GET", "/api/v1/campaigns/c/assurance-runs/r/evidence", "viewer", routeauth.ScopeModeAny, []string{"read:campaigns"}},
		{"POST", "/api/v1/campaigns/c/assurance-runs", "editor", routeauth.ScopeModeAny, []string{"write:campaigns"}},
		{"POST", "/api/v1/campaigns/c/assurance-runs/r/findings/f/appeals", "admin", routeauth.ScopeModeAll, []string{"write:campaigns", "send:transactional"}},
	}
	for _, test := range tests {
		policy, ok := routeauth.PolicyFor(test.method, test.path)
		if !ok || policy.SessionMinimumRole != test.role || policy.APIKeyScopeMode != test.mode ||
			!reflect.DeepEqual(policy.APIKeyScopes, test.scopes) {
			t.Fatalf("policy %s %s = %+v found=%v", test.method, test.path, policy, ok)
		}
	}
}

func TestMainComposesCampaignAssuranceReadsAndWritesInsideSharedStacks(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	// Both authenticated groups now mount the identical shared stack — the
	// per-key rate limit and call recorder moved into authenticatedRouteStack
	// itself, so the two call sites are byte-identical and are told apart by
	// the numbered comment that labels each group.
	readStack := strings.Index(source, "// Authenticated group 1/2:")
	readMount := strings.Index(source, "campaignAssuranceRuntime.MountRead(r)")
	writeStack := strings.Index(source, "// Authenticated group 2/2:")
	if readStack < 0 || writeStack < 0 {
		t.Fatalf("authenticated group markers not found: read=%d write=%d", readStack, writeStack)
	}
	idempotency := strings.Index(source[writeStack:], "r.Use(idempotentRoutes)")
	writeMount := strings.Index(source, "campaignAssuranceRuntime.MountWrite(r)")
	if readStack < 0 || readMount <= readStack || writeStack <= readMount ||
		idempotency < 0 || writeMount <= writeStack+idempotency {
		t.Fatalf("assurance route composition order is unsafe: readStack=%d readMount=%d writeStack=%d idempotency=%d writeMount=%d",
			readStack, readMount, writeStack, idempotency, writeMount)
	}
}

func TestMainKeepsCampaignAssuranceExecutionOutOfTheAPIProcess(t *testing.T) {
	t.Parallel()
	root := readAPICompositionRoot(t)
	source := root.main
	if !strings.Contains(source, "campaign assurance control plane enabled") {
		t.Fatal("API does not identify its Campaign Assurance control-plane role")
	}
	for _, forbidden := range []string{
		`safego.Go(logger, "campaign-assurance-worker"`,
		`safego.Go(logger, "campaign-assurance-image-retention"`,
		"campaignAssuranceRuntime.RunImageRetention(outboxCtx)",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("API process still owns Campaign Assurance execution capability %q", forbidden)
		}
	}
}
