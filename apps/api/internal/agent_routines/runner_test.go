// SPDX-License-Identifier: AGPL-3.0-only
package agent_routines

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
)

// ---- fakes -------------------------------------------------------------

type fakeRunnerStore struct {
	mu       sync.Mutex
	routines map[string]*Routine // key: routineID
	nextRun  int
	active   map[string]bool
	runOwner map[string]string

	insertedRuns []string
	finished     []finishedRun
	campaigns    []CampaignDraft
	campaignSeg  []*string
	campaignID   string
	campaignErr  error
	insertErr    error
}

type finishedRun struct {
	TenantID, RunID, Status, OutputKind, OutputRef, ApprovalID, ErrMsg string
	PromptUsed, ContextUsed, Reasoning                                 string
	DraftPreview                                                       string
}

func newFakeRunnerStore(routines ...*Routine) *fakeRunnerStore {
	m := map[string]*Routine{}
	for _, rt := range routines {
		m[rt.ID] = rt
	}
	return &fakeRunnerStore{
		routines:   m,
		active:     map[string]bool{},
		runOwner:   map[string]string{},
		campaignID: "campaign-1",
	}
}

func (f *fakeRunnerStore) GetRoutine(_ context.Context, _, id string) (*Routine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	rt, ok := f.routines[id]
	if !ok {
		return nil, ErrNotFound
	}
	cp := *rt
	return &cp, nil
}

func (f *fakeRunnerStore) InsertRun(_ context.Context, _, routineID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.insertErr != nil {
		return "", f.insertErr
	}
	if _, ok := f.routines[routineID]; !ok {
		return "", ErrNotFound
	}
	if f.active[routineID] {
		return "", ErrRoutineActive
	}
	f.nextRun++
	id := "run-" + routineID
	f.active[routineID] = true
	f.runOwner[id] = routineID
	f.insertedRuns = append(f.insertedRuns, id)
	return id, nil
}

func (f *fakeRunnerStore) FinishRun(_ context.Context, tenantID, runID string, in FinishRunInput) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if routineID := f.runOwner[runID]; routineID != "" {
		delete(f.active, routineID)
		delete(f.runOwner, runID)
	}
	f.finished = append(f.finished, finishedRun{
		TenantID:     tenantID,
		RunID:        runID,
		Status:       in.Status,
		OutputKind:   in.OutputKind,
		OutputRef:    in.OutputRef,
		ApprovalID:   in.ApprovalID,
		ErrMsg:       in.ErrMsg,
		PromptUsed:   in.PromptUsed,
		ContextUsed:  in.ContextUsed,
		Reasoning:    in.Reasoning,
		DraftPreview: string(in.DraftPreview),
	})
	return nil
}

func (f *fakeRunnerStore) CreateDraftCampaign(_ context.Context, _ string, d CampaignDraft, segmentID *string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.campaignErr != nil {
		return "", f.campaignErr
	}
	f.campaigns = append(f.campaigns, d)
	f.campaignSeg = append(f.campaignSeg, segmentID)
	return f.campaignID, nil
}

func (f *fakeRunnerStore) lastFinished(t *testing.T) finishedRun {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.finished) == 0 {
		t.Fatal("no FinishRun calls recorded")
	}
	return f.finished[len(f.finished)-1]
}

type fakeVoice struct {
	mu sync.Mutex

	campaignDraft CampaignDraft
	campaignErr   error
	sequenceDraft SequenceDraft
	sequenceErr   error
	createSeqID   string
	createSeqErr  error

	generateCalls []string // prompts
	briefs        []string
	created       []SequenceDraft
}

func (f *fakeVoice) GenerateCampaignDraft(_ context.Context, _, prompt, _ string) (CampaignDraft, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.generateCalls = append(f.generateCalls, prompt)
	return f.campaignDraft, f.campaignErr
}

func (f *fakeVoice) DraftSequence(_ context.Context, _, brief string) (SequenceDraft, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.briefs = append(f.briefs, brief)
	return f.sequenceDraft, f.sequenceErr
}

func (f *fakeVoice) CreateDraftSequence(_ context.Context, _ string, draft SequenceDraft) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created = append(f.created, draft)
	return f.createSeqID, f.createSeqErr
}

type fakeApprovals struct {
	mu    sync.Mutex
	calls []approvalCall
	id    string
	err   error
}

type approvalCall struct {
	TenantID, ResourceType, ResourceID, ActorLabel string
}

func (f *fakeApprovals) RequestApproval(_ context.Context, tenantID, resourceType, resourceID, actorLabel string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, approvalCall{tenantID, resourceType, resourceID, actorLabel})
	if f.err != nil {
		return "", f.err
	}
	return f.id, nil
}

func campaignRoutine(requireApproval bool) *Routine {
	return &Routine{
		ID:              "rt-1",
		Name:            "weekly re-engagement",
		Prompt:          "draft a re-engagement campaign",
		Kind:            KindDraftCampaign,
		Schedule:        ScheduleWeekly,
		RequireApproval: requireApproval,
		Enabled:         true,
	}
}

// ---- Execute -----------------------------------------------------------

func TestStart_AllowsExactlyOneConcurrentActiveRun(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(false))
	voice := &fakeVoice{}
	rn := &Runner{Store: store, Voice: voice}
	start := make(chan struct{})
	results := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for range 2 {
		go func() {
			ready.Done()
			<-start
			_, err := rn.Start(context.Background(), "tenant-1", "rt-1")
			results <- err
		}()
	}
	ready.Wait()
	close(start)

	succeeded := 0
	conflicted := 0
	for range 2 {
		err := <-results
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrRoutineActive):
			conflicted++
		default:
			t.Fatalf("Start error = %v", err)
		}
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("concurrent starts: succeeded=%d conflicted=%d", succeeded, conflicted)
	}
	voice.mu.Lock()
	defer voice.mu.Unlock()
	if len(voice.generateCalls) != 0 || len(voice.briefs) != 0 {
		t.Fatal("Start conflict performed model work")
	}
}

func TestExecute_CampaignDraft_OpensApproval(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(true))
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "Re-engage", Subject: "We miss you", Body: "<p>hi</p>"}}
	appr := &fakeApprovals{id: "appr-1"}
	rn := &Runner{Store: store, Voice: voice, Approvals: appr}

	runID, err := rn.Start(context.Background(), "tenant-1", "rt-1")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", runID); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	fin := store.lastFinished(t)
	if fin.Status != RunStatusSucceeded {
		t.Fatalf("status = %q, want succeeded (err=%q)", fin.Status, fin.ErrMsg)
	}
	if fin.OutputKind != OutputCampaign || fin.OutputRef != "campaign-1" {
		t.Fatalf("output = (%q, %q), want (campaign, campaign-1)", fin.OutputKind, fin.OutputRef)
	}
	if fin.ApprovalID != "appr-1" {
		t.Fatalf("approval id = %q, want appr-1", fin.ApprovalID)
	}
	if len(appr.calls) != 1 {
		t.Fatalf("approval calls = %d, want 1", len(appr.calls))
	}
	call := appr.calls[0]
	if call.ResourceType != "campaign" || call.ResourceID != "campaign-1" {
		t.Fatalf("approval resource = (%q, %q)", call.ResourceType, call.ResourceID)
	}
	if call.ActorLabel != "agent_routine:weekly re-engagement" {
		t.Fatalf("actor label = %q", call.ActorLabel)
	}
	if len(store.campaigns) != 1 || store.campaigns[0].Subject != "We miss you" {
		t.Fatalf("draft campaign not persisted: %+v", store.campaigns)
	}
}

// TestExecute_CapturesTrustRecord asserts the run persists the honest
// trust fields: the prompt + resolved audience the agent used, the
// model's own rationale, and a draft snapshot of what it produced.
func TestExecute_CapturesTrustRecord(t *testing.T) {
	rt := campaignRoutine(true)
	seg := "seg-9"
	rt.TargetSegmentID = &seg
	store := newFakeRunnerStore(rt)
	voice := &fakeVoice{campaignDraft: CampaignDraft{
		Name: "Re-engage", Subject: "We miss you", Body: "<p>come back</p>",
		PreviewText: "A note for you", Rationale: "Lapsed openers respond to a low-pressure, value-led nudge.",
	}}
	rn := &Runner{Store: store, Voice: voice, Approvals: &fakeApprovals{id: "appr-1"}}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-1"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	fin := store.lastFinished(t)
	if fin.PromptUsed != "draft a re-engagement campaign" {
		t.Fatalf("prompt_used = %q", fin.PromptUsed)
	}
	if !strings.Contains(fin.ContextUsed, "seg-9") {
		t.Fatalf("context_used = %q, want it to mention the target segment", fin.ContextUsed)
	}
	if !strings.Contains(fin.Reasoning, "low-pressure") {
		t.Fatalf("reasoning = %q, want the model rationale", fin.Reasoning)
	}
	// The draft snapshot must be the agent's actual output, captured as JSON.
	if !strings.Contains(fin.DraftPreview, "We miss you") || !strings.Contains(fin.DraftPreview, "\"campaign\"") {
		t.Fatalf("draft_preview = %q, want the campaign snapshot", fin.DraftPreview)
	}
}

func TestExecute_CampaignDraftMarksAIHTML(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(false))
	voice := &fakeVoice{campaignDraft: CampaignDraft{
		Name: "Re-engage", Subject: "We miss you", Body: "<html><body><p>come back</p></body></html>",
	}}
	rn := &Runner{Store: store, Voice: voice}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-1"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(store.campaigns) != 1 {
		t.Fatalf("persisted campaigns = %d, want 1", len(store.campaigns))
	}
	persistedBody := store.campaigns[0].Body
	if !aidisclosure.IsMarkedHTML(persistedBody) {
		t.Fatalf("persisted AI campaign lacks marker: %q", persistedBody)
	}
	if count := strings.Count(persistedBody, aidisclosure.Marker); count != 1 {
		t.Fatalf("persisted marker count = %d, want 1", count)
	}
	preview := store.lastFinished(t).DraftPreview
	if !strings.Contains(preview, aidisclosure.Marker) {
		t.Fatalf("immutable draft preview lacks marker: %q", preview)
	}
}

func TestExecute_CampaignDraftDisclosureIsIdempotent(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(false))
	marked := aidisclosure.MarkHTML("<p>already marked</p>")
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: marked}}
	rn := &Runner{Store: store, Voice: voice}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-1"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if count := strings.Count(store.campaigns[0].Body, aidisclosure.Marker); count != 1 {
		t.Fatalf("persisted marker count = %d, want exactly one", count)
	}
}

// TestExecute_NoRationaleStaysEmpty proves we never fabricate reasoning:
// a model that returns no rationale yields an empty Reasoning field.
func TestExecute_NoRationaleStaysEmpty(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(false))
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: "b"}}
	rn := &Runner{Store: store, Voice: voice, Approvals: &fakeApprovals{}}
	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if fin := store.lastFinished(t); fin.Reasoning != "" {
		t.Fatalf("reasoning = %q, want empty (no fabrication)", fin.Reasoning)
	}
}

func TestExecute_NoApprovalWhenGateOff(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(false))
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: "b"}}
	appr := &fakeApprovals{id: "appr-1"}
	rn := &Runner{Store: store, Voice: voice, Approvals: appr}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(appr.calls) != 0 {
		t.Fatalf("approval calls = %d, want 0 (require_approval=false)", len(appr.calls))
	}
	fin := store.lastFinished(t)
	if fin.Status != RunStatusSucceeded || fin.ApprovalID != "" {
		t.Fatalf("finished = %+v, want succeeded with empty approval id", fin)
	}
}

func TestExecute_VoiceErrorRecordedVerbatim(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(true))
	voice := &fakeVoice{campaignErr: errors.New("voice service 503: model overloaded")}
	rn := &Runner{Store: store, Voice: voice, Approvals: &fakeApprovals{}}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err == nil {
		t.Fatal("Execute should return the failure")
	}
	fin := store.lastFinished(t)
	if fin.Status != RunStatusFailed {
		t.Fatalf("status = %q, want failed", fin.Status)
	}
	if !strings.Contains(fin.ErrMsg, "voice service 503: model overloaded") {
		t.Fatalf("error not recorded verbatim: %q", fin.ErrMsg)
	}
}

func TestExecute_ApprovalRequiredButNotConfigured(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(true))
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: "b"}}
	rn := &Runner{Store: store, Voice: voice, Approvals: nil}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err == nil {
		t.Fatal("Execute should fail when the approval gate cannot open")
	}
	fin := store.lastFinished(t)
	if fin.Status != RunStatusFailed {
		t.Fatalf("status = %q, want failed", fin.Status)
	}
	// The draft already landed — the run must still record its ref.
	if fin.OutputRef != "campaign-1" {
		t.Fatalf("output ref = %q, want campaign-1 (recorded even on gate failure)", fin.OutputRef)
	}
}

func TestExecute_ApprovalErrorFailsRun(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(true))
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "n", Subject: "s", Body: "b"}}
	rn := &Runner{Store: store, Voice: voice, Approvals: &fakeApprovals{err: errors.New("approvals db down")}}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err == nil {
		t.Fatal("Execute should fail when the approval insert fails")
	}
	fin := store.lastFinished(t)
	if fin.Status != RunStatusFailed || !strings.Contains(fin.ErrMsg, "approvals db down") {
		t.Fatalf("finished = %+v", fin)
	}
}

func TestExecute_SequenceDraft(t *testing.T) {
	rt := campaignRoutine(true)
	rt.Kind = KindDraftSequence
	store := newFakeRunnerStore(rt)
	voice := &fakeVoice{
		sequenceDraft: SequenceDraft{
			Name:  "Welcome flow",
			Steps: []SequenceDraftStep{{Subject: "hi", Body: "b", DelayHours: 24, Position: 1}},
		},
		createSeqID: "seq-9",
	}
	appr := &fakeApprovals{id: "appr-2"}
	rn := &Runner{Store: store, Voice: voice, Approvals: appr}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	fin := store.lastFinished(t)
	if fin.OutputKind != OutputSequence || fin.OutputRef != "seq-9" || fin.ApprovalID != "appr-2" {
		t.Fatalf("finished = %+v", fin)
	}
	if len(voice.created) != 1 {
		t.Fatalf("CreateDraftSequence calls = %d, want 1", len(voice.created))
	}
	if appr.calls[0].ResourceType != "sequence" {
		t.Fatalf("approval resource type = %q, want sequence", appr.calls[0].ResourceType)
	}
}

func TestExecute_SequenceNoStepsFails(t *testing.T) {
	rt := campaignRoutine(false)
	rt.Kind = KindDraftSequence
	store := newFakeRunnerStore(rt)
	voice := &fakeVoice{sequenceDraft: SequenceDraft{Name: "empty"}}
	rn := &Runner{Store: store, Voice: voice}

	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err == nil {
		t.Fatal("Execute should fail on an empty sequence draft")
	}
	if fin := store.lastFinished(t); fin.Status != RunStatusFailed {
		t.Fatalf("status = %q, want failed", fin.Status)
	}
}

func TestExecute_VoiceNotConfigured(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(true))
	rn := &Runner{Store: store, Voice: nil}
	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err == nil {
		t.Fatal("Execute should fail without a voice client")
	}
	if fin := store.lastFinished(t); fin.Status != RunStatusFailed {
		t.Fatalf("status = %q, want failed", fin.Status)
	}
}

func TestExecute_AudienceHintsReachThePrompt(t *testing.T) {
	rt := campaignRoutine(false)
	rt.Kind = KindDraftSequence
	seg := "seg-42"
	rt.TargetSegmentID = &seg
	store := newFakeRunnerStore(rt)
	voice := &fakeVoice{
		sequenceDraft: SequenceDraft{Name: "x", Steps: []SequenceDraftStep{{Subject: "s", Body: "b"}}},
		createSeqID:   "seq-1",
	}
	rn := &Runner{Store: store, Voice: voice}
	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(voice.briefs) != 1 || !strings.Contains(voice.briefs[0], "seg-42") {
		t.Fatalf("segment hint missing from brief: %q", voice.briefs)
	}
}

func TestExecute_LegacyTargetListIsInert(t *testing.T) {
	rt := campaignRoutine(false)
	rt.Kind = KindDraftSequence
	legacyListID := "00000000-0000-4000-8000-000000000042"
	rt.TargetListID = &legacyListID
	store := newFakeRunnerStore(rt)
	voice := &fakeVoice{
		sequenceDraft: SequenceDraft{Name: "x", Steps: []SequenceDraftStep{{Subject: "s", Body: "b"}}},
		createSeqID:   "seq-1",
	}
	rn := &Runner{Store: store, Voice: voice}
	if err := rn.Execute(context.Background(), "tenant-1", "rt-1", "run-x"); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(voice.briefs) != 1 || voice.briefs[0] != rt.Prompt {
		t.Fatalf("legacy list leaked into model brief: %q", voice.briefs)
	}
	if fin := store.lastFinished(t); fin.ContextUsed != "" {
		t.Fatalf("legacy list leaked into trust context: %q", fin.ContextUsed)
	}
}

// ---- IsDue --------------------------------------------------------------

func TestIsDue(t *testing.T) {
	now := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	old := now.Add(-25 * time.Hour)
	recent := now.Add(-1 * time.Hour)
	cases := []struct {
		name string
		r    *Routine
		want bool
	}{
		{"nil", nil, false},
		{"disabled", &Routine{Enabled: false, Schedule: ScheduleDaily}, false},
		{"manual never due", &Routine{Enabled: true, Schedule: ScheduleManual}, false},
		{"never ran", &Routine{Enabled: true, Schedule: ScheduleDaily}, true},
		{"daily overdue", &Routine{Enabled: true, Schedule: ScheduleDaily, LastRunAt: &old}, true},
		{"daily fresh", &Routine{Enabled: true, Schedule: ScheduleDaily, LastRunAt: &recent}, false},
		{"weekly fresh", &Routine{Enabled: true, Schedule: ScheduleWeekly, LastRunAt: &old}, false},
	}
	for _, tc := range cases {
		if got := IsDue(tc.r, now); got != tc.want {
			t.Errorf("%s: IsDue = %v, want %v", tc.name, got, tc.want)
		}
	}
}
