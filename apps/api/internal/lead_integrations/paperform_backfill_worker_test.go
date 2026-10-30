// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakePaperformWorkerStore struct {
	*fakeStore
	targets           []PaperformBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakePaperformWorkerStore) ListPaperformBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]PaperformBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequencePaperformBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequencePaperformBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: paperformCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestPaperformBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderPaperform
	base.integration.CredentialsRef = "cred_paperform_1"
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_paperform_1"}
	store := &fakePaperformWorkerStore{
		fakeStore: base,
		targets:   []PaperformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequencePaperformBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "paperform://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
		Cursor:      encodePaperformCursor(paperformCursorState{Skip: 1}),
	}}}
	worker := &PaperformBackfillWorker{
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
	if store.listedLimit != paperformBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-paperformBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != paperformCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestPaperformBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderPaperform
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_paperform_1"}
	cursor := encodePaperformCursor(paperformCursorState{Skip: 100})
	store := &fakePaperformWorkerStore{
		fakeStore: base,
		targets:   []PaperformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequencePaperformBackfiller{err: PaperformProviderError{Path: "/forms/form_123/submissions", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &PaperformBackfillWorker{
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
	retry, ok, decodeErr := decodePaperformRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Skip != 100 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
