// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeSmileWorkerStore struct {
	*fakeStore
	targets           []SmileBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeSmileWorkerStore) ListSmileBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SmileBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit >= 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type fakeLoyaltyWorkerStore struct {
	*fakeStore
	targets           []LoyaltyBackfillTarget
	listedProvider    string
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeLoyaltyWorkerStore) ListLoyaltyBackfillTargets(_ context.Context, provider string, limit int, staleBefore time.Time) ([]LoyaltyBackfillTarget, error) {
	f.listedProvider = provider
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit >= 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type sequenceSmileBackfiller struct {
	pages   []SyncRequest
	err     error
	calls   int
	cursor  string
	cursors []string
	onCall  func()
}

func (f *sequenceSmileBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.calls++
	f.cursor = cursor
	f.cursors = append(f.cursors, cursor)
	if f.onCall != nil {
		f.onCall()
	}
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: smileCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestLoyaltyBackfillWorkerRunsPromotedProviderAndSkipsNotDueRetry(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	notDue := encodeLoyaltyProviderRetryCursor(ProviderLoyaltyLion, loyaltyProviderRetryState{
		Cursor:        loyaltyLionCursorPrefix + "not-due",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	dueCursor := loyaltyLionCursorPrefix + "1"
	store := &fakeLoyaltyWorkerStore{
		fakeStore: newFakeStore(),
		targets: []LoyaltyBackfillTarget{
			{TenantID: "tenant-1", IntegrationID: "loyalty_wait", Cursor: notDue},
			{TenantID: "tenant-1", IntegrationID: "loyalty_1", Cursor: dueCursor},
		},
	}
	store.integration.Provider = ProviderLoyaltyLion
	store.integration.SyncCursor = dueCursor
	backfiller := &sequenceSmileBackfiller{pages: []SyncRequest{{
		Members: []MemberInput{{SourceID: "loyaltylion://member/42", Email: "buyer@example.com"}},
		Cursor:  loyaltyLionCursorComplete,
	}}}
	worker := &LoyaltyBackfillWorker{
		Provider: ProviderLoyaltyLion,
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Store:          store,
		Backfiller:     backfiller,
		Limit:          1,
		MaxPagesPerRun: 1,
		Now:            func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedProvider != ProviderLoyaltyLion || store.listedLimit != loyaltyBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-loyaltyBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.MembersSeen != 1 || backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("summary=%+v calls=%d cursor=%q", summary, backfiller.calls, backfiller.cursor)
	}
}

func TestLoyaltyBackfillWorkerStoresPromotedProviderRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	cursor := loyaltyLionCursorPrefix + "2"
	store := &fakeLoyaltyWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []LoyaltyBackfillTarget{{TenantID: "tenant-1", IntegrationID: "loyalty_1", Cursor: cursor}},
	}
	store.integration.Provider = ProviderLoyaltyLion
	store.integration.SyncCursor = cursor
	backfiller := &sequenceSmileBackfiller{err: LoyaltyRESTError{StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &LoyaltyBackfillWorker{
		Provider:   ProviderLoyaltyLion,
		Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
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
	if !strings.HasPrefix(store.runs[0].CursorTo, "loyaltylion_retry:") {
		t.Fatalf("cursor=%q", store.runs[0].CursorTo)
	}
	retry, ok, decodeErr := decodeLoyaltyProviderRetryCursor(ProviderLoyaltyLion, store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSmileBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	store := &fakeSmileWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []SmileBackfillTarget{{TenantID: "tenant-1", IntegrationID: "loyalty_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceSmileBackfiller{pages: []SyncRequest{{
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com", PointsBalance: 120}},
		Cursor:  smileCursorPrefix + "2",
	}}}
	worker := &SmileBackfillWorker{
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
	if summary.Targets != 1 || summary.Pages != 1 || summary.MembersSeen != 1 || summary.MembersUpserted != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != smileBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-smileBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.members) != 1 || profiles.members[0].Email != "buyer@example.com" {
		t.Fatalf("members=%+v", profiles.members)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != smileCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSmileBackfillWorkerSkipsManyNotDueRetriesAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	notDue := encodeSmileRetryCursor(smileRetryState{
		Cursor:        smileCursorPrefix + "not-due",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	targets := make([]SmileBackfillTarget, 0, 10)
	for i := 0; i < 9; i++ {
		targets = append(targets, SmileBackfillTarget{TenantID: "tenant-1", IntegrationID: "loyalty_1", Cursor: notDue})
	}
	targets = append(targets, SmileBackfillTarget{TenantID: "tenant-1", IntegrationID: "loyalty_1", Cursor: smileCursorPrefix + "1"})
	store := &fakeSmileWorkerStore{
		fakeStore: newFakeStore(),
		targets:   targets,
	}
	backfiller := &sequenceSmileBackfiller{pages: []SyncRequest{{
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
		Cursor:  smileCursorPrefix + "2",
	}}}
	worker := &SmileBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{},
			Events:   &fakeEventSink{},
			Now:      func() time.Time { return now },
		},
		Store:      store,
		Backfiller: backfiller,
		Limit:      1,
		Now:        func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.listedLimit != smileBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit=%d want over-fetched %d", store.listedLimit, smileBackfillWorkerMaxCandidateScan)
	}
	if summary.Targets != 1 || summary.MembersSeen != 1 || backfiller.calls == 0 {
		t.Fatalf("summary=%+v calls=%d", summary, backfiller.calls)
	}
	if len(backfiller.cursors) == 0 || backfiller.cursors[0] != smileCursorPrefix+"1" {
		t.Fatalf("cursors=%+v", backfiller.cursors)
	}
}

func TestSmileBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "2"
	store := &fakeSmileWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []SmileBackfillTarget{{TenantID: "tenant-1", IntegrationID: "loyalty_1", Cursor: cursor}},
	}
	backfiller := &sequenceSmileBackfiller{err: LoyaltyRESTError{Operation: "loyalty REST /v1/customers", StatusCode: 429, RetryAfter: 5 * time.Minute, Snippet: "slow down"}}
	worker := &SmileBackfillWorker{
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
	retry, ok, decodeErr := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "2" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(5*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr LoyaltyRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestSmileBackfillWorkerPollsStaleCompleteCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	lastSync := time.Date(2026, 6, 28, 10, 30, 0, 0, time.UTC)
	var pointsUpdatedAtMin, rewardsUpdatedAtMin string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/points_transactions":
			pointsUpdatedAtMin = r.URL.Query().Get("updated_at_min")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"points_transactions": []map[string]any{
					{"id": 825673456, "customer_id": 304169232, "points_change": 75, "updated_at": "2026-06-28T11:35:27.893Z"},
				},
			})
		case "/v1/reward_fulfillments":
			rewardsUpdatedAtMin = r.URL.Query().Get("updated_at_min")
			_ = json.NewEncoder(w).Encode(map[string]any{"reward_fulfillments": []map[string]any{}})
		case "/v1/customers/304169232":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"customer": map[string]any{
					"id": 304169232, "email": "Ada@Example.com", "points_balance": 395,
					"vip_tier": map[string]any{"name": "Gold"},
				},
			})
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	store := &fakeSmileWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []SmileBackfillTarget{{TenantID: "tenant-1", IntegrationID: "loyalty_1", Cursor: smileCursorComplete, LastSyncAt: &lastSync}},
	}
	store.integration.SyncCursor = smileCursorComplete
	store.integration.LastSyncAt = &lastSync
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	worker := &SmileBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Profiles: profiles,
			Events:   events,
			Now:      func() time.Time { return now },
		},
		Store: store,
		Backfiller: SmileRESTBackfiller{
			HTTPClient:  srv.Client(),
			Credentials: SmileSecretsCredentialResolver{Secrets: fakeLoyaltySecretResolver{json: `{"api_token":"smile_tok"}`}},
			APIBaseURL:  srv.URL,
		},
		Now: func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if pointsUpdatedAtMin != "2026-06-28T10:30:00Z" || rewardsUpdatedAtMin != "2026-06-28T10:30:00Z" {
		t.Fatalf("updated_at_min points=%q rewards=%q", pointsUpdatedAtMin, rewardsUpdatedAtMin)
	}
	if summary.Completed != 1 || summary.Pages != 1 || summary.MembersSeen != 1 || summary.EventsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if len(profiles.members) != 1 || profiles.members[0].Email != "ada@example.com" || profiles.members[0].PointsBalance != 395 {
		t.Fatalf("members=%+v", profiles.members)
	}
	if len(events.events) != 1 || events.events[0].EventName != "loyalty.points_earned" {
		t.Fatalf("events=%+v", events.events)
	}
	if len(store.runs) != 2 || store.runs[0].CursorTo == smileCursorComplete || store.runs[1].CursorTo != smileCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestSmileRetryCursorKeepsEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := smileBackfillRetryCursor("", "BACKFILL_FAILED", LoyaltyRESTError{StatusCode: 429, RetryAfter: time.Minute}, now)
	retry, ok, decodeErr := decodeSmileRetryCursor(cursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, cursor)
	}
	if retry.Cursor != "" || retry.ProviderCursor != "" {
		t.Fatalf("first failure should retry from the beginning, got %+v", retry)
	}
	if retry.NextAttemptAt != now.Add(time.Minute).Format(time.RFC3339) {
		t.Fatalf("next attempt=%q", retry.NextAttemptAt)
	}
}

func TestSmileBulkBackfillRunnerSkipsDisconnectedTargets(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = smileCursorPrefix + "1"
	backfiller := &sequenceSmileBackfiller{pages: []SyncRequest{{
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
		Cursor:  smileCursorPrefix + "2",
	}}}
	runner := SmileBulkBackfillRunner{
		Deps:       &Deps{Repo: store},
		Backfiller: backfiller,
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "loyalty_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if summary.IntegrationID != "loyalty_1" || summary.Cursor != smileCursorPrefix+"1" || summary.Pages != 0 || summary.Complete {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 0 || len(store.runs) != 0 {
		t.Fatalf("calls=%d runs=%+v", backfiller.calls, store.runs)
	}
}

func TestSmileBulkBackfillRunnerSkipsSinkWritesAfterDisconnectDuringProviderCall(t *testing.T) {
	store := newFakeStore()
	store.integration.SyncCursor = smileCursorPrefix + "1"
	profiles := &fakeProfileSink{}
	backfiller := &sequenceSmileBackfiller{
		pages: []SyncRequest{{
			Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
			Cursor:  smileCursorPrefix + "2",
		}},
		onCall: func() {
			store.integration.Status = "disconnected"
		},
	}
	runner := SmileBulkBackfillRunner{
		Deps: &Deps{
			Repo:     store,
			Profiles: profiles,
		},
		Backfiller: backfiller,
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "loyalty_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if backfiller.calls != 1 {
		t.Fatalf("provider calls=%d", backfiller.calls)
	}
	if summary.Pages != 0 || len(profiles.members) != 0 || len(store.runs) != 0 {
		t.Fatalf("disconnect during provider call should skip sinks/runs: summary=%+v members=%+v runs=%+v", summary, profiles.members, store.runs)
	}
}

func TestSmileBulkBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	retryCursor := encodeSmileRetryCursor(smileRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &sequenceSmileBackfiller{err: LoyaltyRESTError{StatusCode: 429, RetryAfter: 2 * time.Minute, Snippet: "still throttled"}}
	runner := SmileBulkBackfillRunner{
		Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "loyalty_1", "")
	if err == nil {
		t.Fatal("expected provider failure")
	}
	if summary.LastError == "" || summary.Cursor == "" {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 1 || backfiller.cursor != cursor {
		t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestSmileBulkBackfillRunnerStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := smileCursorPrefix + "1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &sequenceSmileBackfiller{pages: []SyncRequest{{
		Members: []MemberInput{{SourceID: "smile://customer/42", Email: "buyer@example.com"}},
		Cursor:  smileCursorPrefix + "2",
	}}}
	runner := SmileBulkBackfillRunner{
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{err: errors.New("profile sink unavailable")},
			Now:      func() time.Time { return now },
		},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "loyalty_1", "")
	if err == nil {
		t.Fatal("expected local sync failure")
	}
	if summary.LastError == "" || summary.Cursor == smileCursorPrefix+"2" {
		t.Fatalf("summary=%+v", summary)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeSmileRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
