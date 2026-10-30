// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeUnbounceWorkerStore struct {
	*fakeStore
	targets           []UnbounceBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeUnbounceWorkerStore) ListUnbounceBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]UnbounceBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceUnbounceBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceUnbounceBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: unbounceCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestUnbounceBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderUnbounce
	base.integration.CredentialsRef = "cred_unbounce_1"
	base.integration.Settings = map[string]any{"page_id": "page_123", "credentials_ref": "cred_unbounce_1"}
	store := &fakeUnbounceWorkerStore{
		fakeStore: base,
		targets:   []UnbounceBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceUnbounceBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "unbounce://lead/page_123/lead_1", Email: "lead@example.com", FormID: "page_123"}},
		Cursor:      encodeUnbounceCursor(unbounceCursorState{Offset: 1, Since: "2026-06-16T10:00:00.000Z"}),
	}}}
	worker := &UnbounceBackfillWorker{
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
	if store.listedLimit != unbounceBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-unbounceBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != unbounceCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestUnbounceBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderUnbounce
	base.integration.Settings = map[string]any{"page_id": "page_123", "credentials_ref": "cred_unbounce_1"}
	cursor := encodeUnbounceCursor(unbounceCursorState{Offset: 100, Since: "2026-06-16T10:00:00.000Z"})
	store := &fakeUnbounceWorkerStore{
		fakeStore: base,
		targets:   []UnbounceBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceUnbounceBackfiller{err: UnbounceProviderError{Path: "/pages/page_123/leads", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &UnbounceBackfillWorker{
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
	retry, ok, decodeErr := decodeUnbounceRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Offset != 100 || retry.Since != "2026-06-16T10:00:00.000Z" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
