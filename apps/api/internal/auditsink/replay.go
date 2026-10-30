// SPDX-License-Identifier: AGPL-3.0-only
//
// replay.go — cursor-based replay/backfill jobs for audit sinks.
//
// State machine:
//
//   pending     created via POST /api/v1/audit-sinks/{id}/replay.
//                 the worker picks these up on its next tick.
//   in_progress claimed by the worker; next_cursor_id moves forward
//                 as batches deliver. survives worker restart — the
//                 cursor lets the next tick resume exactly where it
//                 left off.
//   completed   every row in [from_audit_id, to_audit_id] has been
//                 delivered. terminal.
//   failed      circuit-breaker open beyond the cooldown ceiling, or
//                 a non-retryable delivery error. terminal — operator
//                 reviews last_error and either retries the job by
//                 creating a new one, or fixes the sink config.
//   cancelled   operator hit the cancel endpoint mid-flight. terminal.
//
// The worker reuses the existing delivery + circuit + DLQ machinery
// (see auditsink.go::processReplayJob). Replay jobs respect the
// per-sink BatchSize so a 100k-row backfill doesn't starve the live
// stream.

package auditsink

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// hexEncode is a tiny wrapper used by loadReplayBatch to keep its
// scan loop visually parallel to loadBatch in auditsink.go.
func hexEncode(b []byte) string { return hex.EncodeToString(b) }

// decodeRowJSON unmarshals the metadata column into the AuditRow.
// Wrapped so callers don't depend on encoding/json directly.
func decodeRowJSON(raw []byte, a *AuditRow) error {
	if len(raw) == 0 {
		a.Metadata = map[string]any{}
		return nil
	}
	return json.Unmarshal(raw, &a.Metadata)
}

// MaxReplayRowsPerJob is the per-job ceiling enforced by the API.
// Operators with larger ranges chain jobs (the UI surfaces this as
// "Job 1 of N" when the range is split automatically). 100k matches
// MaxExportRows in handlers/audit.go for symmetry — export and replay
// quote the same row count.
const MaxReplayRowsPerJob = 100_000

// ReplayJobStatus values stored in audit_sink_replay_jobs.status.
const (
	ReplayStatusPending    = "pending"
	ReplayStatusInProgress = "in_progress"
	ReplayStatusCompleted  = "completed"
	ReplayStatusFailed     = "failed"
	ReplayStatusCancelled  = "cancelled"
)

// ReplayJob is the wire shape returned by the read endpoints.
type ReplayJob struct {
	ID           string     `json:"id"`
	TenantID     string     `json:"tenant_id"`
	SinkID       string     `json:"sink_id"`
	FromAuditID  int64      `json:"from_audit_id"`
	ToAuditID    int64      `json:"to_audit_id"`
	Status       string     `json:"status"`
	RowsSent     int64      `json:"rows_sent"`
	RowsFailed   int64      `json:"rows_failed"`
	LastError    string     `json:"last_error,omitempty"`
	NextCursorID *int64     `json:"next_cursor_id,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	CompletedAt  *time.Time `json:"completed_at,omitempty"`
	CreatedBy    string     `json:"created_by,omitempty"`
}

// ReplayJobManager owns the lifecycle CRUD. Holds a *db.Pool so the
// API handler can call CreateReplayJob from the request goroutine
// without sharing state with the worker.
type ReplayJobManager struct {
	Pool *db.Pool
}

// CreateReplayJob inserts a new pending job. Caller is responsible
// for tenant-scoping (we run inside db.WithTenant so RLS enforces the
// sink belongs to the tenant).
func (m *ReplayJobManager) CreateReplayJob(ctx context.Context, tenantID, sinkID string, fromID, toID int64, createdBy string) (*ReplayJob, error) {
	// Pure-arg validation FIRST so unit tests can exercise these
	// without spinning up a pool — keeps the API contract testable.
	if fromID < 0 || toID < 0 {
		return nil, errors.New("replay manager: ids must be non-negative")
	}
	if fromID > toID {
		return nil, errors.New("replay manager: from_id must be <= to_id")
	}
	if toID-fromID+1 > MaxReplayRowsPerJob {
		return nil, fmt.Errorf("replay manager: range exceeds %d-row cap", MaxReplayRowsPerJob)
	}
	if m == nil || m.Pool == nil {
		return nil, errors.New("replay manager: pool required")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Sink existence + tenant ownership check (RLS enforces tenant_id
	// match; a missing row here means cross-tenant or no-such-sink).
	var ownerSink string
	if err := tx.QueryRow(ctx,
		`SELECT id::text FROM audit_sinks
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, sinkID).Scan(&ownerSink); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("sink not found")
		}
		return nil, err
	}
	out := &ReplayJob{
		TenantID:    tenantID,
		SinkID:      sinkID,
		FromAuditID: fromID,
		ToAuditID:   toID,
		Status:      ReplayStatusPending,
		CreatedBy:   createdBy,
	}
	err = tx.QueryRow(ctx, `
INSERT INTO audit_sink_replay_jobs
  (tenant_id, sink_id, from_audit_id, to_audit_id, created_by)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''))
RETURNING id::text, created_at`,
		tenantID, sinkID, fromID, toID, createdBy).Scan(&out.ID, &out.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetReplayJob returns a single job. Tenant-scoped via the GUC.
func (m *ReplayJobManager) GetReplayJob(ctx context.Context, tenantID, jobID string) (*ReplayJob, error) {
	if m == nil || m.Pool == nil {
		return nil, errors.New("replay manager: pool required")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, sink_id::text,
       from_audit_id, to_audit_id, status,
       rows_sent, rows_failed,
       COALESCE(last_error, ''),
       next_cursor_id,
       created_at, started_at, completed_at,
       COALESCE(created_by, '')
  FROM audit_sink_replay_jobs
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, jobID)
	out := &ReplayJob{}
	var startedAt, completedAt *time.Time
	if err := row.Scan(&out.ID, &out.TenantID, &out.SinkID,
		&out.FromAuditID, &out.ToAuditID, &out.Status,
		&out.RowsSent, &out.RowsFailed,
		&out.LastError, &out.NextCursorID,
		&out.CreatedAt, &startedAt, &completedAt,
		&out.CreatedBy); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errors.New("job not found")
		}
		return nil, err
	}
	out.StartedAt = startedAt
	out.CompletedAt = completedAt
	_ = tx.Commit(ctx)
	return out, nil
}

// ListReplayJobs returns jobs for a sink, newest first, with opaque
// cursor pagination. Cursor is the job UUID; results are stable
// because created_at is monotone per-tenant + secondary ordered by id.
func (m *ReplayJobManager) ListReplayJobs(ctx context.Context, tenantID, sinkID, cursor string, limit int) ([]*ReplayJob, string, error) {
	if m == nil || m.Pool == nil {
		return nil, "", errors.New("replay manager: pool required")
	}
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, sink_id::text,
       from_audit_id, to_audit_id, status,
       rows_sent, rows_failed,
       COALESCE(last_error, ''),
       next_cursor_id,
       created_at, started_at, completed_at,
       COALESCE(created_by, '')
  FROM audit_sink_replay_jobs
 WHERE tenant_id = $1::uuid
   AND sink_id = $2::uuid
   AND ($3 = '' OR id < $3::uuid)
 ORDER BY id DESC
 LIMIT $4`, tenantID, sinkID, cursor, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []*ReplayJob{}
	for rows.Next() {
		j := &ReplayJob{}
		var startedAt, completedAt *time.Time
		if err := rows.Scan(&j.ID, &j.TenantID, &j.SinkID,
			&j.FromAuditID, &j.ToAuditID, &j.Status,
			&j.RowsSent, &j.RowsFailed,
			&j.LastError, &j.NextCursorID,
			&j.CreatedAt, &startedAt, &completedAt,
			&j.CreatedBy); err != nil {
			return nil, "", err
		}
		j.StartedAt = startedAt
		j.CompletedAt = completedAt
		out = append(out, j)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	_ = tx.Commit(ctx)
	nextCursor := ""
	if len(out) > limit {
		nextCursor = out[limit-1].ID
		out = out[:limit]
	}
	return out, nextCursor, nil
}

// CancelReplayJob marks a pending/in_progress job cancelled. No-op on
// terminal jobs.
func (m *ReplayJobManager) CancelReplayJob(ctx context.Context, tenantID, jobID string) error {
	if m == nil || m.Pool == nil {
		return errors.New("replay manager: pool required")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET status = 'cancelled',
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status IN ('pending', 'in_progress')`, tenantID, jobID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("job not found or already terminal")
	}
	return tx.Commit(ctx)
}

// ---------- worker-side helpers (called from auditsink.go::processReplayJob) ----------

// claimReplayJob picks the oldest pending job for a sink, transitions
// it to in_progress, and returns it for the worker to process. Uses
// FOR UPDATE SKIP LOCKED so two worker replicas can each grab a
// distinct job without contention.
func (d *Deps) claimReplayJob(ctx context.Context, sinkID string) (*ReplayJob, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, sink_id::text,
       from_audit_id, to_audit_id, status,
       rows_sent, rows_failed,
       COALESCE(last_error, ''),
       next_cursor_id,
       created_at, started_at, completed_at,
       COALESCE(created_by, '')
  FROM audit_sink_replay_jobs
 WHERE sink_id = $1::uuid
   AND status IN ('pending', 'in_progress')
 ORDER BY created_at ASC
 LIMIT 1
 FOR UPDATE SKIP LOCKED`, sinkID)
	j := &ReplayJob{}
	var startedAt, completedAt *time.Time
	if err := row.Scan(&j.ID, &j.TenantID, &j.SinkID,
		&j.FromAuditID, &j.ToAuditID, &j.Status,
		&j.RowsSent, &j.RowsFailed,
		&j.LastError, &j.NextCursorID,
		&j.CreatedAt, &startedAt, &completedAt,
		&j.CreatedBy); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	j.StartedAt = startedAt
	j.CompletedAt = completedAt
	if j.Status == ReplayStatusPending {
		if _, err := tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET status = 'in_progress', started_at = COALESCE(started_at, now()), updated_at = now()
 WHERE id = $1::uuid`, j.ID); err != nil {
			return nil, err
		}
		j.Status = ReplayStatusInProgress
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return j, nil
}

// loadReplayBatch reads audit_log rows in [cursor+1, toID] for the
// tenant, capped at limit. cursor=0 means "start from from_audit_id".
func (d *Deps) loadReplayBatch(ctx context.Context, tenantID string, cursor, fromID, toID int64, limit int) ([]AuditRow, error) {
	startAt := cursor
	if startAt < fromID-1 {
		// First batch — anchor at fromID-1 so the `> $2` predicate
		// includes fromID itself.
		startAt = fromID - 1
	}
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text,
       COALESCE(user_id::text,''), action,
       COALESCE(resource_type,''), COALESCE(resource_id,''),
       COALESCE(metadata, '{}'::jsonb),
       COALESCE(host(ip), ''), COALESCE(user_agent, ''),
       COALESCE(actor_type, 'human'), COALESCE(actor_label, ''),
       at,
       COALESCE(prev_hash, ''::bytea),
       COALESCE(row_hash, ''::bytea),
       COALESCE(event_id::text, '')
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND id > $2
   AND id <= $3
 ORDER BY id ASC
 LIMIT $4`, tenantID, startAt, toID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditRow{}
	for rows.Next() {
		var a AuditRow
		var meta []byte
		var prevHash, rowHash []byte
		if err := rows.Scan(&a.ID, &a.TenantID, &a.UserID, &a.Action,
			&a.ResourceType, &a.ResourceID, &meta, &a.IP, &a.UserAgent,
			&a.ActorType, &a.ActorLabel, &a.At, &prevHash, &rowHash,
			&a.EventID); err != nil {
			return nil, err
		}
		if err := decodeRowJSON(meta, &a); err != nil {
			return nil, err
		}
		if len(rowHash) > 0 {
			a.RowHash = hexEncode(rowHash)
		}
		if len(prevHash) > 0 {
			a.PrevHash = hexEncode(prevHash)
		}
		if a.EventID == "" {
			a.EventID = DeriveEventID(a.TenantID, a.Action,
				a.ResourceType, a.ResourceID, a.ActorLabel, a.At)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// MarkReplayInProgress is a thin helper used by tests + the API layer
// when manually advancing a job (e.g. after a synchronous probe).
func (m *ReplayJobManager) MarkReplayInProgress(ctx context.Context, tenantID, jobID string) error {
	if m == nil || m.Pool == nil {
		return errors.New("replay manager: pool required")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET status = 'in_progress',
       started_at = COALESCE(started_at, now()),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, jobID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkReplayCompleted flips a job to completed (rows fully delivered).
func (m *ReplayJobManager) MarkReplayCompleted(ctx context.Context, tenantID, jobID string) error {
	if m == nil || m.Pool == nil {
		return errors.New("replay manager: pool required")
	}
	tx, err := db.WithTenant(ctx, m.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET status = 'completed',
       completed_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, jobID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// advanceReplayCursor stamps next_cursor_id + rows_sent after each
// successful batch delivery. Worker-side helper.
func (d *Deps) advanceReplayCursor(ctx context.Context, jobID string, newCursor int64, deliveredCount int64) error {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET next_cursor_id = $2,
       rows_sent = rows_sent + $3,
       updated_at = now()
 WHERE id = $1::uuid`, jobID, newCursor, deliveredCount)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// markReplayFailed records a terminal failure with last_error. Used by
// the worker when a batch errors out + the breaker can't progress.
func (d *Deps) markReplayFailed(ctx context.Context, jobID string, errMsg string, rowsFailed int64) error {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if len(errMsg) > 4096 {
		errMsg = errMsg[:4096]
	}
	_, err = tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET status = 'failed',
       last_error = $2,
       rows_failed = rows_failed + $3,
       completed_at = now(),
       updated_at = now()
 WHERE id = $1::uuid`, jobID, errMsg, rowsFailed)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// markReplayCompleted (worker version, doesn't need tenant_id).
func (d *Deps) markReplayCompleted(ctx context.Context, jobID string) error {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE audit_sink_replay_jobs
   SET status = 'completed',
       completed_at = now(),
       updated_at = now()
 WHERE id = $1::uuid`, jobID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
