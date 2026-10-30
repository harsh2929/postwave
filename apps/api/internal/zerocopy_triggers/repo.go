package zerocopy_triggers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// trigger columns used by every SELECT — keep one source of truth so
// scanTrigger and the INSERT/UPDATE projections stay in lock-step.
const triggerColumns = `id::text, tenant_id::text,
       COALESCE(connection_id::text, ''),
       COALESCE(journey_id::text, ''),
       name, description, status, provider,
       query, cursor_column, profile_key_column,
       last_seen_cursor, polling_interval_seconds, max_rows_per_tick,
       last_polled_at, last_success_at, last_error,
       consecutive_failures, rows_fired_total,
       config, created_at, updated_at`

// List returns triggers newest-first with keyset pagination on
// (updated_at, id). limit is the page size (the handler clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned
// when more rows remain. The optional status filter is unchanged.
//
// updated_at is mutable, so a row edited concurrently between page reads
// can shift across page boundaries — acceptable for this admin list.
func (r *Repo) List(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]Trigger, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when
	// paging) takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(status), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (updated_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT `+triggerColumns+`
FROM external_warehouse_triggers
WHERE tenant_id = $1::uuid AND ($2 = '' OR status = $2)
`+keyset+`
ORDER BY updated_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Trigger{}
	for rows.Next() {
		t, err := scanTrigger(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *t)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) Create(ctx context.Context, tenantID string, in Trigger) (*Trigger, error) {
	normalizeTrigger(&in)
	if requestsActiveRuntime(in) {
		return nil, ErrZeroCopyRuntimeUnavailable
	}
	config, _ := json.Marshal(in.Config)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO external_warehouse_triggers
    (tenant_id, connection_id, journey_id, name, description, status,
     provider, query, cursor_column, profile_key_column,
     last_seen_cursor, polling_interval_seconds, max_rows_per_tick, config)
VALUES
    ($1::uuid, NULLIF($2,'')::uuid, NULLIF($3,'')::uuid, $4, $5, $6,
     $7, $8, $9, $10,
     $11, $12, $13, $14::jsonb)
RETURNING `+triggerColumns,
		tenantID, in.ConnectionID, in.JourneyID, in.Name, in.Description, in.Status,
		in.Provider, in.Query, in.CursorColumn, in.ProfileKeyColumn,
		in.LastSeenCursor, in.PollingIntervalSeconds, in.MaxRowsPerTick, string(config))
	out, err := scanTrigger(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Trigger, error) {
	if strings.TrimSpace(id) == "" {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT `+triggerColumns+`
FROM external_warehouse_triggers
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	out, err := scanTrigger(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) Update(ctx context.Context, tenantID string, in Trigger) (*Trigger, error) {
	if strings.TrimSpace(in.ID) == "" {
		return nil, ErrNotFound
	}
	normalizeTrigger(&in)
	if requestsActiveRuntime(in) {
		return nil, ErrZeroCopyRuntimeUnavailable
	}
	config, _ := json.Marshal(in.Config)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE external_warehouse_triggers
   SET connection_id = NULLIF($3,'')::uuid,
       journey_id = NULLIF($4,'')::uuid,
       name = $5,
       description = $6,
       status = $7,
       provider = $8,
       query = $9,
       cursor_column = $10,
       profile_key_column = $11,
       polling_interval_seconds = $12,
       max_rows_per_tick = $13,
       config = $14::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
RETURNING `+triggerColumns,
		tenantID, in.ID, in.ConnectionID, in.JourneyID, in.Name, in.Description, in.Status,
		in.Provider, in.Query, in.CursorColumn, in.ProfileKeyColumn,
		in.PollingIntervalSeconds, in.MaxRowsPerTick, string(config))
	out, err := scanTrigger(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) Delete(ctx context.Context, tenantID, id string) error {
	if strings.TrimSpace(id) == "" {
		return ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM external_warehouse_triggers
WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ListDue returns active triggers whose next poll is in the past, ordered
// oldest-first so the worker drains the longest-overdue first. Bounded by
// `limit` so a single tick can't yank thousands of rows.
//
// The "due" predicate is:
//
//	status = 'active' AND (
//	    last_polled_at IS NULL
//	    OR last_polled_at + polling_interval_seconds <= now
//	)
//
// `now` is passed in so tests can pin time.
func (r *Repo) ListDue(ctx context.Context, now time.Time, limit int) ([]Trigger, error) {
	if !zeroCopyRuntimeQualified() {
		return nil, ErrZeroCopyRuntimeUnavailable
	}
	if limit <= 0 || limit > 1000 {
		limit = 50
	}
	// This deliberately bypasses tenant binding: the worker drains active
	// triggers across tenants, then PollOnce re-enters tenant scope for each
	// row it processes. The restrictive RLS policy allows this read only when
	// the explicit app.outbox_worker GUC is set on this acquired connection.
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SET app.outbox_worker = 'true'"); err != nil {
		// best-effort; if the GUC isn't recognized the WHERE still
		// constrains by status, but RLS may filter all rows. The
		// scaffold's noop driver makes this acceptable.
		_ = err
	}
	defer func() { _, _ = conn.Exec(context.Background(), "RESET app.outbox_worker") }()
	rows, err := conn.Query(ctx, `
SELECT `+triggerColumns+`
FROM external_warehouse_triggers
WHERE status = 'active'
  AND (last_polled_at IS NULL
       OR last_polled_at + (polling_interval_seconds * interval '1 second') <= $1)
ORDER BY last_polled_at NULLS FIRST
LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Trigger{}
	for rows.Next() {
		t, err := scanTrigger(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, rows.Err()
}

// RecordTick is invoked by the worker after a single poll attempt.
// `cursor` is the new last_seen_cursor (the worker computes max over the
// returned rows); pass "" to leave it unchanged. `firedRows` increments
// rows_fired_total. If `runErr` is non-empty, consecutive_failures is
// bumped and last_error is set; success resets both.
func (r *Repo) RecordTick(ctx context.Context, tenantID, triggerID, cursor string, firedRows int, runErr string, now time.Time) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if runErr != "" {
		if _, err := tx.Exec(ctx, `
UPDATE external_warehouse_triggers
   SET last_polled_at = $3,
       last_error = $4,
       consecutive_failures = consecutive_failures + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, triggerID, now, runErr); err != nil {
			return err
		}
	} else {
		if _, err := tx.Exec(ctx, `
UPDATE external_warehouse_triggers
   SET last_polled_at = $3,
       last_success_at = $3,
       last_error = '',
       consecutive_failures = 0,
       rows_fired_total = rows_fired_total + $4,
       last_seen_cursor = CASE WHEN $5 = '' THEN last_seen_cursor ELSE $5 END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, triggerID, now, firedRows, cursor); err != nil {
			return err
		}
	}
	// Read back the post-update failure streak so the alert evaluator can
	// compare it against the configured thresholds.
	var consecutiveFailures int
	_ = tx.QueryRow(ctx, `
SELECT consecutive_failures FROM external_warehouse_triggers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, triggerID).Scan(&consecutiveFailures)

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Evaluate alert thresholds. Previously these were stored and served but
	// never compared against anything, so a trigger could fail forever with no
	// alert. Best-effort and post-commit (its own tx) so an alert hiccup never
	// unwinds a recorded tick.
	if r.Alerts != nil {
		_ = EvaluateAndMaybeAlert(ctx, r.Alerts, r.Notifier, tenantID, triggerID, TickOutcome{
			ConsecutiveFailures: consecutiveFailures,
			FiresThisTick:       firedRows,
		}, now)
	}
	return nil
}

// RecordFire persists a single per-row fire ledger entry. The bigserial
// id is returned so the caller can correlate with their own logging.
func (r *Repo) RecordFire(ctx context.Context, tenantID string, in Fire) (int64, error) {
	if !zeroCopyRuntimeQualified() {
		return 0, ErrZeroCopyRuntimeUnavailable
	}
	payload, _ := json.Marshal(in.Payload)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	if err := tx.QueryRow(ctx, `
INSERT INTO external_warehouse_trigger_fires
    (tenant_id, trigger_id, flow_run_id, cursor_value, profile_key, subscriber_id, payload, status, error)
VALUES
    ($1::uuid, $2::uuid, NULLIF($3,'')::uuid, $4, $5, NULLIF($6,'')::uuid, $7::jsonb, $8, $9)
RETURNING id`,
		tenantID, in.TriggerID, in.FlowRunID, in.CursorValue, in.ProfileKey,
		in.SubscriberID, string(payload), in.Status, in.Error).Scan(&id); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return id, nil
}

// DefaultFireClaimLease bounds how long a `claimed` receipt blocks a re-claim.
//
// Long enough that a slow enqueue is never mistaken for a crash, short enough
// that a crashed worker's rows are recovered on a later tick. It is a recovery
// LATENCY, not a correctness knob — correctness comes from the claimed vs
// enqueueing distinction below, which is what makes a stale row's history
// knowable instead of guessed.
const DefaultFireClaimLease = 15 * time.Minute

// minFireClaimLease floors the lease.
//
// The lease is rendered as a Postgres interval from whole milliseconds, so a
// sub-millisecond value truncates to `0 milliseconds` and makes `fired_at <
// now() - interval '0'` true for every prior committed claim — every row
// instantly re-claimable, dedup silently disabled. `lease <= 0` alone did not
// catch that.
const minFireClaimLease = time.Second

// ClaimOutcome is what a claim attempt learned about a warehouse row.
type ClaimOutcome string

const (
	// ClaimAcquired: this poller owns the row and must process it.
	ClaimAcquired ClaimOutcome = "acquired"
	// ClaimHeld: another poller holds a fresh claim. Not ours, not finished —
	// the cursor must NOT advance past it.
	ClaimHeld ClaimOutcome = "held"
	// ClaimSettled: the row already reached a terminal status. Nothing to do,
	// and safe to advance past.
	ClaimSettled ClaimOutcome = "settled"
	// ClaimIndeterminate: a stale `enqueueing` row. It reached EnqueueRun and
	// we do not know whether the run was created, because `flow_runs` has no
	// idempotency key. Retrying risks a duplicate enrolment; dropping it risks
	// a lost one. Neither is ours to choose silently, so it is surfaced.
	ClaimIndeterminate ClaimOutcome = "indeterminate"
)

// ErrFireClaimLost is returned when a receipt mutation matched no row, meaning
// this poller no longer owns the claim it thought it held — the lease expired
// and another poller took it, or the row was already advanced. The caller must
// NOT proceed to enqueue, and must NOT settle the row's cursor.
var ErrFireClaimLost = errors.New("zerocopy_triggers: receipt claim lost")

// IndeterminateFireError is the marker written to a receipt whose enqueue
// outcome cannot be established. Matched by operators and by ListIndeterminate.
const IndeterminateFireError = "indeterminate_enqueue: the poller stopped between EnqueueRun and its receipt; flow_runs has no idempotency key, so neither retry nor discard is safe without checking the journey"

// ClaimFire durably reserves ONE warehouse row before it is enqueued, and
// reports what it found.
//
// This is the mechanism the runtime gate calls `durable_execution_receipts`.
// The poll loop advances a trigger's cursor over a batch, so without a receipt
// an interrupted batch re-reads and re-enqueues rows it had already enqueued.
// (Not an incident that has occurred: the subsystem has never executed. This is
// the precondition for opening the gate, not a repair.)
//
// The uniqueness lives in the database, not in a read-then-write check here:
// two replicas polling one trigger would both pass a SELECT before either
// INSERTed. The ON CONFLICT is what makes it a claim rather than a hope.
//
// The index is over md5(cursor_value), md5(profile_key) because both come
// straight from a customer's warehouse into unbounded `text` and btree caps an
// index tuple at 2704 bytes. The equality predicate below compares the VALUES
// as well, so a hash collision cannot merge two distinct rows — it would only
// cost an index probe.
func (r *Repo) ClaimFire(ctx context.Context, tenantID, triggerID, cursorValue, profileKey string, lease time.Duration) (int64, ClaimOutcome, error) {
	// Gated like every other mutation here. A claim is a durable write on the
	// path to enqueueing a journey run, so an ungated one would let a contained
	// runtime accumulate receipts for sends it must not make.
	if !zeroCopyRuntimeQualified() {
		return 0, "", ErrZeroCopyRuntimeUnavailable
	}
	if lease < minFireClaimLease {
		lease = DefaultFireClaimLease
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id int64
	var outcome string
	err = tx.QueryRow(ctx, `
WITH ins AS (
    INSERT INTO external_warehouse_trigger_fires
        (tenant_id, trigger_id, cursor_value, profile_key, status, fired_at)
    VALUES
        ($1::uuid, $2::uuid, $3, $4, 'claimed', now())
    ON CONFLICT (tenant_id, trigger_id, md5(cursor_value), md5(profile_key)) DO UPDATE
        SET fired_at = now()
        WHERE external_warehouse_trigger_fires.status = 'claimed'
          AND external_warehouse_trigger_fires.fired_at < now() - $5::interval
    RETURNING id
)
SELECT id, 'acquired'::text FROM ins
UNION ALL
SELECT f.id,
       CASE
         WHEN f.status = 'enqueueing' AND f.fired_at < now() - $5::interval THEN 'indeterminate'
         WHEN f.status IN ('claimed', 'enqueueing') THEN 'held'
         ELSE 'settled'
       END
  FROM external_warehouse_trigger_fires f
 WHERE f.tenant_id = $1::uuid
   AND f.trigger_id = $2::uuid
   AND md5(f.cursor_value) = md5($3)
   AND md5(f.profile_key) = md5($4)
   AND f.cursor_value = $3
   AND f.profile_key = $4
   AND NOT EXISTS (SELECT 1 FROM ins)
LIMIT 1`,
		tenantID, triggerID, cursorValue, profileKey,
		fmt.Sprintf("%d milliseconds", lease.Milliseconds()),
	).Scan(&id, &outcome)
	if errors.Is(err, pgx.ErrNoRows) {
		// Neither branch produced a row.
		//
		// The obvious cause is a concurrent DELETE, but an ordinary concurrent
		// INSERT reaches it too: the second branch reads the caller's snapshot,
		// so a row another poller committed AFTER this statement began is
		// invisible to it while still winning the ON CONFLICT. Either way this
		// poller does not own the row, so it is treated as HELD — the cursor
		// stays put and the next tick re-reads it. Reporting `settled` here
		// would advance past a row nobody has finished.
		return 0, ClaimHeld, nil
	}
	if err != nil {
		return 0, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	return id, ClaimOutcome(outcome), nil
}

// MarkEnqueueing records that a claimed row is ABOUT to be enqueued.
//
// The extra write is the whole point. Without it, a poller that stops after
// EnqueueRun leaves a row indistinguishable from one that stopped before it,
// and lease expiry has to guess: retry (duplicate enrolment) or drop (lost
// enrolment). With it, `claimed` provably means "never reached EnqueueRun" and
// is safe to recover, while `enqueueing` means "unknown" and is escalated.
//
// Only the enqueueing path pays for it; rows that end skipped_log_only or
// matched_no_subscriber go straight from claimed to terminal.
func (r *Repo) MarkEnqueueing(ctx context.Context, tenantID string, id int64) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE external_warehouse_trigger_fires
   SET status = 'enqueueing', fired_at = now()
 WHERE tenant_id = $1::uuid AND id = $2 AND status = 'claimed'`,
		tenantID, id)
	if err != nil {
		return err
	}
	// Rows-affected is the ownership check, not a diagnostic.
	//
	// `ClaimFire` hands out a second `acquired` for the same receipt once a
	// lease expires, so two pollers can hold the same id. Discarding the tag
	// made a 0-row UPDATE return nil, which the caller read as "the receipt
	// advanced" and went on to EnqueueRun — two live owners, both enqueueing,
	// which is exactly the duplicate enrolment this design exists to prevent.
	// The caller's comment said it refused to enqueue behind a receipt it could
	// not advance; without this, that was a comment rather than a check.
	if tag.RowsAffected() == 0 {
		return ErrFireClaimLost
	}
	return tx.Commit(ctx)
}

// FinishFire moves a receipt to its terminal status.
//
// Separate from ClaimFire because the claim must be durable BEFORE the enqueue
// and the outcome is only known after it. Collapsing them back into one write
// would put the receipt on the wrong side of the operation it protects.
func (r *Repo) FinishFire(ctx context.Context, tenantID string, id int64, in Fire) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	payload, _ := json.Marshal(in.Payload)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE external_warehouse_trigger_fires
SET flow_run_id   = NULLIF($3,'')::uuid,
    subscriber_id = NULLIF($4,'')::uuid,
    payload       = $5::jsonb,
    status        = $6,
    error         = $7
WHERE tenant_id = $1::uuid AND id = $2`,
		tenantID, id, in.FlowRunID, in.SubscriberID, string(payload),
		in.Status, in.Error); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkIndeterminate terminates a receipt whose enqueue outcome is unknowable.
//
// Terminal on purpose. Leaving it pending would block the trigger's cursor
// forever — one unknowable row would wedge the whole trigger — and auto-
// retrying it is the duplicate enrolment this design exists to avoid. It is NOT
// sent to the DLQ, because ReconcileDLQ replays pending entries through
// EnqueueRun, which is precisely the retry we must not perform. It is queryable
// via ListIndeterminate and counted for alerting.
func (r *Repo) MarkIndeterminate(ctx context.Context, tenantID string, id int64) error {
	if !zeroCopyRuntimeQualified() {
		return ErrZeroCopyRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE external_warehouse_trigger_fires
   SET status = 'error', error = $3
 WHERE tenant_id = $1::uuid AND id = $2 AND status = 'enqueueing'`,
		tenantID, id, IndeterminateFireError)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Someone else escalated or advanced it first. Not an error, but the
		// caller must not treat the row as settled on our say-so.
		return ErrFireClaimLost
	}
	return tx.Commit(ctx)
}

// ListIndeterminate returns receipts whose enqueue outcome could not be
// established, newest first. The operator-facing half of MarkIndeterminate:
// without a reader, "surfaced for a human" is a comment rather than a fact.
func (r *Repo) ListIndeterminate(ctx context.Context, tenantID string, limit int) ([]Fire, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, trigger_id::text, COALESCE(flow_run_id::text, ''),
       cursor_value, profile_key, COALESCE(subscriber_id::text, ''),
       status, error, fired_at
  FROM external_warehouse_trigger_fires
 WHERE tenant_id = $1::uuid AND status = 'error' AND error = $2
 ORDER BY fired_at DESC
 LIMIT $3`, tenantID, IndeterminateFireError, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Fire{}
	for rows.Next() {
		var f Fire
		if err := rows.Scan(&f.ID, &f.TriggerID, &f.FlowRunID, &f.CursorValue,
			&f.ProfileKey, &f.SubscriberID, &f.Status, &f.Error, &f.FiredAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *Repo) ListFires(ctx context.Context, tenantID, triggerID string, limit int) ([]Fire, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, trigger_id::text,
       COALESCE(flow_run_id::text, ''),
       cursor_value, profile_key,
       COALESCE(subscriber_id::text, ''),
       payload, status, error, fired_at
FROM external_warehouse_trigger_fires
WHERE tenant_id = $1::uuid AND trigger_id = $2::uuid
ORDER BY fired_at DESC
LIMIT $3`, tenantID, triggerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Fire{}
	for rows.Next() {
		var f Fire
		var raw []byte
		if err := rows.Scan(&f.ID, &f.TenantID, &f.TriggerID, &f.FlowRunID,
			&f.CursorValue, &f.ProfileKey, &f.SubscriberID, &raw, &f.Status,
			&f.Error, &f.FiredAt); err != nil {
			return nil, err
		}
		f.Payload = decodeMap(raw)
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ResolveSubscriberID maps a profile_key (email today, custom later) to
// a subscriber row. Returns "" if no match — the caller writes a
// matched_no_subscriber fire row in that case.
func (r *Repo) ResolveSubscriberID(ctx context.Context, tenantID, profileKey string) (string, error) {
	if !zeroCopyRuntimeQualified() {
		return "", ErrZeroCopyRuntimeUnavailable
	}
	profileKey = strings.TrimSpace(profileKey)
	if profileKey == "" {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	err = tx.QueryRow(ctx, `
SELECT id::text FROM subscribers
WHERE tenant_id = $1::uuid AND lower(email) = lower($2)
LIMIT 1`, tenantID, profileKey).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func scanTrigger(row pgx.Row) (*Trigger, error) {
	var out Trigger
	var configRaw []byte
	if err := row.Scan(
		&out.ID, &out.TenantID,
		&out.ConnectionID, &out.JourneyID,
		&out.Name, &out.Description, &out.Status, &out.Provider,
		&out.Query, &out.CursorColumn, &out.ProfileKeyColumn,
		&out.LastSeenCursor, &out.PollingIntervalSeconds, &out.MaxRowsPerTick,
		&out.LastPolledAt, &out.LastSuccessAt, &out.LastError,
		&out.ConsecutiveFailures, &out.RowsFiredTotal,
		&configRaw, &out.CreatedAt, &out.UpdatedAt,
	); err != nil {
		return nil, err
	}
	out.Config = decodeMap(configRaw)
	return &out, nil
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}
