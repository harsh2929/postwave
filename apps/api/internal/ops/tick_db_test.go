// SPDX-License-Identifier: AGPL-3.0-only

package ops

import (
	"context"
	"testing"
	"time"
)

// ops_manual_log has existed since migration 1700 with grants and indexes and
// exactly zero code paths -- the same shape as dsar_policies, the dead table
// this package's own registry comment cites as the reason the check registry
// is compiled rather than configured. A recurring chore is only a control if
// ticking it is recorded; otherwise "did we do the access review" is answered
// from memory.
func TestStore_TickRecordsTheChoreAndRearmsTheClock(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	truncate(t, pool, "ops_check_results", "ops_check_history", "ops_manual_log")
	store := NewStore(pool)
	operator := seedOperator(t, pool, "tick-test@postwave.local", []string{"127.0.0.1/32"})

	chore := Check{
		ID: "security.access-review", Domain: "security", Owner: "security",
		Kind: KindManual, Cadence: 90 * 24 * time.Hour,
		Severity: SevHigh, Why: "w", Remediation: "r",
	}

	// Never ticked: the zero Result derives to DUE, which is correct -- a
	// chore nobody has ever done is not a chore that is up to date.
	before, err := store.Load(ctx, chore.ID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := before.Effective(time.Now().UTC(), chore); got != StatusDue {
		t.Fatalf("an un-ticked chore must derive to due, got %q", got)
	}

	at := time.Now().UTC()
	if err := store.Tick(ctx, chore.ID, operator, "reviewed 4 operators, removed 1", at); err != nil {
		t.Fatalf("Tick: %v", err)
	}

	after, err := store.Load(ctx, chore.ID)
	if err != nil {
		t.Fatalf("Load after tick: %v", err)
	}
	if got := after.Effective(at.Add(time.Hour), chore); got != StatusOK {
		t.Fatalf("a freshly ticked chore is OK until its cadence elapses, got %q", got)
	}
	// And it re-arms rather than being satisfied forever.
	if got := after.Effective(at.Add(91*24*time.Hour), chore); got != StatusDue {
		t.Fatalf("past the cadence the chore must come due again, got %q", got)
	}

	var note, actor string
	if err := pool.QueryRow(ctx,
		`SELECT note, operator_id::text FROM ops_manual_log WHERE check_id = $1`, chore.ID).
		Scan(&note, &actor); err != nil {
		t.Fatalf("the tick must leave an ops_manual_log row: %v", err)
	}
	if note != "reviewed 4 operators, removed 1" || actor != operator {
		t.Fatalf("the log must record who ticked it and what they said, got note=%q actor=%q", note, actor)
	}
}

// The log is the evidence trail, so each tick appends rather than replacing.
// "When was this last done" and "has this ever been skipped" are different
// questions and only an append-only log answers the second.
func TestStore_TickAppendsRatherThanOverwrites(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	truncate(t, pool, "ops_check_results", "ops_check_history", "ops_manual_log")
	store := NewStore(pool)
	operator := seedOperator(t, pool, "tick-append@postwave.local", []string{"127.0.0.1/32"})

	at := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if err := store.Tick(ctx, "database.restore-drill", operator, "drill", at.Add(time.Duration(i)*time.Hour)); err != nil {
			t.Fatalf("Tick %d: %v", i, err)
		}
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM ops_manual_log WHERE check_id = 'database.restore-drill'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("three ticks must leave three log rows, got %d", n)
	}
}

// A tick with no note is a click. The note is the whole evidentiary value of
// the record, so an empty one is refused the same way an empty snooze reason
// is.
func TestStore_TickRequiresANote(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	truncate(t, pool, "ops_check_results", "ops_check_history", "ops_manual_log")
	store := NewStore(pool)
	operator := seedOperator(t, pool, "tick-note@postwave.local", []string{"127.0.0.1/32"})

	if err := store.Tick(ctx, "security.access-review", operator, "   ", time.Now().UTC()); err == nil {
		t.Fatal("a tick with a blank note must be refused: an unexplained tick is a click, not evidence")
	}
}
