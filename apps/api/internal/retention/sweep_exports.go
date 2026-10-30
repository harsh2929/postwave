// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_exports.go — deletes tenant_exports rows past their
// expires_at timestamp (the canonical export-retention deadline) AND removes
// the underlying ZIP bundle from object storage when a Sweeper.ExportStore is
// configured. The graceDays argument remains only for compatibility with
// focused callers; the scheduled tenant sweep passes zero.
//
// We only sweep rows in a terminal status (ready | failed | expired)
// so an in-flight 'running' job isn't deleted out from under the
// exports worker. Rows in 'queued' status with old created_at are
// left alone — those are operator-visible failures, not retention
// targets.
//
// Object purge order: storage Delete first, DB row second. If the
// storage Delete fails the DB row is kept so the next sweep retries
// (the orphan-object alternative leaks data and silently violates
// the export retention SLA). Both private and legacy stores treat missing keys
// as success so retries are safe.

package retention

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ExportObjectStore is the slim Delete-only contract sweep_exports
// depends on so the retention package doesn't drag in the wider
// object-storage Put / Open surface.
type ExportObjectStore interface {
	Delete(ctx context.Context, key string) error
}

func (s *Sweeper) sweepExpiredExports(ctx context.Context, tenantID string, graceDays int) (int64, error) {
	if graceDays < 0 {
		graceDays = 0
	}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := s.sweepExpiredExportsBatch(ctx, tenantID, graceDays)
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

func (s *Sweeper) sweepExpiredExportsBatch(ctx context.Context, tenantID string, graceDays int) (int64, error) {
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Select-then-delete per batch so we can purge the object storage
	// blob keyed by tenant_exports.object_key before unlinking the row.
	// FOR UPDATE SKIP LOCKED so concurrent sweepers cannot race over
	// the same row.
	rows, err := tx.Query(ctx, `
SELECT id::text, COALESCE(object_key, ''),
       COALESCE(NULLIF(btrim(download_url), ''), '') <> '' AS legacy_public_store
  FROM tenant_exports
 WHERE tenant_id = $1::uuid
   AND status IN ('ready', 'failed', 'expired')
   AND expires_at IS NOT NULL
   AND expires_at < now() - ($2::int * interval '1 day')
 LIMIT $3
 FOR UPDATE SKIP LOCKED`, tenantID, graceDays, s.batchSize())
	if err != nil {
		return 0, fmt.Errorf("select tenant_exports: %w", err)
	}
	type victim struct {
		id, objectKey string
		legacyStore   bool
	}
	var victims []victim
	for rows.Next() {
		var v victim
		if err := rows.Scan(&v.id, &v.objectKey, &v.legacyStore); err != nil {
			rows.Close()
			return 0, fmt.Errorf("scan tenant_exports: %w", err)
		}
		victims = append(victims, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("rows tenant_exports: %w", err)
	}
	if len(victims) == 0 {
		return 0, tx.Commit(ctx)
	}

	failedObjectDeletes := make(map[string]struct{})
	for _, v := range victims {
		if v.objectKey == "" {
			continue
		}
		store := s.ExportStore
		if v.legacyStore {
			store = s.LegacyExportStore
		}
		if store == nil {
			s.logWarn("export object delete store unavailable", "tenant_id", tenantID,
				"object_key", v.objectKey, "legacy_public_store", v.legacyStore)
			failedObjectDeletes[v.id] = struct{}{}
			continue
		}
		if err := store.Delete(ctx, v.objectKey); err != nil {
			// One bad object aborts THIS row's deletion (we'll retry
			// on the next sweep), but we keep deleting the rest of
			// the batch so a single missing bucket doesn't block
			// retention forever.
			s.logWarn("export object delete failed", "tenant_id", tenantID, "object_key", v.objectKey, "error", err.Error())
			failedObjectDeletes[v.id] = struct{}{}
			continue
		}
	}

	// Delete only rows whose object purge succeeded (or had no object_key). A
	// missing corresponding store keeps the row for a later retry. We build the id list
	// by re-checking which victims to drop.
	ids := make([]string, 0, len(victims))
	for _, v := range victims {
		if v.objectKey == "" {
			ids = append(ids, v.id)
			continue
		}
		if _, failed := failedObjectDeletes[v.id]; failed {
			continue
		}
		// Object delete already succeeded above. A failed delete was recorded
		// and skipped, preserving the durable object key for a later retry.
		ids = append(ids, v.id)
	}
	// Present the retention capability. `tenant_exports` admits a DELETE only
	// from a transaction that sets this — the same GUC the webhook sweep uses —
	// so that a tenant cannot erase the record that an export happened while the
	// scheduled purge still can. Without it this statement raised
	// "permission denied for table tenant_exports" on every sweep.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.retention_worker', 'true', true)`); err != nil {
		return 0, fmt.Errorf("tenant_exports retention scope: %w", err)
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM tenant_exports
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`, tenantID, ids)
	if err != nil {
		return 0, fmt.Errorf("delete tenant_exports: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit tenant_exports sweep: %w", err)
	}
	return tag.RowsAffected(), nil
}
