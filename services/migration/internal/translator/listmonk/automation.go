package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/postwave/migrate/canonical"
)

const (
	// MigrationSourceTemplateIDMetadataKey is written only after orchestration
	// resolves a source template identity through this job's tenant-scoped
	// template ledger. PersistAutomation independently rechecks that ledger.
	MigrationSourceTemplateIDMetadataKey = "postwave_migration_source_template_id"
	importedAutomationReviewStatus       = "draft"
)

// PersistAutomation writes a canonical Automation as a row in Moosewave's own
// `automations` table (created by infra/migrations/0005_automations_archive.sql).
//
// Important: Listmonk has no native automation runtime. We are NOT writing the
// automation engine here — that lives in services/automation, which another
// agent is building. This translator's only job is to durably persist the
// canonical AST, keyed by tenant and forced to draft. A separate explicit
// review/activation workflow must authorize any later runtime execution.
func PersistAutomation(ctx context.Context, db *sql.DB, tenantID, jobID string, au canonical.Automation, sourcePlatform canonical.SourcePlatform) (id string, err error) {
	if reason := automationUnsupportedReason(au); reason != "" {
		return "", fmt.Errorf("persist automation %q: %s", au.Name, reason)
	}
	sourceID, err := migrationAutomationSourceIdentity(au, sourcePlatform)
	if err != nil {
		return "", err
	}
	triggers, err := json.Marshal(au.Triggers)
	if err != nil {
		return "", fmt.Errorf("marshal automation triggers %q: %w", au.Name, err)
	}
	nodes, err := json.Marshal(au.Nodes)
	if err != nil {
		return "", fmt.Errorf("marshal automation nodes %q: %w", au.Name, err)
	}
	edges, err := json.Marshal(au.Edges)
	if err != nil {
		return "", fmt.Errorf("marshal automation edges %q: %w", au.Name, err)
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return "", err
	}
	defer commitTx(tx, &err)
	if err := validateAutomationTemplateReferencesTx(ctx, tx, tenantID, jobID, au, sourcePlatform); err != nil {
		return "", err
	}
	name := migrationScopedSourceName(au.Name, jobID, sourceID)
	ownershipFingerprint := migrationResourceOwnershipFingerprint(tenantID, jobID, ResourceAutomation, sourcePlatform, sourceID)
	existingID, exists, err := findOwnedMigrationDestinationTx(
		ctx, tx, tenantID, jobID, ResourceAutomation, sourcePlatform, sourceID,
		DestinationPostwaveAutomation, ownershipFingerprint,
	)
	if err != nil {
		return "", err
	}

	if exists {
		var collisionID string
		collisionErr := tx.QueryRowContext(ctx, `
			SELECT id::text
			  FROM automations
			 WHERE tenant_id = $1::uuid
			   AND name = $2
			   AND id <> $3::uuid
			 LIMIT 1
		`, tenantID, name, existingID).Scan(&collisionID)
		switch collisionErr {
		case nil:
			return "", fmt.Errorf("update automation %q: deterministic name %q is already used by unowned destination %s; refusing retry", au.Name, name, collisionID)
		case sql.ErrNoRows:
		default:
			return "", fmt.Errorf("check automation retry collision %q: %w", name, collisionErr)
		}
		if err := tx.QueryRowContext(ctx, `
			UPDATE automations
			   SET name = $3,
			       status = $4,
			       triggers = $5::jsonb,
			       nodes = $6::jsonb,
			       edges = $7::jsonb,
			       source_definition = $8,
			       source_platform = $9,
			       updated_at = now()
			 WHERE tenant_id = $1::uuid
			   AND id = $2::uuid
			RETURNING id::text
		`, tenantID, existingID, name, importedAutomationReviewStatus, string(triggers), string(nodes), string(edges), au.SourceDefinition, string(sourcePlatform)).Scan(&id); err != nil {
			if err == sql.ErrNoRows {
				return "", fmt.Errorf("tracked automation source %q points to missing destination %q", sourceID, existingID)
			}
			return "", fmt.Errorf("update tracked automation %q: %w", au.Name, err)
		}
	} else {
		var collisionID string
		collisionErr := tx.QueryRowContext(ctx, `
			SELECT id::text
			  FROM automations
			 WHERE tenant_id = $1::uuid
			   AND name = $2
			 LIMIT 1
		`, tenantID, name).Scan(&collisionID)
		switch collisionErr {
		case nil:
			return "", fmt.Errorf("persist automation %q: deterministic name %q is already used by unowned destination %s; refusing adoption", au.Name, name, collisionID)
		case sql.ErrNoRows:
		default:
			return "", fmt.Errorf("check automation name collision %q: %w", name, collisionErr)
		}
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO automations
				(tenant_id, name, status, triggers, nodes, edges, source_definition, source_platform)
			VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
			RETURNING id::text
		`, tenantID, name, importedAutomationReviewStatus, string(triggers), string(nodes), string(edges), au.SourceDefinition, string(sourcePlatform)).Scan(&id); err != nil {
			return "", fmt.Errorf("persist automation %q: %w", au.Name, err)
		}
	}
	if err := recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceAutomation,
		SourcePlatform:  sourcePlatform,
		SourceID:        sourceID,
		DestinationType: DestinationPostwaveAutomation,
		DestinationID:   id,
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"name":                  name,
			"source_name":           au.Name,
			"source_definition":     au.SourceDefinition,
			"status":                importedAutomationReviewStatus,
			"source_status":         au.Status,
			"ownership_fingerprint": ownershipFingerprint,
		},
	}); err != nil {
		return "", err
	}
	return id, nil
}

func automationUnsupportedReason(au canonical.Automation) string {
	hasRuntimeTrigger := false
	for _, trigger := range au.Triggers {
		if automationRuntimeTriggerSupported(trigger) {
			hasRuntimeTrigger = true
			break
		}
	}
	if !hasRuntimeTrigger {
		return "automation has no supported runtime trigger in canonical form"
	}
	if len(au.Nodes) == 0 {
		return "automation has no executable journey nodes in canonical form"
	}
	for _, n := range au.Nodes {
		if strings.EqualFold(strings.TrimSpace(n.Type), "send_email") {
			if strings.TrimSpace(n.TemplateID) == "" {
				return "send-email node has no destination template"
			}
			if automationNodeMetadataString(n.Metadata, MigrationSourceTemplateIDMetadataKey) == "" {
				return "send-email node has no tenant-verified source-to-destination template remap"
			}
		}
		if !automationRuntimeNodeSupported(n) {
			return fmt.Sprintf("automation node %q is unsupported or incomplete for the destination runtime", n.ID)
		}
	}
	return ""
}

func validateAutomationTemplateReferencesTx(ctx context.Context, tx *sql.Tx, tenantID, jobID string, au canonical.Automation, sourcePlatform canonical.SourcePlatform) error {
	for _, node := range au.Nodes {
		if !strings.EqualFold(strings.TrimSpace(node.Type), "send_email") {
			continue
		}
		sourceID := automationNodeMetadataString(node.Metadata, MigrationSourceTemplateIDMetadataKey)
		destinationID := strings.TrimSpace(node.TemplateID)
		if sourceID == "" || destinationID == "" {
			return fmt.Errorf("persist automation %q: send-email node %q has no tenant-verified source-to-destination template remap", au.Name, node.ID)
		}
		destinationNumericID, parseErr := strconv.ParseInt(destinationID, 10, 64)
		if parseErr != nil || destinationNumericID <= 0 {
			return fmt.Errorf("persist automation %q: send-email node %q has invalid Listmonk destination template id %q", au.Name, node.ID, destinationID)
		}

		var ownershipFingerprint string
		lookupErr := tx.QueryRowContext(ctx, `
			SELECT COALESCE(destination_metadata->>'ownership_fingerprint', '')
			  FROM migration_imported_resources
			 WHERE tenant_id = $1::uuid
			   AND job_id = $2::uuid
			   AND resource_type = $3
			   AND source_platform = $4
			   AND source_id = $5
			   AND destination_type = $6
			   AND destination_id = $7
			   AND rolled_back_at IS NULL
			 ORDER BY created_at ASC, id ASC
			 LIMIT 1
		`, tenantID, jobID, ResourceTemplate, string(sourcePlatform), sourceID, DestinationListmonkTemplate, destinationID).Scan(&ownershipFingerprint)
		if lookupErr == sql.ErrNoRows {
			return fmt.Errorf("persist automation %q: send-email node %q destination template %q is not the tenant-owned remap of source template %q", au.Name, node.ID, destinationID, sourceID)
		}
		if lookupErr != nil {
			return fmt.Errorf("persist automation %q: verify send-email node %q destination template ownership: %w", au.Name, node.ID, lookupErr)
		}
		if strings.TrimSpace(ownershipFingerprint) == "" {
			return fmt.Errorf("persist automation %q: send-email node %q destination template %q lacks migration ownership attestation", au.Name, node.ID, destinationID)
		}
	}
	return nil
}

func automationNodeMetadataString(metadata map[string]interface{}, key string) string {
	if metadata == nil {
		return ""
	}
	value, _ := metadata[key].(string)
	return strings.TrimSpace(value)
}

func automationRuntimeNodeSupported(node canonical.AutomationNode) bool {
	if strings.TrimSpace(node.ID) == "" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(node.Type)) {
	case "send_email":
		return strings.TrimSpace(node.TemplateID) != ""
	case "send_sms":
		return strings.TrimSpace(node.SMSBody) != ""
	case "webhook":
		return strings.TrimSpace(node.WebhookURL) != ""
	case "branch":
		return node.Condition != nil
	case "percentage_split":
		return len(node.Variants) > 0
	case "ab_test":
		return len(node.Variants) > 0
	case "coupon_assign":
		poolID, _ := node.Metadata["coupon_pool_id"].(string)
		return strings.TrimSpace(poolID) != ""
	case "goal":
		return node.Goal != nil || node.Condition != nil
	case "wait":
		return node.DurationSeconds >= 0
	case "wait_until":
		return node.WaitUntil != nil
	case "wait_until_trigger":
		return node.WaitTrigger != nil && automationRuntimeTriggerSupported(*node.WaitTrigger)
	case "action":
		return automationRuntimeActionSupported(node.Action)
	case "manual_review", "exit":
		return true
	default:
		return false
	}
}

func automationRuntimeActionSupported(action *canonical.AutomationAction) bool {
	if action == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(action.Kind)) {
	case "add_tag", "remove_tag":
		return strings.TrimSpace(action.Tag) != ""
	case "move_to_list":
		return strings.TrimSpace(action.ListID) != ""
	case "unsubscribe":
		return true
	case "update_profile_property":
		return strings.TrimSpace(action.Field) != ""
	case "flow_webhook":
		return strings.TrimSpace(action.URL) != ""
	default:
		return false
	}
}

func automationRuntimeTriggerSupported(trigger canonical.AutomationTrigger) bool {
	switch strings.ToLower(strings.TrimSpace(trigger.Type)) {
	case "subscriber_added_to_list", "list_join", "list_joined":
		return strings.TrimSpace(trigger.ListID) != ""
	case "tag_added":
		return strings.TrimSpace(trigger.Tag) != ""
	case "custom_event":
		return strings.TrimSpace(trigger.EventName) != ""
	case "date_field":
		return strings.TrimSpace(trigger.Field) != ""
	case "subscriber_opened_email", "subscriber_clicked_link":
		return true
	case "subscriber_did_not_open":
		return strings.TrimSpace(trigger.CampaignID) != "" && trigger.AfterDays > 0
	default:
		return false
	}
}
