// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeLeadpagesWorkerStore struct {
	*fakeStore
	targets           []LeadpagesBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeLeadpagesWorkerStore) ListLeadpagesBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]LeadpagesBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceLeadpagesBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceLeadpagesBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: encodeLeadpagesCursor(leadpagesCursorState{LastSubmittedAt: "2026-07-03T12:00:00Z", LastID: "sub_1"})}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestLeadpagesBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderLeadpages
	base.integration.CredentialsRef = "cred_leadpages_1"
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_leadpages_1"}
	store := &fakeLeadpagesWorkerStore{
		fakeStore: base,
		targets:   []LeadpagesBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceLeadpagesBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "leadpages://submission/form_123/sub_1", Email: "lead@example.com", FormID: "form_123"}},
		Cursor:      encodeLeadpagesCursor(leadpagesCursorState{LastSubmittedAt: "2026-07-03T12:00:00Z", LastID: "sub_1"}),
	}}}
	worker := &LeadpagesBackfillWorker{
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
	if store.listedLimit != leadpagesBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-leadpagesBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestLeadpagesBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderLeadpages
	base.integration.Settings = map[string]any{"form_id": "form_123", "credentials_ref": "cred_leadpages_1"}
	cursor := encodeLeadpagesCursor(leadpagesCursorState{NextCursor: "cursor_2", LastSubmittedAt: "2026-07-02T12:00:00Z", LastID: "sub_1"})
	store := &fakeLeadpagesWorkerStore{
		fakeStore: base,
		targets:   []LeadpagesBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceLeadpagesBackfiller{err: LeadpagesProviderError{Path: "/api/forms/form_123/submissions", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &LeadpagesBackfillWorker{
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
	retry, ok, decodeErr := decodeLeadpagesRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.NextCursor != "cursor_2" || retry.LastSubmittedAt != "2026-07-02T12:00:00Z" || retry.LastID != "sub_1" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
