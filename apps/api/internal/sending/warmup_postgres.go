package sending

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresWarmupTracker reads/writes warmup state on the sending_state table.
// Implements the WarmupTracker interface so it is a drop-in replacement for
// MemoryWarmupTracker.
//
// All writes are scoped to a tenant via SET LOCAL app.tenant_id so the RLS
// policy on sending_state fires.
type PostgresWarmupTracker struct {
	Pool *pgxpool.Pool
}

// NewPostgresWarmupTracker constructs a tracker. Validates pool is non-nil.
func NewPostgresWarmupTracker(pool *pgxpool.Pool) (*PostgresWarmupTracker, error) {
	if pool == nil {
		return nil, errors.New("nil pgx pool")
	}
	return &PostgresWarmupTracker{Pool: pool}, nil
}

// Get implements WarmupTracker.
func (p *PostgresWarmupTracker) Get(ctx context.Context, tenantID string) (*WarmupState, error) {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var startedAt *time.Time
	var day, tierLimit int
	var dailyRaw []byte
	err = tx.QueryRow(ctx, `
		SELECT warmup_started_at, warmup_day, daily_sent, tier_limit
		  FROM sending_state WHERE tenant_id = $1
	`, tenantID).Scan(&startedAt, &day, &dailyRaw, &tierLimit)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st := &WarmupState{TenantID: tenantID, WarmupDay: day, DailySent: map[string]int{}, TierLimit: tierLimit}
	if startedAt != nil {
		st.WarmupStartedAt = *startedAt
	}
	if len(dailyRaw) > 0 {
		_ = json.Unmarshal(dailyRaw, &st.DailySent)
	}
	return st, tx.Commit(ctx)
}

// Start implements WarmupTracker.
func (p *PostgresWarmupTracker) Start(ctx context.Context, tenantID string, at time.Time, tierLimit int) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
		UPDATE sending_state
		   SET warmup_started_at = $2,
		       warmup_day = 1,
		       tier_limit = $3,
		       daily_sent = '{}'::jsonb,
		       updated_at = now()
		 WHERE tenant_id = $1
	`, tenantID, at.UTC(), tierLimit)
	if err != nil {
		return fmt.Errorf("start warmup: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("start warmup: sending_state row missing for tenant %s", tenantID)
	}
	return tx.Commit(ctx)
}

// RecordSends implements WarmupTracker.
func (p *PostgresWarmupTracker) RecordSends(ctx context.Context, tenantID string, n int, at time.Time) error {
	tx, err := p.beginTenant(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	day := at.UTC().Format("2006-01-02")
	// jsonb_set(daily_sent, '{<day>}', to_jsonb(coalesce(daily_sent->>'<day>',0)::int + n))
	_, err = tx.Exec(ctx, `
		UPDATE sending_state
		   SET daily_sent = jsonb_set(
		           daily_sent,
		           ARRAY[$2],
		           to_jsonb(COALESCE((daily_sent->>$2)::int, 0) + $3),
		           true
		       ),
		       warmup_day = GREATEST(warmup_day,
		           CASE
		             WHEN warmup_started_at IS NULL THEN 0
		             ELSE GREATEST(1, (EXTRACT(EPOCH FROM (now() - warmup_started_at))/86400)::int + 1)
		           END
		       ),
		       updated_at = now()
		 WHERE tenant_id = $1
	`, tenantID, day, n)
	if err != nil {
		return fmt.Errorf("record sends: %w", err)
	}
	return tx.Commit(ctx)
}

// beginTenant opens a tx + sets the tenant scope. Mirrors db.WithTenant but
// inlined to avoid a circular import (the db package depends on sending for
// no good reason; we keep this contained here).
func (p *PostgresWarmupTracker) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
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
