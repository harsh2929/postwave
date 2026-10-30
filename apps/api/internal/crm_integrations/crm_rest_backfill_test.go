// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"errors"
	"testing"
	"time"
)

type crmRESTBackfillRunResult struct {
	cursor string
	pages  int
	err    error
}

func TestCRMRESTBackfillRunnersSkipDisconnectedIntegration(t *testing.T) {
	for _, provider := range crmRESTBackfillProviders() {
		t.Run(provider, func(t *testing.T) {
			startCursor := crmRESTTestBaseCursor(t, provider)
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.Status = "disconnected"
			store.integration.SyncCursor = startCursor
			backfiller := &fakeCRMBackfiller{}

			result := runCRMRESTBackfillRunner(t, provider, store, backfiller, nil, "")

			if result.err != nil {
				t.Fatalf("err=%v", result.err)
			}
			if backfiller.gotCursor != "" {
				t.Fatalf("disconnected integration should not call provider, cursor=%q", backfiller.gotCursor)
			}
			if len(store.runs) != 0 || result.pages != 0 {
				t.Fatalf("runs=%+v result=%+v", store.runs, result)
			}
			if result.cursor != startCursor {
				t.Fatalf("cursor=%q want %q", result.cursor, startCursor)
			}
		})
	}
}

func TestCRMRESTBackfillRunnersStopBeforeProviderCallWhenDisconnectedMidRun(t *testing.T) {
	for _, provider := range crmRESTBackfillProviders() {
		t.Run(provider, func(t *testing.T) {
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.SyncCursor = crmRESTTestBaseCursor(t, provider)
			store.getIntegrationHook = func(s *fakeStore, call int) {
				if call == 2 {
					s.integration.Status = "disconnected"
				}
			}
			backfiller := &fakeCRMBackfiller{req: SyncRequest{
				Contacts: []ContactInput{{SourceID: crmRESTTestSourceID(t, provider), Email: "buyer@example.com"}},
				Cursor:   crmRESTTestNextCursor(t, provider),
			}}
			profiles := &fakeProfileSink{}

			result := runCRMRESTBackfillRunner(t, provider, store, backfiller, profiles, "")

			if result.err != nil {
				t.Fatalf("err=%v", result.err)
			}
			if backfiller.gotCursor != "" {
				t.Fatalf("disconnected integration should not call provider, cursor=%q", backfiller.gotCursor)
			}
			if len(profiles.contacts) != 0 || len(store.runs) != 0 || result.pages != 0 {
				t.Fatalf("profiles=%+v runs=%+v result=%+v", profiles.contacts, store.runs, result)
			}
		})
	}
}

func TestCRMRESTBackfillRunnersStopBeforeLocalWriteWhenDisconnectedAfterProviderCall(t *testing.T) {
	for _, provider := range crmRESTBackfillProviders() {
		t.Run(provider, func(t *testing.T) {
			startCursor := crmRESTTestBaseCursor(t, provider)
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.SyncCursor = startCursor
			profiles := &fakeProfileSink{}
			backfiller := &fakeCRMBackfiller{
				req: SyncRequest{
					Contacts: []ContactInput{{SourceID: crmRESTTestSourceID(t, provider), Email: "buyer@example.com"}},
					Cursor:   crmRESTTestNextCursor(t, provider),
				},
				afterCall: func() {
					store.integration.Status = "disconnected"
				},
			}

			result := runCRMRESTBackfillRunner(t, provider, store, backfiller, profiles, "")

			if result.err != nil {
				t.Fatalf("err=%v", result.err)
			}
			if backfiller.gotCursor != startCursor {
				t.Fatalf("provider call cursor=%q want %q", backfiller.gotCursor, startCursor)
			}
			if len(profiles.contacts) != 0 || len(store.runs) != 0 || result.pages != 0 {
				t.Fatalf("profiles=%+v runs=%+v result=%+v", profiles.contacts, store.runs, result)
			}
		})
	}
}

func TestCRMRESTBackfillRunnersPreserveRetryAttemptsOnRepeatedProviderFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 13, 0, 0, 0, time.UTC)
	for _, provider := range crmRESTBackfillProviders() {
		t.Run(provider, func(t *testing.T) {
			baseCursor := crmRESTTestBaseCursor(t, provider)
			retryCursor := crmRESTRetryCursorWithAttempts(t, provider, baseCursor, 2, "BACKFILL_FAILED", now.Add(-time.Minute))
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.SyncCursor = retryCursor
			backfiller := &fakeCRMBackfiller{err: crmRESTTestProviderError(t, provider, 3*time.Minute)}

			result := runCRMRESTBackfillRunner(t, provider, store, backfiller, &fakeProfileSink{}, "", now)

			if result.err == nil {
				t.Fatalf("expected provider error, result=%+v", result)
			}
			if backfiller.gotCursor != baseCursor {
				t.Fatalf("provider call cursor=%q want %q", backfiller.gotCursor, baseCursor)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" {
				t.Fatalf("runs=%+v", store.runs)
			}
			assertCRMRESTRetryCursorWithAttempts(t, provider, store.runs[0].CursorTo, baseCursor, "BACKFILL_FAILED", now.Add(3*time.Minute).Format(time.RFC3339), 3)
		})
	}
}

func TestCRMRESTBackfillRunnersStoreRetryCursorOnSyncFailure(t *testing.T) {
	now := time.Date(2026, 7, 2, 13, 30, 0, 0, time.UTC)
	for _, provider := range crmRESTBackfillProviders() {
		t.Run(provider, func(t *testing.T) {
			baseCursor := crmRESTTestBaseCursor(t, provider)
			store := newFakeStore()
			store.integration.Provider = provider
			store.integration.SyncCursor = baseCursor
			backfiller := &fakeCRMBackfiller{req: SyncRequest{
				Contacts: []ContactInput{{SourceID: crmRESTTestSourceID(t, provider), Email: "buyer@example.com"}},
				Cursor:   crmRESTTestNextCursor(t, provider),
			}}
			profiles := &fakeProfileSink{err: errors.New("profile sink down")}

			result := runCRMRESTBackfillRunner(t, provider, store, backfiller, profiles, "", now)

			if result.err == nil {
				t.Fatalf("expected sync failure, result=%+v", result)
			}
			if len(store.runs) != 1 || store.runs[0].Status != "failed" {
				t.Fatalf("runs=%+v", store.runs)
			}
			assertCRMRESTRetryCursorWithAttempts(t, provider, store.runs[0].CursorTo, baseCursor, "SYNC_FAILED", now.Add(15*time.Minute).Format(time.RFC3339), 1)
			if result.cursor != store.runs[0].CursorTo {
				t.Fatalf("result cursor=%q run cursor=%q", result.cursor, store.runs[0].CursorTo)
			}
		})
	}
}

func crmRESTBackfillProviders() []string {
	return []string{ProviderZohoCRM, ProviderDynamics365, ProviderKeap}
}

func runCRMRESTBackfillRunner(t *testing.T, provider string, store *fakeStore, backfiller *fakeCRMBackfiller, profiles *fakeProfileSink, cursor string, nowOpt ...time.Time) crmRESTBackfillRunResult {
	t.Helper()
	now := time.Date(2026, 7, 2, 12, 0, 0, 0, time.UTC)
	if len(nowOpt) > 0 {
		now = nowOpt[0]
	}
	if profiles == nil {
		profiles = &fakeProfileSink{}
	}
	deps := &Deps{
		Repo:     store,
		Profiles: profiles,
		Events:   &fakeEventSink{},
		Now:      func() time.Time { return now },
	}
	switch provider {
	case ProviderZohoCRM:
		summary, err := (ZohoBackfillRunner{Deps: deps, Backfiller: backfiller, Now: func() time.Time { return now }}).Run(context.Background(), "tenant-1", store.integration.ID, cursor)
		return crmRESTBackfillRunResult{cursor: summary.Cursor, pages: summary.Pages, err: err}
	case ProviderDynamics365:
		summary, err := (Dynamics365BackfillRunner{Deps: deps, Backfiller: backfiller, Now: func() time.Time { return now }}).Run(context.Background(), "tenant-1", store.integration.ID, cursor)
		return crmRESTBackfillRunResult{cursor: summary.Cursor, pages: summary.Pages, err: err}
	case ProviderKeap:
		summary, err := (KeapBackfillRunner{Deps: deps, Backfiller: backfiller, Now: func() time.Time { return now }}).Run(context.Background(), "tenant-1", store.integration.ID, cursor)
		return crmRESTBackfillRunResult{cursor: summary.Cursor, pages: summary.Pages, err: err}
	default:
		t.Fatalf("unsupported provider %q", provider)
		return crmRESTBackfillRunResult{}
	}
}

func crmRESTRetryCursorWithAttempts(t *testing.T, provider, cursor string, attempts int, status string, nextAttemptAt time.Time) string {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		return encodeZohoRetryCursor(zohoRetryState{Cursor: cursor, Attempts: attempts, LastStatus: status, LastError: "provider throttled", NextAttemptAt: nextAttemptAt.UTC().Format(time.RFC3339)})
	case ProviderDynamics365:
		return encodeDynamics365RetryCursor(dynamics365RetryState{Cursor: cursor, Attempts: attempts, LastStatus: status, LastError: "provider throttled", NextAttemptAt: nextAttemptAt.UTC().Format(time.RFC3339)})
	case ProviderKeap:
		return encodeKeapRetryCursor(keapRetryState{Cursor: cursor, Attempts: attempts, LastStatus: status, LastError: "provider throttled", NextAttemptAt: nextAttemptAt.UTC().Format(time.RFC3339)})
	default:
		t.Fatalf("unsupported provider %q", provider)
		return ""
	}
}

func assertCRMRESTRetryCursorWithAttempts(t *testing.T, provider, got, wantCursor, wantStatus, wantNextAttemptAt string, wantAttempts int) {
	t.Helper()
	switch provider {
	case ProviderZohoCRM:
		retry, ok, err := decodeZohoRetryCursor(got)
		if err != nil || !ok {
			t.Fatalf("retry cursor=%q ok=%v err=%v", got, ok, err)
		}
		if retry.Cursor != wantCursor || retry.LastStatus != wantStatus || retry.NextAttemptAt != wantNextAttemptAt || retry.Attempts != wantAttempts {
			t.Fatalf("retry=%+v", retry)
		}
	case ProviderDynamics365:
		retry, ok, err := decodeDynamics365RetryCursor(got)
		if err != nil || !ok {
			t.Fatalf("retry cursor=%q ok=%v err=%v", got, ok, err)
		}
		if retry.Cursor != wantCursor || retry.LastStatus != wantStatus || retry.NextAttemptAt != wantNextAttemptAt || retry.Attempts != wantAttempts {
			t.Fatalf("retry=%+v", retry)
		}
	case ProviderKeap:
		retry, ok, err := decodeKeapRetryCursor(got)
		if err != nil || !ok {
			t.Fatalf("retry cursor=%q ok=%v err=%v", got, ok, err)
		}
		if retry.Cursor != wantCursor || retry.LastStatus != wantStatus || retry.NextAttemptAt != wantNextAttemptAt || retry.Attempts != wantAttempts {
			t.Fatalf("retry=%+v", retry)
		}
	default:
		t.Fatalf("unsupported provider %q", provider)
	}
}
