// SPDX-License-Identifier: AGPL-3.0-only
//
// store_pg.go — Postgres impl of PolicyStore. Every read/write opens
// a tenant-scoped tx via db.WithTenant so the RLS policies on
// sunset_policies + sunset_executions enforce the boundary. The
// SubscriberStore Postgres impl is intentionally left for a follow-up
// because it has to join across many tables in the subscribers package
// (subscriber_events + email_events + subscriber_tags + suppressions)
// that already have their own access layers; gluing it here would
// fork that surface. Until then, the engine wires a Postgres
// SubscriberStore via the existing subscribers package directly.

package sunset

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// pgPolicyStore is the production PolicyStore.
type pgPolicyStore struct {
	pool *db.Pool
}

// NewPostgresPolicyStore wraps the pgx pool. Returns an error when
// pool is nil so the boot path fails fast.
func NewPostgresPolicyStore(pool *db.Pool) (PolicyStore, error) {
	if pool == nil {
		return nil, errors.New("sunset: nil pool")
	}
	return &pgPolicyStore{pool: pool}, nil
}

func (s *pgPolicyStore) GetPolicy(ctx context.Context, tenantID, policyID string) (Policy, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Policy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	p, err := scanOnePolicy(ctx, tx, `
		SELECT id::text, tenant_id::text, name, inactive_days, action, enabled,
		       COALESCE(excluded_tags, '{}'::text[]), created_at, updated_at
		  FROM sunset_policies
		 WHERE id = $1::uuid`, policyID)
	if err != nil {
		return Policy{}, err
	}
	return p, tx.Commit(ctx)
}

func (s *pgPolicyStore) ListPolicies(ctx context.Context, tenantID string, enabledOnly bool) ([]Policy, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `SELECT id::text, tenant_id::text, name, inactive_days, action, enabled,
	             COALESCE(excluded_tags, '{}'::text[]), created_at, updated_at
	        FROM sunset_policies`
	if enabledOnly {
		q += " WHERE enabled = true"
	}
	q += " ORDER BY created_at DESC"
	rows, err := tx.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list sunset_policies: %w", err)
	}
	defer rows.Close()
	out := []Policy{}
	for rows.Next() {
		var p Policy
		if err := rows.Scan(&p.ID, &p.TenantID, &p.Name, &p.InactiveDays,
			(*string)(&p.Action), &p.Enabled, &p.ExcludedTags,
			&p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (s *pgPolicyStore) CreatePolicy(ctx context.Context, tenantID string, in Policy) (Policy, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Policy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.ExcludedTags == nil {
		in.ExcludedTags = []string{}
	}
	var p Policy
	err = tx.QueryRow(ctx, `
		INSERT INTO sunset_policies (tenant_id, name, inactive_days, action, enabled, excluded_tags)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)
		RETURNING id::text, tenant_id::text, name, inactive_days, action, enabled,
		          COALESCE(excluded_tags, '{}'::text[]), created_at, updated_at`,
		tenantID, in.Name, in.InactiveDays, string(in.Action), in.Enabled, in.ExcludedTags,
	).Scan(&p.ID, &p.TenantID, &p.Name, &p.InactiveDays,
		(*string)(&p.Action), &p.Enabled, &p.ExcludedTags,
		&p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return Policy{}, fmt.Errorf("insert sunset_policies: %w", err)
	}
	return p, tx.Commit(ctx)
}

func (s *pgPolicyStore) UpdatePolicy(ctx context.Context, tenantID string, in Policy) (Policy, error) {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return Policy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if in.ExcludedTags == nil {
		in.ExcludedTags = []string{}
	}
	var p Policy
	err = tx.QueryRow(ctx, `
		UPDATE sunset_policies
		   SET name          = $2,
		       inactive_days = $3,
		       action        = $4,
		       enabled       = $5,
		       excluded_tags = $6
		 WHERE id = $1::uuid
		RETURNING id::text, tenant_id::text, name, inactive_days, action, enabled,
		          COALESCE(excluded_tags, '{}'::text[]), created_at, updated_at`,
		in.ID, in.Name, in.InactiveDays, string(in.Action), in.Enabled, in.ExcludedTags,
	).Scan(&p.ID, &p.TenantID, &p.Name, &p.InactiveDays,
		(*string)(&p.Action), &p.Enabled, &p.ExcludedTags,
		&p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Policy{}, ErrNotFound
	}
	if err != nil {
		return Policy{}, fmt.Errorf("update sunset_policies: %w", err)
	}
	return p, tx.Commit(ctx)
}

func (s *pgPolicyStore) DeletePolicy(ctx context.Context, tenantID, policyID string) error {
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ct, err := tx.Exec(ctx, `DELETE FROM sunset_policies WHERE id = $1::uuid`, policyID)
	if err != nil {
		return fmt.Errorf("delete sunset_policies: %w", err)
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *pgPolicyStore) RecordExecution(ctx context.Context, e Execution) error {
	tx, err := db.WithTenant(ctx, s.pool, e.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// ON CONFLICT honours the (policy_id, subscriber_id) UNIQUE — a
	// re-run of the detector pass is a no-op on the second insert.
	_, err = tx.Exec(ctx, `
		INSERT INTO sunset_executions
		  (tenant_id, policy_id, subscriber_id, action_taken, reason)
		VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
		ON CONFLICT (policy_id, subscriber_id) DO NOTHING`,
		e.TenantID, e.PolicyID, e.SubscriberID, string(e.ActionTaken), e.Reason)
	if err != nil {
		return fmt.Errorf("insert sunset_executions: %w", err)
	}
	return tx.Commit(ctx)
}

func (s *pgPolicyStore) ListExecutions(ctx context.Context, tenantID, policyID string, limit int) ([]Execution, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, s.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, policy_id::text, subscriber_id::text,
		       action_taken, COALESCE(reason, ''), executed_at
		  FROM sunset_executions
		 WHERE policy_id = $1::uuid
		 ORDER BY executed_at DESC
		 LIMIT $2`, policyID, limit)
	if err != nil {
		return nil, fmt.Errorf("list sunset_executions: %w", err)
	}
	defer rows.Close()
	out := []Execution{}
	for rows.Next() {
		var e Execution
		if err := rows.Scan(&e.ID, &e.TenantID, &e.PolicyID, &e.SubscriberID,
			(*string)(&e.ActionTaken), &e.Reason, &e.ExecutedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func scanOnePolicy(ctx context.Context, q pgx.Tx, sql string, args ...any) (Policy, error) {
	row := q.QueryRow(ctx, sql, args...)
	var p Policy
	if err := row.Scan(&p.ID, &p.TenantID, &p.Name, &p.InactiveDays,
		(*string)(&p.Action), &p.Enabled, &p.ExcludedTags,
		&p.CreatedAt, &p.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Policy{}, ErrNotFound
		}
		return Policy{}, fmt.Errorf("scan sunset_policy: %w", err)
	}
	return p, nil
}
