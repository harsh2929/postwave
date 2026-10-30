// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSalesforceRetryCursorRoundTripAndSchedule(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	base := encodeSalesforceCursor(salesforceCursorState{Object: "contacts"})
	cursor := salesforceBackfillRetryCursor(base, "BACKFILL_FAILED", SalesforceRESTError{StatusCode: 500}, now)
	if !strings.HasPrefix(cursor, salesforceRetryCursorPrefix) {
		t.Fatalf("missing retry prefix: %q", cursor)
	}
	state, ok, err := decodeSalesforceRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode: ok=%v err=%v", ok, err)
	}
	if state.Attempts != 1 {
		t.Fatalf("attempts = %d", state.Attempts)
	}
	next, err := time.Parse(time.RFC3339, state.NextAttemptAt)
	if err != nil || !next.After(now) {
		t.Fatalf("next attempt not scheduled: %q (%v)", state.NextAttemptAt, err)
	}
	if _, ok, _ := decodeSalesforceRetryCursor(base); ok {
		t.Fatal("plain cursor should not decode as retry")
	}
}

func TestSalesforceRetryDelayHonorsRetryAfter(t *testing.T) {
	if d := salesforceRetryDelay(1, SalesforceRESTError{RetryAfter: 45 * time.Second}); d != 45*time.Second {
		t.Fatalf("delay = %v, want 45s", d)
	}
	if d := salesforceRetryDelay(1, nil); d != salesforceRetryInitialDelay {
		t.Fatalf("delay = %v, want %v", d, salesforceRetryInitialDelay)
	}
}

func TestSalesforceBackfillRunnerSkipsDisconnectedIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = encodeSalesforceCursor(salesforceCursorState{Object: "campaign_members"})
	backfiller := &recordingSalesforceBackfiller{}

	summary, err := (SalesforceBackfillRunner{
		Deps:       &Deps{Repo: store},
		Backfiller: backfiller,
		Now: func() time.Time {
			return time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
		},
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err != nil {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if backfiller.called {
		t.Fatal("disconnected integration should not call Salesforce backfiller")
	}
	if len(store.runs) != 0 {
		t.Fatalf("disconnected integration should not record runs: %+v", store.runs)
	}
	if summary.IntegrationID != store.integration.ID || summary.Cursor != store.integration.SyncCursor || summary.LastError != "" {
		t.Fatalf("summary=%+v", summary)
	}
}

func TestSalesforceBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeSalesforceCursor(salesforceCursorState{Object: "tasks", NextRecordsURL: "/services/data/v67.0/query/01g"})
	retryCursor := encodeSalesforceRetryCursor(salesforceRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	providerErr := SalesforceRESTError{
		Path:       "/services/data/v67.0/query",
		StatusCode: 429,
		RetryAfter: 2 * time.Minute,
		Snippet:    "slow down",
	}
	store := newFakeStore()
	store.integration.Provider = ProviderSalesforce
	store.integration.SyncCursor = retryCursor
	backfiller := &recordingSalesforceBackfiller{err: providerErr}

	summary, err := (SalesforceBackfillRunner{
		Deps:       &Deps{Repo: store},
		Backfiller: backfiller,
		Now:        func() time.Time { return now },
	}).Run(context.Background(), "tenant-1", store.integration.ID, "")

	if err == nil || !strings.Contains(err.Error(), "slow down") {
		t.Fatalf("err=%v summary=%+v", err, summary)
	}
	if !backfiller.called || backfiller.cursor != baseCursor {
		t.Fatalf("backfiller called/cursor = %v/%q", backfiller.called, backfiller.cursor)
	}
	if len(store.runs) != 1 || store.runs[0].Status != "failed" || store.runs[0].CursorTo != summary.Cursor {
		t.Fatalf("runs=%+v summary=%+v", store.runs, summary)
	}
	retry, ok, decodeErr := decodeSalesforceRetryCursor(summary.Cursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", summary.Cursor, ok, decodeErr)
	}
	if retry.Cursor != baseCursor || retry.Attempts != 2 || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

type recordingSalesforceBackfiller struct {
	called bool
	cursor string
	err    error
}

func (r *recordingSalesforceBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	r.called = true
	r.cursor = cursor
	if r.err != nil {
		return SyncRequest{}, r.err
	}
	return SyncRequest{}, nil
}
