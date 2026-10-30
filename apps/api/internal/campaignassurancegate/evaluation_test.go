// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancegate

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

func TestEvaluateAndAuthorizeShareOneExactHashDecision(t *testing.T) {
	request, run, manifest := gateFixture()
	now := time.Date(2026, 8, 10, 9, 0, 0, 0, time.UTC)
	score, minimum, maximum := 82.0, 76.0, 88.0
	run.GateDecision = campaignassurance.GateWarn
	run.OverallScore, run.ScoreMin, run.ScoreMax = &score, &minimum, &maximum
	run.CompletedAt, run.UpdatedAt = &now, now
	manifest.Run = run
	gate := &Gate{Store: &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest}, Now: func() time.Time { return now.Add(time.Minute) }}

	evaluation, err := gate.Evaluate(t.Context(), request)
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if evaluation.Status != StatusWarn || !evaluation.Authorized || evaluation.ReasonCode != ReasonAuthorizedWarn ||
		evaluation.RunID != run.ID || evaluation.SendPlanID != run.SendPlanID ||
		evaluation.SourceHash != run.SourceHash || evaluation.PlanHash != run.PlanHash ||
		evaluation.ArtifactSetHash != run.ArtifactSetHash || evaluation.CoverageManifestHash != run.CoverageManifestHash ||
		evaluation.PredictedScore == nil || *evaluation.PredictedScore != score ||
		evaluation.SourceCoverage.Required != 1 || evaluation.SourceCoverage.Successful != 1 ||
		evaluation.SourceCoverage.Ratio != 1 || evaluation.SourceCoverage.DeterministicConfigs != 1 ||
		!evaluation.RefreshedAt.Equal(now) {
		t.Fatalf("evaluation = %+v", evaluation)
	}
	receipt, err := gate.Authorize(t.Context(), request)
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if receipt.RunID != evaluation.RunID || receipt.SendPlanID != evaluation.SendPlanID ||
		receipt.SourceHash != evaluation.SourceHash || receipt.PlanHash != evaluation.PlanHash ||
		receipt.ArtifactSetHash != evaluation.ArtifactSetHash || receipt.Decision != evaluation.GateDecision {
		t.Fatalf("status/receipt drift: evaluation=%+v receipt=%+v", evaluation, receipt)
	}
}

func TestEvaluateClosedLifecycleStatusMapping(t *testing.T) {
	tests := []struct {
		name   string
		state  string
		status Status
		reason string
		want   error
	}{
		{name: "queued", state: campaignassurance.StateQueued, status: StatusPending, reason: ReasonRunPending, want: ErrPending},
		{name: "running", state: campaignassurance.StateRunning, status: StatusPending, reason: ReasonRunPending, want: ErrPending},
		{name: "stale", state: campaignassurance.StateStale, status: StatusStale, reason: ReasonRunStale, want: ErrStale},
		{name: "incomplete", state: campaignassurance.StateIncomplete, status: StatusUnavailable, reason: ReasonEvidenceUnavailable, want: ErrUnavailable},
		{name: "failed", state: campaignassurance.StateFailed, status: StatusUnavailable, reason: ReasonEvidenceUnavailable, want: ErrUnavailable},
		{name: "cancelled", state: campaignassurance.StateCancelled, status: StatusUnavailable, reason: ReasonEvidenceUnavailable, want: ErrUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request, run, manifest := gateFixture()
			run.State, manifest.Run = test.state, run
			evaluation, err := (&Gate{Store: &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest}}).Evaluate(t.Context(), request)
			if !errors.Is(err, test.want) || evaluation.Status != test.status || evaluation.ReasonCode != test.reason || evaluation.Authorized {
				t.Fatalf("evaluation=%+v err=%v", evaluation, err)
			}
		})
	}
}

func TestEvaluateRejectsStaleExpiredAndNonDeterministicWaiverEvidence(t *testing.T) {
	request, run, manifest := gateFixture()
	run.GateDecision, run.BlockingFindingCount = campaignassurance.GateBlock, 1
	manifest.Run = run
	now := time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC)
	finding := campaignassurance.Finding{
		ID: uuid.NewString(), TenantID: run.TenantID, CampaignID: run.CampaignID,
		RunID: run.ID, SendPlanID: run.SendPlanID, AttemptCount: run.AttemptCount,
		ConfigurationHash: strings.Repeat("4", 64), OutboundMIMEHash: strings.Repeat("5", 64),
		FindingKey: strings.Repeat("6", 64), ReceiptHash: strings.Repeat("7", 64),
		FindingInput: campaignassurance.FindingInput{
			SourceClass: campaignassurance.SourceDeterministic, Blocking: true, Overridable: true,
		},
	}
	valid := campaignassurance.Override{
		ID: uuid.NewString(), TenantID: run.TenantID, CampaignID: run.CampaignID,
		RunID: run.ID, AttemptCount: run.AttemptCount,
		FindingID: finding.ID, FindingReceiptHash: finding.ReceiptHash,
		RequestHash: strings.Repeat("3", 64), ArtifactSetHash: run.ArtifactSetHash,
		ActorID: uuid.NewString(), Decision: "allow_send", ActorRole: "admin",
		CreatedAt: now.Add(-time.Minute),
	}
	tests := []struct {
		name   string
		mutate func(*campaignassurance.Finding, *campaignassurance.Override)
		want   error
	}{
		{name: "expired", mutate: func(_ *campaignassurance.Finding, override *campaignassurance.Override) {
			expired := now
			override.ExpiresAt = &expired
		}, want: ErrBlocked},
		{name: "stale finding receipt", mutate: func(_ *campaignassurance.Finding, override *campaignassurance.Override) {
			override.FindingReceiptHash = strings.Repeat("8", 64)
		}, want: ErrBlocked},
		{name: "stale artifact set", mutate: func(_ *campaignassurance.Finding, override *campaignassurance.Override) {
			override.ArtifactSetHash = strings.Repeat("9", 64)
		}, want: ErrBlocked},
		{name: "stale attempt", mutate: func(_ *campaignassurance.Finding, override *campaignassurance.Override) { override.AttemptCount++ }, want: ErrBlocked},
		{name: "modeled blocker", mutate: func(finding *campaignassurance.Finding, _ *campaignassurance.Override) {
			finding.SourceClass = campaignassurance.SourceModeled
		}, want: ErrIntegrityMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidateFinding, candidateOverride := finding, valid
			test.mutate(&candidateFinding, &candidateOverride)
			gate := &Gate{Store: &fakeStore{
				runs: []campaignassurance.Run{run}, manifest: manifest,
				findings: []campaignassurance.Finding{candidateFinding}, overrides: []campaignassurance.Override{candidateOverride},
			}, Now: func() time.Time { return now }}
			evaluation, err := gate.Evaluate(t.Context(), request)
			if !errors.Is(err, test.want) || evaluation.Authorized {
				t.Fatalf("evaluation=%+v err=%v", evaluation, err)
			}
			if errors.Is(test.want, ErrIntegrityMismatch) && evaluation.Status != StatusError {
				t.Fatalf("integrity failure status=%q", evaluation.Status)
			}
		})
	}
}

type boundedStore struct {
	base      *fakeStore
	wantLimit int
	calls     int
	mu        sync.Mutex
}

func (s *boundedStore) ListRuns(ctx context.Context, tenantID, campaignID string, limit int) ([]campaignassurance.Run, error) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	if limit != s.wantLimit {
		return nil, errors.New("unbounded run scan")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return s.base.ListRuns(ctx, tenantID, campaignID, limit)
}

func (s *boundedStore) GetRunManifest(ctx context.Context, tenantID, runID string) (*campaignassurance.ClaimedRun, error) {
	return s.base.GetRunManifest(ctx, tenantID, runID)
}
func (s *boundedStore) ListFindings(ctx context.Context, tenantID, runID string) ([]campaignassurance.Finding, error) {
	return s.base.ListFindings(ctx, tenantID, runID)
}
func (s *boundedStore) ListOverrides(ctx context.Context, tenantID, runID string) ([]campaignassurance.Override, error) {
	return s.base.ListOverrides(ctx, tenantID, runID)
}

func TestEvaluateIsBoundedAndConcurrentReadSafe(t *testing.T) {
	request, run, manifest := gateFixture()
	runs := make([]campaignassurance.Run, 0, maxRunScan)
	for index := 0; index < maxRunScan-1; index++ {
		candidate := run
		candidate.ID, candidate.ContentRevisionID = uuid.NewString(), uuid.NewString()
		candidate.RunNo = int64(index + 1)
		runs = append(runs, candidate)
	}
	run.RunNo = maxRunScan
	runs = append(runs, run)
	store := &boundedStore{base: &fakeStore{runs: runs, manifest: manifest}, wantLimit: maxRunScan}
	gate := &Gate{Store: store}

	const workers = 64
	errs := make(chan error, workers)
	var wait sync.WaitGroup
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			evaluation, err := gate.Evaluate(t.Context(), request)
			if err != nil {
				errs <- err
				return
			}
			if !evaluation.Authorized || evaluation.RunID != run.ID {
				errs <- errors.New("concurrent evaluation returned a different run")
			}
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	store.mu.Lock()
	calls := store.calls
	store.mu.Unlock()
	if calls != workers {
		t.Fatalf("list calls=%d, want %d", calls, workers)
	}
}
