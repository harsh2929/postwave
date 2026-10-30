package mailchimpv3

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func (d *Deps) platformRepo() (*Repo, bool) {
	repo, ok := d.Store.(*Repo)
	return repo, ok && repo != nil && repo.Pool != nil
}

func listPlatformStateItems[T any](ctx context.Context, d *Deps, tenant *middleware.Tenant, kind string) ([]T, bool) {
	repo, ok := d.platformRepo()
	if !ok {
		return nil, false
	}
	tx, err := db.WithTenant(ctx, repo.Pool, tenant.ID)
	if err != nil {
		return nil, false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT payload
  FROM mailchimp_platform_state
 WHERE tenant_id = $1::uuid AND kind = $2
 ORDER BY updated_at DESC`, tenant.ID, kind)
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, false
		}
		var item T
		if err := json.Unmarshal(raw, &item); err != nil {
			return nil, false
		}
		out = append(out, item)
	}
	if rows.Err() != nil {
		return nil, false
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false
	}
	return out, true
}

func (d *Deps) savePlatformStateItem(ctx context.Context, tenant *middleware.Tenant, kind, itemID string, payload any) bool {
	repo, ok := d.platformRepo()
	if !ok || itemID == "" {
		return false
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	tx, err := db.WithTenant(ctx, repo.Pool, tenant.ID)
	if err != nil {
		return false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO mailchimp_platform_state (tenant_id, kind, item_id, payload)
VALUES ($1::uuid, $2, $3, $4::jsonb)
ON CONFLICT (tenant_id, kind, item_id) DO UPDATE SET
  payload = EXCLUDED.payload,
  updated_at = now()`, tenant.ID, kind, itemID, string(raw)); err != nil {
		return false
	}
	return tx.Commit(ctx) == nil
}

func (d *Deps) getPlatformStateItem(ctx context.Context, tenant *middleware.Tenant, kind, itemID string, dest any) bool {
	repo, ok := d.platformRepo()
	if !ok || itemID == "" {
		return false
	}
	tx, err := db.WithTenant(ctx, repo.Pool, tenant.ID)
	if err != nil {
		return false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var raw []byte
	if err := tx.QueryRow(ctx, `
SELECT payload
  FROM mailchimp_platform_state
 WHERE tenant_id = $1::uuid AND kind = $2 AND item_id = $3`, tenant.ID, kind, itemID).Scan(&raw); err != nil {
		return false
	}
	if err := json.Unmarshal(raw, dest); err != nil {
		return false
	}
	return tx.Commit(ctx) == nil
}

func (d *Deps) deletePlatformStateItem(ctx context.Context, tenant *middleware.Tenant, kind, itemID string) bool {
	repo, ok := d.platformRepo()
	if !ok || itemID == "" {
		return false
	}
	tx, err := db.WithTenant(ctx, repo.Pool, tenant.ID)
	if err != nil {
		return false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM mailchimp_platform_state
 WHERE tenant_id = $1::uuid AND kind = $2 AND item_id = $3`, tenant.ID, kind, itemID); err != nil {
		return false
	}
	return tx.Commit(ctx) == nil
}

func platformStateUnavailable(kind string) error {
	return fmt.Errorf("mailchimp platform state %s unavailable", kind)
}
