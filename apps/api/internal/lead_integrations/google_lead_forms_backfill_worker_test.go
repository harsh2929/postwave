// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeGoogleLeadFormsWorkerStore struct {
	*fakeStore
	targets           []GoogleLeadFormsBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeGoogleLeadFormsWorkerStore) ListGoogleLeadFormsBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]GoogleLeadFormsBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceGoogleLeadFormsBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceGoogleLeadFormsBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: googleLeadFormsCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestGoogleLeadFormsBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGoogleLeadForms
	base.integration.CredentialsRef = "cred_google_leads_1"
	base.integration.Settings = map[string]any{"customer_id": "1234567890", "lead_form_asset_id": "111", "credentials_ref": "cred_google_leads_1"}
	store := &fakeGoogleLeadFormsWorkerStore{
		fakeStore: base,
		targets:   []GoogleLeadFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceGoogleLeadFormsBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "google-lead-form-extensions://lead/lead_1", Email: "lead@example.com", FormID: "111"}},
		Cursor:      encodeGoogleLeadFormsWatermarkCursor("2026-06-28 09:00:00+05:30", "lead_1"),
	}}}
	worker := &GoogleLeadFormsBackfillWorker{
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
	if store.listedLimit != googleLeadFormsBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-googleLeadFormsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != googleLeadFormsCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestGoogleLeadFormsBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderGoogleLeadForms
	base.integration.Settings = map[string]any{"customer_id": "1234567890", "lead_form_asset_id": "111", "credentials_ref": "cred_google_leads_1"}
	cursor := encodeGoogleLeadFormsWatermarkCursor("2026-06-28 09:00:00+05:30", "lead_0")
	store := &fakeGoogleLeadFormsWorkerStore{
		fakeStore: base,
		targets:   []GoogleLeadFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceGoogleLeadFormsBackfiller{err: GoogleLeadFormsProviderError{Path: "/v24/customers/1234567890/googleAds:search", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &GoogleLeadFormsBackfillWorker{
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
	retry, ok, decodeErr := decodeGoogleLeadFormsRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.LastSubmissionTime != "2026-06-28 09:00:00+05:30" || retry.LastID != "lead_0" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr GoogleLeadFormsProviderError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestGoogleLeadFormsRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := googleLeadFormsBackfillRetryCursor("", "BACKFILL_FAILED", GoogleLeadFormsProviderError{StatusCode: 500}, now)
	retry, ok, err := decodeGoogleLeadFormsRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.PageToken != "" || retry.LastSubmissionTime != "" || retry.LastID != "" {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
	if retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
}
