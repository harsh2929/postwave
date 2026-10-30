// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeTypeformWorkerStore struct {
	*fakeStore
	targets           []TypeformBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeTypeformWorkerStore) ListTypeformBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]TypeformBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceTypeformBackfiller struct {
	pages  []SyncRequest
	err    error
	cursor string
	called bool
}

func (f *sequenceTypeformBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.cursor = cursor
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: typeformCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestTypeformBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	store := &fakeTypeformWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []TypeformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceTypeformBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "typeform://response/abc123/resp_1", Email: "lead@example.com", FormID: "abc123"}},
		Cursor:      encodeTypeformCursor("resp_1"),
	}}}
	worker := &TypeformBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.SubmissionsSeen != 1 || summary.SubscribersUpserted != 1 || summary.EventsTracked != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != typeformBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-typeformBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestTypeformBackfillWorkerStoresRateLimitRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	store := &fakeTypeformWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []TypeformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: encodeTypeformCursor("resp_1")}},
	}
	backfiller := &sequenceTypeformBackfiller{err: TypeformRateLimitError{Path: "/forms/abc123/responses", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &TypeformBackfillWorker{
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
	if summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	retry, ok, decodeErr := decodeTypeformRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.After != "resp_1" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var rateLimit TypeformRateLimitError
	if !errors.As(backfiller.err, &rateLimit) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestTypeformBackfillWorkerPreservesDueRetryAttemptsOnFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	cursor := encodeTypeformCursor("resp_1")
	retryCursor := encodeTypeformRetryCursor(typeformRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeTypeformWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []TypeformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: retryCursor}},
	}
	backfiller := &sequenceTypeformBackfiller{err: TypeformRateLimitError{Path: "/forms/abc123/responses", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down again"}}
	worker := &TypeformBackfillWorker{
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
	if summary.Failed != 1 || len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("summary=%+v runs=%+v", summary, store.runs)
	}
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	retry, ok, decodeErr := decodeTypeformRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.After != "resp_1" || retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
