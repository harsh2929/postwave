// SPDX-License-Identifier: AGPL-3.0-only

package pushsuppressions

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
	"github.com/postwave/postwave/apps/api/internal/pushtoken"
)

// Store is the tenant-RLS data layer over the independent authority facts.
type Store struct{ Pool *db.Pool }

func (s *Store) List(ctx context.Context, tenantID string, filter ListFilter, audit db.AuditMeta) (ListResult, error) {
	// READ COMMITTED is intentional: tenant setup and an advisory-lock wait may
	// precede the list query. The first query after that wait must see any
	// authority transaction that won the lock and committed before this logical
	// snapshot boundary.
	tx, err := db.WithTenantOptions(ctx, s.Pool, tenantID, pgx.TxOptions{IsoLevel: pgx.ReadCommitted, AccessMode: pgx.ReadWrite})
	if err != nil {
		return ListResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pushauthoritylock.Shared(ctx, tx, tenantID); err != nil {
		return ListResult{}, err
	}

	var (
		databaseNow     time.Time
		currentRevision int64
	)
	if err := tx.QueryRow(ctx, `
SELECT clock_timestamp(), revision
  FROM push_suppression_registry_state
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&databaseNow, &currentRevision); err != nil {
		return ListResult{}, err
	}
	databaseNow = databaseNow.UTC()
	if filter.SnapshotAt.IsZero() {
		filter.SnapshotAt = databaseNow
		filter.SnapshotRevision = currentRevision
	} else if filter.SnapshotRevision > currentRevision {
		return ListResult{}, errInvalidCursor
	}

	countWhere, countArgs := authorityWhere(tenantID, filter, false)
	var total int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM push_suppression_authorities WHERE `+countWhere, countArgs...).Scan(&total); err != nil {
		return ListResult{}, err
	}

	pageWhere, pageArgs := authorityWhere(tenantID, filter, true)
	limitPlaceholder := fmt.Sprintf("$%d", len(pageArgs)+1)
	pageArgs = append(pageArgs, filter.Limit+1)
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text,
       left(encode(device_token_hash, 'hex'), `+fmt.Sprint(fingerprintHexLength)+`),
       platform, reason, source, created_at,
       CASE WHEN registry_hidden_revision > $2 THEN registry_active_updated_at ELSE updated_at END,
       CASE WHEN registry_hidden_revision > $2 THEN registry_active_version ELSE version END,
       authority
  FROM push_suppression_authorities
 WHERE `+pageWhere+`
 ORDER BY created_at DESC, id DESC
 LIMIT `+limitPlaceholder, pageArgs...)
	if err != nil {
		return ListResult{}, err
	}
	defer rows.Close()

	items := make([]Row, 0, filter.Limit+1)
	for rows.Next() {
		row, err := scanAuthorityRow(rows)
		if err != nil {
			return ListResult{}, err
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return ListResult{}, err
	}
	hasMore := len(items) > filter.Limit
	if hasMore {
		items = items[:filter.Limit]
	}
	if err := db.Audit(ctx, tx, audit, "push_suppression.list", "push_suppression_registry", "", map[string]any{
		"page_size": len(items), "has_platform_filter": filter.Platform != "",
		"has_reason_filter": filter.Reason != "", "has_hash_prefix_filter": filter.HashPrefix != "",
		"cursor_page": !filter.AfterAt.IsZero(),
	}); err != nil {
		return ListResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ListResult{}, err
	}
	return ListResult{
		Items: items, Total: total, SnapshotAt: filter.SnapshotAt,
		SnapshotRevision: filter.SnapshotRevision, HasMore: hasMore,
	}, nil
}

func authorityWhere(tenantID string, filter ListFilter, includeAfter bool) (string, []any) {
	args := []any{tenantID, filter.SnapshotRevision}
	parts := []string{
		"tenant_id = $1::uuid",
		"registry_visible_revision <= $2",
		"(registry_hidden_revision IS NULL OR registry_hidden_revision > $2)",
	}
	appendEq := func(column string, value any) {
		args = append(args, value)
		parts = append(parts, fmt.Sprintf("%s = $%d", column, len(args)))
	}
	if filter.Platform != "" {
		appendEq("platform", filter.Platform)
	}
	if filter.Reason != "" {
		appendEq("reason", filter.Reason)
	}
	if filter.HashPrefix != "" {
		args = append(args, filter.HashPrefix)
		parts = append(parts, fmt.Sprintf("encode(device_token_hash, 'hex') LIKE $%d || '%%'", len(args)))
	}
	if includeAfter && !filter.AfterAt.IsZero() {
		args = append(args, filter.AfterAt, filter.AfterID)
		parts = append(parts, fmt.Sprintf("(created_at, id) < ($%d, $%d::uuid)", len(args)-1, len(args)))
	}
	return strings.Join(parts, " AND "), args
}

type rowScanner interface{ Scan(...any) error }

func scanAuthorityRow(scanner rowScanner) (Row, error) {
	var (
		row            Row
		internalSource string
	)
	if err := scanner.Scan(
		&row.ID, &row.TenantID, &row.DeviceTokenHash, &row.Platform,
		&row.Reason, &internalSource, &row.CreatedAt, &row.UpdatedAt,
		&row.Version, &row.authority,
	); err != nil {
		return Row{}, err
	}
	row.CreatedAt = row.CreatedAt.UTC()
	row.UpdatedAt = row.UpdatedAt.UTC()
	row.Source = publicSource(row.authority)
	row.Reversible = row.authority == "manual" && internalSource == "dashboard"
	if !row.Reversible {
		row.LockedReason = lockedReason(row.authority)
	}
	return row, nil
}

func (s *Store) AddManual(ctx context.Context, tenantID string, in ManualAdd, audit db.AuditMeta) (AddResult, error) {
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return AddResult{}, err
	}
	if err := validateManualAddStoreInput(in); err != nil {
		return AddResult{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return AddResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return AddResult{}, err
	}
	result, err := addManualTx(ctx, tx, tenantID, in)
	if err != nil {
		return AddResult{}, err
	}
	if err := db.Audit(ctx, tx, audit, "push_suppression.manual_add", "push_suppression_authority", result.Row.ID, map[string]any{
		"platform": in.Platform, "created": result.Created,
	}); err != nil {
		return AddResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AddResult{}, err
	}
	return result, nil
}

func (s *Store) BulkAddManual(ctx context.Context, tenantID string, items []ManualAdd, audit db.AuditMeta) (BulkImportResult, error) {
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return BulkImportResult{}, err
	}
	for i := range items {
		if err := validateManualAddStoreInput(items[i]); err != nil {
			return BulkImportResult{}, fmt.Errorf("push suppressions: invalid item %d: %w", i, err)
		}
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return BulkImportResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return BulkImportResult{}, err
	}

	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool {
		left := items[order[i]].Platform + "\x00" + items[order[i]].DeviceToken
		right := items[order[j]].Platform + "\x00" + items[order[j]].DeviceToken
		return left < right
	})
	result := BulkImportResult{Rows: make([]Row, len(items))}
	for _, index := range order {
		added, err := addManualTx(ctx, tx, tenantID, items[index])
		if err != nil {
			return BulkImportResult{}, err
		}
		result.Rows[index] = added.Row
		if added.Created {
			result.Created++
		} else {
			result.Existing++
		}
	}
	if err := db.Audit(ctx, tx, audit, "push_suppression.bulk_manual_add", "push_suppression_registry", "", map[string]any{
		"requested": len(items), "created": result.Created, "existing": result.Existing,
	}); err != nil {
		return BulkImportResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BulkImportResult{}, err
	}
	return result, nil
}

func validateManualAddStoreInput(in ManualAdd) error {
	if !validPlatforms[in.Platform] {
		return errors.New("push suppressions: invalid platform")
	}
	if err := pushtoken.ValidateExact(in.DeviceToken); err != nil {
		return fmt.Errorf("push suppressions: invalid exact token: %w", err)
	}
	return nil
}

func addManualTx(ctx context.Context, tx pgx.Tx, tenantID string, in ManualAdd) (AddResult, error) {
	digest := sha256.Sum256([]byte(in.DeviceToken))
	var (
		result         AddResult
		internalSource string
	)
	row := tx.QueryRow(ctx, `
WITH inserted AS (
  INSERT INTO push_suppression_authorities
      (tenant_id, device_token_hash, platform, authority, reason, source)
  VALUES ($1::uuid, $2, $3, 'manual', 'manual', 'dashboard')
  ON CONFLICT (tenant_id, platform, device_token_hash, authority, reason, source)
      WHERE revoked_at IS NULL
  DO NOTHING
  RETURNING id, tenant_id, device_token_hash, platform, reason, source,
            created_at, updated_at, version, authority
)
SELECT id::text, tenant_id::text,
       left(encode(device_token_hash, 'hex'), `+fmt.Sprint(fingerprintHexLength)+`),
       platform, reason, source, created_at, updated_at, version, authority, true
  FROM inserted
UNION ALL
SELECT id::text, tenant_id::text,
       left(encode(device_token_hash, 'hex'), `+fmt.Sprint(fingerprintHexLength)+`),
       platform, reason, source, created_at, updated_at, version, authority, false
  FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND device_token_hash = $2 AND platform = $3
   AND authority = 'manual' AND reason = 'manual' AND source = 'dashboard'
   AND revoked_at IS NULL
LIMIT 1`, tenantID, digest[:], in.Platform)
	if err := row.Scan(
		&result.Row.ID, &result.Row.TenantID, &result.Row.DeviceTokenHash,
		&result.Row.Platform, &result.Row.Reason, &internalSource,
		&result.Row.CreatedAt, &result.Row.UpdatedAt, &result.Row.Version,
		&result.Row.authority, &result.Created,
	); err != nil {
		return AddResult{}, err
	}
	result.Row.CreatedAt = result.Row.CreatedAt.UTC()
	result.Row.UpdatedAt = result.Row.UpdatedAt.UTC()
	result.Row.Source = publicSource(result.Row.authority)
	result.Row.Reversible = true

	// Keep the released one-row table as a compatibility projection. A stronger
	// projection is never overwritten; the authority fact above remains active
	// independently either way.
	if _, err := tx.Exec(ctx, `
INSERT INTO push_token_suppressions
    (tenant_id, device_token_hash, platform, reason, source)
VALUES ($1::uuid, $2, $3, 'manual', 'dashboard')
ON CONFLICT (tenant_id, platform, device_token_hash) DO NOTHING`, tenantID, digest[:], in.Platform); err != nil {
		return AddResult{}, err
	}
	return result, nil
}

func (s *Store) RemoveManual(ctx context.Context, tenantID string, in RemoveRequest, audit db.AuditMeta) (RemoveReceipt, error) {
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return RemoveReceipt{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return RemoveReceipt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return RemoveReceipt{}, err
	}
	receipt, err := removeManualTx(ctx, tx, tenantID, in)
	if err != nil {
		return RemoveReceipt{}, err
	}
	if err := db.Audit(ctx, tx, audit, "push_suppression.manual_remove", "push_suppression_authority", in.ID, map[string]any{
		"still_suppressed": receipt.StillSuppressed,
	}); err != nil {
		return RemoveReceipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RemoveReceipt{}, err
	}
	return receipt, nil
}

func (s *Store) BulkRemoveManual(ctx context.Context, tenantID string, items []RemoveRequest, audit db.AuditMeta) (BulkRemoveResult, error) {
	if err := pushauthoritylock.EnsureMutationAllowed(ctx); err != nil {
		return BulkRemoveResult{}, err
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return BulkRemoveResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := pushauthoritylock.Exclusive(ctx, tx, tenantID); err != nil {
		return BulkRemoveResult{}, err
	}

	order := make([]int, len(items))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool { return items[order[i]].ID < items[order[j]].ID })
	result := BulkRemoveResult{Receipts: make([]RemoveReceipt, len(items))}
	for _, index := range order {
		receipt, err := removeManualTx(ctx, tx, tenantID, items[index])
		if err != nil {
			return BulkRemoveResult{}, err
		}
		result.Receipts[index] = receipt
		result.Removed++
		if receipt.StillSuppressed {
			result.StillSuppressed++
		}
	}
	if err := db.Audit(ctx, tx, audit, "push_suppression.bulk_manual_remove", "push_suppression_registry", "", map[string]any{
		"requested": len(items), "removed": result.Removed,
		"still_suppressed": result.StillSuppressed,
	}); err != nil {
		return BulkRemoveResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return BulkRemoveResult{}, err
	}
	return result, nil
}

func removeManualTx(ctx context.Context, tx pgx.Tx, tenantID string, in RemoveRequest) (RemoveReceipt, error) {
	var (
		digest    []byte
		platform  string
		authority string
		source    string
		version   int64
		revokedAt *time.Time
	)
	err := tx.QueryRow(ctx, `
SELECT device_token_hash, platform, authority, source, version, revoked_at
  FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, in.ID).Scan(&digest, &platform, &authority, &source, &version, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RemoveReceipt{}, ErrNotFound
	}
	if err != nil {
		return RemoveReceipt{}, err
	}
	if authority != "manual" || source != "dashboard" {
		return RemoveReceipt{}, &LockedError{Reason: lockedReason(authority)}
	}
	if in.ExpectedVersion != version {
		return RemoveReceipt{}, ErrStale
	}
	if revokedAt != nil {
		return RemoveReceipt{}, ErrNotFound
	}
	var nextVersion int64
	if err := tx.QueryRow(ctx, `
UPDATE push_suppression_authorities
   SET revoked_at = clock_timestamp(), version = version + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND version = $3 AND revoked_at IS NULL
 RETURNING version`, tenantID, in.ID, in.ExpectedVersion).Scan(&nextVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return RemoveReceipt{}, ErrStale
		}
		return RemoveReceipt{}, err
	}
	var remaining int64
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND platform = $2 AND device_token_hash = $3
   AND revoked_at IS NULL`, tenantID, platform, digest).Scan(&remaining); err != nil {
		return RemoveReceipt{}, err
	}
	if remaining == 0 {
		if _, err := tx.Exec(ctx, `
DELETE FROM push_token_suppressions
 WHERE tenant_id = $1::uuid AND platform = $2 AND device_token_hash = $3
   AND source = 'dashboard' AND reason = 'manual'`, tenantID, platform, digest); err != nil {
			return RemoveReceipt{}, err
		}
	}
	return RemoveReceipt{
		OK: true, TenantID: tenantID, ID: in.ID, Version: nextVersion,
		StillSuppressed: remaining > 0,
	}, nil
}
