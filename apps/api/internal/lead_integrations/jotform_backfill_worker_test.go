// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeJotformWorkerStore struct {
	*fakeStore
	targets           []JotformBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeJotformWorkerStore) ListJotformBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]JotformBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceJotformBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceJotformBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: jotformCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestJotformBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderJotform
	base.integration.CredentialsRef = "cred_jotform_1"
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_jotform_1"}
	store := &fakeJotformWorkerStore{
		fakeStore: base,
		targets:   []JotformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceJotformBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "jotform://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
		Cursor:      encodeJotformCursor(jotformCursorState{Offset: 1}),
	}}}
	worker := &JotformBackfillWorker{
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
	if store.listedLimit != jotformBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-jotformBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != jotformCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestJotformBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderJotform
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_jotform_1"}
	cursor := encodeJotformCursor(jotformCursorState{Offset: 100})
	store := &fakeJotformWorkerStore{
		fakeStore: base,
		targets:   []JotformBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceJotformBackfiller{err: errors.New("jotform 429: slow down")}
	worker := &JotformBackfillWorker{
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
	retry, ok, decodeErr := decodeJotformRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Offset != 100 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(jotformRetryInitialDelay).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
