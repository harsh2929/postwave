// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
)

type modelOutcomeIdentity struct {
	SchemaVersion             int    `json:"schema_version"`
	WorkerVersion             string `json:"worker_version"`
	TenantID                  string `json:"tenant_id"`
	CampaignID                string `json:"campaign_id"`
	ContentRevisionID         string `json:"content_revision_id"`
	SendPlanID                string `json:"send_plan_id"`
	ArtifactID                string `json:"artifact_id"`
	ScenarioID                string `json:"scenario_id"`
	ConfigurationID           string `json:"configuration_id"`
	ConfigurationHash         string `json:"configuration_hash"`
	OutboundMIMEHash          string `json:"outbound_mime_hash"`
	SourceHash                string `json:"source_hash"`
	PlanHash                  string `json:"plan_hash"`
	ArtifactSetHash           string `json:"artifact_set_hash"`
	CoverageManifestHash      string `json:"coverage_manifest_hash"`
	ConfigurationManifestHash string `json:"configuration_manifest_hash"`
	TargetManifestHash        string `json:"target_manifest_hash"`
	RendererVersion           string `json:"renderer_version"`
	CompilerVersion           string `json:"compiler_version"`
	FixtureSetVersion         string `json:"fixture_set_version"`
	PlanPolicyVersion         string `json:"plan_policy_version"`
	AnalyzerSuiteVersion      string `json:"analyzer_suite_version"`
	ModelSuiteVersion         string `json:"model_suite_version"`
	PromptSuiteVersion        string `json:"prompt_suite_version"`
	PromptSuiteHash           string `json:"prompt_suite_hash"`
	NormalizationVersion      string `json:"normalization_version"`
	ScoringVersion            string `json:"scoring_version"`
	GatePolicyVersion         string `json:"gate_policy_version"`
	MethodologyVersion        string `json:"methodology_version"`
}

type modelInputManifest struct {
	SchemaVersion        int                    `json:"schema_version"`
	OutcomeIdentity      modelOutcomeIdentity   `json:"outcome_identity"`
	Configuration        ModeledConfigurationV1 `json:"configuration"`
	Vocabulary           RecoveryVocabularyV1   `json:"vocabulary"`
	Evidence             []ModelEvidence        `json:"evidence"`
	AllowedEvidenceIDs   []string               `json:"allowed_evidence_ids"`
	ExtractionSchemaHash string                 `json:"extraction_schema_sha256"`
}

type modelAttemptIdentity struct {
	SchemaVersion   int    `json:"schema_version"`
	TenantID        string `json:"tenant_id"`
	RunID           string `json:"run_id"`
	AttemptCount    int    `json:"attempt_count"`
	ArtifactID      string `json:"artifact_id"`
	ConfigurationID string `json:"configuration_id"`
	ModelCacheKey   string `json:"model_cache_key"`
}

type compactExtractionIndex struct {
	Ordinal        int    `json:"ordinal"`
	ValueSHA256    string `json:"value_sha256"`
	EvidenceCount  int    `json:"evidence_count"`
	EvidenceSHA256 string `json:"evidence_sha256"`
}

func buildModelRequest(
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration ModeledConfigurationV1,
	contractVocabulary RecoveryVocabularyV1,
	loaded loadedArtifact,
) ModelRequest {
	outcome := modelOutcomeIdentity{
		SchemaVersion: 1, WorkerVersion: Version, TenantID: claimed.Run.TenantID,
		CampaignID:        claimed.Run.CampaignID,
		ContentRevisionID: claimed.Run.ContentRevisionID, SendPlanID: claimed.Run.SendPlanID,
		ArtifactID: target.ArtifactID,
		ScenarioID: loaded.artifact.ScenarioID, ConfigurationID: target.ConfigurationID,
		ConfigurationHash: target.ConfigurationHash, OutboundMIMEHash: target.OutboundMIMEHash,
		SourceHash: claimed.Run.SourceHash, PlanHash: claimed.Run.PlanHash,
		ArtifactSetHash:           claimed.Run.ArtifactSetHash,
		CoverageManifestHash:      claimed.Run.CoverageManifestHash,
		ConfigurationManifestHash: claimed.Run.ConfigurationManifestHash,
		TargetManifestHash:        claimed.Run.TargetManifestHash,
		RendererVersion:           claimed.Run.RendererVersion, CompilerVersion: claimed.Run.CompilerVersion,
		FixtureSetVersion: claimed.Run.FixtureSetVersion, PlanPolicyVersion: claimed.Run.PlanPolicyVersion,
		AnalyzerSuiteVersion: claimed.Run.AnalyzerSuiteVersion,
		ModelSuiteVersion:    claimed.Run.ModelSuiteVersion,
		PromptSuiteVersion:   claimed.Run.PromptSuiteVersion,
		PromptSuiteHash:      claimed.Run.PromptSuiteHash,
		NormalizationVersion: claimed.Run.NormalizationVersion,
		ScoringVersion:       claimed.Run.ScoringVersion,
		GatePolicyVersion:    claimed.Run.GatePolicyVersion,
		MethodologyVersion:   claimed.Run.MethodologyVersion,
	}
	evidence, allowed := modelEvidenceForArtifact(loaded)
	schema := campaigncomprehension.ExtractionJSONSchemaV1()
	manifest := modelInputManifest{
		SchemaVersion: 1, OutcomeIdentity: outcome, Configuration: configuration,
		Vocabulary: contractVocabulary, Evidence: evidence, AllowedEvidenceIDs: allowed,
		ExtractionSchemaHash: digestBytes(schema),
	}
	inputManifestHash := digestBytes(mustJSON(manifest))
	cacheKey := digestBytes(mustJSON(struct {
		SchemaVersion     int    `json:"schema_version"`
		TenantID          string `json:"tenant_id"`
		InputManifestHash string `json:"input_manifest_hash"`
	}{1, claimed.Run.TenantID, inputManifestHash}))
	budgetInvocationID := digestBytes(mustJSON(modelAttemptIdentity{
		SchemaVersion: 1, TenantID: claimed.Run.TenantID, RunID: claimed.Run.ID,
		AttemptCount: claimed.Run.AttemptCount, ArtifactID: target.ArtifactID,
		ConfigurationID: target.ConfigurationID, ModelCacheKey: cacheKey,
	}))
	return ModelRequest{
		InvocationID: cacheKey, BudgetInvocationID: budgetInvocationID, CacheKey: cacheKey,
		TenantID: claimed.Run.TenantID, RunID: claimed.Run.ID, AttemptCount: claimed.Run.AttemptCount,
		CampaignID: claimed.Run.CampaignID, ContentRevisionID: claimed.Run.ContentRevisionID,
		SendPlanID: claimed.Run.SendPlanID, ArtifactID: target.ArtifactID,
		ScenarioID: loaded.artifact.ScenarioID, ConfigurationID: target.ConfigurationID,
		ConfigurationHash: target.ConfigurationHash, OutboundMIMEHash: target.OutboundMIMEHash,
		SourceHash: claimed.Run.SourceHash, PlanHash: claimed.Run.PlanHash,
		ArtifactSetHash:      claimed.Run.ArtifactSetHash,
		AnalyzerSuiteVersion: claimed.Run.AnalyzerSuiteVersion,
		ModelSuiteVersion:    claimed.Run.ModelSuiteVersion,
		PromptSuiteVersion:   claimed.Run.PromptSuiteVersion,
		NormalizationVersion: claimed.Run.NormalizationVersion,
		ScoringVersion:       claimed.Run.ScoringVersion,
		GatePolicyVersion:    claimed.Run.GatePolicyVersion,
		MethodologyVersion:   claimed.Run.MethodologyVersion,
		InputManifestHash:    inputManifestHash, Configuration: configuration,
		Vocabulary: contractVocabulary, Evidence: evidence, AllowedEvidenceIDs: allowed,
		ExtractionSchema: schema, MaxOutputBytes: campaigncomprehension.MaxExtractionBytes,
		Artifact: ModelArtifact{
			Subject: loaded.compilation.Subject, HTML: loaded.compilation.HTML,
			PlainText:      loaded.compilation.Text,
			StructuredData: append(json.RawMessage(nil), loaded.compilation.StructuredData...),
			RFC822:         append([]byte(nil), loaded.compilation.RFC822...),
		},
	}
}

func modelEvidenceForArtifact(loaded loadedArtifact) ([]ModelEvidence, []string) {
	evidence := []ModelEvidence{
		{ID: "html", Representation: "html", SHA256: loaded.artifact.HTMLHash},
		{ID: "mime", Representation: "mime", SHA256: loaded.artifact.OutboundMIMEHash},
		{ID: "subject", Representation: "subject", SHA256: digestBytes([]byte(loaded.compilation.Subject))},
		{ID: "text_plain", Representation: "text_plain", SHA256: loaded.artifact.TextHash},
	}
	if len(loaded.compilation.StructuredData) != 0 {
		evidence = append(evidence, ModelEvidence{
			ID: "structured_data", Representation: "structured_data",
			SHA256: digestBytes(loaded.compilation.StructuredData),
		})
	}
	seen := make(map[string]struct{}, len(evidence)+len(loaded.compilation.Receipt.IncludedNodeIDs))
	for _, item := range evidence {
		seen[item.ID] = struct{}{}
	}
	for _, rawID := range loaded.compilation.Receipt.IncludedNodeIDs {
		id := "node:" + digestBytes([]byte(rawID))
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		evidence = append(evidence, ModelEvidence{
			ID: id, Representation: "html", Location: "node:" + string(rawID),
			SHA256: loaded.artifact.HTMLHash,
		})
	}
	sort.Slice(evidence, func(i, j int) bool { return evidence[i].ID < evidence[j].ID })
	allowed := make([]string, len(evidence))
	for index := range evidence {
		allowed[index] = evidence[index].ID
	}
	return evidence, allowed
}

func (w *Worker) analyzeModeledTarget(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration ModeledConfigurationV1,
	vocabulary RecoveryVocabularyV1,
	loaded loadedArtifact,
) (persistedTarget, error) {
	request := buildModelRequest(claimed, target, configuration, vocabulary, loaded)
	if cached, reused, err := w.tryReuseModeledTarget(ctx, claimed, target, configuration, request); err != nil {
		return persistedTarget{}, err
	} else if reused {
		return cached, nil
	}
	_, err := w.Assurance.ReserveModeledInvocation(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ModeledInvocationReservationInput{
			InvocationID: request.BudgetInvocationID, CacheKey: request.CacheKey,
			InputManifestHash: request.InputManifestHash, ArtifactID: target.ArtifactID,
			ConfigurationID: target.ConfigurationID, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash:   target.OutboundMIMEHash,
			ReservedMicrounits: configuration.MaximumCostMicrounits,
		})
	if errors.Is(err, campaignassurance.ErrCostBudgetExceeded) {
		return w.recordModeledFailure(ctx, claimed, target, configuration, modeledFailureInput{
			status:        campaignassurance.ExtractionUnavailable,
			errorCode:     "modeled_cost_budget_exhausted",
			publicMessage: "the frozen aggregate modeled cost budget has no remaining reservation headroom",
			findingCode:   "MODELED_COST_BUDGET_EXHAUSTED", request: &request,
		})
	}
	if err != nil {
		return persistedTarget{}, fmt.Errorf("%w: reserve modeled invocation: %w", ErrLifecycle, err)
	}
	executorRequest := cloneModelRequest(request)
	timeout := time.Duration(configuration.TimeoutMS) * time.Millisecond
	callContext, cancel := context.WithTimeout(ctx, timeout)
	started := time.Now()
	result, executionErr := w.ModelExecutor.Execute(callContext, executorRequest)
	elapsed := time.Since(started)
	callCause := context.Cause(callContext)
	cancel()

	if executionErr != nil {
		if parentCause := context.Cause(ctx); parentCause != nil {
			return persistedTarget{}, parentCause
		}
		if errors.Is(callCause, context.DeadlineExceeded) {
			if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultChargeUnknown,
				ModelResult{}, elapsed, "model_execution_timeout"); err != nil {
				return persistedTarget{}, err
			}
			return persistedTarget{}, retryableModelError("model_execution_timeout")
		}
		failure, classified := validatedExecutionFailure(executionErr)
		if !classified || failure.Kind == ModelFailureRetryable {
			if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultChargeUnknown,
				ModelResult{}, elapsed, "model_executor_retryable"); err != nil {
				return persistedTarget{}, err
			}
			return persistedTarget{}, retryableModelError("model_executor_retryable")
		}
		status := campaignassurance.ExtractionError
		errorCode := "model_executor_terminal_error"
		findingCode := "MODELED_EXECUTION_ERROR"
		if failure.Kind == ModelFailureUnavailable {
			status = campaignassurance.ExtractionUnavailable
			errorCode = "model_executor_unavailable"
			findingCode = "MODELED_EXECUTION_UNAVAILABLE"
		}
		settlementStatus := campaignassurance.InvocationResultError
		if failure.Kind == ModelFailureUnavailable {
			settlementStatus = campaignassurance.InvocationResultUnavailable
		}
		if err := w.settleModeledInvocation(ctx, claimed, request, settlementStatus,
			ModelResult{}, elapsed, failure.Code); err != nil {
			return persistedTarget{}, err
		}
		return w.recordModeledFailure(ctx, claimed, target, configuration, modeledFailureInput{
			status: status, errorCode: errorCode,
			publicMessage: "the configured modeled executor returned a terminal public failure",
			findingCode:   findingCode, invoked: true, latencyMS: elapsed.Milliseconds(),
			validationDiagnostics: []map[string]string{{"code": failure.Code}}, request: &request,
		})
	}
	if callCause != nil {
		if parentCause := context.Cause(ctx); parentCause != nil {
			return persistedTarget{}, parentCause
		}
		if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultChargeUnknown,
			ModelResult{}, elapsed, "model_execution_timeout"); err != nil {
			return persistedTarget{}, err
		}
		return persistedTarget{}, retryableModelError("model_execution_timeout")
	}
	if !validModelResultUsage(result) || result.CostMicrounits > configuration.MaximumCostMicrounits {
		if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultChargeUnknown,
			ModelResult{}, elapsed, "model_usage_exceeds_reservation"); err != nil {
			return persistedTarget{}, err
		}
		return persistedTarget{}, retryableModelError("model_usage_exceeds_reservation")
	}
	if !provenanceMatches(result.Provenance, configuration) {
		if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultError,
			result, elapsed, "model_provenance_invalid"); err != nil {
			return persistedTarget{}, err
		}
		return w.recordModeledFailure(ctx, claimed, target, configuration, modeledFailureInput{
			status: campaignassurance.ExtractionError, errorCode: "model_provenance_invalid",
			publicMessage: "the modeled executor result did not match the frozen runtime identity",
			findingCode:   "MODELED_PROVENANCE_INVALID", invoked: true,
			rawOutputHash: digestBytes(result.RawExtraction), rawOutput: retainedFailureBytes(result.RawExtraction),
			retainRaw: len(result.RawExtraction) <= campaigncomprehension.MaxExtractionBytes,
			latencyMS: elapsed.Milliseconds(), inputTokens: result.InputTokens,
			outputTokens: result.OutputTokens, costMicrounits: result.CostMicrounits,
			request: &request,
		})
	}
	if len(result.RawExtraction) > campaigncomprehension.MaxExtractionBytes {
		if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultError,
			result, elapsed, "model_output_too_large"); err != nil {
			return persistedTarget{}, err
		}
		return w.recordModeledFailure(ctx, claimed, target, configuration, modeledFailureInput{
			status: campaignassurance.ExtractionError, errorCode: "model_output_too_large",
			publicMessage: "the modeled executor output exceeded the closed extraction size limit",
			findingCode:   "MODELED_OUTPUT_TOO_LARGE", invoked: true,
			rawOutputHash: digestBytes(result.RawExtraction), retainRaw: false,
			latencyMS:   elapsed.Milliseconds(),
			inputTokens: result.InputTokens, outputTokens: result.OutputTokens,
			costMicrounits: result.CostMicrounits, request: &request,
		})
	}
	result.RawExtraction = append([]byte(nil), result.RawExtraction...)
	receipt, diagnostics := campaigncomprehension.DecodeAndNormalizeV1(
		result.RawExtraction, request.AllowedEvidenceIDs,
	)
	if len(diagnostics) != 0 {
		if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultError,
			result, elapsed, "model_output_invalid"); err != nil {
			return persistedTarget{}, err
		}
		return w.recordModeledFailure(ctx, claimed, target, configuration, modeledFailureInput{
			status: campaignassurance.ExtractionError, errorCode: "model_output_invalid",
			publicMessage: "the modeled executor output failed the closed extraction contract",
			findingCode:   "MODELED_OUTPUT_INVALID", invoked: true,
			rawOutputHash: digestBytes(result.RawExtraction), rawOutput: retainedFailureBytes(result.RawExtraction),
			retainRaw:             len(result.RawExtraction) <= campaigncomprehension.MaxExtractionBytes,
			latencyMS:             elapsed.Milliseconds(),
			validationDiagnostics: compactValidationDiagnostics(diagnostics),
			inputTokens:           result.InputTokens, outputTokens: result.OutputTokens,
			costMicrounits: result.CostMicrounits, request: &request,
		})
	}
	if diagnostics := campaigncomprehension.VerifyExtractionReceiptV1AgainstEvidence(
		receipt, request.AllowedEvidenceIDs,
	); len(diagnostics) != 0 {
		if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultError,
			result, elapsed, "model_receipt_invalid"); err != nil {
			return persistedTarget{}, err
		}
		return w.recordModeledFailure(ctx, claimed, target, configuration, modeledFailureInput{
			status: campaignassurance.ExtractionError, errorCode: "model_receipt_invalid",
			publicMessage: "the normalized modeled receipt failed evidence-bound verification",
			findingCode:   "MODELED_RECEIPT_INVALID", invoked: true,
			rawOutputHash: digestBytes(result.RawExtraction), rawOutput: retainedFailureBytes(result.RawExtraction),
			retainRaw:             len(result.RawExtraction) <= campaigncomprehension.MaxExtractionBytes,
			latencyMS:             elapsed.Milliseconds(),
			validationDiagnostics: compactValidationDiagnostics(diagnostics),
			inputTokens:           result.InputTokens, outputTokens: result.OutputTokens,
			costMicrounits: result.CostMicrounits, request: &request,
		})
	}
	if err := w.settleModeledInvocation(ctx, claimed, request, campaignassurance.InvocationResultComplete,
		result, elapsed, ""); err != nil {
		return persistedTarget{}, err
	}

	retained, err := w.retainRawOutput(ctx, claimed, target, result.RawExtraction)
	if err != nil {
		return persistedTarget{}, err
	}
	evidenceManifest := mustJSON(map[string]any{
		"schema_version": 1, "worker_version": Version,
		"source_class": campaignassurance.SourceModeled,
		"claim":        "predicted_agent_comprehension_not_provider_observation",
		"run_id":       claimed.Run.ID, "attempt_count": claimed.Run.AttemptCount,
		"artifact_id": target.ArtifactID, "scenario_id": loaded.artifact.ScenarioID,
		"configuration_id":   target.ConfigurationID,
		"configuration_hash": target.ConfigurationHash,
		"outbound_mime_hash": target.OutboundMIMEHash,
		"invocation_id":      request.InvocationID, "input_manifest_sha256": request.InputManifestHash,
		"model_cache_key": request.CacheKey, "budget_invocation_id": request.BudgetInvocationID,
		"execution_kind": "invoked", "provider_invoked": true,
		"allowed_evidence_count":           len(request.AllowedEvidenceIDs),
		"allowed_evidence_manifest_sha256": digestBytes(mustJSON(request.AllowedEvidenceIDs)),
		"extraction_schema_version":        campaigncomprehension.ExtractionSchemaVersionV1,
		"normalization_version":            receipt.NormalizationVersion,
		"extraction_receipt_sha256":        receipt.ReceiptHash,
		"raw_output_sha256":                digestBytes(result.RawExtraction),
		"raw_output_retention":             "tenant_scoped_object_store",
		"provider_display_status":          "not_observed",
	})
	unsupported := compactUnsupportedClaims(receipt.Extraction.UnsupportedClaims)
	ambiguities := compactAmbiguities(receipt.Extraction.Ambiguities)
	temperature := configuration.Temperature
	extraction, err := w.Assurance.RecordExtraction(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ExtractionInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
			NormalizedExtraction: receipt.CanonicalExtraction, EvidenceManifest: evidenceManifest,
			UnsupportedClaims: unsupported, Ambiguities: ambiguities,
			ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
			ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
			PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
			Temperature: &temperature, InputTokens: result.InputTokens,
			OutputTokens: result.OutputTokens, CostMicrounits: result.CostMicrounits,
			LatencyMS: elapsed.Milliseconds(), RawOutputObjectRef: retained.objectReference,
			RawOutputHash: retained.sha256, RawOutputExpiresAt: &retained.expiresAt,
			ModelCacheKey: request.CacheKey, ModelInputManifestHash: request.InputManifestHash,
			ModelInvocationID: request.BudgetInvocationID,
			ExecutionKind:     campaignassurance.ModeledExecutionInvoked,
		})
	if err != nil {
		return persistedTarget{}, w.cleanupRetainedOutput(ctx, claimed.Run.TenantID, retained,
			fmt.Errorf("%w: record modeled extraction: %w", ErrLifecycle, err))
	}
	receiptCopy := receipt
	return persistedTarget{
		status: campaignassurance.ExtractionComplete, sourceClass: campaignassurance.SourceModeled,
		extractionID: extraction.ID,
		modeledOutput: &campaigncomprehension.AnalyzerOutputV1{
			ConfigurationID: target.ConfigurationID, Receipt: &receiptCopy,
		},
	}, nil
}

func (w *Worker) settleModeledInvocation(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	request ModelRequest,
	status string,
	result ModelResult,
	elapsed time.Duration,
	reason string,
) error {
	_, err := w.Assurance.RecordModeledInvocationResult(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ModeledInvocationResultInput{
			InvocationID: request.BudgetInvocationID, Status: status,
			InputTokens: result.InputTokens, OutputTokens: result.OutputTokens,
			CostMicrounits: result.CostMicrounits, LatencyMS: elapsed.Milliseconds(),
			ReasonCode: reason,
		})
	if err != nil {
		return fmt.Errorf("%w: settle modeled invocation: %w", ErrLifecycle, err)
	}
	return nil
}

func (w *Worker) tryReuseModeledTarget(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration ModeledConfigurationV1,
	request ModelRequest,
) (persistedTarget, bool, error) {
	candidate, err := w.Assurance.FindReusableModeledExtraction(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ModeledCacheLookupInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			ConfigurationHash: target.ConfigurationHash, OutboundMIMEHash: target.OutboundMIMEHash,
			CacheKey: request.CacheKey, InputManifestHash: request.InputManifestHash,
		})
	if err != nil {
		return persistedTarget{}, false, fmt.Errorf("%w: lookup modeled cache: %w", ErrLifecycle, err)
	}
	if candidate == nil || candidate.Extraction.RawOutputExpiresAt == nil ||
		!candidate.Extraction.RawOutputExpiresAt.After(w.Config.Now()) {
		return persistedTarget{}, false, nil
	}
	rest, err := campaignmaterializer.ParseObjectReference(candidate.Extraction.RawOutputObjectRef)
	if err != nil || !strings.HasPrefix(rest, "campaign-assurance/raw-output/runs/") {
		return persistedTarget{}, false, nil
	}
	body, contentType, err := w.RawOutputs.Get(ctx, claimed.Run.TenantID, rest)
	if err != nil || body == nil {
		return persistedTarget{}, false, nil
	}
	mediaType, _, mediaErr := mime.ParseMediaType(strings.TrimSpace(contentType))
	if mediaErr != nil || !strings.EqualFold(mediaType, "application/json") {
		_ = body.Close()
		return persistedTarget{}, false, nil
	}
	raw, readErr := io.ReadAll(io.LimitReader(body, int64(campaigncomprehension.MaxExtractionBytes)+1))
	closeErr := body.Close()
	if readErr != nil || closeErr != nil || len(raw) > campaigncomprehension.MaxExtractionBytes ||
		digestBytes(raw) != candidate.Extraction.RawOutputHash {
		return persistedTarget{}, false, nil
	}
	receipt, diagnostics := campaigncomprehension.DecodeAndNormalizeV1(raw, request.AllowedEvidenceIDs)
	if len(diagnostics) != 0 || !bytes.Equal(receipt.CanonicalExtraction, candidate.Extraction.NormalizedExtraction) {
		return persistedTarget{}, false, nil
	}
	evidence := mustJSON(map[string]any{
		"schema_version": 2, "worker_version": Version,
		"source_class":   campaignassurance.SourceModeled,
		"claim":          "predicted_agent_comprehension_not_provider_observation",
		"execution_kind": "cache_reuse", "provider_invoked": false,
		"run_id": claimed.Run.ID, "attempt_count": claimed.Run.AttemptCount,
		"artifact_id": target.ArtifactID, "configuration_id": target.ConfigurationID,
		"model_cache_key":                 request.CacheKey,
		"input_manifest_sha256":           request.InputManifestHash,
		"cache_reuse_id":                  request.BudgetInvocationID,
		"source_run_id":                   candidate.SourceRunID,
		"source_extraction_id":            candidate.Extraction.ID,
		"source_receipt_sha256":           candidate.Extraction.ReceiptHash,
		"source_raw_output_sha256":        candidate.Extraction.RawOutputHash,
		"source_original_input_tokens":    candidate.Extraction.InputTokens,
		"source_original_output_tokens":   candidate.Extraction.OutputTokens,
		"source_original_cost_microunits": candidate.Extraction.CostMicrounits,
		"reuse_cost_microunits":           0,
		"provider_display_status":         "not_observed",
	})
	temperature := configuration.Temperature
	input := campaignassurance.ExtractionInput{
		ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
		SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
		OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
		NormalizedExtraction: append(json.RawMessage(nil), candidate.Extraction.NormalizedExtraction...),
		EvidenceManifest:     evidence,
		UnsupportedClaims:    append(json.RawMessage(nil), candidate.Extraction.UnsupportedClaims...),
		Ambiguities:          append(json.RawMessage(nil), candidate.Extraction.Ambiguities...),
		RawOutputObjectRef:   candidate.Extraction.RawOutputObjectRef,
		RawOutputHash:        candidate.Extraction.RawOutputHash,
		RawOutputExpiresAt:   candidate.Extraction.RawOutputExpiresAt,
		ModelProvider:        candidate.Extraction.ModelProvider, ModelID: candidate.Extraction.ModelID,
		ModelVersion: candidate.Extraction.ModelVersion, PromptVersion: candidate.Extraction.PromptVersion,
		PromptHash: candidate.Extraction.PromptHash, SeedValue: candidate.Extraction.SeedValue,
		Temperature: &temperature, ModelCacheKey: request.CacheKey,
		ModelInputManifestHash:       request.InputManifestHash,
		ModelInvocationID:            request.BudgetInvocationID,
		ExecutionKind:                campaignassurance.ModeledExecutionCacheReuse,
		ReusedFromExtractionID:       candidate.Extraction.ID,
		ReusedFromReceiptHash:        candidate.Extraction.ReceiptHash,
		ReusedOriginalCostMicrounits: candidate.Extraction.CostMicrounits,
	}
	extraction, err := w.Assurance.RecordModeledCacheReuse(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ModeledCacheReuseInput{
			SourceExtractionID: candidate.Extraction.ID,
			SourceReceiptHash:  candidate.Extraction.ReceiptHash,
			Extraction:         input,
		})
	if errors.Is(err, campaignassurance.ErrNotFound) {
		return persistedTarget{}, false, nil
	}
	if err != nil {
		return persistedTarget{}, false, fmt.Errorf("%w: record modeled cache reuse: %w", ErrLifecycle, err)
	}
	receiptCopy := receipt
	return persistedTarget{
		status: campaignassurance.ExtractionComplete, sourceClass: campaignassurance.SourceModeled,
		extractionID: extraction.ID,
		modeledOutput: &campaigncomprehension.AnalyzerOutputV1{
			ConfigurationID: target.ConfigurationID, Receipt: &receiptCopy,
		},
	}, true, nil
}

func cloneModelRequest(input ModelRequest) ModelRequest {
	result := input
	// Run/attempt and budget reservation identities are operational fences. They
	// are deliberately withheld from executors so exact semantic cache reuse
	// cannot be perturbed by a retry identifier that the provider happens to
	// echo or attend to.
	result.RunID = ""
	result.AttemptCount = 0
	result.BudgetInvocationID = ""
	result.Evidence = append([]ModelEvidence(nil), input.Evidence...)
	result.AllowedEvidenceIDs = append([]string(nil), input.AllowedEvidenceIDs...)
	result.ExtractionSchema = append(json.RawMessage(nil), input.ExtractionSchema...)
	result.Vocabulary.FactSlots = append([]RecoveryFactSlot(nil), input.Vocabulary.FactSlots...)
	result.Artifact.StructuredData = append(json.RawMessage(nil), input.Artifact.StructuredData...)
	result.Artifact.RFC822 = append([]byte(nil), input.Artifact.RFC822...)
	return result
}

type retainedRawOutput struct {
	rest            string
	objectReference string
	sha256          string
	expiresAt       time.Time
}

func (w *Worker) retainRawOutput(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	raw []byte,
) (retainedRawOutput, error) {
	if w.RawOutputs == nil || len(raw) > campaigncomprehension.MaxExtractionBytes {
		return retainedRawOutput{}, ErrUnsupportedAnalyzer
	}
	rest := fmt.Sprintf(
		"campaign-assurance/raw-output/runs/%s/attempt-%d/artifacts/%s/configurations/%s/writes/%s.json",
		claimed.Run.ID, claimed.Run.AttemptCount, target.ArtifactID, target.ConfigurationHash, uuid.NewString(),
	)
	key, err := w.RawOutputs.Put(ctx, claimed.Run.TenantID, rest, "application/json", bytes.NewReader(raw))
	if err != nil {
		return retainedRawOutput{}, fmt.Errorf("retain modeled raw output: %w", err)
	}
	expectedKey := "tenants/" + claimed.Run.TenantID + "/" + rest
	if key != expectedKey {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), w.Config.CleanupTimeout)
		cleanupErr := w.RawOutputs.Delete(cleanup, claimed.Run.TenantID, rest)
		cancel()
		identityErr := fmt.Errorf("retain modeled raw output: object store returned a non-canonical key")
		if cleanupErr != nil {
			return retainedRawOutput{}, errors.Join(identityErr, cleanupErr)
		}
		return retainedRawOutput{}, identityErr
	}
	return retainedRawOutput{
		rest: rest, objectReference: campaignmaterializer.FormatObjectReference(rest),
		sha256: digestBytes(raw), expiresAt: w.Config.Now().UTC().Add(w.Config.RawOutputTTL),
	}, nil
}

func (w *Worker) cleanupRetainedOutput(
	parent context.Context,
	tenantID string,
	retained retainedRawOutput,
	cause error,
) error {
	if retained.rest == "" || w.RawOutputs == nil {
		return cause
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(parent), w.Config.CleanupTimeout)
	defer cancel()
	if err := w.RawOutputs.Delete(cleanup, tenantID, retained.rest); err != nil {
		return errors.Join(cause, fmt.Errorf("cleanup unlinked modeled raw output: %w", err))
	}
	return cause
}

func retainedFailureBytes(raw []byte) []byte {
	if len(raw) > campaigncomprehension.MaxExtractionBytes {
		return nil
	}
	return append([]byte(nil), raw...)
}

type modeledFailureInput struct {
	status                string
	errorCode             string
	publicMessage         string
	findingCode           string
	invoked               bool
	rawOutputHash         string
	rawOutput             []byte
	retainRaw             bool
	latencyMS             int64
	inputTokens           int64
	outputTokens          int64
	costMicrounits        int64
	validationDiagnostics []map[string]string
	request               *ModelRequest
}

func (w *Worker) recordModeledFailure(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration ModeledConfigurationV1,
	failure modeledFailureInput,
) (persistedTarget, error) {
	invocationStatus := "not_invoked"
	if failure.invoked {
		invocationStatus = "invoked_without_valid_extraction"
	}
	var retained retainedRawOutput
	var err error
	if failure.retainRaw {
		retained, err = w.retainRawOutput(ctx, claimed, target, failure.rawOutput)
		if err != nil {
			return persistedTarget{}, err
		}
	}
	retentionStatus := "not_available"
	if retained.objectReference != "" {
		retentionStatus = "tenant_scoped_object_store"
	} else if failure.rawOutputHash != "" {
		retentionStatus = "discarded_over_limit"
	}
	evidence := mustJSON(map[string]any{
		"schema_version": 1, "worker_version": Version,
		"source_class": campaignassurance.SourceModeled,
		"claim":        "predicted_agent_comprehension_not_provider_observation",
		"status":       failure.status, "reason_code": failure.errorCode,
		"invocation_status": invocationStatus, "raw_output_sha256": failure.rawOutputHash,
		"raw_output_retention":    retentionStatus,
		"validation_diagnostics":  failure.validationDiagnostics,
		"provider_display_status": "not_observed",
	})
	if failure.request != nil {
		var decoded map[string]any
		_ = json.Unmarshal(evidence, &decoded)
		decoded["model_cache_key"] = failure.request.CacheKey
		decoded["input_manifest_sha256"] = failure.request.InputManifestHash
		decoded["budget_invocation_id"] = failure.request.BudgetInvocationID
		evidence = mustJSON(decoded)
	}
	temperature := configuration.Temperature
	input := campaignassurance.ExtractionInput{
		ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
		SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
		OutboundMIMEHash: target.OutboundMIMEHash, Status: failure.status,
		EvidenceManifest:  evidence,
		UnsupportedClaims: json.RawMessage(`[]`), Ambiguities: json.RawMessage(`[]`),
		ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
		ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
		PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
		Temperature: &temperature, InputTokens: failure.inputTokens,
		OutputTokens: failure.outputTokens, CostMicrounits: failure.costMicrounits,
		LatencyMS: failure.latencyMS, ErrorCode: failure.errorCode,
		ErrorMessage: failure.publicMessage,
	}
	if failure.invoked && failure.request != nil {
		input.ModelCacheKey = failure.request.CacheKey
		input.ModelInputManifestHash = failure.request.InputManifestHash
		input.ModelInvocationID = failure.request.BudgetInvocationID
		input.ExecutionKind = campaignassurance.ModeledExecutionInvoked
	}
	if retained.objectReference != "" {
		input.RawOutputObjectRef = retained.objectReference
		input.RawOutputHash = retained.sha256
		input.RawOutputExpiresAt = &retained.expiresAt
	}
	extraction, err := w.Assurance.RecordExtraction(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, input)
	if err != nil {
		return persistedTarget{}, w.cleanupRetainedOutput(ctx, claimed.Run.TenantID, retained,
			fmt.Errorf("%w: record modeled failure: %w", ErrLifecycle, err))
	}
	blocking := failure.status == campaignassurance.ExtractionError
	severity := "warning"
	if blocking {
		severity = "critical"
	}
	_, err = w.Assurance.RecordFinding(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.FindingInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			ExtractionID: extraction.ID, Code: failure.findingCode,
			SourceClass: campaignassurance.SourceModeled, Severity: severity,
			Blocking: blocking, Overridable: false, Dimension: "modeled_comprehension",
			BlockReferences: json.RawMessage(`[]`),
			EvidenceReferences: mustJSON([]map[string]any{{
				"representation": "modeled_output", "location": "/",
			}}),
			ExpectedValue:   mustJSON(map[string]any{"status": "complete"}),
			ObservedValue:   mustJSON(map[string]any{"status": failure.status, "reason_code": failure.errorCode}),
			Explanation:     "The configured modeled execution did not produce a valid evidence-bound extraction; no score or successful comprehension claim was inferred.",
			Remediation:     mustJSON(map[string]any{"kind": "review_modeled_executor"}),
			DetectorVersion: campaigncomprehension.ScoreVersionV1,
			PolicyVersion:   claimed.Run.GatePolicyVersion,
		})
	if err != nil {
		return persistedTarget{}, fmt.Errorf("%w: record modeled failure finding: %w", ErrLifecycle, err)
	}
	blockers := 0
	if blocking {
		blockers = 1
	}
	return persistedTarget{
		findings: 1, blockers: blockers, status: failure.status,
		sourceClass: campaignassurance.SourceModeled, extractionID: extraction.ID,
		modeledOutput: &campaigncomprehension.AnalyzerOutputV1{
			ConfigurationID: target.ConfigurationID, FailureCode: failure.errorCode,
		},
	}, nil
}

func compactValidationDiagnostics(values campaigncomprehension.ValidationErrors) []map[string]string {
	limit := len(values)
	if limit > 32 {
		limit = 32
	}
	result := make([]map[string]string, 0, limit)
	for _, value := range values[:limit] {
		result = append(result, map[string]string{"path": value.Path, "code": string(value.Code)})
	}
	return result
}

func compactUnsupportedClaims(values []campaigncomprehension.UnsupportedClaim) json.RawMessage {
	result := make([]compactExtractionIndex, 0, len(values))
	for index, value := range values {
		result = append(result, compactExtractionIndex{
			Ordinal: index + 1, ValueSHA256: digestBytes([]byte(value.Statement)),
			EvidenceCount: len(value.EvidenceIDs), EvidenceSHA256: digestBytes(mustJSON(value.EvidenceIDs)),
		})
	}
	return mustJSON(result)
}

func compactAmbiguities(values []campaigncomprehension.Ambiguity) json.RawMessage {
	result := make([]compactExtractionIndex, 0, len(values))
	for index, value := range values {
		result = append(result, compactExtractionIndex{
			Ordinal: index + 1, ValueSHA256: digestBytes([]byte(value.Field + "\x00" + value.Description)),
			EvidenceCount: len(value.EvidenceIDs), EvidenceSHA256: digestBytes(mustJSON(value.EvidenceIDs)),
		})
	}
	return mustJSON(result)
}
