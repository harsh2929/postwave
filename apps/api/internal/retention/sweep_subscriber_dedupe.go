// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// sweepExpiredSubscriberDuplicateScans removes the privacy-minimised scan
// cache after its contractual 24-hour lifetime. Pair rows are drained in
// bounded transactions before their parent manifests so a very large scan
// cannot turn one retention tick into an unbounded cascading delete.
func (s *Sweeper) sweepExpiredSubscriberDuplicateScans(ctx context.Context, tenantID string) (int64, error) {
	var total int64
	for index := 0; index < s.maxBatchesPerTenant(); index++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepExpiredSubscriberDuplicatePairBatch(ctx, tenantID)
		if err != nil {
			return total, err
		}
		total += n
		if n == 0 {
			break
		}
	}
	for index := 0; index < s.maxBatchesPerTenant(); index++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepExpiredSubscriberDuplicateScanBatch(ctx, tenantID)
		if err != nil {
			return total, err
		}
		total += n
		if n == 0 {
			break
		}
	}
	return total, nil
}

func (s *Sweeper) sweepExpiredSubscriberDuplicatePairBatch(ctx context.Context, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
WITH doomed AS (
    SELECT pair.ctid
      FROM subscriber_duplicate_scan_pairs pair
      JOIN subscriber_duplicate_scans scan
        ON scan.tenant_id = pair.tenant_id AND scan.id = pair.scan_id
     WHERE pair.tenant_id = $1::uuid AND scan.expires_at <= now()
     LIMIT $2
)
DELETE FROM subscriber_duplicate_scan_pairs pair
 WHERE pair.ctid IN (SELECT ctid FROM doomed)`, tenantID, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete expired subscriber duplicate pairs: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit subscriber duplicate pair sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}

func (s *Sweeper) sweepExpiredSubscriberDuplicateScanBatch(ctx context.Context, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_duplicate_scans scan
 WHERE scan.ctid IN (
     SELECT candidate.ctid
       FROM subscriber_duplicate_scans candidate
      WHERE candidate.tenant_id = $1::uuid
        AND candidate.expires_at <= now()
        AND NOT EXISTS (
            SELECT 1
              FROM subscriber_duplicate_scan_pairs pair
             WHERE pair.tenant_id = candidate.tenant_id
               AND pair.scan_id = candidate.id
        )
      LIMIT $2
 )`, tenantID, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("delete expired subscriber duplicate scans: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit subscriber duplicate scan sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
