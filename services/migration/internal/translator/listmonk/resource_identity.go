package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/postwave/migrate/canonical"
)

// migrationSourceIdentity is the durable source-side identity used by the
// imported-resource ledger. Display names are deliberately never identities:
// providers allow duplicate names and users can rename resources between
// retries.
func migrationSegmentSourceIdentity(seg canonical.Segment, source canonical.SourcePlatform) (string, error) {
	definition, canonicalDefinition, err := parseSourceDefinition(seg.SourceDefinition)
	if err != nil {
		return "", fmt.Errorf("segment %q has invalid source definition: %w", seg.Name, err)
	}
	if source == canonical.SourceMailchimp {
		segmentID := sourceDefinitionScalar(definition, "id")
		listID := sourceDefinitionScalar(definition, "list_id")
		if segmentID == "" || listID == "" {
			return "", fmt.Errorf("Mailchimp segment %q source definition must contain both id and list_id", seg.Name)
		}
		return "list:" + listID + "/segment:" + segmentID, nil
	}
	if sourceID := firstNonEmptyLocal(
		sourceDefinitionScalar(definition, "source_id"),
		sourceDefinitionScalar(definition, "id"),
	); sourceID != "" {
		if listID := sourceDefinitionScalar(definition, "list_id"); listID != "" {
			return "list:" + listID + "/segment:" + sourceID, nil
		}
		return sourceID, nil
	}
	if canonicalDefinition != "" {
		return "definition:" + migrationOwnershipFingerprint(canonicalDefinition)[:16], nil
	}
	// Some older adapters model a provider list/tag as a segment without
	// retaining its source payload. Keep those migrations compatible, while
	// Mailchimp remains strict because its definition always carries exact IDs.
	if name := strings.TrimSpace(seg.Name); name != "" {
		return "legacy-name:" + name, nil
	}
	return "", fmt.Errorf("segment source identity is required")
}

// SegmentSourceIdentity exposes the same durable identity used by
// PersistSegment. Snapshot orchestrators use it to reconcile source-side
// deletions without relying on mutable display names.
func SegmentSourceIdentity(seg canonical.Segment, source canonical.SourcePlatform) (string, error) {
	return migrationSegmentSourceIdentity(seg, source)
}

func migrationAutomationSourceIdentity(au canonical.Automation, source canonical.SourcePlatform) (string, error) {
	definition, canonicalDefinition, err := parseSourceDefinition(au.SourceDefinition)
	if err != nil {
		return "", fmt.Errorf("automation %q has invalid source definition: %w", au.Name, err)
	}
	if source == canonical.SourceMailchimp {
		sourceID := sourceDefinitionScalar(definition, "source_id")
		if sourceID == "" {
			return "", fmt.Errorf("Mailchimp automation %q source definition must contain source_id", au.Name)
		}
		return sourceID, nil
	}
	if sourceID := firstNonEmptyLocal(
		sourceDefinitionScalar(definition, "source_id"),
		sourceDefinitionScalar(definition, "id"),
	); sourceID != "" {
		return sourceID, nil
	}
	if canonicalDefinition != "" {
		return "definition:" + migrationOwnershipFingerprint(canonicalDefinition)[:16], nil
	}
	if name := strings.TrimSpace(au.Name); name != "" {
		return "legacy-name:" + name, nil
	}
	return "", fmt.Errorf("automation source identity is required")
}

func parseSourceDefinition(raw string) (map[string]interface{}, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", nil
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var definition map[string]interface{}
	if err := decoder.Decode(&definition); err != nil {
		return nil, "", err
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return nil, "", fmt.Errorf("multiple JSON values are not allowed")
		}
		return nil, "", err
	}
	if definition == nil {
		return nil, "", fmt.Errorf("expected a JSON object")
	}
	canonicalRaw, err := json.Marshal(definition)
	if err != nil {
		return nil, "", err
	}
	return definition, string(canonicalRaw), nil
}

func sourceDefinitionScalar(definition map[string]interface{}, key string) string {
	if len(definition) == 0 {
		return ""
	}
	switch value := definition[key].(type) {
	case string:
		return strings.TrimSpace(value)
	case json.Number:
		return value.String()
	case float64:
		return fmt.Sprintf("%.0f", value)
	case int:
		return fmt.Sprintf("%d", value)
	case int64:
		return fmt.Sprintf("%d", value)
	default:
		return ""
	}
}

func migrationResourceOwnershipFingerprint(tenantID, jobID, resourceType string, source canonical.SourcePlatform, sourceID string) string {
	return migrationOwnershipFingerprint("migration-resource", tenantID, jobID, resourceType, string(source), sourceID)
}

// findOwnedMigrationDestinationTx serializes materialization of one stable
// source identity and returns only a row already owned by the same job ledger.
// The advisory lock closes the same-job concurrent retry race even for resource
// types whose ledger rows predate a dedicated source-identity unique index.
func findOwnedMigrationDestinationTx(
	ctx context.Context,
	tx *sql.Tx,
	tenantID, jobID, resourceType string,
	source canonical.SourcePlatform,
	sourceID, destinationType, ownershipFingerprint string,
) (string, bool, error) {
	if tx == nil {
		return "", false, fmt.Errorf("materialize %s: transaction is required", resourceType)
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" || strings.TrimSpace(sourceID) == "" || strings.TrimSpace(string(source)) == "" {
		return "", false, fmt.Errorf("materialize %s: tenant, job, source platform, and stable source id are required", resourceType)
	}
	// PostgreSQL text values cannot contain NUL bytes. Use the same
	// length-delimited ownership fingerprint as the durable ledger marker, then
	// reduce that safe ASCII value to PostgreSQL's 64-bit advisory-lock key.
	lockKey := migrationOwnershipFingerprint("migration-resource-lock", tenantID, jobID, resourceType, string(source), sourceID)
	var ignored interface{}
	if err := tx.QueryRowContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, lockKey).Scan(&ignored); err != nil {
		return "", false, fmt.Errorf("lock %s source identity %q: %w", resourceType, sourceID, err)
	}

	rows, err := tx.QueryContext(ctx, `
SELECT destination_type, destination_id, destination_metadata
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid
   AND job_id = $2::uuid
   AND resource_type = $3
   AND source_platform = $4
   AND source_id = $5
   AND rolled_back_at IS NULL
 ORDER BY created_at ASC, id ASC
 LIMIT 2`, tenantID, jobID, resourceType, string(source), sourceID)
	if err != nil {
		return "", false, fmt.Errorf("load %s source identity %q: %w", resourceType, sourceID, err)
	}
	defer func() { _ = rows.Close() }()

	var destinationID string
	count := 0
	for rows.Next() {
		count++
		var gotDestinationType string
		var metadataRaw []byte
		if err := rows.Scan(&gotDestinationType, &destinationID, &metadataRaw); err != nil {
			return "", false, err
		}
		if gotDestinationType != destinationType {
			return "", false, fmt.Errorf("tracked %s source %q has destination type %q, want %q", resourceType, sourceID, gotDestinationType, destinationType)
		}
		var metadata map[string]interface{}
		if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
			return "", false, fmt.Errorf("decode tracked %s source %q metadata: %w", resourceType, sourceID, err)
		}
		if got, _ := metadata["ownership_fingerprint"].(string); got != ownershipFingerprint {
			return "", false, fmt.Errorf("tracked %s source %q lacks this migration's exact ownership fingerprint; refusing destination adoption", resourceType, sourceID)
		}
	}
	if err := rows.Err(); err != nil {
		return "", false, err
	}
	if count > 1 {
		return "", false, fmt.Errorf("tracked %s source %q has multiple active destinations; refusing ambiguous retry", resourceType, sourceID)
	}
	return destinationID, count == 1, nil
}
