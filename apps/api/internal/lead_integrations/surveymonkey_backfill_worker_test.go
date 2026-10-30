// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"testing"
	"time"
)

type fakeSurveyMonkeyWorkerStore struct {
	*fakeStore
	targets           []SurveyMonkeyBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeSurveyMonkeyWorkerStore) ListSurveyMonkeyBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SurveyMonkeyBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceSurveyMonkeyBackfiller struct {
	pages []SyncRequest
	err   error
}

func (f *sequenceSurveyMonkeyBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, _ string) (SyncRequest, error) {
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: surveyMonkeyCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestSurveyMonkeyBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderSurveyMonkey
	base.integration.CredentialsRef = "cred_surveymonkey_1"
	base.integration.Settings = map[string]any{"survey_id": "survey_456", "credentials_ref": "cred_surveymonkey_1"}
	store := &fakeSurveyMonkeyWorkerStore{
		fakeStore: base,
		targets:   []SurveyMonkeyBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceSurveyMonkeyBackfiller{pages: []SyncRequest{{
		Submissions: []SubmissionInput{{SourceID: "surveymonkey://response/survey_456/response_123", Email: "lead@example.com", FormID: "survey_456"}},
		Cursor:      encodeSurveyMonkeyCursor(surveyMonkeyCursorState{Since: "2026-06-18T12:00:00Z"}),
	}}}
	worker := &SurveyMonkeyBackfillWorker{
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
	if store.listedLimit != surveyMonkeyBackfillWorkerDefaultLimit || !store.listedStaleBefore.Equal(now.Add(-surveyMonkeyBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.submissions) != 1 || profiles.submissions[0].Email != "lead@example.com" {
		t.Fatalf("profiles=%+v", profiles.submissions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != surveyMonkeyCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSurveyMonkeyBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 18, 12, 0, 0, 0, time.UTC)
	base := newFakeStore()
	base.integration.Provider = ProviderSurveyMonkey
	base.integration.Settings = map[string]any{"survey_id": "survey_456", "credentials_ref": "cred_surveymonkey_1"}
	cursor := encodeSurveyMonkeyCursor(surveyMonkeyCursorState{NextURL: "https://api.surveymonkey.com/v3/surveys/survey_456/responses/bulk?page=100", Since: "2026-06-01T00:00:00Z"})
	store := &fakeSurveyMonkeyWorkerStore{
		fakeStore: base,
		targets:   []SurveyMonkeyBackfillTarget{{TenantID: "tenant-1", IntegrationID: "lead_1", Cursor: cursor}},
	}
	backfiller := &sequenceSurveyMonkeyBackfiller{err: SurveyMonkeyProviderError{Path: "/v3/surveys/survey_456/responses/bulk", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &SurveyMonkeyBackfillWorker{
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
	retry, ok, decodeErr := decodeSurveyMonkeyRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.NextURL != "https://api.surveymonkey.com/v3/surveys/survey_456/responses/bulk?page=100" || retry.Since != "2026-06-01T00:00:00Z" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
