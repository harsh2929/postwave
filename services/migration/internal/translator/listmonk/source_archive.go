package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/postwave/migrate/canonical"
)

func PersistSourceArchiveItem(ctx context.Context, db *sql.DB, tenantID, jobID string, item canonical.SourceArchiveItem) (id string, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return "", err
	}
	defer commitTx(tx, &err)

	payload := item.Payload
	if payload == nil {
		payload = map[string]interface{}{}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal source archive payload: %w", err)
	}
	row := tx.QueryRowContext(ctx, `
		INSERT INTO migration_source_archive_items (
			tenant_id, migration_job_id, source_platform, resource_type, source_id,
			name, status, linked_contact_id, occurred_at, payload
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
		)
		ON CONFLICT (tenant_id, migration_job_id, resource_type, source_id)
		DO UPDATE SET
			name = EXCLUDED.name,
			status = EXCLUDED.status,
			linked_contact_id = EXCLUDED.linked_contact_id,
			occurred_at = EXCLUDED.occurred_at,
			payload = EXCLUDED.payload,
			updated_at = now()
		RETURNING id::text`,
		tenantID, jobID, string(item.SourcePlatform), item.ResourceType, item.SourceID,
		item.Name, item.Status, item.LinkedContactID, item.OccurredAt, string(raw))
	if err := row.Scan(&id); err != nil {
		return "", fmt.Errorf("persist source archive item: %w", err)
	}
	if err := recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceSourceArchive,
		SourcePlatform:  item.SourcePlatform,
		SourceID:        item.SourceID,
		DestinationType: DestinationPostwaveSourceArchive,
		DestinationID:   id,
		DestinationMetadata: map[string]interface{}{
			"operation":     "created",
			"resource_type": item.ResourceType,
			"name":          item.Name,
		},
	}); err != nil {
		return "", err
	}
	if err := materializeSourceArchiveItemTx(ctx, tx, tenantID, jobID, item); err != nil {
		return "", err
	}
	return id, nil
}
