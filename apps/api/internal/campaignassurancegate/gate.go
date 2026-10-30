// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancegate

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

const maxRunScan = 200

func canonicalUUID(raw string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", ErrInvalidInput
	}
	return parsed.String(), nil
}

func validHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, current := range value {
		if (current < '0' || current > '9') && (current < 'a' || current > 'f') {
			return false
		}
	}
	return true
}

func normalizeRequest(input Request) (Request, error) {
	var err error
	if input.TenantID, err = canonicalUUID(input.TenantID); err != nil {
		return Request{}, fmt.Errorf("%w: tenant_id", ErrInvalidInput)
	}
	if input.CampaignID, err = canonicalUUID(input.CampaignID); err != nil {
		return Request{}, fmt.Errorf("%w: campaign_id", ErrInvalidInput)
	}
	if input.ContentRevisionID, err = canonicalUUID(input.ContentRevisionID); err != nil {
		return Request{}, fmt.Errorf("%w: content_revision_id", ErrInvalidInput)
	}
	input.SourceHash = strings.TrimSpace(input.SourceHash)
	if !validHash(input.SourceHash) {
		return Request{}, fmt.Errorf("%w: source_hash", ErrInvalidInput)
	}
	return input, nil
}

func (g *Gate) now() time.Time {
	if g != nil && g.Now != nil {
		return g.Now().UTC()
	}
	return time.Now().UTC()
}

// Evaluate returns the newest cached run bound to the exact current revision
// and source hash. It never falls back to a run for an older draft and never
// invokes an analyzer. Evidence denials return both a client-safe Evaluation
// and the stable sentinel error used by strict queue enforcement.
func (g *Gate) Evaluate(ctx context.Context, raw Request) (Evaluation, error) {
	base := Evaluation{
		PolicyVersion: PolicyVersion,
		TenantID:      strings.TrimSpace(raw.TenantID), CampaignID: strings.TrimSpace(raw.CampaignID),
		ContentRevisionID: strings.TrimSpace(raw.ContentRevisionID), SourceHash: strings.TrimSpace(raw.SourceHash),
		Status: StatusError, ReasonCode: ReasonIntegrityMismatch,
		SourceCoverage: SourceCoverage{}, RefreshedAt: g.now(),
	}
	if g == nil || g.Store == nil {
		base.Status, base.ReasonCode = StatusUnavailable, ReasonEvidenceUnavailable
		return base, ErrUnavailable
	}
	request, err := normalizeRequest(raw)
	if err != nil {
		return base, err
	}
	base.TenantID, base.CampaignID = request.TenantID, request.CampaignID
	base.ContentRevisionID, base.SourceHash = request.ContentRevisionID, request.SourceHash
	runs, err := g.Store.ListRuns(ctx, request.TenantID, request.CampaignID, maxRunScan)
	if err != nil {
		base.Status, base.ReasonCode = StatusError, ReasonDependencyError
		return base, err
	}
	// Do not trust an interface implementation's ordering.
	sort.SliceStable(runs, func(left, right int) bool {
		if runs[left].RunNo != runs[right].RunNo {
			return runs[left].RunNo > runs[right].RunNo
		}
		if !runs[left].CreatedAt.Equal(runs[right].CreatedAt) {
			return runs[left].CreatedAt.After(runs[right].CreatedAt)
		}
		return runs[left].ID > runs[right].ID
	})
	var run *campaignassurance.Run
	for index := range runs {
		candidate := &runs[index]
		if candidate.CampaignID == request.CampaignID &&
			candidate.ContentRevisionID == request.ContentRevisionID &&
			candidate.SourceHash == request.SourceHash {
			run = candidate
			break
		}
	}
	if run == nil {
		base.Status, base.ReasonCode = StatusUnavailable, ReasonNotAssured
		return base, ErrNotAssured
	}
	base.RunID, base.SendPlanID = run.ID, run.SendPlanID
	base.PlanHash, base.ArtifactSetHash = run.PlanHash, run.ArtifactSetHash
	base.CoverageManifestHash = run.CoverageManifestHash
	base.RunAttempt, base.GateDecision = run.AttemptCount, run.GateDecision
	base.DeterministicBlockers = run.BlockingFindingCount
	base.PredictedScore = cloneFloat(run.OverallScore)
	base.PredictedScoreMin = cloneFloat(run.ScoreMin)
	base.PredictedScoreMax = cloneFloat(run.ScoreMax)
	base.RefreshedAt = runRefreshTime(*run, g.now())
	switch run.State {
	case campaignassurance.StateQueued, campaignassurance.StateRunning:
		base.Status, base.ReasonCode = StatusPending, ReasonRunPending
		return base, ErrPending
	case campaignassurance.StateStale:
		base.Status, base.ReasonCode = StatusStale, ReasonRunStale
		return base, ErrStale
	case campaignassurance.StateComplete:
		// Continue below.
	case campaignassurance.StateIncomplete, campaignassurance.StateFailed,
		campaignassurance.StateCancelled:
		base.Status, base.ReasonCode = StatusUnavailable, ReasonEvidenceUnavailable
		return base, ErrUnavailable
	default:
		base.Status, base.ReasonCode = StatusError, ReasonIntegrityMismatch
		return base, ErrIntegrityMismatch
	}
	if run.Profile == campaignassurance.ProfileCalibration || run.RequiredExtractionCount < 1 ||
		run.TerminalExtractionCount != run.RequiredExtractionCount ||
		run.SuccessfulExtractionCount != run.RequiredExtractionCount ||
		run.ExtractionErrorCount != 0 || run.AttemptCount < 1 ||
		!validHash(run.PlanHash) || !validHash(run.ArtifactSetHash) ||
		!validHash(run.CoverageManifestHash) || !validHash(run.ConfigurationManifestHash) ||
		!validHash(run.TargetManifestHash) {
		base.Status, base.ReasonCode = StatusUnavailable, ReasonEvidenceUnavailable
		return base, ErrUnavailable
	}
	manifest, err := g.Store.GetRunManifest(ctx, request.TenantID, run.ID)
	if err != nil {
		base.Status, base.ReasonCode = StatusError, ReasonDependencyError
		return base, err
	}
	if err := verifyManifest(*run, manifest); err != nil {
		base.Status, base.ReasonCode = StatusError, ReasonIntegrityMismatch
		return base, err
	}
	base.SourceCoverage = sourceCoverage(*run, manifest.Configurations)
	receipt := Receipt{
		PolicyVersion: PolicyVersion, TenantID: request.TenantID,
		CampaignID: request.CampaignID, RunID: run.ID,
		ContentRevisionID: run.ContentRevisionID, SendPlanID: run.SendPlanID,
		SourceHash: run.SourceHash, PlanHash: run.PlanHash,
		ArtifactSetHash: run.ArtifactSetHash, RunAttempt: run.AttemptCount,
		AuthorizedAt: g.now(),
	}
	switch run.GateDecision {
	case campaignassurance.GatePass:
		if run.BlockingFindingCount != 0 {
			base.Status, base.ReasonCode = StatusError, ReasonIntegrityMismatch
			return base, ErrIntegrityMismatch
		}
		receipt.Decision = campaignassurance.GatePass
		base.Status, base.ReasonCode, base.Authorized = StatusOK, ReasonAuthorized, true
		base.receipt = &receipt
		return base, nil
	case campaignassurance.GateWarn:
		if run.BlockingFindingCount != 0 {
			base.Status, base.ReasonCode = StatusError, ReasonIntegrityMismatch
			return base, ErrIntegrityMismatch
		}
		receipt.Decision = campaignassurance.GateWarn
		base.Status, base.ReasonCode, base.Authorized = StatusWarn, ReasonAuthorizedWarn, true
		base.receipt = &receipt
		return base, nil
	case campaignassurance.GateBlock:
		overrides, err := g.authorizeOverrides(ctx, request.TenantID, *run)
		if err != nil {
			base.Status, base.ReasonCode = StatusCritical, ReasonDeterministicBlock
			if errors.Is(err, ErrIntegrityMismatch) {
				base.Status, base.ReasonCode = StatusError, ReasonIntegrityMismatch
			} else if !errors.Is(err, ErrBlocked) {
				base.Status, base.ReasonCode = StatusError, ReasonDependencyError
			}
			return base, err
		}
		receipt.Decision = "overridden"
		receipt.OverrideIDs = overrides
		base.Status, base.ReasonCode, base.Authorized = StatusCritical, ReasonAuthorizedOverride, true
		base.GateDecision = receipt.Decision
		base.OverrideIDs = append([]string(nil), overrides...)
		base.receipt = &receipt
		return base, nil
	default:
		base.Status, base.ReasonCode = StatusUnavailable, ReasonEvidenceUnavailable
		return base, ErrUnavailable
	}
}

// Authorize is the strict queue contract backed by Evaluate. Keeping receipt
// construction inside the same method path prevents the pre-send status and
// queue authority from drifting into separate implementations.
func (g *Gate) Authorize(ctx context.Context, raw Request) (Receipt, error) {
	evaluation, err := g.Evaluate(ctx, raw)
	if err != nil {
		return Receipt{}, err
	}
	if !evaluation.Authorized || evaluation.receipt == nil {
		return Receipt{}, ErrUnavailable
	}
	receipt := *evaluation.receipt
	receipt.OverrideIDs = append([]string(nil), receipt.OverrideIDs...)
	return receipt, nil
}

// ReauthorizeBound always applies strict current evidence semantics. It is
// intentionally independent of rollout mode so a queued receipt cannot become
// less governed if an operator later moves the rollout back to warn/shadow.
func (g *Gate) ReauthorizeBound(ctx context.Context, raw Request) (Receipt, error) {
	return g.Authorize(ctx, raw)
}

func cloneFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func runRefreshTime(run campaignassurance.Run, fallback time.Time) time.Time {
	for _, candidate := range []*time.Time{run.CompletedAt, run.StaleAt, run.StartedAt} {
		if candidate != nil && !candidate.IsZero() {
			return candidate.UTC()
		}
	}
	if !run.UpdatedAt.IsZero() {
		return run.UpdatedAt.UTC()
	}
	if !run.CreatedAt.IsZero() {
		return run.CreatedAt.UTC()
	}
	return fallback.UTC()
}

func sourceCoverage(run campaignassurance.Run, configurations []campaignassurance.RunConfiguration) SourceCoverage {
	coverage := SourceCoverage{
		Required: run.RequiredExtractionCount, Successful: run.SuccessfulExtractionCount,
	}
	if coverage.Required > 0 {
		coverage.Ratio = float64(coverage.Successful) / float64(coverage.Required)
	}
	for _, configuration := range configurations {
		switch configuration.SourceClass {
		case campaignassurance.SourceDeterministic:
			coverage.DeterministicConfigs++
		case campaignassurance.SourceModeled:
			coverage.ModeledConfigs++
		case campaignassurance.SourceControlledObservation:
			coverage.ControlledObservationConfigs++
		}
	}
	return coverage
}

func verifyManifest(run campaignassurance.Run, manifest *campaignassurance.ClaimedRun) error {
	if manifest == nil || manifest.Run.ID != run.ID || manifest.Run.TenantID != run.TenantID ||
		manifest.Run.CampaignID != run.CampaignID ||
		manifest.Run.ContentRevisionID != run.ContentRevisionID || manifest.Run.SendPlanID != run.SendPlanID ||
		manifest.Run.SourceHash != run.SourceHash || manifest.Run.PlanHash != run.PlanHash ||
		manifest.Run.ArtifactSetHash != run.ArtifactSetHash ||
		manifest.Run.CoverageManifestHash != run.CoverageManifestHash ||
		manifest.Run.ConfigurationManifestHash != run.ConfigurationManifestHash ||
		manifest.Run.TargetManifestHash != run.TargetManifestHash ||
		manifest.Run.AttemptCount != run.AttemptCount || manifest.Run.State != run.State ||
		len(manifest.Targets) != run.RequiredExtractionCount || len(manifest.Artifacts) != run.RequiredScenarioCount ||
		len(manifest.Configurations) != run.RequiredConfigurationCount {
		return ErrIntegrityMismatch
	}
	artifacts, err := verifyManifestArtifacts(run, manifest.Artifacts)
	if err != nil {
		return err
	}
	configurations, hasDeterministic, err := verifyManifestConfigurations(run, manifest.Configurations)
	if err != nil {
		return err
	}
	if !hasDeterministic {
		return ErrUnavailable
	}
	seen := make(map[string]struct{}, len(manifest.Targets))
	targetedArtifacts := make(map[string]struct{}, len(artifacts))
	targetedConfigurations := make(map[string]struct{}, len(configurations))
	for index, target := range manifest.Targets {
		artifact, artifactOK := artifacts[target.ArtifactID]
		configuration, configurationOK := configurations[target.ConfigurationID]
		key := target.ArtifactID + "\x00" + target.ConfigurationID
		_, duplicate := seen[key]
		if !artifactOK || !configurationOK || duplicate ||
			target.TenantID != run.TenantID || target.CampaignID != run.CampaignID ||
			target.RunID != run.ID || target.Ordinal != index+1 ||
			target.SendPlanID != run.SendPlanID || target.SourceClass != configuration.SourceClass ||
			target.ConfigurationHash != configuration.ConfigurationHash ||
			target.OutboundMIMEHash != artifact.OutboundMIMEHash {
			return ErrIntegrityMismatch
		}
		seen[key] = struct{}{}
		targetedArtifacts[target.ArtifactID] = struct{}{}
		targetedConfigurations[target.ConfigurationID] = struct{}{}
	}
	if len(targetedArtifacts) != len(artifacts) || len(targetedConfigurations) != len(configurations) {
		return ErrIntegrityMismatch
	}
	return nil
}

// verifyManifestArtifacts binds every manifest artifact to the run identity,
// in ordinal order and without duplicates, and indexes them by artifact id.
func verifyManifestArtifacts(run campaignassurance.Run, list []campaignassurance.RunArtifact) (map[string]campaignassurance.RunArtifact, error) {
	artifacts := make(map[string]campaignassurance.RunArtifact, len(list))
	for index, artifact := range list {
		if artifact.TenantID != run.TenantID || artifact.CampaignID != run.CampaignID ||
			artifact.RunID != run.ID || artifact.SendPlanID != run.SendPlanID ||
			artifact.Ordinal != index+1 || !canonicalUUIDValue(artifact.ArtifactID) ||
			!validHash(artifact.OutboundMIMEHash) || !validHash(artifact.MIMEStructureHash) {
			return nil, ErrIntegrityMismatch
		}
		if _, duplicate := artifacts[artifact.ArtifactID]; duplicate {
			return nil, ErrIntegrityMismatch
		}
		artifacts[artifact.ArtifactID] = artifact
	}
	return artifacts, nil
}

// verifyManifestConfigurations binds every manifest configuration to the run
// identity, indexes them by id, and reports whether a deterministic source is
// present.
func verifyManifestConfigurations(run campaignassurance.Run, list []campaignassurance.RunConfiguration) (map[string]campaignassurance.RunConfiguration, bool, error) {
	hasDeterministic := false
	configurations := make(map[string]campaignassurance.RunConfiguration, len(list))
	for index, configuration := range list {
		if configuration.TenantID != run.TenantID || configuration.CampaignID != run.CampaignID ||
			configuration.RunID != run.ID || configuration.Ordinal != index+1 ||
			!validHash(configuration.ConfigurationHash) {
			return nil, false, ErrIntegrityMismatch
		}
		switch configuration.SourceClass {
		case campaignassurance.SourceDeterministic:
			hasDeterministic = true
		case campaignassurance.SourceModeled, campaignassurance.SourceControlledObservation:
		default:
			return nil, false, ErrIntegrityMismatch
		}
		if _, duplicate := configurations[configuration.ID]; duplicate {
			return nil, false, ErrIntegrityMismatch
		}
		configurations[configuration.ID] = configuration
	}
	return configurations, hasDeterministic, nil
}

func canonicalUUIDValue(value string) bool {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	return err == nil && parsed.String() == value
}

func (g *Gate) authorizeOverrides(ctx context.Context, tenantID string, run campaignassurance.Run) ([]string, error) {
	findings, err := g.Store.ListFindings(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	blocking := make([]campaignassurance.Finding, 0, run.BlockingFindingCount)
	seenFindings := make(map[string]struct{}, run.BlockingFindingCount)
	for _, finding := range findings {
		if finding.AttemptCount == run.AttemptCount && finding.Blocking {
			if finding.TenantID != run.TenantID || finding.CampaignID != run.CampaignID ||
				finding.RunID != run.ID || finding.SendPlanID != run.SendPlanID ||
				!canonicalUUIDValue(finding.ID) || !validHash(finding.ConfigurationHash) ||
				!validHash(finding.OutboundMIMEHash) || !validHash(finding.FindingKey) ||
				!validHash(finding.ReceiptHash) || finding.SourceClass != campaignassurance.SourceDeterministic {
				return nil, ErrIntegrityMismatch
			}
			if _, duplicate := seenFindings[finding.ID]; duplicate {
				return nil, ErrIntegrityMismatch
			}
			seenFindings[finding.ID] = struct{}{}
			blocking = append(blocking, finding)
		}
	}
	if len(blocking) == 0 || len(blocking) != run.BlockingFindingCount {
		return nil, ErrIntegrityMismatch
	}
	overrides, err := g.Store.ListOverrides(ctx, tenantID, run.ID)
	if err != nil {
		return nil, err
	}
	latest := make(map[string]campaignassurance.Override, len(blocking))
	for _, override := range overrides {
		if override.AttemptCount != run.AttemptCount || override.ArtifactSetHash != run.ArtifactSetHash {
			continue
		}
		if override.TenantID != run.TenantID || override.CampaignID != run.CampaignID ||
			override.RunID != run.ID || !canonicalUUIDValue(override.ID) ||
			!canonicalUUIDValue(override.FindingID) || !canonicalUUIDValue(override.ActorID) ||
			!validHash(override.FindingReceiptHash) || !validHash(override.RequestHash) {
			return nil, ErrIntegrityMismatch
		}
		previous, exists := latest[override.FindingID]
		if !exists || override.CreatedAt.After(previous.CreatedAt) ||
			(override.CreatedAt.Equal(previous.CreatedAt) && override.ID > previous.ID) {
			latest[override.FindingID] = override
		}
	}
	now := g.now()
	approved := make([]string, 0, len(blocking))
	for _, finding := range blocking {
		if !finding.Overridable {
			return nil, ErrBlocked
		}
		override, ok := latest[finding.ID]
		if !ok || override.Decision != "allow_send" ||
			override.FindingReceiptHash != finding.ReceiptHash ||
			(override.ExpiresAt != nil && !override.ExpiresAt.After(now)) ||
			(override.ActorRole != "owner" && override.ActorRole != "admin") {
			return nil, ErrBlocked
		}
		approved = append(approved, override.ID)
	}
	sort.Strings(approved)
	return approved, nil
}

func IsDenial(err error) bool {
	return errors.Is(err, ErrNotAssured) || errors.Is(err, ErrPending) ||
		errors.Is(err, ErrStale) || errors.Is(err, ErrUnavailable) ||
		errors.Is(err, ErrBlocked) || errors.Is(err, ErrIntegrityMismatch)
}
