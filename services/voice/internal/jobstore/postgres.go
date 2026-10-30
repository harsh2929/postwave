// Package jobstore is the Postgres-backed implementation of the voice
// ingest-job state machine.
//
// Lifecycle:
//
//	Create  → status='pending'   (handler, before dispatch)
//	Start   → status='running'   (worker goroutine, started_at = now())
//	Succeed → status='succeeded' (worker, item_count + finished_at)
//	Fail    → status='failed'    (worker, error_message + finished_at)
//
// The handler creates the row up front so the response can return a real
// job_id that the polling endpoint can find. If the goroutine panics or
// the host dies before reaching a terminal state the row will sit in
// 'running' forever — pruning that is a future concern (a reaper that
// flips stuck rows to 'failed' with a timeout error). For V1, refusing
// to re-dispatch over a stuck row is enough to stay safe.
package jobstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Status enumerates the job state machine. Mirror of the SQL CHECK constraint.
type Status string

const (
	StatusPending   Status = "pending"
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
)

// Job is the durable record returned by Get / passed back through the polling
// endpoint. JSON tags match the API contract advertised in the OpenAPI spec.
type Job struct {
	ID           string     `json:"id"`
	TenantID     string     `json:"tenant_id"`
	SourceID     string     `json:"source_id"`
	Status       Status     `json:"status"`
	ItemCount    int        `json:"item_count"`
	ErrorMessage string     `json:"error_message,omitempty"`
	StartedAt    *time.Time `json:"started_at,omitempty"`
	FinishedAt   *time.Time `json:"finished_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// Store wraps the pgx pool. All methods are tenant-scoped via the
// app.tenant_id GUC; RLS enforces isolation.
type Store struct {
	Pool *pgxpool.Pool
}

// ErrNotFound signals the row is absent (or RLS hid it from this tenant).
var ErrNotFound = errors.New("jobstore: not found")

// New constructs a Store. Returns an error on a nil pool so misconfiguration
// fails loudly at startup rather than at the first request.
func New(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &Store{Pool: p}, nil
}

// Create inserts a new job in 'pending'. Returns the freshly-allocated ID so
// the handler can return it to the caller before dispatching the goroutine.
func (s *Store) Create(ctx context.Context, tenantID, sourceID string) (string, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := uuid.NewString()
	_, err = tx.Exec(ctx, `
		INSERT INTO voice_ingest_jobs (id, tenant_id, source_id, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, 'pending')
	`, id, tenantID, sourceID)
	if err != nil {
		return "", fmt.Errorf("insert ingest job: %w", err)
	}
	return id, tx.Commit(ctx)
}

// Start flips a job from 'pending' to 'running' and records started_at.
// Idempotent: a no-op if the row is already past 'pending'.
func (s *Store) Start(ctx context.Context, tenantID, jobID string) error {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE voice_ingest_jobs
		   SET status = 'running', started_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'
	`, tenantID, jobID)
	if err != nil {
		return fmt.Errorf("start ingest job: %w", err)
	}
	return tx.Commit(ctx)
}

// Succeed transitions the job to 'succeeded' with the final item count.
func (s *Store) Succeed(ctx context.Context, tenantID, jobID string, itemCount int) error {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE voice_ingest_jobs
		   SET status = 'succeeded', item_count = $3, finished_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, jobID, itemCount)
	if err != nil {
		return fmt.Errorf("succeed ingest job: %w", err)
	}
	return tx.Commit(ctx)
}

// Fail transitions the job to 'failed' with an error message. The message
// is truncated to 1 KiB to keep stuck-job error rows bounded.
func (s *Store) Fail(ctx context.Context, tenantID, jobID, errMsg string) error {
	if len(errMsg) > 1024 {
		errMsg = errMsg[:1024]
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE voice_ingest_jobs
		   SET status = 'failed', error_message = $3, finished_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, jobID, errMsg)
	if err != nil {
		return fmt.Errorf("fail ingest job: %w", err)
	}
	return tx.Commit(ctx)
}

// Get returns one job for polling. RLS + the explicit tenant_id predicate
// belt-and-braces against cross-tenant peeks.
func (s *Store) Get(ctx context.Context, tenantID, jobID string) (Job, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var j Job
	var errMsg *string
	err = tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, source_id::text, status, item_count,
		       error_message, started_at, finished_at, created_at, updated_at
		  FROM voice_ingest_jobs
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, jobID).Scan(
		&j.ID, &j.TenantID, &j.SourceID, &j.Status, &j.ItemCount,
		&errMsg, &j.StartedAt, &j.FinishedAt, &j.CreatedAt, &j.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, fmt.Errorf("get ingest job: %w", err)
	}
	if errMsg != nil {
		j.ErrorMessage = *errMsg
	}
	return j, tx.Commit(ctx)
}

// beginTenant opens a tx and pins the tenant GUC so RLS scopes every read
// and write that follows. Same pattern as sourcestore / profilestore.
func (s *Store) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}
