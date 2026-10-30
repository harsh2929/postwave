// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestHubSpotRetryCursorRoundTrip(t *testing.T) {
	underlying := encodeHubSpotCursor(hubSpotCursorState{Object: "contacts", After: "abc"})
	encoded := encodeHubSpotRetryCursor(hubSpotRetryState{
		Cursor:        underlying,
		Attempts:      2,
		NextAttemptAt: "2026-06-20T12:30:00Z",
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "boom",
	})
	if !strings.HasPrefix(encoded, hubSpotRetryCursorPrefix) {
		t.Fatalf("encoded retry cursor missing prefix: %q", encoded)
	}
	state, ok, err := decodeHubSpotRetryCursor(encoded)
	if err != nil || !ok {
		t.Fatalf("decode: ok=%v err=%v", ok, err)
	}
	if state.Cursor != underlying || state.Attempts != 2 || state.NextAttemptAt != "2026-06-20T12:30:00Z" {
		t.Fatalf("round-trip mismatch: %+v", state)
	}
}

func TestHubSpotRetryCursorIgnoresNonRetryCursor(t *testing.T) {
	_, ok, err := decodeHubSpotRetryCursor(encodeHubSpotCursor(hubSpotCursorState{Object: "contacts"}))
	if err != nil || ok {
		t.Fatalf("plain cursor should not decode as retry: ok=%v err=%v", ok, err)
	}
}

func TestHubSpotRetryCursorDue(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	if !hubSpotRetryCursorDue(hubSpotRetryState{}, now) {
		t.Fatal("empty next-attempt should be due")
	}
	if !hubSpotRetryCursorDue(hubSpotRetryState{NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339)}, now) {
		t.Fatal("past next-attempt should be due")
	}
	if hubSpotRetryCursorDue(hubSpotRetryState{NextAttemptAt: now.Add(time.Minute).Format(time.RFC3339)}, now) {
		t.Fatal("future next-attempt should not be due")
	}
}

func TestHubSpotBackfillRetryCursorIncrementsAndSchedules(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	base := encodeHubSpotCursor(hubSpotCursorState{Object: "contacts"})
	cursor := hubSpotBackfillRetryCursor(base, "BACKFILL_FAILED", HubSpotRateLimitError{StatusCode: 500}, now)
	state, ok, err := decodeHubSpotRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode: ok=%v err=%v", ok, err)
	}
	if state.Attempts != 1 {
		t.Fatalf("attempts = %d, want 1", state.Attempts)
	}
	next, err := time.Parse(time.RFC3339, state.NextAttemptAt)
	if err != nil || !next.After(now) {
		t.Fatalf("next attempt should be scheduled in the future: %q (%v)", state.NextAttemptAt, err)
	}
	// A second failure increments attempts and backs off further.
	cursor2 := hubSpotBackfillRetryCursor(cursor, "BACKFILL_FAILED", nil, now)
	state2, _, _ := decodeHubSpotRetryCursor(cursor2)
	if state2.Attempts != 2 {
		t.Fatalf("attempts = %d, want 2", state2.Attempts)
	}
}

func TestHubSpotBackfillRetryCursorPreservesListMembershipState(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	base := encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: "456", After: "abc"})
	cursor := hubSpotBackfillRetryCursor(base, "BACKFILL_FAILED", HubSpotRateLimitError{StatusCode: 429, RetryAfter: 90 * time.Second}, now)
	state, ok, err := decodeHubSpotRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode: ok=%v err=%v", ok, err)
	}
	if state.Object != "list_memberships" || state.ListID != "456" || state.ProviderCursor != "abc" {
		t.Fatalf("state=%+v", state)
	}
	underlying, err := decodeHubSpotCursor(state.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if underlying.Object != "list_memberships" || underlying.ListID != "456" || underlying.After != "abc" {
		t.Fatalf("underlying=%+v", underlying)
	}
}

func TestHubSpotBackfillRetryCursorPreservesDealsState(t *testing.T) {
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	base := encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-after"})
	cursor := hubSpotBackfillRetryCursor(base, "BACKFILL_FAILED", HubSpotRateLimitError{StatusCode: 429, RetryAfter: 90 * time.Second}, now)
	state, ok, err := decodeHubSpotRetryCursor(cursor)
	if err != nil || !ok {
		t.Fatalf("decode: ok=%v err=%v", ok, err)
	}
	if state.Object != "deals" || state.ProviderCursor != "deal-after" {
		t.Fatalf("state=%+v", state)
	}
	underlying, err := decodeHubSpotCursor(state.Cursor)
	if err != nil {
		t.Fatal(err)
	}
	if underlying.Object != "deals" || underlying.After != "deal-after" {
		t.Fatalf("underlying=%+v", underlying)
	}
}

func TestHubSpotRetryDelayHonorsRetryAfter(t *testing.T) {
	delay := hubSpotRetryDelay(1, HubSpotRateLimitError{RetryAfter: 90 * time.Second})
	if delay != 90*time.Second {
		t.Fatalf("delay = %v, want 90s from Retry-After", delay)
	}
	if d := hubSpotRetryDelay(1, nil); d != hubSpotRetryInitialDelay {
		t.Fatalf("first attempt delay = %v, want %v", d, hubSpotRetryInitialDelay)
	}
}

func TestHubSpotBackfillRunnerSkipsDisconnectedIntegration(t *testing.T) {
	store := newFakeStore()
	store.integration.Status = "disconnected"
	store.integration.SyncCursor = encodeHubSpotCursor(hubSpotCursorState{Object: "list_memberships", ListID: "456"})
	backfiller := &recordingHubSpotBackfiller{}

	summary, err := (HubSpotBackfillRunner{
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
		t.Fatal("disconnected integration should not call HubSpot backfiller")
	}
	if len(store.runs) != 0 {
		t.Fatalf("disconnected integration should not record runs: %+v", store.runs)
	}
	if summary.IntegrationID != store.integration.ID || summary.Cursor != store.integration.SyncCursor || summary.LastError != "" {
		t.Fatalf("summary=%+v", summary)
	}
}

func TestHubSpotBackfillRunnerPreservesRetryAttemptsOnRepeatedFailure(t *testing.T) {
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	baseCursor := encodeHubSpotCursor(hubSpotCursorState{Object: "deals", After: "deal-cursor-100"})
	retryCursor := encodeHubSpotRetryCursor(hubSpotRetryState{
		Cursor:        baseCursor,
		Attempts:      1,
		LastStatus:    "BACKFILL_FAILED",
		LastError:     "provider throttled",
		NextAttemptAt: now.Add(-time.Minute).Format(time.RFC3339),
	})
	providerErr := HubSpotRateLimitError{
		Path:       "/crm/v3/objects/deals",
		StatusCode: 429,
		RetryAfter: 2 * time.Minute,
		Snippet:    "slow down",
	}
	store := newFakeStore()
	store.integration.SyncCursor = retryCursor
	backfiller := &recordingHubSpotBackfiller{err: providerErr}

	summary, err := (HubSpotBackfillRunner{
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
	retry, ok, decodeErr := decodeHubSpotRetryCursor(summary.Cursor)
	if decodeErr != nil || !ok {
		t.Fatalf("retry cursor=%q ok=%v err=%v", summary.Cursor, ok, decodeErr)
	}
	if retry.Cursor != baseCursor || retry.Attempts != 2 || retry.NextAttemptAt != now.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("retry=%+v", retry)
	}
}

type recordingHubSpotBackfiller struct {
	called bool
	cursor string
	err    error
}

func (r *recordingHubSpotBackfiller) BackfillPage(_ context.Context, _ string, _ Integration, cursor string) (SyncRequest, error) {
	r.called = true
	r.cursor = cursor
	if r.err != nil {
		return SyncRequest{}, r.err
	}
	return SyncRequest{}, nil
}
