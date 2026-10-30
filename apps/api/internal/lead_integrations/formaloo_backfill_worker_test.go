// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeFormalooWorkerStore struct {
	*fakeStore
	targets           []FormalooBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeFormalooWorkerStore) ListFormalooBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]FormalooBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceFormalooBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceFormalooBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: encodeFormalooCursor(formalooCursorState{LastSlug: "row_1", LastSubmittedAt: "2026-07-03T12:00:00Z"})}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestFormalooBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFormaloo
	base.integration.CredentialsRef = "cred_formaloo_1"
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_formaloo_1"}
	store := &fakeFormalooWorkerStore{
		fakeStore: base,
		targets:   []FormalooBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceFormalooBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "formaloo://row/form_123/row_1", Email: "lead@example.com", FormID: "form_123"}},
		Cursor:      encodeFormalooCursor(formalooCursorState{LastSlug: "row_1", LastSubmittedAt: "2026-07-03T12:00:00Z"}),
	}}}
	worker := &FormalooBackfillWorker{
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
	if store.listedLimit != formalooBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-formalooBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFormalooBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFormaloo
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_formaloo_1"}
	cursor := encodeFormalooCursor(formalooCursorState{FormSlug: "form_123", Page: 2, LastSlug: "row_1", LastSubmittedAt: "2026-07-02T12:00:00Z"})
	store := &fakeFormalooWorkerStore{
		fakeStore: base,
		targets:   []FormalooBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceFormalooBackfiller{err: FormalooProviderError{Path: "/v3.0/forms/form_123/rows/", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &FormalooBackfillWorker{
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
	retry, ok, decodeErr := decodeFormalooRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Page != 2 || retry.LastSlug != "row_1" || retry.LastSubmittedAt != "2026-07-02T12:00:00Z" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
