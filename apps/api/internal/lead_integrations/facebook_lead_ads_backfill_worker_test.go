// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type fakeFacebookLeadAdsWorkerStore struct {
	*fakeStore
	targets           []FacebookLeadAdsBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeFacebookLeadAdsWorkerStore) ListFacebookLeadAdsBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]FacebookLeadAdsBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceFacebookLeadAdsBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceFacebookLeadAdsBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: facebookLeadAdsCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestFacebookLeadAdsBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFacebookLeadAds
	base.integration.CredentialsRef = "cred_meta_leads_1"
	base.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	store := &fakeFacebookLeadAdsWorkerStore{
		fakeStore: base,
		targets:   []FacebookLeadAdsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceFacebookLeadAdsBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "facebook-lead-ads://lead/lead_1", Email: "lead@example.com", FormID: "form_456"}},
		Cursor:      encodeFacebookLeadAdsCursor("after_2"),
	}}}
	worker := &FacebookLeadAdsBackfillWorker{
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
	if store.listedLimit != facebookLeadAdsBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-facebookLeadAdsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != facebookLeadAdsCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestFacebookLeadAdsBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderFacebookLeadAds
	base.integration.Settings = map[string]any{"page_id": "page_123", "form_id": "form_456", "credentials_ref": "cred_meta_leads_1"}
	cursor := encodeFacebookLeadAdsCursor("after_1")
	store := &fakeFacebookLeadAdsWorkerStore{
		fakeStore: base,
		targets:   []FacebookLeadAdsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceFacebookLeadAdsBackfiller{err: FacebookLeadAdsProviderError{Path: "/v25.0/form_456/leads", StatusCode: 429, RetryAfter: 4 * time.Minute, Snippet: "slow down"}}
	worker := &FacebookLeadAdsBackfillWorker{
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
	retry, ok, decodeErr := decodeFacebookLeadAdsRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.After != "after_1" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(4*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr FacebookLeadAdsProviderError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestFacebookLeadAdsRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := facebookLeadAdsBackfillRetryCursor("", "BACKFILL_FAILED", FacebookLeadAdsProviderError{StatusCode: 500}, now)
	retry, ok, err := decodeFacebookLeadAdsRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.After != "" {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
	if retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
}
