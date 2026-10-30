// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ZeroBounce documents 30 real-time batch requests per minute. A two-second
// durable slot is shared by every replica and synchronous/job caller using the
// same tenant provider configuration.
const zeroBounceBatchInterval = 2 * time.Second

func (s *Store) waitForZeroBounceBatchSlot(ctx context.Context, tenantID string) error {
	wait, err := s.reserveProviderBatchSlot(ctx, tenantID, ProviderZeroBounce, zeroBounceBatchInterval)
	if err != nil {
		// Database detail can contain tenant/topology identifiers. The caller only
		// needs the retry-safe fact that no provider request was dispatched.
		return fmt.Errorf("verification: provider batch pacing is unavailable: %w", ErrProviderUnavailable)
	}
	if wait <= 0 {
		return nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *Store) reserveProviderBatchSlot(
	ctx context.Context,
	tenantID, provider string,
	interval time.Duration,
) (time.Duration, error) {
	if s == nil || s.Pool == nil {
		return 0, fmt.Errorf("verification: provider pacing store is unavailable")
	}
	if provider != ProviderZeroBounce || interval < time.Second {
		return 0, fmt.Errorf("verification: unsupported provider pacing reservation")
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO verification_provider_batch_slots (tenant_id, provider, next_dispatch_at)
VALUES ($1::uuid, $2, clock_timestamp())
ON CONFLICT (tenant_id, provider) DO NOTHING`, tenantID, provider); err != nil {
		return 0, err
	}
	var next, databaseNow time.Time
	if err := tx.QueryRow(ctx, `
SELECT next_dispatch_at, clock_timestamp()
  FROM verification_provider_batch_slots
 WHERE tenant_id = $1::uuid AND provider = $2
 FOR UPDATE`, tenantID, provider).Scan(&next, &databaseNow); err != nil {
		return 0, err
	}
	dispatchAt := next
	if dispatchAt.Before(databaseNow) {
		dispatchAt = databaseNow
	}
	if _, err := tx.Exec(ctx, `
UPDATE verification_provider_batch_slots
   SET next_dispatch_at = $3::timestamptz + $4::interval,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND provider = $2`,
		tenantID, provider, dispatchAt, interval); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	wait := dispatchAt.Sub(databaseNow)
	if wait < 0 {
		return 0, nil
	}
	return wait, nil
}
