// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeWPFormsWorkerStore struct {
	*fakeStore
	targets           []WPFormsBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeWPFormsWorkerStore) ListWPFormsBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]WPFormsBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceWPFormsBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceWPFormsBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: encodeWPFormsCursor(wpformsCursorState{Page: 2, TotalPages: 1, TotalCount: 1})}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestWPFormsBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderWPForms
	base.integration.CredentialsRef = "cred_gravity_1"
	base.integration.Settings = map[string]any{"site_url": "https://example.com", "form_id": "123", "credentials_ref": "cred_gravity_1"}
	store := &fakeWPFormsWorkerStore{
		fakeStore: base,
		targets:   []WPFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceWPFormsBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "wpforms://entry/example.com/123/entry_1", Email: "lead@example.com", FormID: "123"}},
		Cursor:      encodeWPFormsCursor(wpformsCursorState{Page: 2, TotalPages: 1, TotalCount: 1}),
	}}}
	worker := &WPFormsBackfillWorker{
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
	if store.listedLimit != wpformsBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-wpformsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestWPFormsBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderWPForms
	base.integration.Settings = map[string]any{"site_url": "https://example.com", "form_id": "123", "credentials_ref": "cred_gravity_1"}
	cursor := encodeWPFormsCursor(wpformsCursorState{Page: 2, TotalPages: 4, TotalCount: 200})
	store := &fakeWPFormsWorkerStore{
		fakeStore: base,
		targets:   []WPFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceWPFormsBackfiller{err: WPFormsProviderError{Path: "/wp-json/wp-abilities/v1/abilities/wpforms/search-entries/run", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &WPFormsBackfillWorker{
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
	retry, ok, decodeErr := decodeWPFormsRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Page != 2 || retry.TotalPages != 4 || retry.TotalCount != 200 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
