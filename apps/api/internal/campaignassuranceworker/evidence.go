// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

type executionSummary struct {
	findings              int
	blockers              int
	unavailable           int
	deterministicFindings int
	deterministicBlockers int
	modeledFindings       int
	modeledBlockers       int
	modeledScores         *modeledScoreFinalization
}

type persistedTarget struct {
	findings      int
	blockers      int
	status        string
	sourceClass   string
	extractionID  string
	modeledOutput *campaigncomprehension.AnalyzerOutputV1
}

func validateDeterministicConfiguration(raw json.RawMessage, policyVersion string) error {
	var configuration DeterministicConfiguration
	if len(raw) > 64<<10 || decodeStrict(raw, &configuration) != nil {
		return ErrUnsupportedAnalyzer
	}
	if configuration.AnalyzerVersion != campaignchecks.DetectorVersion ||
		configuration.PolicyVersion != strings.TrimSpace(policyVersion) ||
		!validVersion(configuration.PolicyVersion) {
		return ErrUnsupportedAnalyzer
	}
	return nil
}

func (w *Worker) analyzeDeterministicTarget(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	configuration campaignassurance.RunConfiguration,
	loaded loadedArtifact,
) (persistedTarget, error) {
	if target.SourceClass != campaignassurance.SourceDeterministic ||
		configuration.SourceClass != campaignassurance.SourceDeterministic ||
		configuration.ID != DeterministicConfigurationID ||
		validateDeterministicConfiguration(configuration.Configuration, claimed.Run.GatePolicyVersion) != nil {
		return w.recordUnavailable(ctx, claimed, target, unavailableSpec{
			errorCode:   "deterministic_analyzer_unsupported",
			message:     "the frozen deterministic analyzer configuration is not executable by this worker version",
			code:        "DETERMINISTIC_ANALYZER_UNAVAILABLE",
			severity:    "critical",
			blocking:    true,
			dimension:   "execution",
			explanation: "The required deterministic analyzer identity or policy is unsupported; no structural or comprehension success was inferred.",
			remediation: "rerun_with_supported_analyzer",
		})
	}

	imageAnalysis, err := w.inspectArtifactImages(ctx, claimed, loaded)
	if err != nil {
		return persistedTarget{}, err
	}
	// F15's canonical-offer bridge, resolved HERE because it is a database read
	// and Analyze is pure. A resolver failure is not fatal: the checks then see a
	// nil slice and report nothing assessed, which is the honest outcome and is
	// distinct from reporting agreement.
	canonicalOffers := w.resolveCanonicalOffers(ctx, claimed, loaded)

	report := campaignchecks.Analyze(campaignchecks.Input{
		Revision: loaded.revision, Compilation: loaded.compilation,
		PolicyVersion: claimed.Run.GatePolicyVersion, ImageMetadata: imageAnalysis.metadata,
		CanonicalOffers: canonicalOffers,
	})
	blockers := 0
	for _, finding := range report.Findings {
		if finding.Blocking {
			blockers++
		}
	}
	normalized := mustJSON(map[string]any{
		"schema_version":          1,
		"kind":                    "deterministic_structural_report",
		"scenario_id":             report.ScenarioID,
		"detector_version":        report.DetectorVersion,
		"policy_version":          report.PolicyVersion,
		"finding_count":           len(report.Findings),
		"blocking_finding_count":  blockers,
		"comprehension_status":    "not_measured",
		"provider_display_status": "not_observed",
		"capabilities":            report.Capabilities,
		"image_analysis":          imageAnalysis.normalizedReceipt(),
	})
	evidence := mustJSON(map[string]any{
		"schema_version": 1,
		"worker_version": Version,
		"representations": []map[string]any{
			{"name": "html", "sha256": loaded.artifact.HTMLHash},
			{"name": "text_plain", "sha256": loaded.artifact.TextHash},
			{"name": "mime", "sha256": loaded.artifact.OutboundMIMEHash},
		},
		"compiler_receipt_sha256":        digestBytes(loaded.artifact.CompilerReceipt),
		"representation_manifest_sha256": digestBytes(loaded.artifact.RepresentationManifest),
		"capabilities":                   report.Capabilities,
		"image_analysis":                 imageAnalysis.evidenceReceipt(),
	})
	unsupported := deterministicUnsupportedClaims(report.Capabilities)
	extraction, err := w.Assurance.RecordExtraction(ctx, claimed.Run.TenantID, claimed.Run.ID,
		*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.ExtractionInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
			OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionComplete,
			NormalizedExtraction: normalized, EvidenceManifest: evidence,
			UnsupportedClaims: unsupported, Ambiguities: json.RawMessage(`[]`),
			LatencyMS: imageAnalysis.report.LatencyMS,
		})
	if err != nil {
		return persistedTarget{}, fmt.Errorf("%w: record deterministic extraction: %w", ErrLifecycle, err)
	}
	for _, finding := range report.Findings {
		fields, err := finding.PersistenceFields()
		if err != nil {
			return persistedTarget{}, fmt.Errorf("encode deterministic finding: %w", err)
		}
		_, err = w.Assurance.RecordFinding(ctx, claimed.Run.TenantID, claimed.Run.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, campaignassurance.FindingInput{
				ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
				ExtractionID: extraction.ID, Code: fields.Code, SourceClass: fields.SourceClass,
				Severity: fields.Severity, Blocking: fields.Blocking, Overridable: fields.Overridable,
				Dimension: fields.Dimension, BlockReferences: fields.BlockReferences,
				EvidenceReferences: fields.EvidenceReferences, ExpectedValue: fields.ExpectedValue,
				ObservedValue: fields.ObservedValue, Explanation: fields.Explanation,
				Remediation: fields.Remediation, TypedPatch: fields.TypedPatch,
				TypedPatchSchemaVersion: fields.TypedPatchSchemaVersion,
				DetectorVersion:         fields.DetectorVersion, PolicyVersion: fields.PolicyVersion,
			})
		if err != nil {
			return persistedTarget{}, fmt.Errorf("%w: record deterministic finding: %w", ErrLifecycle, err)
		}
	}
	return persistedTarget{
		findings: len(report.Findings), blockers: blockers, status: campaignassurance.ExtractionComplete,
		sourceClass: campaignassurance.SourceDeterministic, extractionID: extraction.ID,
	}, nil
}

type unavailableSpec struct {
	errorCode   string
	message     string
	code        string
	severity    string
	blocking    bool
	dimension   string
	explanation string
	remediation string
}

func (w *Worker) recordUnavailable(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	target campaignassurance.RunTarget,
	spec unavailableSpec,
) (persistedTarget, error) {
	run := claimed.Run
	evidence := mustJSON(map[string]any{
		"schema_version": 1,
		"worker_version": Version,
		"status":         "unavailable",
		"reason_code":    spec.errorCode,
		"claims": map[string]string{
			"comprehension":    "not_measured",
			"provider_display": "not_observed",
		},
	})
	input := campaignassurance.ExtractionInput{
		ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
		SourceClass: target.SourceClass, ConfigurationHash: target.ConfigurationHash,
		OutboundMIMEHash: target.OutboundMIMEHash, Status: campaignassurance.ExtractionUnavailable,
		EvidenceManifest: evidence,
		UnsupportedClaims: mustJSON([]string{
			"comprehension_not_measured", "provider_display_not_observed",
		}),
		Ambiguities: json.RawMessage(`[]`), ErrorCode: spec.errorCode, ErrorMessage: spec.message,
	}
	if target.SourceClass == campaignassurance.SourceModeled {
		// These literal identities describe non-execution; they are not a claim
		// that a provider/model was invoked. Frozen suite/prompt versions remain
		// attached so the unavailable receipt cannot migrate across runs.
		input.ModelProvider = "not_invoked"
		input.ModelID = "not_invoked"
		input.ModelVersion = run.ModelSuiteVersion
		input.PromptVersion = run.PromptSuiteVersion
		input.PromptHash = run.PromptSuiteHash
	}
	extraction, err := w.Assurance.RecordExtraction(ctx, run.TenantID, run.ID,
		*run.ClaimToken, run.AttemptCount, input)
	if err != nil {
		return persistedTarget{}, fmt.Errorf("%w: record unavailable extraction: %w", ErrLifecycle, err)
	}
	_, err = w.Assurance.RecordFinding(ctx, run.TenantID, run.ID,
		*run.ClaimToken, run.AttemptCount, campaignassurance.FindingInput{
			ArtifactID: target.ArtifactID, ConfigurationID: target.ConfigurationID,
			ExtractionID: extraction.ID, Code: spec.code, SourceClass: target.SourceClass,
			Severity: spec.severity, Blocking: spec.blocking, Overridable: false,
			Dimension: spec.dimension, BlockReferences: json.RawMessage(`[]`),
			EvidenceReferences: mustJSON([]map[string]any{{
				"representation": "representation_manifest", "location": "/",
			}}),
			ExpectedValue:   mustJSON(map[string]any{"terminal_status": "complete"}),
			ObservedValue:   mustJSON(map[string]any{"terminal_status": "unavailable", "reason_code": spec.errorCode}),
			Explanation:     spec.explanation,
			Remediation:     mustJSON(map[string]any{"kind": spec.remediation}),
			DetectorVersion: Version, PolicyVersion: run.GatePolicyVersion,
		})
	if err != nil {
		return persistedTarget{}, fmt.Errorf("%w: record unavailable finding: %w", ErrLifecycle, err)
	}
	blockers := 0
	if spec.blocking {
		blockers = 1
	}
	persisted := persistedTarget{
		findings: 1, blockers: blockers, status: campaignassurance.ExtractionUnavailable,
		sourceClass: target.SourceClass, extractionID: extraction.ID,
	}
	if target.SourceClass == campaignassurance.SourceModeled {
		persisted.modeledOutput = &campaigncomprehension.AnalyzerOutputV1{
			ConfigurationID: target.ConfigurationID, FailureCode: spec.errorCode,
		}
	}
	return persisted, nil
}

func unsupportedSourceSpec(source string) unavailableSpec {
	switch source {
	case campaignassurance.SourceModeled:
		return unavailableSpec{
			errorCode: "modeled_analyzer_unavailable", message: "this worker has no configured model executor and did not invoke a model",
			code: "MODELED_ANALYZER_UNAVAILABLE", severity: "warning", dimension: "modeled_comprehension",
			explanation: "The required modeled extraction was not executed; deterministic structure cannot substitute for predicted comprehension.",
			remediation: "configure_modeled_analyzer",
		}
	case campaignassurance.SourceControlledObservation:
		return unavailableSpec{
			errorCode: "controlled_observation_unavailable", message: "this worker has no controlled-client observation adapter and observed no inbox surface",
			code: "CONTROLLED_OBSERVATION_UNAVAILABLE", severity: "warning", dimension: "controlled_observation",
			explanation: "No named controlled client was observed; a predicted or deterministic result cannot be relabeled as observed.",
			remediation: "configure_controlled_observation",
		}
	default:
		return unavailableSpec{
			errorCode: "analyzer_source_unsupported", message: "the frozen analyzer source class is unsupported",
			code: "ANALYZER_SOURCE_UNAVAILABLE", severity: "critical", blocking: true, dimension: "execution",
			explanation: "The target source class cannot be executed and no success was inferred.", remediation: "rerun_with_supported_analyzer",
		}
	}
}

func artifactUnavailableSpec(err error) unavailableSpec {
	code := "artifact_integrity_failed"
	message := "the exact frozen artifact could not be safely verified"
	if errors.Is(err, ErrObjectTooLarge) {
		code, message = "artifact_object_too_large", "a frozen artifact object exceeds the worker byte limit"
	} else if errors.Is(err, ErrObjectMediaType) {
		code, message = "artifact_media_type_mismatch", "a frozen artifact object has an unexpected media type"
	} else if errors.Is(err, ErrSyntheticOnly) {
		code, message = "synthetic_fixture_required", "the assurance artifact is not a synthetic fixture"
	}
	return unavailableSpec{
		errorCode: code, message: message, code: "ARTIFACT_INTEGRITY_UNAVAILABLE",
		severity: "critical", blocking: true, dimension: "artifact_integrity",
		explanation: "Unverified artifact bytes were not supplied to an analyzer and cannot authorize a send.",
		remediation: "regenerate_frozen_artifact",
	}
}

func permanentArtifactError(err error) bool {
	return errors.Is(err, ErrArtifactIntegrity) || errors.Is(err, ErrManifestIntegrity) ||
		errors.Is(err, ErrObjectTooLarge) || errors.Is(err, ErrObjectMediaType) ||
		errors.Is(err, ErrSyntheticOnly) || errors.Is(err, uploads.ErrNotFound) ||
		errors.Is(err, uploads.ErrInvalidKey)
}

func validVersion(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 160 {
		return false
	}
	for _, current := range value {
		if unicode.IsControl(current) {
			return false
		}
	}
	return true
}

func mustJSON(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

func canonicalConfigurationHash(raw json.RawMessage) (string, error) {
	value, err := canonicalJSONObject(raw, 64<<10)
	if err != nil {
		return "", err
	}
	return digestBytes(value), nil
}

func ensureJSONObject(raw json.RawMessage) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if _, ok := value.(map[string]any); !ok {
		return errors.New("object required")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("trailing data")
	}
	return nil
}

// resolveCanonicalOffers performs the F15 bridge read for one run.
//
// Returns nil on every failure path rather than an error, and the distinction
// matters: a nil slice makes the checks report that nothing was assessed, while
// an empty-but-non-nil slice would say "resolved, and everything agrees". A
// bridge that could not be read must never be mistaken for a bridge that agreed,
// which is the same rule the summary-stability tri-state follows.
func (w *Worker) resolveCanonicalOffers(
	ctx context.Context, claimed *campaignassurance.ClaimedRun, loaded loadedArtifact,
) []campaignchecks.CanonicalOfferBinding {
	if w.OfferResolver == nil {
		return nil
	}
	document, _, err := effectiveDocument(loaded.revision, loaded.artifact)
	if err != nil {
		return nil
	}
	bindings, err := w.OfferResolver.ResolveCanonicalOffers(ctx, claimed.Run.TenantID, document)
	if err != nil {
		return nil
	}
	return bindings
}
