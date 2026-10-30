// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancegate

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

type fakeStore struct {
	runs      []campaignassurance.Run
	manifest  *campaignassurance.ClaimedRun
	findings  []campaignassurance.Finding
	overrides []campaignassurance.Override
}

func (f *fakeStore) ListRuns(context.Context, string, string, int) ([]campaignassurance.Run, error) {
	return append([]campaignassurance.Run(nil), f.runs...), nil
}
func (f *fakeStore) GetRunManifest(context.Context, string, string) (*campaignassurance.ClaimedRun, error) {
	return f.manifest, nil
}
func (f *fakeStore) ListFindings(context.Context, string, string) ([]campaignassurance.Finding, error) {
	return append([]campaignassurance.Finding(nil), f.findings...), nil
}
func (f *fakeStore) ListOverrides(context.Context, string, string) ([]campaignassurance.Override, error) {
	return append([]campaignassurance.Override(nil), f.overrides...), nil
}

func gateFixture() (Request, campaignassurance.Run, *campaignassurance.ClaimedRun) {
	tenantID, campaignID, revisionID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	runID, planID, artifactID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash := strings.Repeat("a", 64)
	run := campaignassurance.Run{
		ID: runID, TenantID: tenantID, CampaignID: campaignID,
		ContentRevisionID: revisionID, SendPlanID: planID, RunNo: 2,
		Profile: campaignassurance.ProfileFast, State: campaignassurance.StateComplete,
		SourceHash: hash, PlanHash: strings.Repeat("b", 64), ArtifactSetHash: strings.Repeat("c", 64),
		CoverageManifestHash: strings.Repeat("4", 64), ConfigurationManifestHash: strings.Repeat("5", 64),
		TargetManifestHash:    strings.Repeat("6", 64),
		RequiredScenarioCount: 1, RequiredConfigurationCount: 1, RequiredExtractionCount: 1,
		TerminalExtractionCount: 1, SuccessfulExtractionCount: 1, AttemptCount: 1,
		GateDecision: campaignassurance.GatePass, CreatedAt: time.Now().UTC(),
	}
	configuration := campaignassurance.RunConfiguration{
		TenantID: tenantID, CampaignID: campaignID, RunID: runID, Ordinal: 1,
		ID: "deterministic.v1", SourceClass: campaignassurance.SourceDeterministic,
		ConfigurationHash: strings.Repeat("d", 64),
	}
	artifact := campaignassurance.RunArtifact{
		TenantID: tenantID, CampaignID: campaignID, RunID: runID, SendPlanID: planID,
		ArtifactID: artifactID, Ordinal: 1,
		OutboundMIMEHash: strings.Repeat("e", 64), MIMEStructureHash: strings.Repeat("f", 64),
	}
	manifest := &campaignassurance.ClaimedRun{
		Run: run, Artifacts: []campaignassurance.RunArtifact{artifact},
		Configurations: []campaignassurance.RunConfiguration{configuration},
		Targets: []campaignassurance.RunTarget{{
			TenantID: tenantID, CampaignID: campaignID, RunID: runID, SendPlanID: planID,
			ArtifactID: artifactID, Ordinal: 1,
			ConfigurationID: configuration.ID, SourceClass: configuration.SourceClass,
			ConfigurationHash: configuration.ConfigurationHash,
			OutboundMIMEHash:  artifact.OutboundMIMEHash,
		}},
	}
	return Request{TenantID: tenantID, CampaignID: campaignID, ContentRevisionID: revisionID, SourceHash: hash}, run, manifest
}

func TestAuthorizeExactCompleteDeterministicRun(t *testing.T) {
	request, run, manifest := gateFixture()
	older := run
	older.ID, older.ContentRevisionID, older.RunNo = uuid.NewString(), uuid.NewString(), 1
	gate := &Gate{Store: &fakeStore{runs: []campaignassurance.Run{older, run}, manifest: manifest}}
	receipt, err := gate.Authorize(context.Background(), request)
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if receipt.RunID != run.ID || receipt.Decision != campaignassurance.GatePass || receipt.SendPlanID != run.SendPlanID {
		t.Fatalf("receipt = %+v", receipt)
	}
}

func TestAuthorizeNeverFallsBackAcrossRevisionOrPendingRun(t *testing.T) {
	request, run, manifest := gateFixture()
	run.State = campaignassurance.StateRunning
	manifest.Run = run
	gate := &Gate{Store: &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest}}
	if _, err := gate.Authorize(context.Background(), request); !errors.Is(err, ErrPending) {
		t.Fatalf("pending error = %v", err)
	}
	request.ContentRevisionID = uuid.NewString()
	if _, err := gate.Authorize(context.Background(), request); !errors.Is(err, ErrNotAssured) {
		t.Fatalf("revision mismatch error = %v", err)
	}
}

func TestAuthorizeBlockedRunRequiresEveryLatestLiveOverride(t *testing.T) {
	request, run, manifest := gateFixture()
	run.GateDecision, run.BlockingFindingCount = campaignassurance.GateBlock, 2
	manifest.Run = run
	now := time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)
	newFinding := func(receiptDigit string) campaignassurance.Finding {
		return campaignassurance.Finding{
			ID: uuid.NewString(), TenantID: run.TenantID, CampaignID: run.CampaignID,
			RunID: run.ID, SendPlanID: run.SendPlanID, AttemptCount: 1,
			ConfigurationHash: strings.Repeat("7", 64), OutboundMIMEHash: strings.Repeat("8", 64),
			FindingKey: strings.Repeat("9", 64), ReceiptHash: strings.Repeat(receiptDigit, 64),
			FindingInput: campaignassurance.FindingInput{SourceClass: campaignassurance.SourceDeterministic, Blocking: true, Overridable: true},
		}
	}
	first := newFinding("1")
	second := newFinding("2")
	allow := func(finding campaignassurance.Finding, created time.Time) campaignassurance.Override {
		return campaignassurance.Override{
			ID: uuid.NewString(), TenantID: run.TenantID, CampaignID: run.CampaignID,
			RunID: run.ID, AttemptCount: 1, FindingID: finding.ID,
			FindingReceiptHash: finding.ReceiptHash, ArtifactSetHash: run.ArtifactSetHash,
			RequestHash: strings.Repeat("3", 64), ActorID: uuid.NewString(),
			Decision: "allow_send", ActorRole: "admin", CreatedAt: created,
		}
	}
	store := &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest,
		findings:  []campaignassurance.Finding{first, second},
		overrides: []campaignassurance.Override{allow(first, now.Add(-time.Minute))}}
	gate := &Gate{Store: store, Now: func() time.Time { return now }}
	if _, err := gate.Authorize(context.Background(), request); !errors.Is(err, ErrBlocked) {
		t.Fatalf("partial override error = %v", err)
	}
	store.overrides = append(store.overrides, allow(second, now.Add(-time.Minute)))
	receipt, err := gate.Authorize(context.Background(), request)
	if err != nil || receipt.Decision != "overridden" || len(receipt.OverrideIDs) != 2 {
		t.Fatalf("full override receipt=%+v err=%v", receipt, err)
	}
	// An explicit later rejection revokes the prior allow decision.
	reject := allow(first, now)
	reject.Decision = "reject"
	store.overrides = append(store.overrides, reject)
	if _, err := gate.Authorize(context.Background(), request); !errors.Is(err, ErrBlocked) {
		t.Fatalf("revoked override error = %v", err)
	}
}

func TestAuthorizeRejectsCalibrationAndManifestDrift(t *testing.T) {
	request, run, manifest := gateFixture()
	run.Profile = campaignassurance.ProfileCalibration
	manifest.Run = run
	store := &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest}
	gate := &Gate{Store: store}
	if _, err := gate.Authorize(context.Background(), request); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("calibration error = %v", err)
	}
	run.Profile = campaignassurance.ProfileFast
	manifest.Run = run
	store.runs = []campaignassurance.Run{run}
	manifest.Targets[0].OutboundMIMEHash = strings.Repeat("0", 64)
	if _, err := gate.Authorize(context.Background(), request); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("manifest drift error = %v", err)
	}
}
