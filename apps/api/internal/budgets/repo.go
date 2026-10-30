// SPDX-License-Identifier: AGPL-3.0-only
package budgets

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo is the pgx-backed implementation of Checker.
type Repo struct {
	Pool *db.Pool
}

// LoadBudget reads the budget columns from api_keys. Lookup happens without
// a tenant context (the api_keys_hash_lookup permissive policy still applies
// for SELECT) so the middleware can call this before the tenant tx is open.
func (r *Repo) LoadBudget(ctx context.Context, apiKeyID string) (*Budget, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Release()
	var b Budget
	row := conn.QueryRow(ctx, `
SELECT id::text, tenant_id::text, sends_per_day, dollars_per_month_cents
FROM api_keys
WHERE id::text = $1 AND revoked_at IS NULL
LIMIT 1`, apiKeyID)
	if err := row.Scan(&b.APIKeyID, &b.TenantID, &b.SendsPerDay, &b.DollarsPerMonthCents); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &b, nil
}

// LoadUsage reads (sends, cost_cents) for the given key + period bucket.
// Returns a zero-valued Usage (not nil) when no row exists yet.
func (r *Repo) LoadUsage(ctx context.Context, apiKeyID string, period time.Time) (*Usage, error) {
	// We load the budget first to learn the tenant; the api_key_usage table
	// is RLS-scoped so the SELECT must run inside a tenant tx.
	b, err := r.LoadBudget(ctx, apiKeyID)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return &Usage{APIKeyID: apiKeyID, Period: period}, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, b.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	u := &Usage{APIKeyID: apiKeyID, Period: period}
	row := tx.QueryRow(ctx, `
SELECT sends, cost_cents
FROM api_key_usage
WHERE api_key_id = $1::uuid AND period = $2::date`,
		apiKeyID, period)
	if err := row.Scan(&u.Sends, &u.CostCents); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_ = tx.Commit(ctx)
			return u, nil
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return u, nil
}

// IncrementUsage atomically bumps the running totals for the period bucket
// matching `resource` and `at`. It uses INSERT ... ON CONFLICT DO UPDATE so
// concurrent callers do not lose increments.
func (r *Repo) IncrementUsage(ctx context.Context, b *Budget, resource Resource, increment int, at time.Time) error {
	if b == nil {
		return errors.New("budgets: IncrementUsage requires a budget")
	}
	period := PeriodFor(resource, at)
	tx, err := db.WithTenant(ctx, r.Pool, b.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var sendsDelta, costDelta int
	switch resource {
	case ResourceSends:
		sendsDelta = increment
	case ResourceCost:
		costDelta = increment
	default:
		return errors.New("budgets: unknown resource")
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO api_key_usage (api_key_id, tenant_id, period, sends, cost_cents)
VALUES ($1::uuid, $2::uuid, $3::date, $4, $5)
ON CONFLICT (api_key_id, period) DO UPDATE
SET sends      = api_key_usage.sends      + EXCLUDED.sends,
    cost_cents = api_key_usage.cost_cents + EXCLUDED.cost_cents`,
		b.APIKeyID, b.TenantID, period, sendsDelta, costDelta); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
