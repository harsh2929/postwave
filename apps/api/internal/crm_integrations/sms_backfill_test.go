// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"strings"
	"testing"
	"time"
)

type fakePostscriptWorkerStore struct {
	*fakeStore
	targets           []SMSBackfillTarget
	listedLimit       int
	listedStaleBefore time.Time
}

func (f *fakePostscriptWorkerStore) ListPostscriptBackfillTargets(_ context.Context, limit int, staleBefore time.Time) ([]SMSBackfillTarget, error) {
	f.listedLimit = limit
	f.listedStaleBefore = staleBefore
	return f.targets, nil
}

type sequenceSMSBackfiller struct {
	tenantIDs    []string
	integrations []Integration
	cursors      []string
	pages        []SyncRequest
	err          error
	errAt        int
	calls        int
	afterCall    func()
}

func (f *sequenceSMSBackfiller) BackfillPage(_ context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error) {
	f.tenantIDs = append(f.tenantIDs, tenantID)
	f.integrations = append(f.integrations, integration)
	f.cursors = append(f.cursors, cursor)
	if f.err != nil && f.calls == f.errAt {
		f.calls++
		return SyncRequest{}, f.err
	}
	if f.calls >= len(f.pages) {
		f.calls++
		if f.afterCall != nil {
			f.afterCall()
		}
		return SyncRequest{Cursor: smsCompleteCursorForProvider(integration.Provider)}, nil
	}
	out := f.pages[f.calls]
	f.calls++
	if f.afterCall != nil {
		f.afterCall()
	}
	return out, nil
}

func smsCompleteCursorForProvider(provider string) string {
	cfg, _ := smsCursorConfigForProvider(provider)
	return cfg.CompleteCursor
}

func TestSMSRetryCursorRoundTripAndDue(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	cfg, _ := smsCursorConfigForProvider(ProviderPostscript)
	encoded := encodeSMSRetryCursor(smsRetryState{
		Cursor:        postscriptCursorPrefix + "cursor-1",
		Attempts:      2,
		NextAttemptAt: now.Add(time.Minute).Format(time.RFC3339),
		LastStatus:    "backfill_failed",
		LastError:     "slow down",
	}, cfg)
	if !strings.HasPrefix(encoded, postscriptRetryCursorPrefix) {
		t.Fatalf("retry cursor prefix mismatch: %q", encoded)
	}
	state, ok, err := decodePostscriptRetryCursor(encoded)
	if err != nil || !ok {
		t.Fatalf("decode retry cursor ok=%v err=%v", ok, err)
	}
	if state.Cursor != postscriptCursorPrefix+"cursor-1" || state.ProviderCursor != "cursor-1" || state.Attempts != 2 || state.LastStatus != "BACKFILL_FAILED" {
		t.Fatalf("state=%+v", state)
	}
	if smsRetryCursorDue(state, now) {
		t.Fatal("future retry cursor should not be due")
	}
	state.NextAttemptAt = now.Add(-time.Minute).Format(time.RFC3339)
	if !smsRetryCursorDue(state, now) {
		t.Fatal("past retry cursor should be due")
	}
}

func TestPostscriptBackfillWorkerTickRunsCursorOnlyAndPayloadPages(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	startCursor := postscriptCursorPrefix + "cursor-1"
	nextCursor := postscriptCursorPrefix + "cursor-2"
	store := &fakePostscriptWorkerStore{
		fakeStore: newFakeStore(),
		targets: []SMSBackfillTarget{{
			TenantID:      "tenant-1",
			IntegrationID: "crm_1",
			Cursor:        startCursor,
		}},
	}
	store.integration.Provider = ProviderPostscript
	store.integration.Name = "Postscript SMS"
	store.integration.SyncCursor = startCursor
	profiles := &fakeProfileSink{}
	backfiller := &sequenceSMSBackfiller{pages: []SyncRequest{
		{Cursor: nextCursor},
		{Contacts: []ContactInput{{SourceID: "postscript://subscriber/sub_1", Email: "Buyer@Example.com", Phone: "+15551234567"}}, Cursor: postscriptCursorComplete},
	}}
	worker := &PostscriptBackfillWorker{
		Deps: &Deps{
			Repo:     store,
			Profiles: profiles,
			Now:      func() time.Time { return now },
		},
		Store:          store,
		Backfiller:     backfiller,
		Limit:          8,
		DueAfter:       2 * time.Hour,
		MaxPagesPerRun: 3,
		Now:            func() time.Time { return now },
	}

	summary, err := worker.tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Targets != 1 || summary.Pages != 2 || summary.Completed != 1 || summary.Failed != 0 || summary.ContactsSeen != 1 || summary.ContactsUpserted != 1 {
		t.Fatalf("summary=%+v", summary)
	}
	if store.listedLimit != 8 || !store.listedStaleBefore.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("listed limit=%d staleBefore=%s", store.listedLimit, store.listedStaleBefore)
	}
	if len(backfiller.cursors) != 2 || backfiller.cursors[0] != startCursor || backfiller.cursors[1] != nextCursor {
		t.Fatalf("cursors=%+v", backfiller.cursors)
	}
	if len(profiles.contacts) != 1 || profiles.contacts[0].Email != "buyer@example.com" {
		t.Fatalf("profiles=%+v", profiles.contacts)
	}
	if len(store.runs) != 2 || store.runs[0].RunMode != "scheduled" || store.runs[0].CursorTo != nextCursor || store.runs[1].CursorTo != postscriptCursorComplete {
		t.Fatalf("runs=%+v", store.runs)
	}
}

func TestAttentiveBackfillRunnerSkipsDisconnectedIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderAttentive
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = attentiveCursorPrefix + "cursor-1"
	backfiller := &sequenceSMSBackfiller{}

	summary, err := (AttentiveBackfillRunner{
		Deps:       &Deps{Repo: store},
		Backfiller: backfiller,
		Now:        func() time.Time { return time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC) },
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err != nil {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if len(backfiller.cursors) != 0 {
		t.Fatalf("disconnected integration should not call provider: %+v", backfiller.cursors)
	}
	if len(store.runs) != 0 {
		t.Fatalf("disconnected integration should not record runs: %+v", store.runs)
	}
	if summary.Cursor != store.integration.SyncCursor {
		t.Fatalf("summary=%+v", summary)
	}
}

func TestSMSBackfillRunnerStopsBeforeProviderCallWhenDisconnectedMidRun(t *testing.T) {
	startCursor := postscriptCursorPrefix + "cursor-1"
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.SyncCursor = startCursor
	store.getIntegrationHook = func(s *fakeStore, call int) {
		if call == 2 {
			s.integration.Status = "disconnected"
		}
	}
	backfiller := &sequenceSMSBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "postscript://subscriber/sub_1", Email: "buyer@example.com"}},
		Cursor:   postscriptCursorComplete,
	}}}

	summary, err := (PostscriptBackfillRunner{
		Deps:       &Deps{Repo: store, Profiles: &fakeProfileSink{}},
		Backfiller: backfiller,
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err != nil {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if len(backfiller.cursors) != 0 {
		t.Fatalf("disconnected integration should not call provider: %+v", backfiller.cursors)
	}
	if len(store.runs) != 0 {
		t.Fatalf("disconnected integration should not record runs: %+v", store.runs)
	}
}

func TestSMSBackfillRunnerStopsBeforeLocalWriteWhenDisconnectedAfterProviderCall(t *testing.T) {
	startCursor := postscriptCursorPrefix + "cursor-1"
	store := newFakeStore()
	store.integration.Provider = ProviderPostscript
	store.integration.SyncCursor = startCursor
	profiles := &fakeProfileSink{}
	backfiller := &sequenceSMSBackfiller{
		pages: []SyncRequest{{
			Contacts: []ContactInput{{SourceID: "postscript://subscriber/sub_1", Email: "buyer@example.com"}},
			Cursor:   postscriptCursorComplete,
		}},
		afterCall: func() {
			store.integration.Status = "disconnected"
		},
	}

	summary, err := (PostscriptBackfillRunner{
		Deps:       &Deps{Repo: store, Profiles: profiles},
		Backfiller: backfiller,
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err != nil {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != startCursor {
		t.Fatalf("provider call cursors=%+v", backfiller.cursors)
	}
	if len(profiles.contacts) != 0 {
		t.Fatalf("disconnected integration should not write profiles: %+v", profiles.contacts)
	}
	if len(store.runs) != 0 || summary.Pages != 0 {
		t.Fatalf("runs=%+v summary=%+v", store.runs, summary)
	}
}

func TestAttentiveBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 30, 10, 0, 0, 0, time.UTC)
	baseCursor := attentiveCursorPrefix + "cursor-100"
	cfg, _ := smsCursorConfigForProvider(ProviderAttentive)
	retryCursor := encodeSMSRetryCursor(smsRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	}, cfg)
	providerErr := CRMStaticRESTError{Path: "/subscribers", StatusCode: 429, RetryAfter: 2 * time.Minute, Snippet: "slow down"}
	store := newFakeStore()
	store.integration.Provider = ProviderAttentive
	store.integration.SyncCursor = retryCursor
	backfiller := &sequenceSMSBackfiller{err: providerErr}

	summary, err := (AttentiveBackfillRunner{
		Deps:       &Deps{Repo: store, Now: func() time.Time { return now }},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err == nil || !strings.Contains(err.Error(), "slow down") {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != baseCursor {
		t.Fatalf("cursors=%+v", backfiller.cursors)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].CursorTo != summary.Cursor {
		t.Fatalf("runs=%+v summary=%+v", store.runs, summary)
	}
	retry, ok, decodeErr := decodeAttentiveRetryCursor(summary.Cursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", summary.Cursor, ok, decodeErr)
	}
	if retry.Cursor != baseCursor || retry.ProviderCursor != "cursor-100" || retry.Attempts != 2 || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}
