package warehouse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var ErrDisconnected = errors.New("warehouse: disconnected")

func (r *Repo) ListConnections(ctx context.Context, tenantID, status string) ([]Connection, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, name, provider, direction, status,
       credentials_ref, config, object_selection, cadence, backfill_days,
       last_cursor, error, version, created_at, updated_at
FROM warehouse_connections
WHERE tenant_id = $1::uuid
  AND (($2 = '' AND status <> 'disconnected') OR ($2 <> '' AND status = $2))
ORDER BY updated_at DESC
LIMIT 200`, tenantID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Connection{}
	for rows.Next() {
		item, err := scanConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) CreateConnection(ctx context.Context, tenantID string, in Connection) (*Connection, error) {
	normalizeConnection(&in)
	config, _ := json.Marshal(in.Config)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO warehouse_connections
    (tenant_id, name, provider, direction, status, credentials_ref, config,
     object_selection, cadence, backfill_days)
VALUES
    ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::text[], $9, $10)
RETURNING id::text, tenant_id::text, name, provider, direction, status,
       credentials_ref, config, object_selection, cadence, backfill_days,
       last_cursor, error, version, created_at, updated_at`,
		tenantID, in.Name, in.Provider, in.Direction, in.Status, in.CredentialsRef,
		string(config), in.ObjectSelection, in.Cadence, in.BackfillDays)
	out, err := scanConnection(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetConnection(ctx context.Context, tenantID, id string) (*Connection, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getConnectionTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) SetConnectionStatus(ctx context.Context, tenantID, id, status string, expectedVersion int64) (*Connection, error) {
	status = strings.ToLower(strings.TrimSpace(status))
	if !allowed(status, []string{"draft", "active", "paused", "error"}) {
		return nil, fmt.Errorf("validation: status must be draft, active, paused, or error")
	}
	if expectedVersion < 1 {
		return nil, fmt.Errorf("validation: expected_version must be a positive integer")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE warehouse_connections
   SET status = $3,
       error = CASE WHEN $3 = 'paused' THEN '' ELSE error END,
       version = version + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND version = $4
   AND status <> 'disconnected'
RETURNING id::text, tenant_id::text, name, provider, direction, status,
       credentials_ref, config, object_selection, cadence, backfill_days,
       last_cursor, error, version, created_at, updated_at`, tenantID, strings.TrimSpace(id), status, expectedVersion)
	out, err := scanConnection(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			current, currentVersion, statusErr := connectionStatusVersionTx(ctx, tx, tenantID, id)
			if statusErr != nil {
				if errors.Is(statusErr, pgx.ErrNoRows) {
					return nil, ErrNotFound
				}
				return nil, statusErr
			}
			if current == "disconnected" {
				return nil, ErrDisconnected
			}
			if currentVersion != expectedVersion {
				return nil, ErrStale
			}
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) DeleteConnection(ctx context.Context, tenantID, id string, expectedVersion int64, confirmationName string) (*ConnectionDeleteReceipt, error) {
	if expectedVersion < 1 {
		return nil, fmt.Errorf("validation: expected_version must be a positive integer")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	conn, err := getConnectionTx(ctx, tx, tenantID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if conn.Version != expectedVersion {
		return nil, ErrStale
	}
	if strings.TrimSpace(confirmationName) == "" || strings.TrimSpace(confirmationName) != conn.Name {
		return nil, fmt.Errorf("validation: confirmation_name must exactly match the connection name")
	}
	cleanup, err := json.Marshal(warehouseDisconnectCleanupEvidence(*conn, time.Now().UTC()))
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `
UPDATE warehouse_connections
   SET status = 'disconnected',
       error = '',
       config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('provider_cleanup', $3::jsonb),
       version = version + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND version = $4
   AND status <> 'disconnected'`, tenantID, strings.TrimSpace(id), string(cleanup), expectedVersion)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		current, currentVersion, statusErr := connectionStatusVersionTx(ctx, tx, tenantID, id)
		if errors.Is(statusErr, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if statusErr != nil {
			return nil, statusErr
		}
		if currentVersion != expectedVersion {
			return nil, ErrStale
		}
		if current == "disconnected" {
			return nil, ErrDisconnected
		}
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ConnectionDeleteReceipt{OK: true, ID: conn.ID, PreviousVersion: expectedVersion, Version: expectedVersion + 1, Status: "disconnected"}, nil
}

func (r *Repo) AcknowledgeProviderCleanup(ctx context.Context, tenantID, id string, in ProviderCleanupAcknowledgementInput, acknowledgedAt time.Time) (*Connection, error) {
	if in.ExpectedVersion < 1 {
		return nil, fmt.Errorf("validation: expected_version must be a positive integer")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	current, err := getConnectionTx(ctx, tx, tenantID, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if current.Provider != ProviderSnowflake ||
		strings.ToLower(strings.TrimSpace(current.Status)) != "disconnected" ||
		current.Config == nil ||
		current.Config["provider_cleanup"] == nil {
		return nil, ErrProviderCleanupMissing
	}
	if current.Version != in.ExpectedVersion {
		return nil, ErrStale
	}
	patch := map[string]any{
		"status":                   "operator_acknowledged",
		"acknowledged_at":          acknowledgedAt.UTC().Format(time.RFC3339),
		"managed_provider_cleanup": false,
	}
	if strings.TrimSpace(in.AcknowledgedBy) != "" {
		patch["acknowledged_by"] = strings.TrimSpace(in.AcknowledgedBy)
	}
	if len(in.CompletedActions) > 0 {
		patch["completed_actions"] = append([]string(nil), in.CompletedActions...)
	}
	if strings.TrimSpace(in.Notes) != "" {
		patch["operator_notes"] = strings.TrimSpace(in.Notes)
	}
	payload, err := json.Marshal(patch)
	if err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
UPDATE warehouse_connections
   SET config = jsonb_set(
           COALESCE(config, '{}'::jsonb),
           '{provider_cleanup}',
           (
             CASE
               WHEN jsonb_typeof(config->'provider_cleanup') = 'object'
               THEN config->'provider_cleanup'
               ELSE '{}'::jsonb
             END
           ) || $3::jsonb,
           true
       ),
       version = version + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND provider = 'snowflake'
   AND status = 'disconnected'
   AND version = $4
   AND config ? 'provider_cleanup'
RETURNING id::text, tenant_id::text, name, provider, direction, status,
       credentials_ref, config, object_selection, cadence, backfill_days,
       last_cursor, error, version, created_at, updated_at`, tenantID, strings.TrimSpace(id), string(payload), in.ExpectedVersion)
	out, err := scanConnection(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			_, currentVersion, statusErr := connectionStatusVersionTx(ctx, tx, tenantID, id)
			if statusErr == nil && currentVersion != in.ExpectedVersion {
				return nil, ErrStale
			}
			return nil, ErrProviderCleanupMissing
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func connectionStatusVersionTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (string, int64, error) {
	var status string
	var version int64
	err := tx.QueryRow(ctx, `
SELECT status, version
  FROM warehouse_connections
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, strings.TrimSpace(id)).Scan(&status, &version)
	return strings.ToLower(strings.TrimSpace(status)), version, err
}

func (r *Repo) ListMappings(ctx context.Context, tenantID, connectionID string) ([]ImportMapping, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := listMappingsTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpsertMapping(ctx context.Context, tenantID, connectionID string, in ImportMapping) (*ImportMapping, error) {
	normalizeMapping(&in)
	if in.SourceObject == "" {
		return nil, fmt.Errorf("validation: source_object is required")
	}
	if in.TargetEventName == "" {
		return nil, fmt.Errorf("validation: target_event_name is required")
	}
	if in.ExpectedVersion < 0 {
		return nil, fmt.Errorf("validation: expected_version must be zero for create or a positive integer for update")
	}
	props, _ := json.Marshal(in.PropertyMap)
	rules, _ := json.Marshal(in.ValidationRules)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	conn, err := lockConnectionTx(ctx, tx, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	if err := requireMutableWarehouseConnection(conn); err != nil {
		return nil, err
	}
	var row pgx.Row
	if in.ExpectedVersion == 0 {
		row = tx.QueryRow(ctx, `
INSERT INTO warehouse_import_mappings
    (tenant_id, connection_id, source_object, target_event_name,
     profile_key_column, occurred_at_column, property_map, validation_rules, status)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
ON CONFLICT (tenant_id, connection_id, source_object) DO NOTHING
RETURNING id::text, tenant_id::text, connection_id::text, source_object,
       target_event_name, profile_key_column, occurred_at_column, property_map,
	       validation_rules, status, version, created_at, updated_at`,
			tenantID, connectionID, in.SourceObject, in.TargetEventName,
			in.ProfileKeyColumn, in.OccurredAtColumn, string(props), string(rules), in.Status)
	} else {
		row = tx.QueryRow(ctx, `
UPDATE warehouse_import_mappings
   SET target_event_name = $4,
       profile_key_column = $5,
       occurred_at_column = $6,
       property_map = $7::jsonb,
       validation_rules = $8::jsonb,
       status = $9,
       version = version + 1,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND connection_id = $2::uuid
   AND source_object = $3
   AND version = $10
RETURNING id::text, tenant_id::text, connection_id::text, source_object,
       target_event_name, profile_key_column, occurred_at_column, property_map,
	       validation_rules, status, version, created_at, updated_at`,
			tenantID, connectionID, in.SourceObject, in.TargetEventName,
			in.ProfileKeyColumn, in.OccurredAtColumn, string(props), string(rules), in.Status, in.ExpectedVersion)
	}
	out, err := scanMapping(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			var version int64
			versionErr := tx.QueryRow(ctx, `
SELECT version
  FROM warehouse_import_mappings
 WHERE tenant_id = $1::uuid AND connection_id = $2::uuid AND source_object = $3`,
				tenantID, connectionID, in.SourceObject).Scan(&version)
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
	return out, nil
}

func requireMutableWarehouseConnection(conn *Connection) error {
	if conn == nil {
		return ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(conn.Status), "disconnected") {
		return ErrDisconnected
	}
	return nil
}

func (r *Repo) RunConnection(ctx context.Context, tenantID, connectionID string, in RunInput, storage Storage) (*SyncRun, error) {
	conn, connectionErr := r.GetConnection(ctx, tenantID, connectionID)
	if connectionErr != nil {
		return nil, connectionErr
	}
	if in.ExpectedConnectionVersion < 1 {
		return nil, fmt.Errorf("validation: expected_connection_version must be a positive integer")
	}
	if conn.Version != in.ExpectedConnectionVersion {
		return nil, ErrStale
	}
	normalizeRunInput(&in, *conn)
	if err := validateRunInput(*conn, in, storage); err != nil {
		return nil, err
	}
	dryRun := in.RunMode == "dry_run"

	runTx, connectionErr := db.WithTenant(ctx, r.Pool, tenantID)
	if connectionErr != nil {
		return nil, connectionErr
	}
	defer func() { _ = runTx.Rollback(ctx) }()
	lockedConnection, connectionErr := lockConnectionTx(ctx, runTx, tenantID, connectionID)
	if connectionErr != nil {
		return nil, connectionErr
	}
	if lockedConnection.Version != in.ExpectedConnectionVersion {
		return nil, ErrStale
	}
	if lockedConnection.Status != "active" {
		return nil, fmt.Errorf("validation: warehouse connection must be active before runs can execute")
	}
	run, connectionErr := insertRunTx(ctx, runTx, tenantID, connectionID, in)
	if connectionErr != nil {
		return nil, connectionErr
	}
	started := time.Now().UTC()
	if _, err := runTx.Exec(ctx, `
UPDATE warehouse_sync_runs
   SET status = 'running', started_at = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, run.ID, started); err != nil {
		return nil, err
	}
	// Persist the run before doing export/import work. The work itself remains
	// atomic in a second tenant transaction, while a provider or SQL failure can
	// now be recorded durably instead of rolling the run row back with its work.
	if err := runTx.Commit(ctx); err != nil {
		return nil, err
	}
	tx, connectionErr := db.WithTenant(ctx, r.Pool, tenantID)
	if connectionErr != nil {
		return r.failRun(ctx, nil, tenantID, run.ID, connectionErr)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lockedConnection, connectionErr = lockConnectionTx(ctx, tx, tenantID, connectionID)
	if connectionErr != nil {
		return r.failRun(ctx, tx, tenantID, run.ID, connectionErr)
	}
	if lockedConnection.Version != in.ExpectedConnectionVersion {
		return r.failRun(ctx, tx, tenantID, run.ID, ErrStale)
	}
	if lockedConnection.Status != "active" {
		return r.failRun(ctx, tx, tenantID, run.ID, fmt.Errorf("validation: warehouse connection must be active before runs can execute"))
	}

	switch in.Direction {
	case "export":
		return r.runExport(ctx, tx, tenantID, conn, run, in, storage, dryRun)
	case "import":
		return r.runImport(ctx, tx, tenantID, connectionID, conn, run, in, storage, dryRun)
	default:
		return nil, fmt.Errorf("validation: direction must be export or import")
	}
}

// runExport performs the export half of RunConnection inside the work tx: it
// builds the bundle, stores or plans its delivery per provider, and completes
// (or fails) the already-persisted run row.
func (r *Repo) runExport(ctx context.Context, tx pgx.Tx, tenantID string, conn *Connection, run *SyncRun, in RunInput, storage Storage, dryRun bool) (*SyncRun, error) {
	body, rows, metrics, exportErr := buildExportBundle(ctx, tx, tenantID, in.ObjectSelection, conn.BackfillDays)
	if exportErr != nil {
		return r.failRun(ctx, tx, tenantID, run.ID, exportErr)
	}
	if dryRun {
		metrics["dry_run"] = true
	}
	if run.RetryCount > 0 {
		metrics["retry_count"] = run.RetryCount
		metrics["retry_basis"] = "prior_failed_runs_for_connection_direction"
	}
	if managedSQLWarehouseProvider(conn.Provider) {
		metrics["provider"] = conn.Provider
		metrics["provider_target_uri"] = providerTargetURI(*conn)
		metrics["delivery_state"] = "prepared_manifest"
		metrics["driver_attachment"] = "provider worker consumes this run using credentials_ref"
		metrics["provider_runtime_status"] = "partial"
		metrics["provider_driver_attachment"] = "manifest_worker"
		metrics["manifest_kind"] = "warehouse_export_bundle"
		metrics["bytes_prepared"] = len(body)
		metrics["rows_prepared"] = rows
		var snowflakeEntries []snowflakeExportEntry
		var snowflakeArtifacts []SnowflakeLoadArtifact
		if conn.Provider == ProviderSnowflake {
			snowflakeEntries = snowflakeExportEntries(in.ObjectSelection, snowflakeRowsByObject(metrics))
			metrics["manifest_kind"] = "warehouse_export_bundle_with_snowflake_load_plan"
		}
		switch {
		case dryRun:
			metrics["manifest_storage_state"] = "dry_run_not_stored"
		case storage != nil:
			artifact, err := storeWarehouseRunArtifact(ctx, storage, tenantID, run.ID, body)
			if err != nil {
				return r.failRun(ctx, tx, tenantID, run.ID, err)
			}
			metrics["manifest_storage_state"] = "stored"
			metrics["manifest_object_key"] = artifact.ObjectKey
			metrics["manifest_object_path"] = artifact.Rest
			metrics["manifest_download_url"] = artifact.DownloadURL
			metrics["manifest_download_url_ttl_seconds"] = int((24 * time.Hour).Seconds())
			if conn.Provider == ProviderSnowflake {
				snowflakeArtifacts, err = storeSnowflakeJSONLArtifacts(ctx, storage, tenantID, run.ID, body, snowflakeEntries)
				if err != nil {
					return r.failRun(ctx, tx, tenantID, run.ID, err)
				}
				metrics["snowflake_load_artifacts"] = snowflakeArtifacts
			}
		default:
			metrics["manifest_storage_state"] = "not_configured"
		}
		if conn.Provider == ProviderSnowflake {
			plan := BuildSnowflakeLoadPlan(*conn, run.ID, snowflakeEntries, snowflakeArtifacts)
			metrics["snowflake_load_plan"] = plan
			metrics["snowflake_load_plan_state"] = plan.ExecutionState
			metrics["snowflake_provider_job"] = plan.ProviderJob
			if plan.ProviderJob != nil {
				metrics["snowflake_provider_job_state"] = plan.ProviderJob.LiveState
			}
			if dryRun {
				metrics["snowflake_provider_execution_live_state"] = "not_executed"
				metrics["snowflake_provider_execution_state"] = "skipped"
				metrics["snowflake_provider_execution_reason"] = "dry_run"
			} else {
				executionMetrics, err := executeSnowflakeProviderJob(ctx, storage, r.SnowflakeExecutor, tenantID, *conn, plan.ProviderJob)
				if err != nil {
					return r.failRun(ctx, tx, tenantID, run.ID, err)
				}
				for key, value := range executionMetrics {
					metrics[key] = value
				}
			}
		}
		out, err := completeRunTx(ctx, tx, tenantID, run.ID, runTotals{
			rowsScanned: rows,
			outputURI:   providerTargetURI(*conn),
			metrics:     metrics,
		})
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return out, nil
	}
	if dryRun {
		metrics["manifest_storage_state"] = "dry_run_not_stored"
		out, err := completeRunTx(ctx, tx, tenantID, run.ID, runTotals{
			rowsScanned: rows,
			metrics:     metrics,
		})
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return out, nil
	}
	rest := fmt.Sprintf("warehouse/runs/%s.zip", run.ID)
	key, exportErr := storage.Put(ctx, tenantID, rest, "application/zip", bytes.NewReader(body))
	if exportErr != nil {
		return r.failRun(ctx, tx, tenantID, run.ID, exportErr)
	}
	url, exportErr := storage.PresignGet(ctx, tenantID, rest, 24*time.Hour)
	if exportErr != nil {
		return r.failRun(ctx, tx, tenantID, run.ID, exportErr)
	}
	metrics["object_key"] = key
	out, exportErr := completeRunTx(ctx, tx, tenantID, run.ID, runTotals{
		rowsScanned:  rows,
		rowsExported: rows,
		outputURI:    url,
		metrics:      metrics,
	})
	if exportErr != nil {
		return nil, exportErr
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// runImport performs the import half of RunConnection inside the work tx: it
// unions inline and polled rows, materializes them through the connection's
// mappings, advances the poll cursor, and completes (or fails) the run row.
func (r *Repo) runImport(ctx context.Context, tx pgx.Tx, tenantID, connectionID string, conn *Connection, run *SyncRun, in RunInput, storage Storage, dryRun bool) (*SyncRun, error) {
	mappings, mappingsErr := listMappingsTx(ctx, tx, tenantID, connectionID)
	if mappingsErr != nil {
		return nil, mappingsErr
	}
	rows := in.ImportRows
	objectsRead := []string{}
	advancedCursor := conn.LastCursor
	inputURI := in.InputURI
	parseErrors := []parseError{}
	// Object-storage connections with no inline rows are the poll path:
	// fetch any new JSONL objects under the connection's import prefix,
	// parse them, and treat the union of inline + polled rows as the batch.
	if objectStorageProvider(conn.Provider) && len(rows) == 0 {
		limit := importPollLimit(*conn)
		polled, err := pollImportObjects(ctx, storage, tenantID, *conn, limit)
		if err != nil {
			return r.failRun(ctx, tx, tenantID, run.ID, err)
		}
		rows = append(rows, polled.rows...)
		objectsRead = polled.objectsRead
		advancedCursor = polled.advancedCursor
		parseErrors = polled.parseErrors
		if inputURI == "" && len(objectsRead) > 0 {
			inputURI = fmt.Sprintf("%s://%s -> %s..%s",
				conn.Provider, importPrefixFor(*conn), objectsRead[0], objectsRead[len(objectsRead)-1])
		}
	}
	for _, pe := range parseErrors {
		if dryRun {
			continue
		}
		source := sourceObjectFromKey(pe.key)
		_ = insertRowError(ctx, tx, tenantID, run.ID, source, pe.line,
			"parse_failed", fmt.Sprintf("%s: %v", pe.key, pe.err), ImportRow{
				SourceObject: source,
				Raw:          map[string]any{"_polled_object_key": pe.key},
			})
	}
	var imported, failed int64
	if !dryRun {
		imported, failed, mappingsErr = materializeImportRows(ctx, tx, tenantID, run.ID, rows, mappings)
		if mappingsErr != nil {
			return r.failRun(ctx, tx, tenantID, run.ID, mappingsErr)
		}
	}
	parseFailed := int64(len(parseErrors))
	if shouldAdvanceImportCursor(dryRun, conn.LastCursor, advancedCursor) {
		if _, err := tx.Exec(ctx, `
UPDATE warehouse_connections
   SET last_cursor = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
			tenantID, connectionID, advancedCursor); err != nil {
			return r.failRun(ctx, tx, tenantID, run.ID, err)
		}
	}
	metrics := map[string]any{
		"import_rows":     len(rows),
		"mappings":        len(mappings),
		"objects_polled":  len(objectsRead),
		"parse_errors":    parseFailed,
		"advanced_cursor": advancedCursor,
	}
	if dryRun {
		metrics["dry_run"] = true
		metrics["materialization_state"] = "dry_run_skipped"
		metrics["cursor_update_state"] = "dry_run_not_advanced"
	}
	if run.RetryCount > 0 {
		metrics["retry_count"] = run.RetryCount
		metrics["retry_basis"] = "prior_failed_runs_for_connection_direction"
	}
	if managedSQLWarehouseProvider(conn.Provider) && len(rows) == 0 {
		metrics["provider"] = conn.Provider
		metrics["provider_target_uri"] = providerTargetURI(*conn)
		metrics["loader_state"] = "waiting_for_provider_driver"
		metrics["driver_attachment"] = "provider worker supplies rows or reverse ETL staged rows"
		metrics["provider_runtime_status"] = "partial"
		metrics["provider_driver_attachment"] = "manifest_worker"
		if conn.Provider == ProviderSnowflake {
			plan := BuildSnowflakeImportPlan(*conn, run.ID)
			metrics["loader_state"] = plan.ExecutionState
			metrics["snowflake_import_plan"] = plan
			metrics["snowflake_import_plan_state"] = plan.ExecutionState
			metrics["snowflake_provider_job"] = plan.ProviderJob
			if plan.ProviderJob != nil {
				metrics["snowflake_provider_job_state"] = plan.ProviderJob.LiveState
			}
			if dryRun {
				metrics["snowflake_provider_execution_live_state"] = "not_executed"
				metrics["snowflake_provider_execution_state"] = "skipped"
				metrics["snowflake_provider_execution_reason"] = "dry_run"
			} else {
				executionMetrics, err := executeSnowflakeProviderJob(ctx, storage, r.SnowflakeExecutor, tenantID, *conn, plan.ProviderJob)
				if err != nil {
					return r.failRun(ctx, tx, tenantID, run.ID, err)
				}
				for key, value := range executionMetrics {
					metrics[key] = value
				}
			}
		}
	}
	if len(objectsRead) > 0 {
		metrics["objects"] = objectsRead
	}
	out, mappingsErr := completeRunTx(ctx, tx, tenantID, run.ID, runTotals{
		rowsScanned:  int64(len(rows)) + parseFailed,
		rowsImported: imported,
		rowsFailed:   failed + parseFailed,
		schemaErrors: failed + parseFailed,
		inputURI:     inputURI,
		metrics:      metrics,
	})
	if mappingsErr != nil {
		return nil, mappingsErr
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func shouldAdvanceImportCursor(dryRun bool, current, advanced string) bool {
	return !dryRun && advanced != current && advanced != ""
}

type warehouseRunArtifact struct {
	Rest        string
	ObjectKey   string
	DownloadURL string
}

func storeWarehouseRunArtifact(ctx context.Context, storage Storage, tenantID, runID string, body []byte) (warehouseRunArtifact, error) {
	if storage == nil {
		return warehouseRunArtifact{}, fmt.Errorf("warehouse artifact storage is not configured")
	}
	rest := fmt.Sprintf("warehouse/runs/%s.zip", runID)
	key, err := storage.Put(ctx, tenantID, rest, "application/zip", bytes.NewReader(body))
	if err != nil {
		return warehouseRunArtifact{}, err
	}
	url, err := storage.PresignGet(ctx, tenantID, rest, 24*time.Hour)
	if err != nil {
		return warehouseRunArtifact{}, err
	}
	return warehouseRunArtifact{Rest: rest, ObjectKey: key, DownloadURL: url}, nil
}

func (r *Repo) RunDueConnections(ctx context.Context, tenantID string, now time.Time, limit int, storage Storage) ([]SyncRun, error) {
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	connections, err := r.listDueConnections(ctx, tenantID, now, limit)
	if err != nil {
		return nil, err
	}
	out := make([]SyncRun, 0, len(connections))
	for _, conn := range connections {
		directions := []string{"export"}
		switch conn.Direction {
		case "import":
			directions = []string{"import"}
		case "bidirectional":
			directions = []string{"export", "import"}
		}
		for _, direction := range directions {
			if len(out) >= limit {
				return out, nil
			}
			run, err := r.RunConnection(ctx, tenantID, conn.ID, RunInput{
				Direction:                 direction,
				RunMode:                   "scheduled",
				ExpectedConnectionVersion: conn.Version,
			}, storage)
			if err != nil {
				return nil, err
			}
			out = append(out, *run)
		}
	}
	return out, nil
}

func (r *Repo) ListRuns(ctx context.Context, tenantID, connectionID string, limit int) ([]SyncRun, error) {
	if limit <= 0 {
		limit = 25
	} else if limit > 500 {
		limit = 500
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, COALESCE(connection_id::text, ''), direction,
       run_mode, status, object_selection, input_uri, output_uri, cursor_from,
       cursor_to, rows_scanned, rows_exported, rows_imported, rows_failed,
       schema_errors, retry_count, metrics, error, started_at, completed_at,
       created_at, updated_at
FROM warehouse_sync_runs
WHERE tenant_id = $1::uuid AND ($2 = '' OR connection_id = NULLIF($2, '')::uuid)
ORDER BY created_at DESC
LIMIT $3`, tenantID, strings.TrimSpace(connectionID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SyncRun{}
	for rows.Next() {
		item, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetRun(ctx context.Context, tenantID, id string) (*SyncRun, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getRunTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) ListRunErrors(ctx context.Context, tenantID, runID string) ([]RowError, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, run_id::text, source_object, row_number, error_code,
       error_message, raw_row, created_at
FROM warehouse_row_errors
WHERE tenant_id = $1::uuid AND run_id = $2::uuid
ORDER BY row_number ASC, id ASC
LIMIT 500`, tenantID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RowError{}
	for rows.Next() {
		var item RowError
		var raw []byte
		if err := rows.Scan(&item.ID, &item.RunID, &item.SourceObject,
			&item.RowNumber, &item.ErrorCode, &item.ErrorMessage,
			&raw, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.RawRow = decodeMap(raw)
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) listDueConnections(ctx context.Context, tenantID string, now time.Time, limit int) ([]Connection, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT c.id::text, c.tenant_id::text, c.name, c.provider, c.direction,
       c.status, c.credentials_ref, c.config, c.object_selection, c.cadence,
       c.backfill_days, c.last_cursor, c.error, c.created_at, c.updated_at,
       latest.created_at
FROM warehouse_connections c
LEFT JOIN LATERAL (
    SELECT created_at
    FROM warehouse_sync_runs r
    WHERE r.tenant_id = c.tenant_id
      AND r.connection_id = c.id
    ORDER BY created_at DESC
    LIMIT 1
) latest ON true
WHERE c.tenant_id = $1::uuid
  AND c.status = 'active'
  AND c.provider = ANY($2::text[])
  AND c.direction IN ('export','import','bidirectional')
  AND c.cadence <> 'manual'
  AND NOT EXISTS (
      SELECT 1
      FROM warehouse_sync_runs r
      WHERE r.tenant_id = c.tenant_id
        AND r.connection_id = c.id
        AND r.status IN ('queued','running')
)
ORDER BY c.updated_at ASC
LIMIT 200`, tenantID, []string{ProviderS3, ProviderR2, ProviderBigQuery, ProviderSnowflake, ProviderRedshift, ProviderPostgres})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Connection{}
	for rows.Next() {
		var conn Connection
		var raw []byte
		var lastRun *time.Time
		if err := rows.Scan(&conn.ID, &conn.TenantID, &conn.Name, &conn.Provider,
			&conn.Direction, &conn.Status, &conn.CredentialsRef, &raw,
			&conn.ObjectSelection, &conn.Cadence, &conn.BackfillDays,
			&conn.LastCursor, &conn.Error, &conn.CreatedAt, &conn.UpdatedAt,
			&lastRun); err != nil {
			return nil, err
		}
		conn.Config = decodeMap(raw)
		if cadenceDue(conn.Cadence, lastRun, now) {
			out = append(out, conn)
			if len(out) >= limit {
				break
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func cadenceDue(cadence string, lastRun *time.Time, now time.Time) bool {
	var every time.Duration
	switch strings.ToLower(strings.TrimSpace(cadence)) {
	case "hourly":
		every = time.Hour
	case "daily":
		every = 24 * time.Hour
	case "weekly":
		every = 7 * 24 * time.Hour
	default:
		return false
	}
	if lastRun == nil {
		return true
	}
	return !lastRun.Add(every).After(now)
}

func validateRunInput(conn Connection, in RunInput, storage Storage) error {
	if conn.Status != "active" {
		return fmt.Errorf("validation: warehouse connection must be active before runs can execute")
	}
	spec, ok := ProviderSpecByKey(conn.Provider)
	if !ok {
		return fmt.Errorf("validation: unsupported warehouse provider %q", conn.Provider)
	}
	if spec.RuntimeStatus == "planned" {
		return fmt.Errorf("validation: %s is planned and cannot execute warehouse runs", conn.Provider)
	}
	if raw := rawCredentialConfigKey(conn.Config); raw != "" {
		return fmt.Errorf("validation: raw credential config is not accepted: %s", raw)
	}
	if conn.CredentialsRef != "" && looksLikeRawCredentialRef(conn.CredentialsRef) {
		return fmt.Errorf("validation: credentials_ref looks like raw credential material")
	}
	if key := disallowedEndpointOverrideKey(conn); key != "" {
		return fmt.Errorf("validation: %s is not accepted in public warehouse config", key)
	}
	if err := providerAddressConfigError(conn); err != "" {
		return fmt.Errorf("validation: %s", err)
	}
	if missing := missingRequiredSettings(conn); len(missing) > 0 {
		return fmt.Errorf("validation: missing required provider settings: %s", strings.Join(missing, ", "))
	}
	if !allowed(in.Direction, []string{"export", "import"}) {
		return fmt.Errorf("validation: direction must be export or import")
	}
	if !allowed(in.RunMode, []string{"manual", "scheduled", "backfill", "retry", "dry_run"}) {
		return fmt.Errorf("validation: unsupported run_mode")
	}
	for _, object := range in.ObjectSelection {
		if !supportedObject(object) {
			return fmt.Errorf("validation: unsupported object %q", object)
		}
	}
	if conn.Direction == "export" && in.Direction == "import" {
		return fmt.Errorf("validation: connection is export-only")
	}
	if conn.Direction == "import" && in.Direction == "export" {
		return fmt.Errorf("validation: connection is import-only")
	}
	if in.Direction == "export" {
		if !objectStorageProvider(conn.Provider) && !managedSQLWarehouseProvider(conn.Provider) {
			return fmt.Errorf("validation: executable export currently supports s3/r2 or managed SQL warehouse providers; %s is planned", conn.Provider)
		}
		if objectStorageProvider(conn.Provider) && storage == nil {
			return fmt.Errorf("validation: object storage is not configured")
		}
	}
	if in.Direction == "import" && len(in.ImportRows) == 0 {
		// S3-direction-import connections poll their bucket prefix; the
		// caller does not need to inline import_rows. Managed SQL providers
		// can also record a zero-row manifest while their driver supplies rows.
		if !objectStorageProvider(conn.Provider) && !managedSQLWarehouseProvider(conn.Provider) {
			return fmt.Errorf("validation: import_rows are required for %s import execution", conn.Provider)
		}
		if objectStorageProvider(conn.Provider) && storage == nil {
			return fmt.Errorf("validation: object storage is not configured")
		}
	}
	return nil
}

func getConnectionTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Connection, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, provider, direction, status,
       credentials_ref, config, object_selection, cadence, backfill_days,
       last_cursor, error, version, created_at, updated_at
FROM warehouse_connections
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, strings.TrimSpace(id))
	out, err := scanConnection(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func lockConnectionTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Connection, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, name, provider, direction, status,
       credentials_ref, config, object_selection, cadence, backfill_days,
       last_cursor, error, version, created_at, updated_at
FROM warehouse_connections
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1
FOR SHARE`, tenantID, strings.TrimSpace(id))
	out, err := scanConnection(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func listMappingsTx(ctx context.Context, tx pgx.Tx, tenantID, connectionID string) ([]ImportMapping, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, connection_id::text, source_object,
       target_event_name, profile_key_column, occurred_at_column, property_map,
       validation_rules, status, version, created_at, updated_at
FROM warehouse_import_mappings
WHERE tenant_id = $1::uuid AND connection_id = $2::uuid
ORDER BY source_object`, tenantID, connectionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ImportMapping{}
	for rows.Next() {
		item, err := scanMapping(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *item)
	}
	return out, rows.Err()
}

func insertRunTx(ctx context.Context, tx pgx.Tx, tenantID, connectionID string, in RunInput) (*SyncRun, error) {
	retryCount := 0
	if in.RunMode == "retry" {
		count, err := countPriorFailedRunsTx(ctx, tx, tenantID, connectionID, in.Direction)
		if err != nil {
			return nil, err
		}
		retryCount = count
	}
	row := tx.QueryRow(ctx, `
INSERT INTO warehouse_sync_runs
    (tenant_id, connection_id, direction, run_mode, status, object_selection, input_uri, retry_count)
VALUES
    ($1::uuid, $2::uuid, $3, $4, 'queued', $5::text[], $6, $7)
RETURNING id::text, tenant_id::text, COALESCE(connection_id::text, ''), direction,
       run_mode, status, object_selection, input_uri, output_uri, cursor_from,
       cursor_to, rows_scanned, rows_exported, rows_imported, rows_failed,
       schema_errors, retry_count, metrics, error, started_at, completed_at,
       created_at, updated_at`,
		tenantID, connectionID, in.Direction, in.RunMode, in.ObjectSelection, in.InputURI, retryCount)
	return scanRun(row)
}

func countPriorFailedRunsTx(ctx context.Context, tx pgx.Tx, tenantID, connectionID, direction string) (int, error) {
	var count int
	err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM warehouse_sync_runs
 WHERE tenant_id = $1::uuid
   AND connection_id = $2::uuid
   AND direction = $3
   AND status = 'failed'`, tenantID, strings.TrimSpace(connectionID), direction).Scan(&count)
	return count, err
}

type runTotals struct {
	rowsScanned  int64
	rowsExported int64
	rowsImported int64
	rowsFailed   int64
	schemaErrors int64
	inputURI     string
	outputURI    string
	metrics      map[string]any
}

func completeRunTx(ctx context.Context, tx pgx.Tx, tenantID, runID string, totals runTotals) (*SyncRun, error) {
	metrics, _ := json.Marshal(totals.metrics)
	if totals.metrics == nil {
		metrics = []byte("{}")
	}
	if _, err := tx.Exec(ctx, `
UPDATE warehouse_sync_runs
   SET status = 'completed',
       input_uri = COALESCE(NULLIF($3, ''), input_uri),
       output_uri = COALESCE(NULLIF($4, ''), output_uri),
       rows_scanned = $5,
       rows_exported = $6,
       rows_imported = $7,
       rows_failed = $8,
       schema_errors = $9,
       metrics = $10::jsonb,
       completed_at = now(),
       error = ''
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, runID, totals.inputURI, totals.outputURI, totals.rowsScanned,
		totals.rowsExported, totals.rowsImported, totals.rowsFailed,
		totals.schemaErrors, string(metrics)); err != nil {
		return nil, err
	}
	return getRunTx(ctx, tx, tenantID, runID)
}

func (r *Repo) failRun(ctx context.Context, workTx pgx.Tx, tenantID, runID string, cause error) (*SyncRun, error) {
	// A SQL error aborts the work transaction, so failure state must be written
	// in a fresh transaction. WithoutCancel gives that bounded bookkeeping a
	// chance to complete even when the request or provider deadline fired.
	persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if workTx != nil {
		_ = workTx.Rollback(persistCtx)
	}
	tx, txErr := db.WithTenant(persistCtx, r.Pool, tenantID)
	if txErr != nil {
		return nil, errors.Join(cause, fmt.Errorf("persist warehouse run failure: %w", txErr))
	}
	defer func() { _ = tx.Rollback(persistCtx) }()
	if _, err := tx.Exec(persistCtx, `
UPDATE warehouse_sync_runs
   SET status = 'failed', error = $3, completed_at = now()
	 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, runID, cause.Error()); err != nil {
		return nil, errors.Join(cause, fmt.Errorf("persist warehouse run failure: %w", err))
	}
	out, txErr := getRunTx(persistCtx, tx, tenantID, runID)
	if txErr != nil {
		return nil, errors.Join(cause, fmt.Errorf("read persisted warehouse run failure: %w", txErr))
	}
	if err := tx.Commit(persistCtx); err != nil {
		return nil, errors.Join(cause, fmt.Errorf("commit warehouse run failure: %w", err))
	}
	return out, cause
}

func getRunTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*SyncRun, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, COALESCE(connection_id::text, ''), direction,
       run_mode, status, object_selection, input_uri, output_uri, cursor_from,
       cursor_to, rows_scanned, rows_exported, rows_imported, rows_failed,
       schema_errors, retry_count, metrics, error, started_at, completed_at,
       created_at, updated_at
FROM warehouse_sync_runs
WHERE tenant_id = $1::uuid AND id = $2::uuid
LIMIT 1`, tenantID, id)
	out, err := scanRun(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func scanConnection(row pgx.Row) (*Connection, error) {
	var out Connection
	var raw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Provider,
		&out.Direction, &out.Status, &out.CredentialsRef, &raw,
		&out.ObjectSelection, &out.Cadence, &out.BackfillDays,
		&out.LastCursor, &out.Error, &out.Version, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Config = decodeMap(raw)
	return &out, nil
}

func scanMapping(row pgx.Row) (*ImportMapping, error) {
	var out ImportMapping
	var props, rules []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ConnectionID,
		&out.SourceObject, &out.TargetEventName, &out.ProfileKeyColumn,
		&out.OccurredAtColumn, &props, &rules, &out.Status,
		&out.Version, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	out.PropertyMap = decodeMap(props)
	out.ValidationRules = decodeMap(rules)
	return &out, nil
}

func scanRun(row pgx.Row) (*SyncRun, error) {
	var out SyncRun
	var raw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.ConnectionID,
		&out.Direction, &out.RunMode, &out.Status, &out.ObjectSelection,
		&out.InputURI, &out.OutputURI, &out.CursorFrom, &out.CursorTo,
		&out.RowsScanned, &out.RowsExported, &out.RowsImported,
		&out.RowsFailed, &out.SchemaErrors, &out.RetryCount, &raw,
		&out.Error, &out.StartedAt, &out.CompletedAt, &out.CreatedAt,
		&out.UpdatedAt); err != nil {
		return nil, err
	}
	out.Metrics = decodeMap(raw)
	return &out, nil
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return out
}
