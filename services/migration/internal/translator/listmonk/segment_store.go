package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/postwave/migrate/canonical"
)

// PersistSegment stores a translated saved segment in Moosewave's segments
// table and records the destination id for rollback.
func PersistSegment(ctx context.Context, db *sql.DB, tenantID, jobID string, seg canonical.Segment, sourcePlatform canonical.SourcePlatform) (id string, err error) {
	sourceID, err := migrationSegmentSourceIdentity(seg, sourcePlatform)
	if err != nil {
		return "", err
	}
	compiledSQL, compiledArgs, err := CompileSegment(seg.QueryAST)
	if err != nil {
		return "", fmt.Errorf("compile segment query %q: %w", seg.Name, err)
	}
	queryAST, err := json.Marshal(seg.QueryAST)
	if err != nil {
		return "", fmt.Errorf("marshal segment query %q: %w", seg.Name, err)
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return "", err
	}
	defer commitTx(tx, &err)
	if err := validateCompiledSegmentSQLTx(ctx, tx, seg.Name, compiledSQL, compiledArgs); err != nil {
		return "", err
	}
	name := migrationScopedSourceName(seg.Name, jobID, sourceID)
	ownershipFingerprint := migrationResourceOwnershipFingerprint(tenantID, jobID, ResourceSegment, sourcePlatform, sourceID)
	existingID, exists, err := findOwnedMigrationDestinationTx(
		ctx, tx, tenantID, jobID, ResourceSegment, sourcePlatform, sourceID,
		DestinationPostwaveSegment, ownershipFingerprint,
	)
	if err != nil {
		return "", err
	}

	if exists {
		if err := tx.QueryRowContext(ctx, `
			UPDATE segments
			   SET name = $3,
			       description = $4,
			       query_ast = $5::jsonb,
			       updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND id = $2::uuid
			RETURNING id::text
		`, tenantID, existingID, name, seg.Description, string(queryAST)).Scan(&id); err != nil {
			if err == sql.ErrNoRows {
				return "", fmt.Errorf("tracked segment source %q points to missing destination %q", sourceID, existingID)
			}
			return "", fmt.Errorf("update tracked segment %q: %w", seg.Name, err)
		}
	} else if err := tx.QueryRowContext(ctx, `
		INSERT INTO segments (tenant_id, name, description, query_ast)
		VALUES ($1::uuid, $2, $3, $4::jsonb)
		RETURNING id::text
	`, tenantID, name, seg.Description, string(queryAST)).Scan(&id); err != nil {
		return "", fmt.Errorf("persist segment %q at deterministic name %q: refusing to adopt or overwrite a pre-existing row: %w", seg.Name, name, err)
	}
	if err := recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceSegment,
		SourcePlatform:  sourcePlatform,
		SourceID:        sourceID,
		DestinationType: DestinationPostwaveSegment,
		DestinationID:   id,
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"name":                  name,
			"source_name":           seg.Name,
			"source_definition":     seg.SourceDefinition,
			"ownership_fingerprint": ownershipFingerprint,
		},
	}); err != nil {
		return "", err
	}
	return id, nil
}

func validateCompiledSegmentSQLTx(ctx context.Context, tx *sql.Tx, name, fragment string, args []interface{}) error {
	rows, err := tx.QueryContext(ctx, `EXPLAIN (FORMAT JSON) SELECT subscribers.id FROM subscribers WHERE `+fragment, args...)
	if err != nil {
		return fmt.Errorf("validate segment query %q against destination schema: %w", name, err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return fmt.Errorf("validate segment query %q against destination schema: %w", name, err)
		}
		return fmt.Errorf("validate segment query %q against destination schema: EXPLAIN returned no plan", name)
	}
	var plan json.RawMessage
	if err := rows.Scan(&plan); err != nil {
		return fmt.Errorf("read segment query plan %q: %w", name, err)
	}
	if len(plan) == 0 {
		return fmt.Errorf("validate segment query %q against destination schema: EXPLAIN returned an empty plan", name)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close segment query validation %q: %w", name, err)
	}
	return nil
}
