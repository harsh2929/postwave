// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
)

// F06's model-backed half, as one more reviewed configuration.
//
// campaignchecks owns the question and the arithmetic; it deliberately owns no
// HTTP client, credential, or budget. This file is the only thing that connects
// the two, and it is written so that connecting them cannot widen the reviewed
// surface:
//
//   - The prompt is NOT passed through to the provider as caller-supplied text.
//     ModelRequest still has no free-form prompt field. The summarisation prompt
//     is a member of the same frozen reviewed suite as the eight extraction
//     prompts, is bound into ProductionPromptSuiteHashV1 by the hash of its
//     exact bytes, and is selected by PromptVersion exactly like its siblings.
//   - The one thing a Summarizer hands this package — the rendered prompt — is
//     checked for byte equality against the frozen reviewed rendering and
//     refused otherwise. A future Summarizer that asks a different question
//     fails its runs; it does not get to ask it.
//   - An absent, refused, or failing summariser produces
//     SUMMARY_STABILITY_NOT_ASSESSED and an unavailable extraction. It never
//     produces a pass, and it is never silent.

const (
	// SummaryStabilityConfigurationID is the reviewed configuration identity a
	// run creator freezes to obtain the model-backed half of F06.
	SummaryStabilityConfigurationID = "modeled.summary-stability"

	// SummaryStabilityPromptVersionV1 selects the summarisation member of the
	// frozen reviewed prompt suite, the same way an extraction configuration
	// selects one of the eight analyzer members.
	SummaryStabilityPromptVersionV1 = "summary-stability.v1"

	// summaryStabilityTemperatureV1 is reviewed, not tuned at the call site.
	//
	// Stability is a question about what a recipient's assistant would actually
	// do, and a real assistant samples. Eight runs at temperature zero with one
	// seed are eight copies of one answer, so a check that ran that way would
	// report perfect stability for every campaign ever sent — the exact
	// always-green check this feature exists to avoid being.
	summaryStabilityTemperatureV1 = 0.8

	summaryStabilityNotAssessedCode    = "summary_stability_not_assessed"
	summaryStabilityNotAssessedMessage = "summary stability was not measured for this artifact; absence of a measurement is not a passing measurement"
)

var (
	errSummaryPromptUnreviewed = errors.New("campaign assurance worker: summariser asked a prompt outside the frozen reviewed suite")
	errSummaryRunBudget        = errors.New("campaign assurance worker: summariser exceeded the frozen run count")
	errSummaryRunCost          = errors.New("campaign assurance worker: summarisation run exceeded its share of the frozen reservation")
	errSummaryRunUsage         = errors.New("campaign assurance worker: summarisation run returned unusable metering")
	errSummaryRunProvenance    = errors.New("campaign assurance worker: summarisation run returned a foreign runtime identity")
)

// productionSummaryPromptDefinitionV1 is the summarisation member of the frozen
// reviewed prompt suite.
//
// It is declared here rather than appended to productionPromptDefinitionsV1
// because that slice is the analyzer ensemble: ProductionGeminiConfigurations
// takes a prefix of it, and a summarisation prompt inside that prefix would be
// asked to satisfy the extraction schema, which it cannot. It is nonetheless a
// full member of the suite — ProductionPromptSuiteHashV1 hashes it, so its
// bytes cannot move without moving the suite identity that every run pins.
var productionSummaryPromptDefinitionV1 = productionPromptDefinition{
	Version: SummaryStabilityPromptVersionV1,
	Focus: "Summarise the compiled message the way a recipient's inbox assistant would, " +
		"so that repeated answers about one frozen artifact can be compared for stability.",
	RepresentationOrder: []string{"subject", "text_plain", "html"},
	Seed:                4201,
}

func isSummaryStabilityConfiguration(configuration ModeledConfigurationV1) bool {
	return configuration.PromptVersion == SummaryStabilityPromptVersionV1
}

// NewSummaryStabilityConfiguration freezes the reviewed summarisation
// configuration for one deployment's model suite.
func NewSummaryStabilityConfiguration(
	modelProvider, modelSuiteVersion, modelID, modelVersion string,
	executor ModelExecutorIdentity,
	timeout time.Duration,
) (campaignassurance.ConfigurationInput, error) {
	return NewModeledConfiguration(SummaryStabilityConfigurationID, ModeledConfigurationV1{
		SchemaVersion:   ModeledConfigurationSchemaVersionV1,
		ExecutorID:      executor.ID,
		ExecutorVersion: executor.Version,

		ModelSuiteVersion: modelSuiteVersion,
		ModelProvider:     modelProvider,
		ModelID:           modelID,
		ModelVersion:      modelVersion,

		PromptSuiteVersion: ProductionPromptSuiteVersionV1,
		PromptVersion:      productionSummaryPromptDefinitionV1.Version,
		PromptHash:         ProductionPromptSuiteHashV1(),

		SeedValue:   strconv.FormatInt(productionSummaryPromptDefinitionV1.Seed, 10),
		Temperature: summaryStabilityTemperatureV1,

		TimeoutMS:             timeout.Milliseconds(),
		MaximumCostMicrounits: executor.MaximumCostMicrounits,
	})
}

// summaryModelInvoker adapts the reviewed ModelExecutor to campaignchecks'
// ModelInvoke without letting an unreviewed prompt reach a provider.
type summaryModelInvoker struct {
	worker         *Worker
	configuration  ModeledConfigurationV1
	request        ModelRequest
	expectedPrompt string
	perRunCap      int64

	run            int
	answered       int
	inputTokens    int64
	outputTokens   int64
	costMicrounits int64
	rawResponses   []json.RawMessage
}

func (i *summaryModelInvoker) invoke(ctx context.Context, prompt string) (string, error) {
	if i.run >= campaignchecks.SummaryRunCount {
		return "", errSummaryRunBudget
	}
	i.run++
	// The prompt is verified, never forwarded. It is recomputed here from the
	// frozen reviewed suite and the closed artifact, so a Summarizer that has
	// been swapped for one asking a different question is refused before any
	// provider call, rather than quietly measuring the stability of an answer
	// to a question nobody reviewed.
	if prompt != i.expectedPrompt {
		return "", errSummaryPromptUnreviewed
	}

	request := cloneModelRequest(i.request)
	request.SummaryRun = i.run
	// Per-run invocation identity. An executor that caches on CacheKey would
	// otherwise return one answer eight times, and eight copies of one answer
	// are perfectly stable no matter how unstable the model is.
	runIdentity := digestBytes(mustJSON(struct {
		SchemaVersion int    `json:"schema_version"`
		CacheKey      string `json:"model_cache_key"`
		PromptVersion string `json:"prompt_version"`
		Run           int    `json:"run"`
	}{1, i.request.CacheKey, i.configuration.PromptVersion, i.run}))
	request.InvocationID = runIdentity
	request.CacheKey = runIdentity

	timeout := time.Duration(i.configuration.TimeoutMS) * time.Millisecond
	callContext, cancel := context.WithTimeout(ctx, timeout)
	result, err := i.worker.ModelExecutor.Execute(callContext, request)
	cancel()
	if err != nil {
		return "", err
	}
	if !validModelResultUsage(result) {
		return "", errSummaryRunUsage
	}
	// Each run may spend at most its share of the single reservation taken for
	// the whole assessment, so eight runs can never settle above what was
	// reserved. A run that costs more than its share is discarded rather than
	// accepted, which costs this artifact a pass and never costs the budget.
	if result.CostMicrounits > i.perRunCap {
		i.costMicrounits += i.perRunCap
		return "", errSummaryRunCost
	}
	if !provenanceMatches(result.Provenance, i.configuration) {
		return "", errSummaryRunProvenance
	}
	i.inputTokens += result.InputTokens
	i.outputTokens += result.OutputTokens
	i.costMicrounits += result.CostMicrounits
	i.answered++
	if len(result.RawExtraction) <= campaignchecks.MaxSummaryFieldBytes*4 {
		i.rawResponses = append(i.rawResponses, mustJSON(string(result.RawExtraction)))
	}
	return string(result.RawExtraction), nil
}

// analyzeSummaryStabilityTarget executes the reviewed summarisation
// configuration for one frozen artifact.
//
// It runs after that artifact's analyzer configurations because the reviewed
// suite declares it last, and run targets are frozen artifact-major: every
// comprehension extraction for an artifact is already durable before this is
// reached. It does not depend on their results — a stability verdict is about
// the message, not about the ensemble — but the ordering keeps one artifact's
// evidence contiguous in the receipt.
func (w *Worker) analyzeSummaryStabilityTarget(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration ModeledConfigurationV1,
	loaded loadedArtifact,
) (persistedTarget, error) {
	request := buildModelRequest(claimed, target, configuration, RecoveryVocabularyV1{
		SchemaVersion: 1, FactSlots: []RecoveryFactSlot{},
	}, loaded)

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
		return persistedTarget{}, fmt.Errorf("%w: reserve summary stability invocation: %w", ErrLifecycle, err)
	}

	checkInput := campaignchecks.Input{
		Revision: loaded.revision, Compilation: loaded.compilation,
		PolicyVersion: claimed.Run.GatePolicyVersion,
	}
	invoker := w.newSummaryInvoker(configuration, request, checkInput)
	var summarizer campaignchecks.Summarizer
	if invoker != nil {
		// The production summariser: campaignchecks owns the strict parser, so
		// a model that will not answer in the frozen schema produces a counted
		// failed run instead of a draft invented out of an apology.
		summarizer = campaignchecks.NewJSONSummarizer(invoker.invoke)
	}

	started := time.Now()
	stability := campaignchecks.AssessSummaryStability(ctx, checkInput, summarizer)
	elapsed := time.Since(started)
	if cause := context.Cause(ctx); cause != nil {
		// A cancelled run has not measured anything. Persisting a receipt built
		// from runs that were skipped because the worker was shutting down would
		// attribute the worker's cancellation to the campaign.
		return persistedTarget{}, cause
	}

	usage := summaryUsage{}
	if invoker != nil {
		usage = summaryUsage{
			invoked: invoker.run, answered: invoker.answered,
			inputTokens: invoker.inputTokens, outputTokens: invoker.outputTokens,
			costMicrounits: invoker.costMicrounits, rawResponses: invoker.rawResponses,
		}
	}
	if err := w.settleSummaryInvocation(ctx, claimed, request, stability, usage, elapsed); err != nil {
		return persistedTarget{}, err
	}
	return w.persistSummaryStability(ctx, claimed, target, configuration, request, stability, usage, elapsed)
}

type summaryUsage struct {
	invoked        int
	answered       int
	inputTokens    int64
	outputTokens   int64
	costMicrounits int64
	rawResponses   []json.RawMessage
}

func (w *Worker) newSummaryInvoker(
	configuration ModeledConfigurationV1,
	request ModelRequest,
	checkInput campaignchecks.Input,
) *summaryModelInvoker {
	if w.ModelExecutor == nil {
		// Unreachable through the normal path — a worker with no executor turns
		// every modeled configuration unavailable before an artifact is read —
		// but a nil Summarizer is the correct degradation, and it is cheaper to
		// be correct here than to rely on a caller staying correct.
		return nil
	}
	summaryRequest, withinBounds := campaignchecks.NewSummaryRequestV1(checkInput)
	if !withinBounds {
		// AssessSummaryStability applies the same bound and reports
		// artifact_exceeds_summarisation_bounds; there is nothing to precompute.
		return nil
	}
	perRunCap := configuration.MaximumCostMicrounits / int64(campaignchecks.SummaryRunCount)
	return &summaryModelInvoker{
		worker: w, configuration: configuration, request: request,
		expectedPrompt: campaignchecks.RenderSummaryPromptV1(summaryRequest),
		perRunCap:      perRunCap,
	}
}

func (w *Worker) settleSummaryInvocation(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	request ModelRequest,
	stability campaignchecks.SummaryStabilityV1,
	usage summaryUsage,
	elapsed time.Duration,
) error {
	status, reason := campaignassurance.InvocationResultComplete, ""
	if stability.Status == campaignchecks.AssessmentNotAssessed {
		status, reason = campaignassurance.InvocationResultUnavailable, summaryStabilityNotAssessedCode
	}
	_, err := w.Assurance.RecordModeledInvocationResult(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ModeledInvocationResultInput{
			InvocationID: request.BudgetInvocationID, Status: status,
			InputTokens: usage.inputTokens, OutputTokens: usage.outputTokens,
			CostMicrounits: usage.costMicrounits, LatencyMS: elapsed.Milliseconds(),
			ReasonCode: reason,
		})
	if err != nil {
		return fmt.Errorf("%w: settle summary stability invocation: %w", ErrLifecycle, err)
	}
	return nil
}

func (w *Worker) persistSummaryStability(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration ModeledConfigurationV1,
	request ModelRequest,
	stability campaignchecks.SummaryStabilityV1,
	usage summaryUsage,
	elapsed time.Duration,
) (persistedTarget, error) {
	blockers := 0
	for _, finding := range stability.Findings {
		if finding.Blocking {
			blockers++
		}
	}
	assessed := stability.Status != campaignchecks.AssessmentNotAssessed
	report := summaryStabilityReport(stability, usage, blockers)

	// Model output is derived from artifact content, and artifact content is
	// exactly where an injection attempt lives, so the drafts are never echoed
	// into a receipt or a finding. They go, verbatim, to the same tenant-scoped
	// encrypted store every other raw model output goes to.
	var retained retainedRawOutput
	rawOutput := mustJSON(usage.rawResponses)
	// Nothing is retained for a run that produced no provider bytes. A durable
	// raw-output reference to an empty array would read as "the answers are on
	// file" for an assessment whose answers do not exist.
	retainable := len(usage.rawResponses) > 0 && w.RawOutputs != nil &&
		len(rawOutput) <= campaigncomprehension.MaxExtractionBytes
	if retainable {
		var err error
		retained, err = w.retainRawOutput(ctx, claimed, target, rawOutput)
		if err != nil {
			return persistedTarget{}, err
		}
	}

	input := campaignassurance.ExtractionInput{
		ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
		SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
		OutboundMIMEHash: target.OutboundMIMEHash,
		EvidenceManifest: summaryStabilityEvidence(claimed, target, request, stability, usage, report, retained),
		UnsupportedClaims: mustJSON([]string{
			"comprehension_not_measured", "provider_display_not_observed",
		}),
		Ambiguities:   json.RawMessage(`[]`),
		ModelProvider: configuration.ModelProvider, ModelID: configuration.ModelID,
		ModelVersion: configuration.ModelVersion, PromptVersion: configuration.PromptVersion,
		PromptHash: configuration.PromptHash, SeedValue: configuration.SeedValue,
		InputTokens: usage.inputTokens, OutputTokens: usage.outputTokens,
		CostMicrounits: usage.costMicrounits, LatencyMS: elapsed.Milliseconds(),
	}
	temperature := configuration.Temperature
	input.Temperature = &temperature
	if usage.invoked > 0 {
		input.ModelCacheKey = request.CacheKey
		input.ModelInputManifestHash = request.InputManifestHash
		input.ModelInvocationID = request.BudgetInvocationID
		input.ExecutionKind = campaignassurance.ModeledExecutionInvoked
	}
	if retained.objectReference != "" {
		input.RawOutputObjectRef = retained.objectReference
		input.RawOutputHash = retained.sha256
		input.RawOutputExpiresAt = &retained.expiresAt
	}
	if assessed {
		input.Status = campaignassurance.ExtractionComplete
		// The variance lives in the normalized extraction: it is the measurement,
		// not a diagnostic about the measurement.
		input.NormalizedExtraction = report
	} else {
		// The durable receipt shape forbids a normalized extraction on a
		// non-complete status, and rightly so — a normalized extraction is the
		// record of a measurement that happened. The variance is still carried,
		// in the evidence manifest, because "six of eight runs answered" is the
		// evidence for the not-assessed verdict.
		input.Status = campaignassurance.ExtractionUnavailable
		input.ErrorCode = summaryStabilityNotAssessedCode
		input.ErrorMessage = summaryStabilityNotAssessedMessage
	}

	extraction, err := w.Assurance.RecordExtraction(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, input)
	if err != nil {
		return persistedTarget{}, w.cleanupRetainedOutput(ctx, claimed.Run.TenantID, retained,
			fmt.Errorf("%w: record summary stability extraction: %w", ErrLifecycle, err))
	}
	for _, finding := range stability.Findings {
		fields, err := finding.PersistenceFields()
		if err != nil {
			return persistedTarget{}, fmt.Errorf("encode summary stability finding: %w", err)
		}
		_, err = w.Assurance.RecordFinding(ctx, claimed.Run.TenantID, claimed.Run.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.FindingInput{
				ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
				ExtractionID: extraction.ID, Code: fields.Code,
				// campaignchecks labels every finding it mints "deterministic"
				// because Analyze is. These came from eight model calls, and the
				// durable target this attaches to is the modeled one, so the
				// source class is corrected here rather than misreported.
				SourceClass: campaignassurance.SourceModeled,
				Severity:    fields.Severity, Blocking: fields.Blocking, Overridable: fields.Overridable,
				Dimension: fields.Dimension, BlockReferences: fields.BlockReferences,
				EvidenceReferences: fields.EvidenceReferences, ExpectedValue: fields.ExpectedValue,
				ObservedValue: fields.ObservedValue, Explanation: fields.Explanation,
				Remediation: fields.Remediation, TypedPatch: fields.TypedPatch,
				TypedPatchSchemaVersion: fields.TypedPatchSchemaVersion,
				DetectorVersion:         fields.DetectorVersion, PolicyVersion: fields.PolicyVersion,
			})
		if err != nil {
			return persistedTarget{}, fmt.Errorf("%w: record summary stability finding: %w", ErrLifecycle, err)
		}
	}

	status := campaignassurance.ExtractionComplete
	if !assessed {
		status = campaignassurance.ExtractionUnavailable
	}
	return persistedTarget{
		findings: len(stability.Findings), blockers: blockers, status: status,
		sourceClass: campaignassurance.SourceModeled, extractionID: extraction.ID,
	}, nil
}

func summaryStabilityReport(
	stability campaignchecks.SummaryStabilityV1,
	usage summaryUsage,
	blockers int,
) json.RawMessage {
	return mustJSON(map[string]any{
		"schema_version":          1,
		"kind":                    "summary_stability_report",
		"worker_version":          Version,
		"detector_version":        campaignchecks.DetectorVersion,
		"prompt_version":          stability.PromptVersion,
		"assessment_status":       string(stability.Status),
		"capability":              stability.Capability,
		"required_runs":           campaignchecks.SummaryRunCount,
		"invoked_runs":            usage.invoked,
		"variance":                stability.Variance,
		"finding_count":           len(stability.Findings),
		"blocking_finding_count":  blockers,
		"comprehension_status":    "not_measured",
		"provider_display_status": "not_observed",
	})
}

func summaryStabilityEvidence(
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	request ModelRequest,
	stability campaignchecks.SummaryStabilityV1,
	usage summaryUsage,
	report json.RawMessage,
	retained retainedRawOutput,
) json.RawMessage {
	retention := "not_available"
	if retained.objectReference != "" {
		retention = "tenant_scoped_object_store"
	} else if usage.answered > 0 {
		retention = "discarded_over_limit"
	}
	return mustJSON(map[string]any{
		"schema_version": 1, "worker_version": Version,
		"source_class": campaignassurance.SourceModeled,
		"claim":        "predicted_summary_stability_not_provider_observation",
		"run_id":       claimed.Run.ID, "attempt_count": claimed.Run.AttemptCount,
		"artifact_id": target.ArtifactID, "configuration_id": target.ConfigurationID,
		"invocation_id": request.InvocationID, "budget_invocation_id": request.BudgetInvocationID,
		"input_manifest_sha256": request.InputManifestHash,
		"execution_kind":        summaryExecutionKind(usage),
		"provider_invoked":      usage.invoked > 0,
		"required_runs":         campaignchecks.SummaryRunCount,
		"invoked_runs":          usage.invoked, "answered_runs": usage.answered,
		"assessment_status":       string(stability.Status),
		"prompt_version":          stability.PromptVersion,
		"variance":                stability.Variance,
		"summary_report_sha256":   digestBytes(report),
		"raw_output_sha256":       retained.sha256,
		"raw_output_retention":    retention,
		"provider_display_status": "not_observed",
	})
}

func summaryExecutionKind(usage summaryUsage) string {
	if usage.invoked > 0 {
		return "invoked"
	}
	return "not_invoked"
}
