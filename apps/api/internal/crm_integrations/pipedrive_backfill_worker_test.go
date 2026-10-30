// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakePipedriveWorkerStore struct {
	*fakeStore
	targets           []PipedriveBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakePipedriveWorkerStore) ListPipedriveBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]PipedriveBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit >= 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type sequencePipedriveBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
	onCall       func()
}

func (f *sequencePipedriveBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.onCall != nil {
		f.onCall()
	}
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		return SyncRequest{Cursor: pipedriveCursorComplete}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	return out, nil
}

func TestPipedriveBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 19, 9, 0, 0, 0, time.UTC)
	startCursor := encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-100"})
	store := &fakePipedriveWorkerStore{
		fakeStore: newFakeStore(),
		targets: []PipedriveBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "crm_1",
			Cursor:        startCursor,
		}},
	}
	store.integration.Provider = ProviderPipedrive
	store.integration.Name = "Pipedrive example"
	store.integration.SyncCursor = startCursor
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequencePipedriveBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com", FirstName: "Ada"}},
		Cursor:   encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-200"}),
	}}}
	worker := &PipedriveBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:          store,
		Backfiller:     backfiller,
		Limit:          7,
		DueAfter:       2 * time.Hour,
		MaxPagesPerRun: 3,
		Now:            func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.Completed != 1 || summary.Failed != 0 || summary.ContactsSeen != 1 || summary.ContactsUpserted != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != pipedriveBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	nextCursor := encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-200"})
	if len(backfiller.cursors) != 2 || backfiller.cursors[0] != startCursor || backfiller.cursors[1] != nextCursor || backfiller.tenantIDs[0] != "tenant-1" {
		t.Fatalf("backfill calls tenant=%+v cursors=%+v", backfiller.tenantIDs, backfiller.cursors)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("profiles=%+v", profiles.contacts)
	}
	if len(events.events) != 0 {
		t.Fatalf("events=%+v", events.events)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[0].Status != "completed" || store.runs[1].CursorTo != pipedriveCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestPipedriveBackfillWorkerSkipsManyNotDueRetriesAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	notDue := encodePipedriveRetryCursor(pipedriveRetryState{
		Cursor:        encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: "not-due"}),
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	targets := make([]PipedriveBackfillTarget, 0, 10)
	for i := 0; i < 9; i++ {
		targets = append(targets, PipedriveBackfillTarget{TenantID: "tenant-1", IntegrationID: "crm_1", Cursor: notDue})
	}
	dueCursor := encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "due"})
	targets = append(targets, PipedriveBackfillTarget{TenantID: "tenant-1", IntegrationID: "crm_1", Cursor: dueCursor})
	store := &fakePipedriveWorkerStore{
		fakeStore: newFakeStore(),
		targets:   targets,
	}
	store.integration.Provider = ProviderPipedrive
	backfiller := &sequencePipedriveBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com"}},
		Cursor:   pipedriveCursorComplete,
	}}}
	worker := &PipedriveBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedLimit != pipedriveBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit=%d want over-fetched %d", store.listedLimit, pipedriveBackfillWorkerMaxCandidateScan)
	}
	if summary.Targets != 1 || summary.ContactsSeen != 1 || backfiller.calls == 0 {
		t.Fatalf("summary=%+v calls=%d", summary, backfiller.calls)
	}
	if len(backfiller.cursors) == 0 || backfiller.cursors[0] != dueCursor {
		t.Fatalf("cursors=%+v", backfiller.cursors)
	}
}

func TestPipedriveBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 19, 9, 0, 0, 0, time.UTC)
	startCursor := encodePipedriveCursor(pipedriveCursorState{Object: "deals", Cursor: "deal-cursor-100"})
	providerErr := PipedriveRESTError{Path: "/api/v2/deals", StatusCode: 429, RetryAfter: 45 * time.Second, Snippet: "slow down"}
	store := &fakePipedriveWorkerStore{
		fakeStore: newFakeStore(),
		targets: []PipedriveBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "crm_1",
			Cursor:        startCursor,
		}},
	}
	store.integration.Provider = ProviderPipedrive
	store.integration.SyncCursor = startCursor
	backfiller := &sequencePipedriveBackfiller{err: providerErr}
	worker := &PipedriveBackfillWorker{
		Deps: &Deps{
			Repo: store,
			Now:  func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Failed != 1 || summary.Pages != 0 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	retry, ok, decodeErr := decodePipedriveRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != startCursor || retry.Object != "deals" || retry.ProviderCursor != "deal-cursor-100" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
	if retry.NextAttemptAt != now.Add(45*time.Second).Format(time.RFC3339) || !strings.Contains(retry.LastError, "429") {
		t.Fatalf("retry=%+v", retry)
	}
	var restErr PipedriveRESTError
	if !errors.As(backfiller.err, &restErr) {
		t.Fatalf("stored err=%T %v", backfiller.err, backfiller.err)
	}
}

func TestPipedriveBulkBackfillRunnerSkipsSinkWritesAfterDisconnectDuringProviderCall(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.SyncCursor = encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-100"})
	profiles := &fakeProfileSink{}
	backfiller := &sequencePipedriveBackfiller{
		pages: []SyncRequest{{
			Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com"}},
			Cursor:   pipedriveCursorComplete,
		}},
		onCall: func() {
			store.integration.Status = "disconnected"
		},
	}
	runner := PipedriveBulkBackfillRunner{
		Deps: &Deps{
			Repo:     store,
			Profiles: profiles,
			Events:   &fakeEventSink{},
		},
		Backfiller: backfiller,
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "crm_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles.contacts) != 0 || len(store.runs) != 0 {
		t.Fatalf("contacts=%+v runs=%+v summary=%+v", profiles.contacts, store.runs, summary)
	}
}

func TestPipedriveBulkBackfillRunnerStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	startCursor := encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-100"})
	store := newFakeStore()
	store.integration.Provider = ProviderPipedrive
	store.integration.SyncCursor = startCursor
	backfiller := &sequencePipedriveBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "pipedrive://person/123", Email: "Buyer@Example.com"}},
		Cursor:   encodePipedriveCursor(pipedriveCursorState{Object: "persons", Cursor: "cursor-200"}),
	}}}
	runner := PipedriveBulkBackfillRunner{
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{err: errors.New("profile sink down")},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "crm_1", startCursor)
	if err == nil || !strings.Contains(err.Error(), "profile sink down") {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodePipedriveRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != startCursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
