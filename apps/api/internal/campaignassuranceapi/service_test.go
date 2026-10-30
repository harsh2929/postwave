// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

const (
	testTenantID   = "11111111-1111-4111-8111-111111111111"
	testCampaignID = "22222222-2222-4222-8222-222222222222"
	testRevisionID = "33333333-3333-4333-8333-333333333333"
	testPlanID     = "44444444-4444-4444-8444-444444444444"
	testRunID      = "55555555-5555-4555-8555-555555555555"
	testActorID    = "66666666-6666-4666-8666-666666666666"
	testRequestID  = "77777777-7777-4777-8777-777777777777"
	testFindingID  = "88888888-8888-4888-8888-888888888888"
	testOverrideID = "99999999-9999-4999-8999-999999999999"
)

var _ Repository = (*campaignassurance.Repo)(nil)

type fakeRepository struct {
	mu sync.Mutex

	createInput campaignassurance.CreateRunInput
	createCalls int
	createRun   *campaignassurance.Run
	createErr   error

	getRun         *campaignassurance.Run
	getRunSequence []*campaignassurance.Run
	getRunErr      error
	getRunCalls    int
	listRuns       []campaignassurance.Run
	listRunsErr    error
	listRunsLimit  int

	manifest      *campaignassurance.ClaimedRun
	manifestErr   error
	manifestCalls int

	extractions    []campaignassurance.Extraction
	extractionsErr error
	findings       []campaignassurance.Finding
	findingsErr    error
	overrides      []campaignassurance.Override
	overridesErr   error

	overrideInput   campaignassurance.OverrideInput
	overrideActorID string
	overrideRunID   string
	overrideResult  *campaignassurance.Override
	overrideErr     error
	overrideCalls   int

	cancelResult *campaignassurance.Run
	cancelErr    error
	cancelCalls  int
}

func (f *fakeRepository) CreateRun(_ context.Context, _ string, input campaignassurance.CreateRunInput) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	f.createInput = input
	return f.createRun, f.createErr
}

func (f *fakeRepository) GetRun(_ context.Context, _, _ string) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.getRunCalls++
	if len(f.getRunSequence) > 0 {
		index := f.getRunCalls - 1
		if index >= len(f.getRunSequence) {
			index = len(f.getRunSequence) - 1
		}
		return f.getRunSequence[index], f.getRunErr
	}
	return f.getRun, f.getRunErr
}

func (f *fakeRepository) ListRuns(_ context.Context, _, _ string, limit int) ([]campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listRunsLimit = limit
	return append([]campaignassurance.Run(nil), f.listRuns...), f.listRunsErr
}

func (f *fakeRepository) GetRunManifest(_ context.Context, _, _ string) (*campaignassurance.ClaimedRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.manifestCalls++
	return f.manifest, f.manifestErr
}

func (f *fakeRepository) ListExtractions(_ context.Context, _, _ string) ([]campaignassurance.Extraction, error) {
	return append([]campaignassurance.Extraction(nil), f.extractions...), f.extractionsErr
}

func (f *fakeRepository) ListFindings(_ context.Context, _, _ string) ([]campaignassurance.Finding, error) {
	return append([]campaignassurance.Finding(nil), f.findings...), f.findingsErr
}

func (f *fakeRepository) ListOverrides(_ context.Context, _, _ string) ([]campaignassurance.Override, error) {
	return append([]campaignassurance.Override(nil), f.overrides...), f.overridesErr
}

func (f *fakeRepository) CreateOverride(_ context.Context, _, runID, actorID string, input campaignassurance.OverrideInput) (*campaignassurance.Override, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.overrideCalls++
	f.overrideRunID = runID
	f.overrideActorID = actorID
	f.overrideInput = input
	return f.overrideResult, f.overrideErr
}

func (f *fakeRepository) CancelRun(_ context.Context, _, _ string) (*campaignassurance.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelCalls++
	return f.cancelResult, f.cancelErr
}

type fakeScheduler struct {
	mu       sync.Mutex
	commands []DispatchCommand
	err      error
}

func (f *fakeScheduler) EnqueueCampaignAssurance(_ context.Context, command DispatchCommand) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commands = append(f.commands, command)
	return f.err
}

func testRun() campaignassurance.Run {
	now := time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC)
	return campaignassurance.Run{
		ID: testRunID, CampaignID: testCampaignID, ContentRevisionID: testRevisionID,
		SendPlanID: testPlanID, RequestID: testRequestID, Profile: campaignassurance.ProfileFull,
		State: campaignassurance.StateQueued, GateDecision: campaignassurance.GatePending,
		RequiredScenarioCount: 2, RequiredConfigurationCount: 2, RequiredExtractionCount: 4,
		CreatedAt: now, UpdatedAt: now,
	}
}

func testManifest(run campaignassurance.Run) *campaignassurance.ClaimedRun {
	return &campaignassurance.ClaimedRun{
		Run: run,
		Configurations: []campaignassurance.RunConfiguration{
			{ID: "deterministic.preflight", SourceClass: campaignassurance.SourceDeterministic},
			{ID: "modeled.ensemble", SourceClass: campaignassurance.SourceModeled},
		},
	}
}

func TestServiceStartRunUsesOnlyFrozenServerSuiteAndAuthenticatedActor(t *testing.T) {
	run := testRun()
	repository := &fakeRepository{createRun: &run}
	scheduler := &fakeScheduler{}
	service, err := NewService(repository, testSuiteRegistry(t), scheduler)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}

	created, sourceClasses, err := service.StartRun(context.Background(), StartRunCommand{
		TenantID: testTenantID, CampaignID: testCampaignID, ContentRevisionID: testRevisionID,
		SendPlanID: testPlanID, RequestID: testRequestID,
		Profile: campaignassurance.ProfileFull, ActorID: testActorID,
	})
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if created.ID != testRunID {
		t.Fatalf("run id = %q", created.ID)
	}
	if !reflect.DeepEqual(sourceClasses, []string{campaignassurance.SourceDeterministic, campaignassurance.SourceModeled}) {
		t.Fatalf("source classes = %#v", sourceClasses)
	}
	input := repository.createInput
	if input.CreatedBy != testActorID || input.TriggerKind != campaignassurance.TriggerExplicit ||
		input.AnalyzerSuiteVersion != "analyzers-2026-08-09" ||
		input.PromptSuiteVersion != "prompts-2026-08-09" ||
		input.GatePolicyVersion != "gate-v1" || len(input.Configurations) != 2 ||
		len(input.Targets) != 0 {
		t.Fatalf("server-owned create input was not exact: %+v", input)
	}
	if len(scheduler.commands) != 1 || scheduler.commands[0] != (DispatchCommand{
		TenantID: testTenantID, CampaignID: testCampaignID,
		RunID: testRunID, RequestID: testRequestID,
	}) {
		t.Fatalf("dispatch commands = %+v", scheduler.commands)
	}
}

func TestServiceStartRunFailsClosedWithoutScheduler(t *testing.T) {
	run := testRun()
	repository := &fakeRepository{createRun: &run}
	service, err := NewService(repository, testSuiteRegistry(t), nil)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	_, _, err = service.StartRun(context.Background(), StartRunCommand{
		TenantID: testTenantID, CampaignID: testCampaignID, ContentRevisionID: testRevisionID,
		SendPlanID: testPlanID, RequestID: testRequestID,
		Profile: campaignassurance.ProfileFull, ActorID: testActorID,
	})
	if !errors.Is(err, ErrDispatchUnavailable) || repository.createCalls != 0 {
		t.Fatalf("err=%v create calls=%d, want dispatch unavailable before persistence", err, repository.createCalls)
	}
}

func TestServiceDispatchFailureCanRetryExactDurableRun(t *testing.T) {
	run := testRun()
	repository := &fakeRepository{createRun: &run}
	scheduler := &fakeScheduler{err: errors.New("outbox temporarily unavailable")}
	service, err := NewService(repository, testSuiteRegistry(t), scheduler)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	command := StartRunCommand{
		TenantID: testTenantID, CampaignID: testCampaignID, ContentRevisionID: testRevisionID,
		SendPlanID: testPlanID, RequestID: testRequestID,
		Profile: campaignassurance.ProfileFull, ActorID: testActorID,
	}
	for attempt := 0; attempt < 2; attempt++ {
		if _, _, err := service.StartRun(context.Background(), command); !errors.Is(err, ErrDispatchUnavailable) {
			t.Fatalf("attempt %d err=%v", attempt, err)
		}
	}
	if repository.createCalls != 2 || len(scheduler.commands) != 2 || scheduler.commands[0] != scheduler.commands[1] {
		t.Fatalf("retry did not converge: creates=%d commands=%+v", repository.createCalls, scheduler.commands)
	}
}

func TestServiceFlattensCrossCampaignRunBeforeAllDetailOrMutationReads(t *testing.T) {
	run := testRun()
	run.CampaignID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	repository := &fakeRepository{getRun: &run}
	service, err := NewService(repository, testSuiteRegistry(t), &fakeScheduler{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	checks := []struct {
		name string
		call func() error
	}{
		{"detail", func() error {
			_, err := service.Detail(context.Background(), testTenantID, testCampaignID, testRunID)
			return err
		}},
		{"evidence", func() error {
			_, err := service.Evidence(context.Background(), testTenantID, testCampaignID, testRunID, 0, 10)
			return err
		}},
		{"progress", func() error {
			_, err := service.Progress(context.Background(), testTenantID, testCampaignID, testRunID)
			return err
		}},
		{"appeal", func() error {
			_, err := service.Appeal(context.Background(), AppealCommand{TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID, FindingID: testFindingID, RequestID: testRequestID, ActorID: testActorID, Decision: "allow_send", Reason: "documented exception"})
			return err
		}},
		{"cancel", func() error {
			_, err := service.Cancel(context.Background(), testTenantID, testCampaignID, testRunID)
			return err
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.call(); !errors.Is(err, campaignassurance.ErrNotFound) {
				t.Fatalf("err=%v, want not found", err)
			}
		})
	}
	if repository.manifestCalls != 0 || repository.overrideCalls != 0 || repository.cancelCalls != 0 {
		t.Fatalf("cross-campaign run reached child operation: manifest=%d override=%d cancel=%d",
			repository.manifestCalls, repository.overrideCalls, repository.cancelCalls)
	}
}

func TestServiceEvidenceBoundsEachDurableCollection(t *testing.T) {
	run := testRun()
	repository := &fakeRepository{getRun: &run, manifest: testManifest(run)}
	for index := 0; index < 250; index++ {
		repository.extractions = append(repository.extractions, campaignassurance.Extraction{ID: testRunID, AttemptCount: index})
		repository.findings = append(repository.findings, campaignassurance.Finding{ID: testFindingID, AttemptCount: index})
		repository.overrides = append(repository.overrides, campaignassurance.Override{ID: testOverrideID, AttemptCount: index})
	}
	service, err := NewService(repository, testSuiteRegistry(t), &fakeScheduler{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	page, err := service.Evidence(context.Background(), testTenantID, testCampaignID, testRunID, 200, 25)
	if err != nil {
		t.Fatalf("Evidence: %v", err)
	}
	if len(page.Extractions.Items) != 25 || len(page.Findings.Items) != 25 || len(page.Overrides.Items) != 25 ||
		page.Extractions.Total != 250 || page.Extractions.NextOffset == nil || *page.Extractions.NextOffset != 225 {
		t.Fatalf("unexpected bounded page: %+v", page)
	}
	if !reflect.DeepEqual(page.SourceClasses, []string{campaignassurance.SourceDeterministic, campaignassurance.SourceModeled}) {
		t.Fatalf("source classes = %#v", page.SourceClasses)
	}
	if _, err := service.Evidence(context.Background(), testTenantID, testCampaignID, testRunID, -1, 25); !errors.Is(err, campaignassurance.ErrInvalidInput) {
		t.Fatalf("negative offset err=%v", err)
	}
}

func TestServiceLatestDetailProgressAndAppealUseExactBoundManifest(t *testing.T) {
	run := testRun()
	override := &campaignassurance.Override{
		ID: testOverrideID, CampaignID: testCampaignID, RunID: testRunID,
		FindingID: testFindingID, RequestID: testRequestID, ActorID: testActorID,
		Decision: "reject", Reason: "reviewer rejected exception",
	}
	repository := &fakeRepository{
		getRun: &run, listRuns: []campaignassurance.Run{run}, manifest: testManifest(run),
		overrideResult: override,
	}
	service, err := NewService(repository, testSuiteRegistry(t), &fakeScheduler{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	latest, err := service.Latest(context.Background(), testTenantID, testCampaignID)
	if err != nil || latest.Run.ID != testRunID || repository.listRunsLimit != 1 {
		t.Fatalf("latest=%+v err=%v limit=%d", latest, err, repository.listRunsLimit)
	}
	detail, err := service.Detail(context.Background(), testTenantID, testCampaignID, testRunID)
	if err != nil || detail.Manifest.Run.ID != testRunID || len(detail.SourceClasses) != 2 {
		t.Fatalf("detail=%+v err=%v", detail, err)
	}
	progress, err := service.Progress(context.Background(), testTenantID, testCampaignID, testRunID)
	if err != nil || progress.EventHistoryAvailable || progress.RequiredExtractions != 4 ||
		progress.EventHistoryExplanation == "" {
		t.Fatalf("progress=%+v err=%v", progress, err)
	}
	appealed, err := service.Appeal(context.Background(), AppealCommand{
		TenantID: testTenantID, CampaignID: testCampaignID, RunID: testRunID,
		FindingID: testFindingID, RequestID: testRequestID, ActorID: testActorID,
		Decision: "reject", Reason: "reviewer rejected exception",
	})
	if err != nil || appealed.ID != testOverrideID || repository.overrideCalls != 1 ||
		repository.overrideRunID != testRunID || repository.overrideActorID != testActorID ||
		repository.overrideInput.FindingID != testFindingID {
		t.Fatalf("appealed=%+v err=%v repo=%+v", appealed, err, repository)
	}
}

func TestServiceLatestReturnsNotFoundWithoutRuns(t *testing.T) {
	service, err := NewService(&fakeRepository{}, testSuiteRegistry(t), &fakeScheduler{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	if _, err := service.Latest(context.Background(), testTenantID, testCampaignID); !errors.Is(err, campaignassurance.ErrNotFound) {
		t.Fatalf("err=%v", err)
	}
}

func TestServiceCancelIsSemanticallyIdempotent(t *testing.T) {
	run := testRun()
	run.State = campaignassurance.StateCancelled
	repository := &fakeRepository{getRun: &run}
	service, err := NewService(repository, testSuiteRegistry(t), &fakeScheduler{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	cancelled, err := service.Cancel(context.Background(), testTenantID, testCampaignID, testRunID)
	if err != nil || cancelled.State != campaignassurance.StateCancelled || repository.cancelCalls != 0 {
		t.Fatalf("cancelled=%+v err=%v calls=%d", cancelled, err, repository.cancelCalls)
	}
}

func TestServiceCancelConvergesAfterConcurrentTransitionRace(t *testing.T) {
	running := testRun()
	running.State = campaignassurance.StateRunning
	cancelled := running
	cancelled.State = campaignassurance.StateCancelled
	repository := &fakeRepository{
		getRunSequence: []*campaignassurance.Run{&running, &cancelled},
		cancelErr:      campaignassurance.ErrInvalidTransition,
	}
	service, err := NewService(repository, testSuiteRegistry(t), &fakeScheduler{})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	result, err := service.Cancel(context.Background(), testTenantID, testCampaignID, testRunID)
	if err != nil || result == nil || result.State != campaignassurance.StateCancelled ||
		repository.cancelCalls != 1 || repository.getRunCalls != 2 {
		t.Fatalf("result=%+v err=%v cancel=%d gets=%d", result, err, repository.cancelCalls, repository.getRunCalls)
	}
}
