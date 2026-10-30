// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeFilloutWorkerStore struct {
	*fakeStore
	targets           []FilloutBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeFilloutWorkerStore) ListFilloutBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]FilloutBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceFilloutBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceFilloutBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: filloutCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestFilloutBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFillout
	base.integration.CredentialsRef = "cred_fillout_1"
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_fillout_1"}
	store := &fakeFilloutWorkerStore{
		fakeStore: base,
		targets:   []FilloutBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceFilloutBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "fillout://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
		Cursor:      encodeFilloutCursor(filloutCursorState{Offset: 1}),
	}}}
	worker := &FilloutBackfillWorker{
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
	if store.listedLimit != filloutBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-filloutBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != filloutCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFilloutBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFillout
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_fillout_1"}
	cursor := encodeFilloutCursor(filloutCursorState{Offset: 100})
	store := &fakeFilloutWorkerStore{
		fakeStore: base,
		targets:   []FilloutBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceFilloutBackfiller{err: errors.New("fillout 429: slow down")}
	worker := &FilloutBackfillWorker{
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
	retry, ok, decodeErr := decodeFilloutRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Offset != 100 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(filloutRetryInitialDelay).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
