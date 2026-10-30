package listmonk

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/postwave/migrate/canonical"
)

type importedResourceRecorder func(context.Context, *sql.DB, ImportedResource) error

// CreateOrReuseTemplate makes Listmonk's create-only template API idempotent
// for one migration job and stable source template identity.
func CreateOrReuseTemplate(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, tpl canonical.EmailTemplate) (*TemplateResponse, bool, error) {
	if client == nil || db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, false, fmt.Errorf("materialize template: Listmonk, DB, tenant, and job are required")
	}
	if err := client.ValidateMigrationIsolation(tenantID); err != nil {
		return nil, false, err
	}
	sourceID := strings.TrimSpace(tpl.SourceID)
	if sourceID == "" {
		sourceID = "name:" + strings.TrimSpace(tpl.Name)
	}
	intent, err := templateIntent(tenantID, jobID, tpl, sourceID)
	if err != nil {
		return nil, false, err
	}
	// The template ledger is intentionally immutable because Listmonk does not
	// expose a conditional update primitive. Detect a source-content change
	// before writing a second durable external intent; otherwise a rejected
	// delta could leave an unreconcilable intent that also blocks rollback.
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	if existing, findErr := FindImportedResourceBySource(ctx, db, tenantID, jobID, ResourceTemplate, tpl.SourcePlatform, sourceID); findErr != nil {
		return nil, false, fmt.Errorf("materialize template: preflight immutable ledger: %w", findErr)
	} else if existing != nil {
		if ownershipErr := validateTemplateLedgerOwnership(*existing, tenantID, jobID, tpl.SourcePlatform, sourceID, tpl.Name, ownership.fingerprint); ownershipErr != nil {
			return nil, false, fmt.Errorf("materialize template %s changed after its immutable destination copy was created; rebuild or version the template before final delta: %w", sourceID, ownershipErr)
		}
	}
	if err := RecordExternalWriteIntents(ctx, db, intent); err != nil {
		return nil, false, fmt.Errorf("materialize template before external mutation: %w", err)
	}
	resp, reused, err := createOrReuseTemplate(ctx, client, db, tenantID, jobID, tpl, FindImportedResourceBySource, RecordImportedResource)
	if err != nil {
		return nil, false, err
	}
	if err := DeleteExternalWriteIntents(ctx, db, tenantID, jobID, intent); err != nil {
		return nil, false, fmt.Errorf("materialize template: clear durable external intent: %w", err)
	}
	return resp, reused, nil
}

func createOrReuseTemplate(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, tpl canonical.EmailTemplate, find importedResourceFinder, record importedResourceRecorder) (*TemplateResponse, bool, error) {
	if client == nil || db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, false, fmt.Errorf("materialize template: Listmonk, DB, tenant, and job are required")
	}
	if find == nil || record == nil {
		return nil, false, fmt.Errorf("materialize template: imported-resource ledger is required")
	}
	if err := client.ValidateMigrationIsolation(tenantID); err != nil {
		return nil, false, err
	}
	client = client.ForTenant(tenantID)
	sourceID := strings.TrimSpace(tpl.SourceID)
	if sourceID == "" {
		sourceID = "name:" + strings.TrimSpace(tpl.Name)
	}
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	if existing, err := find(ctx, db, tenantID, jobID, ResourceTemplate, tpl.SourcePlatform, sourceID); err != nil {
		return nil, false, err
	} else if existing != nil {
		if err := validateTemplateLedgerOwnership(*existing, tenantID, jobID, tpl.SourcePlatform, sourceID, tpl.Name, ownership.fingerprint); err != nil {
			return nil, false, err
		}
		id, err := strconv.Atoi(existing.DestinationID)
		if err != nil || id <= 0 {
			return nil, false, fmt.Errorf("tracked template %s has invalid destination id %q", sourceID, existing.DestinationID)
		}
		tracked, err := client.GetTemplate(ctx, id)
		if err != nil {
			return nil, false, fmt.Errorf("validate tracked template %s: %w", sourceID, err)
		}
		if err := ownership.validate(tracked); err != nil {
			return nil, false, err
		}
		return tracked, true, nil
	}
	resp, err := client.FindTemplateByName(ctx, ownership.name)
	if err != nil {
		return nil, false, fmt.Errorf("reconcile template %s: %w", sourceID, err)
	}
	recovered := resp != nil
	if resp != nil {
		if err := ownership.validate(resp); err != nil {
			return nil, false, err
		}
	}
	if resp == nil {
		resp, err = client.CreateTemplate(ctx, ownership.name, ownership.body)
		if err != nil {
			recoveredResp, recoveredCreate, recoverErr := recoverUncertainTemplateCreate(ctx, client, db, tenantID, jobID, tpl, sourceID, ownership, err, find, record)
			if recoverErr != nil {
				return nil, false, recoverErr
			}
			if recoveredCreate {
				return recoveredResp, true, nil
			}
			return nil, false, err
		}
		verified, verifyErr := client.GetTemplate(ctx, resp.ID)
		if verifyErr != nil {
			client.invalidateTemplateInventory()
			return nil, false, fmt.Errorf("verify created template %s: %w (deterministic marker %q retained for detached retry/rollback reconciliation)", sourceID, verifyErr, ownership.name)
		}
		if err := ownership.validate(verified); err != nil {
			return nil, false, err
		}
		resp = verified
		client.rememberTemplateForReconciliation(*resp)
	}
	resource := templateImportedResource(tenantID, jobID, tpl, sourceID, resp.ID, recovered, ownership.fingerprint)
	if err := record(ctx, db, resource); err != nil {
		winnerResp, adopted, resolveErr := reconcileTemplatePersistenceFailure(ctx, client, db, tenantID, jobID, tpl, sourceID, resp, ownership, err, find, record)
		if resolveErr != nil {
			return nil, false, resolveErr
		}
		if adopted {
			return winnerResp, true, nil
		}
		return nil, false, err
	}
	return resp, recovered, nil
}

type templateOwnership struct {
	name        string
	body        string
	fingerprint string
}

func newTemplateOwnership(tenantID, jobID string, tpl canonical.EmailTemplate, sourceID string) templateOwnership {
	fingerprint := migrationOwnershipFingerprint("template", tenantID, jobID, string(tpl.SourcePlatform), sourceID, tpl.Name, tpl.HTML)
	return templateOwnership{
		name:        migrationScopedSourceName(tpl.Name, jobID, sourceID),
		body:        fmt.Sprintf("<!-- postwave-migration-fingerprint:%s -->\n%s", fingerprint, tpl.HTML),
		fingerprint: fingerprint,
	}
}

func (o templateOwnership) validate(resp *TemplateResponse) error {
	if resp == nil || resp.ID <= 0 || resp.Name != o.name || resp.Type != "campaign" || resp.Body != o.body {
		return fmt.Errorf("Listmonk template %q exists without this migration's exact campaign/job/source/content fingerprint; refusing adoption or deletion", o.name)
	}
	return nil
}

func validateTemplateLedgerOwnership(res ImportedResource, tenantID, jobID string, source canonical.SourcePlatform, sourceID, name, fingerprint string) error {
	if res.TenantID != tenantID || res.JobID != jobID || res.ResourceType != ResourceTemplate ||
		res.SourcePlatform != source || res.SourceID != sourceID || res.DestinationType != DestinationListmonkTemplate ||
		metadataString(res.DestinationMetadata, "ownership_fingerprint") != fingerprint || metadataString(res.DestinationMetadata, "name") != name {
		return fmt.Errorf("tracked template %s does not carry this migration's exact tenant/job/source/content ownership fingerprint", sourceID)
	}
	return nil
}

func templateImportedResource(tenantID, jobID string, tpl canonical.EmailTemplate, sourceID string, destinationID int, recovered bool, fingerprint string) ImportedResource {
	return ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceTemplate,
		SourcePlatform:  tpl.SourcePlatform,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkTemplate,
		DestinationID:   strconv.Itoa(destinationID),
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"recovered_orphan":      recovered,
			"ownership_fingerprint": fingerprint,
			"name":                  tpl.Name,
			"subject":               tpl.Subject,
			"preview_text":          tpl.PreviewText,
			"default_content":       tpl.DefaultContent,
			"source_definition":     tpl.SourceDefinition,
			"warnings":              tpl.Warnings,
		},
	}
}

func recoverUncertainTemplateCreate(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, tpl canonical.EmailTemplate, sourceID string, ownership templateOwnership, createErr error, find importedResourceFinder, record importedResourceRecorder) (*TemplateResponse, bool, error) {
	client.invalidateTemplateInventory()
	reconcileCtx, cancel := detachedMigrationContext(ctx)
	recovered, reconcileErr := client.FindTemplateByName(reconcileCtx, ownership.name)
	if reconcileErr != nil {
		cancel()
		return nil, false, fmt.Errorf("create template %s: %w (detached reconciliation failed; deterministic marker %q may remain for retry: %v)", sourceID, createErr, ownership.name, reconcileErr)
	}
	if recovered == nil {
		cancel()
		return nil, false, fmt.Errorf("create template %s: %w (deterministic marker %q remains discoverable if the external response was lost)", sourceID, createErr, ownership.name)
	}
	if err := ownership.validate(recovered); err != nil {
		cancel()
		return nil, false, fmt.Errorf("create template %s: %w (uncertain external result is not safely adoptable: %v)", sourceID, createErr, err)
	}
	resource := templateImportedResource(tenantID, jobID, tpl, sourceID, recovered.ID, true, ownership.fingerprint)
	recordErr := record(reconcileCtx, db, resource)
	cancel()
	if recordErr == nil {
		return recovered, true, nil
	}
	resp, adopted, resolveErr := reconcileTemplatePersistenceFailure(ctx, client, db, tenantID, jobID, tpl, sourceID, recovered, ownership, recordErr, find, record)
	if resolveErr != nil {
		return nil, false, fmt.Errorf("create template %s: %w (exact orphan recovered but ledger persistence failed: %v)", sourceID, createErr, resolveErr)
	}
	return resp, adopted, nil
}

func reconcileTemplatePersistenceFailure(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, tpl canonical.EmailTemplate, sourceID string, candidate *TemplateResponse, ownership templateOwnership, recordErr error, find importedResourceFinder, record importedResourceRecorder) (*TemplateResponse, bool, error) {
	reconcileCtx, cancel := detachedMigrationContext(ctx)
	defer cancel()
	winner, lookupErr := find(reconcileCtx, db, tenantID, jobID, ResourceTemplate, tpl.SourcePlatform, sourceID)
	if lookupErr != nil {
		return nil, false, fmt.Errorf("record imported template: %w (winner lookup: %v)", recordErr, lookupErr)
	}
	if winner == nil && ctx.Err() != nil {
		resource := templateImportedResource(tenantID, jobID, tpl, sourceID, candidate.ID, true, ownership.fingerprint)
		retryErr := record(reconcileCtx, db, resource)
		if retryErr == nil {
			return candidate, true, nil
		}
		recordErr = fmt.Errorf("%w (detached ledger retry: %v)", recordErr, retryErr)
		winner, lookupErr = find(reconcileCtx, db, tenantID, jobID, ResourceTemplate, tpl.SourcePlatform, sourceID)
		if lookupErr != nil {
			return nil, false, fmt.Errorf("record imported template: %w (winner lookup after detached retry: %v)", recordErr, lookupErr)
		}
	}
	if winner != nil {
		if err := validateTemplateLedgerOwnership(*winner, tenantID, jobID, tpl.SourcePlatform, sourceID, tpl.Name, ownership.fingerprint); err != nil {
			return nil, false, fmt.Errorf("record imported template: %w (concurrent ledger winner is unsafe: %v)", recordErr, err)
		}
		id, err := strconv.Atoi(winner.DestinationID)
		if err != nil || id <= 0 {
			return nil, false, fmt.Errorf("record imported template: %w (concurrent winner has invalid destination id %q)", recordErr, winner.DestinationID)
		}
		winnerTemplate, err := client.GetTemplate(reconcileCtx, id)
		if err != nil {
			return nil, false, fmt.Errorf("record imported template: %w (concurrent winner lookup: %v)", recordErr, err)
		}
		if err := ownership.validate(winnerTemplate); err != nil {
			return nil, false, fmt.Errorf("record imported template: %w (concurrent winner ownership: %v)", recordErr, err)
		}
		if id != candidate.ID {
			loser, err := client.GetTemplate(reconcileCtx, candidate.ID)
			if err != nil {
				return nil, false, fmt.Errorf("record imported template: %w (loser template %d ownership lookup: %v)", recordErr, candidate.ID, err)
			}
			if err := ownership.validate(loser); err != nil {
				return nil, false, fmt.Errorf("record imported template: %w (refusing loser cleanup: %v)", recordErr, err)
			}
			if err := client.DeleteTemplate(reconcileCtx, candidate.ID); err != nil {
				return nil, false, fmt.Errorf("record imported template: %w (concurrent winner adopted but loser template %d cleanup failed: %v)", recordErr, candidate.ID, err)
			}
		}
		return winnerTemplate, true, nil
	}
	return nil, false, fmt.Errorf("record imported template: %w (exact migration-owned orphan %d retained with deterministic marker %q for retry/rollback reconciliation)", recordErr, candidate.ID, ownership.name)
}

func metadataString(metadata map[string]interface{}, key string) string {
	value, _ := metadata[key].(string)
	return value
}
