// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeFormstackWorkerStore struct {
	*fakeStore
	targets           []FormstackBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeFormstackWorkerStore) ListFormstackBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]FormstackBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceFormstackBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceFormstackBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: formstackCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestFormstackBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFormstack
	base.integration.CredentialsRef = "cred_formstack_1"
	base.integration.Settings = map[string]any{"form_id": "123", "credentials_ref": "cred_formstack_1"}
	store := &fakeFormstackWorkerStore{
		fakeStore: base,
		targets:   []FormstackBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceFormstackBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "formstack://submission/123/sub_1", Email: "lead@example.com", FormID: "123"}},
		Cursor:      encodeFormstackCursor(formstackCursorState{Page: 2}),
	}}}
	worker := &FormstackBackfillWorker{
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
	if store.listedLimit != formstackBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-formstackBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != formstackCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFormstackBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFormstack
	base.integration.Settings = map[string]any{"form_id": "123", "credentials_ref": "cred_formstack_1"}
	cursor := encodeFormstackCursor(formstackCursorState{Page: 100})
	store := &fakeFormstackWorkerStore{
		fakeStore: base,
		targets:   []FormstackBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceFormstackBackfiller{err: FormstackProviderError{Path: "/forms/123/submissions", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &FormstackBackfillWorker{
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
	retry, ok, decodeErr := decodeFormstackRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Page != 100 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
