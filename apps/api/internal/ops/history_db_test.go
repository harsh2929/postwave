// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"testing"
	"time"
)

// ops_check_history has been written on every status transition since
// migration 1700 and read by nothing. Without it the board can say "this is
// red" and "it first went red 19h ago", but not the two questions that decide
// what an operator actually does: has this been flapping, and has it ever
// been green?
func TestStore_HistoryReadsBackTheTransitions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	truncate(t, pool, "ops_check_results", "ops_check_history")
	store := NewStore(pool)

	base := time.Now().UTC().Add(-6 * time.Hour)
	var prev Result
	for i, st := range []Status{StatusOK, StatusRed, StatusOK, StatusRed} {
		at := base.Add(time.Duration(i) * time.Hour)
		if err := store.Upsert(ctx, "t.history", prev, st, string(st)+" detail", at); err != nil {
			t.Fatalf("Upsert %d: %v", i, err)
		}
		var err error
		if prev, err = store.Load(ctx, "t.history"); err != nil {
			t.Fatalf("Load %d: %v", i, err)
		}
	}

	entries, err := store.History(ctx, "t.history", 50)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("four transitions must be readable, got %d", len(entries))
	}
	// Newest first: an operator reads a timeline from now backwards.
	if entries[0].To != StatusRed || entries[len(entries)-1].From != "unknown" {
		t.Fatalf("history must be newest-first and record the first observation as coming from unknown, got %+v", entries)
	}
	for i := 1; i < len(entries); i++ {
		if entries[i].At.After(entries[i-1].At) {
			t.Fatalf("history must be ordered newest first, got %v before %v", entries[i-1].At, entries[i].At)
		}
	}
}

// A status that does not change writes no history row -- the reconciler only
// appends on transition. So a check red for a week has ONE row, and any
// "flapping" derivation must count transitions rather than observations or it
// would call a stable outage a flap.
func TestStore_HistoryOnlyRecordsTransitions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	truncate(t, pool, "ops_check_results", "ops_check_history")
	store := NewStore(pool)

	base := time.Now().UTC().Add(-3 * time.Hour)
	var prev Result
	for i := 0; i < 5; i++ {
		at := base.Add(time.Duration(i) * time.Minute)
		if err := store.Upsert(ctx, "t.stable", prev, StatusRed, "still red", at); err != nil {
			t.Fatalf("Upsert %d: %v", i, err)
		}
		var err error
		if prev, err = store.Load(ctx, "t.stable"); err != nil {
			t.Fatal(err)
		}
	}

	entries, err := store.History(ctx, "t.stable", 50)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("five identical observations are one transition, got %d rows", len(entries))
	}
}

// Flapping is the signal that separates "fix this" from "this check is
// wrong". A check crossing back and forth is usually a bad threshold, and
// treating it as an outage burns the team's attention on a measurement bug.
func TestFlapRate_CountsTransitionsInsideTheWindow(t *testing.T) {
	now := time.Now().UTC()
	entries := []HistoryEntry{
		{To: StatusRed, At: now.Add(-1 * time.Hour)},
		{To: StatusOK, At: now.Add(-2 * time.Hour)},
		{To: StatusRed, At: now.Add(-3 * time.Hour)},
		{To: StatusOK, At: now.Add(-30 * time.Hour)}, // outside a 24h window
	}
	if got := FlapCount(entries, now, 24*time.Hour); got != 3 {
		t.Fatalf("three transitions fall inside 24h, got %d", got)
	}
	if got := FlapCount(nil, now, 24*time.Hour); got != 0 {
		t.Fatalf("no history is no flapping, got %d", got)
	}
}
