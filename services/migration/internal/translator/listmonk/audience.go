package listmonk

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

// AudienceMapping binds one source audience to both destination identities.
// Subscriber writes use ListmonkID for native subscriptions and PostwaveID
// for the tenant-scoped list_subscribers mirror.
type AudienceMapping struct {
	SourceID   string
	Name       string
	ListmonkID int
	PostwaveID string
}

type importedResourceFinder func(context.Context, *sql.DB, string, string, string, canonical.SourcePlatform, string) (*ImportedResource, error)
type audienceMappingPersister func(context.Context, *sql.DB, string, string, canonical.SourcePlatform, string, string, int) (AudienceMapping, error)

// EnsureAudienceLists creates one private destination list per discovered
// source audience and records the Listmonk bigint <-> Moosewave UUID mapping.
// Same-job retries reuse the imported-resource ledger instead of duplicating
// lists.
func EnsureAudienceLists(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform, audiences []adapter.DiscoveryAudience) (map[string]AudienceMapping, error) {
	if client == nil || db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, fmt.Errorf("materialize audiences: Listmonk, DB, tenant, and job are required")
	}
	if err := client.ValidateMigrationIsolation(tenantID); err != nil {
		return nil, err
	}
	intents := make([]ExternalWriteIntent, 0, len(audiences))
	for _, audience := range audiences {
		sourceID := strings.TrimSpace(audience.ID)
		if sourceID == "" {
			return nil, fmt.Errorf("materialize audiences: source audience id required")
		}
		name := strings.TrimSpace(audience.Name)
		if name == "" {
			name = "Imported audience " + sourceID
		}
		intent, err := audienceIntent(tenantID, jobID, source, sourceID, name)
		if err != nil {
			return nil, err
		}
		intents = append(intents, intent)
	}
	if err := RecordExternalWriteIntents(ctx, db, intents...); err != nil {
		return nil, fmt.Errorf("materialize audiences before external mutation: %w", err)
	}
	mappings, err := ensureAudienceLists(ctx, client, db, tenantID, jobID, source, audiences, FindImportedResourceBySource, persistAudienceMapping)
	if err != nil {
		return nil, err
	}
	if err := DeleteExternalWriteIntents(ctx, db, tenantID, jobID, intents...); err != nil {
		return nil, fmt.Errorf("materialize audiences: clear durable external intents: %w", err)
	}
	return mappings, nil
}

func ensureAudienceLists(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform, audiences []adapter.DiscoveryAudience, find importedResourceFinder, persist audienceMappingPersister) (map[string]AudienceMapping, error) {
	if client == nil || db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, fmt.Errorf("materialize audiences: Listmonk, DB, tenant, and job are required")
	}
	if find == nil || persist == nil {
		return nil, fmt.Errorf("materialize audiences: imported-resource ledger is required")
	}
	if err := client.ValidateMigrationIsolation(tenantID); err != nil {
		return nil, err
	}
	client = client.ForTenant(tenantID)
	// Reconciliation inventory is scoped to this materialization operation.
	// A long-lived Listmonk client may have observed a different destination
	// snapshot during an earlier job; refresh once here, then reuse the bounded
	// scan across every audience in this batch.
	client.invalidateListInventory()
	out := make(map[string]AudienceMapping, len(audiences))
	for _, audience := range audiences {
		sourceID := strings.TrimSpace(audience.ID)
		if sourceID == "" {
			return nil, fmt.Errorf("materialize audiences: source audience id required")
		}
		name := strings.TrimSpace(audience.Name)
		if name == "" {
			name = "Imported audience " + sourceID
		}
		ownership := newAudienceListOwnership(tenantID, jobID, source, sourceID, name)
		if existing, err := find(ctx, db, tenantID, jobID, ResourceList, source, sourceID); err != nil {
			return nil, err
		} else if existing != nil {
			if err := validateAudienceLedgerOwnership(*existing, tenantID, jobID, source, sourceID, name, ownership.fingerprint); err != nil {
				return nil, err
			}
			mapping, err := audienceMappingFromResource(*existing)
			if err != nil {
				return nil, err
			}
			tracked, err := client.GetList(ctx, mapping.ListmonkID)
			if err != nil {
				return nil, fmt.Errorf("validate tracked audience list %s: %w", sourceID, err)
			}
			if err := ownership.validate(tracked); err != nil {
				return nil, err
			}
			out[sourceID] = mapping
			continue
		}

		resp, err := client.FindListByName(ctx, ownership.name)
		if err != nil {
			return nil, fmt.Errorf("reconcile audience list %s: %w", sourceID, err)
		}
		if resp != nil {
			if err := ownership.validate(resp); err != nil {
				return nil, err
			}
		}
		if resp == nil {
			resp, err = client.CreateList(ctx, ListPayload{
				Name:        ownership.name,
				Type:        "private",
				Optin:       "single",
				Tags:        append([]string(nil), ownership.tags...),
				Description: ownership.description,
			})
			if err != nil {
				mapping, recovered, recoverErr := recoverUncertainAudienceCreate(ctx, client, db, tenantID, jobID, source, sourceID, name, ownership, err, find, persist)
				if recoverErr != nil {
					return nil, recoverErr
				}
				if recovered {
					out[sourceID] = mapping
					continue
				}
				return nil, err
			}
			verified, verifyErr := client.GetList(ctx, resp.ID)
			if verifyErr != nil {
				client.invalidateListInventory()
				return nil, fmt.Errorf("verify created audience list %s: %w (deterministic marker %q retained for detached retry/rollback reconciliation)", sourceID, verifyErr, ownership.name)
			}
			if err := ownership.validate(verified); err != nil {
				return nil, err
			}
			resp = verified
			client.rememberListForReconciliation(*resp)
		}
		mapping, err := persist(ctx, db, tenantID, jobID, source, sourceID, name, resp.ID)
		if err != nil {
			mapping, adopted, resolveErr := reconcileAudiencePersistenceFailure(ctx, client, db, tenantID, jobID, source, sourceID, name, resp, ownership, err, find, persist)
			if resolveErr != nil {
				return nil, resolveErr
			}
			if adopted {
				out[sourceID] = mapping
				continue
			}
			return nil, err
		}
		out[sourceID] = mapping
	}
	return out, nil
}

type audienceListOwnership struct {
	name        string
	description string
	tags        []string
	fingerprint string
}

func newAudienceListOwnership(tenantID, jobID string, source canonical.SourcePlatform, sourceID, name string) audienceListOwnership {
	fingerprint := migrationOwnershipFingerprint("list", tenantID, jobID, string(source), sourceID, name)
	return audienceListOwnership{
		name:        migrationScopedSourceName(name, jobID, sourceID),
		description: fmt.Sprintf("Moosewave migration-owned audience; tenant=%s; job=%s; source=%s; source_id=%s; fingerprint=%s; activation requires Moosewave review", tenantID, jobID, source, sourceID, fingerprint),
		tags:        []string{"postwave-migration", "tenant:" + tenantID, "postwave-fingerprint:" + fingerprint},
		fingerprint: fingerprint,
	}
}

func (o audienceListOwnership) validate(resp *ListResponse) error {
	if resp == nil || resp.ID <= 0 || resp.Name != o.name || resp.Type != "private" || resp.Optin != "single" ||
		resp.Description != o.description || !sameExactStrings(resp.Tags, o.tags) {
		return fmt.Errorf("Listmonk list %q exists without this migration's exact private/single name/description/tag fingerprint; refusing adoption or deletion", o.name)
	}
	return nil
}

func sameExactStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	counts := make(map[string]int, len(want))
	for _, value := range want {
		counts[value]++
	}
	for _, value := range got {
		counts[value]--
		if counts[value] < 0 {
			return false
		}
	}
	for _, count := range counts {
		if count != 0 {
			return false
		}
	}
	return true
}

func validateAudienceLedgerOwnership(res ImportedResource, tenantID, jobID string, source canonical.SourcePlatform, sourceID, name, fingerprint string) error {
	if res.TenantID != tenantID || res.JobID != jobID || res.ResourceType != ResourceList ||
		res.SourcePlatform != source || res.SourceID != sourceID || res.DestinationType != DestinationListmonkList ||
		metadataString(res.DestinationMetadata, "ownership_fingerprint") != fingerprint || metadataString(res.DestinationMetadata, "name") != name {
		return fmt.Errorf("tracked audience %s does not carry this migration's exact tenant/job/source ownership fingerprint", sourceID)
	}
	return nil
}

func recoverUncertainAudienceCreate(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform, sourceID, name string, ownership audienceListOwnership, createErr error, find importedResourceFinder, persist audienceMappingPersister) (AudienceMapping, bool, error) {
	client.invalidateListInventory()
	reconcileCtx, cancel := detachedMigrationContext(ctx)
	recovered, reconcileErr := client.FindListByName(reconcileCtx, ownership.name)
	if reconcileErr != nil {
		cancel()
		return AudienceMapping{}, false, fmt.Errorf("create audience list %s: %w (detached reconciliation failed; deterministic marker %q may remain for retry: %v)", sourceID, createErr, ownership.name, reconcileErr)
	}
	if recovered == nil {
		cancel()
		return AudienceMapping{}, false, fmt.Errorf("create audience list %s: %w (deterministic marker %q remains discoverable if the external response was lost)", sourceID, createErr, ownership.name)
	}
	if err := ownership.validate(recovered); err != nil {
		cancel()
		return AudienceMapping{}, false, fmt.Errorf("create audience list %s: %w (uncertain external result is not safely adoptable: %v)", sourceID, createErr, err)
	}
	mapping, persistErr := persist(reconcileCtx, db, tenantID, jobID, source, sourceID, name, recovered.ID)
	cancel()
	if persistErr == nil {
		return mapping, true, nil
	}
	mapping, adopted, resolveErr := reconcileAudiencePersistenceFailure(ctx, client, db, tenantID, jobID, source, sourceID, name, recovered, ownership, persistErr, find, persist)
	if resolveErr != nil {
		return AudienceMapping{}, false, fmt.Errorf("create audience list %s: %w (exact orphan recovered but ledger persistence failed: %v)", sourceID, createErr, resolveErr)
	}
	return mapping, adopted, nil
}

func reconcileAudiencePersistenceFailure(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform, sourceID, name string, candidate *ListResponse, ownership audienceListOwnership, persistErr error, find importedResourceFinder, persist audienceMappingPersister) (AudienceMapping, bool, error) {
	reconcileCtx, cancel := detachedMigrationContext(ctx)
	defer cancel()
	winner, lookupErr := find(reconcileCtx, db, tenantID, jobID, ResourceList, source, sourceID)
	if lookupErr != nil {
		return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (winner lookup: %v)", persistErr, lookupErr)
	}
	if winner == nil && ctx.Err() != nil {
		mapping, retryErr := persist(reconcileCtx, db, tenantID, jobID, source, sourceID, name, candidate.ID)
		if retryErr == nil {
			return mapping, true, nil
		}
		persistErr = fmt.Errorf("%w (detached ledger retry: %v)", persistErr, retryErr)
		winner, lookupErr = find(reconcileCtx, db, tenantID, jobID, ResourceList, source, sourceID)
		if lookupErr != nil {
			return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (winner lookup after detached retry: %v)", persistErr, lookupErr)
		}
	}
	if winner != nil {
		if err := validateAudienceLedgerOwnership(*winner, tenantID, jobID, source, sourceID, name, ownership.fingerprint); err != nil {
			return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (concurrent ledger winner is unsafe: %v)", persistErr, err)
		}
		mapping, err := audienceMappingFromResource(*winner)
		if err != nil {
			return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (concurrent winner: %v)", persistErr, err)
		}
		winnerList, err := client.GetList(reconcileCtx, mapping.ListmonkID)
		if err != nil {
			return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (concurrent winner lookup: %v)", persistErr, err)
		}
		if err := ownership.validate(winnerList); err != nil {
			return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (concurrent winner ownership: %v)", persistErr, err)
		}
		if mapping.ListmonkID != candidate.ID {
			loser, err := client.GetList(reconcileCtx, candidate.ID)
			if err != nil {
				return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (loser list %d ownership lookup: %v)", persistErr, candidate.ID, err)
			}
			if err := ownership.validate(loser); err != nil {
				return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (refusing loser cleanup: %v)", persistErr, err)
			}
			if err := client.DeleteList(reconcileCtx, candidate.ID); err != nil {
				return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (concurrent winner adopted but loser list %d cleanup failed: %v)", persistErr, candidate.ID, err)
			}
		}
		return mapping, true, nil
	}
	return AudienceMapping{}, false, fmt.Errorf("persist audience mapping: %w (exact migration-owned orphan %d retained with deterministic marker %q for retry/rollback reconciliation)", persistErr, candidate.ID, ownership.name)
}

// LoadAudienceMappings reconstructs source-audience to destination-list
// references from the tenant/job ledger. Automation recovery uses this when
// the subscriber stage already completed in an earlier worker attempt.
func LoadAudienceMappings(ctx context.Context, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform) (map[string]AudienceMapping, error) {
	if db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, fmt.Errorf("load audience mappings: DB, tenant, and job are required")
	}
	resources, err := ListImportedResources(ctx, db, tenantID, jobID, ResourceList)
	if err != nil {
		return nil, err
	}
	out := make(map[string]AudienceMapping, len(resources))
	for _, resource := range resources {
		if source != "" && resource.SourcePlatform != source {
			continue
		}
		mapping, err := audienceMappingFromResource(resource)
		if err != nil {
			return nil, err
		}
		out[resource.SourceID] = mapping
	}
	return out, nil
}

func persistAudienceMapping(ctx context.Context, db *sql.DB, tenantID, jobID string, source canonical.SourcePlatform, sourceID, name string, listmonkID int) (mapping AudienceMapping, err error) {
	if listmonkID <= 0 {
		return mapping, fmt.Errorf("materialize audience %s: Listmonk id required", sourceID)
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return mapping, err
	}
	defer commitTx(tx, &err)

	mapping = AudienceMapping{SourceID: sourceID, Name: name, ListmonkID: listmonkID}
	if err := tx.QueryRowContext(ctx, `SELECT gen_random_uuid()::text`).Scan(&mapping.PostwaveID); err != nil {
		return mapping, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
		VALUES ($1::uuid, $2, $3::uuid)
	`, mapping.PostwaveID, listmonkID, tenantID); err != nil {
		return mapping, fmt.Errorf("persist audience list id map: %w", err)
	}
	if err := recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceList,
		SourcePlatform:  source,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkList,
		DestinationID:   strconv.Itoa(listmonkID),
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"name":                  name,
			"postwave_list_id":      mapping.PostwaveID,
			"ownership_fingerprint": migrationOwnershipFingerprint("list", tenantID, jobID, string(source), sourceID, name),
		},
	}); err != nil {
		return mapping, err
	}
	return mapping, nil
}

func audienceMappingFromResource(res ImportedResource) (AudienceMapping, error) {
	listmonkID, err := strconv.Atoi(res.DestinationID)
	if err != nil || listmonkID <= 0 {
		return AudienceMapping{}, fmt.Errorf("tracked audience %s has invalid Listmonk id %q", res.SourceID, res.DestinationID)
	}
	postwaveID, _ := res.DestinationMetadata["postwave_list_id"].(string)
	if strings.TrimSpace(postwaveID) == "" {
		return AudienceMapping{}, fmt.Errorf("tracked audience %s is missing Moosewave list id", res.SourceID)
	}
	name, _ := res.DestinationMetadata["name"].(string)
	return AudienceMapping{
		SourceID:   res.SourceID,
		Name:       name,
		ListmonkID: listmonkID,
		PostwaveID: postwaveID,
	}, nil
}
