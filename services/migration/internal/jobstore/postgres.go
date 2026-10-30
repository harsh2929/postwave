// Package jobstore provides a Postgres-backed implementation of the
// MigrationJobStore interface used by services/migration/internal/handlers.
//
// Handlers depend on MigrationJobStore so main.go can use Postgres when
// DATABASE_URL is reachable and fall back to MemoryJobStore for local tests.
package jobstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

type tenantContextKey struct{}

// WithTenantID attaches the authenticated tenant to store calls that only carry
// a job id. Postgres uses it to set the RLS GUC inside the transaction.
func WithTenantID(ctx context.Context, tenantID string) context.Context {
	if tenantID == "" {
		return ctx
	}
	return context.WithValue(ctx, tenantContextKey{}, tenantID)
}

// TenantIDFromContext returns the tenant attached by WithTenantID.
func TenantIDFromContext(ctx context.Context) (string, bool) {
	tenantID, ok := ctx.Value(tenantContextKey{}).(string)
	return tenantID, ok && tenantID != ""
}

// MigrationJobStore is the persistence contract used by handlers.
type MigrationJobStore interface {
	Create(ctx context.Context, job *canonical.MigrationJob) error
	Get(ctx context.Context, id string) (*canonical.MigrationJob, error)
	Update(ctx context.Context, job *canonical.MigrationJob) error
	UpdateProgress(ctx context.Context, id string, p canonical.MigrationProgress) error
	UpdateStatus(ctx context.Context, id string, status canonical.MigrationStatus, errMsg string) error
	// UpdateAnnotations sets only the operator label/notes (MIGR-037), leaving
	// every lifecycle column untouched so the worker can never clobber them.
	UpdateAnnotations(ctx context.Context, id string, label, notes *string) error
	List(ctx context.Context, tenantID string) ([]canonical.MigrationJob, error)
	SaveOAuthState(ctx context.Context, state OAuthStateRecord) error
	ConsumeOAuthState(ctx context.Context, tenantID, state string, now time.Time) (OAuthStateRecord, error)
	SaveSession(ctx context.Context, jobID, tenantID string, sess adapter.Session, expiresAt time.Time) error
	GetSession(ctx context.Context, tenantID, jobID string, now time.Time) (adapter.Session, error)
	GetSessionInfo(ctx context.Context, tenantID, jobID string, now time.Time) (SessionInfo, error)
	DeleteSession(ctx context.Context, tenantID, jobID string) error
}

// LeasingJobStore is implemented by stores that can atomically grant a
// per-worker lease on a runnable job. The Postgres store uses
// FOR UPDATE SKIP LOCKED so multi-instance deployments cannot pick up the
// same job twice. Worker code is expected to:
//
//  1. ClaimJob(ctx, ownerID, ttl) — receives at most one job
//  2. RenewLease(ctx, jobID, ownerID, ttl) — call periodically while running
//  3. ReleaseLease(ctx, jobID, ownerID) — on terminal status (or let it expire)
//
// ErrJobNotClaimable is returned when no runnable job is currently free.
type LeasingJobStore interface {
	ClaimJob(ctx context.Context, ownerID string, leaseTTL time.Duration) (*canonical.MigrationJob, error)
	RenewLease(ctx context.Context, jobID, ownerID string, leaseTTL time.Duration) error
	ReleaseLease(ctx context.Context, jobID, ownerID string) error
}

// StatusTransitionJobStore atomically replaces a job only when its durable
// status is one of expected. HTTP state-machine entry points use this instead
// of a read-then-unconditional Update so concurrent resume, delta, and
// rollback requests cannot all commit from the same stale snapshot.
type StatusTransitionJobStore interface {
	UpdateIfStatus(ctx context.Context, job *canonical.MigrationJob, expected ...canonical.MigrationStatus) error
}

// CancellationJobStore records an operator cancellation without replacing the
// job's mutable checkpoint fields. A remote worker may commit progress between
// the handler's read and this write, so cancellation must update only lifecycle
// state or a stale handler could rewind the cursor it is trying to stop.
type CancellationJobStore interface {
	CancelIfStatus(ctx context.Context, id, errMsg string, rollbackUntil *time.Time, expected ...canonical.MigrationStatus) error
}

// ErrJobNotClaimable is returned by ClaimJob when no runnable job is
// currently unleased / past its lease TTL.
var ErrJobNotClaimable = errors.New("jobstore: no claimable job available")

// ErrLeaseLost is returned when RenewLease/ReleaseLease finds that another
// worker has taken the lease (the row's lease_owner doesn't match ours).
// The current worker should abandon its execution: another instance owns it.
var ErrLeaseLost = errors.New("jobstore: lease lost; another worker owns this job")

// ErrStatusTransitionConflict means the job still exists in the caller's
// tenant but its status changed before an expected-status update committed.
var ErrStatusTransitionConflict = errors.New("jobstore: migration status transition conflict")

// RunnableJobStore is implemented by stores that can discover jobs left in a
// runnable state after a service restart. The HTTP handler uses this for a
// local durable worker loop; stores that cannot enumerate runnable jobs still
// work for request-scoped execution.
type RunnableJobStore interface {
	ListRunnable(ctx context.Context) ([]canonical.MigrationJob, error)
}

// OAuthStateRecord is the durable CSRF state used during provider OAuth.
type OAuthStateRecord struct {
	State     string
	TenantID  string
	Source    canonical.SourcePlatform
	CreatedAt time.Time
	ExpiresAt time.Time
}

// SessionInfo is the non-secret migration source session metadata returned to
// handlers so clients can warn before a reconnect is required.
type SessionInfo struct {
	Source              canonical.SourcePlatform `json:"source"`
	ExpiresAt           time.Time                `json:"expires_at"`
	LastUsedAt          *time.Time               `json:"last_used_at,omitempty"`
	SelectedAudienceIDs []string                 `json:"selected_audience_ids,omitempty"`
}

// ShadowMonitorRecord schedules periodic source rediscovery during a customer
// pilot. The completed check retains discovery totals and, for sources that
// support it, bounded content fingerprints; delta-import performs the replay.
type ShadowMonitorRecord struct {
	JobID                 string                   `json:"job_id"`
	TenantID              string                   `json:"tenant_id"`
	Source                canonical.SourcePlatform `json:"source"`
	Enabled               bool                     `json:"enabled"`
	IntervalSeconds       int                      `json:"interval_seconds"`
	LastCheckedAt         *time.Time               `json:"last_checked_at,omitempty"`
	NextCheckAt           *time.Time               `json:"next_check_at,omitempty"`
	LastRecommendedAction string                   `json:"last_recommended_action,omitempty"`
	LastError             string                   `json:"last_error,omitempty"`
	CreatedAt             time.Time                `json:"created_at"`
	UpdatedAt             time.Time                `json:"updated_at"`
}

// ShadowCheckRecord stores the immutable outcome of one shadow check.
type ShadowCheckRecord struct {
	ID                string                   `json:"id"`
	JobID             string                   `json:"job_id"`
	TenantID          string                   `json:"tenant_id"`
	Source            canonical.SourcePlatform `json:"source"`
	GeneratedAt       time.Time                `json:"generated_at"`
	NeedsDeltaImport  bool                     `json:"needs_delta_import"`
	RecommendedAction string                   `json:"recommended_action"`
	Error             string                   `json:"error,omitempty"`
	Snapshot          json.RawMessage          `json:"snapshot"`
}

type SourceEventMonitorRecord struct {
	JobID           string                   `json:"job_id"`
	TenantID        string                   `json:"tenant_id"`
	Source          canonical.SourcePlatform `json:"source"`
	Enabled         bool                     `json:"enabled"`
	IntervalSeconds int                      `json:"interval_seconds"`
	EnabledSince    *time.Time               `json:"enabled_since,omitempty"`
	FirstSyncedAt   *time.Time               `json:"first_successful_sync_at,omitempty"`
	SuccessfulSyncs int                      `json:"successful_sync_count"`
	MaxSyncGapSecs  int                      `json:"max_success_gap_seconds"`
	Cursor          string                   `json:"cursor,omitempty"`
	LastEventAt     *time.Time               `json:"last_event_at,omitempty"`
	LastSyncedAt    *time.Time               `json:"last_synced_at,omitempty"`
	NextSyncAt      *time.Time               `json:"next_sync_at,omitempty"`
	LastError       string                   `json:"last_error,omitempty"`
	EventsSeen      int                      `json:"events_seen"`
	EventsApplied   int                      `json:"events_applied"`
	CreatedAt       time.Time                `json:"created_at"`
	UpdatedAt       time.Time                `json:"updated_at"`
}

type SourceEventRecord struct {
	ID             string                   `json:"id"`
	JobID          string                   `json:"job_id"`
	TenantID       string                   `json:"tenant_id"`
	Source         canonical.SourcePlatform `json:"source"`
	SourceEventID  string                   `json:"source_event_id"`
	ResourceType   string                   `json:"resource_type"`
	Action         string                   `json:"action"`
	OccurredAt     *time.Time               `json:"occurred_at,omitempty"`
	Applied        bool                     `json:"applied"`
	Error          string                   `json:"error,omitempty"`
	ReviewStatus   string                   `json:"review_status"`
	ReviewDetail   string                   `json:"review_detail,omitempty"`
	ReviewEvidence []string                 `json:"review_evidence,omitempty"`
	ReviewedAt     *time.Time               `json:"reviewed_at,omitempty"`
	Payload        json.RawMessage          `json:"payload"`
	CreatedAt      time.Time                `json:"created_at"`
}

// ShadowMonitorStore is implemented by stores that persist pilot shadow-mode
// schedules and check history.
type ShadowMonitorStore interface {
	UpsertShadowMonitor(ctx context.Context, rec ShadowMonitorRecord) (ShadowMonitorRecord, error)
	DisableShadowMonitor(ctx context.Context, tenantID, jobID string) error
	GetShadowMonitor(ctx context.Context, tenantID, jobID string) (ShadowMonitorRecord, error)
	ListDueShadowMonitors(ctx context.Context, now time.Time, limit int) ([]ShadowMonitorRecord, error)
	UpdateShadowMonitorAfterCheck(ctx context.Context, tenantID, jobID string, checkedAt, nextCheckAt time.Time, action, errMsg string) error
	SaveShadowCheckResult(ctx context.Context, rec ShadowCheckRecord) error
	ListShadowCheckResults(ctx context.Context, tenantID, jobID string, limit int) ([]ShadowCheckRecord, error)
}

type SourceEventMonitorStore interface {
	UpsertSourceEventMonitor(ctx context.Context, rec SourceEventMonitorRecord) (SourceEventMonitorRecord, error)
	DisableSourceEventMonitor(ctx context.Context, tenantID, jobID string) error
	GetSourceEventMonitor(ctx context.Context, tenantID, jobID string) (SourceEventMonitorRecord, error)
	ListDueSourceEventMonitors(ctx context.Context, now time.Time, limit int) ([]SourceEventMonitorRecord, error)
	UpdateSourceEventMonitorAfterSync(ctx context.Context, tenantID, jobID string, cursor string, lastEventAt *time.Time, syncedAt, nextSyncAt time.Time, seen, applied int, errMsg string) error
	SaveSourceEventResult(ctx context.Context, rec SourceEventRecord) error
	GetSourceEventResult(ctx context.Context, tenantID, jobID, sourceEventID string) (SourceEventRecord, error)
	GetSourceEventResultByID(ctx context.Context, tenantID, jobID, eventID string) (SourceEventRecord, error)
	UpdateSourceEventReview(ctx context.Context, tenantID, jobID, eventID, status, detail string, evidence []string, reviewedAt *time.Time) (SourceEventRecord, error)
	ListSourceEventResults(ctx context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error)
	ListFailedSourceEventResults(ctx context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error)
	ListReviewedSourceEventResults(ctx context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error)
}

// PostgresJobStore writes through to the migration_jobs table from
// 0004_migration_jobs.sql.
type PostgresJobStore struct {
	Pool   *pgxpool.Pool
	Cipher SessionCipher
}

// NewPostgresJobStore constructs a Postgres-backed store.
func NewPostgresJobStore(pool *pgxpool.Pool, cipher ...SessionCipher) *PostgresJobStore {
	var c SessionCipher
	if len(cipher) > 0 {
		c = cipher[0]
	}
	return &PostgresJobStore{Pool: pool, Cipher: c}
}

// Create inserts a fresh row.
func (p *PostgresJobStore) Create(ctx context.Context, job *canonical.MigrationJob) error {
	tx, err := p.beginTenant(ctx, job.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	prog, err := json.Marshal(job.Progress)
	if err != nil {
		return fmt.Errorf("marshal progress: %w", err)
	}
	cur, err := json.Marshal(job.Cursor)
	if err != nil {
		return fmt.Errorf("marshal cursor: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO migration_jobs (id, tenant_id, source, status, progress, cursor, started_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7)
	`, job.ID, job.TenantID, string(job.Source), string(job.Status), string(prog), string(cur), job.StartedAt)
	if err != nil {
		return fmt.Errorf("create migration_job: %w", err)
	}
	return tx.Commit(ctx)
}

// Get returns one job by id.
func (p *PostgresJobStore) Get(ctx context.Context, id string) (*canonical.MigrationJob, error) {
	tenantID, ok := TenantIDFromContext(ctx)
	if !ok {
		return nil, ErrTenantRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, source, status, progress, cursor,
		       started_at, completed_at, rollback_until, verification_report, error, label, notes
		  FROM migration_jobs WHERE id = $1::uuid
	`, id)
	job, err := scanJob(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

// Update replaces every mutable field.
func (p *PostgresJobStore) Update(ctx context.Context, job *canonical.MigrationJob) error {
	tx, err := p.beginTenant(ctx, job.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	prog, err := json.Marshal(job.Progress)
	if err != nil {
		return fmt.Errorf("marshal progress: %w", err)
	}
	cur, err := json.Marshal(job.Cursor)
	if err != nil {
		return fmt.Errorf("marshal cursor: %w", err)
	}
	var vr *string
	if job.VerificationReport != nil {
		b, err := json.Marshal(job.VerificationReport)
		if err != nil {
			return fmt.Errorf("marshal verification report: %w", err)
		}
		s := string(b)
		vr = &s
	}
	tag, err := tx.Exec(ctx, `
		UPDATE migration_jobs SET
		  status = $2,
		  progress = $3::jsonb,
		  cursor = $4::jsonb,
		  completed_at = $5,
		  rollback_until = $6,
		  verification_report = $7::jsonb,
		  error = $8
		WHERE id = $1::uuid
	`, job.ID, string(job.Status), string(prog), string(cur),
		job.CompletedAt, job.RollbackUntil, vr, errPtr(job.Error))
	if err != nil {
		return fmt.Errorf("update job: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// UpdateIfStatus performs the full mutable-job update as an expected-status
// compare-and-swap. The status predicate is evaluated in the same tenant-RLS
// transaction as the write; a stale handler can therefore never overwrite a
// concurrently committed lifecycle transition.
func (p *PostgresJobStore) UpdateIfStatus(ctx context.Context, job *canonical.MigrationJob, expected ...canonical.MigrationStatus) error {
	if job == nil || len(expected) == 0 {
		return fmt.Errorf("update job status transition: job and expected status are required")
	}
	tx, err := p.beginTenant(ctx, job.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	prog, err := json.Marshal(job.Progress)
	if err != nil {
		return fmt.Errorf("marshal progress: %w", err)
	}
	cur, err := json.Marshal(job.Cursor)
	if err != nil {
		return fmt.Errorf("marshal cursor: %w", err)
	}
	var vr *string
	if job.VerificationReport != nil {
		b, err := json.Marshal(job.VerificationReport)
		if err != nil {
			return fmt.Errorf("marshal verification report: %w", err)
		}
		s := string(b)
		vr = &s
	}
	expectedValues := make([]string, 0, len(expected))
	for _, status := range expected {
		expectedValues = append(expectedValues, string(status))
	}
	tag, err := tx.Exec(ctx, `
		UPDATE migration_jobs SET
		  status = $2,
		  progress = $3::jsonb,
		  cursor = $4::jsonb,
		  completed_at = $5,
		  rollback_until = $6,
		  verification_report = $7::jsonb,
		  error = $8
		WHERE id = $1::uuid
		  AND status = ANY($9::text[])
	`, job.ID, string(job.Status), string(prog), string(cur),
		job.CompletedAt, job.RollbackUntil, vr, errPtr(job.Error), expectedValues)
	if err != nil {
		return fmt.Errorf("update job status transition: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrStatusTransitionConflict
	}
	return tx.Commit(ctx)
}

// CancelIfStatus atomically marks a runnable job operator-cancelled while
// deliberately leaving progress, cursor, verification evidence, and timestamps
// untouched. Those fields may have advanced on another service instance after
// the cancelling handler loaded its snapshot.
func (p *PostgresJobStore) CancelIfStatus(ctx context.Context, id, errMsg string, rollbackUntil *time.Time, expected ...canonical.MigrationStatus) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(errMsg) == "" || len(expected) == 0 {
		return fmt.Errorf("cancel job status transition: id, error message, and expected status are required")
	}
	tenantID, ok := TenantIDFromContext(ctx)
	if !ok {
		return ErrTenantRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	expectedValues := make([]string, 0, len(expected))
	for _, status := range expected {
		expectedValues = append(expectedValues, string(status))
	}
	tag, err := tx.Exec(ctx, `
		UPDATE migration_jobs
		   SET status = $2,
		       error = $3,
		       rollback_until = $4
		 WHERE id = $1::uuid
		   AND status = ANY($5::text[])
	`, id, string(canonical.MigFailed), errMsg, rollbackUntil, expectedValues)
	if err != nil {
		return fmt.Errorf("cancel job status transition: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrStatusTransitionConflict
	}
	return tx.Commit(ctx)
}

// UpdateProgress patches just the progress jsonb.
func (p *PostgresJobStore) UpdateProgress(ctx context.Context, id string, prog canonical.MigrationProgress) error {
	tenantID, ok := TenantIDFromContext(ctx)
	if !ok {
		return ErrTenantRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	b, err := json.Marshal(prog)
	if err != nil {
		return fmt.Errorf("marshal progress: %w", err)
	}
	tag, err := tx.Exec(ctx,
		`UPDATE migration_jobs SET progress = $2::jsonb WHERE id = $1::uuid`,
		id, string(b))
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

// UpdateStatus patches status (+ error).
func (p *PostgresJobStore) UpdateStatus(ctx context.Context, id string, st canonical.MigrationStatus, msg string) error {
	tenantID, ok := TenantIDFromContext(ctx)
	if !ok {
		return ErrTenantRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tag pgconn.CommandTag
	if msg == "" {
		tag, err = tx.Exec(ctx,
			`UPDATE migration_jobs SET status = $2 WHERE id = $1::uuid`, id, string(st))
	} else {
		tag, err = tx.Exec(ctx,
			`UPDATE migration_jobs SET status = $2, error = $3 WHERE id = $1::uuid`, id, string(st), msg)
	}
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

// UpdateAnnotations sets only the operator label/notes (MIGR-037). Kept separate
// from Update so a concurrent lifecycle write can never clobber an operator's
// annotation and vice-versa. A nil pointer clears the column.
func (p *PostgresJobStore) UpdateAnnotations(ctx context.Context, id string, label, notes *string) error {
	tenantID, ok := TenantIDFromContext(ctx)
	if !ok {
		return ErrTenantRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`UPDATE migration_jobs SET label = $2, notes = $3 WHERE id = $1::uuid`,
		id, label, notes)
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

// List returns all jobs for a tenant, newest first.
func (p *PostgresJobStore) List(ctx context.Context, tenantID string) ([]canonical.MigrationJob, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, source, status, progress, cursor,
		       started_at, completed_at, rollback_until, verification_report, error, label, notes
		  FROM migration_jobs WHERE tenant_id = $1::uuid
		  ORDER BY started_at DESC
	`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]canonical.MigrationJob, 0)
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *j)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ListRunnable returns jobs that were already accepted for execution but have
// not reached a terminal state. It intentionally walks tenants one by one so
// every migration_jobs query still runs under the normal tenant RLS policy.
func (p *PostgresJobStore) ListRunnable(ctx context.Context) ([]canonical.MigrationJob, error) {
	tenantIDs, err := p.listWorkerTenantIDs(ctx, "runnable")
	if err != nil {
		return nil, err
	}

	out := make([]canonical.MigrationJob, 0)
	for _, tenantID := range tenantIDs {
		tx, err := p.beginTenant(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		jobRows, err := tx.Query(ctx, `
			SELECT id::text, tenant_id::text, source, status, progress, cursor,
			       started_at, completed_at, rollback_until, verification_report, error, label, notes
			  FROM migration_jobs
			 WHERE tenant_id = $1::uuid
			   AND status IN ($2, $3)
			 ORDER BY started_at ASC
		`, tenantID, string(canonical.MigDryRun), string(canonical.MigImporting))
		if err != nil {
			_ = tx.Rollback(ctx)
			return nil, fmt.Errorf("list runnable jobs for tenant %s: %w", tenantID, err)
		}
		for jobRows.Next() {
			j, err := scanJob(jobRows)
			if err != nil {
				jobRows.Close()
				_ = tx.Rollback(ctx)
				return nil, err
			}
			out = append(out, *j)
		}
		if err := jobRows.Err(); err != nil {
			jobRows.Close()
			_ = tx.Rollback(ctx)
			return nil, err
		}
		jobRows.Close()
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// listWorkerTenantIDs enters the reviewed background-worker scope before
// enumerating tenants. Migration 1728 intentionally makes a bare SELECT return
// zero rows, so worker loops must never query tenants directly or they will
// silently stop recovering jobs and running monitors.
func (p *PostgresJobStore) listWorkerTenantIDs(ctx context.Context, operation string) ([]string, error) {
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("list %s tenants: %w", operation, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		return nil, fmt.Errorf("list %s tenants: enter worker scope: %w", operation, err)
	}
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list %s tenants: %w", operation, err)
	}
	defer rows.Close()
	tenantIDs := make([]string, 0)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, err
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return tenantIDs, nil
}

// ClaimJob atomically grants the requesting worker a lease on one
// runnable job. Uses FOR UPDATE SKIP LOCKED so concurrent claimants on
// other instances pick disjoint rows instead of blocking. Returns
// ErrJobNotClaimable when no runnable job is unleased / past its TTL.
//
// Candidate discovery uses the worker SELECT policy; claiming and loading
// a job use its tenant policy in the same transaction.
func (p *PostgresJobStore) ClaimJob(ctx context.Context, ownerID string, leaseTTL time.Duration) (*canonical.MigrationJob, error) {
	if ownerID == "" {
		return nil, errors.New("jobstore: ownerID required")
	}
	if leaseTTL <= 0 {
		return nil, errors.New("jobstore: leaseTTL must be positive")
	}
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The worker policy grants cross-tenant SELECT only. FOR UPDATE also
	// requires the tenant UPDATE policy, so discover candidates without a row
	// lock, then scope and atomically recheck each candidate before claiming it.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.platform_admin', 'true', true)`); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text FROM migration_jobs
		WHERE status IN ($1, $2)
		  AND (lease_expires_at IS NULL OR lease_expires_at < now())
		ORDER BY started_at ASC, id ASC LIMIT 128
	`, string(canonical.MigDryRun), string(canonical.MigImporting))
	if err != nil {
		return nil, fmt.Errorf("claim discover: %w", err)
	}
	type candidate struct{ id, tenant string }
	var candidates []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.id, &c.tenant); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.platform_admin', 'false', true)`); err != nil {
		return nil, err
	}
	var candidateID string
	for _, c := range candidates {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, c.tenant); err != nil {
			return nil, err
		}
		err := tx.QueryRow(ctx, `
			WITH available AS (
				SELECT id FROM migration_jobs
				WHERE id=$1::uuid AND tenant_id=$2::uuid
				  AND status IN ($5, $6)
				  AND (lease_expires_at IS NULL OR lease_expires_at < now())
				FOR UPDATE SKIP LOCKED
			)
			UPDATE migration_jobs j SET lease_owner=$3::uuid,
			       lease_expires_at=now()+($4::text)::interval
			FROM available a WHERE j.id=a.id RETURNING j.id::text
		`, c.id, c.tenant, ownerID, fmt.Sprintf("%d milliseconds", leaseTTL.Milliseconds()), string(canonical.MigDryRun), string(canonical.MigImporting)).Scan(&candidateID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("claim update: %w", err)
		}
		break
	}
	if candidateID == "" {
		return nil, ErrJobNotClaimable
	}

	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, source, status, progress, cursor,
		       started_at, completed_at, rollback_until, verification_report, error, label, notes
		  FROM migration_jobs WHERE id = $1::uuid
	`, candidateID)
	job, err := scanJob(row)
	if err != nil {
		return nil, fmt.Errorf("claim reload: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

// RenewLease extends the lease window for a worker that's still alive.
// It refuses (returning ErrLeaseLost) if the row has been claimed by a
// different owner, so a stalled worker cannot resurrect a job that another
// instance has already taken over.
func (p *PostgresJobStore) RenewLease(ctx context.Context, jobID, ownerID string, leaseTTL time.Duration) error {
	if jobID == "" || ownerID == "" {
		return errors.New("jobstore: jobID and ownerID required")
	}
	if leaseTTL <= 0 {
		return errors.New("jobstore: leaseTTL must be positive")
	}
	// Need the row's tenant first to set RLS context.
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.platform_admin', 'true', true)`); err != nil {
		return err
	}
	var tenantID string
	if err := tx.QueryRow(ctx,
		`SELECT tenant_id::text FROM migration_jobs WHERE id = $1::uuid`, jobID,
	).Scan(&tenantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE migration_jobs
		   SET lease_expires_at = now() + ($3::text)::interval
		 WHERE id = $1::uuid AND lease_owner = $2::uuid
	`, jobID, ownerID, fmt.Sprintf("%d milliseconds", leaseTTL.Milliseconds()))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

// ReleaseLease clears (lease_owner, lease_expires_at) so the job is once
// again claimable. Worker code calls this on terminal statuses; otherwise
// the lease just expires on its own.
func (p *PostgresJobStore) ReleaseLease(ctx context.Context, jobID, ownerID string) error {
	if jobID == "" || ownerID == "" {
		return errors.New("jobstore: jobID and ownerID required")
	}
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.platform_admin', 'true', true)`); err != nil {
		return err
	}
	var tenantID string
	if err := tx.QueryRow(ctx,
		`SELECT tenant_id::text FROM migration_jobs WHERE id = $1::uuid`, jobID,
	).Scan(&tenantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE migration_jobs
		   SET lease_owner = NULL, lease_expires_at = NULL
		 WHERE id = $1::uuid AND lease_owner = $2::uuid
	`, jobID, ownerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

// SaveOAuthState stores a short-lived provider OAuth CSRF state.
func (p *PostgresJobStore) SaveOAuthState(ctx context.Context, st OAuthStateRecord) error {
	tx, err := p.beginTenant(ctx, st.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO migration_oauth_states (state, tenant_id, source, created_at, expires_at)
		VALUES ($1, $2::uuid, $3, $4, $5)
	`, st.State, st.TenantID, string(st.Source), st.CreatedAt, st.ExpiresAt)
	if err != nil {
		return fmt.Errorf("save oauth state: %w", err)
	}
	return tx.Commit(ctx)
}

// ConsumeOAuthState atomically marks an OAuth state as used and returns it.
func (p *PostgresJobStore) ConsumeOAuthState(ctx context.Context, tenantID, state string, now time.Time) (OAuthStateRecord, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return OAuthStateRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var st OAuthStateRecord
	row := tx.QueryRow(ctx, `
		UPDATE migration_oauth_states
		   SET consumed_at = $3
		 WHERE state = $1
		   AND tenant_id = $2::uuid
		   AND consumed_at IS NULL
		   AND expires_at > $3
		RETURNING state, tenant_id::text, source, created_at, expires_at
	`, state, tenantID, now)
	if err := row.Scan(&st.State, &st.TenantID, &st.Source, &st.CreatedAt, &st.ExpiresAt); errors.Is(err, pgx.ErrNoRows) {
		return OAuthStateRecord{}, ErrNotFound
	} else if err != nil {
		return OAuthStateRecord{}, fmt.Errorf("consume oauth state: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return OAuthStateRecord{}, err
	}
	return st, nil
}

// SaveSession stores an encrypted adapter session for a job.
func (p *PostgresJobStore) SaveSession(ctx context.Context, jobID, tenantID string, sess adapter.Session, expiresAt time.Time) error {
	if p.Cipher == nil {
		return ErrSessionCipherRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	payload, err := json.Marshal(sess)
	if err != nil {
		return fmt.Errorf("marshal migration session: %w", err)
	}
	ct, err := p.Cipher.Encrypt(ctx, payload)
	if err != nil {
		return fmt.Errorf("encrypt migration session: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO migration_sessions (job_id, tenant_id, source, ciphertext, expires_at, last_used_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, $5, now())
		ON CONFLICT (job_id) DO UPDATE SET
		  ciphertext = EXCLUDED.ciphertext,
		  source = EXCLUDED.source,
		  expires_at = EXCLUDED.expires_at,
		  last_used_at = now()
	`, jobID, tenantID, string(sess.Source), ct, expiresAt)
	if err != nil {
		return fmt.Errorf("save migration session: %w", err)
	}
	return tx.Commit(ctx)
}

// GetSession decrypts and returns a still-valid session for a job.
func (p *PostgresJobStore) GetSession(ctx context.Context, tenantID, jobID string, now time.Time) (adapter.Session, error) {
	if p.Cipher == nil {
		return adapter.Session{}, ErrSessionCipherRequired
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return adapter.Session{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var ct []byte
	row := tx.QueryRow(ctx, `
		UPDATE migration_sessions
		   SET last_used_at = $3
		 WHERE job_id = $1::uuid
		   AND tenant_id = $2::uuid
		   AND expires_at > $3
		RETURNING ciphertext
	`, jobID, tenantID, now)
	if err := row.Scan(&ct); errors.Is(err, pgx.ErrNoRows) {
		return adapter.Session{}, ErrNotFound
	} else if err != nil {
		return adapter.Session{}, fmt.Errorf("get migration session: %w", err)
	}
	payload, err := p.Cipher.Decrypt(ctx, ct)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("decrypt migration session: %w", err)
	}
	var sess adapter.Session
	if err := json.Unmarshal(payload, &sess); err != nil {
		return adapter.Session{}, fmt.Errorf("decode migration session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return adapter.Session{}, err
	}
	return sess, nil
}

// GetSessionInfo returns non-secret metadata for a still-valid migration
// session.
func (p *PostgresJobStore) GetSessionInfo(ctx context.Context, tenantID, jobID string, now time.Time) (SessionInfo, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return SessionInfo{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var info SessionInfo
	var lastUsed sql.NullTime
	var ct []byte
	row := tx.QueryRow(ctx, `
		SELECT source, expires_at, last_used_at, ciphertext
		  FROM migration_sessions
		 WHERE job_id = $1::uuid
		   AND tenant_id = $2::uuid
		   AND expires_at > $3
	`, jobID, tenantID, now)
	var source string
	if err := row.Scan(&source, &info.ExpiresAt, &lastUsed, &ct); errors.Is(err, pgx.ErrNoRows) {
		return SessionInfo{}, ErrNotFound
	} else if err != nil {
		return SessionInfo{}, fmt.Errorf("get migration session info: %w", err)
	}
	info.Source = canonical.SourcePlatform(source)
	if lastUsed.Valid {
		info.LastUsedAt = &lastUsed.Time
	}
	if p.Cipher != nil {
		payload, err := p.Cipher.Decrypt(ctx, ct)
		if err != nil {
			return SessionInfo{}, fmt.Errorf("decrypt migration session info: %w", err)
		}
		var sess adapter.Session
		if err := json.Unmarshal(payload, &sess); err != nil {
			return SessionInfo{}, fmt.Errorf("decode migration session info: %w", err)
		}
		info.SelectedAudienceIDs = selectedAudienceIDsFromSessionExtra(sess.Extra)
	}
	if err := tx.Commit(ctx); err != nil {
		return SessionInfo{}, err
	}
	return info, nil
}

// DeleteSession removes a job's source session.
func (p *PostgresJobStore) DeleteSession(ctx context.Context, tenantID, jobID string) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM migration_sessions WHERE job_id = $1::uuid AND tenant_id = $2::uuid`,
		jobID, tenantID)
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

func (p *PostgresJobStore) UpsertShadowMonitor(ctx context.Context, rec ShadowMonitorRecord) (ShadowMonitorRecord, error) {
	if rec.IntervalSeconds <= 0 {
		rec.IntervalSeconds = 3600
	}
	tx, err := p.beginTenant(ctx, rec.TenantID)
	if err != nil {
		return ShadowMonitorRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		INSERT INTO migration_shadow_monitors (
			job_id, tenant_id, source, enabled, interval_seconds, next_check_at
		) VALUES (
			$1::uuid, $2::uuid, $3, true, $4, COALESCE($5::timestamptz, now())
		)
		ON CONFLICT (job_id)
		DO UPDATE SET
			enabled = true,
			interval_seconds = EXCLUDED.interval_seconds,
			next_check_at = COALESCE(EXCLUDED.next_check_at, migration_shadow_monitors.next_check_at, now()),
			updated_at = now()
		RETURNING job_id::text, tenant_id::text, source, enabled, interval_seconds,
		          last_checked_at, next_check_at, COALESCE(last_recommended_action, ''),
		          COALESCE(last_error, ''), created_at, updated_at`,
		rec.JobID, rec.TenantID, string(rec.Source), rec.IntervalSeconds, rec.NextCheckAt)
	out, err := scanShadowMonitor(row)
	if err != nil {
		return ShadowMonitorRecord{}, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) DisableShadowMonitor(ctx context.Context, tenantID, jobID string) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
			UPDATE migration_shadow_monitors
			   SET enabled = false, updated_at = now()
			 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`,
		tenantID, jobID)
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

func (p *PostgresJobStore) GetShadowMonitor(ctx context.Context, tenantID, jobID string) (ShadowMonitorRecord, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return ShadowMonitorRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT job_id::text, tenant_id::text, source, enabled, interval_seconds,
		       last_checked_at, next_check_at, COALESCE(last_recommended_action, ''),
		       COALESCE(last_error, ''), created_at, updated_at
		  FROM migration_shadow_monitors
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, tenantID, jobID)
	out, err := scanShadowMonitor(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return ShadowMonitorRecord{}, ErrNotFound
	}
	if err != nil {
		return ShadowMonitorRecord{}, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) ListDueShadowMonitors(ctx context.Context, now time.Time, limit int) ([]ShadowMonitorRecord, error) {
	if limit <= 0 {
		limit = 25
	}
	tenantIDs, err := p.listWorkerTenantIDs(ctx, "shadow")
	if err != nil {
		return nil, err
	}
	out := []ShadowMonitorRecord{}
	for _, tenantID := range tenantIDs {
		if len(out) >= limit {
			break
		}
		tx, err := p.beginTenant(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		remaining := limit - len(out)
		monitorRows, err := tx.Query(ctx, `
			SELECT job_id::text, tenant_id::text, source, enabled, interval_seconds,
			       last_checked_at, next_check_at, COALESCE(last_recommended_action, ''),
			       COALESCE(last_error, ''), created_at, updated_at
			  FROM migration_shadow_monitors
			 WHERE tenant_id = $1::uuid
			   AND enabled = true
			   AND COALESCE(next_check_at, now()) <= $2
			 ORDER BY COALESCE(next_check_at, created_at) ASC
			 LIMIT $3`, tenantID, now, remaining)
		if err != nil {
			_ = tx.Rollback(ctx)
			return nil, err
		}
		for monitorRows.Next() {
			rec, err := scanShadowMonitor(monitorRows)
			if err != nil {
				monitorRows.Close()
				_ = tx.Rollback(ctx)
				return nil, err
			}
			out = append(out, rec)
		}
		if err := monitorRows.Err(); err != nil {
			monitorRows.Close()
			_ = tx.Rollback(ctx)
			return nil, err
		}
		monitorRows.Close()
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (p *PostgresJobStore) UpdateShadowMonitorAfterCheck(ctx context.Context, tenantID, jobID string, checkedAt, nextCheckAt time.Time, action, errMsg string) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE migration_shadow_monitors
		   SET last_checked_at = $3,
		       next_check_at = $4,
		       last_recommended_action = NULLIF($5, ''),
		       last_error = NULLIF($6, ''),
		       updated_at = now()
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`,
		tenantID, jobID, checkedAt, nextCheckAt, action, errMsg)
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

func (p *PostgresJobStore) SaveShadowCheckResult(ctx context.Context, rec ShadowCheckRecord) error {
	tx, err := p.beginTenant(ctx, rec.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if len(rec.Snapshot) == 0 {
		rec.Snapshot = json.RawMessage(`{}`)
	}
	var latest sql.NullTime
	if err := tx.QueryRow(ctx, `
		SELECT MAX(generated_at)
		  FROM migration_shadow_check_results
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, rec.TenantID, rec.JobID).Scan(&latest); err != nil {
		return err
	}
	if latest.Valid && !rec.GeneratedAt.After(latest.Time) {
		rec.GeneratedAt = latest.Time.Add(time.Microsecond)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO migration_shadow_check_results (
			job_id, tenant_id, source, generated_at, needs_delta_import,
			recommended_action, error, snapshot
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, $6, NULLIF($7, ''), $8::jsonb
		)`, rec.JobID, rec.TenantID, string(rec.Source), rec.GeneratedAt,
		rec.NeedsDeltaImport, rec.RecommendedAction, rec.Error, string(rec.Snapshot))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *PostgresJobStore) ListShadowCheckResults(ctx context.Context, tenantID, jobID string, limit int) ([]ShadowCheckRecord, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, job_id::text, tenant_id::text, source, generated_at,
		       needs_delta_import, COALESCE(recommended_action, ''),
		       COALESCE(error, ''), snapshot
		  FROM migration_shadow_check_results
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		 ORDER BY generated_at DESC
		 LIMIT $3`, tenantID, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ShadowCheckRecord{}
	for rows.Next() {
		rec, err := scanShadowCheckResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) UpsertSourceEventMonitor(ctx context.Context, rec SourceEventMonitorRecord) (SourceEventMonitorRecord, error) {
	rec.IntervalSeconds = normalizeSourceEventIntervalSeconds(rec.IntervalSeconds)
	if rec.NextSyncAt == nil {
		now := time.Now().UTC()
		rec.NextSyncAt = &now
	}
	tx, err := p.beginTenant(ctx, rec.TenantID)
	if err != nil {
		return SourceEventMonitorRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		INSERT INTO migration_source_event_monitors (
			job_id, tenant_id, source, enabled, interval_seconds, enabled_since, cursor, last_event_at, next_sync_at
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, CASE WHEN $4 THEN now() ELSE NULL END, COALESCE($6, ''), $7, COALESCE($8, now())
		)
		ON CONFLICT (job_id) DO UPDATE SET
			enabled = EXCLUDED.enabled,
			interval_seconds = EXCLUDED.interval_seconds,
			next_sync_at = COALESCE(EXCLUDED.next_sync_at, migration_source_event_monitors.next_sync_at, now()),
			enabled_since = CASE
				WHEN EXCLUDED.enabled = false THEN NULL
				WHEN migration_source_event_monitors.enabled = false
				  OR migration_source_event_monitors.enabled_since IS NULL
				  OR migration_source_event_monitors.interval_seconds <> EXCLUDED.interval_seconds THEN now()
				ELSE migration_source_event_monitors.enabled_since
			END,
			first_successful_sync_at = CASE
				WHEN migration_source_event_monitors.enabled = false
				  OR migration_source_event_monitors.enabled_since IS NULL
				  OR migration_source_event_monitors.interval_seconds <> EXCLUDED.interval_seconds THEN NULL
				ELSE migration_source_event_monitors.first_successful_sync_at
			END,
			successful_sync_count = CASE
				WHEN migration_source_event_monitors.enabled = false
				  OR migration_source_event_monitors.enabled_since IS NULL
				  OR migration_source_event_monitors.interval_seconds <> EXCLUDED.interval_seconds THEN 0
				ELSE migration_source_event_monitors.successful_sync_count
			END,
			max_success_gap_seconds = CASE
				WHEN migration_source_event_monitors.enabled = false
				  OR migration_source_event_monitors.enabled_since IS NULL
				  OR migration_source_event_monitors.interval_seconds <> EXCLUDED.interval_seconds THEN 0
				ELSE migration_source_event_monitors.max_success_gap_seconds
			END,
			last_synced_at = CASE
				WHEN migration_source_event_monitors.enabled = false
				  OR migration_source_event_monitors.enabled_since IS NULL
				  OR migration_source_event_monitors.interval_seconds <> EXCLUDED.interval_seconds THEN NULL
				ELSE migration_source_event_monitors.last_synced_at
			END,
			updated_at = now()
		RETURNING job_id::text, tenant_id::text, source, enabled, interval_seconds,
		          enabled_since, first_successful_sync_at, successful_sync_count, max_success_gap_seconds,
		          COALESCE(cursor, ''), last_event_at, last_synced_at, next_sync_at,
		          COALESCE(last_error, ''), events_seen, events_applied, created_at, updated_at`,
		rec.JobID, rec.TenantID, string(rec.Source), rec.Enabled, rec.IntervalSeconds, rec.Cursor, rec.LastEventAt, rec.NextSyncAt)
	out, err := scanSourceEventMonitor(row)
	if err != nil {
		return SourceEventMonitorRecord{}, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) DisableSourceEventMonitor(ctx context.Context, tenantID, jobID string) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE migration_source_event_monitors
		   SET enabled = false, enabled_since = NULL, updated_at = now()
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, tenantID, jobID)
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

func (p *PostgresJobStore) GetSourceEventMonitor(ctx context.Context, tenantID, jobID string) (SourceEventMonitorRecord, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return SourceEventMonitorRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT job_id::text, tenant_id::text, source, enabled, interval_seconds,
		       enabled_since, first_successful_sync_at, successful_sync_count, max_success_gap_seconds,
		       COALESCE(cursor, ''), last_event_at, last_synced_at, next_sync_at,
		       COALESCE(last_error, ''), events_seen, events_applied, created_at, updated_at
		  FROM migration_source_event_monitors
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid`, tenantID, jobID)
	out, err := scanSourceEventMonitor(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceEventMonitorRecord{}, ErrNotFound
	}
	if err != nil {
		return SourceEventMonitorRecord{}, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) ListDueSourceEventMonitors(ctx context.Context, now time.Time, limit int) ([]SourceEventMonitorRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	tenantIDs, err := p.listWorkerTenantIDs(ctx, "source-event")
	if err != nil {
		return nil, err
	}
	out := []SourceEventMonitorRecord{}
	for _, tenantID := range tenantIDs {
		if len(out) >= limit {
			break
		}
		tx, err := p.beginTenant(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		remaining := limit - len(out)
		monitorRows, err := tx.Query(ctx, `
			SELECT job_id::text, tenant_id::text, source, enabled, interval_seconds,
			       enabled_since, first_successful_sync_at, successful_sync_count, max_success_gap_seconds,
			       COALESCE(cursor, ''), last_event_at, last_synced_at, next_sync_at,
			       COALESCE(last_error, ''), events_seen, events_applied, created_at, updated_at
			  FROM migration_source_event_monitors
			 WHERE tenant_id = $1::uuid
			   AND enabled = true
			   AND COALESCE(next_sync_at, now()) <= $2
			 ORDER BY COALESCE(next_sync_at, created_at) ASC
			 LIMIT $3`, tenantID, now, remaining)
		if err != nil {
			_ = tx.Rollback(ctx)
			return nil, err
		}
		for monitorRows.Next() {
			rec, err := scanSourceEventMonitor(monitorRows)
			if err != nil {
				monitorRows.Close()
				_ = tx.Rollback(ctx)
				return nil, err
			}
			out = append(out, rec)
		}
		if err := monitorRows.Err(); err != nil {
			monitorRows.Close()
			_ = tx.Rollback(ctx)
			return nil, err
		}
		monitorRows.Close()
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (p *PostgresJobStore) UpdateSourceEventMonitorAfterSync(ctx context.Context, tenantID, jobID string, cursor string, lastEventAt *time.Time, syncedAt, nextSyncAt time.Time, seen, applied int, errMsg string) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE migration_source_event_monitors
		   SET cursor = $3,
		       last_event_at = COALESCE($4, last_event_at),
			       last_synced_at = CASE
		           WHEN NULLIF($7, '') IS NULL THEN $5
		           ELSE last_synced_at
			       END,
			       first_successful_sync_at = CASE
			           WHEN NULLIF($7, '') IS NULL THEN COALESCE(first_successful_sync_at, $5)
			           ELSE first_successful_sync_at
			       END,
			       successful_sync_count = successful_sync_count + CASE WHEN NULLIF($7, '') IS NULL THEN 1 ELSE 0 END,
			       max_success_gap_seconds = CASE
			           WHEN NULLIF($7, '') IS NULL AND last_synced_at IS NOT NULL THEN
			               GREATEST(max_success_gap_seconds, GREATEST(0, CEIL(EXTRACT(EPOCH FROM ($5 - last_synced_at)))::integer))
			           ELSE max_success_gap_seconds
			       END,
		       next_sync_at = $6,
		       last_error = NULLIF($7, ''),
		       events_seen = events_seen + $8,
		       events_applied = events_applied + $9,
		       updated_at = now()
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND enabled = true`,
		tenantID, jobID, cursor, lastEventAt, syncedAt, nextSyncAt, errMsg, seen, applied)
	if err != nil {
		return err
	}
	return commitUpdated(ctx, tx, tag)
}

func (p *PostgresJobStore) SaveSourceEventResult(ctx context.Context, rec SourceEventRecord) error {
	tx, err := p.beginTenant(ctx, rec.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if len(rec.Payload) == 0 {
		rec.Payload = json.RawMessage(`{}`)
	}
	if strings.TrimSpace(rec.ReviewStatus) == "" {
		rec.ReviewStatus = "pending"
	}
	if rec.ReviewEvidence == nil {
		rec.ReviewEvidence = []string{}
	}
	reviewEvidence, err := json.Marshal(rec.ReviewEvidence)
	if err != nil {
		return fmt.Errorf("marshal source-event review evidence: %w", err)
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO migration_source_event_results (
			job_id, tenant_id, source, source_event_id, resource_type, action,
			occurred_at, applied, error, review_status, review_detail,
			review_evidence, reviewed_at, payload
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, NULLIF($9, ''),
			$10, NULLIF($11, ''), $12::jsonb, $13, $14::jsonb
		)
		ON CONFLICT (tenant_id, job_id, source_event_id) DO UPDATE SET
			applied = EXCLUDED.applied,
			error = EXCLUDED.error,
			payload = EXCLUDED.payload`,
		rec.JobID, rec.TenantID, string(rec.Source), rec.SourceEventID, rec.ResourceType,
		rec.Action, rec.OccurredAt, rec.Applied, rec.Error, rec.ReviewStatus,
		rec.ReviewDetail, string(reviewEvidence), rec.ReviewedAt, string(rec.Payload))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *PostgresJobStore) GetSourceEventResult(ctx context.Context, tenantID, jobID, sourceEventID string) (SourceEventRecord, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return SourceEventRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, job_id::text, tenant_id::text, source, source_event_id,
		       resource_type, action, occurred_at, applied, COALESCE(error, ''),
		       review_status, COALESCE(review_detail, ''), review_evidence,
		       reviewed_at, payload, created_at
		  FROM migration_source_event_results
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND source_event_id = $3`,
		tenantID, jobID, sourceEventID)
	out, err := scanSourceEventResult(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceEventRecord{}, ErrNotFound
	}
	if err != nil {
		return SourceEventRecord{}, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) GetSourceEventResultByID(ctx context.Context, tenantID, jobID, eventID string) (SourceEventRecord, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return SourceEventRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		SELECT id::text, job_id::text, tenant_id::text, source, source_event_id,
		       resource_type, action, occurred_at, applied, COALESCE(error, ''),
		       review_status, COALESCE(review_detail, ''), review_evidence,
		       reviewed_at, payload, created_at
		  FROM migration_source_event_results
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND id = $3::uuid`,
		tenantID, jobID, eventID)
	out, err := scanSourceEventResult(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceEventRecord{}, ErrNotFound
	}
	if err != nil {
		return SourceEventRecord{}, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) UpdateSourceEventReview(ctx context.Context, tenantID, jobID, eventID, status, detail string, evidence []string, reviewedAt *time.Time) (SourceEventRecord, error) {
	if evidence == nil {
		evidence = []string{}
	}
	reviewEvidence, err := json.Marshal(evidence)
	if err != nil {
		return SourceEventRecord{}, fmt.Errorf("marshal source-event review evidence: %w", err)
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return SourceEventRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
		UPDATE migration_source_event_results
		   SET review_status = $4,
		       review_detail = NULLIF($5, ''),
		       review_evidence = $6::jsonb,
		       reviewed_at = $7
		 WHERE tenant_id = $1::uuid
		   AND job_id = $2::uuid
		   AND id = $3::uuid
		   AND applied = false
		   AND lower(action) = 'manual_review'
		RETURNING id::text, job_id::text, tenant_id::text, source, source_event_id,
		          resource_type, action, occurred_at, applied, COALESCE(error, ''),
		          review_status, COALESCE(review_detail, ''), review_evidence,
		          reviewed_at, payload, created_at`,
		tenantID, jobID, eventID, status, detail, string(reviewEvidence), reviewedAt)
	out, err := scanSourceEventResult(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return SourceEventRecord{}, ErrNotFound
	}
	if err != nil {
		return SourceEventRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SourceEventRecord{}, err
	}
	return out, nil
}

func (p *PostgresJobStore) ListSourceEventResults(ctx context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, job_id::text, tenant_id::text, source, source_event_id,
		       resource_type, action, occurred_at, applied, COALESCE(error, ''),
		       review_status, COALESCE(review_detail, ''), review_evidence,
		       reviewed_at, payload, created_at
		  FROM migration_source_event_results
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		 ORDER BY created_at DESC
		 LIMIT $3`, tenantID, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceEventRecord{}
	for rows.Next() {
		rec, err := scanSourceEventResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) ListFailedSourceEventResults(ctx context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, job_id::text, tenant_id::text, source, source_event_id,
		       resource_type, action, occurred_at, applied, COALESCE(error, ''),
		       review_status, COALESCE(review_detail, ''), review_evidence,
		       reviewed_at, payload, created_at
		  FROM migration_source_event_results
		 WHERE tenant_id = $1::uuid
		   AND job_id = $2::uuid
		   AND (applied = false OR COALESCE(error, '') <> '')
		   AND NOT (
		       applied = false
		       AND lower(action) = 'manual_review'
		       AND review_status = 'reviewed'
		       AND reviewed_at IS NOT NULL
		       AND COALESCE(review_detail, '') <> ''
		       AND jsonb_array_length(review_evidence) > 0
		   )
		 ORDER BY created_at DESC
		 LIMIT $3`, tenantID, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceEventRecord{}
	for rows.Next() {
		rec, err := scanSourceEventResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) ListReviewedSourceEventResults(ctx context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, job_id::text, tenant_id::text, source, source_event_id,
		       resource_type, action, occurred_at, applied, COALESCE(error, ''),
		       review_status, COALESCE(review_detail, ''), review_evidence,
		       reviewed_at, payload, created_at
		  FROM migration_source_event_results
		 WHERE tenant_id = $1::uuid
		   AND job_id = $2::uuid
		   AND applied = false
		   AND lower(action) = 'manual_review'
		   AND review_status = 'reviewed'
		   AND reviewed_at IS NOT NULL
		   AND COALESCE(review_detail, '') <> ''
		   AND jsonb_array_length(review_evidence) > 0
		 ORDER BY reviewed_at DESC, created_at DESC
		 LIMIT $3`, tenantID, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceEventRecord{}
	for rows.Next() {
		rec, err := scanSourceEventResult(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (p *PostgresJobStore) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("tenant id required")
	}
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func commitUpdated(ctx context.Context, tx pgx.Tx, tag pgconn.CommandTag) error {
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

type jobScanner interface {
	Scan(dest ...any) error
}

func scanJob(rows jobScanner) (*canonical.MigrationJob, error) {
	var j canonical.MigrationJob
	var progRaw, curRaw, vrRaw []byte
	var completedAt, rollbackUntil *time.Time
	var errMsg *string
	var label, notes *string
	if err := rows.Scan(&j.ID, &j.TenantID, &j.Source, &j.Status,
		&progRaw, &curRaw, &j.StartedAt,
		&completedAt, &rollbackUntil, &vrRaw, &errMsg,
		&label, &notes); err != nil {
		return nil, err
	}
	j.Label = label
	j.Notes = notes
	if len(progRaw) > 0 {
		if err := json.Unmarshal(progRaw, &j.Progress); err != nil {
			return nil, fmt.Errorf("decode migration progress: %w", err)
		}
	}
	if len(curRaw) > 0 {
		if err := json.Unmarshal(curRaw, &j.Cursor); err != nil {
			return nil, fmt.Errorf("decode migration cursor: %w", err)
		}
	}
	if len(vrRaw) > 0 {
		var vr canonical.VerificationReport
		if err := json.Unmarshal(vrRaw, &vr); err != nil {
			return nil, fmt.Errorf("decode verification report: %w", err)
		}
		j.VerificationReport = &vr
	}
	if j.Cursor == nil {
		j.Cursor = map[string]*string{}
	}
	j.CompletedAt = completedAt
	j.RollbackUntil = rollbackUntil
	j.Error = errMsg
	return &j, nil
}

func errPtr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// ErrNotFound is returned by Get when the row is absent.
var ErrNotFound = errors.New("jobstore: not found")

// ErrTenantRequired is returned by id-only operations when no tenant scope was
// attached to the context.
var ErrTenantRequired = errors.New("jobstore: tenant id required")

// ErrSessionCipherRequired means a Postgres store was created without the
// encryption primitive required for durable source sessions.
var ErrSessionCipherRequired = errors.New("jobstore: migration session cipher required")

// ---------------------------------------------------------------------------
// MemoryJobStore — kept here so handlers + tests have a single import path.
// ---------------------------------------------------------------------------

// MemoryJobStore is the in-process fallback used when DATABASE_URL is unset.
type MemoryJobStore struct {
	mu                  sync.Mutex
	jobs                map[string]*canonical.MigrationJob
	states              map[string]OAuthStateRecord
	sessions            map[string]memorySessionRecord
	leases              map[string]memoryLease
	monitors            map[string]ShadowMonitorRecord
	shadowResults       map[string][]ShadowCheckRecord
	sourceEventMonitors map[string]SourceEventMonitorRecord
	sourceEventResults  map[string][]SourceEventRecord
	now                 func() time.Time
}

type memoryLease struct {
	OwnerID   string
	ExpiresAt time.Time
}

type memorySessionRecord struct {
	TenantID   string
	Session    adapter.Session
	ExpiresAt  time.Time
	LastUsedAt *time.Time
}

// NewMemoryJobStore constructs an empty store.
func NewMemoryJobStore() *MemoryJobStore {
	return &MemoryJobStore{
		jobs:                map[string]*canonical.MigrationJob{},
		states:              map[string]OAuthStateRecord{},
		sessions:            map[string]memorySessionRecord{},
		leases:              map[string]memoryLease{},
		monitors:            map[string]ShadowMonitorRecord{},
		shadowResults:       map[string][]ShadowCheckRecord{},
		sourceEventMonitors: map[string]SourceEventMonitorRecord{},
		sourceEventResults:  map[string][]SourceEventRecord{},
	}
}

// SetClock injects a deterministic clock for tests. Must be called before
// any lease operation if used.
func (m *MemoryJobStore) SetClock(now func() time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = now
}

func (m *MemoryJobStore) clock() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now().UTC()
}

// ClaimJob implements LeasingJobStore for the in-memory store. It picks
// the oldest runnable, unleased (or expired) job and grants ownerID a lease.
func (m *MemoryJobStore) ClaimJob(_ context.Context, ownerID string, leaseTTL time.Duration) (*canonical.MigrationJob, error) {
	if ownerID == "" {
		return nil, errors.New("jobstore: ownerID required")
	}
	if leaseTTL <= 0 {
		return nil, errors.New("jobstore: leaseTTL must be positive")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.clock()
	candidates := make([]*canonical.MigrationJob, 0)
	for _, j := range m.jobs {
		if j.Status != canonical.MigDryRun && j.Status != canonical.MigImporting {
			continue
		}
		if l, leased := m.leases[j.ID]; leased && l.ExpiresAt.After(now) {
			continue
		}
		candidates = append(candidates, j)
	}
	if len(candidates) == 0 {
		return nil, ErrJobNotClaimable
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].StartedAt.Before(candidates[j].StartedAt)
	})
	pick := candidates[0]
	m.leases[pick.ID] = memoryLease{OwnerID: ownerID, ExpiresAt: now.Add(leaseTTL)}
	cp := cloneJob(pick)
	return &cp, nil
}

// RenewLease extends a held lease.
func (m *MemoryJobStore) RenewLease(_ context.Context, jobID, ownerID string, leaseTTL time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.jobs[jobID]; !ok {
		return ErrNotFound
	}
	cur, ok := m.leases[jobID]
	if !ok || cur.OwnerID != ownerID {
		return ErrLeaseLost
	}
	cur.ExpiresAt = m.clock().Add(leaseTTL)
	m.leases[jobID] = cur
	return nil
}

// ReleaseLease clears a held lease.
func (m *MemoryJobStore) ReleaseLease(_ context.Context, jobID, ownerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.jobs[jobID]; !ok {
		return ErrNotFound
	}
	cur, ok := m.leases[jobID]
	if !ok || cur.OwnerID != ownerID {
		return ErrLeaseLost
	}
	delete(m.leases, jobID)
	return nil
}

// Create implements MigrationJobStore.
func (m *MemoryJobStore) Create(_ context.Context, j *canonical.MigrationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := cloneJob(j)
	m.jobs[j.ID] = &cp
	return nil
}

// Get implements MigrationJobStore.
func (m *MemoryJobStore) Get(ctx context.Context, id string) (*canonical.MigrationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return nil, ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && j.TenantID != tenantID {
		return nil, ErrNotFound
	}
	cp := cloneJob(j)
	return &cp, nil
}

// Update implements MigrationJobStore.
func (m *MemoryJobStore) Update(ctx context.Context, j *canonical.MigrationJob) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.jobs[j.ID]
	if !ok {
		return ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && existing.TenantID != tenantID {
		return ErrNotFound
	}
	cp := cloneJob(j)
	m.jobs[j.ID] = &cp
	return nil
}

// UpdateIfStatus is the in-process compare-and-swap counterpart to the
// PostgreSQL implementation. Holding m.mu across the comparison and clone
// makes handler race tests exercise the same lifecycle guarantee.
func (m *MemoryJobStore) UpdateIfStatus(ctx context.Context, j *canonical.MigrationJob, expected ...canonical.MigrationStatus) error {
	if j == nil || len(expected) == 0 {
		return fmt.Errorf("update job status transition: job and expected status are required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.jobs[j.ID]
	if !ok {
		return ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && existing.TenantID != tenantID {
		return ErrNotFound
	}
	matched := false
	for _, status := range expected {
		if existing.Status == status {
			matched = true
			break
		}
	}
	if !matched {
		return ErrStatusTransitionConflict
	}
	cp := cloneJob(j)
	m.jobs[j.ID] = &cp
	return nil
}

// CancelIfStatus is the in-memory status-only counterpart to PostgreSQL. It
// intentionally preserves every checkpoint field on the stored job.
func (m *MemoryJobStore) CancelIfStatus(ctx context.Context, id, errMsg string, rollbackUntil *time.Time, expected ...canonical.MigrationStatus) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(errMsg) == "" || len(expected) == 0 {
		return fmt.Errorf("cancel job status transition: id, error message, and expected status are required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	existing, ok := m.jobs[id]
	if !ok {
		return ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && existing.TenantID != tenantID {
		return ErrNotFound
	}
	matched := false
	for _, status := range expected {
		if existing.Status == status {
			matched = true
			break
		}
	}
	if !matched {
		return ErrStatusTransitionConflict
	}
	existing.Status = canonical.MigFailed
	message := errMsg
	existing.Error = &message
	if rollbackUntil == nil {
		existing.RollbackUntil = nil
	} else {
		value := *rollbackUntil
		existing.RollbackUntil = &value
	}
	return nil
}

// UpdateProgress implements MigrationJobStore.
func (m *MemoryJobStore) UpdateProgress(ctx context.Context, id string, p canonical.MigrationProgress) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && j.TenantID != tenantID {
		return ErrNotFound
	}
	j.Progress = p
	return nil
}

// UpdateStatus implements MigrationJobStore.
func (m *MemoryJobStore) UpdateStatus(ctx context.Context, id string, st canonical.MigrationStatus, msg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && j.TenantID != tenantID {
		return ErrNotFound
	}
	j.Status = st
	if msg != "" {
		j.Error = &msg
	}
	return nil
}

// UpdateAnnotations implements MigrationJobStore (MIGR-037).
func (m *MemoryJobStore) UpdateAnnotations(ctx context.Context, id string, label, notes *string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return ErrNotFound
	}
	if tenantID, scoped := TenantIDFromContext(ctx); scoped && j.TenantID != tenantID {
		return ErrNotFound
	}
	j.Label = label
	j.Notes = notes
	return nil
}

// List implements MigrationJobStore.
func (m *MemoryJobStore) List(_ context.Context, tenantID string) ([]canonical.MigrationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]canonical.MigrationJob, 0)
	for _, j := range m.jobs {
		if j.TenantID == tenantID {
			out = append(out, cloneJob(j))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })
	return out, nil
}

// ListRunnable implements RunnableJobStore.
func (m *MemoryJobStore) ListRunnable(_ context.Context) ([]canonical.MigrationJob, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]canonical.MigrationJob, 0)
	for _, j := range m.jobs {
		if j.Status == canonical.MigDryRun || j.Status == canonical.MigImporting {
			out = append(out, cloneJob(j))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out, nil
}

// SaveOAuthState implements MigrationJobStore.
func (m *MemoryJobStore) SaveOAuthState(_ context.Context, st OAuthStateRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.states[st.State] = st
	return nil
}

// ConsumeOAuthState implements MigrationJobStore.
func (m *MemoryJobStore) ConsumeOAuthState(_ context.Context, tenantID, state string, now time.Time) (OAuthStateRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.states[state]
	if !ok || st.TenantID != tenantID || !now.Before(st.ExpiresAt) {
		return OAuthStateRecord{}, ErrNotFound
	}
	delete(m.states, state)
	return st, nil
}

// SaveSession implements MigrationJobStore.
func (m *MemoryJobStore) SaveSession(_ context.Context, jobID, tenantID string, sess adapter.Session, expiresAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[jobID] = memorySessionRecord{
		TenantID:   tenantID,
		Session:    cloneSession(sess),
		ExpiresAt:  expiresAt,
		LastUsedAt: nil,
	}
	return nil
}

// GetSession implements MigrationJobStore.
func (m *MemoryJobStore) GetSession(_ context.Context, tenantID, jobID string, now time.Time) (adapter.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sessions[jobID]
	if !ok || rec.TenantID != tenantID || !now.Before(rec.ExpiresAt) {
		return adapter.Session{}, ErrNotFound
	}
	rec.LastUsedAt = &now
	m.sessions[jobID] = rec
	return cloneSession(rec.Session), nil
}

// GetSessionInfo implements MigrationJobStore.
func (m *MemoryJobStore) GetSessionInfo(_ context.Context, tenantID, jobID string, now time.Time) (SessionInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sessions[jobID]
	if !ok || rec.TenantID != tenantID || !now.Before(rec.ExpiresAt) {
		return SessionInfo{}, ErrNotFound
	}
	return SessionInfo{
		Source:              rec.Session.Source,
		ExpiresAt:           rec.ExpiresAt,
		LastUsedAt:          rec.LastUsedAt,
		SelectedAudienceIDs: selectedAudienceIDsFromSessionExtra(rec.Session.Extra),
	}, nil
}

// DeleteSession implements MigrationJobStore.
func (m *MemoryJobStore) DeleteSession(_ context.Context, tenantID, jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sessions[jobID]
	if !ok || rec.TenantID != tenantID {
		return ErrNotFound
	}
	delete(m.sessions, jobID)
	return nil
}

func (m *MemoryJobStore) UpsertShadowMonitor(_ context.Context, rec ShadowMonitorRecord) (ShadowMonitorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec.IntervalSeconds <= 0 {
		rec.IntervalSeconds = 3600
	}
	now := m.clock()
	existing, ok := m.monitors[rec.JobID]
	if !ok {
		existing = ShadowMonitorRecord{
			JobID:     rec.JobID,
			TenantID:  rec.TenantID,
			Source:    rec.Source,
			CreatedAt: now,
		}
	}
	existing.Enabled = true
	existing.IntervalSeconds = rec.IntervalSeconds
	if rec.NextCheckAt != nil {
		next := *rec.NextCheckAt
		existing.NextCheckAt = &next
	} else if existing.NextCheckAt == nil {
		next := now
		existing.NextCheckAt = &next
	}
	existing.UpdatedAt = now
	m.monitors[rec.JobID] = existing
	return cloneShadowMonitor(existing), nil
}

func (m *MemoryJobStore) DisableShadowMonitor(_ context.Context, tenantID, jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.monitors[jobID]
	if !ok || rec.TenantID != tenantID {
		return ErrNotFound
	}
	rec.Enabled = false
	rec.UpdatedAt = m.clock()
	m.monitors[jobID] = rec
	return nil
}

func (m *MemoryJobStore) GetShadowMonitor(_ context.Context, tenantID, jobID string) (ShadowMonitorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.monitors[jobID]
	if !ok || rec.TenantID != tenantID {
		return ShadowMonitorRecord{}, ErrNotFound
	}
	return cloneShadowMonitor(rec), nil
}

func (m *MemoryJobStore) ListDueShadowMonitors(_ context.Context, now time.Time, limit int) ([]ShadowMonitorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 {
		limit = 25
	}
	out := []ShadowMonitorRecord{}
	for _, rec := range m.monitors {
		if len(out) >= limit {
			break
		}
		if !rec.Enabled {
			continue
		}
		if rec.NextCheckAt == nil || !rec.NextCheckAt.After(now) {
			out = append(out, cloneShadowMonitor(rec))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		var left, right time.Time
		if out[i].NextCheckAt != nil {
			left = *out[i].NextCheckAt
		}
		if out[j].NextCheckAt != nil {
			right = *out[j].NextCheckAt
		}
		return left.Before(right)
	})
	return out, nil
}

func (m *MemoryJobStore) UpdateShadowMonitorAfterCheck(_ context.Context, tenantID, jobID string, checkedAt, nextCheckAt time.Time, action, errMsg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.monitors[jobID]
	if !ok || rec.TenantID != tenantID {
		return ErrNotFound
	}
	rec.LastCheckedAt = &checkedAt
	rec.NextCheckAt = &nextCheckAt
	rec.LastRecommendedAction = action
	rec.LastError = errMsg
	rec.UpdatedAt = m.clock()
	m.monitors[jobID] = rec
	return nil
}

func (m *MemoryJobStore) SaveShadowCheckResult(_ context.Context, rec ShadowCheckRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	results := m.shadowResults[rec.JobID]
	if len(results) > 0 {
		latest := results[len(results)-1].GeneratedAt
		if !rec.GeneratedAt.After(latest) {
			rec.GeneratedAt = latest.Add(time.Microsecond)
		}
	}
	if rec.ID == "" {
		rec.ID = fmt.Sprintf("shadow-%d", len(results)+1)
	}
	m.shadowResults[rec.JobID] = append(m.shadowResults[rec.JobID], cloneShadowCheck(rec))
	return nil
}

func (m *MemoryJobStore) ListShadowCheckResults(_ context.Context, tenantID, jobID string, limit int) ([]ShadowCheckRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	all := m.shadowResults[jobID]
	out := []ShadowCheckRecord{}
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		if all[i].TenantID == tenantID {
			out = append(out, cloneShadowCheck(all[i]))
		}
	}
	return out, nil
}

func (m *MemoryJobStore) UpsertSourceEventMonitor(_ context.Context, rec SourceEventMonitorRecord) (SourceEventMonitorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec.IntervalSeconds = normalizeSourceEventIntervalSeconds(rec.IntervalSeconds)
	now := m.clock()
	existing, ok := m.sourceEventMonitors[rec.JobID]
	if !ok {
		existing = SourceEventMonitorRecord{
			JobID:     rec.JobID,
			TenantID:  rec.TenantID,
			Source:    rec.Source,
			CreatedAt: now,
		}
	}
	resetEvidence := rec.Enabled && (!existing.Enabled || existing.EnabledSince == nil || existing.IntervalSeconds != rec.IntervalSeconds)
	if resetEvidence {
		t := now
		existing.EnabledSince = &t
		existing.FirstSyncedAt = nil
		existing.SuccessfulSyncs = 0
		existing.MaxSyncGapSecs = 0
		existing.LastSyncedAt = nil
	} else if !rec.Enabled {
		existing.EnabledSince = nil
	}
	existing.Enabled = rec.Enabled
	existing.IntervalSeconds = rec.IntervalSeconds
	if rec.Cursor != "" {
		existing.Cursor = rec.Cursor
	}
	if rec.LastEventAt != nil {
		t := *rec.LastEventAt
		existing.LastEventAt = &t
	}
	if rec.NextSyncAt != nil {
		t := *rec.NextSyncAt
		existing.NextSyncAt = &t
	} else if existing.NextSyncAt == nil {
		next := now
		existing.NextSyncAt = &next
	}
	existing.UpdatedAt = now
	m.sourceEventMonitors[rec.JobID] = existing
	return cloneSourceEventMonitor(existing), nil
}

func (m *MemoryJobStore) DisableSourceEventMonitor(_ context.Context, tenantID, jobID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sourceEventMonitors[jobID]
	if !ok || rec.TenantID != tenantID {
		return ErrNotFound
	}
	rec.Enabled = false
	rec.EnabledSince = nil
	rec.UpdatedAt = m.clock()
	m.sourceEventMonitors[jobID] = rec
	return nil
}

func (m *MemoryJobStore) GetSourceEventMonitor(_ context.Context, tenantID, jobID string) (SourceEventMonitorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sourceEventMonitors[jobID]
	if !ok || rec.TenantID != tenantID {
		return SourceEventMonitorRecord{}, ErrNotFound
	}
	return cloneSourceEventMonitor(rec), nil
}

func (m *MemoryJobStore) ListDueSourceEventMonitors(_ context.Context, now time.Time, limit int) ([]SourceEventMonitorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	out := []SourceEventMonitorRecord{}
	for _, rec := range m.sourceEventMonitors {
		if len(out) >= limit {
			break
		}
		if !rec.Enabled {
			continue
		}
		if rec.NextSyncAt == nil || !rec.NextSyncAt.After(now) {
			out = append(out, cloneSourceEventMonitor(rec))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		var left, right time.Time
		if out[i].NextSyncAt != nil {
			left = *out[i].NextSyncAt
		}
		if out[j].NextSyncAt != nil {
			right = *out[j].NextSyncAt
		}
		return left.Before(right)
	})
	return out, nil
}

func (m *MemoryJobStore) UpdateSourceEventMonitorAfterSync(_ context.Context, tenantID, jobID string, cursor string, lastEventAt *time.Time, syncedAt, nextSyncAt time.Time, seen, applied int, errMsg string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.sourceEventMonitors[jobID]
	if !ok || rec.TenantID != tenantID {
		return ErrNotFound
	}
	if !rec.Enabled {
		return ErrNotFound
	}
	rec.Cursor = cursor
	if lastEventAt != nil {
		t := *lastEventAt
		rec.LastEventAt = &t
	}
	if strings.TrimSpace(errMsg) == "" {
		if rec.FirstSyncedAt == nil {
			t := syncedAt
			rec.FirstSyncedAt = &t
		}
		if rec.LastSyncedAt != nil {
			gap := int(syncedAt.Sub(*rec.LastSyncedAt).Seconds())
			if gap > rec.MaxSyncGapSecs {
				rec.MaxSyncGapSecs = gap
			}
		}
		rec.SuccessfulSyncs++
		rec.LastSyncedAt = &syncedAt
	}
	rec.NextSyncAt = &nextSyncAt
	rec.LastError = errMsg
	rec.EventsSeen += seen
	rec.EventsApplied += applied
	rec.UpdatedAt = m.clock()
	m.sourceEventMonitors[jobID] = rec
	return nil
}

func (m *MemoryJobStore) SaveSourceEventResult(_ context.Context, rec SourceEventRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if strings.TrimSpace(rec.ReviewStatus) == "" {
		rec.ReviewStatus = "pending"
	}
	if rec.ID == "" {
		rec.ID = uuid.NewString()
	}
	if len(rec.Payload) == 0 {
		rec.Payload = json.RawMessage(`{}`)
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = m.clock()
	}
	results := m.sourceEventResults[rec.JobID]
	for i := range results {
		if results[i].TenantID == rec.TenantID && results[i].SourceEventID == rec.SourceEventID {
			rec.ID = results[i].ID
			rec.CreatedAt = results[i].CreatedAt
			rec.ReviewStatus = results[i].ReviewStatus
			rec.ReviewDetail = results[i].ReviewDetail
			rec.ReviewEvidence = append([]string(nil), results[i].ReviewEvidence...)
			if results[i].ReviewedAt != nil {
				t := *results[i].ReviewedAt
				rec.ReviewedAt = &t
			}
			results[i] = cloneSourceEventRecord(rec)
			m.sourceEventResults[rec.JobID] = results
			return nil
		}
	}
	m.sourceEventResults[rec.JobID] = append(results, cloneSourceEventRecord(rec))
	return nil
}

func (m *MemoryJobStore) GetSourceEventResult(_ context.Context, tenantID, jobID, sourceEventID string) (SourceEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, rec := range m.sourceEventResults[jobID] {
		if rec.TenantID == tenantID && rec.SourceEventID == sourceEventID {
			return cloneSourceEventRecord(rec), nil
		}
	}
	return SourceEventRecord{}, ErrNotFound
}

func (m *MemoryJobStore) GetSourceEventResultByID(_ context.Context, tenantID, jobID, eventID string) (SourceEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, rec := range m.sourceEventResults[jobID] {
		if rec.TenantID == tenantID && rec.ID == eventID {
			return cloneSourceEventRecord(rec), nil
		}
	}
	return SourceEventRecord{}, ErrNotFound
}

func (m *MemoryJobStore) UpdateSourceEventReview(_ context.Context, tenantID, jobID, eventID, status, detail string, evidence []string, reviewedAt *time.Time) (SourceEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	results := m.sourceEventResults[jobID]
	for i := range results {
		if results[i].TenantID != tenantID || results[i].ID != eventID || results[i].Applied || !strings.EqualFold(strings.TrimSpace(results[i].Action), "manual_review") {
			continue
		}
		results[i].ReviewStatus = status
		results[i].ReviewDetail = detail
		results[i].ReviewEvidence = append([]string(nil), evidence...)
		results[i].ReviewedAt = nil
		if reviewedAt != nil {
			t := *reviewedAt
			results[i].ReviewedAt = &t
		}
		m.sourceEventResults[jobID] = results
		return cloneSourceEventRecord(results[i]), nil
	}
	return SourceEventRecord{}, ErrNotFound
}

func (m *MemoryJobStore) ListSourceEventResults(_ context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	all := m.sourceEventResults[jobID]
	out := []SourceEventRecord{}
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		if all[i].TenantID == tenantID {
			out = append(out, cloneSourceEventRecord(all[i]))
		}
	}
	return out, nil
}

func (m *MemoryJobStore) ListFailedSourceEventResults(_ context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	all := m.sourceEventResults[jobID]
	out := []SourceEventRecord{}
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		if all[i].TenantID != tenantID {
			continue
		}
		if all[i].Applied && strings.TrimSpace(all[i].Error) == "" {
			continue
		}
		if sourceEventReviewComplete(all[i]) {
			continue
		}
		out = append(out, cloneSourceEventRecord(all[i]))
	}
	return out, nil
}

func (m *MemoryJobStore) ListReviewedSourceEventResults(_ context.Context, tenantID, jobID string, limit int) ([]SourceEventRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	all := m.sourceEventResults[jobID]
	out := []SourceEventRecord{}
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		if all[i].TenantID != tenantID || !sourceEventReviewComplete(all[i]) {
			continue
		}
		out = append(out, cloneSourceEventRecord(all[i]))
	}
	return out, nil
}

func cloneJob(j *canonical.MigrationJob) canonical.MigrationJob {
	if j == nil {
		return canonical.MigrationJob{}
	}
	cp := *j
	if j.Cursor != nil {
		cp.Cursor = make(map[string]*string, len(j.Cursor))
		for k, v := range j.Cursor {
			if v == nil {
				cp.Cursor[k] = nil
				continue
			}
			value := *v
			cp.Cursor[k] = &value
		}
	}
	if j.VerificationReport != nil {
		vr := *j.VerificationReport
		cp.VerificationReport = &vr
	}
	if j.SelectedAudienceIDs != nil {
		cp.SelectedAudienceIDs = append([]string(nil), j.SelectedAudienceIDs...)
	}
	return cp
}

func cloneSession(sess adapter.Session) adapter.Session {
	cp := sess
	if sess.Extra != nil {
		cp.Extra = make(map[string]string, len(sess.Extra))
		for k, v := range sess.Extra {
			cp.Extra[k] = v
		}
	}
	return cp
}

func selectedAudienceIDsFromSessionExtra(extra map[string]string) []string {
	const mailchimpSelectedAudiencesExtraKey = "mailchimp_selected_audience_ids"
	raw := strings.TrimSpace(extra[mailchimpSelectedAudiencesExtraKey])
	if raw == "" {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, strings.Count(raw, ",")+1)
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func scanShadowMonitor(row jobScanner) (ShadowMonitorRecord, error) {
	var out ShadowMonitorRecord
	if err := row.Scan(&out.JobID, &out.TenantID, &out.Source, &out.Enabled,
		&out.IntervalSeconds, &out.LastCheckedAt, &out.NextCheckAt,
		&out.LastRecommendedAction, &out.LastError, &out.CreatedAt,
		&out.UpdatedAt); err != nil {
		return ShadowMonitorRecord{}, err
	}
	return out, nil
}

func scanShadowCheckResult(row jobScanner) (ShadowCheckRecord, error) {
	var out ShadowCheckRecord
	if err := row.Scan(&out.ID, &out.JobID, &out.TenantID, &out.Source,
		&out.GeneratedAt, &out.NeedsDeltaImport, &out.RecommendedAction,
		&out.Error, &out.Snapshot); err != nil {
		return ShadowCheckRecord{}, err
	}
	return out, nil
}

func scanSourceEventMonitor(row jobScanner) (SourceEventMonitorRecord, error) {
	var out SourceEventMonitorRecord
	if err := row.Scan(&out.JobID, &out.TenantID, &out.Source, &out.Enabled,
		&out.IntervalSeconds, &out.EnabledSince, &out.FirstSyncedAt, &out.SuccessfulSyncs, &out.MaxSyncGapSecs,
		&out.Cursor, &out.LastEventAt, &out.LastSyncedAt,
		&out.NextSyncAt, &out.LastError, &out.EventsSeen, &out.EventsApplied,
		&out.CreatedAt, &out.UpdatedAt); err != nil {
		return SourceEventMonitorRecord{}, err
	}
	return out, nil
}

func scanSourceEventResult(row jobScanner) (SourceEventRecord, error) {
	var out SourceEventRecord
	if err := row.Scan(&out.ID, &out.JobID, &out.TenantID, &out.Source,
		&out.SourceEventID, &out.ResourceType, &out.Action, &out.OccurredAt,
		&out.Applied, &out.Error, &out.ReviewStatus, &out.ReviewDetail,
		&out.ReviewEvidence, &out.ReviewedAt, &out.Payload, &out.CreatedAt); err != nil {
		return SourceEventRecord{}, err
	}
	return out, nil
}

func cloneShadowMonitor(rec ShadowMonitorRecord) ShadowMonitorRecord {
	cp := rec
	if rec.LastCheckedAt != nil {
		t := *rec.LastCheckedAt
		cp.LastCheckedAt = &t
	}
	if rec.NextCheckAt != nil {
		t := *rec.NextCheckAt
		cp.NextCheckAt = &t
	}
	return cp
}

func cloneShadowCheck(rec ShadowCheckRecord) ShadowCheckRecord {
	cp := rec
	if rec.Snapshot != nil {
		cp.Snapshot = append(json.RawMessage(nil), rec.Snapshot...)
	}
	return cp
}

func cloneSourceEventMonitor(rec SourceEventMonitorRecord) SourceEventMonitorRecord {
	cp := rec
	if rec.LastEventAt != nil {
		t := *rec.LastEventAt
		cp.LastEventAt = &t
	}
	if rec.EnabledSince != nil {
		t := *rec.EnabledSince
		cp.EnabledSince = &t
	}
	if rec.FirstSyncedAt != nil {
		t := *rec.FirstSyncedAt
		cp.FirstSyncedAt = &t
	}
	if rec.LastSyncedAt != nil {
		t := *rec.LastSyncedAt
		cp.LastSyncedAt = &t
	}
	if rec.NextSyncAt != nil {
		t := *rec.NextSyncAt
		cp.NextSyncAt = &t
	}
	return cp
}

func cloneSourceEventRecord(rec SourceEventRecord) SourceEventRecord {
	cp := rec
	if rec.OccurredAt != nil {
		t := *rec.OccurredAt
		cp.OccurredAt = &t
	}
	if rec.Payload != nil {
		cp.Payload = append(json.RawMessage(nil), rec.Payload...)
	}
	if rec.ReviewEvidence != nil {
		cp.ReviewEvidence = append([]string(nil), rec.ReviewEvidence...)
	}
	if rec.ReviewedAt != nil {
		t := *rec.ReviewedAt
		cp.ReviewedAt = &t
	}
	return cp
}

func sourceEventReviewComplete(rec SourceEventRecord) bool {
	return !rec.Applied && strings.EqualFold(strings.TrimSpace(rec.Action), "manual_review") && rec.ReviewStatus == "reviewed" &&
		rec.ReviewedAt != nil && strings.TrimSpace(rec.ReviewDetail) != "" && len(rec.ReviewEvidence) > 0
}

func normalizeSourceEventIntervalSeconds(seconds int) int {
	if seconds <= 0 {
		return 300
	}
	if seconds < 60 {
		return 60
	}
	if seconds > 24*3600 {
		return 24 * 3600
	}
	return seconds
}
