// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/campaigntransform"
	"github.com/postwave/postwave/apps/api/internal/mimecomposer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

var errArtifactObjectIntegrity = errors.New("campaign send runtime: artifact object integrity mismatch")

type frozenEvidenceError struct {
	reason string
	err    error
}

func (e *frozenEvidenceError) Error() string { return e.err.Error() }
func (e *frozenEvidenceError) Unwrap() error { return e.err }

func evidenceFailure(reason string, err error) error {
	return &frozenEvidenceError{reason: reason, err: err}
}

func frozenEvidenceReason(err error) string {
	var failure *frozenEvidenceError
	if errors.As(err, &failure) && failure.reason != "" {
		return failure.reason
	}
	return ReasonRunMismatch
}

func verifyFrozenEvidence(
	input sending.BoundDispatchInput,
	revision campaignartifact.Revision,
	plan campaignartifact.Plan,
	runManifest *campaignassurance.ClaimedRun,
	coverage campaigncoverage.Manifest,
	artifacts []campaignartifact.Artifact,
) error {
	binding := input.Binding
	if revision.TenantID != input.TenantID || revision.CampaignID != input.CampaignID ||
		revision.ID != binding.ContentRevisionID || revision.SourceHash != binding.SourceHash {
		return evidenceFailure(ReasonSourceMismatch, errors.New("revision identity differs from recipient binding"))
	}
	if err := verifyRevisionSourceHash(revision); err != nil {
		return evidenceFailure(ReasonSourceMismatch, err)
	}
	if plan.TenantID != input.TenantID || plan.CampaignID != input.CampaignID ||
		plan.ID != binding.SendPlanID || plan.ContentRevisionID != revision.ID ||
		plan.PlanHash == nil || *plan.PlanHash != binding.PlanHash ||
		(plan.State != campaignartifact.PlanReady && plan.State != campaignartifact.PlanCertified) ||
		plan.CompilerVersion != campaigncompiler.Version ||
		plan.RendererVersion != semanticemail.HTMLRendererVersion ||
		plan.FixtureSetVersion != campaigncoverage.FixtureSetVersionV1 {
		return evidenceFailure(ReasonPlanMismatch, errors.New("plan identity, state, or implementation differs from recipient binding"))
	}
	if coverage.SourceHash != revision.SourceHash || coverage.FixtureSetVersion != plan.FixtureSetVersion {
		return evidenceFailure(ReasonCoverageMismatch, errors.New("coverage manifest differs from plan source"))
	}
	if err := verifyPlanHashes(plan, artifacts); err != nil {
		return evidenceFailure(ReasonPlanMismatch, err)
	}
	if err := verifyFrozenRun(input, revision, plan, runManifest); err != nil {
		return err
	}
	if err := verifyFrozenGateDecision(binding, runManifest.Run); err != nil {
		return err
	}
	if len(artifacts) != len(coverage.Scenarios) || len(runManifest.Artifacts) != len(artifacts) {
		return evidenceFailure(ReasonArtifactMismatch, errors.New("plan, coverage, and assurance artifact counts differ"))
	}
	if err := verifyRunCells(runManifest, coverage, artifacts); err != nil {
		return evidenceFailure(ReasonArtifactMismatch, err)
	}
	return nil
}

// verifyFrozenRun binds the assurance run manifest to the recipient binding,
// the frozen revision and plan, and proves terminal completeness plus the
// frozen coverage hash.
func verifyFrozenRun(
	input sending.BoundDispatchInput,
	revision campaignartifact.Revision,
	plan campaignartifact.Plan,
	runManifest *campaignassurance.ClaimedRun,
) error {
	binding := input.Binding
	if runManifest == nil {
		return evidenceFailure(ReasonRunMismatch, errors.New("assurance run manifest is nil"))
	}
	run := runManifest.Run
	if run.TenantID != input.TenantID || run.CampaignID != input.CampaignID ||
		run.ID != binding.RunID || run.ContentRevisionID != revision.ID ||
		run.SendPlanID != plan.ID || run.State != campaignassurance.StateComplete ||
		run.SourceHash != binding.SourceHash || run.PlanHash != binding.PlanHash ||
		run.ArtifactSetHash != binding.ArtifactSetHash || run.AttemptCount != binding.RunAttempt ||
		run.CompilerVersion != plan.CompilerVersion || run.RendererVersion != plan.RendererVersion ||
		run.FixtureSetVersion != plan.FixtureSetVersion || run.PlanPolicyVersion != plan.PolicyVersion ||
		run.Profile == campaignassurance.ProfileCalibration || run.RequiredExtractionCount < 1 ||
		run.TerminalExtractionCount != run.RequiredExtractionCount ||
		run.SuccessfulExtractionCount != run.RequiredExtractionCount || run.ExtractionErrorCount != 0 ||
		len(runManifest.Artifacts) != run.RequiredScenarioCount ||
		len(runManifest.Configurations) != run.RequiredConfigurationCount ||
		len(runManifest.Targets) != run.RequiredExtractionCount {
		return evidenceFailure(ReasonRunMismatch, errors.New("assurance run identity or terminal completeness differs from recipient binding"))
	}
	for _, hash := range []string{
		run.ArtifactSetHash, run.CoverageManifestHash,
		run.ConfigurationManifestHash, run.TargetManifestHash,
	} {
		if !validSHA256(hash) {
			return evidenceFailure(ReasonRunMismatch, errors.New("assurance run contains an invalid manifest hash"))
		}
	}
	coverageJSON, err := canonicalJSON(plan.CoverageManifest, "object")
	if err != nil || digestBytes(coverageJSON) != run.CoverageManifestHash {
		return evidenceFailure(ReasonCoverageMismatch, errors.New("assurance coverage hash differs from frozen plan"))
	}
	return nil
}

// verifyFrozenGateDecision proves the recipient's bound gate decision is the
// one the assurance run actually produced.
func verifyFrozenGateDecision(binding sending.AssuranceBinding, run campaignassurance.Run) error {
	switch binding.GateDecision {
	case "pass", "warn":
		if run.GateDecision != binding.GateDecision || len(binding.OverrideIDs) != 0 {
			return evidenceFailure(ReasonGateMismatch, errors.New("non-overridden gate differs from assurance run"))
		}
	case "overridden":
		if run.GateDecision != campaignassurance.GateBlock || len(binding.OverrideIDs) == 0 {
			return evidenceFailure(ReasonGateMismatch, errors.New("overridden gate is not backed by a blocked run and exact override set"))
		}
	default:
		return evidenceFailure(ReasonGateMismatch, errors.New("recipient gate is not sendable"))
	}
	return nil
}

func verifyRunCells(runManifest *campaignassurance.ClaimedRun, coverage campaigncoverage.Manifest, artifacts []campaignartifact.Artifact) error {
	scenarioByID := make(map[string]campaigncoverage.Scenario, len(coverage.Scenarios))
	for _, scenario := range coverage.Scenarios {
		scenarioByID[scenario.ID] = scenario
	}
	artifactByID := make(map[string]campaignartifact.Artifact, len(artifacts))
	artifactByScenario := make(map[string]campaignartifact.Artifact, len(artifacts))
	for _, artifact := range artifacts {
		if _, duplicate := artifactByID[artifact.ID]; duplicate {
			return errors.New("duplicate plan artifact id")
		}
		if _, duplicate := artifactByScenario[artifact.ScenarioID]; duplicate {
			return errors.New("duplicate plan scenario id")
		}
		scenario, ok := scenarioByID[artifact.ScenarioID]
		if !ok || !artifactMatchesScenario(artifact, coverage, scenario) {
			return errors.New("artifact coordinates or compiler receipt differ from coverage")
		}
		artifactByID[artifact.ID], artifactByScenario[artifact.ScenarioID] = artifact, artifact
	}
	runArtifacts := make(map[string]campaignassurance.RunArtifact, len(runManifest.Artifacts))
	for index, snapshot := range runManifest.Artifacts {
		artifact, ok := artifactByID[snapshot.ArtifactID]
		_, duplicate := runArtifacts[snapshot.ArtifactID]
		if !ok || duplicate || snapshot.Ordinal != index+1 || snapshot.TenantID != runManifest.Run.TenantID ||
			snapshot.CampaignID != runManifest.Run.CampaignID || snapshot.RunID != runManifest.Run.ID ||
			snapshot.SendPlanID != runManifest.Run.SendPlanID || snapshot.ScenarioID != artifact.ScenarioID ||
			snapshot.OutboundMIMEHash != artifact.OutboundMIMEHash || snapshot.MIMEStructureHash != artifact.MIMEStructureHash {
			return errors.New("assurance artifact snapshot differs from plan artifact")
		}
		runArtifacts[snapshot.ArtifactID] = snapshot
	}
	if len(runArtifacts) != len(artifactByID) {
		return errors.New("assurance artifact snapshot does not cover the frozen plan")
	}
	configurations := make(map[string]campaignassurance.RunConfiguration, len(runManifest.Configurations))
	hasDeterministic := false
	for index, configuration := range runManifest.Configurations {
		canonicalConfiguration, err := canonicalJSON(configuration.Configuration, "object")
		if err != nil || digestBytes(canonicalConfiguration) != configuration.ConfigurationHash ||
			configuration.Ordinal != index+1 || configuration.TenantID != runManifest.Run.TenantID ||
			configuration.CampaignID != runManifest.Run.CampaignID || configuration.RunID != runManifest.Run.ID {
			return errors.New("assurance configuration manifest is non-contiguous")
		}
		switch configuration.SourceClass {
		case campaignassurance.SourceDeterministic:
			hasDeterministic = true
		case campaignassurance.SourceModeled, campaignassurance.SourceControlledObservation:
		default:
			return errors.New("assurance configuration source class is invalid")
		}
		if _, duplicate := configurations[configuration.ID]; duplicate {
			return errors.New("duplicate assurance configuration")
		}
		configurations[configuration.ID] = configuration
	}
	if !hasDeterministic {
		return errors.New("assurance run omitted deterministic analysis")
	}
	seenTargets := make(map[string]struct{}, len(runManifest.Targets))
	targetedArtifacts := make(map[string]struct{}, len(runArtifacts))
	targetedConfigurations := make(map[string]struct{}, len(configurations))
	for index, target := range runManifest.Targets {
		artifact, artifactOK := runArtifacts[target.ArtifactID]
		configuration, configurationOK := configurations[target.ConfigurationID]
		key := target.ArtifactID + "\x00" + target.ConfigurationID
		_, duplicate := seenTargets[key]
		if !artifactOK || !configurationOK || duplicate || target.Ordinal != index+1 ||
			target.TenantID != runManifest.Run.TenantID || target.CampaignID != runManifest.Run.CampaignID ||
			target.RunID != runManifest.Run.ID || target.SendPlanID != runManifest.Run.SendPlanID ||
			target.SourceClass != configuration.SourceClass || target.ConfigurationHash != configuration.ConfigurationHash ||
			target.OutboundMIMEHash != artifact.OutboundMIMEHash {
			return errors.New("assurance target manifest differs from artifact/configuration snapshot")
		}
		seenTargets[key] = struct{}{}
		targetedArtifacts[target.ArtifactID] = struct{}{}
		targetedConfigurations[target.ConfigurationID] = struct{}{}
	}
	if len(targetedArtifacts) != len(runArtifacts) || len(targetedConfigurations) != len(configurations) {
		return errors.New("assurance target manifest does not cover every artifact and configuration")
	}
	return nil
}

func artifactMatchesScenario(artifact campaignartifact.Artifact, coverage campaigncoverage.Manifest, scenario campaigncoverage.Scenario) bool {
	expectedVariant := scenario.VariantID
	if len(coverage.Variants) == 1 && coverage.Variants[0].ID == "control" {
		expectedVariant = ""
	}
	if artifact.ScenarioID != scenario.ID || artifact.VariantID != expectedVariant ||
		artifact.Locale != scenario.Locale || artifact.BranchKey != scenario.BranchKey ||
		artifact.FixtureID != scenario.FixtureID || artifact.SourceHash != coverage.SourceHash ||
		!validSHA256(artifact.HTMLHash) || !validSHA256(artifact.TextHash) ||
		!validSHA256(artifact.MIMEStructureHash) || !validSHA256(artifact.OutboundMIMEHash) {
		return false
	}
	var receipt campaigncompiler.Receipt
	if strictDecode(artifact.CompilerReceipt, &receipt) != nil {
		return false
	}
	var representation campaigncompiler.RepresentationManifest
	if strictDecode(artifact.RepresentationManifest, &representation) != nil {
		return false
	}
	variantHash := ""
	for _, variant := range coverage.Variants {
		if variant.ID == scenario.VariantID {
			variantHash = variant.DocumentHash
		}
	}
	nodes := make([]string, len(receipt.IncludedNodeIDs))
	for index, node := range receipt.IncludedNodeIDs {
		nodes[index] = string(node)
	}
	return receipt.CompilerVersion == campaigncompiler.Version && receipt.SourceHash == artifact.SourceHash &&
		receipt.SourceMode == campaignartifact.SourceModeSemantic && receipt.ContentSchema == semanticemail.SchemaVersionV2 &&
		receipt.SemanticCompiler == semanticemail.CompilerVersion && receipt.HTMLRenderer == semanticemail.HTMLRendererVersion &&
		receipt.TextRenderer == semanticemail.TextRendererVersion && receipt.MIMEFormat == mimecomposer.FormatVersion &&
		receipt.Transform.Version == campaigntransform.Version && receipt.SemanticDocumentSHA256 == variantHash &&
		slices.Equal(nodes, scenario.IncludedNodeIDs) &&
		representation.SourceMode == campaignartifact.SourceModeSemantic && representation.Locale == scenario.Locale &&
		representation.SemanticDocumentSHA256 == variantHash && representation.HTMLSHA256 == artifact.HTMLHash &&
		representation.TextSHA256 == artifact.TextHash && representation.MIMEStructureSHA256 == artifact.MIMEStructureHash &&
		representation.OutboundMIMESHA256 == artifact.OutboundMIMEHash
}

func selectedArtifact(artifacts []campaignartifact.Artifact, scenarioID string) (campaignartifact.Artifact, error) {
	var selected campaignartifact.Artifact
	count := 0
	for _, artifact := range artifacts {
		if artifact.ScenarioID == scenarioID {
			selected, count = artifact, count+1
		}
	}
	if count != 1 {
		return campaignartifact.Artifact{}, errors.New("selected scenario does not have exactly one artifact")
	}
	return selected, nil
}

func verifySelectedObject(ctx context.Context, reader ObjectReader, tenantID string, artifact campaignartifact.Artifact) error {
	if reader == nil {
		return fmt.Errorf("%w: object reader is required", errArtifactObjectIntegrity)
	}
	rest, err := campaignmaterializer.ParseObjectReference(artifact.MIMEObjectRef)
	if err != nil {
		return fmt.Errorf("%w: %v", errArtifactObjectIntegrity, err)
	}
	body, contentType, err := reader.Get(ctx, tenantID, rest)
	if err != nil {
		return err
	}
	defer func() { _ = body.Close() }()
	if !strings.EqualFold(strings.TrimSpace(contentType), "message/rfc822") {
		return fmt.Errorf("%w: content type differs", errArtifactObjectIntegrity)
	}
	raw, err := io.ReadAll(io.LimitReader(body, mimecomposer.MaxRawMessageBytes+1))
	if err != nil {
		return err
	}
	if len(raw) == 0 || len(raw) > mimecomposer.MaxRawMessageBytes || digestBytes(raw) != artifact.OutboundMIMEHash {
		return fmt.Errorf("%w: bytes differ from receipt", errArtifactObjectIntegrity)
	}
	return nil
}

func sortedUniqueOverrideIDs(input []string) bool {
	copyIDs := append([]string(nil), input...)
	sort.Strings(copyIDs)
	return slices.Equal(copyIDs, input) && len(copyIDs) == len(slices.Compact(copyIDs))
}

func canonicalReceiptEqual(raw json.RawMessage, typed any) bool {
	left, err := canonicalJSON(raw, "object")
	if err != nil {
		return false
	}
	rightRaw, err := json.Marshal(typed)
	if err != nil {
		return false
	}
	right, err := canonicalJSON(rightRaw, "object")
	return err == nil && bytes.Equal(left, right)
}
