// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// dashboardWorkerTenantIDs is the deliberately narrow cross-tenant step used
// by the dashboard background workers. The worker policy can enumerate only
// tenants; every read of tenant-owned data must re-enter db.WithTenant.
func dashboardWorkerTenantIDs(ctx context.Context, pool *db.Pool) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("list worker tenants: %w", err)
	}
	defer rows.Close()

	tenantIDs := make([]string, 0)
	for rows.Next() {
		var tenantID string
		if err := rows.Scan(&tenantID); err != nil {
			return nil, fmt.Errorf("scan worker tenant: %w", err)
		}
		tenantIDs = append(tenantIDs, tenantID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate worker tenants: %w", err)
	}
	return tenantIDs, nil
}
