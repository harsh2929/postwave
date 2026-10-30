package listmonk

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/postwave/migrate/canonical"
)

// ExternalWriteIntent is the durable intent written before a Listmonk
// mutation. A worker crash can therefore be reconciled by deterministic
// lookup and exact ownership markers even when the imported-resource ledger
// transaction was never reached.
type ExternalWriteIntent struct {
	ID              string
	TenantID        string
	JobID           string
	ResourceType    string
	IntentKey       string
	SourcePlatform  canonical.SourcePlatform
	SourceID        string
	DestinationType string
	LookupKey       string
	Payload         json.RawMessage
}

type audienceIntentPayload struct {
	Name string `json:"name"`
}

type subscriberIntentPayload struct {
	Email          string `json:"email"`
	MutationSHA256 string `json:"mutation_sha256"`
}

type templateIntentPayload struct {
	Template             canonical.EmailTemplate `json:"template"`
	BodySHA256           string                  `json:"body_sha256"`
	OwnershipFingerprint string                  `json:"ownership_fingerprint"`
}

func subscriberIntent(tenantID, jobID string, sub canonical.Subscriber, mutation SubscriberPayload) (ExternalWriteIntent, error) {
	email := strings.ToLower(strings.TrimSpace(sub.Email))
	if email == "" {
		return ExternalWriteIntent{}, fmt.Errorf("subscriber external intent: email required")
	}
	if !strings.EqualFold(strings.TrimSpace(mutation.Email), email) {
		return ExternalWriteIntent{}, fmt.Errorf("subscriber external intent: canonical and destination emails must match")
	}
	mutationBytes, err := json.Marshal(struct {
		Payload                 SubscriberPayload `json:"payload"`
		AuthoritativeStatus     bool              `json:"authoritative_status"`
		AuthoritativeTags       bool              `json:"authoritative_tags"`
		AuthoritativeFields     bool              `json:"authoritative_fields"`
		TransferSourceFrom      string            `json:"transfer_source_from,omitempty"`
		PreserveExistingConsent bool              `json:"preserve_existing_consent,omitempty"`
	}{
		Payload:                 mutation,
		AuthoritativeStatus:     mutation.AuthoritativeStatus,
		AuthoritativeTags:       mutation.AuthoritativeTags,
		AuthoritativeFields:     mutation.AuthoritativeFields,
		TransferSourceFrom:      mutation.TransferSourceFrom,
		PreserveExistingConsent: mutation.PreserveExistingConsent,
	})
	if err != nil {
		return ExternalWriteIntent{}, err
	}
	digest := sha256.Sum256(mutationBytes)
	payload, err := json.Marshal(subscriberIntentPayload{
		Email:          email,
		MutationSHA256: hex.EncodeToString(digest[:]),
	})
	if err != nil {
		return ExternalWriteIntent{}, err
	}
	return ExternalWriteIntent{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceSubscriber,
		IntentKey:       email,
		SourcePlatform:  sub.SourcePlatform,
		SourceID:        strings.TrimSpace(sub.SourceID),
		DestinationType: DestinationListmonkSubscriber,
		LookupKey:       email,
		Payload:         payload,
	}, nil
}

func audienceIntent(tenantID, jobID string, source canonical.SourcePlatform, sourceID, name string) (ExternalWriteIntent, error) {
	payload, err := json.Marshal(audienceIntentPayload{Name: name})
	if err != nil {
		return ExternalWriteIntent{}, err
	}
	ownership := newAudienceListOwnership(tenantID, jobID, source, sourceID, name)
	return ExternalWriteIntent{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceList,
		IntentKey:       migrationOwnershipFingerprint("intent", ResourceList, string(source), sourceID),
		SourcePlatform:  source,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkList,
		LookupKey:       ownership.name,
		Payload:         payload,
	}, nil
}

func templateIntent(tenantID, jobID string, tpl canonical.EmailTemplate, sourceID string) (ExternalWriteIntent, error) {
	ownership := newTemplateOwnership(tenantID, jobID, tpl, sourceID)
	bodyDigest := sha256.Sum256([]byte(ownership.body))
	metadata := tpl
	// The remote-body hash and ownership fingerprint are sufficient to prove
	// an orphan is unchanged. Do not retain full template HTML indefinitely in
	// a crash-window row; the normal imported-resource ledger stores only its
	// bounded review metadata after reconciliation.
	metadata.HTML = ""
	payload, err := json.Marshal(templateIntentPayload{
		Template:             metadata,
		BodySHA256:           hex.EncodeToString(bodyDigest[:]),
		OwnershipFingerprint: ownership.fingerprint,
	})
	if err != nil {
		return ExternalWriteIntent{}, err
	}
	return ExternalWriteIntent{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceTemplate,
		IntentKey:       migrationOwnershipFingerprint("intent", ResourceTemplate, string(tpl.SourcePlatform), sourceID),
		SourcePlatform:  tpl.SourcePlatform,
		SourceID:        sourceID,
		DestinationType: DestinationListmonkTemplate,
		LookupKey:       ownership.name,
		Payload:         payload,
	}, nil
}

// RecordExternalWriteIntents persists every intent in one tenant transaction.
// Existing rows are deliberately immutable: an unresolved orphan must be
// reconciled with the exact payload that preceded its mutation, not replaced
// by data from a later retry or delta run.
func RecordExternalWriteIntents(ctx context.Context, db *sql.DB, intents ...ExternalWriteIntent) (err error) {
	if len(intents) == 0 {
		return nil
	}
	tenantID := strings.TrimSpace(intents[0].TenantID)
	jobID := strings.TrimSpace(intents[0].JobID)
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	for _, intent := range intents {
		if err := validateExternalWriteIntent(intent, tenantID, jobID); err != nil {
			return err
		}
		payload := intent.Payload
		if len(payload) == 0 {
			payload = json.RawMessage(`{}`)
		}
		if !json.Valid(payload) {
			return fmt.Errorf("external write intent %s has invalid JSON payload", intent.IntentKey)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO migration_external_write_intents
				(tenant_id, job_id, resource_type, intent_key, source_platform, source_id,
				 destination_type, lookup_key, payload)
			VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)
			ON CONFLICT (tenant_id, job_id, resource_type, intent_key) DO NOTHING
		`, intent.TenantID, intent.JobID, intent.ResourceType, intent.IntentKey,
			string(intent.SourcePlatform), intent.SourceID, intent.DestinationType, intent.LookupKey, string(payload)); err != nil {
			return fmt.Errorf("record external write intent %s/%s: %w", intent.ResourceType, intent.IntentKey, err)
		}
		var exact bool
		if err := tx.QueryRowContext(ctx, `
			SELECT source_platform = $5
			   AND source_id = $6
			   AND destination_type = $7
			   AND lookup_key = $8
			   AND payload = $9::jsonb
			  FROM migration_external_write_intents
			 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
			   AND resource_type = $3 AND intent_key = $4
		`, intent.TenantID, intent.JobID, intent.ResourceType, intent.IntentKey,
			string(intent.SourcePlatform), intent.SourceID, intent.DestinationType, intent.LookupKey, string(payload)).Scan(&exact); err != nil {
			return fmt.Errorf("verify external write intent %s/%s: %w", intent.ResourceType, intent.IntentKey, err)
		}
		if !exact {
			return fmt.Errorf("external write intent %s/%s conflicts with immutable recorded payload", intent.ResourceType, intent.IntentKey)
		}
	}
	return nil
}

func DeleteExternalWriteIntents(ctx context.Context, db *sql.DB, tenantID, jobID string, intents ...ExternalWriteIntent) (err error) {
	if len(intents) == 0 {
		return nil
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	for _, intent := range intents {
		if err := validateExternalWriteIntent(intent, tenantID, jobID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `
			DELETE FROM migration_external_write_intents
			 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
			   AND resource_type = $3 AND intent_key = $4
		`, tenantID, jobID, intent.ResourceType, intent.IntentKey)
		if err != nil {
			return fmt.Errorf("delete external write intent %s/%s: %w", intent.ResourceType, intent.IntentKey, err)
		}
		if affected, err := result.RowsAffected(); err != nil || affected > 1 {
			return fmt.Errorf("delete external write intent %s/%s affected an invalid row count", intent.ResourceType, intent.IntentKey)
		}
	}
	return nil
}

func validateExternalWriteIntent(intent ExternalWriteIntent, tenantID, jobID string) error {
	tenantID = strings.TrimSpace(tenantID)
	jobID = strings.TrimSpace(jobID)
	if tenantID == "" || jobID == "" ||
		strings.TrimSpace(intent.TenantID) != tenantID || strings.TrimSpace(intent.JobID) != jobID ||
		strings.TrimSpace(intent.ResourceType) != intent.ResourceType || strings.TrimSpace(intent.IntentKey) != intent.IntentKey ||
		strings.TrimSpace(string(intent.SourcePlatform)) == "" ||
		strings.TrimSpace(intent.DestinationType) != intent.DestinationType ||
		strings.TrimSpace(intent.LookupKey) != intent.LookupKey {
		return fmt.Errorf("external write intent: exact tenant, job, source, type, key, destination, and lookup are required")
	}
	wantDestination := ""
	switch intent.ResourceType {
	case ResourceSubscriber:
		wantDestination = DestinationListmonkSubscriber
	case ResourceList:
		wantDestination = DestinationListmonkList
	case ResourceTemplate:
		wantDestination = DestinationListmonkTemplate
	default:
		return fmt.Errorf("external write intent: unsupported resource type %q", intent.ResourceType)
	}
	if intent.DestinationType != wantDestination {
		return fmt.Errorf("external write intent: resource type %q requires destination type %q", intent.ResourceType, wantDestination)
	}
	return nil
}

const externalIntentReconciliationBatchSize = 100

func listExternalWriteIntentsBatch(ctx context.Context, db *sql.DB, tenantID, jobID string, limit int) (out []ExternalWriteIntent, err error) {
	if limit <= 0 || limit > externalIntentReconciliationBatchSize {
		limit = externalIntentReconciliationBatchSize
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, err
	}
	defer commitTx(tx, &err)
	rows, err := tx.QueryContext(ctx, `
		SELECT id::text, tenant_id::text, job_id::text, resource_type, intent_key,
		       source_platform, source_id, destination_type, lookup_key, payload
		  FROM migration_external_write_intents
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
		 ORDER BY created_at, id
		 LIMIT $3
	`, tenantID, jobID, limit)
	if err != nil {
		return nil, fmt.Errorf("list external write intents: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var intent ExternalWriteIntent
		if err := rows.Scan(&intent.ID, &intent.TenantID, &intent.JobID, &intent.ResourceType, &intent.IntentKey,
			&intent.SourcePlatform, &intent.SourceID, &intent.DestinationType, &intent.LookupKey, &intent.Payload); err != nil {
			return nil, err
		}
		out = append(out, intent)
	}
	return out, rows.Err()
}

func CountExternalWriteIntents(ctx context.Context, db *sql.DB, tenantID, jobID string) (count int, err error) {
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return 0, err
	}
	defer commitTx(tx, &err)
	if err := tx.QueryRowContext(ctx, `
		SELECT count(*)
		  FROM migration_external_write_intents
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
	`, tenantID, jobID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count external write intents: %w", err)
	}
	return count, nil
}

// ReconcileExternalWriteIntents converts exact migration-owned external
// results into the normal imported-resource ledger. An intent with no owned
// destination represents a crash before mutation and is simply removed.
// Ambiguous or changed external state fails closed and remains durable.
func ReconcileExternalWriteIntents(ctx context.Context, client *Client, db *sql.DB, tenantID, jobID string) (err error) {
	intents, err := listExternalWriteIntentsBatch(ctx, db, tenantID, jobID, externalIntentReconciliationBatchSize)
	if err != nil || len(intents) == 0 {
		return err
	}
	// Reconciliation can turn an uncertain subscriber write into a durable
	// ownership ledger. Serialize it with imports, source-deletion guards, and
	// rollback so that ledger cannot appear between a survivor read and the
	// corresponding external status mutation.
	lease, err := acquireSubscriberBatchLease(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lease.Release()) }()

	var clientPrepared bool
	for {
		if !clientPrepared {
			if client == nil {
				return fmt.Errorf("reconcile external write intents: Listmonk client required")
			}
			if err := client.ValidateMigrationIsolation(tenantID); err != nil {
				return err
			}
			client = client.ForTenant(tenantID)
			client.invalidateListInventory()
			client.invalidateTemplateInventory()
			clientPrepared = true
		}
		for _, intent := range intents {
			if err := validateExternalWriteIntent(intent, tenantID, jobID); err != nil {
				return fmt.Errorf("external write intent %s is invalid: %w", intent.ID, err)
			}
			switch intent.ResourceType {
			case ResourceSubscriber:
				err = reconcileSubscriberIntent(ctx, client, db, intent)
			case ResourceList:
				err = reconcileAudienceIntent(ctx, client, db, intent)
			case ResourceTemplate:
				err = reconcileTemplateIntent(ctx, client, db, intent)
			default:
				err = fmt.Errorf("external write intent %s has unsupported resource type %q", intent.ID, intent.ResourceType)
			}
			if err != nil {
				return err
			}
		}
		intents, err = listExternalWriteIntentsBatch(ctx, db, tenantID, jobID, externalIntentReconciliationBatchSize)
		if err != nil || len(intents) == 0 {
			return err
		}
	}
}

func reconcileSubscriberIntent(ctx context.Context, client *Client, db *sql.DB, intent ExternalWriteIntent) error {
	var payload subscriberIntentPayload
	if err := json.Unmarshal(intent.Payload, &payload); err != nil ||
		strings.ToLower(strings.TrimSpace(payload.Email)) != intent.LookupKey ||
		len(payload.MutationSHA256) != sha256.Size*2 {
		return fmt.Errorf("reconcile subscriber intent %s: invalid mutation attestation", intent.IntentKey)
	}
	digest, err := hex.DecodeString(payload.MutationSHA256)
	if err != nil || len(digest) != sha256.Size || payload.MutationSHA256 != strings.ToLower(payload.MutationSHA256) {
		return fmt.Errorf("reconcile subscriber intent %s: invalid mutation attestation", intent.IntentKey)
	}
	subscriber, err := client.FindSubscriberByEmailForReconciliation(ctx, intent.LookupKey)
	if err != nil {
		return fmt.Errorf("reconcile subscriber intent %s: %w", intent.IntentKey, err)
	}
	if subscriber == nil {
		return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
	}
	if ownerJobID := attribString(subscriber.Attribs, "postwave_migration_job_id"); ownerJobID != intent.JobID {
		// Email is a natural key, so an existing row may be the pre-mutation
		// state or a concurrently changed former result. Without the exact
		// same-job marker there is no safe way to distinguish those cases or
		// reconstruct an update before-image. Keep the intent and fail closed.
		return fmt.Errorf("reconcile subscriber intent %s: existing destination has ambiguous migration ownership", intent.IntentKey)
	}
	if err := client.validateSubscriberOwnership(*subscriber); err != nil {
		return err
	}
	if err := validateSubscriberMigrationAfter(*subscriber); err != nil {
		return fmt.Errorf("reconcile subscriber intent %s: migration-owned destination changed: %w", intent.IntentKey, err)
	}
	outcome := UpsertOutcome(attribString(subscriber.Attribs, migrationOperationAttrib))
	if outcome != UpsertCreated && outcome != UpsertUpdated {
		return fmt.Errorf("reconcile subscriber intent %s: destination lacks safe create/update marker", intent.IntentKey)
	}
	if existing, err := FindImportedResourceByDestination(ctx, db, intent.TenantID, intent.JobID,
		ResourceSubscriber, DestinationListmonkSubscriber, strconv.Itoa(subscriber.ID)); err != nil {
		return err
	} else if existing != nil {
		return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
	}
	var before *SubscriberResponse
	if outcome == UpsertUpdated {
		original, err := subscriberSnapshotFromAttrib(subscriber.Attribs[migrationBeforeAttrib])
		if err != nil {
			return fmt.Errorf("reconcile subscriber intent %s: invalid before-image: %w", intent.IntentKey, err)
		}
		before = &original
	}
	source := canonical.Subscriber{
		Email:          subscriber.Email,
		SourcePlatform: intent.SourcePlatform,
		SourceID:       intent.SourceID,
	}
	resource := subscriberResource(intent.JobID, source, subscriber.ID, outcome, before, subscriber)
	resource.TenantID = intent.TenantID
	resource.DestinationMetadata["postwave_mirror_applied"] = false
	resource.DestinationMetadata["recovered_external_intent"] = true
	if err := RecordImportedResource(ctx, db, resource); err != nil {
		return err
	}
	return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
}

func reconcileAudienceIntent(ctx context.Context, client *Client, db *sql.DB, intent ExternalWriteIntent) error {
	var payload audienceIntentPayload
	if err := json.Unmarshal(intent.Payload, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		return fmt.Errorf("reconcile audience intent %s: invalid payload", intent.IntentKey)
	}
	ownership := newAudienceListOwnership(intent.TenantID, intent.JobID, intent.SourcePlatform, intent.SourceID, payload.Name)
	if ownership.name != intent.LookupKey {
		return fmt.Errorf("reconcile audience intent %s: deterministic lookup key mismatch", intent.IntentKey)
	}
	if existing, err := FindImportedResourceBySource(ctx, db, intent.TenantID, intent.JobID, ResourceList, intent.SourcePlatform, intent.SourceID); err != nil {
		return err
	} else if existing != nil {
		if err := validateAudienceLedgerOwnership(*existing, intent.TenantID, intent.JobID, intent.SourcePlatform, intent.SourceID, payload.Name, ownership.fingerprint); err != nil {
			return err
		}
		return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
	}
	list, err := client.FindListByName(ctx, intent.LookupKey)
	if err != nil {
		return err
	}
	if list == nil {
		return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
	}
	if err := ownership.validate(list); err != nil {
		return err
	}
	if _, err := persistAudienceMapping(ctx, db, intent.TenantID, intent.JobID, intent.SourcePlatform, intent.SourceID, payload.Name, list.ID); err != nil {
		return err
	}
	return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
}

func reconcileTemplateIntent(ctx context.Context, client *Client, db *sql.DB, intent ExternalWriteIntent) error {
	var payload templateIntentPayload
	if err := json.Unmarshal(intent.Payload, &payload); err != nil {
		return fmt.Errorf("reconcile template intent %s: invalid payload: %w", intent.IntentKey, err)
	}
	tpl := payload.Template
	if tpl.SourcePlatform != intent.SourcePlatform || tpl.HTML != "" ||
		len(payload.BodySHA256) != sha256.Size*2 || len(payload.OwnershipFingerprint) != sha256.Size*2 {
		return fmt.Errorf("reconcile template intent %s: source platform mismatch", intent.IntentKey)
	}
	if _, err := hex.DecodeString(payload.BodySHA256); err != nil {
		return fmt.Errorf("reconcile template intent %s: invalid body attestation", intent.IntentKey)
	}
	if _, err := hex.DecodeString(payload.OwnershipFingerprint); err != nil {
		return fmt.Errorf("reconcile template intent %s: invalid ownership attestation", intent.IntentKey)
	}
	lookupName := migrationScopedSourceName(tpl.Name, intent.JobID, intent.SourceID)
	if lookupName != intent.LookupKey {
		return fmt.Errorf("reconcile template intent %s: deterministic lookup key mismatch", intent.IntentKey)
	}
	if existing, err := FindImportedResourceBySource(ctx, db, intent.TenantID, intent.JobID, ResourceTemplate, intent.SourcePlatform, intent.SourceID); err != nil {
		return err
	} else if existing != nil {
		if err := validateTemplateLedgerOwnership(*existing, intent.TenantID, intent.JobID, intent.SourcePlatform, intent.SourceID, tpl.Name, payload.OwnershipFingerprint); err != nil {
			return err
		}
		return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
	}
	template, err := client.FindTemplateByName(ctx, intent.LookupKey)
	if err != nil {
		return err
	}
	if template == nil {
		return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
	}
	if template.ID <= 0 || template.Name != lookupName || template.Type != "campaign" {
		return fmt.Errorf("Listmonk template %q exists without this migration's exact job/source ownership", lookupName)
	}
	bodyDigest := sha256.Sum256([]byte(template.Body))
	if hex.EncodeToString(bodyDigest[:]) != payload.BodySHA256 {
		return fmt.Errorf("Listmonk template %q changed after the recorded migration mutation", lookupName)
	}
	resource := templateImportedResource(intent.TenantID, intent.JobID, tpl, intent.SourceID, template.ID, true, payload.OwnershipFingerprint)
	resource.DestinationMetadata["recovered_external_intent"] = true
	if err := RecordImportedResource(ctx, db, resource); err != nil {
		return err
	}
	return DeleteExternalWriteIntents(ctx, db, intent.TenantID, intent.JobID, intent)
}
