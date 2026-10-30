// SPDX-License-Identifier: AGPL-3.0-only
package zerocopy_triggers

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/activation_firewall"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The cursor is a watermark over the longest SETTLED PREFIX, not a running max.
//
// An earlier revision advanced `maxCursor` at the top of the loop for every row
// examined, before the claim and before the consent gate. A row that could not
// be processed — held by another poller, or whose claim errored — was stepped
// over and never read again, because every driver filters
// `WHERE <cursor> > :last_seen_cursor`. There was no fire row, no DLQ entry, no
// log line and no counter: a silent drop, which is strictly worse than the
// duplicate the receipt was added to prevent.
//
// These drive the real PollOnce against a real database, because the defect
// lives in the interaction between the loop, the receipt table and the cursor —
// none of which a unit test with a fake repo can see.

type watermarkDriver struct{ rows []DriverRow }

func (d watermarkDriver) Poll(_ context.Context, _ Trigger, _ int) ([]DriverRow, error) {
	return d.rows, nil
}

type watermarkEnqueuer struct{ calls []string }

func (e *watermarkEnqueuer) EnqueueRun(_ context.Context, _ string, req EnqueueRequest) (string, error) {
	e.calls = append(e.calls, req.SubscriberID)
	return "00000000-0000-0000-0000-000000000001", nil
}

func TestPollDoesNotAdvanceThecursorPastAHeldRow(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	rows := []DriverRow{
		{CursorValue: "2026-08-04T09:00:01Z", ProfileKey: "r1@example.com"},
		{CursorValue: "2026-08-04T09:00:02Z", ProfileKey: "r2@example.com"},
		{CursorValue: "2026-08-04T09:00:03Z", ProfileKey: "r3@example.com"},
	}
	RegisterDriver("postgres", watermarkDriver{rows: rows})

	// Another poller is mid-flight on r2 — a fresh claim it has not settled.
	if _, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID,
		"2026-08-04T09:00:02Z", "r2@example.com", time.Hour); err != nil || outcome != ClaimAcquired {
		t.Fatalf("seed held claim = (%q, %v)", outcome, err)
	}

	trig := loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC()); err != nil {
		t.Fatalf("poll: %v", err)
	}

	after := loadTrigger(t, repo, tenantID, triggerID)
	if after.LastSeenCursor >= "2026-08-04T09:00:02Z" {
		t.Fatalf("cursor advanced to %q, past a row another poller still holds. "+
			"No later tick can re-read it — the row is lost with no receipt, no DLQ "+
			"entry and no log line.", after.LastSeenCursor)
	}
	if after.LastSeenCursor != "2026-08-04T09:00:01Z" {
		t.Fatalf("cursor = %q, want the settled prefix to end at r1", after.LastSeenCursor)
	}
}

func TestPollAdvancesTheCursorOverAFullySettledBatch(t *testing.T) {
	// The watermark must not be so conservative that a clean batch stalls.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: "2026-08-04T10:00:01Z", ProfileKey: "s1@example.com"},
		{CursorValue: "2026-08-04T10:00:02Z", ProfileKey: "s2@example.com"},
	}})

	trig := loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	after := loadTrigger(t, repo, tenantID, triggerID)
	if after.LastSeenCursor != "2026-08-04T10:00:02Z" {
		t.Fatalf("cursor = %q, want the whole settled batch consumed", after.LastSeenCursor)
	}
}

func TestPollRefusesToAdvanceOnOutOfOrderRows(t *testing.T) {
	// A prefix watermark is only meaningful if rows arrive in cursor order.
	// Operators own the query, so that is not something to assume: when it does
	// not hold the cursor stays put and the batch is re-read, rather than
	// advancing to a position that skipped an unsettled row.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: "2026-08-04T11:00:09Z", ProfileKey: "o1@example.com"},
		{CursorValue: "2026-08-04T11:00:01Z", ProfileKey: "o2@example.com"},
	}})

	trig := loadTrigger(t, repo, tenantID, triggerID)
	before := trig.LastSeenCursor
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	after := loadTrigger(t, repo, tenantID, triggerID)
	if after.LastSeenCursor != before {
		t.Fatalf("cursor moved to %q on out-of-order rows; want it to stay at %q", after.LastSeenCursor, before)
	}
}

func TestPollDoesNotReEnqueueAnAlreadySettledRow(t *testing.T) {
	// The receipt's whole purpose, end to end: a re-poll of the same warehouse
	// row must not produce a second journey enrolment.
	//
	// The trigger needs a journey_id AND the profile key must resolve to a real
	// subscriber. Without both, every row takes the skipped_log_only or
	// matched_no_subscriber branch, EnqueueRun is never reached on EITHER poll,
	// and "the second poll enqueued nothing" is true whether the receipt works
	// or not. This test passed identically with the receipt removed entirely
	// before that was fixed — a test written from the same assumption as the
	// code, certifying the assumption.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	email := "d1@example.com"
	attachJourney(t, pool, tenantID, triggerID)
	seedSubscriber(t, pool, tenantID, email)

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: "2026-08-04T12:00:01Z", ProfileKey: email},
	}})

	trig := loadTrigger(t, repo, tenantID, triggerID)
	first := &watermarkEnqueuer{}
	if _, err := pollOnceQualified(ctx, repo, first, tenantID, trig, time.Now().UTC(), alwaysKeep); err != nil {
		t.Fatalf("first poll: %v", err)
	}
	if len(first.calls) != 1 {
		t.Fatalf("first poll enqueued %d run(s), want 1 — if it is 0 this test proves nothing", len(first.calls))
	}

	// Simulate the cursor write having been lost: re-poll from the same
	// position with the same rows.
	resetCursor(t, pool, tenantID, triggerID)
	second := &watermarkEnqueuer{}
	trig = loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, second, tenantID, trig, time.Now().UTC(), alwaysKeep); err != nil {
		t.Fatalf("second poll: %v", err)
	}
	if len(second.calls) != 0 {
		t.Fatalf("re-poll enqueued %d run(s) for a row that already has a settled receipt", len(second.calls))
	}
}

// The Critical an adversarial panel sustained unanimously.
//
// Two rows can share one cursor value — the default cursor column is
// `updated_at`, and the receipt's unique key is (cursor_value, profile_key)
// precisely because cursor_value does not identify a row. A per-ROW prefix
// watermark published the shared value as soon as the FIRST of them settled,
// and nothing the second row did afterwards could take it back. `WHERE
// <cursor> > :last_seen_cursor` then never returned it again.
func TestPollDoesNotAdvancePastAHeldRowSharingItsCursorValue(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	const tied = "2026-08-04T13:00:00Z"

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: tied, ProfileKey: "eq1@example.com"},
		{CursorValue: tied, ProfileKey: "eq2@example.com"},
	}})

	// Another poller holds a fresh claim on the SECOND row of the tied group.
	if _, outcome, err := repo.ClaimFire(ctx, tenantID, triggerID, tied, "eq2@example.com", time.Hour); err != nil || outcome != ClaimAcquired {
		t.Fatalf("seed held claim = (%q, %v)", outcome, err)
	}

	trig := loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC()); err != nil {
		t.Fatalf("poll: %v", err)
	}

	after := loadTrigger(t, repo, tenantID, triggerID)
	if after.LastSeenCursor >= tied {
		t.Fatalf("cursor advanced to %q, at or past the cursor of a row another poller still HOLDS. "+
			"Drivers resume with `> last_seen_cursor`, so that row is now unreachable forever.",
			after.LastSeenCursor)
	}
}

func TestPollWithholdsAPossiblyTruncatedFinalGroup(t *testing.T) {
	// A batch that came back FULL may have cut a cursor-value group in half:
	// rows sharing the last value could be waiting on the other side of the
	// LIMIT. Publishing that value skips them on the completely healthy path —
	// no crash, no concurrency, no error.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	setRowLimit(t, pool, tenantID, triggerID, 2)

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: "2026-08-04T14:00:01Z", ProfileKey: "t1@example.com"},
		{CursorValue: "2026-08-04T14:00:02Z", ProfileKey: "t2@example.com"},
	}})

	trig := loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	after := loadTrigger(t, repo, tenantID, triggerID)
	if after.LastSeenCursor != "2026-08-04T14:00:01Z" {
		t.Fatalf("cursor = %q, want the last COMPLETE group only — the final value may be truncated",
			after.LastSeenCursor)
	}
}

func TestPollSettlesEveryRowOfACompleteTiedGroup(t *testing.T) {
	// The conservative rule must not stall a healthy batch: when every row of a
	// tied group settles, the group publishes.
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	const tied = "2026-08-04T15:00:00Z"

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: "2026-08-04T14:59:00Z", ProfileKey: "p0@example.com"},
		{CursorValue: tied, ProfileKey: "p1@example.com"},
		{CursorValue: tied, ProfileKey: "p2@example.com"},
	}})

	trig := loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	after := loadTrigger(t, repo, tenantID, triggerID)
	if after.LastSeenCursor != tied {
		t.Fatalf("cursor = %q, want %q — a fully settled tied group must publish", after.LastSeenCursor, tied)
	}
}

// A row the consent firewall never RULED on is not a row it withheld.
// normalizeEmails drops blank keys before Decide partitions, so such a row is
// in neither Kept nor Excluded; reading that absence as "withheld" settled its
// cursor with no receipt at all.
func TestPollDoesNotTreatAnUnevaluatedRowAsWithheld(t *testing.T) {
	pool, tenantID, triggerID := seedTriggerForReceipts(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	attachJourney(t, pool, tenantID, triggerID)

	RegisterDriver("postgres", watermarkDriver{rows: []DriverRow{
		{CursorValue: "2026-08-04T16:00:01Z", ProfileKey: "   "}, // blank cell
	}})

	trig := loadTrigger(t, repo, tenantID, triggerID)
	if _, err := pollOnceQualified(ctx, repo, &watermarkEnqueuer{}, tenantID, trig, time.Now().UTC(), alwaysKeep); err != nil {
		t.Fatalf("poll: %v", err)
	}
	fires, err := repo.ListFires(ctx, tenantID, triggerID, 10)
	if err != nil {
		t.Fatalf("list fires: %v", err)
	}
	if len(fires) == 0 {
		t.Fatal("a row the firewall never evaluated was settled with NO receipt — it is gone with no evidence anywhere")
	}
}

// alwaysKeep is a consent gate that rules on every key it is given. It ONLY
// returns keys it was asked about, exactly as the real firewall does, so a
// blank key is absent from both sets here too.
func alwaysKeep(_ context.Context, _, _ string, keys []string) (map[string]bool, []activation_firewall.ExclusionRecord) {
	kept := make(map[string]bool, len(keys))
	for _, k := range keys {
		n := strings.ToLower(strings.TrimSpace(k))
		if n == "" {
			continue
		}
		kept[n] = true
	}
	return kept, nil
}

func loadTrigger(t *testing.T, repo *Repo, tenantID, triggerID string) *Trigger {
	t.Helper()
	trig, err := repo.Get(context.Background(), tenantID, triggerID)
	if err != nil {
		t.Fatalf("load trigger: %v", err)
	}
	return trig
}

func resetCursor(t *testing.T, pool *db.Pool, tenantID, triggerID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reset tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE external_warehouse_triggers SET last_seen_cursor = ''
		  WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, triggerID); err != nil {
		t.Fatalf("reset cursor: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("reset commit: %v", err)
	}
}

func attachJourney(t *testing.T, pool *db.Pool, tenantID, triggerID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("journey tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	journeyID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`UPDATE external_warehouse_triggers SET journey_id = $3::uuid
		  WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, triggerID, journeyID); err != nil {
		t.Fatalf("attach journey: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("journey commit: %v", err)
	}
}

func seedSubscriber(t *testing.T, pool *db.Pool, tenantID, email string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
		 VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'import')`,
		uuid.NewString(), tenantID, email); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("subscriber commit: %v", err)
	}
}

func setRowLimit(t *testing.T, pool *db.Pool, tenantID, triggerID string, limit int) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("limit tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE external_warehouse_triggers SET max_rows_per_tick = $3
		  WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, triggerID, limit); err != nil {
		t.Fatalf("set row limit: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("limit commit: %v", err)
	}
}
