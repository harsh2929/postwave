// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const workerTenantInventorySQL = `
SELECT tenant_id::text
  FROM deliverability_hub_worker_tenants($1, $2)
 ORDER BY tenant_id`

const deliverabilityModelWindow = 30 * 24 * time.Hour

// listWorkerTenants uses a column-bounded SECURITY DEFINER function rather
// than widening cross-tenant RLS on subscriber/campaign tables. Its inventory
// includes qualified campaign cohorts across the full model window, recent
// event activity, every DNS identity workspace, and recent blocklist evidence.
func (w *Worker) listWorkerTenants(ctx context.Context) ([]string, error) {
	if w == nil || w.Deps == nil || w.Deps.Pool == nil {
		return nil, fmt.Errorf("deliverability inventory: nil dependencies")
	}
	tx, err := db.WithWorkerScope(ctx, w.Deps.Pool)
	if err != nil {
		return nil, fmt.Errorf("deliverability inventory: begin worker transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	since := w.Deps.now().UTC().Add(-deliverabilityModelWindow)
	rows, err := tx.Query(ctx, workerTenantInventorySQL, since, MinimumRateSampleSends)
	if err != nil {
		return nil, fmt.Errorf("deliverability inventory: query candidates: %w", err)
	}
	defer rows.Close()

	tenants := make([]string, 0)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, fmt.Errorf("deliverability inventory: scan tenant: %w", err)
		}
		if tenantID != "" {
			tenants = append(tenants, tenantID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("deliverability inventory: iterate candidates: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("deliverability inventory: commit read: %w", err)
	}
	return tenants, nil
}
