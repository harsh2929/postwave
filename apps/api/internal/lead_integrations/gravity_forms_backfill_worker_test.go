// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeGravityFormsWorkerStore struct {
	*fakeStore
	targets           []GravityFormsBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeGravityFormsWorkerStore) ListGravityFormsBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]GravityFormsBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceGravityFormsBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceGravityFormsBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: encodeGravityFormsCursor(gravityFormsCursorState{Offset: 1, TotalCount: 1})}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestGravityFormsBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGravityForms
	base.integration.CredentialsRef = "cred_gravity_1"
	base.integration.Settings = map[string]any{"site_url": "https://example.com", "form_id": "123", "credentials_ref": "cred_gravity_1"}
	store := &fakeGravityFormsWorkerStore{
		fakeStore: base,
		targets:   []GravityFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceGravityFormsBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "gravity-forms://entry/example.com/123/entry_1", Email: "lead@example.com", FormID: "123"}},
		Cursor:      encodeGravityFormsCursor(gravityFormsCursorState{Offset: 1, TotalCount: 1}),
	}}}
	worker := &GravityFormsBackfillWorker{
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
	if store.listedLimit != gravityFormsBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-gravityFormsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestGravityFormsBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGravityForms
	base.integration.Settings = map[string]any{"site_url": "https://example.com", "form_id": "123", "credentials_ref": "cred_gravity_1"}
	cursor := encodeGravityFormsCursor(gravityFormsCursorState{Offset: 100, TotalCount: 200})
	store := &fakeGravityFormsWorkerStore{
		fakeStore: base,
		targets:   []GravityFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceGravityFormsBackfiller{err: GravityFormsProviderError{Path: "/wp-json/gf/v2/forms/123/entries", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &GravityFormsBackfillWorker{
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
	retry, ok, decodeErr := decodeGravityFormsRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Offset != 100 || retry.TotalCount != 200 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
