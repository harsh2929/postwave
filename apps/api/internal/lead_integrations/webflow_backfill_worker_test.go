// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"net/http"
	"testing"
	"time"
)

type fakeWebflowWorkerStore struct {
	*fakeStore
	targets           []WebflowBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeWebflowWorkerStore) ListWebflowBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]WebflowBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceWebflowBackfiller struct {
	pages  []SyncRequest
	err    error
	cursor string
	called bool
}

func (f *sequenceWebflowBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.called = true
	f.cursor = cursor
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: webflowCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestWebflowBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderWebflow
	base.integration.CredentialsRef = "cred_webflow_1"
	base.integration.Settings = map[string]any{"site_id": "site_123", "credentials_ref": "cred_webflow_1"}
	store := &fakeWebflowWorkerStore{
		fakeStore: base,
		targets:   []WebflowBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceWebflowBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "webflow://submission/site_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
		Cursor:      encodeWebflowCursor(webflowCursorState{Offset: 1}),
	}}}
	worker := &WebflowBackfillWorker{
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
	if store.listedLimit != webflowBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-webflowBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != webflowCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestWebflowBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderWebflow
	base.integration.Settings = map[string]any{"site_id": "site_123", "credentials_ref": "cred_webflow_1"}
	cursor := encodeWebflowCursor(webflowCursorState{Offset: 100})
	store := &fakeWebflowWorkerStore{
		fakeStore: base,
		targets:   []WebflowBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceWebflowBackfiller{err: webflowHTTPStatusError{Path: "/v2/sites/site_123/form_submissions", StatusCode: http.StatusTooManyRequests, RetryAfter: 3 * time.Minute, Body: "slow down"}}
	worker := &WebflowBackfillWorker{
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
	retry, ok, decodeErr := decodeWebflowRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Offset != 100 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestWebflowBackfillWorkerPreservesDueRetryAttemptsOnFailure(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderWebflow
	base.integration.Settings = map[string]any{"site_id": "site_123", "credentials_ref": "cred_webflow_1"}
	cursor := encodeWebflowCursor(webflowCursorState{Offset: 100})
	retryCursor := encodeWebflowRetryCursor(webflowRetryState{
		Cursor:        cursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := &fakeWebflowWorkerStore{
		fakeStore: base,
		targets:   []WebflowBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: retryCursor}},
	}
	backfiller := &sequenceWebflowBackfiller{err: webflowHTTPStatusError{Path: "/v2/sites/site_123/form_submissions", StatusCode: http.StatusTooManyRequests, RetryAfter: 3 * time.Minute, Body: "slow down again"}}
	worker := &WebflowBackfillWorker{
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
	if !backfiller.called || backfiller.cursor != cursor {
		t.Fatalf("backfiller called=%v cursor=%q want %q", backfiller.called, backfiller.cursor, cursor)
	}
	retry, ok, decodeErr := decodeWebflowRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Offset != 100 || retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
