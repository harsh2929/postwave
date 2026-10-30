// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeInstapageWorkerStore struct {
	*fakeStore
	targets           []InstapageBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeInstapageWorkerStore) ListInstapageBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]InstapageBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceInstapageBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceInstapageBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: instapageCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestInstapageBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderInstapage
	base.integration.CredentialsRef = "cred_instapage_1"
	base.integration.Settings = map[string]any{"workspace_id": "workspace_123", "page_id": "page_456", "credentials_ref": "cred_instapage_1"}
	store := &fakeInstapageWorkerStore{
		fakeStore: base,
		targets:   []InstapageBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceInstapageBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "instapage://submission/workspace_123/page_456/sub_1", Email: "lead@example.com", FormID: "page_456"}},
		Cursor:      encodeInstapageCursor(instapageCursorState{NextPageToken: "token_2", Since: 1781517600}),
	}}}
	worker := &InstapageBackfillWorker{
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
	if store.listedLimit != instapageBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-instapageBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != instapageCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestInstapageBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderInstapage
	base.integration.Settings = map[string]any{"workspace_id": "workspace_123", "page_id": "page_456", "credentials_ref": "cred_instapage_1"}
	cursor := encodeInstapageCursor(instapageCursorState{NextPageToken: "token_2", Since: 1781517600})
	store := &fakeInstapageWorkerStore{
		fakeStore: base,
		targets:   []InstapageBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceInstapageBackfiller{err: InstapageProviderError{Path: "/v1/workspaces/workspace_123/submissions", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &InstapageBackfillWorker{
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
	retry, ok, decodeErr := decodeInstapageRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.NextPageToken != "token_2" || retry.Since != 1781517600 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
