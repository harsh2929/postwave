// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const notificationIdentityWorkerGUC = "app.mobile_push_notification_identity_worker"

// withMobilePushWorkerScope advertises that this lifecycle worker restores
// notification_id when it reconstructs an Expo request. Migration 1858 uses
// the transaction-local capability to keep security deliveries away from
// older replicas during a rolling deployment.
func withMobilePushWorkerScope(ctx context.Context, pool *db.Pool) (pgx.Tx, error) {
	tx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		return nil, err
	}
	if err := setNotificationIdentityWorkerCapability(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// Completion runs tenant-scoped after a cross-tenant claim. Bind the same
// capability there so every claim/finalisation transaction has an explicit,
// auditable compatibility declaration.
func withMobilePushTenantScope(ctx context.Context, pool *db.Pool, tenantID string) (pgx.Tx, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, err
	}
	if err := setNotificationIdentityWorkerCapability(ctx, tx); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

func setNotificationIdentityWorkerCapability(ctx context.Context, tx pgx.Tx) error {
	if _, err := tx.Exec(ctx,
		"SELECT set_config('"+notificationIdentityWorkerGUC+"', 'true', true)"); err != nil {
		return fmt.Errorf("mobile push: set notification identity worker capability: %w", err)
	}
	return nil
}
