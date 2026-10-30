// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeRechargeWorkerStore struct {
	*fakeStore
	targets           []RechargeBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeRechargeWorkerStore) ListRechargeBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]RechargeBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit > 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type fakeSubscriptionWorkerStore struct {
	*fakeStore
	targets           []SubscriptionBackfillTarget
	listedProvider    string
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakeSubscriptionWorkerStore) ListSubscriptionBackfillTargets(_ context.Context, provider string, limit int, staleBefore time.Time) ([]SubscriptionBackfillTarget, error) {
	f.listedProvider = provider
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	if limit > 0 && limit < len(f.targets) {
		return f.targets[:limit], nil
	}
	return f.targets, nil
}

type sequenceRechargeBackfiller struct {
	pages  []SyncRequest
	err    error
	calls  int
	cursor string
}

func (f *sequenceRechargeBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.calls++
	f.cursor = cursor
	if f.err != nil {
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		return SyncRequest{Cursor: rechargeCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	return page, nil
}

func TestSubscriptionBackfillWorkerRunsPromotedProviderAndSkipsNotDueRetry(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	notDue := encodeSubscriptionProviderRetryCursor(ProviderAfterShip, subscriptionProviderRetryState{
		Cursor:        afterShipCursorPrefix + "not-due",
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
	})
	dueCursor := afterShipCursorPrefix + "1"
	store := &fakeSubscriptionWorkerStore{
		fakeStore: newFakeStore(),
		targets: []SubscriptionBackfillTarget{
			{TenantID: "tenant-1", IntegrationID: "subscription_wait", Cursor: notDue},
			{TenantID: "tenant-1", IntegrationID: "subscription_1", Cursor: dueCursor},
		},
	}
	store.integration.Provider = ProviderAfterShip
	store.integration.SyncCursor = dueCursor
	backfiller := &sequenceRechargeBackfiller{pages: []SyncRequest{{
		Shipments: []ShipmentInput{{SourceID: "aftership://tracking/42", Email: "buyer@example.com", TrackingNumber: "TRACK1"}},
		Cursor:    afterShipCursorComplete,
	}}}
	worker := &SubscriptionBackfillWorker{
		Provider: ProviderAfterShip,
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
	if store.listedProvider != ProviderAfterShip || store.listedLimit != subscriptionBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-subscriptionBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed provider=%q limit=%d staleBefore=%s", store.listedProvider, store.listedLimit, store.listedStaleBefore)
	}
	if summary.Targets != 1 || summary.Pages != 1 || summary.ShipmentsSeen != 1 || backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("summary=%+v calls=%d cursor=%q", summary, backfiller.calls, backfiller.cursor)
	}
}

func TestSubscriptionBackfillWorkerStoresPromotedProviderRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	cursor := afterShipCursorPrefix + "2"
	store := &fakeSubscriptionWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []SubscriptionBackfillTarget{{TenantID: "tenant-1", IntegrationID: "subscription_1", Cursor: cursor}},
	}
	store.integration.Provider = ProviderAfterShip
	store.integration.SyncCursor = cursor
	backfiller := &sequenceRechargeBackfiller{err: RechargeRESTError{StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}}
	worker := &SubscriptionBackfillWorker{
		Provider:   ProviderAfterShip,
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
	if !strings.HasPrefix(store.runs[0].CursorTo, "aftership_retry:") {
		t.Fatalf("cursor=%q", store.runs[0].CursorTo)
	}
	retry, ok, decodeErr := decodeSubscriptionProviderRetryCursor(ProviderAfterShip, store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestRechargeBackfillWorkerTickRunsDueTargets(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	store := &fakeRechargeWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []RechargeBackfillTarget{{TenantID: "tenant-1", IntegrationID: "subscription_1"}},
	}
	profiles := &fakeProfileSink{}
	events := &fakeEventSink{}
	backfiller := &sequenceRechargeBackfiller{pages: []SyncRequest{{
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com", SubscriptionID: "9001", Status: "active"}},
		Cursor:        rechargeCursorPrefix + "cur_2",
	}}}
	worker := &RechargeBackfillWorker{
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
	if summary.Targets != 1 || summary.Pages != 1 || summary.SubscriptionsSeen != 1 || summary.SubscriptionsUpserted != 1 || summary.EventsTracked != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != rechargeBackfillWorkerMaxCandidateScan || !store.listedStaleBefore.Equal(now.Add(-rechargeBackfillWorkerDefaultDueAfter)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(profiles.subscriptions) != 1 || profiles.subscriptions[0].Email != "buyer@example.com" {
		t.Fatalf("profiles=%+v", profiles.subscriptions)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[1].CursorTo != rechargeCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestRechargeBackfillWorkerStoresRetryCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	store := &fakeRechargeWorkerStore{
		fakeStore: newFakeStore(),
		targets:   []RechargeBackfillTarget{{TenantID: "tenant-1", IntegrationID: "subscription_1", Cursor: cursor}},
	}
	backfiller := &sequenceRechargeBackfiller{err: RechargeRESTError{StatusCode: 429, RetryAfter: 5 * time.Minute, Snippet: "slow down"}}
	worker := &RechargeBackfillWorker{
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
	retry, ok, decodeErr := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.ProviderCursor != "cur_1" || retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(5*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	var providerErr RechargeRESTError
	if !errors.As(backfiller.err, &providerErr) {
		t.Fatalf("stored err = %v", backfiller.err)
	}
}

func TestRechargeBackfillWorkerSkipsManyNotDueRetriesAndProcessesDueTarget(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	targets := make([]RechargeBackfillTarget, 0, 252)
	for i := 0; i < 251; i++ {
		notDue := encodeRechargeRetryCursor(rechargeRetryState{
			Cursor:        rechargeCursorPrefix + "wait",
			Attempts:      1,
			LastStatus:    "BACKFILL_FAILED",
			LastError:     "provider throttled",
			NextAttemptAt: now.Add(time.Hour).Format(time.RFC3339),
		})
		targets = append(targets, RechargeBackfillTarget{TenantID: "tenant-1", IntegrationID: "subscription_wait", Cursor: notDue})
	}
	dueCursor := rechargeCursorPrefix + "cur_1"
	targets = append(targets, RechargeBackfillTarget{TenantID: "tenant-1", IntegrationID: "subscription_1", Cursor: dueCursor})
	store := &fakeRechargeWorkerStore{
		fakeStore: newFakeStore(),
		targets:   targets,
	}
	backfiller := &sequenceRechargeBackfiller{pages: []SyncRequest{{
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com", SubscriptionID: "9001", Status: "active"}},
		Cursor:        rechargeCursorPrefix + "cur_2",
	}}}
	worker := &RechargeBackfillWorker{
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
	if summary.Targets != 1 || summary.Pages != 1 || summary.SubscriptionsSeen != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != rechargeBackfillWorkerMaxCandidateScan {
		t.Fatalf("listed limit = %d", store.listedLimit)
	}
	if backfiller.calls != 1 || backfiller.cursor != dueCursor {
		t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, dueCursor)
	}
	if len(store.runs) != 1 || store.runs[0].CursorTo != rechargeCursorPrefix+"cur_2" {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestRechargeRetryCursorPreservesEmptyStartCursor(t *testing.T) {
	now := time.Date(2026, 6, 28, 12, 0, 0, 0, time.UTC)
	cursor := rechargeBackfillRetryCursor("", "BACKFILL_FAILED", RechargeRESTError{StatusCode: 500}, now)
	retry, ok, err := decodeRechargeRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode retry ok=%v err=%v cursor=%q", ok, err, cursor)
	}
	if retry.Cursor != "" || retry.ProviderCursor != "" {
		t.Fatalf("empty starting cursor must stay empty, got %+v", retry)
	}
	if retry.Attempts != 1 || retry.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestRechargeBulkBackfillRunnerSkipsDisconnectedTargets(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = rechargeCursorPrefix + "cur_1"
	backfiller := &sequenceRechargeBackfiller{pages: []SyncRequest{{
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com"}},
		Cursor:        rechargeCursorPrefix + "cur_2",
	}}}
	runner := RechargeBulkBackfillRunner{
		Deps:       &Deps{Repo: store},
		Backfiller: backfiller,
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "subscription_1", "")
	if err != nil {
		t.Fatal(err)
	}
	if summary.IntegrationID != "subscription_1" || summary.Cursor != rechargeCursorPrefix+"cur_1" || summary.Pages != 0 || summary.Complete {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 0 || len(store.runs) != 0 {
		t.Fatalf("calls=%d runs=%+v", backfiller.calls, store.runs)
	}
}

func TestRechargeBulkBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	retryCursor := encodeRechargeRetryCursor(rechargeRetryState{
		Cursor:        cursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &sequenceRechargeBackfiller{err: RechargeRESTError{StatusCode: 429, RetryAfter: 2 * time.Minute, Snippet: "still throttled"}}
	runner := RechargeBulkBackfillRunner{
		Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "subscription_1", "")
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
	retry, ok, decodeErr := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.Attempts != 2 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestRechargeBulkBackfillRunnerStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	cursor := rechargeCursorPrefix + "cur_1"
	store := newFakeStore()
	store.integration.SyncCursor = cursor
	backfiller := &sequenceRechargeBackfiller{pages: []SyncRequest{{
		Subscriptions: []SubscriptionInput{{SourceID: "recharge://subscription/9001", Email: "buyer@example.com", SubscriptionID: "9001", Status: "active"}},
		Cursor:        rechargeCursorComplete,
	}}}
	runner := RechargeBulkBackfillRunner{
		Deps: &Deps{
			Repo:     store,
			Profiles: &fakeProfileSink{err: errors.New("profile sink unavailable")},
			Now:      func() time.Time { return now },
		},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}

	summary, err := runner.Run(context.Background(), "tenant-1", "subscription_1", "")
	if err == nil {
		t.Fatal("expected local sync failure")
	}
	if summary.LastError == "" || summary.Cursor == "" || summary.Pages != 1 || summary.SubscriptionsSeen != 1 || summary.SubscriptionsUpserted != 0 {
		t.Fatalf("summary=%+v", summary)
	}
	if backfiller.calls != 1 || backfiller.cursor != cursor {
		t.Fatalf("calls=%d cursor=%q want %q", backfiller.calls, backfiller.cursor, cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].RunMode != "scheduled" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeRechargeRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != cursor || retry.ProviderCursor != "cur_1" || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(rechargeRetryInitialDelay).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
