// SPDX-License-Identifier: AGPL-3.0-only

package reportstore

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

// The §16.5 matrix for seed cursors. This logic decides whether a mailbox
// re-ingests its entire history or goes permanently blind, and until now none
// of its branches had a test — the advance rules are pure arithmetic on
// server-supplied numbers, which is exactly the kind of code that survives a
// careless refactor while quietly changing behaviour.

func cursorStore(t *testing.T, ctx context.Context) (*PostgresStore, string) {
	t.Helper()
	pool := seedObservationDBPool(t, ctx)
	mailboxID := "mbx-" + uuid.NewString()
	t.Cleanup(func() {
		bg := context.Background()
		_, _ = pool.Exec(bg, `SELECT set_config('app.seed_observation_worker','true',false)`)
		_, _ = pool.Exec(bg, `DELETE FROM seed_mailbox_capture_cursor_events WHERE mailbox_id=$1`, mailboxID)
		_, _ = pool.Exec(bg, `DELETE FROM seed_mailbox_capture_cursors WHERE mailbox_id=$1`, mailboxID)
	})
	return &PostgresStore{Pool: pool}, mailboxID
}

func advance(t *testing.T, ctx context.Context, store *PostgresStore, mailboxID string,
	uidValidity, lastUID uint32, observedAt time.Time) {
	t.Helper()
	if err := store.AdvanceSeedMailboxCursors(ctx, mailboxID, []seedlist.FolderWatermark{{
		Folder: "INBOX", UIDValidity: uidValidity, LastUID: lastUID, ObservedAt: observedAt,
	}}); err != nil {
		t.Fatalf("advance(%d,%d): %v", uidValidity, lastUID, err)
	}
}

func readCursor(t *testing.T, ctx context.Context, store *PostgresStore, mailboxID string) seedlist.FolderCursor {
	t.Helper()
	cursors, err := store.LoadSeedMailboxCursors(ctx, mailboxID)
	if err != nil {
		t.Fatal(err)
	}
	return cursors["INBOX"]
}

func cursorEvents(t *testing.T, ctx context.Context, store *PostgresStore, mailboxID string) []string {
	t.Helper()
	// The events table's SELECT policy is scoped to app.seed_observation_worker.
	// Reading without it returns zero rows and no error, which would make every
	// assertion below pass vacuously — the same shape of trap as reading an
	// RLS-protected table on a connection that silently sees nothing.
	tx, err := store.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.seed_observation_worker','true',true)`); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query(ctx, `
SELECT event_type FROM seed_mailbox_capture_cursor_events
 WHERE mailbox_id=$1 ORDER BY recorded_at, id`, mailboxID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var events []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}

// A UIDVALIDITY change means the server renumbered the mailbox: every UID we
// stored now refers to a different message, or to none. Carrying the old
// LastUID forward would skip everything below it forever. The cursor must
// accept the new numbering and record that the reset happened.
func TestUIDValidityResetAdoptsTheNewNumberingAndBumpsGeneration(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, mailboxID := cursorStore(t, ctx)
	advance(t, ctx, store, mailboxID, 1000, 500, time.Now().UTC())
	before := readCursor(t, ctx, store, mailboxID)
	if before.UIDValidity != 1000 || before.LastUID != 500 {
		t.Fatalf("initial cursor not stored: %+v", before)
	}

	// New UIDVALIDITY with a LOWER UID. Under the same validity this would be a
	// regression and correctly ignored — the whole point is that it must not be
	// ignored here.
	advance(t, ctx, store, mailboxID, 2000, 7, time.Now().UTC())
	after := readCursor(t, ctx, store, mailboxID)
	if after.UIDValidity != 2000 || after.LastUID != 7 {
		t.Fatalf("cursor did not adopt the new numbering: %+v", after)
	}
	if after.Generation <= before.Generation {
		t.Fatalf("generation did not advance across the reset: %d -> %d",
			before.Generation, after.Generation)
	}
	events := cursorEvents(t, ctx, store, mailboxID)
	if len(events) < 2 || events[len(events)-1] != "uidvalidity_reset" {
		t.Fatalf("reset was not recorded as an event: %v", events)
	}
}

// A duplicate or out-of-order batch under the SAME validity must not roll the
// cursor backward; doing so would re-ingest everything between the two UIDs and
// duplicate every observation in that range.
func TestDuplicateAndRegressingUIDsDoNotRollTheCursorBackward(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, mailboxID := cursorStore(t, ctx)
	advance(t, ctx, store, mailboxID, 1000, 500, time.Now().UTC())
	advance(t, ctx, store, mailboxID, 1000, 500, time.Now().UTC()) // exact duplicate
	advance(t, ctx, store, mailboxID, 1000, 120, time.Now().UTC())

	cursor := readCursor(t, ctx, store, mailboxID)
	if cursor.LastUID != 500 {
		t.Fatalf("cursor rolled backward to %d", cursor.LastUID)
	}
	if cursor.UIDValidity != 1000 {
		t.Fatalf("validity changed unexpectedly: %+v", cursor)
	}
	// Neither a duplicate nor a regression is an advance, and neither may be
	// recorded as one — the event log is evidence of what actually moved, and a
	// spurious "advanced" row would make a stuck cursor look healthy.
	events := cursorEvents(t, ctx, store, mailboxID)
	created, advanced := 0, 0
	for _, event := range events {
		switch event {
		case "created":
			created++
		case "advanced":
			advanced++
		}
	}
	if created != 1 {
		t.Fatalf("expected exactly one creation event, got %d: %v", created, events)
	}
	if advanced != 0 {
		t.Fatalf("a duplicate or regression was recorded as an advance: %v", events)
	}
}

// Two pollers can overlap. The one whose observation is OLDER must not undo the
// newer one's progress, even though its numbers look valid in isolation.
func TestAStaleConcurrentPollCannotUndoNewerProgress(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, mailboxID := cursorStore(t, ctx)
	now := time.Now().UTC()

	advance(t, ctx, store, mailboxID, 1000, 900, now.Add(-time.Minute))
	// Arrives late, observed earlier, and carries a higher UID. Accepting it
	// would move the cursor on evidence that predates what we already stored.
	advance(t, ctx, store, mailboxID, 1000, 950, now.Add(-30*time.Minute))

	if cursor := readCursor(t, ctx, store, mailboxID); cursor.LastUID != 900 {
		t.Fatalf("a stale poll moved the cursor to %d", cursor.LastUID)
	}
}

// Ordinary forward progress must still work, or every guard above could be
// satisfied by a cursor that never moves at all.
func TestNormalAdvanceMovesTheCursorForward(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, mailboxID := cursorStore(t, ctx)
	advance(t, ctx, store, mailboxID, 1000, 10, time.Now().UTC())
	advance(t, ctx, store, mailboxID, 1000, 42, time.Now().UTC())

	cursor := readCursor(t, ctx, store, mailboxID)
	if cursor.LastUID != 42 || cursor.UIDValidity != 1000 {
		t.Fatalf("cursor did not advance: %+v", cursor)
	}
}

// An observation stamped in the future is a broken clock or a hostile input,
// and accepting it would pin the cursor against every later legitimate poll,
// which the stale-poll guard would then reject forever.
func TestAFutureObservationIsRefused(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store, mailboxID := cursorStore(t, ctx)

	err := store.AdvanceSeedMailboxCursors(ctx, mailboxID, []seedlist.FolderWatermark{{
		Folder: "INBOX", UIDValidity: 1000, LastUID: 5,
		ObservedAt: time.Now().UTC().Add(2 * time.Hour),
	}})
	if err == nil {
		t.Fatal("a future-dated observation was accepted")
	}
}
