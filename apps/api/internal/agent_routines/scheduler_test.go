// SPDX-License-Identifier: AGPL-3.0-only
package agent_routines

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeRoutineClaimer struct {
	due      []DueRoutine
	claimErr error
	staleErr error
	onClaim  func()

	mu          sync.Mutex
	claimCalls  int
	dueIndex    int
	staleCalls  int
	staleCutoff time.Time
}

func (f *fakeRoutineClaimer) ClaimDue(_ context.Context, limit int) ([]DueRoutine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claimCalls++
	if f.onClaim != nil {
		f.onClaim()
	}
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if f.dueIndex >= len(f.due) || limit <= 0 {
		return []DueRoutine{}, nil
	}
	end := f.dueIndex + limit
	if end > len(f.due) {
		end = len(f.due)
	}
	claimed := append([]DueRoutine(nil), f.due[f.dueIndex:end]...)
	f.dueIndex = end
	return claimed, nil
}

func (f *fakeRoutineClaimer) FailStaleRuns(_ context.Context, cutoff time.Time, _ int) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.staleCalls++
	f.staleCutoff = cutoff
	return 0, f.staleErr
}

// TestScheduler_TickExecutesDueRoutines drives one tick with fake voice
// + approvals deps and asserts each due routine produced a finished,
// approval-gated run.
func TestScheduler_TickExecutesDueRoutines(t *testing.T) {
	rtA := campaignRoutine(true)
	rtA.ID = "rt-a"
	rtB := campaignRoutine(true)
	rtB.ID = "rt-b"
	rtB.Name = "monthly digest"
	store := newFakeRunnerStore(rtA, rtB)
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "d", Subject: "s", Body: "b"}}
	appr := &fakeApprovals{id: "appr-1"}
	s := &Scheduler{
		Repo: &fakeRoutineClaimer{due: []DueRoutine{
			{RoutineID: "rt-a", TenantID: "tenant-1", RunID: "run-a"},
			{RoutineID: "rt-b", TenantID: "tenant-2", RunID: "run-b"},
		}},
		Runner: &Runner{Store: store, Voice: voice, Approvals: appr},
	}

	s.tick(context.Background())

	if len(store.insertedRuns) != 0 {
		t.Fatalf("scheduler called Start and inserted %d duplicate receipts", len(store.insertedRuns))
	}
	if len(store.finished) != 2 {
		t.Fatalf("finished runs = %d, want 2", len(store.finished))
	}
	for _, fin := range store.finished {
		if fin.Status != RunStatusSucceeded {
			t.Fatalf("run %s status = %q (err=%q), want succeeded", fin.RunID, fin.Status, fin.ErrMsg)
		}
		if fin.ApprovalID != "appr-1" {
			t.Fatalf("run %s approval id = %q, want appr-1", fin.RunID, fin.ApprovalID)
		}
	}
	// Tenant binding: each run executed under its own tenant.
	tenants := map[string]bool{}
	for _, c := range appr.calls {
		tenants[c.TenantID] = true
	}
	if !tenants["tenant-1"] || !tenants["tenant-2"] {
		t.Fatalf("approvals not opened per-tenant: %+v", appr.calls)
	}
}

// TestScheduler_TickContinuesPastFailures: one bad routine must not
// stop the rest of the tick.
func TestScheduler_TickContinuesPastFailures(t *testing.T) {
	rtOK := campaignRoutine(false)
	rtOK.ID = "rt-ok"
	store := newFakeRunnerStore(rtOK) // rt-missing is absent → Start fails
	voice := &fakeVoice{campaignDraft: CampaignDraft{Name: "d", Subject: "s", Body: "b"}}
	s := &Scheduler{
		Repo: &fakeRoutineClaimer{due: []DueRoutine{
			{RoutineID: "rt-missing", TenantID: "tenant-1", RunID: "run-missing"},
			{RoutineID: "rt-ok", TenantID: "tenant-1", RunID: "run-ok"},
		}},
		Runner: &Runner{Store: store, Voice: voice},
	}

	s.tick(context.Background())

	if len(store.finished) != 2 || store.finished[0].Status != RunStatusFailed ||
		store.finished[1].Status != RunStatusSucceeded {
		t.Fatalf("finished = %+v, want missing failure followed by rt-ok success", store.finished)
	}
}

// TestScheduler_ClaimErrorIsNonFatal: a failed claim logs and returns.
func TestScheduler_ClaimErrorIsNonFatal(t *testing.T) {
	s := &Scheduler{
		Repo:   &fakeRoutineClaimer{claimErr: errors.New("db down")},
		Runner: &Runner{Store: newFakeRunnerStore(), Voice: &fakeVoice{}},
	}
	s.tick(context.Background()) // must not panic
}

// TestScheduler_RunNilGuards: a half-configured scheduler exits cleanly.
func TestScheduler_RunNilGuards(t *testing.T) {
	if err := (&Scheduler{}).Run(context.Background()); err != nil {
		t.Fatalf("nil-guard Run returned %v", err)
	}
	var s *Scheduler
	if err := s.Run(context.Background()); err != nil {
		t.Fatalf("nil receiver Run returned %v", err)
	}
}

func TestScheduler_RunReconcilesImmediatelyAtStartup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	claimer := &fakeRoutineClaimer{onClaim: cancel}
	s := &Scheduler{
		Repo:   claimer,
		Runner: &Runner{Store: newFakeRunnerStore(), Voice: &fakeVoice{}},
	}
	if err := s.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run error=%v, want context.Canceled", err)
	}
	claimer.mu.Lock()
	defer claimer.mu.Unlock()
	if claimer.staleCalls != 1 || claimer.claimCalls != 1 {
		t.Fatalf("startup stale calls=%d claim calls=%d, want 1 each", claimer.staleCalls, claimer.claimCalls)
	}
}

// TestScheduler_TickStopsOnCancel: a cancelled ctx stops mid-batch.
func TestScheduler_TickStopsOnCancel(t *testing.T) {
	store := newFakeRunnerStore(campaignRoutine(false))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := &Scheduler{
		Repo: &fakeRoutineClaimer{due: []DueRoutine{{
			RoutineID: "rt-1", TenantID: "tenant-1", RunID: "run-1",
		}}},
		Runner: &Runner{Store: store, Voice: &fakeVoice{}},
	}
	s.tick(ctx)
	if len(store.insertedRuns) != 0 {
		t.Fatalf("inserted runs = %d, want 0 after cancel", len(store.insertedRuns))
	}
}

func TestScheduler_TickReconcilesStaleRunsBeforeClaim(t *testing.T) {
	claimer := &fakeRoutineClaimer{}
	before := time.Now().UTC()
	s := &Scheduler{
		Repo:   claimer,
		Runner: &Runner{Store: newFakeRunnerStore(), Voice: &fakeVoice{}},
	}
	s.tick(context.Background())
	after := time.Now().UTC()

	claimer.mu.Lock()
	defer claimer.mu.Unlock()
	if claimer.staleCalls != 1 || claimer.claimCalls != 1 {
		t.Fatalf("stale calls=%d claim calls=%d, want 1 each", claimer.staleCalls, claimer.claimCalls)
	}
	wantEarliest := before.Add(-schedulerStaleRunAfter)
	wantLatest := after.Add(-schedulerStaleRunAfter)
	if claimer.staleCutoff.Before(wantEarliest) || claimer.staleCutoff.After(wantLatest) {
		t.Fatalf("stale cutoff=%s, want within [%s,%s]", claimer.staleCutoff, wantEarliest, wantLatest)
	}
}

type panicOnceVoice struct {
	mu      sync.Mutex
	paniced bool
}

func (v *panicOnceVoice) GenerateCampaignDraft(context.Context, string, string, string) (CampaignDraft, error) {
	v.mu.Lock()
	shouldPanic := !v.paniced
	v.paniced = true
	v.mu.Unlock()
	if shouldPanic {
		panic("provider payload must not reach receipt")
	}
	return CampaignDraft{Name: "safe", Subject: "safe", Body: "safe"}, nil
}

func (*panicOnceVoice) DraftSequence(context.Context, string, string) (SequenceDraft, error) {
	return SequenceDraft{}, errors.New("unexpected sequence call")
}

func (*panicOnceVoice) CreateDraftSequence(context.Context, string, SequenceDraft) (string, error) {
	return "", errors.New("unexpected sequence call")
}

func TestScheduler_TickPanicFinalizesAndContinues(t *testing.T) {
	rtA := campaignRoutine(false)
	rtA.ID = "rt-a"
	rtB := campaignRoutine(false)
	rtB.ID = "rt-b"
	store := newFakeRunnerStore(rtA, rtB)
	s := &Scheduler{
		Repo: &fakeRoutineClaimer{due: []DueRoutine{
			{RoutineID: "rt-a", TenantID: "tenant-1", RunID: "run-a"},
			{RoutineID: "rt-b", TenantID: "tenant-1", RunID: "run-b"},
		}},
		Runner: &Runner{Store: store, Voice: &panicOnceVoice{}},
	}

	s.tick(context.Background())

	if len(store.finished) != 2 {
		t.Fatalf("finished=%+v, want panic failure and following success", store.finished)
	}
	if store.finished[0].Status != RunStatusFailed ||
		store.finished[0].ErrMsg != unexpectedExecutionError {
		t.Fatalf("panic receipt=%+v", store.finished[0])
	}
	if store.finished[1].Status != RunStatusSucceeded {
		t.Fatalf("second receipt=%+v, want succeeded", store.finished[1])
	}
}
