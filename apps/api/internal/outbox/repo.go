// SPDX-License-Identifier: AGPL-3.0-only
package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Store is the persistence surface used by Worker. The pgx Repo in this
// package implements it; tests may substitute a fake.
type Store interface {
	// Append writes an outbox row inside the caller-supplied tx. Callers
	// pass the SAME tx that mutates business state so the side-effect
	// intent is durable iff that state commits.
	Append(ctx context.Context, tx pgx.Tx, in Append) (string, error)
	// Claim leases up to limit available events for ownerID. Returns
	// ErrNoEvents when nothing is claimable.
	Claim(ctx context.Context, ownerID string, leaseTTL time.Duration, limit int) ([]Event, error)
	// Complete marks a successful event terminal.
	Complete(ctx context.Context, eventID, ownerID string) error
	// Fail bumps attempts, sets last_error, and either re-queues with a
	// future available_at OR moves to the DLQ when attempts exceeds max.
	Fail(ctx context.Context, eventID, ownerID, errMsg string, retryAt time.Time, dead bool) error
	// Renew extends the lease on a running event. Workers call this for
	// long-running handlers; ErrLeaseLost means another worker took over.
	Renew(ctx context.Context, eventID, ownerID string, leaseTTL time.Duration) error
}

// ErrLeaseLost is returned by Renew/Complete/Fail when the row's
// claimed_by no longer matches us. The handler should abandon — another
// worker now owns this event.
var ErrLeaseLost = errors.New("outbox: lease lost")

// Repo is the pgx-backed Store implementation.
type Repo struct {
	Pool *db.Pool
}

// Append inserts an outbox row inside the caller's tenant-scoped tx. The
// row's tenant_id MUST equal the tx's app.tenant_id (RLS will reject
// otherwise) — we read TenantID from the Append struct rather than
// inferring from the tx so callers cannot accidentally cross-write.
func (r *Repo) Append(ctx context.Context, tx pgx.Tx, in Append) (string, error) {
	if in.TenantID == "" {
		return "", fmt.Errorf("outbox: TenantID required")
	}
	if in.Kind == "" {
		return "", fmt.Errorf("outbox: Kind required")
	}
	max := in.MaxAttempts
	if max <= 0 {
		max = DefaultMaxAttempts
	}
	available := in.AvailableAt
	if available.IsZero() {
		available = time.Now().UTC()
	}
	payload, err := marshalPayload(in.Payload)
	if err != nil {
		return "", fmt.Errorf("outbox: marshal payload: %w", err)
	}
	var id string
	err = tx.QueryRow(ctx, `
		INSERT INTO outbox_events (tenant_id, kind, payload, available_at, max_attempts)
		VALUES ($1::uuid, $2, $3::jsonb, $4, $5)
		RETURNING id::text
	`, in.TenantID, in.Kind, string(payload), available, max).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("outbox: insert: %w", err)
	}
	return id, nil
}

// AppendMany inserts a bounded set of transactional intents in one statement.
// It has the same validation/default semantics as Append, but deliberately
// returns no row ids: bulk business operations only need the all-or-nothing
// durability guarantee and would otherwise pay one database round trip per
// subject. The supplied transaction remains authoritative, so any malformed
// payload or insert failure rolls back the parent mutation as well.
func (r *Repo) AppendMany(ctx context.Context, tx pgx.Tx, inputs []Append) error {
	if len(inputs) == 0 {
		return nil
	}
	tenantIDs := make([]string, 0, len(inputs))
	kinds := make([]string, 0, len(inputs))
	payloads := make([]string, 0, len(inputs))
	availableAt := make([]time.Time, 0, len(inputs))
	maxAttempts := make([]int, 0, len(inputs))
	for index, in := range inputs {
		if in.TenantID == "" {
			return fmt.Errorf("outbox: input %d TenantID required", index)
		}
		if in.Kind == "" {
			return fmt.Errorf("outbox: input %d Kind required", index)
		}
		payload, err := marshalPayload(in.Payload)
		if err != nil {
			return fmt.Errorf("outbox: input %d marshal payload: %w", index, err)
		}
		available := in.AvailableAt
		if available.IsZero() {
			available = time.Now().UTC()
		}
		max := in.MaxAttempts
		if max <= 0 {
			max = DefaultMaxAttempts
		}
		tenantIDs = append(tenantIDs, in.TenantID)
		kinds = append(kinds, in.Kind)
		payloads = append(payloads, string(payload))
		availableAt = append(availableAt, available)
		maxAttempts = append(maxAttempts, max)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO outbox_events
		       (tenant_id, kind, payload, available_at, max_attempts)
		SELECT batch.tenant_id::uuid,
		       batch.kind,
		       batch.payload::jsonb,
		       batch.available_at,
		       batch.max_attempts
		  FROM unnest(
		       $1::text[], $2::text[], $3::text[],
		       $4::timestamptz[], $5::integer[]
		  ) AS batch(tenant_id, kind, payload, available_at, max_attempts)
	`, tenantIDs, kinds, payloads, availableAt, maxAttempts); err != nil {
		return fmt.Errorf("outbox: batch insert: %w", err)
	}
	return nil
}

// Claim leases up to `limit` events for `ownerID`. Two-step:
//
//  1. SELECT FOR UPDATE SKIP LOCKED to pick candidate ids platform-wide
//     (under the worker permissive policy).
//  2. UPDATE the picked ids, returning the full rows.
//
// Concurrent workers cooperate cleanly — the first SKIP LOCKED never
// hands the same id to two workers, so the UPDATE is contention-free.
func (r *Repo) Claim(ctx context.Context, ownerID string, leaseTTL time.Duration, limit int) ([]Event, error) {
	if ownerID == "" {
		return nil, fmt.Errorf("outbox: ownerID required")
	}
	if leaseTTL <= 0 {
		return nil, fmt.Errorf("outbox: leaseTTL must be positive")
	}
	if limit <= 0 {
		limit = DefaultClaimBatch
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Enable the worker policy for this transaction. Permissive worker_*
	// policies allow cross-tenant reads/writes; the tenant_id column is
	// still preserved on every row so handlers can re-scope.
	if _, err := tx.Exec(ctx, `
		SELECT set_config('app.outbox_worker', 'true', true),
		       set_config('app.device_signin_outbox_worker', 'true', true)`); err != nil {
		return nil, fmt.Errorf("outbox: enable worker scope: %w", err)
	}

	rows, err := tx.Query(ctx, `
		WITH picked AS (
			SELECT id
			  FROM outbox_events
			 WHERE completed_at IS NULL
			   AND failed_at IS NULL
			   AND available_at <= now()
			   AND (claimed_until IS NULL OR claimed_until < now())
			 ORDER BY available_at ASC
			 FOR UPDATE SKIP LOCKED
			 LIMIT $1
		)
		UPDATE outbox_events o
		   SET claimed_by   = $2::uuid,
		       claimed_until = now() + ($3::text)::interval,
		       attempts     = o.attempts + 1,
		       updated_at   = now()
		  FROM picked
		 WHERE o.id = picked.id
		 RETURNING o.id::text, o.tenant_id::text, o.kind, o.payload,
		           o.available_at, o.attempts, o.max_attempts,
		           COALESCE(o.last_error, ''), o.created_at
	`, limit, ownerID, fmt.Sprintf("%d milliseconds", leaseTTL.Milliseconds()))
	if err != nil {
		return nil, fmt.Errorf("outbox: claim: %w", err)
	}
	defer rows.Close()

	out := []Event{}
	for rows.Next() {
		var ev Event
		var payloadRaw []byte
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.Kind, &payloadRaw,
			&ev.AvailableAt, &ev.Attempts, &ev.MaxAttempts, &ev.LastError, &ev.CreatedAt); err != nil {
			return nil, err
		}
		ev.Payload = append(json.RawMessage(nil), payloadRaw...)
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNoEvents
	}
	return out, nil
}

// Complete marks a successful event terminal.
func (r *Repo) Complete(ctx context.Context, eventID, ownerID string) error {
	tag, err := r.workerExec(ctx, `
		UPDATE outbox_events
		   SET completed_at = now(),
		       claimed_by = NULL,
		       claimed_until = NULL,
		       updated_at = now()
		 WHERE id = $1::uuid AND claimed_by = $2::uuid AND completed_at IS NULL
	`, eventID, ownerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// Fail bumps last_error and either re-queues at retryAt or DLQs.
func (r *Repo) Fail(ctx context.Context, eventID, ownerID, errMsg string, retryAt time.Time, dead bool) error {
	if dead {
		tag, err := r.workerExec(ctx, `
			UPDATE outbox_events
			   SET failed_at = now(),
			       last_error = $3,
			       claimed_by = NULL,
			       claimed_until = NULL,
			       updated_at = now()
			 WHERE id = $1::uuid AND claimed_by = $2::uuid AND failed_at IS NULL
		`, eventID, ownerID, errMsg)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrLeaseLost
		}
		return nil
	}
	tag, err := r.workerExec(ctx, `
		UPDATE outbox_events
		   SET available_at = $3,
		       last_error   = $4,
		       claimed_by   = NULL,
		       claimed_until = NULL,
		       updated_at   = now()
		 WHERE id = $1::uuid AND claimed_by = $2::uuid AND completed_at IS NULL AND failed_at IS NULL
	`, eventID, ownerID, retryAt, errMsg)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// Renew extends the lease on a held event.
func (r *Repo) Renew(ctx context.Context, eventID, ownerID string, leaseTTL time.Duration) error {
	tag, err := r.workerExec(ctx, `
		UPDATE outbox_events
		   SET claimed_until = now() + ($3::text)::interval,
		       updated_at    = now()
		 WHERE id = $1::uuid AND claimed_by = $2::uuid AND completed_at IS NULL AND failed_at IS NULL
	`, eventID, ownerID, fmt.Sprintf("%d milliseconds", leaseTTL.Milliseconds()))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return nil
}

// workerExec runs an UPDATE under the app.outbox_worker permissive policy.
// The device-signin capability marks this as a new worker that has the
// corresponding handler; migration 1857 hides that kind from older generic
// workers so a mixed-version replica cannot claim and immediately DLQ it.
// We open a fresh tx, set both GUCs, run the statement, commit.
func (r *Repo) workerExec(ctx context.Context, sql string, args ...any) (pgxCommandTag, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return pgxCommandTag{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		SELECT set_config('app.outbox_worker', 'true', true),
		       set_config('app.device_signin_outbox_worker', 'true', true)`); err != nil {
		return pgxCommandTag{}, err
	}
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return pgxCommandTag{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return pgxCommandTag{}, err
	}
	return pgxCommandTag{n: tag.RowsAffected()}, nil
}

// pgxCommandTag is the minimal subset of pgconn.CommandTag we need; using
// our own struct keeps the signature import-free for callers.
type pgxCommandTag struct{ n int64 }

func (t pgxCommandTag) RowsAffected() int64 { return t.n }

// DLQEntry is the polling-shape view of a dead-letter row. Surfaces in
// the admin UI so operators can see what side effects dropped on the
// floor and decide whether to replay.
type DLQEntry struct {
	ID          string    `json:"id"`
	TenantID    string    `json:"tenant_id"`
	Kind        string    `json:"kind"`
	Payload     []byte    `json:"payload"`
	Attempts    int       `json:"attempts"`
	MaxAttempts int       `json:"max_attempts"`
	LastError   string    `json:"last_error,omitempty"`
	FailedAt    time.Time `json:"failed_at"`
	CreatedAt   time.Time `json:"created_at"`
}

// ListDLQ returns DLQ entries for a tenant (newest-first). Bounded
// at 200; the admin UI paginates by failed_at + an "older than"
// cursor when needed.
func (r *Repo) ListDLQ(ctx context.Context, tenantID string, limit int) ([]DLQEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, kind, payload, attempts, max_attempts,
       COALESCE(last_error, ''), failed_at, created_at
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND failed_at IS NOT NULL
 ORDER BY failed_at DESC
 LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DLQEntry{}
	for rows.Next() {
		var d DLQEntry
		if err := rows.Scan(&d.ID, &d.TenantID, &d.Kind, &d.Payload,
			&d.Attempts, &d.MaxAttempts, &d.LastError, &d.FailedAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ReplayDLQ resets a failed row so the worker can pick it up again.
// Clears failed_at + last_error + attempts; sets available_at = now().
//
// Idempotent: replaying a row that already drained successfully
// returns ErrNoEvents (no row matched the failed_at IS NOT NULL
// predicate). Replaying twice while the row is in-flight is harmless
// — the worker's lease check rejects the second attempt.
func (r *Repo) ReplayDLQ(ctx context.Context, tenantID, id string) error {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE outbox_events
   SET failed_at = NULL,
       last_error = NULL,
       attempts = 0,
       claimed_by = NULL,
       claimed_until = NULL,
       available_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND failed_at IS NOT NULL`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNoEvents
	}
	return tx.Commit(ctx)
}

func marshalPayload(in any) ([]byte, error) {
	if in == nil {
		return []byte("{}"), nil
	}
	if raw, ok := in.(json.RawMessage); ok {
		if len(raw) == 0 {
			return []byte("{}"), nil
		}
		return raw, nil
	}
	if raw, ok := in.([]byte); ok {
		return raw, nil
	}
	return json.Marshal(in)
}
