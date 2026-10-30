// SPDX-License-Identifier: AGPL-3.0-only
package dedupeinfo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo wraps the pgx pool with tenant_dedupe_settings access. Every method
// goes through db.WithTenant so the RLS policy on the table is satisfied.
type Repo struct {
	Pool *db.Pool
}

// Load reads the per-tenant deduplication settings. When no row exists the
// default threshold is returned (so callers never special-case
// "unconfigured"). A pgx.ErrNoRows is mapped to the default; any other read
// error is surfaced.
func (r *Repo) Load(ctx context.Context, tenantID string) (Settings, error) {
	out := Settings{MergeConfidenceThreshold: DefaultThreshold}
	if r == nil || r.Pool == nil {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT merge_confidence_threshold::float8
  FROM tenant_dedupe_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&out.MergeConfidenceThreshold)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Settings{MergeConfidenceThreshold: DefaultThreshold}, nil
		}
		return Settings{MergeConfidenceThreshold: DefaultThreshold}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}

// Upsert writes the per-tenant threshold and returns the resolved settings.
// At most one row per tenant (ON CONFLICT (tenant_id)).
func (r *Repo) Upsert(ctx context.Context, tenantID string, threshold float64) (Settings, error) {
	out := Settings{MergeConfidenceThreshold: threshold}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
INSERT INTO tenant_dedupe_settings (tenant_id, merge_confidence_threshold)
VALUES ($1::uuid, $2)
ON CONFLICT (tenant_id) DO UPDATE
   SET merge_confidence_threshold = EXCLUDED.merge_confidence_threshold,
       updated_at                 = now()
RETURNING merge_confidence_threshold::float8`,
		tenantID, threshold).Scan(&out.MergeConfidenceThreshold); err != nil {
		return Settings{MergeConfidenceThreshold: threshold}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return out, err
	}
	return out, nil
}
