// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

type modelExecutorFake struct {
	mu       sync.Mutex
	identity ModelExecutorIdentity
	requests []ModelRequest
	execute  func(context.Context, ModelRequest) (ModelResult, error)
}

type readOnlyObjectReader struct{ delegate *objectFake }

func (r *readOnlyObjectReader) Get(ctx context.Context, tenantID, rest string) (io.ReadCloser, string, error) {
	return r.delegate.Get(ctx, tenantID, rest)
}

type failingRawOutputStore struct {
	mu   sync.Mutex
	puts int
}

func (*failingRawOutputStore) CampaignAssuranceRawOutputStore() {}

func (*failingRawOutputStore) Get(context.Context, string, string) (io.ReadCloser, string, error) {
	return nil, "", errors.New("raw output store unavailable")
}

func (s *failingRawOutputStore) Put(context.Context, string, string, string, io.Reader) (string, error) {
	s.mu.Lock()
	s.puts++
	s.mu.Unlock()
	return "", errors.New("raw output store unavailable")
}

func (*failingRawOutputStore) Delete(context.Context, string, string) error { return nil }

func (f *modelExecutorFake) Identity() ModelExecutorIdentity {
	identity := f.identity
	if identity.MaximumCostMicrounits == 0 {
		identity.MaximumCostMicrounits = 1_000
	}
	return identity
}

func (f *modelExecutorFake) Execute(ctx context.Context, request ModelRequest) (ModelResult, error) {
	f.mu.Lock()
	f.requests = append(f.requests, request)
	execute := f.execute
	f.mu.Unlock()
	return execute(ctx, request)
}

func (f *modelExecutorFake) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func TestWorkerExecutesEvidenceBoundModeledEnsembleAndBlocksContradiction(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	contract := modeledTestContract(t)
	configureModeledEnsemble(t, &fixture, contract, 2, 2*time.Second)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
	}
	executor.execute = func(_ context.Context, request ModelRequest) (ModelResult, error) {
		if request.TenantID != testTenantID || request.RunID != "" || request.AttemptCount != 0 ||
			request.BudgetInvocationID != "" || len(request.CacheKey) != 64 ||
			request.ArtifactID != testArtifactID || request.ScenarioID == "" ||
			request.ConfigurationHash == "" || request.OutboundMIMEHash != fixture.compiled.Artifact.OutboundMIMEHash ||
			len(request.InvocationID) != 64 || len(request.InputManifestHash) != 64 ||
			request.MaxOutputBytes != campaigncomprehension.MaxExtractionBytes ||
			len(request.Artifact.RFC822) == 0 || request.Artifact.Subject != "Assurance fixture" ||
			request.Vocabulary.PrimaryAction.ActionID != "continue" ||
			request.Vocabulary.PrimaryAction.BlockID != "primary_action" ||
			len(request.Vocabulary.FactSlots) != 0 || !containsString(request.AllowedEvidenceIDs, "subject") {
			t.Fatalf("modeled request lost exact or stripped identity: %+v", request)
		}
		extraction := exactModeledExtraction(request.ConfigurationID == "modeled.sample-b")
		raw, err := json.Marshal(extraction)
		if err != nil {
			t.Fatal(err)
		}
		return successfulModelResult(request.Configuration, raw), nil
	}
	fixture.worker.ModelExecutor = executor

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeComplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateBlock || result.BlockerCount != 1 ||
		executor.requestCount() != 2 {
		t.Fatalf("result=%+v requests=%d", result, executor.requestCount())
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if len(fixture.assurance.extractions) != 2 {
		t.Fatalf("extractions=%+v", fixture.assurance.extractions)
	}
	for _, extraction := range fixture.assurance.extractions {
		if extraction.Status != campaignassurance.ExtractionComplete ||
			extraction.ModelProvider != "test-provider" || extraction.ModelID != "test-model" ||
			extraction.PromptHash != strings.Repeat("f", 64) ||
			!bytesContainAll(extraction.EvidenceManifest,
				`"claim":"predicted_agent_comprehension_not_provider_observation"`,
				`"provider_display_status":"not_observed"`,
				`"raw_output_retention":"tenant_scoped_object_store"`) ||
			extraction.RawOutputObjectRef == "" || len(extraction.RawOutputHash) != 64 ||
			extraction.RawOutputExpiresAt == nil {
			t.Fatalf("modeled extraction overclaimed or lost provenance: %+v", extraction)
		}
	}
	if !hasFindingCode(fixture.assurance.findings, "MODELED_FORBIDDEN_CLAIM_CONTRADICTION", true) {
		t.Fatalf("findings=%+v", fixture.assurance.findings)
	}
	final := fixture.assurance.finalizeInput
	if final.OverallScore == nil || *final.OverallScore != 100 ||
		final.ScoreMin == nil || final.ScoreMax == nil || final.Agreement == nil ||
		!bytesContainAll(final.ComponentScores,
			`"score_version":"campaign-comprehension-score-v1"`,
			`"claim":"prediction_not_provider_observation"`,
			`"scenario_manifest_sha256"`) {
		t.Fatalf("final modeled score=%+v", final)
	}
}

func TestWorkerRejectsInvalidModeledOutputWithoutFabricatingScore(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			return successfulModelResult(request.Configuration, []byte(`{"schema_version":1,"unexpected":true}`)), nil
		},
	}
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateUnavailable || result.BlockerCount != 2 {
		t.Fatalf("result=%+v", result)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if fixture.assurance.finalizeInput.OverallScore != nil || len(fixture.assurance.extractions) != 2 ||
		!hasFindingCode(fixture.assurance.findings, "MODELED_OUTPUT_INVALID", true) {
		t.Fatalf("final=%+v extractions=%+v findings=%+v", fixture.assurance.finalizeInput,
			fixture.assurance.extractions, fixture.assurance.findings)
	}
	for _, extraction := range fixture.assurance.extractions {
		if extraction.Status != campaignassurance.ExtractionError || len(extraction.NormalizedExtraction) != 0 {
			t.Fatalf("invalid output became complete: %+v", extraction)
		}
	}
}

func TestWorkerRejectsOversizedModeledOutputBeforeCopyingParsingOrRetention(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	oversized := bytes.Repeat([]byte{'x'}, campaigncomprehension.MaxExtractionBytes+1)
	fixture.worker.ModelExecutor = &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			return successfulModelResult(request.Configuration, oversized), nil
		},
	}

	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeIncomplete || result.Run == nil ||
		result.Run.GateDecision != campaignassurance.GateUnavailable ||
		fixture.assurance.finalizeInput.OverallScore != nil ||
		len(fixture.assurance.extractions) != 2 ||
		!hasFindingCode(fixture.assurance.findings, "MODELED_OUTPUT_TOO_LARGE", true) {
		t.Fatalf("result=%+v final=%+v extractions=%+v findings=%+v", result,
			fixture.assurance.finalizeInput, fixture.assurance.extractions, fixture.assurance.findings)
	}
	for _, extraction := range fixture.assurance.extractions {
		if extraction.Status != campaignassurance.ExtractionError ||
			extraction.ErrorCode != "model_output_too_large" ||
			extraction.RawOutputObjectRef != "" || extraction.RawOutputHash != "" ||
			!bytesContainAll(extraction.EvidenceManifest,
				`"raw_output_retention":"discarded_over_limit"`,
				`"raw_output_sha256":"`+digestBytes(oversized)+`"`) {
			t.Fatalf("oversized output was retained or misclassified: %+v", extraction)
		}
	}
}

func TestWorkerSurfacesExactModeledFidelityGapWithoutInventingThresholdBlock(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			extraction := exactModeledExtraction(false)
			extraction.CoreClaim.Value = "A different claim was recovered"
			return successfulModelResult(request.Configuration, mustJSON(extraction)), nil
		},
	}
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeComplete || result.Run.GateDecision != campaignassurance.GateWarn ||
		result.BlockerCount != 0 || fixture.assurance.finalizeInput.OverallScore == nil ||
		*fixture.assurance.finalizeInput.OverallScore >= 100 ||
		!hasFindingCode(fixture.assurance.findings, "MODELED_INTENT_FIDELITY_GAP", false) {
		t.Fatalf("result=%+v final=%+v findings=%+v", result,
			fixture.assurance.finalizeInput, fixture.assurance.findings)
	}
}

func TestWorkerBlocksMissingCriticalFactWithoutLeakingExpectedValueToExecutor(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	contract := modeledTestContract(t)
	expected := "Premium support is included"
	contract.RequiredFacts = []factcontract.RequiredFact{{
		ID: "support", Type: factcontract.FactTypeText, DisplayValue: expected,
		Criticality:    factcontract.CriticalityCritical,
		SourceBlockIDs: []factcontract.BlockID{"heading"}, TextValue: &expected,
	}}
	var diagnostics factcontract.ValidationErrors
	contract, diagnostics = factcontract.NormalizeAndValidateV1(contract)
	if len(diagnostics) != 0 {
		t.Fatal(diagnostics)
	}
	configureModeledEnsemble(t, &fixture, contract, 2, 2*time.Second)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			vocabulary := string(mustJSON(request.Vocabulary))
			if len(request.Vocabulary.FactSlots) != 1 || request.Vocabulary.FactSlots[0].FactID != "support" ||
				request.Vocabulary.FactSlots[0].Type != string(factcontract.FactTypeText) ||
				strings.Contains(vocabulary, expected) {
				t.Fatalf("recovery vocabulary leaked sender answer: %s", vocabulary)
			}
			return successfulModelResult(request.Configuration, mustJSON(exactModeledExtraction(false))), nil
		},
	}
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeComplete || result.Run.GateDecision != campaignassurance.GateBlock ||
		result.BlockerCount != 2 ||
		!hasFindingCode(fixture.assurance.findings, "MODELED_CRITICAL_FACT_RECOVERY_GAP", true) {
		t.Fatalf("result=%+v findings=%+v", result, fixture.assurance.findings)
	}
}

func TestWorkerRetriesUnknownModeledExecutorFailureWithoutTerminalReceipt(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	fixture.worker.ModelExecutor = &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(context.Context, ModelRequest) (ModelResult, error) {
			return ModelResult{}, errors.New("provider transport included a secret detail")
		},
	}
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeRequeued || fixture.assurance.retries != 1 ||
		len(fixture.assurance.extractions) != 0 || len(fixture.assurance.findings) != 0 {
		t.Fatalf("result=%+v retries=%d extractions=%+v findings=%+v", result,
			fixture.assurance.retries, fixture.assurance.extractions, fixture.assurance.findings)
	}
}

func TestWorkerEnforcesPerConfigurationModeledTimeout(t *testing.T) {
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 100*time.Millisecond)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(ctx context.Context, _ ModelRequest) (ModelResult, error) {
			<-ctx.Done()
			return ModelResult{}, ctx.Err()
		},
	}
	fixture.worker.ModelExecutor = executor
	started := time.Now()
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeRequeued || executor.requestCount() != 1 || time.Since(started) > time.Second {
		t.Fatalf("timeout result=%+v requests=%d elapsed=%v", result, executor.requestCount(), time.Since(started))
	}
}

func TestWorkerPersistsClassifiedModeledUnavailability(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	fixture.worker.ModelExecutor = &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(context.Context, ModelRequest) (ModelResult, error) {
			return ModelResult{}, &ModelExecutionFailure{Code: "provider_capacity", Kind: ModelFailureUnavailable}
		},
	}
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeIncomplete || len(fixture.assurance.extractions) != 2 ||
		fixture.assurance.extractions[0].Status != campaignassurance.ExtractionUnavailable ||
		fixture.assurance.extractions[0].ErrorCode != "model_executor_unavailable" ||
		fixture.assurance.extractions[0].ModelProvider != "test-provider" ||
		fixture.assurance.finalizeInput.OverallScore != nil {
		t.Fatalf("result=%+v extractions=%+v final=%+v", result,
			fixture.assurance.extractions, fixture.assurance.finalizeInput)
	}
}

func TestWorkerRejectsModeledProvenanceMismatch(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	fixture.worker.ModelExecutor = &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			result := successfulModelResult(request.Configuration, mustJSON(exactModeledExtraction(false)))
			result.Provenance.PromptHash = strings.Repeat("0", 64)
			return result, nil
		},
	}
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeIncomplete || fixture.assurance.finalizeInput.OverallScore != nil ||
		fixture.assurance.extractions[0].ErrorCode != "model_provenance_invalid" ||
		fixture.assurance.extractions[0].RawOutputObjectRef == "" ||
		!hasFindingCode(fixture.assurance.findings, "MODELED_PROVENANCE_INVALID", true) {
		t.Fatalf("result=%+v extractions=%+v findings=%+v", result,
			fixture.assurance.extractions, fixture.assurance.findings)
	}
}

func TestWorkerRequiresRawOutputStoreBeforeModelInvocation(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			return successfulModelResult(request.Configuration, mustJSON(exactModeledExtraction(false))), nil
		},
	}
	fixture.worker.Objects = &readOnlyObjectReader{delegate: fixture.objects}
	fixture.worker.RawOutputs = nil
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeIncomplete || executor.requestCount() != 0 || fixture.objects.calls != 0 ||
		len(fixture.assurance.extractions) != 2 ||
		fixture.assurance.extractions[0].ErrorCode != "modeled_raw_output_store_unavailable" {
		t.Fatalf("result=%+v requests=%d objects=%d extractions=%+v", result,
			executor.requestCount(), fixture.objects.calls, fixture.assurance.extractions)
	}
}

func TestWorkerRequeuesRawOutputStoreFailureWithoutExtractionReceipt(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			return successfulModelResult(request.Configuration, mustJSON(exactModeledExtraction(false))), nil
		},
	}
	store := &failingRawOutputStore{}
	fixture.worker.ModelExecutor = executor
	fixture.worker.RawOutputs = store
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	puts := store.puts
	store.mu.Unlock()
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if result.Outcome != OutcomeRequeued || executor.requestCount() != 1 || puts != 1 ||
		len(fixture.assurance.extractions) != 0 || fixture.assurance.retries != 1 {
		t.Fatalf("result=%+v requests=%d puts=%d extractions=%+v retries=%d", result,
			executor.requestCount(), puts, fixture.assurance.extractions, fixture.assurance.retries)
	}
}

func TestWorkerCleansUnlinkedRawOutputWhenExtractionReceiptIsRejected(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	fixture.assurance.recordExtractionErr = campaignassurance.ErrInvalidReceipt
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
			return successfulModelResult(request.Configuration, mustJSON(exactModeledExtraction(false))), nil
		},
	}
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.objects.mu.Lock()
	rawObjects := 0
	for key := range fixture.objects.objects {
		if strings.HasPrefix(key, "campaign-assurance/raw-output/") {
			rawObjects++
		}
	}
	fixture.objects.mu.Unlock()
	if result.Outcome != OutcomeFailed || executor.requestCount() != 1 || rawObjects != 0 || fixture.assurance.failures != 1 {
		t.Fatalf("result=%+v requests=%d raw_objects=%d failures=%d", result,
			executor.requestCount(), rawObjects, fixture.assurance.failures)
	}
}

func TestRetainedRawOutputUsesCollisionProofPhysicalKeyPerWrite(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	fixture.worker.Config.RawOutputTTL = 24 * time.Hour
	claimed := &fixture.assurance.claimed
	target := claimed.Targets[0]
	first, err := fixture.worker.retainRawOutput(context.Background(), claimed, target, []byte(`{"attempt":1}`))
	if err != nil {
		t.Fatal(err)
	}
	second, err := fixture.worker.retainRawOutput(context.Background(), claimed, target, []byte(`{"attempt":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if first.rest == second.rest || first.objectReference == second.objectReference {
		t.Fatalf("two writes reused one physical identity: first=%+v second=%+v", first, second)
	}
	for _, retained := range []retainedRawOutput{first, second} {
		segments := strings.Split(retained.rest, "/")
		if len(segments) < 2 || segments[len(segments)-2] != "writes" ||
			!strings.HasSuffix(segments[len(segments)-1], ".json") {
			t.Fatalf("raw-output key is not a unique write identity: %q", retained.rest)
		}
		writeID := strings.TrimSuffix(segments[len(segments)-1], ".json")
		if parsed, parseErr := uuid.Parse(writeID); parseErr != nil || parsed.String() != writeID {
			t.Fatalf("raw-output write identity is not a canonical UUID: %q", writeID)
		}
	}
}

func TestWorkerDoesNotInvokeSingletonOrMismatchedModeledSuite(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*fixture)
	}{
		{
			name: "singleton",
			mutate: func(fixture *fixture) {
				fixture.assurance.claimed.Configurations = fixture.assurance.claimed.Configurations[:1]
				fixture.assurance.claimed.Targets = fixture.assurance.claimed.Targets[:1]
				fixture.assurance.claimed.Run.RequiredConfigurationCount = 1
				fixture.assurance.claimed.Run.RequiredExtractionCount = 1
			},
		},
		{
			name: "scoring version mismatch",
			mutate: func(fixture *fixture) {
				fixture.assurance.claimed.Run.ScoringVersion = "unreviewed-score"
			},
		},
		{
			name: "duplicate analyzer identity",
			mutate: func(fixture *fixture) {
				duplicate := append(json.RawMessage(nil), fixture.assurance.claimed.Configurations[0].Configuration...)
				fixture.assurance.claimed.Configurations[1].Configuration = duplicate
				fixture.assurance.claimed.Configurations[1].ConfigurationHash =
					fixture.assurance.claimed.Configurations[0].ConfigurationHash
				fixture.assurance.claimed.Targets[1].ConfigurationHash =
					fixture.assurance.claimed.Configurations[0].ConfigurationHash
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			fixture := newFixture(t, campaignassurance.SourceModeled)
			configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
			test.mutate(&fixture)
			executor := &modelExecutorFake{
				identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
				execute: func(_ context.Context, request ModelRequest) (ModelResult, error) {
					return successfulModelResult(request.Configuration, mustJSON(exactModeledExtraction(false))), nil
				},
			}
			fixture.worker.ModelExecutor = executor
			result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
			if err != nil {
				t.Fatal(err)
			}
			if result.Outcome != OutcomeIncomplete || executor.requestCount() != 0 || fixture.objects.calls != 0 {
				t.Fatalf("result=%+v requests=%d objects=%d", result, executor.requestCount(), fixture.objects.calls)
			}
		})
	}
}

func TestModeledConfigurationV1IsClosedAndBounded(t *testing.T) {
	t.Parallel()
	configuration := modeledTestConfiguration("seed-a", 2*time.Second)
	if _, err := NewModeledConfiguration("modeled.sample-a", configuration); err != nil {
		t.Fatal(err)
	}
	raw := mustTestJSON(t, map[string]any{
		"schema_version": 1, "executor_id": configuration.ExecutorID,
		"executor_version": configuration.ExecutorVersion, "model_suite_version": configuration.ModelSuiteVersion,
		"model_provider": configuration.ModelProvider, "model_id": configuration.ModelID,
		"model_version": configuration.ModelVersion, "prompt_suite_version": configuration.PromptSuiteVersion,
		"prompt_version": configuration.PromptVersion, "prompt_hash": configuration.PromptHash,
		"seed_value": configuration.SeedValue, "temperature": configuration.Temperature,
		"timeout_ms": configuration.TimeoutMS, "tools": []string{"browser"},
	})
	if _, err := decodeModeledConfiguration(raw); err == nil {
		t.Fatal("modeled configuration accepted an unreviewed tools field")
	}
	configuration.TimeoutMS = maximumModelTimeout.Milliseconds() + 1
	if _, err := NewModeledConfiguration("modeled.sample-a", configuration); err == nil {
		t.Fatal("modeled configuration accepted an unbounded timeout")
	}
}

func TestModelCacheIdentityIsStableAcrossOperationalRetriesAndBindsOutcomeInputs(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	claimed := fixture.assurance.claimed
	target := claimed.Targets[0]
	configuration, err := decodeModeledConfiguration(claimed.Configurations[0].Configuration)
	if err != nil {
		t.Fatal(err)
	}
	loaded := loadedArtifact{
		artifact: fixture.artifacts.artifact, revision: fixture.artifacts.revision,
		compilation: fixture.compiled,
	}
	vocabulary := recoveryVocabulary(modeledTestContract(t))
	base := buildModelRequest(&claimed, target, configuration, vocabulary, loaded)
	retry := claimed
	retry.Run.ID = "00000000-0000-4000-8000-000000000099"
	retry.Run.AttemptCount++
	retried := buildModelRequest(&retry, target, configuration, vocabulary, loaded)
	if base.CacheKey != retried.CacheKey || base.InputManifestHash != retried.InputManifestHash ||
		base.InvocationID != retried.InvocationID || base.BudgetInvocationID == retried.BudgetInvocationID {
		t.Fatalf("operational retry changed semantic identity or reused budget identity: base=%+v retry=%+v", base, retried)
	}

	tests := []struct {
		name   string
		mutate func(*campaignassurance.ClaimedRun, *campaignassurance.RunTarget, *ModeledConfigurationV1, *loadedArtifact, *RecoveryVocabularyV1)
	}{
		{"tenant", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.TenantID = "00000000-0000-4000-8000-000000000098"
		}},
		{"artifact set", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.ArtifactSetHash = strings.Repeat("1", 64)
		}},
		{"coverage", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.CoverageManifestHash = strings.Repeat("2", 64)
		}},
		{"configuration manifest", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.ConfigurationManifestHash = strings.Repeat("3", 64)
		}},
		{"target manifest", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.TargetManifestHash = strings.Repeat("4", 64)
		}},
		{"prompt hash", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.PromptSuiteHash = strings.Repeat("5", 64)
		}},
		{"normalization", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.NormalizationVersion += ".changed"
		}},
		{"scoring", func(value *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.Run.ScoringVersion += ".changed"
		}},
		{"configuration", func(_ *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, value *ModeledConfigurationV1, _ *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.SeedValue = "different"
		}},
		{"evidence", func(_ *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, value *loadedArtifact, _ *RecoveryVocabularyV1) {
			value.artifact.HTMLHash = strings.Repeat("6", 64)
		}},
		{"vocabulary", func(_ *campaignassurance.ClaimedRun, _ *campaignassurance.RunTarget, _ *ModeledConfigurationV1, _ *loadedArtifact, value *RecoveryVocabularyV1) {
			value.PrimaryAction.ActionID = "different"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			changedRun, changedTarget, changedConfiguration := claimed, target, configuration
			changedLoaded, changedVocabulary := loaded, vocabulary
			test.mutate(&changedRun, &changedTarget, &changedConfiguration, &changedLoaded, &changedVocabulary)
			changed := buildModelRequest(&changedRun, changedTarget, changedConfiguration, changedVocabulary, changedLoaded)
			if changed.CacheKey == base.CacheKey || changed.InputManifestHash == base.InputManifestHash {
				t.Fatalf("%s did not invalidate exact cache identity", test.name)
			}
		})
	}
}

func TestWorkerFailsClosedBeforeProviderWhenAggregateBudgetIsExhausted(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	configureModeledEnsemble(t, &fixture, modeledTestContract(t), 2, 2*time.Second)
	fixture.assurance.reservationErr = campaignassurance.ErrCostBudgetExceeded
	executor := &modelExecutorFake{
		identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"},
		execute: func(context.Context, ModelRequest) (ModelResult, error) {
			t.Fatal("provider invoked after budget exhaustion")
			return ModelResult{}, nil
		},
	}
	fixture.worker.ModelExecutor = executor
	result, err := fixture.worker.Process(context.Background(), Command{TenantID: testTenantID, RunID: testRunID})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeIncomplete || executor.requestCount() != 0 {
		t.Fatalf("budget exhaustion result=%+v provider calls=%d", result, executor.requestCount())
	}
	fixture.assurance.mu.Lock()
	defer fixture.assurance.mu.Unlock()
	if len(fixture.assurance.extractions) != 2 || len(fixture.assurance.findings) != 2 {
		t.Fatalf("budget exhaustion evidence extractions=%+v findings=%+v", fixture.assurance.extractions, fixture.assurance.findings)
	}
	for _, extraction := range fixture.assurance.extractions {
		if extraction.ErrorCode != "modeled_cost_budget_exhausted" || extraction.ExecutionKind != "" || extraction.CostMicrounits != 0 {
			t.Fatalf("budget exhaustion fabricated invocation success: %+v", extraction)
		}
	}
}

func TestWorkerReusesOnlyHashVerifiedLiveRawModeledOriginAtZeroCost(t *testing.T) {
	t.Parallel()
	fixture := newFixture(t, campaignassurance.SourceModeled)
	contract := modeledTestContract(t)
	configureModeledEnsemble(t, &fixture, contract, 2, 2*time.Second)
	claimed := &fixture.assurance.claimed
	target := claimed.Targets[0]
	configuration, err := decodeModeledConfiguration(claimed.Configurations[0].Configuration)
	if err != nil {
		t.Fatal(err)
	}
	loaded := loadedArtifact{artifact: fixture.artifacts.artifact, revision: fixture.artifacts.revision, compilation: fixture.compiled}
	request := buildModelRequest(claimed, target, configuration, recoveryVocabulary(contract), loaded)
	raw := mustJSON(exactModeledExtraction(false))
	receipt, diagnostics := campaigncomprehension.DecodeAndNormalizeV1(raw, request.AllowedEvidenceIDs)
	if len(diagnostics) != 0 {
		t.Fatalf("normalize cache fixture: %v", diagnostics)
	}
	rest := "campaign-assurance/raw-output/runs/00000000-0000-4000-8000-000000000088/attempt-1/artifacts/source/configurations/source.json"
	fixture.objects.objects[rest] = objectValue{body: raw, contentType: "application/json"}
	expires := fixture.worker.Config.Now().Add(24 * time.Hour)
	fixture.assurance.cacheCandidate = &campaignassurance.ReusableModeledExtraction{
		SourceRunID: "00000000-0000-4000-8000-000000000088",
		Extraction: campaignassurance.Extraction{
			ID: "00000000-0000-4000-8000-000000000087", ReceiptHash: strings.Repeat("7", 64),
			ExtractionInput: campaignassurance.ExtractionInput{
				ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
				SourceClass: campaignassurance.SourceModeled, ConfigurationHash: target.ConfigurationHash,
				OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
				NormalizedExtraction: receipt.CanonicalExtraction, UnsupportedClaims: json.RawMessage(`[]`),
				Ambiguities: json.RawMessage(`[]`), RawOutputObjectRef: campaignmaterializer.FormatObjectReference(rest),
				RawOutputHash: digestBytes(raw), RawOutputExpiresAt: &expires,
				ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
				ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
				PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
				InputTokens: 100, OutputTokens: 40, CostMicrounits: 25,
			},
		},
	}
	executor := &modelExecutorFake{identity: ModelExecutorIdentity{ID: "test.closed-executor", Version: "postwave.test.executor.v1"}, execute: func(context.Context, ModelRequest) (ModelResult, error) {
		t.Fatal("provider invoked despite valid exact cache origin")
		return ModelResult{}, nil
	}}
	fixture.worker.ModelExecutor = executor
	persisted, err := fixture.worker.analyzeModeledTarget(context.Background(), claimed, target, configuration, recoveryVocabulary(contract), loaded)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.status != campaignassurance.ExtractionComplete || executor.requestCount() != 0 || len(fixture.assurance.reservations) != 0 {
		t.Fatalf("cache reuse persisted=%+v calls=%d reservations=%+v", persisted, executor.requestCount(), fixture.assurance.reservations)
	}
	reused := fixture.assurance.extractions[0]
	if reused.ExecutionKind != campaignassurance.ModeledExecutionCacheReuse || reused.CostMicrounits != 0 ||
		reused.ReusedOriginalCostMicrounits != 25 || reused.ReusedFromExtractionID == "" ||
		!bytesContainAll(reused.EvidenceManifest, `"provider_invoked":false`, `"reuse_cost_microunits":0`) {
		t.Fatalf("cache receipt lost zero-cost lineage: %+v", reused)
	}
}

func TestModeledFinalizationReceiptStaysBoundedForMaximumScenarioDiagnostics(t *testing.T) {
	t.Parallel()
	missing := make([]string, maxModeledScenariosV1)
	failures := make([]campaigncomprehension.ScoreFailureV1, maxModeledScenariosV1)
	for index := range missing {
		missing[index] = "scenario-" + strconv.Itoa(index)
		failures[index] = campaigncomprehension.ScoreFailureV1{
			Code: "required_scenario_incomplete", Detail: strings.Repeat("diagnostic", 100),
		}
	}
	aggregate := campaigncomprehension.ScenarioAggregateV1{
		ScoreVersion: campaigncomprehension.ScoreVersionV1,
		Coverage: campaigncomprehension.CoverageV1{
			Required: len(missing), MissingIDs: missing, FailedIDs: append([]string(nil), missing...),
		},
		WorstScenarioIDs: append([]string(nil), missing...), Failures: failures,
	}
	final := (executionSummary{modeledScores: &modeledScoreFinalization{
		status: "incomplete", aggregate: aggregate,
		scenarioManifestSHA256: strings.Repeat("a", 64), scenarioCount: len(missing),
	}}).finalizeInput(campaignassurance.GateBlock)
	if !json.Valid(final.ComponentScores) || len(final.ComponentScores) > 64<<10 ||
		strings.Contains(string(final.ComponentScores), strings.Repeat("diagnostic", 10)) {
		t.Fatalf("component score receipt bytes=%d valid=%t", len(final.ComponentScores), json.Valid(final.ComponentScores))
	}
}

func configureModeledEnsemble(
	t *testing.T,
	fixture *fixture,
	contract factcontract.ContractV1,
	count int,
	timeout time.Duration,
) {
	t.Helper()
	fixture.artifacts.revision.FactContract = mustTestJSON(t, contract)
	run := &fixture.assurance.claimed.Run
	run.NormalizationVersion = campaigncomprehension.ExtractionNormalizationVersionV1
	run.ScoringVersion = campaigncomprehension.ScoreVersionV1
	run.MethodologyVersion = "postwave.test.predicted-comprehension.v1"
	run.RequiredConfigurationCount = count
	run.RequiredExtractionCount = count
	fixture.assurance.claimed.Configurations = nil
	fixture.assurance.claimed.Targets = nil
	for index := 0; index < count; index++ {
		id := "modeled.sample-" + string(rune('a'+index))
		configuration := modeledTestConfiguration("seed-"+string(rune('a'+index)), timeout)
		input, err := NewModeledConfiguration(id, configuration)
		if err != nil {
			t.Fatal(err)
		}
		hash, err := canonicalConfigurationHash(input.Configuration)
		if err != nil {
			t.Fatal(err)
		}
		fixture.assurance.claimed.Configurations = append(fixture.assurance.claimed.Configurations,
			campaignassurance.RunConfiguration{
				TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
				Ordinal: index + 1, ID: id, SourceClass: campaignassurance.SourceModeled,
				ConfigurationHash: hash, Configuration: input.Configuration,
			})
		fixture.assurance.claimed.Targets = append(fixture.assurance.claimed.Targets,
			campaignassurance.RunTarget{
				TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
				SendPlanID: testPlanID, ArtifactID: testArtifactID, ConfigurationID: id,
				Ordinal: index + 1, SourceClass: campaignassurance.SourceModeled,
				ConfigurationHash: hash, OutboundMIMEHash: fixture.compiled.Artifact.OutboundMIMEHash,
			})
	}
}

func modeledTestConfiguration(seed string, timeout time.Duration) ModeledConfigurationV1 {
	return ModeledConfigurationV1{
		SchemaVersion: ModeledConfigurationSchemaVersionV1,
		ExecutorID:    "test.closed-executor", ExecutorVersion: "postwave.test.executor.v1",
		ModelSuiteVersion: "postwave.test.model-suite.v1", ModelProvider: "test-provider",
		ModelID: "test-model", ModelVersion: "test-model-2026-08-09",
		PromptSuiteVersion: "postwave.test.prompt-suite.v1", PromptVersion: "test-prompt.v1",
		PromptHash: strings.Repeat("f", 64), SeedValue: seed, Temperature: 0,
		TimeoutMS: timeout.Milliseconds(), MaximumCostMicrounits: 1_000,
	}
}

func modeledTestContract(t *testing.T) factcontract.ContractV1 {
	t.Helper()
	contract := factcontract.ContractV1{
		SchemaVersion:   factcontract.SchemaVersionV1,
		PrimaryIntent:   factcontract.Intent{Kind: factcontract.IntentInform, Statement: "Assurance fixture"},
		AudienceContext: factcontract.Audience{Description: "Moosewave assurance operators"},
		CoreClaim:       factcontract.Claim{Statement: "Assurance fixture", SourceBlockIDs: []factcontract.BlockID{"heading"}},
		PrimaryAction: factcontract.PrimaryAction{
			ActionID: "continue", BlockID: "primary_action", Role: factcontract.PrimaryActionNavigate,
			Label: "Continue", CanonicalURL: "https://example.test/continue",
		},
		RequiredFacts:   []factcontract.RequiredFact{},
		ForbiddenClaims: []factcontract.ForbiddenClaim{{ID: "guaranteed_result", Statement: "Results are guaranteed"}},
		AllowedSecondaryActions: []factcontract.SecondaryActionRole{
			factcontract.SecondaryActionUnsubscribe,
		},
		Language: "en-US",
	}
	normalized, diagnostics := factcontract.NormalizeAndValidateV1(contract)
	if len(diagnostics) != 0 {
		t.Fatalf("test Fact Contract invalid: %v", diagnostics)
	}
	return normalized
}

func exactModeledExtraction(contradiction bool) campaigncomprehension.ExtractionV1 {
	unsupported := []campaigncomprehension.UnsupportedClaim{}
	if contradiction {
		unsupported = append(unsupported, campaigncomprehension.UnsupportedClaim{
			Statement: "Results are guaranteed", EvidenceIDs: []string{"subject"},
		})
	}
	return campaigncomprehension.ExtractionV1{
		SchemaVersion: campaigncomprehension.ExtractionSchemaVersionV1,
		Summary:       "Assurance fixture",
		PrimaryIntent: campaigncomprehension.ExtractedIntent{
			Kind: factcontract.IntentInform, Value: "Assurance fixture", EvidenceIDs: []string{"subject"},
		},
		CoreClaim: campaigncomprehension.ExtractedStatement{
			Value: "Assurance fixture", EvidenceIDs: []string{"subject"},
		},
		PrimaryAction: campaigncomprehension.ExtractedAction{
			ActionID: "continue", BlockID: "primary_action", Role: factcontract.PrimaryActionNavigate,
			Label: "Continue", CanonicalURL: "https://example.test/continue", EvidenceIDs: []string{"html"},
		},
		Facts: []campaigncomprehension.ExtractedFact{}, UnsupportedClaims: unsupported,
		Ambiguities: []campaigncomprehension.Ambiguity{},
	}
}

func successfulModelResult(configuration ModeledConfigurationV1, raw []byte) ModelResult {
	return ModelResult{
		RawExtraction: raw,
		Provenance: ModelProvenance{
			ExecutorID: configuration.ExecutorID, ExecutorVersion: configuration.ExecutorVersion,
			ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
			ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
			PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
			Temperature: configuration.Temperature,
		},
		InputTokens: 100, OutputTokens: 40, CostMicrounits: 25,
	}
}

func hasFindingCode(values []campaignassurance.FindingInput, code string, blocking bool) bool {
	for _, value := range values {
		if value.Code == code && value.Blocking == blocking {
			return true
		}
	}
	return false
}

func bytesContainAll(value json.RawMessage, needles ...string) bool {
	text := string(value)
	for _, needle := range needles {
		if !strings.Contains(text, needle) {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
