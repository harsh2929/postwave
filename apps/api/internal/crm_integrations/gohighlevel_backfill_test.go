// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type sequenceHighLevelBackfiller struct {
	pages     []SyncRequest
	err       error
	cursors   []string
	calls     int
	afterCall func()
}

func (f *sequenceHighLevelBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	f.calls++
	f.cursors = append(f.cursors, cursor)
	if f.err != nil {
		if f.afterCall != nil {
			f.afterCall()
		}
		return SyncRequest{}, f.err
	}
	if len(f.pages) == 0 {
		if f.afterCall != nil {
			f.afterCall()
		}
		return SyncRequest{Cursor: highLevelCursorComplete}, nil
	}
	page := f.pages[0]
	f.pages = f.pages[1:]
	if f.afterCall != nil {
		f.afterCall()
	}
	return page, nil
}

func TestHighLevelBackfillRunnerSkipsDisconnectedIntegration(t *testing.T) {
	startCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = startCursor
	backfiller := &sequenceHighLevelBackfiller{}

	summary, err := (HighLevelBackfillRunner{
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
	if summary.Cursor != startCursor {
		t.Fatalf("summary=%+v", summary)
	}
}

func TestHighLevelBackfillRunnerStopsBeforeProviderCallWhenDisconnectedMidRun(t *testing.T) {
	startCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.SyncCursor = startCursor
	store.getIntegrationHook = func(s *fakeStore, call int) {
		if call == 2 {
			s.integration.Status = "disconnected"
		}
	}
	backfiller := &sequenceHighLevelBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "highlevel://contact/c_1", Email: "buyer@example.com"}},
		Cursor:   highLevelCursorComplete,
	}}}

	summary, err := (HighLevelBackfillRunner{
		Deps:       &Deps{Repo: store, Profiles: &fakeProfileSink{}},
		Backfiller: backfiller,
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err != nil {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if len(backfiller.cursors) != 0 {
		t.Fatalf("disconnected integration should not call provider: %+v", backfiller.cursors)
	}
	if len(store.runs) != 0 || summary.Pages != 0 {
		t.Fatalf("runs=%+v summary=%+v", store.runs, summary)
	}
}

func TestHighLevelBackfillRunnerPreservesRetryAttemptsOnProviderFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	retryCursor := encodeHighLevelRetryCursor(highLevelRetryState{
		Cursor:        baseCursor,
		Attempts:      2,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.SyncCursor = retryCursor
	providerErr := HighLevelRESTError{Path: "/contacts/", StatusCode: 429, RetryAfter: 3 * time.Minute, Snippet: "slow down"}
	backfiller := &sequenceHighLevelBackfiller{err: providerErr}

	summary, err := (HighLevelBackfillRunner{
		Deps:       &Deps{Repo: store, Profiles: &fakeProfileSink{}, Now: func() time.Time { return now }},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err == nil {
		t.Fatalf("expected provider error, summary=%+v", summary)
	}
	if len(backfiller.cursors) != 1 || backfiller.cursors[0] != baseCursor {
		t.Fatalf("provider call cursors=%+v", backfiller.cursors)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeHighLevelRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != baseCursor || retry.Attempts != 3 || retry.LastStatus != "BACKFILL_FAILED" || retry.NextAttemptAt != now.Add(3*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

func TestHighLevelBackfillRunnerStoresRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 12, 30, 0, 0, time.UTC)
	baseCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.SyncCursor = baseCursor
	backfiller := &sequenceHighLevelBackfiller{pages: []SyncRequest{{
		Contacts: []ContactInput{{SourceID: "highlevel://contact/c_1", Email: "buyer@example.com"}},
		Cursor:   encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "200"}),
	}}}

	summary, err := (HighLevelBackfillRunner{
		Deps:       &Deps{Repo: store, Profiles: &fakeProfileSink{err: errors.New("profile sink down")}, Now: func() time.Time { return now }},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err == nil {
		t.Fatalf("expected sync failure, summary=%+v", summary)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" {
		t.Fatalf("runs=%+v", store.runs)
	}
	retry, ok, decodeErr := decodeHighLevelRetryCursor(store.runs[0].CursorTo)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor decode ok=%v err=%v cursor=%q", ok, decodeErr, store.runs[0].CursorTo)
	}
	if retry.Cursor != baseCursor || retry.Attempts != 1 || retry.LastStatus != "SYNC_FAILED" || retry.NextAttemptAt != now.Add(15*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
	if summary.Cursor != store.runs[0].CursorTo || summary.LastError == "" {
		t.Fatalf("summary=%+v run=%+v", summary, store.runs[0])
	}
}

func TestHighLevelBackfillRunnerStopsBeforeLocalWriteWhenDisconnectedAfterProviderCall(t *testing.T) {
	startCursor := encodeHighLevelCursor(highLevelCursorState{Object: "contacts", StartAfterID: "100"})
	store := newFakeStore()
	store.integration.Provider = ProviderHighLevel
	store.integration.SyncCursor = startCursor
	profiles := &fakeProfileSink{}
	backfiller := &sequenceHighLevelBackfiller{
		pages: []SyncRequest{{
			Contacts: []ContactInput{{SourceID: "highlevel://contact/c_1", Email: "buyer@example.com"}},
			Cursor:   highLevelCursorComplete,
		}},
		afterCall: func() {
			store.integration.Status = "disconnected"
		},
	}

	summary, err := (HighLevelBackfillRunner{
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
