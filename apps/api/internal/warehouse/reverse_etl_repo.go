// SPDX-License-Identifier: AGPL-3.0-only
//
// reverse_etl_repo.go — database CRUD + executor for SUB-112 reverse ETL.
package warehouse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ListReverseETLMappings returns a connection's mappings.
func (r *Repo) ListReverseETLMappings(ctx context.Context, tenantID, connectionID string) ([]ReverseETLMapping, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getConnectionTx(ctx, tx, tenantID, connectionID); err != nil {
		return nil, err
	}
	out, err := listReverseETLMappingsTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func listReverseETLMappingsTx(ctx context.Context, tx pgx.Tx, tenantID, connectionID string) ([]ReverseETLMapping, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, connection_id::text, source_table,
       profile_key_column, profile_key_target, source_column, target_field_key,
       cast_type, status, version, last_synced_at, last_row_count, created_at, updated_at
  FROM warehouse_reverse_etl_mappings
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid
 ORDER BY source_table, source_column`, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReverseETLMapping{}
	for rows.Next() {
		var m ReverseETLMapping
		if err := rows.Scan(&m.ID, &m.TenantID, &m.ConnectionID, &m.SourceTable,
			&m.ProfileKeyColumn, &m.ProfileKeyTarget, &m.SourceColumn, &m.TargetFieldKey,
			&m.CastType, &m.Status, &m.Version, &m.LastSyncedAt, &m.LastRowCount,
			&m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func requireActiveReverseETLConnection(conn *Connection) error {
	if conn == nil {
		return ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(conn.Status), "disconnected") {
		return ErrDisconnected
	}
	if !strings.EqualFold(strings.TrimSpace(conn.Status), "active") {
		return fmt.Errorf("validation: warehouse connection must be active before reverse ETL can mutate mappings or traits")
	}
	return nil
}

// UpsertReverseETLMapping creates or updates a mapping (keyed on
// connection + source_table + source_column).
func (r *Repo) UpsertReverseETLMapping(ctx context.Context, tenantID, connectionID string, in ReverseETLMapping) (*ReverseETLMapping, error) {
	if err := normalizeReverseETLMapping(&in); err != nil {
		return nil, err
	}
	if in.ExpectedVersion < 0 {
		return nil, fmt.Errorf("validation: expected_version must be zero for create or a positive integer for update")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	conn, err := lockConnectionTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	if err := requireActiveReverseETLConnection(conn); err != nil {
		return nil, err
	}
	var row pgx.Row
	if in.ExpectedVersion == 0 {
		row = tx.QueryRow(ctx, `
INSERT INTO warehouse_reverse_etl_mappings
    (tenant_id, connection_id, source_table, profile_key_column, profile_key_target,
     source_column, target_field_key, cast_type, status)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tenant_id, connection_id, source_table, source_column) DO NOTHING
RETURNING id::text, tenant_id::text, connection_id::text, source_table,
       profile_key_column, profile_key_target, source_column, target_field_key,
	       cast_type, status, version, last_synced_at, last_row_count, created_at, updated_at`,
			tenantID, connectionID, in.SourceTable, in.ProfileKeyColumn, in.ProfileKeyTarget,
			in.SourceColumn, in.TargetFieldKey, in.CastType, in.Status)
	} else {
		row = tx.QueryRow(ctx, `
UPDATE warehouse_reverse_etl_mappings
   SET profile_key_column = $4,
       profile_key_target = $5,
       target_field_key = $7,
       cast_type = $8,
       status = $9,
       version = version + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND connection_id = $2::uuid
   AND source_table = $3
   AND source_column = $6
   AND version = $10
RETURNING id::text, tenant_id::text, connection_id::text, source_table,
       profile_key_column, profile_key_target, source_column, target_field_key,
	       cast_type, status, version, last_synced_at, last_row_count, created_at, updated_at`,
			tenantID, connectionID, in.SourceTable, in.ProfileKeyColumn, in.ProfileKeyTarget,
			in.SourceColumn, in.TargetFieldKey, in.CastType, in.Status, in.ExpectedVersion)
	}
	var m ReverseETLMapping
	err = row.Scan(
		&m.ID, &m.TenantID, &m.ConnectionID, &m.SourceTable,
		&m.ProfileKeyColumn, &m.ProfileKeyTarget, &m.SourceColumn, &m.TargetFieldKey,
		&m.CastType, &m.Status, &m.Version, &m.LastSyncedAt, &m.LastRowCount,
		&m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var version int64
			versionErr := tx.QueryRow(ctx, `
SELECT version
  FROM warehouse_reverse_etl_mappings
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid
   AND source_table = $3 AND source_column = $4`,
				tenantID, connectionID, in.SourceTable, in.SourceColumn).Scan(&version)
			if errors.Is(versionErr, pgx.ErrNoRows) {
				if in.ExpectedVersion == 0 {
					return nil, ErrStale
				}
				return nil, ErrNotFound
			}
			if versionErr != nil {
				return nil, versionErr
			}
			return nil, ErrStale
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// DeleteReverseETLMapping removes a mapping.
func (r *Repo) DeleteReverseETLMapping(ctx context.Context, tenantID, connectionID, mappingID string, expectedVersion int64, confirmationTarget string) error {
	if expectedVersion < 1 {
		return fmt.Errorf("validation: expected_version must be a positive integer")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	conn, err := lockConnectionTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return err
	}
	if err := requireActiveReverseETLConnection(conn); err != nil {
		return err
	}
	var currentVersion int64
	var currentTarget string
	err = tx.QueryRow(ctx, `
SELECT version, target_field_key
  FROM warehouse_reverse_etl_mappings
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid AND id = $3::uuid
 FOR UPDATE`, tenantID, connectionID, mappingID).Scan(&currentVersion, &currentTarget)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if currentVersion != expectedVersion {
		return ErrStale
	}
	if strings.TrimSpace(confirmationTarget) == "" || strings.TrimSpace(confirmationTarget) != currentTarget {
		return fmt.Errorf("validation: confirmation_target must exactly match target_field_key")
	}
	tag, err := tx.Exec(ctx, `
DELETE FROM warehouse_reverse_etl_mappings
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid AND id = $3::uuid
   AND version = $4`, tenantID, connectionID, mappingID, expectedVersion)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// SyncReverseETL applies the connection's active mappings to the staged
// rows: for each subscriber matched by profile_key_column, writes the
// mapped+cast values into subscribers.custom_fields. v1 reads inline rows
// (see reverse_etl.go header); a credentialed warehouse driver attaches
// at fetchReverseETLRows later.
func (r *Repo) SyncReverseETL(ctx context.Context, tenantID, connectionID string, in ReverseETLSyncInput) (*ReverseETLSyncResult, error) {
	if len(in.Rows) > reverseETLMaxRows {
		return nil, fmt.Errorf("validation: at most %d rows per sync", reverseETLMaxRows)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	conn, err := lockConnectionTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	if err := requireActiveReverseETLConnection(conn); err != nil {
		return nil, err
	}
	if in.ExpectedConnectionVersion < 1 {
		return nil, fmt.Errorf("validation: expected_connection_version must be a positive integer")
	}
	if conn.Version != in.ExpectedConnectionVersion {
		return nil, ErrStale
	}
	mappings, err := listReverseETLMappingsTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	// Restrict to active mappings, optionally filtered to the requested
	// source_table.
	active := mappings[:0]
	table := strings.TrimSpace(in.SourceTable)
	for _, m := range mappings {
		if m.Status != "active" {
			continue
		}
		if table != "" && m.SourceTable != table {
			continue
		}
		active = append(active, m)
	}
	if len(active) == 0 {
		return nil, fmt.Errorf("validation: no active mappings for this connection")
	}

	result := &ReverseETLSyncResult{
		ConnectionID:    connectionID,
		MappingsApplied: len(active),
		RowsScanned:     len(in.Rows),
	}

	// Group mappings by profile_key_column so one row resolves a subscriber
	// once and fans out to every field it feeds.
	matched := map[string]bool{}
	for _, row := range in.Rows {
		// All active mappings share the email-target profile key; resolve
		// the email from the first mapping's profile_key_column that the row
		// provides.
		email := ""
		for _, m := range active {
			if v, ok := row[m.ProfileKeyColumn]; ok {
				email = strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", v)))
				if email != "" {
					break
				}
			}
		}
		if email == "" {
			continue
		}
		patch := map[string]any{}
		for _, m := range active {
			raw, ok := row[m.SourceColumn]
			if !ok {
				continue
			}
			patch[m.TargetFieldKey] = castValue(m.CastType, raw)
		}
		if len(patch) == 0 {
			continue
		}
		written, err := writeSubscriberTraits(ctx, tx, tenantID, email, patch)
		if err != nil {
			return nil, err
		}
		if written > 0 {
			matched[email] = true
			result.FieldsWritten += written
		}
	}
	result.SubscribersFound = len(matched)

	// Stamp last_synced_at + last_row_count on the applied mappings.
	for _, m := range active {
		if _, err := tx.Exec(ctx, `
UPDATE warehouse_reverse_etl_mappings
   SET last_synced_at = now(), last_row_count = $3,
       version = version + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, m.ID, int64(result.RowsScanned)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// writeSubscriberTraits merges patch into one subscriber's custom_fields
// (matched by email). Returns the number of fields written (0 when no
// subscriber matched). Uses jsonb || to merge so unrelated keys survive.
func writeSubscriberTraits(ctx context.Context, tx pgx.Tx, tenantID, email string, patch map[string]any) (int, error) {
	patchJSON, err := json.Marshal(patch)
	if err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `
UPDATE subscribers
   SET custom_fields = custom_fields || $3::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND email = $2`,
		tenantID, email, string(patchJSON))
	if err != nil {
		return 0, err
	}
	if tag.RowsAffected() == 0 {
		return 0, nil
	}
	return len(patch), nil
}
