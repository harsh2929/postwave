// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeCognitoFormsWorkerStore struct {
	*fakeStore
	targets           []CognitoFormsBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeCognitoFormsWorkerStore) ListCognitoFormsBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]CognitoFormsBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceCognitoFormsBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceCognitoFormsBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: encodeCognitoFormsCursor(cognitoFormsCursorState{FormID: "123", ViewID: "456", LastID: "101", TotalCount: 1})}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestCognitoFormsBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderCognitoForms
	base.integration.CredentialsRef = "cred_cognito_1"
	base.integration.Settings = map[string]any{"form_id": "123", "view_id": "456", "credentials_ref": "cred_cognito_1"}
	store := &fakeCognitoFormsWorkerStore{
		fakeStore: base,
		targets:   []CognitoFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceCognitoFormsBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "cognito-forms://entry/123/456/100", Email: "lead@example.com", FormID: "123"}},
		Cursor:      encodeCognitoFormsCursor(cognitoFormsCursorState{FormID: "123", ViewID: "456", LastID: "100", TotalCount: 1}),
	}}}
	worker := &CognitoFormsBackfillWorker{
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
	if store.listedLimit != cognitoFormsBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-cognitoFormsBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestCognitoFormsBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderCognitoForms
	base.integration.Settings = map[string]any{"form_id": "123", "view_id": "456", "credentials_ref": "cred_cognito_1"}
	cursor := encodeCognitoFormsCursor(cognitoFormsCursorState{FormID: "123", ViewID: "456", LastID: "100", TotalCount: 200})
	store := &fakeCognitoFormsWorkerStore{
		fakeStore: base,
		targets:   []CognitoFormsBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceCognitoFormsBackfiller{err: CognitoFormsProviderError{Path: "/Forms(123)/Views(456)/Entries", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &CognitoFormsBackfillWorker{
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
	retry, ok, decodeErr := decodeCognitoFormsRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.FormID != "123" || retry.ViewID != "456" || retry.LastID != "100" || retry.TotalCount != 200 || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
