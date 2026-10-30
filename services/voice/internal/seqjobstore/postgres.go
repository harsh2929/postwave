// Package seqjobstore is the Postgres-backed state machine for
// sequence-generation jobs.
//
// Lifecycle (mirrors jobstore for ingest):
//
//	Create  → status='pending'   (handler, before dispatch)
//	Start   → status='running'   (worker goroutine, started_at = now())
//	Succeed → status='succeeded' (worker, sequence_id + finished_at)
//	Fail    → status='failed'    (worker, error_message + finished_at)
//
// The handler creates the row up front so the response can return a
// real job_id that the polling endpoint can find. If the goroutine
// panics or the host dies before reaching a terminal state, the row
// sits in 'running' until a future reaper sweeps it; for V1, refusing
// to re-dispatch over a stuck row is enough to stay safe.
package seqjobstore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Status enumerates the job state machine. Mirror of the SQL CHECK.
type Status string

const (
	StatusPending   Status = "pending"
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
)

// Job is the polling-shape view of a sequence generation run.
type Job struct {
	ID            string     `json:"id"`
	TenantID      string     `json:"tenant_id"`
	SequenceID    string     `json:"sequence_id,omitempty"`
	EmailPosition *int       `json:"email_position,omitempty"`
	Status        Status     `json:"status"`
	ErrorMessage  string     `json:"error_message,omitempty"`
	StartedAt     *time.Time `json:"started_at,omitempty"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// Store wraps the pgx pool. All methods are tenant-scoped via the
// app.tenant_id GUC; RLS enforces isolation.
type Store struct {
	Pool *pgxpool.Pool
}

// ErrNotFound signals the row is absent (or RLS hid it from this tenant).
var ErrNotFound = errors.New("seqjobstore: not found")

// New constructs a Store. Returns an error on a nil pool so misconfig
// fails loudly at startup rather than at the first request.
func New(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &Store{Pool: p}, nil
}

// Create inserts a new job in 'pending'. Returns the freshly-allocated ID
// so the handler can return it before dispatching the goroutine.
//
// `request` is the snapshot we marshal into the row's request column so a
// whole-sequence generation worker can pick it up after a restart. New
// regeneration previews do not use jobs because this schema has no isolated
// result field; sequenceID and position remain supported for reading legacy
// regeneration-job rows created before that safety boundary. Pass empty / nil
// for whole-sequence generation jobs.
func (s *Store) Create(
	ctx context.Context,
	tenantID string,
	sequenceID string,
	emailPosition *int,
	request any,
) (string, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	id := uuid.NewString()
	requestBytes, err := json.Marshal(request)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	// sequence_id is set up-front only for legacy regeneration jobs (where the
	// target already exists) and left NULL for whole-sequence generation (where
	// it is filled in on Succeed).
	var sequenceArg any
	if sequenceID != "" {
		sequenceArg = sequenceID
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO voice_sequence_jobs
			(id, tenant_id, sequence_id, email_position, request, status)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'pending')
	`, id, tenantID, sequenceArg, emailPosition, string(requestBytes))
	if err != nil {
		return "", fmt.Errorf("insert sequence job: %w", err)
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
		UPDATE voice_sequence_jobs
		   SET status = 'running', started_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'pending'
	`, tenantID, jobID)
	if err != nil {
		return fmt.Errorf("start sequence job: %w", err)
	}
	return tx.Commit(ctx)
}

// Succeed transitions the job to 'succeeded' and records the produced
// sequence_id. The CHECK constraint on the table enforces that
// succeeded rows always carry a sequence_id.
func (s *Store) Succeed(ctx context.Context, tenantID, jobID, sequenceID string) error {
	if sequenceID == "" {
		return errors.New("sequenceID required for Succeed (CHECK constraint)")
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE voice_sequence_jobs
		   SET status = 'succeeded', sequence_id = $3::uuid, finished_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, jobID, sequenceID)
	if err != nil {
		return fmt.Errorf("succeed sequence job: %w", err)
	}
	return tx.Commit(ctx)
}

// Fail transitions the job to 'failed' with an error message. The
// message is truncated to 1 KiB to keep stuck-job error rows bounded.
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
		UPDATE voice_sequence_jobs
		   SET status = 'failed', error_message = $3, finished_at = now()
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, jobID, errMsg)
	if err != nil {
		return fmt.Errorf("fail sequence job: %w", err)
	}
	return tx.Commit(ctx)
}

// Get returns one job for polling. RLS plus the explicit tenant_id
// predicate are belt-and-braces against cross-tenant peeks.
func (s *Store) Get(ctx context.Context, tenantID, jobID string) (Job, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return Job{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var j Job
	var (
		seqID    *string
		errMsg   *string
		position *int
	)
	err = tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, sequence_id::text, email_position,
		       status, error_message, started_at, finished_at,
		       created_at, updated_at
		  FROM voice_sequence_jobs
		 WHERE tenant_id = $1::uuid AND id = $2::uuid
	`, tenantID, jobID).Scan(
		&j.ID, &j.TenantID, &seqID, &position,
		&j.Status, &errMsg, &j.StartedAt, &j.FinishedAt,
		&j.CreatedAt, &j.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Job{}, ErrNotFound
	}
	if err != nil {
		return Job{}, fmt.Errorf("get sequence job: %w", err)
	}
	if seqID != nil {
		j.SequenceID = *seqID
	}
	if errMsg != nil {
		j.ErrorMessage = *errMsg
	}
	j.EmailPosition = position
	return j, tx.Commit(ctx)
}

// beginTenant pins the tenant GUC so RLS scopes every read + write
// that follows. Same pattern as jobstore / sourcestore / profilestore.
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
