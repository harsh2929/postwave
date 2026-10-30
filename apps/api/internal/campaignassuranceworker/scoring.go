// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncomprehension"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

const maxReportedScenarioScores = 32

type modeledTargetResult struct {
	target       campaignassurance.RunTarget
	extractionID string
	output       campaigncomprehension.AnalyzerOutputV1
}

type modeledScenarioResults struct {
	artifact campaignassurance.RunArtifact
	targets  map[string]modeledTargetResult
}

type modeledExecutionResults struct {
	byArtifact map[string]*modeledScenarioResults
}

// newModeledExecutionResults tracks the comprehension ensemble only.
//
// prepared is consulted so the summary-stability configuration never becomes a
// required output of the pinned scorer: it produces no comprehension receipt,
// so counting it would make every scenario permanently incomplete for a reason
// that is not a fact about the campaign.
func newModeledExecutionResults(
	claimed *campaignassurance.ClaimedRun,
	prepared modeledPreparationSet,
) modeledExecutionResults {
	artifacts := make(map[string]campaignassurance.RunArtifact, len(claimed.Artifacts))
	for _, artifact := range claimed.Artifacts {
		artifacts[artifact.ArtifactID] = artifact
	}
	result := modeledExecutionResults{byArtifact: make(map[string]*modeledScenarioResults)}
	for _, target := range claimed.Targets {
		if target.SourceClass != campaignassurance.SourceModeled ||
			prepared.isSummaryStability(target.ConfigurationID) {
			continue
		}
		scenario := result.byArtifact[target.ArtifactID]
		if scenario == nil {
			scenario = &modeledScenarioResults{
				artifact: artifacts[target.ArtifactID], targets: make(map[string]modeledTargetResult),
			}
			result.byArtifact[target.ArtifactID] = scenario
		}
		scenario.targets[target.ConfigurationID] = modeledTargetResult{target: target}
	}
	return result
}

func (r modeledExecutionResults) record(target campaignassurance.RunTarget, persisted persistedTarget) error {
	scenario := r.byArtifact[target.ArtifactID]
	if scenario == nil || persisted.modeledOutput == nil ||
		persisted.modeledOutput.ConfigurationID != target.ConfigurationID {
		return ErrManifestIntegrity
	}
	current, ok := scenario.targets[target.ConfigurationID]
	if !ok || current.output.ConfigurationID != "" {
		return ErrManifestIntegrity
	}
	current.extractionID = persisted.extractionID
	current.output = *persisted.modeledOutput
	scenario.targets[target.ConfigurationID] = current
	return nil
}

type compactScenarioScore struct {
	ScenarioID        string                                  `json:"scenario_id"`
	ArtifactID        string                                  `json:"artifact_id"`
	OutboundMIMEHash  string                                  `json:"outbound_mime_hash"`
	Complete          bool                                    `json:"complete"`
	Overall           *float64                                `json:"overall"`
	Components        campaigncomprehension.ComponentScoresV1 `json:"components"`
	Range             *campaigncomprehension.ScoreRangeV1     `json:"range"`
	Agreement         *float64                                `json:"agreement"`
	Coverage          compactScoreCoverage                    `json:"coverage"`
	HasContradictions bool                                    `json:"has_contradictions"`
	FailureCodes      []string                                `json:"failure_codes"`
}

type compactScoreCoverage struct {
	Required         int     `json:"required"`
	Terminal         int     `json:"terminal"`
	Successful       int     `json:"successful"`
	Ratio            float64 `json:"ratio"`
	MissingCount     int     `json:"missing_count"`
	FailedCount      int     `json:"failed_count"`
	MissingIDsSHA256 string  `json:"missing_ids_sha256"`
	FailedIDsSHA256  string  `json:"failed_ids_sha256"`
}

type compactAggregateScore struct {
	ScoreVersion           string                              `json:"score_version"`
	Complete               bool                                `json:"complete"`
	Worst                  *float64                            `json:"worst"`
	Mean                   *float64                            `json:"mean"`
	Range                  *campaigncomprehension.ScoreRangeV1 `json:"range"`
	Coverage               compactScoreCoverage                `json:"coverage"`
	WorstScenarioCount     int                                 `json:"worst_scenario_count"`
	WorstScenarioIDsSHA256 string                              `json:"worst_scenario_ids_sha256"`
	HasContradictions      bool                                `json:"has_contradictions"`
	FailureCodes           []string                            `json:"failure_codes"`
}

type modeledScoreFinalization struct {
	status                 string
	aggregate              campaigncomprehension.ScenarioAggregateV1
	scenarioManifestSHA256 string
	reported               []compactScenarioScore
	scenarioCount          int
	overall                *float64
	minimum                *float64
	maximum                *float64
	agreement              *float64
}

func (w *Worker) scoreModeledScenarios(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	contract factcontract.ContractV1,
	results modeledExecutionResults,
) (*modeledScoreFinalization, int, int, error) {
	if len(results.byArtifact) == 0 {
		return nil, 0, 0, nil
	}
	artifactIDs := make([]string, 0, len(results.byArtifact))
	for artifactID := range results.byArtifact {
		artifactIDs = append(artifactIDs, artifactID)
	}
	sort.Slice(artifactIDs, func(i, j int) bool {
		left, right := results.byArtifact[artifactIDs[i]], results.byArtifact[artifactIDs[j]]
		if left.artifact.ScenarioID == right.artifact.ScenarioID {
			return artifactIDs[i] < artifactIDs[j]
		}
		return left.artifact.ScenarioID < right.artifact.ScenarioID
	})

	requiredScenarios := make([]string, 0, len(artifactIDs))
	reducedScores := make([]campaigncomprehension.ScenarioScoreV1, 0, len(artifactIDs))
	compactScores := make([]compactScenarioScore, 0, len(artifactIDs))
	findings, blockers := 0, 0
	for _, artifactID := range artifactIDs {
		scenario := results.byArtifact[artifactID]
		requiredIDs := make([]string, 0, len(scenario.targets))
		outputs := make([]campaigncomprehension.AnalyzerOutputV1, 0, len(scenario.targets))
		for configurationID := range scenario.targets {
			requiredIDs = append(requiredIDs, configurationID)
		}
		sort.Strings(requiredIDs)
		for _, configurationID := range requiredIDs {
			output := scenario.targets[configurationID].output
			if output.ConfigurationID == "" {
				output = campaigncomprehension.AnalyzerOutputV1{
					ConfigurationID: configurationID, FailureCode: "modeled_output_missing",
				}
			}
			outputs = append(outputs, output)
		}
		score := campaigncomprehension.ScoreV1(campaigncomprehension.ScenarioScoreInputV1{
			ScenarioID: scenario.artifact.ScenarioID, Contract: contract,
			RequiredOutputIDs: requiredIDs, Outputs: outputs,
		})
		added, blocked, err := w.persistModeledScoreFindings(ctx, claimed, contract, scenario, score)
		if err != nil {
			return nil, findings, blockers, err
		}
		findings += added
		blockers += blocked
		requiredScenarios = append(requiredScenarios, scenario.artifact.ScenarioID)
		reducedScores = append(reducedScores, campaigncomprehension.ScenarioScoreV1{
			ScoreVersion: score.ScoreVersion, ScenarioID: score.ScenarioID,
			Complete: score.Complete, Overall: score.Overall,
			HasContradictions: score.HasContradictions,
		})
		compactScores = append(compactScores, compactScenarioScore{
			ScenarioID: score.ScenarioID, ArtifactID: scenario.artifact.ArtifactID,
			OutboundMIMEHash: scenario.artifact.OutboundMIMEHash,
			Complete:         score.Complete, Overall: score.Overall, Components: score.Components,
			Range: score.Range, Agreement: score.Agreement, Coverage: compactCoverage(score.Coverage),
			HasContradictions: score.HasContradictions, FailureCodes: scoreFailureCodes(score.Failures),
		})
	}
	aggregate := campaigncomprehension.AggregateScenariosV1(requiredScenarios, reducedScores)
	finalization := &modeledScoreFinalization{
		status: "incomplete", aggregate: aggregate,
		scenarioManifestSHA256: digestBytes(mustJSON(compactScores)),
		reported:               weakestScenarioScores(compactScores, maxReportedScenarioScores),
		scenarioCount:          len(compactScores),
	}
	if aggregate.Complete {
		finalization.status = "complete"
		finalization.overall = aggregate.Worst
		if aggregate.Range != nil {
			minimum, maximum := aggregate.Range.Min, aggregate.Range.Max
			finalization.minimum, finalization.maximum = &minimum, &maximum
		}
		finalization.agreement = minimumScenarioAgreement(compactScores)
	}
	return finalization, findings, blockers, nil
}

func scoreFailureCodes(values []campaigncomprehension.ScoreFailureV1) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, duplicate := seen[value.Code]; duplicate {
			continue
		}
		seen[value.Code] = struct{}{}
		result = append(result, value.Code)
	}
	sort.Strings(result)
	return result
}

func compactCoverage(value campaigncomprehension.CoverageV1) compactScoreCoverage {
	return compactScoreCoverage{
		Required: value.Required, Terminal: value.Terminal, Successful: value.Successful,
		Ratio: value.Ratio, MissingCount: len(value.MissingIDs), FailedCount: len(value.FailedIDs),
		MissingIDsSHA256: digestBytes(mustJSON(value.MissingIDs)),
		FailedIDsSHA256:  digestBytes(mustJSON(value.FailedIDs)),
	}
}

func compactAggregate(value campaigncomprehension.ScenarioAggregateV1) compactAggregateScore {
	return compactAggregateScore{
		ScoreVersion: value.ScoreVersion, Complete: value.Complete, Worst: value.Worst,
		Mean: value.Mean, Range: value.Range, Coverage: compactCoverage(value.Coverage),
		WorstScenarioCount:     len(value.WorstScenarioIDs),
		WorstScenarioIDsSHA256: digestBytes(mustJSON(value.WorstScenarioIDs)),
		HasContradictions:      value.HasContradictions, FailureCodes: scoreFailureCodes(value.Failures),
	}
}

func weakestScenarioScores(values []compactScenarioScore, maximum int) []compactScenarioScore {
	result := append([]compactScenarioScore(nil), values...)
	sort.Slice(result, func(i, j int) bool {
		if result[i].Complete != result[j].Complete {
			return !result[i].Complete
		}
		left, right := 101.0, 101.0
		if result[i].Overall != nil {
			left = *result[i].Overall
		}
		if result[j].Overall != nil {
			right = *result[j].Overall
		}
		if left == right {
			return result[i].ScenarioID < result[j].ScenarioID
		}
		return left < right
	})
	if len(result) > maximum {
		result = result[:maximum]
	}
	return result
}

func minimumScenarioAgreement(values []compactScenarioScore) *float64 {
	var result *float64
	for _, value := range values {
		if value.Agreement == nil {
			return nil
		}
		if result == nil || *value.Agreement < *result {
			copy := *value.Agreement
			result = &copy
		}
	}
	return result
}

func (s executionSummary) finalizeInput(gate string) campaignassurance.FinalizeInput {
	components := map[string]any{
		"schema_version": 1,
		"deterministic": map[string]any{
			"finding_count":          s.deterministicFindings,
			"blocking_finding_count": s.deterministicBlockers,
			"score_status":           "not_computed",
		},
	}
	input := campaignassurance.FinalizeInput{GateDecision: gate}
	if s.modeledScores != nil {
		modeled := s.modeledScores
		components["predicted_agent_comprehension"] = map[string]any{
			"source_class":             campaignassurance.SourceModeled,
			"claim":                    "prediction_not_provider_observation",
			"score_version":            campaigncomprehension.ScoreVersionV1,
			"status":                   modeled.status,
			"scenario_count":           modeled.scenarioCount,
			"reported_scenario_count":  len(modeled.reported),
			"scenario_manifest_sha256": modeled.scenarioManifestSHA256,
			"reported_scenarios":       modeled.reported,
			"aggregate":                compactAggregate(modeled.aggregate),
			"finding_count":            s.modeledFindings,
			"blocking_finding_count":   s.modeledBlockers,
		}
		input.OverallScore = modeled.overall
		input.ScoreMin = modeled.minimum
		input.ScoreMax = modeled.maximum
		input.Agreement = modeled.agreement
	}
	input.ComponentScores = mustJSON(components)
	return input
}

func (w *Worker) persistModeledScoreFindings(
	ctx context.Context,
	claimed *campaignassurance.ClaimedRun,
	contract factcontract.ContractV1,
	scenario *modeledScenarioResults,
	score campaigncomprehension.ScenarioScoreV1,
) (int, int, error) {
	findings, blockers := 0, 0
	record := func(target modeledTargetResult, input campaignassurance.FindingInput) error {
		input.ArtifactID = target.target.ArtifactID
		input.ConfigurationID = target.target.ConfigurationID
		input.ExtractionID = target.extractionID
		input.SourceClass = campaignassurance.SourceModeled
		input.DetectorVersion = campaigncomprehension.ScoreVersionV1
		input.PolicyVersion = claimed.Run.GatePolicyVersion
		_, err := w.Assurance.RecordFinding(ctx, claimed.Run.TenantID, claimed.Run.ID,
			*claimed.Run.ClaimToken, claimed.Run.AttemptCount, input)
		if err != nil {
			return fmt.Errorf("%w: record modeled score finding: %w", ErrLifecycle, err)
		}
		findings++
		if input.Blocking {
			blockers++
		}
		return nil
	}

	for _, unsupported := range score.UnsupportedClaims {
		target, ok := scenario.targets[unsupported.ConfigurationID]
		if !ok || target.extractionID == "" {
			return findings, blockers, ErrManifestIntegrity
		}
		code, severity, blocking := "MODELED_UNSUPPORTED_CLAIM", "warning", false
		explanation := "The modeled analyzer surfaced a claim outside the sender-declared Fact Contract; human review is required and the numeric score does not erase it."
		if unsupported.Contradiction {
			code, severity, blocking = "MODELED_FORBIDDEN_CLAIM_CONTRADICTION", "critical", true
			explanation = "The modeled analyzer surfaced a sender-declared forbidden claim; this contradiction blocks the assurance gate independently of the numeric score."
		}
		if err := record(target, campaignassurance.FindingInput{
			Code: code, Severity: severity, Blocking: blocking, Overridable: false,
			Dimension:          "modeled_comprehension.contradiction",
			BlockReferences:    json.RawMessage(`[]`),
			EvidenceReferences: modeledEvidenceReferences(unsupported.EvidenceIDs),
			ExpectedValue:      mustJSON(map[string]any{"forbidden_claim_ids": unsupported.ForbiddenClaimIDs}),
			ObservedValue:      mustJSON(map[string]any{"statement": unsupported.Statement}),
			Explanation:        explanation,
			Remediation:        mustJSON(map[string]any{"kind": "review_or_remove_unsupported_claim"}),
		}); err != nil {
			return findings, blockers, err
		}
	}

	for _, outputScore := range score.OutputScores {
		target, ok := scenario.targets[outputScore.ConfigurationID]
		if !ok || target.output.Receipt == nil || target.extractionID == "" {
			return findings, blockers, ErrManifestIntegrity
		}
		extraction := target.output.Receipt.Extraction
		if outputScore.IntentFidelity < 100 {
			evidence := append([]string(nil), extraction.PrimaryIntent.EvidenceIDs...)
			evidence = append(evidence, extraction.CoreClaim.EvidenceIDs...)
			if err := record(target, campaignassurance.FindingInput{
				Code: "MODELED_INTENT_FIDELITY_GAP", Severity: "warning", Blocking: false, Overridable: false,
				Dimension:       "modeled_comprehension.intent_fidelity",
				BlockReferences: json.RawMessage(`[]`), EvidenceReferences: modeledEvidenceReferences(evidence),
				ExpectedValue: mustJSON(map[string]any{
					"intent_kind":      contract.PrimaryIntent.Kind,
					"intent_statement": contract.PrimaryIntent.Statement,
					"core_claim":       contract.CoreClaim.Statement,
				}),
				ObservedValue: mustJSON(map[string]any{
					"intent_kind":      extraction.PrimaryIntent.Kind,
					"intent_statement": extraction.PrimaryIntent.Value,
					"core_claim":       extraction.CoreClaim.Value,
					"component_score":  outputScore.IntentFidelity,
				}),
				Explanation: "The predicted extraction did not exactly preserve the sender-declared intent and core claim under the pinned comparison rules.",
				Remediation: mustJSON(map[string]any{"kind": "clarify_intent_and_core_claim"}),
			}); err != nil {
				return findings, blockers, err
			}
		}
		if outputScore.PrimaryAction < 100 {
			if err := record(target, campaignassurance.FindingInput{
				Code: "MODELED_PRIMARY_ACTION_FIDELITY_GAP", Severity: "warning", Blocking: false, Overridable: false,
				Dimension: "modeled_comprehension.primary_action_fidelity",
				BlockReferences: mustJSON([]map[string]string{{
					"block_id":  string(contract.PrimaryAction.BlockID),
					"action_id": string(contract.PrimaryAction.ActionID),
				}}),
				EvidenceReferences: modeledEvidenceReferences(extraction.PrimaryAction.EvidenceIDs),
				ExpectedValue:      mustJSON(contract.PrimaryAction),
				ObservedValue: mustJSON(map[string]any{
					"action": extraction.PrimaryAction, "component_score": outputScore.PrimaryAction,
				}),
				Explanation: "The predicted extraction did not exactly recover the sender-declared primary action; the numeric score remains advisory and the mismatch is explicit.",
				Remediation: mustJSON(map[string]any{"kind": "clarify_primary_action"}),
			}); err != nil {
				return findings, blockers, err
			}
		}
	}

	facts := make(map[factcontract.FactID]factcontract.RequiredFact, len(contract.RequiredFacts))
	for _, fact := range contract.RequiredFacts {
		facts[fact.ID] = fact
	}
	for _, factResult := range score.FactResults {
		if factResult.Match != campaigncomprehension.MatchWrong && factResult.Match != campaigncomprehension.MatchMissing {
			continue
		}
		target, ok := scenario.targets[factResult.ConfigurationID]
		if !ok || target.extractionID == "" {
			return findings, blockers, ErrManifestIntegrity
		}
		expected := facts[factResult.FactID]
		severity, blocking, code := "warning", false, "MODELED_FACT_RECOVERY_GAP"
		if factResult.Criticality == factcontract.CriticalityCritical {
			severity, blocking, code = "critical", true, "MODELED_CRITICAL_FACT_RECOVERY_GAP"
		}
		if err := record(target, campaignassurance.FindingInput{
			Code: code, Severity: severity, Blocking: blocking, Overridable: false,
			Dimension:          "modeled_comprehension.entity_recovery",
			BlockReferences:    modeledFactBlockReferences(expected),
			EvidenceReferences: modeledFactEvidenceReferences(target.output, factResult.FactID),
			ExpectedValue: mustJSON(map[string]any{
				"fact_id": factResult.FactID, "type": factResult.Type, "value": factResult.Expected,
			}),
			ObservedValue: mustJSON(map[string]any{
				"match": factResult.Match, "value": factResult.Observed,
			}),
			Explanation: "The predicted extraction did not recover a sender-declared fact under the pinned conservative comparison rules.",
			Remediation: mustJSON(map[string]any{"kind": "clarify_fact_in_live_text"}),
		}); err != nil {
			return findings, blockers, err
		}
	}

	undeclaredByConfiguration := make(map[string][]string)
	for _, undeclared := range score.UndeclaredFacts {
		undeclaredByConfiguration[undeclared.ConfigurationID] = append(
			undeclaredByConfiguration[undeclared.ConfigurationID], string(undeclared.Fact.FactID),
		)
	}
	for configurationID, factIDs := range undeclaredByConfiguration {
		target := scenario.targets[configurationID]
		sort.Strings(factIDs)
		if err := record(target, campaignassurance.FindingInput{
			Code: "MODELED_UNDECLARED_FACTS", Severity: "warning", Blocking: false, Overridable: false,
			Dimension:          "modeled_comprehension.entity_recovery",
			BlockReferences:    json.RawMessage(`[]`),
			EvidenceReferences: mustJSON([]map[string]any{{"representation": "modeled_output", "location": "/facts"}}),
			ExpectedValue:      mustJSON(map[string]any{"fact_ids": []string{}}),
			ObservedValue:      mustJSON(map[string]any{"fact_ids": factIDs}),
			Explanation:        "The modeled extraction emitted fact identifiers outside the sender-declared recovery vocabulary; these claims require review.",
			Remediation:        mustJSON(map[string]any{"kind": "review_undeclared_facts"}),
		}); err != nil {
			return findings, blockers, err
		}
	}

	for configurationID, target := range scenario.targets {
		if target.output.Receipt == nil || len(target.output.Receipt.Extraction.Ambiguities) == 0 {
			continue
		}
		fields := make([]string, 0, len(target.output.Receipt.Extraction.Ambiguities))
		var evidence []string
		for _, ambiguity := range target.output.Receipt.Extraction.Ambiguities {
			fields = append(fields, ambiguity.Field)
			evidence = append(evidence, ambiguity.EvidenceIDs...)
		}
		sort.Strings(fields)
		if err := record(target, campaignassurance.FindingInput{
			Code: "MODELED_AMBIGUITIES_PRESENT", Severity: "warning", Blocking: false, Overridable: false,
			Dimension:       "modeled_comprehension.ambiguity",
			BlockReferences: json.RawMessage(`[]`), EvidenceReferences: modeledEvidenceReferences(evidence),
			ExpectedValue: mustJSON(map[string]any{"ambiguity_count": 0}),
			ObservedValue: mustJSON(map[string]any{"ambiguity_count": len(fields), "fields": fields}),
			Explanation:   "The modeled extraction reported ambiguity in the frozen artifact; the ambiguity remains explicit and outside the numeric average.",
			Remediation:   mustJSON(map[string]any{"kind": "clarify_ambiguous_content", "configuration_id": configurationID}),
		}); err != nil {
			return findings, blockers, err
		}
	}

	allOutputsComplete := true
	for _, target := range scenario.targets {
		if target.output.Receipt == nil {
			allOutputsComplete = false
			break
		}
	}
	if allOutputsComplete && !score.Complete {
		configurationIDs := make([]string, 0, len(scenario.targets))
		for configurationID := range scenario.targets {
			configurationIDs = append(configurationIDs, configurationID)
		}
		sort.Strings(configurationIDs)
		target := scenario.targets[configurationIDs[0]]
		if err := record(target, campaignassurance.FindingInput{
			Code: "MODELED_SCORE_INCOMPLETE", Severity: "critical", Blocking: true, Overridable: false,
			Dimension:          "modeled_comprehension.scoring",
			BlockReferences:    json.RawMessage(`[]`),
			EvidenceReferences: mustJSON([]map[string]any{{"representation": "modeled_output", "location": "/"}}),
			ExpectedValue:      mustJSON(map[string]any{"score_status": "complete"}),
			ObservedValue:      mustJSON(map[string]any{"score_status": "incomplete", "failure_codes": scoreFailureCodes(score.Failures)}),
			Explanation:        "Every modeled extraction was present but the pinned scorer could not produce a complete result; no fallback score was fabricated.",
			Remediation:        mustJSON(map[string]any{"kind": "review_scoring_contract"}),
		}); err != nil {
			return findings, blockers, err
		}
	}
	return findings, blockers, nil
}

func modeledEvidenceReferences(ids []string) json.RawMessage {
	seen := make(map[string]struct{}, len(ids))
	values := make([]string, 0, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		values = append(values, id)
	}
	sort.Strings(values)
	if len(values) > 32 {
		values = values[:32]
	}
	result := make([]map[string]any, 0, len(values))
	for _, id := range values {
		result = append(result, map[string]any{
			"representation": "modeled_input", "location": "/evidence/" + id,
		})
	}
	if len(result) == 0 {
		result = append(result, map[string]any{"representation": "modeled_input", "location": "/"})
	}
	return mustJSON(result)
}

func modeledFactEvidenceReferences(output campaigncomprehension.AnalyzerOutputV1, factID factcontract.FactID) json.RawMessage {
	if output.Receipt != nil {
		for _, fact := range output.Receipt.Extraction.Facts {
			if fact.FactID == factID {
				return modeledEvidenceReferences(fact.EvidenceIDs)
			}
		}
	}
	return modeledEvidenceReferences(nil)
}

func modeledFactBlockReferences(fact factcontract.RequiredFact) json.RawMessage {
	result := make([]map[string]string, 0, len(fact.SourceBlockIDs))
	for _, blockID := range fact.SourceBlockIDs {
		result = append(result, map[string]string{"block_id": string(blockID), "fact_id": string(fact.ID)})
	}
	return mustJSON(result)
}
