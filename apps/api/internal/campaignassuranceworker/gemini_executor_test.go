// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
)

func TestProductionGeminiConfigurationsFreezeDistinctPromptSuite(t *testing.T) {
	t.Parallel()
	executor, err := NewGeminiModelExecutor(GeminiExecutorConfig{
		APIKey: "test-key", BaseURL: defaultGeminiBaseURL,
		PricingVersion:                "google-list-2026-08-10",
		InputMicroUSDPerMillionTokens: 1000, OutputMicroUSDPerMillionTokens: 2000,
	})
	if err != nil {
		t.Fatal(err)
	}
	fast, err := ProductionGeminiConfigurations(
		campaignassurance.ProfileFast, "gemini-test", "gemini-test-001",
		executor.Identity(), 30*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	full, err := ProductionGeminiConfigurations(
		campaignassurance.ProfileFull, "gemini-test", "gemini-test-001",
		executor.Identity(), 30*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	calibration, err := ProductionGeminiConfigurations(
		campaignassurance.ProfileCalibration, "gemini-test", "gemini-test-001",
		executor.Identity(), 30*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	// Every profile carries its analyzer ensemble plus exactly one reviewed
	// summarisation configuration. The summariser is a suite member, not a
	// worker-side convention, so a profile that forgot it would ship a run in
	// which SUMMARY_UNSTABLE can never fire.
	if len(fast) != 4 || len(full) != 9 || len(calibration) != 9 {
		t.Fatalf("fast=%d full=%d calibration=%d", len(fast), len(full), len(calibration))
	}
	seenIDs := map[string]struct{}{}
	seenIdentities := map[modeledAnalyzerIdentity]struct{}{}
	summaryCount := 0
	for index, input := range full {
		configuration, err := decodeModeledConfiguration(input.Configuration)
		if err != nil {
			t.Fatalf("configuration[%d]: %v", index, err)
		}
		expectedTemperature := 0.0
		if isSummaryStabilityConfiguration(configuration) {
			summaryCount++
			expectedTemperature = summaryStabilityTemperatureV1
			if input.ID != SummaryStabilityConfigurationID || index != len(full)-1 {
				t.Fatalf("summary configuration is not the last frozen member: index=%d id=%s", index, input.ID)
			}
		}
		if configuration.PromptHash != ProductionPromptSuiteHashV1() ||
			configuration.PromptSuiteVersion != ProductionPromptSuiteVersionV1 ||
			configuration.ModelSuiteVersion != ProductionModelSuiteVersionV1 ||
			configuration.ModelProvider != GeminiModelProvider ||
			configuration.Temperature != expectedTemperature {
			t.Fatalf("configuration[%d] lost frozen identity: %+v", index, configuration)
		}
		seenIDs[input.ID] = struct{}{}
		seenIdentities[modeledAnalyzerIdentity{
			ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
			ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
			PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
			Temperature: configuration.Temperature,
		}] = struct{}{}
	}
	if len(seenIDs) != 9 || len(seenIdentities) != 9 || summaryCount != 1 {
		t.Fatalf("ids=%d analyzer identities=%d summary=%d", len(seenIDs), len(seenIdentities), summaryCount)
	}
	// A summarisation temperature of zero would make every campaign look
	// perfectly stable, so the reviewed value is asserted rather than assumed.
	if summaryStabilityTemperatureV1 <= 0 {
		t.Fatalf("summary temperature = %v; eight identical samples are not a measurement", summaryStabilityTemperatureV1)
	}
	// Moved deliberately when `would_surface_in_digest` became a required field
	// of the extraction schema (F06 surfaceability). The schema is embedded in
	// the prompt, so asking analyzers a new question necessarily changes this
	// hash — which is exactly what this guard is for: a prompt that changes
	// without anyone noticing invalidates every score compared across it.
	//
	// Moved again when the summarisation prompt joined the suite. The frozen
	// summariser instruction bytes are hashed into the manifest, so editing the
	// question campaignchecks asks moves this hash and invalidates every
	// configuration frozen against the old suite — which is the whole reason it
	// was added to the suite rather than smuggled through a prompt field.
	//
	// Previous: 6c1ee80d3a8b694bf20a8e8e4c240a87187cbda254f36d4749fbde3e23aa5309
	// Previous: 47f3dcc5f0788f5519692f9294393eef8738604c7a6d6a8cfe550e2914231430
	if got := ProductionPromptSuiteHashV1(); got != "19b5a392af719e6bac445727f0d4d198b3b2c24595b3d6c89dd1df47efe8dd0f" {
		t.Fatalf("production prompt suite hash drifted: %s", got)
	}
}

func TestGeminiModelExecutorUsesClosedNoToolsRequestAndReturnsProvenance(t *testing.T) {
	t.Parallel()
	var captured geminiGenerateRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1beta/models/gemini-test:generateContent" ||
			r.Header.Get("x-goog-api-key") != "secret-test-key" ||
			r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected request: method=%s path=%s headers=%v", r.Method, r.URL.Path, r.Header)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxGeminiRequestBodyBytes+1))
		if err != nil {
			t.Error(err)
			return
		}
		var topLevel map[string]json.RawMessage
		if err := json.Unmarshal(raw, &topLevel); err != nil {
			t.Error(err)
			return
		}
		if _, exists := topLevel["tools"]; exists || len(topLevel) != 3 || strings.Contains(string(raw), "secret-test-key") {
			t.Errorf("request exposed tools, secret, or unknown top-level fields: %s", raw)
		}
		if err := json.Unmarshal(raw, &captured); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{
  "candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"{\"schema_version\":1}"}]}}],
  "usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":40},
  "modelVersion":"gemini-test-001"
}`)
	}))
	defer server.Close()
	executor, configuration := testGeminiExecutorAndConfiguration(t, server.URL+"/v1beta", server.Client())
	request := testGeminiModelRequest(configuration)
	result, err := executor.Execute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if string(result.RawExtraction) != `{"schema_version":1}` || result.InputTokens != 100 ||
		result.OutputTokens != 40 || result.CostMicrounits != 2 ||
		result.Provenance.ExecutorID != executor.Identity().ID ||
		result.Provenance.ExecutorVersion != executor.Identity().Version ||
		result.Provenance.ModelProvider != GeminiModelProvider ||
		result.Provenance.ModelID != "gemini-test" ||
		result.Provenance.ModelVersion != "gemini-test-001" ||
		result.Provenance.PromptVersion != configuration.PromptVersion ||
		result.Provenance.PromptHash != ProductionPromptSuiteHashV1() ||
		result.Provenance.SeedValue != configuration.SeedValue ||
		result.Provenance.Temperature != 0 {
		t.Fatalf("result=%+v", result)
	}
	if len(captured.SystemInstruction.Parts) != 1 ||
		!strings.Contains(captured.SystemInstruction.Parts[0].Text, "untrusted quoted data") ||
		!strings.Contains(captured.SystemInstruction.Parts[0].Text, "no browser") ||
		len(captured.Contents) != 1 || len(captured.Contents[0].Parts) != 1 ||
		captured.GenerationConfig.Seed != 4101 || captured.GenerationConfig.Temperature != 0 ||
		captured.GenerationConfig.ResponseMIMEType != "application/json" ||
		captured.GenerationConfig.CandidateCount != 1 {
		t.Fatalf("provider request lost closed execution controls: %+v", captured)
	}
	var payload geminiPromptPayload
	if err := json.Unmarshal([]byte(captured.Contents[0].Parts[0].Text), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.InvocationID != request.InvocationID || payload.InputManifestHash != request.InputManifestHash ||
		!reflect.DeepEqual(payload.AllowedEvidenceIDs, request.AllowedEvidenceIDs) ||
		!jsonSemanticEqual(payload.ExtractionSchema, request.ExtractionSchema) ||
		len(payload.Representations) != 5 || payload.Representations[0].ID != "subject" ||
		payload.Representations[1].ID != "text_plain" || payload.Representations[4].ID != "mime" {
		t.Fatalf("prompt payload lost exact evidence or order: %+v", payload)
	}
}

func TestWorkerExecutesProductionGeminiSuiteThroughDurableEvidenceBoundary(t *testing.T) {
	t.Parallel()
	var calls, summaryPrompts atomic.Int64
	rawExtraction := string(mustJSON(exactModeledExtraction(false)))
	var fixtureHTML, fixtureText string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var request geminiGenerateRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, maxGeminiRequestBodyBytes+1)).Decode(&request); err != nil {
			t.Error(err)
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		seed := request.GenerationConfig.Seed
		answer := rawExtraction
		switch {
		case seed >= 4101 && seed <= 4103:
			summaryPrompts.Add(0)
		case seed >= productionSummaryPromptDefinitionV1.Seed+1 &&
			seed <= productionSummaryPromptDefinitionV1.Seed+int64(campaignchecks.SummaryRunCount):
			// The summarisation member reaches the provider as the frozen
			// reviewed question and nothing else.
			text := request.Contents[0].Parts[0].Text
			if text != campaignchecks.RenderSummaryPromptV1(campaignchecks.SummaryRequest{
				Run: 1, RunCount: campaignchecks.SummaryRunCount,
				PromptVersion: campaignchecks.SummaryPromptVersionV1,
				Subject:       "Assurance fixture", PlainText: fixtureText, HTML: fixtureHTML,
			}) {
				t.Errorf("summarisation run did not ask the frozen reviewed question:\n%s", text)
			}
			summaryPrompts.Add(1)
			answer = `{"one_line_summary":"Assurance fixture continues","primary_intent":"announcement","primary_action":"Continue"}`
		default:
			t.Errorf("unexpected fast-suite seed %d", seed)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"candidates": []any{map[string]any{
				"finishReason": "STOP",
				"content":      map[string]any{"parts": []any{map[string]any{"text": answer}}},
			}},
			"usageMetadata": map[string]any{"promptTokenCount": 100, "candidatesTokenCount": 40},
			"modelVersion":  "gemini-test-001",
		})
	}))
	defer server.Close()
	executor, _ := testGeminiExecutorAndConfiguration(t, server.URL+"/v1beta", server.Client())
	inputs, err := ProductionGeminiConfigurations(
		campaignassurance.ProfileFast, "gemini-test", "gemini-test-001",
		executor.Identity(), 2*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture := newFixture(t, campaignassurance.SourceModeled)
	fixture.artifacts.revision.FactContract = mustTestJSON(t, modeledTestContract(t))
	fixtureHTML, fixtureText = fixture.compiled.HTML, fixture.compiled.Text
	run := &fixture.assurance.claimed.Run
	run.ModelSuiteVersion = ProductionModelSuiteVersionV1
	run.PromptSuiteVersion = ProductionPromptSuiteVersionV1
	run.PromptSuiteHash = ProductionPromptSuiteHashV1()
	run.NormalizationVersion = campaigncomprehension.ExtractionNormalizationVersionV1
	run.ScoringVersion = campaigncomprehension.ScoreVersionV1
	run.MethodologyVersion = "postwave.predicted-agent-comprehension.methodology.v1"
	run.RequiredConfigurationCount = len(inputs)
	run.RequiredExtractionCount = len(inputs)
	fixture.assurance.claimed.Configurations = nil
	fixture.assurance.claimed.Targets = nil
	for index, input := range inputs {
		hash, err := canonicalConfigurationHash(input.Configuration)
		if err != nil {
			t.Fatal(err)
		}
		fixture.assurance.claimed.Configurations = append(
			fixture.assurance.claimed.Configurations,
			campaignassurance.RunConfiguration{
				TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
				Ordinal: index + 1, ID: input.ID, SourceClass: input.SourceClass,
				ConfigurationHash: hash, Configuration: input.Configuration,
			},
		)
		fixture.assurance.claimed.Targets = append(
			fixture.assurance.claimed.Targets,
			campaignassurance.RunTarget{
				TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
				SendPlanID: testPlanID, ArtifactID: testArtifactID,
				ConfigurationID: input.ID, Ordinal: index + 1,
				SourceClass: input.SourceClass, ConfigurationHash: hash,
				OutboundMIMEHash: fixture.compiled.Artifact.OutboundMIMEHash,
			},
		)
	}
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(
		context.Background(), Command{TenantID: testTenantID, RunID: testRunID},
	)
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	// Three analyzer invocations plus the eight summarisation runs: the model
	// is reached through the frozen suite for BOTH halves of F06.
	wantCalls := int64(3 + campaignchecks.SummaryRunCount)
	if calls.Load() != wantCalls || summaryPrompts.Load() != int64(campaignchecks.SummaryRunCount) ||
		result.Outcome != OutcomeComplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GatePass ||
		fixture.assurance.finalizeInput.OverallScore == nil ||
		*fixture.assurance.finalizeInput.OverallScore != 100 ||
		len(fixture.assurance.extractions) != 4 {
		t.Fatalf("calls=%d summary=%d result=%+v final=%+v extractions=%+v", calls.Load(),
			summaryPrompts.Load(), result, fixture.assurance.finalizeInput, fixture.assurance.extractions)
	}
	summaryExtractions := 0
	for _, extraction := range fixture.assurance.extractions {
		if extraction.ModelProvider != GeminiModelProvider ||
			extraction.ModelVersion != "gemini-test-001" ||
			extraction.RawOutputObjectRef == "" || extraction.RawOutputExpiresAt == nil {
			t.Fatalf("durable extraction lost provider evidence: %+v", extraction)
		}
		if extraction.ConfigurationID == SummaryStabilityConfigurationID {
			summaryExtractions++
			if extraction.Status != campaignassurance.ExtractionComplete ||
				extraction.InputTokens != 100*int64(campaignchecks.SummaryRunCount) ||
				!bytesContainAll(extraction.NormalizedExtraction,
					`"kind":"summary_stability_report"`,
					`"assessment_status":"pass"`,
					`"compared_pairs":28`) {
				t.Fatalf("summary stability extraction lost its measurement: %+v", extraction)
			}
			continue
		}
		if extraction.InputTokens != 100 || extraction.OutputTokens != 40 ||
			extraction.CostMicrounits != 2 {
			t.Fatalf("durable extraction lost provider metering: %+v", extraction)
		}
	}
	if summaryExtractions != 1 {
		t.Fatalf("summary stability extractions = %d", summaryExtractions)
	}
}

func jsonSemanticEqual(left, right []byte) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil &&
		reflect.DeepEqual(leftValue, rightValue)
}

func TestGeminiModelExecutorFailsClosedForProviderAndOutputFailures(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		status   int
		body     string
		wantKind ModelFailureKind
		wantCode string
	}{
		{name: "rate limit", status: http.StatusTooManyRequests, body: `{"error":{"message":"secret"}}`, wantKind: ModelFailureRetryable, wantCode: "provider_retryable"},
		{name: "auth", status: http.StatusUnauthorized, body: `{}`, wantKind: ModelFailureUnavailable, wantCode: "provider_unavailable"},
		{name: "bad request", status: http.StatusBadRequest, body: `{}`, wantKind: ModelFailureError, wantCode: "provider_request_rejected"},
		{name: "blocked", status: http.StatusOK, body: `{"promptFeedback":{"blockReason":"SAFETY"},"modelVersion":"gemini-test-001"}`, wantKind: ModelFailureError, wantCode: "provider_prompt_blocked"},
		{name: "truncated", status: http.StatusOK, body: `{"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"{}"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1},"modelVersion":"gemini-test-001"}`, wantKind: ModelFailureError, wantCode: "provider_completion_incomplete"},
		{name: "non text part", status: http.StatusOK, body: `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"functionCall":{"name":"forbidden"}}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1},"modelVersion":"gemini-test-001"}`, wantKind: ModelFailureError, wantCode: "provider_output_nontext"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			executor, configuration := testGeminiExecutorAndConfiguration(t, server.URL, server.Client())
			_, err := executor.Execute(context.Background(), testGeminiModelRequest(configuration))
			var failure *ModelExecutionFailure
			if !errors.As(err, &failure) || failure.Kind != test.wantKind || failure.Code != test.wantCode ||
				strings.Contains(err.Error(), "secret") {
				t.Fatalf("error=%v failure=%+v", err, failure)
			}
		})
	}
}

func TestGeminiModelExecutorRejectsConfigurationDriftBeforeNetwork(t *testing.T) {
	t.Parallel()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	defer server.Close()
	executor, configuration := testGeminiExecutorAndConfiguration(t, server.URL, server.Client())
	tests := []struct {
		name   string
		mutate func(*ModeledConfigurationV1)
	}{
		{name: "prompt", mutate: func(value *ModeledConfigurationV1) { value.PromptVersion = "unknown.v1" }},
		{name: "suite hash", mutate: func(value *ModeledConfigurationV1) { value.PromptHash = strings.Repeat("0", 64) }},
		{name: "seed", mutate: func(value *ModeledConfigurationV1) { value.SeedValue = "9999" }},
		{name: "temperature", mutate: func(value *ModeledConfigurationV1) { value.Temperature = 0.1 }},
		{name: "provider", mutate: func(value *ModeledConfigurationV1) { value.ModelProvider = "other" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := testGeminiModelRequest(configuration)
			test.mutate(&request.Configuration)
			_, err := executor.Execute(context.Background(), request)
			var failure *ModelExecutionFailure
			if !errors.As(err, &failure) || failure.Code != "frozen_configuration_mismatch" {
				t.Fatalf("error=%v", err)
			}
		})
	}
	if calls != 0 {
		t.Fatalf("configuration drift reached provider %d times", calls)
	}
}

func TestGeminiExecutorConfigurationAndEndpointValidation(t *testing.T) {
	t.Parallel()
	valid := GeminiExecutorConfig{
		APIKey: "key", PricingVersion: "pricing-v1",
		InputMicroUSDPerMillionTokens: 1, OutputMicroUSDPerMillionTokens: 1,
	}
	if _, err := NewGeminiModelExecutor(valid); err != nil {
		t.Fatal(err)
	}
	invalid := []GeminiExecutorConfig{
		{},
		{APIKey: "key", PricingVersion: "pricing-v1", InputMicroUSDPerMillionTokens: 1},
		{APIKey: "key", PricingVersion: "Pricing V1", InputMicroUSDPerMillionTokens: 1, OutputMicroUSDPerMillionTokens: 1},
		{APIKey: "key", BaseURL: "file:///tmp/provider", PricingVersion: "pricing-v1", InputMicroUSDPerMillionTokens: 1, OutputMicroUSDPerMillionTokens: 1},
		{APIKey: "key", BaseURL: "http://generativelanguage.googleapis.com/v1beta", PricingVersion: "pricing-v1", InputMicroUSDPerMillionTokens: 1, OutputMicroUSDPerMillionTokens: 1},
		{APIKey: "key", BaseURL: "https://example.test/v1beta", PricingVersion: "pricing-v1", InputMicroUSDPerMillionTokens: 1, OutputMicroUSDPerMillionTokens: 1},
		{APIKey: "key", BaseURL: "https://generativelanguage.googleapis.com/other", PricingVersion: "pricing-v1", InputMicroUSDPerMillionTokens: 1, OutputMicroUSDPerMillionTokens: 1},
	}
	for index, configuration := range invalid {
		if _, err := NewGeminiModelExecutor(configuration); err == nil {
			t.Fatalf("invalid configuration[%d] accepted", index)
		}
	}
	for _, unsafe := range []string{
		"https://user:pass@generativelanguage.googleapis.com/v1beta",
		"https://generativelanguage.googleapis.com/v1beta?q=secret",
		"https://example.test/v1beta", "http://generativelanguage.googleapis.com/v1beta", "file:///tmp",
	} {
		if _, err := safeGeminiEndpoint(unsafe, "gemini-test"); err == nil {
			t.Fatalf("unsafe endpoint accepted: %s", unsafe)
		}
	}
	if _, err := safeGeminiEndpoint(defaultGeminiBaseURL, "../../secret"); err == nil {
		t.Fatal("unsafe model id accepted")
	}
}

func TestGeminiModelExecutorNeverFollowsProviderRedirect(t *testing.T) {
	t.Parallel()
	var targetCalls atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		targetCalls.Add(1)
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	executor, configuration := testGeminiExecutorAndConfiguration(t, redirect.URL, redirect.Client())
	_, err := executor.Execute(context.Background(), testGeminiModelRequest(configuration))
	var failure *ModelExecutionFailure
	if !errors.As(err, &failure) || failure.Code != "provider_request_rejected" || targetCalls.Load() != 0 {
		t.Fatalf("error=%v failure=%+v target_calls=%d", err, failure, targetCalls.Load())
	}
}

func TestGeminiTokenCostIsConservativeAndOverflowSafe(t *testing.T) {
	t.Parallel()
	tests := []struct {
		tokens, price int64
		want          int64
		wantError     bool
	}{
		{tokens: 0, price: 1000, want: 0},
		{tokens: 1, price: 1, want: 1},
		{tokens: 1_000_000, price: 1000, want: 1000},
		{tokens: maxGeminiProviderTokenCount + 1, price: maxGeminiPricePerMillion, wantError: true},
	}
	for _, test := range tests {
		got, err := tokenCostMicrounits(test.tokens, test.price)
		if (err != nil) != test.wantError || (!test.wantError && got != test.want) {
			t.Fatalf("tokens=%d price=%d got=%d err=%v", test.tokens, test.price, got, err)
		}
	}
}

func testGeminiExecutorAndConfiguration(
	t *testing.T,
	baseURL string,
	httpClient *http.Client,
) (*GeminiModelExecutor, ModeledConfigurationV1) {
	t.Helper()
	executor, err := NewGeminiModelExecutor(GeminiExecutorConfig{
		APIKey: "secret-test-key", BaseURL: baseURL,
		PricingVersion:                 "test-pricing-v1",
		InputMicroUSDPerMillionTokens:  1000,
		OutputMicroUSDPerMillionTokens: 2000,
		HTTPClient:                     httpClient,
		allowLoopbackForTests:          true,
	})
	if err != nil {
		t.Fatal(err)
	}
	inputs, err := ProductionGeminiConfigurations(
		campaignassurance.ProfileFast, "gemini-test", "gemini-test-001",
		executor.Identity(), 30*time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	configuration, err := decodeModeledConfiguration(inputs[0].Configuration)
	if err != nil {
		t.Fatal(err)
	}
	return executor, configuration
}

func testGeminiModelRequest(configuration ModeledConfigurationV1) ModelRequest {
	return ModelRequest{
		InvocationID:      strings.Repeat("a", 64),
		InputManifestHash: strings.Repeat("b", 64),
		Configuration:     configuration,
		Vocabulary: RecoveryVocabularyV1{
			SchemaVersion: 1,
			PrimaryAction: RecoveryActionSlot{ActionID: "register", BlockID: "primary"},
			FactSlots:     []RecoveryFactSlot{{FactID: "deadline", Type: "datetime"}},
		},
		Evidence: []ModelEvidence{
			{ID: "subject", Representation: "subject", SHA256: strings.Repeat("c", 64)},
			{ID: "text_plain", Representation: "text_plain", SHA256: strings.Repeat("d", 64)},
		},
		AllowedEvidenceIDs: []string{"subject", "text_plain", "html", "mime", "structured_data"},
		ExtractionSchema:   campaigncomprehension.ExtractionJSONSchemaV1(),
		MaxOutputBytes:     campaigncomprehension.MaxExtractionBytes,
		Artifact: ModelArtifact{
			Subject:        "Launch invitation",
			PlainText:      "Register by 2026-08-14T16:00:00+05:30.",
			HTML:           `<html><body><a href="https://example.test/register">Register</a></body></html>`,
			StructuredData: json.RawMessage(`{"@context":"https://schema.org"}`),
			RFC822:         []byte("Subject: Launch invitation\r\nContent-Type: text/plain\r\n\r\nRegister now.\r\n"),
		},
	}
}
