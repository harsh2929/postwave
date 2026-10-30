package sending

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStateRepo persists per-tenant sending provisioning state in the
// sending_state table. Every operation runs inside a tenant-scoped tx so RLS
// remains the primary isolation boundary.
type PostgresStateRepo struct {
	Pool *pgxpool.Pool
}

// NewPostgresStateRepo constructs a Postgres-backed StateRepo.
func NewPostgresStateRepo(pool *pgxpool.Pool) (*PostgresStateRepo, error) {
	if pool == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &PostgresStateRepo{Pool: pool}, nil
}

// Get implements StateRepo.
func (p *PostgresStateRepo) Get(ctx context.Context, tenantID string) (*State, []byte, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var st State
	var token []byte
	var warmupStartedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT tenant_id::text, tier, COALESCE(postmark_server_id, ''),
		       postmark_server_token_encrypted, COALESCE(postmark_stream_id, ''),
		       COALESCE(dkim_domain, ''), COALESCE(dedicated_ip, ''),
		       warmup_started_at, warmup_day
		  FROM sending_state
		 WHERE tenant_id = $1::uuid
	`, tenantID).Scan(
		&st.TenantID,
		&st.Tier,
		&st.PostmarkServerID,
		&token,
		&st.PostmarkStreamID,
		&st.DKIMDomain,
		&st.DedicatedIP,
		&warmupStartedAt,
		&st.WarmupDay,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("get sending_state: %w", err)
	}
	if warmupStartedAt != nil {
		st.WarmupStartedAt = *warmupStartedAt
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return &st, token, nil
}

// Upsert implements StateRepo. A nil encryptedToken preserves the existing
// ciphertext on update, matching MemoryStateRepo's behavior.
func (p *PostgresStateRepo) Upsert(ctx context.Context, st *State, encryptedToken []byte) error {
	if st == nil {
		return errors.New("nil sending state")
	}
	tx, err := p.beginTenant(ctx, st.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var warmupStartedAt *time.Time
	if !st.WarmupStartedAt.IsZero() {
		t := st.WarmupStartedAt.UTC()
		warmupStartedAt = &t
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO sending_state (
		    tenant_id, tier, postmark_server_id,
		    postmark_server_token_encrypted, postmark_stream_id,
		    dkim_domain, dedicated_ip, warmup_started_at, warmup_day
		)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (tenant_id) DO UPDATE SET
		    tier = EXCLUDED.tier,
		    postmark_server_id = EXCLUDED.postmark_server_id,
		    postmark_server_token_encrypted = COALESCE(EXCLUDED.postmark_server_token_encrypted, sending_state.postmark_server_token_encrypted),
		    postmark_stream_id = EXCLUDED.postmark_stream_id,
		    dkim_domain = EXCLUDED.dkim_domain,
		    dedicated_ip = EXCLUDED.dedicated_ip,
		    warmup_started_at = EXCLUDED.warmup_started_at,
		    warmup_day = EXCLUDED.warmup_day,
		    updated_at = now()
	`, st.TenantID, st.Tier, st.PostmarkServerID, encryptedToken, st.PostmarkStreamID,
		st.DKIMDomain, st.DedicatedIP, warmupStartedAt, st.WarmupDay)
	if err != nil {
		return fmt.Errorf("upsert sending_state: %w", err)
	}
	return tx.Commit(ctx)
}

// Delete implements StateRepo.
func (p *PostgresStateRepo) Delete(ctx context.Context, tenantID string) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM sending_state WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return fmt.Errorf("delete sending_state: %w", err)
	}
	return tx.Commit(ctx)
}

func (p *PostgresStateRepo) ScheduleDeprovision(ctx context.Context, tenantID, serverID, streamID string, scheduledAt time.Time) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		INSERT INTO sending_deprovision_jobs (tenant_id, postmark_server_id, postmark_stream_id, scheduled_at)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (tenant_id, postmark_server_id) WHERE completed_at IS NULL DO UPDATE SET
		    postmark_stream_id = EXCLUDED.postmark_stream_id,
		    scheduled_at = LEAST(sending_deprovision_jobs.scheduled_at, EXCLUDED.scheduled_at),
		    updated_at = now()
	`, tenantID, serverID, streamID, scheduledAt.UTC())
	if err != nil {
		return fmt.Errorf("schedule deprovision: %w", err)
	}
	return tx.Commit(ctx)
}

func (p *PostgresStateRepo) ListDueDeprovisionJobs(ctx context.Context, now time.Time, limit int) ([]DeprovisionJob, error) {
	if limit <= 0 {
		limit = 25
	}
	tx, err := p.beginDeprovisionWorker(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		WITH picked AS (
			SELECT id
			  FROM sending_deprovision_jobs
			 WHERE completed_at IS NULL
			   AND scheduled_at <= $1
			   AND (attempted_at IS NULL OR attempted_at < $1 - interval '1 hour')
			 ORDER BY scheduled_at ASC
			 LIMIT $2
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE sending_deprovision_jobs j
		   SET attempted_at = $1,
		       updated_at = now()
		  FROM picked
		 WHERE j.id = picked.id
		RETURNING j.id::text, j.tenant_id::text, j.postmark_server_id,
		          COALESCE(j.postmark_stream_id, ''), j.scheduled_at, j.attempts
	`, now.UTC(), limit)
	if err != nil {
		return nil, fmt.Errorf("list deprovision jobs: %w", err)
	}
	defer rows.Close()
	out := []DeprovisionJob{}
	for rows.Next() {
		var job DeprovisionJob
		if err := rows.Scan(&job.ID, &job.TenantID, &job.PostmarkServerID, &job.PostmarkStreamID, &job.ScheduledAt, &job.Attempts); err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (p *PostgresStateRepo) MarkDeprovisionJobCompleted(ctx context.Context, id string, completedAt time.Time) error {
	tx, err := p.beginDeprovisionWorker(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sending_deprovision_jobs
		   SET completed_at = $2, attempted_at = $2, updated_at = now()
		 WHERE id = $1::uuid
	`, id, completedAt.UTC())
	if err != nil {
		return fmt.Errorf("complete deprovision job: %w", err)
	}
	return tx.Commit(ctx)
}

func (p *PostgresStateRepo) MarkDeprovisionJobFailed(ctx context.Context, id string, attemptedAt time.Time, errText string) error {
	tx, err := p.beginDeprovisionWorker(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
		UPDATE sending_deprovision_jobs
		   SET attempted_at = $2,
		       attempts = attempts + 1,
		       scheduled_at = $2 + ((LEAST(attempts + 1, 24))::text || ' hours')::interval,
		       last_error = $3,
		       updated_at = now()
		 WHERE id = $1::uuid
	`, id, attemptedAt.UTC(), errText)
	if err != nil {
		return fmt.Errorf("fail deprovision job: %w", err)
	}
	return tx.Commit(ctx)
}

func (p *PostgresStateRepo) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
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

func (p *PostgresStateRepo) beginDeprovisionWorker(ctx context.Context) (pgx.Tx, error) {
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.sending_deprovision_worker', 'true', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

var _ StateRepo = (*PostgresStateRepo)(nil)
var _ DeprovisionJobRepo = (*PostgresStateRepo)(nil)
