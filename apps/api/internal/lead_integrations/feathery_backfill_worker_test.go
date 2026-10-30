// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeFeatheryWorkerStore struct {
	*fakeStore
	targets           []FeatheryBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeFeatheryWorkerStore) ListFeatheryBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]FeatheryBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceFeatheryBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceFeatheryBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: featheryCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestFeatheryBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFeathery
	base.integration.CredentialsRef = "cred_feathery_1"
	base.integration.Settings = map[string]any{"form_id": "form_456", "credentials_ref": "cred_feathery_1"}
	store := &fakeFeatheryWorkerStore{
		fakeStore: base,
		targets:   []FeatheryBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceFeatheryBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "feathery://submission/form_456/user_123", Email: "lead@example.com", FormID: "form_456"}},
		Cursor:      encodeFeatheryCursor(featheryCursorState{Since: "2026-06-18T12:00:00Z"}),
	}}}
	worker := &FeatheryBackfillWorker{
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
	if store.listedLimit != featheryBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-featheryBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != featheryCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFeatheryBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFeathery
	base.integration.Settings = map[string]any{"form_id": "form_456", "credentials_ref": "cred_feathery_1"}
	cursor := encodeFeatheryCursor(featheryCursorState{NextURL: "https://api.feathery.io/api/form/submission/?page=100", Since: "2026-06-01T00:00:00Z"})
	store := &fakeFeatheryWorkerStore{
		fakeStore: base,
		targets:   []FeatheryBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceFeatheryBackfiller{err: FeatheryProviderError{Path: "/api/form/submission/", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &FeatheryBackfillWorker{
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
	retry, ok, decodeErr := decodeFeatheryRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.NextURL != "https://api.feathery.io/api/form/submission/?page=100" || retry.Since != "2026-06-01T00:00:00Z" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
