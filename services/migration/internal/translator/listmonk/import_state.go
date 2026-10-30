package listmonk

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/postwave/migrate/canonical"
)

const (
	ResourceSubscriber          = "subscriber"
	ResourceList                = "list"
	ResourceSegment             = "segment"
	ResourceAutomation          = "automation"
	ResourceCampaignArchive     = "campaign_archive"
	ResourceCampaign            = "campaign"
	ResourceCampaignEvent       = "campaign_report_event"
	ResourceTemplate            = "template"
	ResourcePaidSubscription    = "paid_subscription"
	ResourceSourceArchive       = "source_archive"
	ResourceAutomationJourney   = "automation_journey"
	ResourcePopupForm           = "popup_form"
	ResourceLandingPage         = "landing_page"
	ResourceCommerceIntegration = "commerce_integration"

	DestinationListmonkSubscriber          = "listmonk_subscriber"
	DestinationListmonkList                = "listmonk_list"
	DestinationListmonkTemplate            = "listmonk_template"
	DestinationPostwaveSegment             = "postwave_segment"
	DestinationPostwaveAutomation          = "postwave_automation"
	DestinationPostwaveJourney             = "postwave_automation_journey"
	DestinationPostwaveCampaign            = "postwave_campaign_archive"
	DestinationPostwaveCampaignRow         = "postwave_campaign"
	DestinationPostwaveCampaignEvent       = "postwave_campaign_report_event"
	DestinationPostwavePaidSub             = "postwave_paid_subscription"
	DestinationPostwaveSourceArchive       = "postwave_source_archive"
	DestinationPostwavePopupForm           = "postwave_popup_form"
	DestinationPostwaveLandingPage         = "postwave_landing_page"
	DestinationPostwaveCommerceIntegration = "postwave_commerce_integration"

	destinationAfterSHA256MetadataKey   = "destination_after_sha256"
	destinationAfterTimezoneMetadataKey = "destination_after_timezone"
)

// ImportedResource is the durable link between a migration job and one
// destination-side resource created by that job.
type ImportedResource struct {
	ID                  string
	TenantID            string
	JobID               string
	ResourceType        string
	SourcePlatform      canonical.SourcePlatform
	SourceID            string
	DestinationType     string
	DestinationID       string
	DestinationMetadata map[string]interface{}
}

func beginTenantTx(ctx context.Context, db *sql.DB, tenantID string) (*sql.Tx, error) {
	if db == nil {
		return nil, fmt.Errorf("listmonk persistence: db is nil")
	}
	if tenantID == "" {
		return nil, fmt.Errorf("listmonk persistence: tenant id required")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func commitTx(tx *sql.Tx, err *error) {
	if *err != nil {
		_ = tx.Rollback()
		return
	}
	*err = tx.Commit()
}

// RecordImportedResource upserts one resource-tracking row.
func RecordImportedResource(ctx context.Context, db *sql.DB, res ImportedResource) (err error) {
	tx, err := beginTenantTx(ctx, db, res.TenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	return recordImportedResourceTx(ctx, tx, res)
}

func recordImportedResourceTx(ctx context.Context, tx *sql.Tx, res ImportedResource) error {
	if res.TenantID == "" || res.JobID == "" {
		return fmt.Errorf("migration import resource: tenant id and job id required")
	}
	if res.ResourceType == "" || res.DestinationType == "" || res.DestinationID == "" {
		return fmt.Errorf("migration import resource: resource type, destination type, and destination id required")
	}
	meta := res.DestinationMetadata
	if meta == nil {
		meta = map[string]interface{}{}
	}
	if operation, _ := meta["operation"].(string); operation == "created" {
		if query, ok := trackedPostgresDestinationSnapshotQuery(res); ok {
			fingerprint, err := trackedPostgresDestinationFingerprintTx(ctx, tx, res, query)
			if err != nil {
				return fmt.Errorf("capture %s destination after-image %s: %w", res.ResourceType, res.DestinationID, err)
			}
			meta[destinationAfterSHA256MetadataKey] = fingerprint
			if res.ResourceType == ResourceCampaignEvent {
				var snapshotTimezone string
				if err := tx.QueryRowContext(ctx,
					`SELECT current_setting('TimeZone')`).Scan(&snapshotTimezone); err != nil {
					return fmt.Errorf("capture campaign report destination timezone: %w", err)
				}
				if snapshotTimezone == "" || len(snapshotTimezone) > 128 {
					return fmt.Errorf("capture campaign report destination timezone: invalid value")
				}
				meta[destinationAfterTimezoneMetadataKey] = snapshotTimezone
			}
		}
	}
	metaRaw, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("marshal import resource metadata: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO migration_imported_resources
			(tenant_id, job_id, resource_type, source_platform, source_id, destination_type, destination_id, destination_metadata)
		VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), $6, $7, $8::jsonb)
		ON CONFLICT (tenant_id, job_id, resource_type, destination_type, destination_id)
		DO UPDATE SET
			source_id = EXCLUDED.source_id,
			source_platform = EXCLUDED.source_platform,
			destination_metadata = EXCLUDED.destination_metadata,
			rolled_back_at = NULL
	`, res.TenantID, res.JobID, res.ResourceType, string(res.SourcePlatform), res.SourceID,
		res.DestinationType, res.DestinationID, string(metaRaw))
	if err != nil {
		return fmt.Errorf("record import resource %s/%s: %w", res.ResourceType, res.DestinationID, err)
	}
	return nil
}

func trackedPostgresDestinationSnapshotQuery(res ImportedResource) (string, bool) {
	var table, idCast string
	lockClause := " FOR UPDATE"
	switch res.ResourceType {
	case ResourceSegment:
		table, idCast = "segments", "uuid"
	case ResourceAutomation:
		table, idCast = "automations", "uuid"
	case ResourceCampaignArchive:
		table, idCast = "campaign_archive", "uuid"
	case ResourceCampaign:
		table, idCast = "campaigns", "uuid"
	case ResourceCampaignEvent:
		table, idCast = "campaign_report_events", "bigint"
		// Migration 1964 moves the lock and after-image comparison into the
		// purpose-scoped SECURITY DEFINER rollback authority. Requiring a lock
		// here would require granting postwave_app UPDATE on report evidence.
		lockClause = ""
	case ResourcePaidSubscription:
		table, idCast = "migration_paid_subscriptions", "uuid"
	case ResourceSourceArchive:
		table, idCast = "migration_source_archive_items", "uuid"
	case ResourceAutomationJourney:
		table, idCast = "automation_journeys", "uuid"
	case ResourcePopupForm:
		table, idCast = "popup_forms", "uuid"
	case ResourceLandingPage:
		table, idCast = "landing_pages", "uuid"
	case ResourceCommerceIntegration:
		table, idCast = "commerce_integrations", "uuid"
	default:
		return "", false
	}
	// table and cast are selected exclusively from the closed switch above;
	// destination identifiers remain bind parameters.
	// FOR UPDATE makes validation and subsequent DELETE one atomic conflict
	// check for every ordinary destination. Campaign report events are the one
	// exception: their governed rollback function performs both under its own
	// lock, while this query is used only to capture the initial after-image.
	return fmt.Sprintf(`SELECT to_jsonb(destination_row)::text FROM %s AS destination_row WHERE tenant_id = $1::uuid AND id = $2::%s%s`, table, idCast, lockClause), true
}

func trackedPostgresDestinationFingerprintTx(ctx context.Context, tx *sql.Tx, res ImportedResource, query string) (string, error) {
	var snapshot string
	if err := tx.QueryRowContext(ctx, query, res.TenantID, res.DestinationID).Scan(&snapshot); err != nil {
		if err == sql.ErrNoRows {
			return "", fmt.Errorf("destination row is missing")
		}
		return "", err
	}
	digest := sha256.Sum256([]byte(snapshot))
	return hex.EncodeToString(digest[:]), nil
}

func validateTrackedPostgresDestinationTx(ctx context.Context, tx *sql.Tx, res ImportedResource) error {
	// Campaign-report rows are append-only once they are linked to canonical
	// evidence. Their purpose-scoped SECURITY DEFINER rollback function locks
	// the exact row and re-proves this same destination-after fingerprint before
	// tombstoning it. Running the generic SELECT ... FOR UPDATE first would
	// require granting postwave_app UPDATE on the report table, bypassing that
	// boundary. Keep every other tracked resource on the generic validator.
	if res.ResourceType == ResourceCampaignEvent {
		expected, _ := res.DestinationMetadata[destinationAfterSHA256MetadataKey].(string)
		if expected == "" {
			return fmt.Errorf("%w: %s rollback ledger %s lacks a destination after-image", ErrRollbackConflict, res.ResourceType, res.ID)
		}
		return nil
	}
	query, tracked := trackedPostgresDestinationSnapshotQuery(res)
	if !tracked {
		return nil
	}
	expected, _ := res.DestinationMetadata[destinationAfterSHA256MetadataKey].(string)
	if expected == "" {
		return fmt.Errorf("%w: %s rollback ledger %s lacks a destination after-image", ErrRollbackConflict, res.ResourceType, res.ID)
	}
	actual, err := trackedPostgresDestinationFingerprintTx(ctx, tx, res, query)
	if err != nil {
		return fmt.Errorf("%w: %s destination %s: %v", ErrRollbackConflict, res.ResourceType, res.DestinationID, err)
	}
	if actual != expected {
		return fmt.Errorf("%w: %s destination %s changed after import", ErrRollbackConflict, res.ResourceType, res.DestinationID)
	}
	return nil
}

// ListImportedResources returns active tracked resources for one job.
func ListImportedResources(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType string) (out []ImportedResource, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)
	return listImportedResourcesTx(ctx, tx, tenantID, jobID, resourceType)
}

// CountImportedResources returns a bounded rollback total without decoding
// every rich destination snapshot into process memory.
func CountImportedResources(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType string) (count int, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return 0, err
	}
	defer commitTx(tx, &err)
	err = tx.QueryRowContext(ctx, `
		SELECT count(*)
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		   AND resource_type = $3 AND rolled_back_at IS NULL
	`, tenantID, jobID, resourceType).Scan(&count)
	return count, err
}

// CountImportedResourceLedgerRows counts active and already-rolled-back rows.
// Rollback recovery uses it to distinguish "the ledger never existed" from a
// crash after every destination row was successfully reconciled but before
// the migration job status was durably finalized.
func CountImportedResourceLedgerRows(ctx context.Context, db *sql.DB, tenantID, jobID string) (count int, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return 0, err
	}
	defer commitTx(tx, &err)
	err = tx.QueryRowContext(ctx, `
		SELECT count(*)
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
	`, tenantID, jobID).Scan(&count)
	return count, err
}

// ListImportedResourcesPage keyset-pages active ledgers by UUID. Rollback
// uses this for a read-only conflict pass before mutations and never holds
// more than limit rich snapshots in memory.
func ListImportedResourcesPage(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType, afterID string, limit int) (out []ImportedResource, err error) {
	if limit <= 0 || limit > 1000 {
		limit = 250
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)
	rows, err := tx.QueryContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, source_platform,
		       COALESCE(source_id, ''), destination_type, destination_id, destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3
		   AND rolled_back_at IS NULL
		   AND ($4 = '' OR id > $4::uuid)
		 ORDER BY id ASC
		 LIMIT $5
	`, tenantID, jobID, resourceType, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	return scanImportedResources(rows)
}

// ValidateTrackedPostgresResourcesUnchanged performs a bounded, read-only
// pass across every job-owned Postgres destination before rollback mutates
// anything. Delete batches repeat the same check in their transaction to
// narrow the race between this whole-ledger preflight and deletion.
func ValidateTrackedPostgresResourcesUnchanged(ctx context.Context, db *sql.DB, tenantID, jobID string, resourceTypes []string) error {
	for _, resourceType := range resourceTypes {
		afterID := ""
		for {
			resources, err := ListImportedResourcesPage(ctx, db, tenantID, jobID, resourceType, afterID, 250)
			if err != nil {
				return err
			}
			if len(resources) == 0 {
				break
			}
			tx, err := beginTenantTx(ctx, db, tenantID)
			if err != nil {
				return err
			}
			validationErr := func() error {
				for _, res := range resources {
					if err := validateTrackedPostgresDestinationTx(ctx, tx, res); err != nil {
						return err
					}
				}
				return nil
			}()
			if validationErr != nil {
				_ = tx.Rollback()
				return validationErr
			}
			if err := tx.Commit(); err != nil {
				return err
			}
			afterID = resources[len(resources)-1].ID
		}
	}
	return nil
}

// FindImportedResourceBySource returns an active same-job resource for a
// stable source identity. It is the retry/idempotency lookup used before
// creating non-upsertable destination resources such as Listmonk templates
// and lists.
func FindImportedResourceBySource(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType string, sourcePlatform canonical.SourcePlatform, sourceID string) (out *ImportedResource, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)
	var res ImportedResource
	var platform string
	var metaRaw []byte
	err = tx.QueryRowContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, source_platform,
		       COALESCE(source_id, ''), destination_type, destination_id, destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid
		   AND job_id = $2::uuid
		   AND resource_type = $3
		   AND source_platform = $4
		   AND source_id = $5
		   AND rolled_back_at IS NULL
		 ORDER BY created_at ASC, id ASC
		 LIMIT 1
	`, tenantID, jobID, resourceType, string(sourcePlatform), sourceID).Scan(
		&res.ID, &res.TenantID, &res.JobID, &res.ResourceType, &platform,
		&res.SourceID, &res.DestinationType, &res.DestinationID, &metaRaw,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	res.SourcePlatform = canonical.SourcePlatform(platform)
	if len(metaRaw) > 0 {
		if err := json.Unmarshal(metaRaw, &res.DestinationMetadata); err != nil {
			return nil, fmt.Errorf("decode imported resource metadata: %w", err)
		}
	}
	if res.DestinationMetadata == nil {
		res.DestinationMetadata = map[string]interface{}{}
	}
	return &res, nil
}

// FindImportedResourceByDestination returns the active same-job ledger row
// for a destination identity. Subscriber conflict recovery uses it to
// distinguish a previously tracked same-job update from an orphan created by
// a POST that succeeded immediately before worker death.
func FindImportedResourceByDestination(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType, destinationType, destinationID string) (out *ImportedResource, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)
	var res ImportedResource
	var platform string
	var metaRaw []byte
	err = tx.QueryRowContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, source_platform,
		       COALESCE(source_id, ''), destination_type, destination_id, destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3
		   AND destination_type = $4 AND destination_id = $5 AND rolled_back_at IS NULL
		 LIMIT 1
	`, tenantID, jobID, resourceType, destinationType, destinationID).Scan(
		&res.ID, &res.TenantID, &res.JobID, &res.ResourceType, &platform,
		&res.SourceID, &res.DestinationType, &res.DestinationID, &metaRaw,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	res.SourcePlatform = canonical.SourcePlatform(platform)
	if len(metaRaw) > 0 {
		if err := json.Unmarshal(metaRaw, &res.DestinationMetadata); err != nil {
			return nil, err
		}
	}
	if res.DestinationMetadata == nil {
		res.DestinationMetadata = map[string]interface{}{}
	}
	return &res, nil
}

func listImportedResourcesTx(ctx context.Context, tx *sql.Tx, tenantID, jobID, resourceType string) ([]ImportedResource, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, source_platform,
		       COALESCE(source_id, ''), destination_type, destination_id, destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid
		   AND job_id = $2::uuid
		   AND resource_type = $3
		   AND rolled_back_at IS NULL
		 ORDER BY created_at ASC, id ASC
	`, tenantID, jobID, resourceType)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	return scanImportedResources(rows)
}

type importedResourceRows interface {
	Next() bool
	Scan(dest ...interface{}) error
	Err() error
}

func scanImportedResources(rows importedResourceRows) ([]ImportedResource, error) {
	out := []ImportedResource{}
	for rows.Next() {
		var res ImportedResource
		var platform string
		var metaRaw []byte
		if err := rows.Scan(&res.ID, &res.TenantID, &res.JobID, &res.ResourceType, &platform,
			&res.SourceID, &res.DestinationType, &res.DestinationID, &metaRaw); err != nil {
			return nil, err
		}
		res.SourcePlatform = canonical.SourcePlatform(platform)
		if len(metaRaw) > 0 {
			_ = json.Unmarshal(metaRaw, &res.DestinationMetadata)
		}
		if res.DestinationMetadata == nil {
			res.DestinationMetadata = map[string]interface{}{}
		}
		out = append(out, res)
	}
	return out, rows.Err()
}

// MarkImportedResourceRolledBack marks one tracked resource as already undone.
func MarkImportedResourceRolledBack(ctx context.Context, db *sql.DB, tenantID, resourceID string) (err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	return markImportedResourceRolledBackTx(ctx, tx, resourceID)
}

func markImportedResourceRolledBackTx(ctx context.Context, tx *sql.Tx, resourceID string) error {
	if resourceID == "" {
		return nil
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE migration_imported_resources
		   SET rolled_back_at = now()
		 WHERE id = $1::uuid
	`, resourceID)
	return err
}

// DeleteTrackedPostgresResources deletes Moosewave-owned resources that were
// recorded for a migration job and marks their tracking rows rolled back.
func DeleteTrackedPostgresResources(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType string) (deleted []ImportedResource, err error) {
	return DeleteTrackedPostgresResourcesBatch(ctx, db, tenantID, jobID, resourceType, 1000)
}

// DeleteTrackedPostgresResourceBySource removes one exact migration-owned
// destination identified by its stable source identity. It performs the same
// after-image conflict check as rollback, so an operator-edited destination is
// never silently removed during exact-snapshot reconciliation.
func DeleteTrackedPostgresResourceBySource(
	ctx context.Context,
	db *sql.DB,
	tenantID, jobID, resourceType string,
	sourcePlatform canonical.SourcePlatform,
	sourceID string,
) (deleted *ImportedResource, err error) {
	if jobID == "" || resourceType == "" || sourcePlatform == "" || sourceID == "" {
		return nil, fmt.Errorf("delete tracked resource by source: job, resource type, source platform, and source id are required")
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)

	rows, err := tx.QueryContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, source_platform,
		       COALESCE(source_id, ''), destination_type, destination_id, destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid
		   AND job_id = $2::uuid
		   AND resource_type = $3
		   AND source_platform = $4
		   AND source_id = $5
		   AND rolled_back_at IS NULL
		 ORDER BY created_at ASC, id ASC
		 LIMIT 2
		 FOR UPDATE
	`, tenantID, jobID, resourceType, string(sourcePlatform), sourceID)
	if err != nil {
		return nil, err
	}
	resources, scanErr := scanImportedResources(rows)
	_ = rows.Close()
	if scanErr != nil {
		return nil, scanErr
	}
	if len(resources) == 0 {
		return nil, nil
	}
	if len(resources) > 1 {
		return nil, fmt.Errorf("delete tracked %s source %q: multiple active destinations are ambiguous", resourceType, sourceID)
	}
	res := resources[0]
	if err := validateTrackedPostgresDestinationTx(ctx, tx, res); err != nil {
		return nil, err
	}
	if err := deleteTrackedDestinationTx(ctx, tx, tenantID, res); err != nil {
		return nil, err
	}
	if err := markImportedResourceRolledBackTx(ctx, tx, res.ID); err != nil {
		return nil, err
	}
	return &res, nil
}

// DeleteTrackedPostgresResourcesBatch deletes at most limit resources in one
// tenant transaction. Callers repeat until an empty result, bounding locks,
// memory, and retry scope for large migrations.
func DeleteTrackedPostgresResourcesBatch(ctx context.Context, db *sql.DB, tenantID, jobID, resourceType string, limit int) (deleted []ImportedResource, err error) {
	if limit <= 0 || limit > 1000 {
		limit = 250
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)

	rows, err := tx.QueryContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, source_platform,
		       COALESCE(source_id, ''), destination_type, destination_id, destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3
		   AND rolled_back_at IS NULL
		 ORDER BY id ASC
		 LIMIT $4
		 FOR UPDATE
	`, tenantID, jobID, resourceType, limit)
	if err != nil {
		return nil, err
	}
	resources, err := scanImportedResources(rows)
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	for _, res := range resources {
		if err := validateTrackedPostgresDestinationTx(ctx, tx, res); err != nil {
			return deleted, err
		}
		if err := deleteTrackedDestinationTx(ctx, tx, tenantID, res); err != nil {
			return deleted, err
		}
		if err := markImportedResourceRolledBackTx(ctx, tx, res.ID); err != nil {
			return deleted, err
		}
		deleted = append(deleted, res)
	}
	return deleted, nil
}

func deleteTrackedDestinationTx(ctx context.Context, tx *sql.Tx, tenantID string, res ImportedResource) error {
	operation, _ := res.DestinationMetadata["operation"].(string)
	if operation != "created" {
		return fmt.Errorf("tracked %s resource %s lacks safe create marker; refusing destructive rollback", res.ResourceType, res.DestinationID)
	}
	switch res.ResourceType {
	case ResourceSegment:
		_, err := tx.ExecContext(ctx, `DELETE FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceAutomation:
		_, err := tx.ExecContext(ctx, `DELETE FROM automations WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceAutomationJourney:
		_, err := tx.ExecContext(ctx, `DELETE FROM automation_journeys WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourcePopupForm:
		_, err := tx.ExecContext(ctx, `DELETE FROM popup_forms WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceLandingPage:
		_, err := tx.ExecContext(ctx, `DELETE FROM landing_pages WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceCommerceIntegration:
		_, err := tx.ExecContext(ctx, `DELETE FROM commerce_integrations WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceCampaign:
		_, err := tx.ExecContext(ctx, `DELETE FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceCampaignEvent:
		// Migration 1964 preserves the historical report-only import rollback
		// while governing any future canonicalized import through an immutable
		// tombstone receipt. The database proves this exact active imported-
		// resource ledger owns the destination; linked canonical rows additionally
		// require their preallocated job/resource ownership metadata to match.
		var outcome string
		return tx.QueryRowContext(ctx, `
SELECT campaign_report_projection_rollback_delete(
    $1::uuid, $2::bigint, $3::uuid, gen_random_uuid()
)`, tenantID, res.DestinationID, res.ID).Scan(&outcome)
	case ResourceCampaignArchive:
		_, err := tx.ExecContext(ctx, `DELETE FROM campaign_archive WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourcePaidSubscription:
		_, err := tx.ExecContext(ctx, `DELETE FROM migration_paid_subscriptions WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceSourceArchive:
		_, err := tx.ExecContext(ctx, `DELETE FROM migration_source_archive_items WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, res.DestinationID)
		return err
	case ResourceList:
		listUUID, _ := res.DestinationMetadata["postwave_list_id"].(string)
		if listUUID == "" {
			return fmt.Errorf("tracked list %s missing postwave_list_id", res.DestinationID)
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM list_id_map WHERE tenant_id = $1::uuid AND postwave_uuid = $2::uuid`, tenantID, listUUID)
		return err
	default:
		return fmt.Errorf("unsupported tracked resource type %q", res.ResourceType)
	}
}

func subscriberResource(jobID string, sub canonical.Subscriber, destID int, outcome UpsertOutcome, before, after *SubscriberResponse) ImportedResource {
	metadata := map[string]interface{}{
		"email":              sub.Email,
		"listmonk_operation": string(outcome),
	}
	if before != nil {
		metadata["listmonk_before"] = before
	}
	if after != nil {
		metadata["listmonk_after"] = after
	}
	return ImportedResource{
		JobID:               jobID,
		ResourceType:        ResourceSubscriber,
		SourcePlatform:      sub.SourcePlatform,
		SourceID:            sub.SourceID,
		DestinationType:     DestinationListmonkSubscriber,
		DestinationID:       strconv.Itoa(destID),
		DestinationMetadata: metadata,
	}
}

func paidSubSourceID(ps canonical.PaidSub) string {
	if ps.StripeSubscriptionID != "" {
		return ps.StripeSubscriptionID
	}
	if ps.StripeCustomerID != "" {
		return ps.StripeCustomerID
	}
	return ps.Email
}

func nullableTime(t time.Time) interface{} {
	if t.IsZero() {
		return nil
	}
	return t
}

func migrationScopedName(name, jobID string) string {
	if jobID == "" {
		return name
	}
	short := jobID
	if len(short) > 8 {
		short = short[:8]
	}
	return fmt.Sprintf("%s (migration %s)", name, short)
}

func migrationScopedSourceName(name, jobID, sourceID string) string {
	base := migrationScopedName(name, jobID)
	digest := sha256.Sum256([]byte(sourceID))
	return fmt.Sprintf("%s [source %s]", base, hex.EncodeToString(digest[:4]))
}

func migrationOwnershipFingerprint(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = hash.Write([]byte(strconv.Itoa(len(part))))
		_, _ = hash.Write([]byte{':'})
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func detachedMigrationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	// External mutation may have completed immediately before the request was
	// cancelled. Cleanup must not inherit that cancelled signal, but remains
	// tightly bounded so a stuck destination cannot pin a worker forever.
	return context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
}
