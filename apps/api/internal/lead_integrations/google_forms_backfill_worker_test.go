// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeGoogleFormsWorkerStore struct {
	*fakeStore
	targets           []GoogleFormsBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeGoogleFormsWorkerStore) ListGoogleFormsBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]GoogleFormsBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceGoogleFormsBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceGoogleFormsBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: encodeGoogleFormsCursor(googleFormsCursorState{Since: "2026-06-18T12:00:00Z"})}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestGoogleFormsBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGoogleForms
	base.integration.CredentialsRef = "cred_google_forms_1"
	base.integration.Settings = map[string]any{"form_id": "form123", "credentials_ref": "cred_google_forms_1"}
	store := &fakeGoogleFormsWorkerStore{
		fakeStore: base,
		targets:   []GoogleFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceGoogleFormsBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "google-forms://response/form123/resp_1", Email: "lead@example.com", FormID: "form123"}},
		Cursor:      encodeGoogleFormsCursor(googleFormsCursorState{Since: "2026-06-18T12:00:00Z"}),
	}}}
	worker := &GoogleFormsBackfillWorker{
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
	if store.listedLimit != googleFormsBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-googleFormsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestGoogleFormsBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGoogleForms
	base.integration.Settings = map[string]any{"form_id": "form123", "credentials_ref": "cred_google_forms_1"}
	cursor := encodeGoogleFormsCursor(googleFormsCursorState{PageToken: "page_100", Since: "2026-06-01T00:00:00Z"})
	store := &fakeGoogleFormsWorkerStore{
		fakeStore: base,
		targets:   []GoogleFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceGoogleFormsBackfiller{err: GoogleFormsProviderError{Path: "/v1/forms/form123/responses", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &GoogleFormsBackfillWorker{
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
	retry, ok, decodeErr := decodeGoogleFormsRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.PageToken != "page_100" || retry.Since != "2026-06-01T00:00:00Z" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
