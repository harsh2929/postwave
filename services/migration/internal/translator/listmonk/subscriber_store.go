package listmonk

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/postwave/migrate/canonical"
)

var (
	ErrSubscriberErasureBlocked = errors.New("subscriber was previously erased and cannot be re-imported without fresh consent")
	ErrContactPlanLimitExceeded = errors.New("tenant contact plan limit exceeded")
	ErrRollbackConflict         = errors.New("migration rollback refused because destination state changed after import")
)

var contactLimitsByTier = map[string]int{
	"studio":  1_000,
	"sending": 10_000,
	"pro":     100_000,
}

// ImportedCustomFieldTypes returns the effective provider custom-field schema
// for one canonical subscriber. Provider provenance and reserved migration
// metadata are excluded. A nil value is reported as "unknown" so a later
// concrete value can define the field without a false string-type conflict.
func ImportedCustomFieldTypes(sub canonical.Subscriber) map[string]string {
	out := map[string]string{}
	for key, value := range subscriberMirrorFields(sub).MergeFields {
		key = strings.TrimSpace(key)
		if key == "" || strings.HasPrefix(key, "postwave_") {
			continue
		}
		if value == nil {
			out[key] = "unknown"
			continue
		}
		out[key] = inferCustomFieldType(value)
	}
	return out
}

// ValidateImportedCustomFieldPlan checks the complete dry-run schema against
// tenant strict/auto/off policy and registry capacity before any commit-stage
// destination mutation.
func ValidateImportedCustomFieldPlan(ctx context.Context, db *sql.DB, tenantID string, plan map[string]string) (err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("custom-field plan validation requires DB and tenant")
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	var maxFields int
	var mode string
	if err := tx.QueryRowContext(ctx, `
		SELECT max_custom_fields, COALESCE(NULLIF(custom_fields_mode, ''), 'auto')
		  FROM tenants WHERE id = $1::uuid FOR UPDATE
	`, tenantID).Scan(&maxFields, &mode); err != nil {
		return err
	}
	if mode == "off" {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT key, type FROM tenant_custom_fields WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		return err
	}
	definitions := map[string]string{}
	for rows.Next() {
		var key, fieldType string
		if err := rows.Scan(&key, &fieldType); err != nil {
			_ = rows.Close()
			return err
		}
		definitions[key] = fieldType
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	unknownCount := 0
	for key, plannedType := range plan {
		if plannedType == "unknown" {
			plannedType = "string"
		}
		if existingType, ok := definitions[key]; ok {
			if !customFieldTypesCompatible(existingType, plannedType) {
				return fmt.Errorf("custom field %q has registered type %s but dry-run observed %s", key, existingType, plannedType)
			}
			continue
		}
		if mode == "strict" {
			return fmt.Errorf("custom field %q is not declared and tenant custom_fields_mode is strict", key)
		}
		unknownCount++
	}
	if maxFields >= 0 && len(definitions)+unknownCount > maxFields {
		return fmt.Errorf("tenant custom-field limit exceeded by migration plan: current=%d new=%d limit=%d", len(definitions), unknownCount, maxFields)
	}
	return nil
}

// PrepareSubscriberForWrite performs destination policy checks before any
// external Listmonk mutation. It returns a copy whose status is forced to
// blocklisted when either Moosewave suppression store contains the email.
// plannedNew is used by dry-runs to account for earlier not-yet-written rows.
func PrepareSubscriberForWrite(ctx context.Context, db *sql.DB, tenantID string, sub canonical.Subscriber, plannedNew int) (prepared canonical.Subscriber, isNew bool, err error) {
	prepared = sub
	prepared = quarantineMailchimpWithoutConsentEvidence(prepared)
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return prepared, false, err
	}
	defer commitTx(tx, &err)
	if erased, checkErr := subscriberWasErasedTx(ctx, tx, tenantID, sub.Email); checkErr != nil {
		return prepared, false, checkErr
	} else if erased {
		return prepared, false, ErrSubscriberErasureBlocked
	}
	existingID, _, checkErr := subscriberBeforeImageTx(ctx, tx, tenantID, sub.Email)
	if checkErr != nil {
		return prepared, false, checkErr
	}
	isNew = existingID == ""
	if isNew {
		if checkErr := checkContactPlanLimitTx(ctx, tx, tenantID, plannedNew+1); checkErr != nil {
			return prepared, true, checkErr
		}
	}
	if suppressed, checkErr := subscriberSuppressedTx(ctx, tx, tenantID, sub.Email); checkErr != nil {
		return prepared, isNew, checkErr
	} else if suppressed {
		prepared.Status = canonical.StatusBlocklisted
	}
	return prepared, isNew, nil
}

// PrepareSubscriberBatchForWrite runs policy checks in one tenant transaction
// and scans the contact count once for the whole batch. It is used before any
// external Listmonk write; PersistSubscriberMirror still rechecks erasure and
// suppression, but can skip the quadratic per-row count scan.
func PrepareSubscriberBatchForWrite(ctx context.Context, db *sql.DB, tenantID string, subscribers []canonical.Subscriber, plannedNew int) (prepared []canonical.Subscriber, isNew []bool, err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return nil, nil, fmt.Errorf("subscriber batch preflight requires DB and tenant")
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer commitTx(tx, &err)
	current, limit, tier, err := contactPlanCapacityTx(ctx, tx, tenantID)
	if err != nil {
		return nil, nil, err
	}
	prepared = make([]canonical.Subscriber, len(subscribers))
	isNew = make([]bool, len(subscribers))
	newEmails := map[string]struct{}{}
	for i, subscriber := range subscribers {
		subscriber = quarantineMailchimpWithoutConsentEvidence(subscriber)
		if erased, checkErr := subscriberWasErasedTx(ctx, tx, tenantID, subscriber.Email); checkErr != nil {
			return nil, nil, checkErr
		} else if erased {
			return nil, nil, fmt.Errorf("preflight %q: %w", subscriber.Email, ErrSubscriberErasureBlocked)
		}
		existingID, _, checkErr := subscriberBeforeImageTx(ctx, tx, tenantID, subscriber.Email)
		if checkErr != nil {
			return nil, nil, checkErr
		}
		emailKey := strings.ToLower(strings.TrimSpace(subscriber.Email))
		if existingID == "" {
			if _, duplicate := newEmails[emailKey]; !duplicate {
				newEmails[emailKey] = struct{}{}
				isNew[i] = true
			}
		}
		if suppressed, checkErr := subscriberSuppressedTx(ctx, tx, tenantID, subscriber.Email); checkErr != nil {
			return nil, nil, checkErr
		} else if suppressed {
			subscriber.Status = canonical.StatusBlocklisted
		}
		prepared[i] = subscriber
	}
	if limit > 0 && current+plannedNew+len(newEmails) > limit {
		return nil, nil, fmt.Errorf("%w: tier=%s current=%d planned=%d batch_new=%d limit=%d", ErrContactPlanLimitExceeded, tier, current, plannedNew, len(newEmails), limit)
	}
	return prepared, isNew, nil
}

type subscriberSourceLedgerState struct {
	JobID          string
	SourcePlatform canonical.SourcePlatform
	SourceID       string
	Metadata       map[string]interface{}
}

// guardSourceSnapshotDeletionCandidates marks the current job's source
// snapshot absent and returns only destinations with no other active durable
// source identity. The caller must hold the tenant subscriber batch lease for
// the entire guard + external write sequence; that is what prevents another
// migration job from inserting a survivor between this read and the disable.
func guardSourceSnapshotDeletionCandidates(ctx context.Context, db *sql.DB, tenantID, jobID string, candidates []SourceSnapshotDeletionCandidate) (allowed []canonical.Subscriber, reconciliations []*subscriberProjectionReconciliation, protected int, err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return nil, nil, 0, fmt.Errorf("source snapshot deletion guard requires DB, tenant, and job")
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return nil, nil, 0, err
	}
	defer commitTx(tx, &err)

	allowed = make([]canonical.Subscriber, 0, len(candidates))
	for _, candidate := range candidates {
		subscriber := candidate.Subscriber
		if candidate.DestinationType != DestinationListmonkSubscriber || strings.TrimSpace(candidate.DestinationID) == "" {
			return nil, nil, 0, fmt.Errorf("source snapshot deletion guard requires an exact Listmonk destination identity")
		}
		if strings.TrimSpace(subscriber.Email) == "" || strings.TrimSpace(subscriber.SourceID) == "" || subscriber.SourcePlatform == "" || subscriber.Status != canonical.StatusDisabled {
			return nil, nil, 0, fmt.Errorf("source snapshot deletion guard requires a disabled subscriber with stable source identity")
		}

		result, updateErr := tx.ExecContext(ctx, `
			UPDATE migration_imported_resources
			   SET destination_metadata = jsonb_set(
			       COALESCE(destination_metadata, '{}'::jsonb),
			       '{postwave_source_snapshot_present}', 'false'::jsonb, true)
			 WHERE tenant_id = $1::uuid AND job_id = $2::uuid
			   AND resource_type = 'subscriber' AND destination_type = $3
			   AND destination_id = $4 AND rolled_back_at IS NULL
		`, tenantID, jobID, candidate.DestinationType, candidate.DestinationID)
		if updateErr != nil {
			return nil, nil, 0, fmt.Errorf("mark source subscriber ledger absent: %w", updateErr)
		}
		updated, updateErr := result.RowsAffected()
		if updateErr != nil {
			return nil, nil, 0, fmt.Errorf("inspect source subscriber ledger absence update: %w", updateErr)
		}
		if updated != 1 {
			return nil, nil, 0, fmt.Errorf("source snapshot deletion guard found %d current-job ledgers for destination %s; want exactly one", updated, candidate.DestinationID)
		}

		rows, queryErr := tx.QueryContext(ctx, `
			SELECT job_id::text, source_platform, COALESCE(source_id, ''), destination_metadata
			  FROM migration_imported_resources
			 WHERE tenant_id = $1::uuid AND resource_type = 'subscriber'
			   AND destination_type = $2 AND destination_id = $3
			   AND rolled_back_at IS NULL
			 ORDER BY job_id
			 FOR UPDATE
		`, tenantID, candidate.DestinationType, candidate.DestinationID)
		if queryErr != nil {
			return nil, nil, 0, fmt.Errorf("load tenant subscriber ownership ledgers: %w", queryErr)
		}
		ledgers := make([]subscriberSourceLedgerState, 0, 2)
		activeProjectionSet := newSubscriberProjectionSet()
		retiringIdentityKey := subscriberSourceIdentityKey(subscriber.SourcePlatform, subscriber.SourceID)
		for rows.Next() {
			var state subscriberSourceLedgerState
			var sourcePlatform string
			var raw []byte
			if scanErr := rows.Scan(&state.JobID, &sourcePlatform, &state.SourceID, &raw); scanErr != nil {
				_ = rows.Close()
				return nil, nil, 0, fmt.Errorf("scan tenant subscriber ownership ledger: %w", scanErr)
			}
			state.SourcePlatform = canonical.SourcePlatform(strings.TrimSpace(sourcePlatform))
			if unmarshalErr := json.Unmarshal(raw, &state.Metadata); unmarshalErr != nil {
				_ = rows.Close()
				return nil, nil, 0, fmt.Errorf("decode tenant subscriber ownership ledger: %w", unmarshalErr)
			}
			if present, explicit := state.Metadata["postwave_source_snapshot_present"].(bool); !explicit || present {
				projections, projectionErr := subscriberProjectionsFromMetadata(state.Metadata)
				if projectionErr != nil {
					_ = rows.Close()
					return nil, nil, 0, fmt.Errorf("validate active subscriber projection ledger %q while streaming deletion guard: %w", state.JobID, projectionErr)
				}
				for key, projection := range projections {
					if key == retiringIdentityKey {
						continue
					}
					if projectionErr := activeProjectionSet.add(key, projection); projectionErr != nil {
						_ = rows.Close()
						return nil, nil, 0, fmt.Errorf("active subscriber projection bound exceeded while streaming deletion guard: %w", projectionErr)
					}
				}
			}
			ledgers = append(ledgers, state)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return nil, nil, 0, fmt.Errorf("read tenant subscriber ownership ledgers: %w", rowsErr)
		}
		if closeErr := rows.Close(); closeErr != nil {
			return nil, nil, 0, fmt.Errorf("close tenant subscriber ownership ledgers: %w", closeErr)
		}
		var retiringLedger *subscriberSourceLedgerState
		for i := range ledgers {
			if ledgers[i].JobID == jobID {
				retiringLedger = &ledgers[i]
				break
			}
		}
		if retiringLedger == nil || !metadataBool(retiringLedger.Metadata, "postwave_source_identity_owned") {
			return nil, nil, 0, fmt.Errorf("source snapshot deletion refuses authoritative disable because the retiring ledger does not own the destination subscriber identity")
		}

		hasSurvivor, survivorErr := subscriberDeletionHasActiveSourceSurvivor(subscriber, ledgers)
		if survivorErr != nil {
			return nil, nil, 0, survivorErr
		}
		if hasSurvivor {
			reconciliation, reconcileErr := buildSubscriberProjectionReconciliation(candidate, jobID, ledgers)
			if reconcileErr != nil {
				return nil, nil, 0, fmt.Errorf("reconcile shared subscriber %q after source deletion: %w", subscriber.Email, reconcileErr)
			}
			if reconciliation == nil {
				return nil, nil, 0, fmt.Errorf("shared subscriber %q had an active survivor but no exact projection reconciliation", subscriber.Email)
			}
			reconciliations = append(reconciliations, reconciliation)
			protected++
			continue
		}
		allowed = append(allowed, subscriber)
	}
	return allowed, reconciliations, protected, nil
}

func subscriberDeletionHasActiveSourceSurvivor(candidate canonical.Subscriber, ledgers []subscriberSourceLedgerState) (bool, error) {
	email := strings.ToLower(strings.TrimSpace(candidate.Email))
	sourceID := strings.TrimSpace(candidate.SourceID)
	if email == "" || sourceID == "" || candidate.SourcePlatform == "" {
		return false, fmt.Errorf("source snapshot deletion candidate has incomplete identity")
	}
	if len(ledgers) == 0 {
		return false, fmt.Errorf("source snapshot deletion has no durable destination ownership ledger")
	}
	for _, ledger := range ledgers {
		if ledger.SourcePlatform == "" {
			return false, fmt.Errorf("subscriber ownership ledger %q has no source platform", ledger.JobID)
		}
		if ledgerEmail, _ := ledger.Metadata["email"].(string); strings.TrimSpace(ledgerEmail) != "" && !strings.EqualFold(strings.TrimSpace(ledgerEmail), email) {
			return false, fmt.Errorf("subscriber ownership ledger %q destination email does not match deletion candidate", ledger.JobID)
		}
		if present, explicit := ledger.Metadata["postwave_source_snapshot_present"].(bool); explicit && !present {
			continue
		}
		ids := unionMetadataStrings([]string{ledger.SourceID}, metadataStringSlice(ledger.Metadata["source_ids"]))
		if len(ids) == 0 {
			return false, fmt.Errorf("subscriber ownership ledger %q has no source identity", ledger.JobID)
		}
		for _, ledgerSourceID := range ids {
			if ledger.SourcePlatform == candidate.SourcePlatform && strings.TrimSpace(ledgerSourceID) == sourceID {
				continue
			}
			return true, nil
		}
	}
	return false, nil
}

// PersistSubscriberMirror upserts the tenant-scoped Moosewave subscriber,
// materializes list memberships, writes consent/audit evidence, and stores the
// before-images required for rollback in the same transaction.
func PersistSubscriberMirror(ctx context.Context, db *sql.DB, resource ImportedResource, sub canonical.Subscriber, audiences map[string]AudienceMapping, capacityPrevalidated ...bool) (err error) {
	return persistSubscriberMirror(ctx, db, resource, sub, audiences, false, false, false, capacityPrevalidated...)
}

func persistSubscriberMirror(ctx context.Context, db *sql.DB, resource ImportedResource, sub canonical.Subscriber, audiences map[string]AudienceMapping, authoritativeStatus, authoritativeTags, authoritativeFields bool, capacityPrevalidated ...bool) (err error) {
	return persistSubscriberMirrorWithSourceIdentityTransfer(ctx, db, resource, sub, audiences, authoritativeStatus, authoritativeTags, authoritativeFields, "", nil, capacityPrevalidated...)
}

func persistSubscriberMirrorWithSourceIdentityTransfer(ctx context.Context, db *sql.DB, resource ImportedResource, sub canonical.Subscriber, audiences map[string]AudienceMapping, authoritativeStatus, authoritativeTags, authoritativeFields bool, transferSourceFrom string, projectionReconcile *subscriberProjectionReconciliation, capacityPrevalidated ...bool) (err error) {
	if db == nil || resource.TenantID == "" || resource.JobID == "" {
		return fmt.Errorf("persist subscriber mirror: DB, tenant, and job are required")
	}
	if resource.DestinationType != DestinationListmonkSubscriber || resource.DestinationID == "" {
		return fmt.Errorf("persist subscriber mirror: tracked Listmonk subscriber required")
	}
	if strings.TrimSpace(sub.Email) == "" {
		return fmt.Errorf("persist subscriber mirror: email required")
	}
	if resource.DestinationMetadata == nil {
		resource.DestinationMetadata = map[string]interface{}{}
	}
	if _, present := resource.DestinationMetadata[subscriberSourceProjectionsMetadataKey]; !present {
		if projectionReconcile != nil {
			return fmt.Errorf("persist subscriber mirror: shared-source reconciliation requires the exact primary survivor projection")
		}
		projection, projectionErr := newSubscriberSourceProjection(sub, audiences)
		if projectionErr != nil {
			return fmt.Errorf("persist subscriber mirror source projection: %w", projectionErr)
		}
		for key, value := range subscriberProjectionMetadata(projection) {
			resource.DestinationMetadata[key] = value
		}
	} else if _, projectionErr := subscriberProjectionsFromMetadata(resource.DestinationMetadata); projectionErr != nil {
		return fmt.Errorf("persist subscriber mirror source projection: %w", projectionErr)
	}

	tx, err := beginTenantTx(ctx, db, resource.TenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	// A SELECT ... FOR UPDATE cannot lock an absent email key. Serialize the
	// before-image decision across jobs so a concurrent insert cannot turn this
	// transaction into an update while its rollback metadata still says
	// "created" with no before-image.
	lockKey := migrationOwnershipFingerprint(
		"migration-subscriber-lock",
		resource.TenantID,
		strings.ToLower(strings.TrimSpace(sub.Email)),
	)
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, lockKey); err != nil {
		return fmt.Errorf("lock subscriber rollback identity: %w", err)
	}

	if erased, err := subscriberWasErasedTx(ctx, tx, resource.TenantID, sub.Email); err != nil {
		return err
	} else if erased {
		return ErrSubscriberErasureBlocked
	}

	existingID, before, err := subscriberBeforeImageTx(ctx, tx, resource.TenantID, sub.Email)
	if err != nil {
		return err
	}
	if existingID == "" && !(len(capacityPrevalidated) > 0 && capacityPrevalidated[0]) {
		if err := checkContactPlanLimitTx(ctx, tx, resource.TenantID, 1); err != nil {
			return err
		}
	}
	previousMetadata, err := importedResourceMetadataByDestinationTx(ctx, tx, resource)
	if err != nil {
		return err
	}
	sameSourceIdentity := subscriberSnapshotSourceMatches(before, sub)
	sameStatusSourceIdentity := sameSourceIdentity || subscriberTrackedSourceMatches(before, previousMetadata, sub)
	transferSourceFrom = strings.TrimSpace(transferSourceFrom)
	transferSourceIdentity := false
	var retiringMetadata map[string]interface{}
	var retiringJobID string
	if transferSourceFrom != "" {
		beforePlatform, _ := before["source_platform"].(string)
		beforeSourceID, _ := before["source_id"].(string)
		transferSourceIdentity = authoritativeStatus && authoritativeTags && authoritativeFields &&
			previousMetadata != nil && metadataBool(previousMetadata, "postwave_source_identity_owned") &&
			strings.EqualFold(strings.TrimSpace(beforePlatform), strings.TrimSpace(string(sub.SourcePlatform))) &&
			strings.TrimSpace(beforeSourceID) == transferSourceFrom &&
			subscriberTrackedSourceMatches(before, previousMetadata, sub)
		if !transferSourceIdentity && projectionReconcile != nil {
			validated, reconcileErr := validateSubscriberProjectionReconciliationTx(ctx, tx, resource, sub, transferSourceFrom, projectionReconcile)
			if reconcileErr != nil {
				return reconcileErr
			}
			retiringMetadata = validated.RetiringMetadata
			retiringJobID = validated.RetiringJobID
			transferSourceIdentity = true
		}
		if !transferSourceIdentity {
			return fmt.Errorf("subscriber source-identity transfer from %q to %q is not proven by the locked source-owned ledger", transferSourceFrom, sub.SourceID)
		}
	}
	sameSnapshotSourceIdentity := sameSourceIdentity || transferSourceIdentity
	previousOwnedTagIDs := []string(nil)
	if authoritativeTags && sameSnapshotSourceIdentity && previousMetadata != nil {
		previousOwnedTagIDs = metadataStringSlice(previousMetadata["postwave_tag_joins_created"])
		if retiringMetadata != nil {
			previousOwnedTagIDs = unionMetadataStrings(previousOwnedTagIDs, retiringMetadata["postwave_tag_joins_created"])
		}
	}
	previousOwnedFieldKeys := []string(nil)
	if authoritativeFields && sameSnapshotSourceIdentity && previousMetadata != nil {
		previousOwnedFieldKeys = metadataStringSlice(previousMetadata["postwave_source_field_keys"])
		if retiringMetadata != nil {
			previousOwnedFieldKeys = unionMetadataStrings(previousOwnedFieldKeys, retiringMetadata["postwave_source_field_keys"])
			if projectionReconcile.Candidate.Subscriber.SourcePlatform == canonical.SourceBeehiiv {
				// Beehiiv provenance is intentionally excluded from tenant targeting
				// field ownership, but a primary-source retirement must still replace
				// or remove the retiring publication's provider blob.
				previousOwnedFieldKeys = unionMetadataStrings(previousOwnedFieldKeys, []string{"beehiiv"})
			}
		}
	}
	if previousOwnedTagIDs == nil {
		previousOwnedTagIDs = []string{}
	}
	if previousOwnedFieldKeys == nil {
		previousOwnedFieldKeys = []string{}
	}
	sourceIdentityOwned := existingID == "" || sameSourceIdentity || transferSourceIdentity
	if previousMetadata != nil && !transferSourceIdentity {
		sourceIdentityOwned = metadataBool(previousMetadata, "postwave_source_identity_owned")
	}
	allowSourceIdentityConsent := !authoritativeFields || sourceIdentityOwned
	if projectionReconcile != nil && defensibleImportedConsentAt(sub, string(sub.Status), subscriberMirrorFields(sub).MailchimpStatus) == nil {
		allowSourceIdentityConsent = false
	}

	sub = quarantineMailchimpWithoutConsentEvidence(sub)
	fields := subscriberMirrorFields(sub)
	suppressed, err := subscriberSuppressedTx(ctx, tx, resource.TenantID, sub.Email)
	if err != nil {
		return err
	}
	if suppressed {
		fields.Status = string(canonical.StatusBlocklisted)
	}

	candidateSourceFieldKeys := make([]string, 0, len(fields.MergeFields))
	for key := range fields.MergeFields {
		if key = strings.TrimSpace(key); key != "" {
			candidateSourceFieldKeys = append(candidateSourceFieldKeys, key)
		}
	}
	sort.Strings(candidateSourceFieldKeys)
	sourceFieldKeys := candidateSourceFieldKeys
	if authoritativeFields {
		sourceFieldKeys = sourceOwnedSubscriberFieldKeys(before, previousOwnedFieldKeys, candidateSourceFieldKeys, existingID == "")
	}
	persistedCustomFields := cloneMetadata(sub.CustomFields)
	if authoritativeFields {
		owned := make(map[string]struct{}, len(sourceFieldKeys))
		for _, key := range sourceFieldKeys {
			owned[key] = struct{}{}
		}
		for key := range persistedCustomFields {
			if _, ok := owned[key]; !ok && !(sub.SourcePlatform == canonical.SourceBeehiiv && key == "beehiiv") {
				delete(persistedCustomFields, key)
			}
		}
	}
	customRaw, _ := json.Marshal(persistedCustomFields)
	fieldOwnershipTransition := mergeStringUnion(previousOwnedFieldKeys, sourceFieldKeys)
	allowFirstName := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "first_name", "firstname", "fname")
	allowLastName := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "last_name", "lastname", "lname")
	allowFullName := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "name", "full_name", "fullname", "first_name", "firstname", "fname", "last_name", "lastname", "lname")
	allowDisplayName := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "display_name", "name", "full_name", "fullname", "first_name", "firstname", "fname", "last_name", "lastname", "lname")
	allowLocale := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "locale", "language", "country", "country_code")
	allowLanguage := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "language")
	allowCountry := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "country", "country_code")
	allowRegion := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "region", "state", "province")
	allowTimezone := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "timezone", "time_zone")
	allowRating := !authoritativeFields || containsSubscriberFieldKey(fieldOwnershipTransition, "rating", "member_rating")
	previousOwnedFieldKeysRaw, _ := json.Marshal(previousOwnedFieldKeys)
	mergeRaw, _ := json.Marshal(fields.MergeFields)
	groupsRaw, _ := json.Marshal(fields.Groups)
	gdprRaw, _ := json.Marshal(fields.GDPRPermissions)
	activityRaw, _ := json.Marshal(fields.ActivitySummary)
	consentMarketingAt := defensibleImportedConsentAt(sub, fields.Status, fields.MailchimpStatus)

	var subscriberID, finalStatus string
	// subscribers.tags is deliberately absent from this upsert. Since migration
	// 1774, subscriber_tags is canonical and the array is a trigger-maintained
	// projection: an array write makes the reconcile trigger create the joins
	// itself (labelled legacy_array_writer), so syncSubscriberTagsTx would never
	// see its own inserts land and would record no migration-owned joins. A
	// later authoritative delta could then not remove stale source tags, and
	// rollback could not find what this import created. Tags are written only
	// through the canonical joins below; the projection triggers rebuild the
	// array in the same transaction.
	err = tx.QueryRowContext(ctx, `
		INSERT INTO subscribers (
			tenant_id, email, primary_email, status, consent_timestamp, consent_source,
			custom_fields, source_id, source_platform, mailchimp_status,
			merge_fields, groups, gdpr_permissions, signup_ip, unsubscribe_reason,
			mailchimp_last_changed, activity_summary, consent_email_marketing_at,
			first_name, last_name, full_name, display_name,
			locale, language, country, region, timezone, rating
		)
		VALUES (
			$1::uuid, $2, $2, $3, $4, $5, $6::jsonb,
			NULLIF($7, ''), NULLIF($8, ''),
			$9, $10::jsonb, $11::jsonb, $12::jsonb, NULLIF($13, '')::inet,
			NULLIF($14, ''), NULLIF($15, '')::timestamptz, $16::jsonb, $17,
			$18, $19, $20, $21,
			NULLIF($22, ''), NULLIF($23, ''), NULLIF($24, ''), NULLIF($25, ''), NULLIF($26, ''), $27
		)
		ON CONFLICT (tenant_id, email) DO UPDATE SET
			status = CASE
				WHEN $41::boolean THEN EXCLUDED.status
				WHEN subscribers.status = 'blocklisted' OR EXCLUDED.status = 'blocklisted' THEN 'blocklisted'
				WHEN subscribers.status = 'disabled' OR EXCLUDED.status = 'disabled' THEN 'disabled'
				WHEN subscribers.status = 'unconfirmed' OR EXCLUDED.status = 'unconfirmed' THEN 'unconfirmed'
				ELSE 'enabled'
			END,
			consent_timestamp = CASE
				WHEN $40::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)
					THEN COALESCE(EXCLUDED.consent_timestamp, subscribers.consent_timestamp)
				ELSE COALESCE(subscribers.consent_timestamp, EXCLUDED.consent_timestamp)
			END,
			consent_source = CASE
				WHEN $40::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)
					THEN EXCLUDED.consent_source
				WHEN NOT $40::boolean AND COALESCE(subscribers.consent_source, '') <> ''
					THEN subscribers.consent_source
				WHEN subscribers.consent_timestamp IS NOT NULL THEN subscribers.consent_source
				ELSE EXCLUDED.consent_source
			END,
			consent_email_marketing_at = CASE
				WHEN subscribers.status = 'enabled' AND EXCLUDED.status = 'enabled'
					THEN COALESCE(subscribers.consent_email_marketing_at, EXCLUDED.consent_email_marketing_at)
				ELSE NULL
			END,
			custom_fields = CASE
				WHEN $29::boolean
					AND ((subscribers.source_platform = EXCLUDED.source_platform
					AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)
				THEN (subscribers.custom_fields - ARRAY(SELECT jsonb_array_elements_text($28::jsonb))) || EXCLUDED.custom_fields
				ELSE subscribers.custom_fields || EXCLUDED.custom_fields
			END,
			source_id = CASE WHEN $42::boolean THEN EXCLUDED.source_id ELSE COALESCE(subscribers.source_id, EXCLUDED.source_id) END,
			source_platform = CASE WHEN $42::boolean THEN EXCLUDED.source_platform ELSE COALESCE(subscribers.source_platform, EXCLUDED.source_platform) END,
			mailchimp_status = CASE
				WHEN EXCLUDED.source_platform <> 'mailchimp' THEN subscribers.mailchimp_status
				WHEN subscribers.source_platform <> 'mailchimp' THEN EXCLUDED.mailchimp_status
				WHEN (CASE subscribers.mailchimp_status
					WHEN 'cleaned' THEN 90 WHEN 'unsubscribed' THEN 80 WHEN 'transactional' THEN 79
					WHEN 'archived' THEN 78 WHEN 'deleted' THEN 77 WHEN 'pending' THEN 60
					WHEN 'non_subscribed' THEN 59 WHEN 'subscribed' THEN 10 ELSE 20 END)
					>= (CASE EXCLUDED.mailchimp_status
					WHEN 'cleaned' THEN 90 WHEN 'unsubscribed' THEN 80 WHEN 'transactional' THEN 79
					WHEN 'archived' THEN 78 WHEN 'deleted' THEN 77 WHEN 'pending' THEN 60
					WHEN 'non_subscribed' THEN 59 WHEN 'subscribed' THEN 10 ELSE 20 END)
					THEN subscribers.mailchimp_status
				ELSE EXCLUDED.mailchimp_status
			END,
			merge_fields = CASE WHEN EXCLUDED.source_platform = 'mailchimp' THEN subscribers.merge_fields || EXCLUDED.merge_fields ELSE subscribers.merge_fields END,
			groups = CASE WHEN EXCLUDED.source_platform = 'mailchimp' THEN (
				SELECT COALESCE(jsonb_agg(group_item ORDER BY audience_id, category_id, source_id), '[]'::jsonb)
				  FROM (
					SELECT DISTINCT ON (audience_id, category_id, source_id)
					       group_item, audience_id, category_id, source_id
					  FROM (
						SELECT item AS group_item,
						       COALESCE(item ->> 'audience_id', '') AS audience_id,
						       COALESCE(item ->> 'category_id', item ->> 'category', '') AS category_id,
						       COALESCE(item ->> 'source_id', item ->> 'id', item ->> 'name', '') AS source_id,
						       ordinality
						  FROM jsonb_array_elements(subscribers.groups || EXCLUDED.groups) WITH ORDINALITY AS evidence(item, ordinality)
					  ) candidates
					 ORDER BY audience_id, category_id, source_id, ordinality DESC
				  ) merged_groups
			) ELSE subscribers.groups END,
			gdpr_permissions = CASE WHEN EXCLUDED.source_platform = 'mailchimp' THEN (
				SELECT COALESCE(jsonb_agg(permission ORDER BY audience_id, permission_id), '[]'::jsonb)
				  FROM (
					SELECT DISTINCT ON (audience_id, permission_id)
					       permission, audience_id, permission_id
					  FROM (
						SELECT item AS permission,
						       COALESCE(item ->> 'audience_id', '') AS audience_id,
						       COALESCE(item ->> 'marketing_permission_id', item ->> 'id', item ->> 'text', item::text) AS permission_id,
						       ordinality
						  FROM jsonb_array_elements(subscribers.gdpr_permissions || EXCLUDED.gdpr_permissions) WITH ORDINALITY AS evidence(item, ordinality)
					  ) candidates
					 ORDER BY audience_id, permission_id, ordinality DESC
				  ) merged_permissions
			) ELSE subscribers.gdpr_permissions END,
			signup_ip = COALESCE(EXCLUDED.signup_ip, subscribers.signup_ip),
			unsubscribe_reason = COALESCE(EXCLUDED.unsubscribe_reason, subscribers.unsubscribe_reason),
			mailchimp_last_changed = COALESCE(EXCLUDED.mailchimp_last_changed, subscribers.mailchimp_last_changed),
			activity_summary = CASE WHEN EXCLUDED.source_platform = 'mailchimp' THEN subscribers.activity_summary || EXCLUDED.activity_summary ELSE subscribers.activity_summary END,
			first_name = CASE WHEN subscribers.first_name = '' OR ($30::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.first_name ELSE subscribers.first_name END,
			last_name = CASE WHEN subscribers.last_name = '' OR ($31::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.last_name ELSE subscribers.last_name END,
			full_name = CASE WHEN subscribers.full_name = '' OR ($32::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.full_name ELSE subscribers.full_name END,
			display_name = CASE WHEN subscribers.display_name = '' OR ($33::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.display_name ELSE subscribers.display_name END,
			locale = CASE WHEN subscribers.locale IS NULL OR ($34::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.locale ELSE subscribers.locale END,
			language = CASE WHEN subscribers.language IS NULL OR ($35::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.language ELSE subscribers.language END,
			country = CASE WHEN subscribers.country IS NULL OR ($36::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.country ELSE subscribers.country END,
			region = CASE WHEN subscribers.region IS NULL OR ($37::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.region ELSE subscribers.region END,
			timezone = CASE WHEN subscribers.timezone IS NULL OR ($38::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.timezone ELSE subscribers.timezone END,
			rating = CASE WHEN subscribers.rating IS NULL OR ($39::boolean AND ((subscribers.source_platform = EXCLUDED.source_platform AND subscribers.source_id = EXCLUDED.source_id) OR $42::boolean)) THEN EXCLUDED.rating ELSE subscribers.rating END,
			updated_at = now()
		RETURNING id::text, status
	`, resource.TenantID, sub.Email, fields.Status, sub.ConsentTimestamp, normalizedConsentSource(sub.ConsentSource),
		string(customRaw), sub.SourceID, string(sub.SourcePlatform), fields.MailchimpStatus,
		string(mergeRaw), string(groupsRaw), string(gdprRaw), fields.SignupIP, fields.UnsubscribeReason,
		fields.LastChanged, string(activityRaw), consentMarketingAt,
		fields.FirstName, fields.LastName, fields.FullName, fields.DisplayName,
		fields.Locale, fields.Language, fields.Country, fields.Region, fields.Timezone, fields.Rating,
		string(previousOwnedFieldKeysRaw), authoritativeFields,
		allowFirstName, allowLastName, allowFullName, allowDisplayName, allowLocale,
		allowLanguage, allowCountry, allowRegion, allowTimezone, allowRating,
		allowSourceIdentityConsent, authoritativeStatus && sameStatusSourceIdentity, transferSourceIdentity).Scan(&subscriberID, &finalStatus)
	if err != nil {
		return fmt.Errorf("persist Moosewave subscriber %q: %w", sub.Email, err)
	}
	customFieldRegistryCreated, err := registerImportedCustomFieldsTx(ctx, tx, resource.TenantID, fields.MergeFields)
	if err != nil {
		return err
	}

	membershipCreated, membershipBefore, membershipTouched, err := persistAudienceMembershipsTx(ctx, tx, resource, sub, subscriberID, audiences)
	if err != nil {
		return err
	}
	if retiringMetadata != nil {
		transferredCreated, transferredBefore, reconcileErr := reconcileRetiringSubscriberMembershipsTx(ctx, tx, resource, sub, subscriberID, retiringJobID, retiringMetadata, membershipTouched)
		if reconcileErr != nil {
			return reconcileErr
		}
		membershipCreated = unionMetadataStrings(membershipCreated, transferredCreated)
		membershipBefore = unionMetadataObjectsByID(membershipBefore, transferredBefore)
	}
	tagJoinsCreated, tagRegistryCreated, err := syncSubscriberTagsTx(ctx, tx, resource.TenantID, subscriberID, sub.Tags, previousOwnedTagIDs, authoritativeTags && sameSnapshotSourceIdentity)
	if err != nil {
		return err
	}
	groupMembershipsCreated, groupRegistryCreated, err := syncSubscriberGroupsTx(ctx, tx, resource.TenantID, subscriberID, fields.Groups)
	if err != nil {
		return err
	}
	if retiringMetadata != nil {
		if len(metadataStringSlice(retiringMetadata["postwave_group_memberships_created"])) > 0 || len(metadataStringSlice(retiringMetadata["postwave_group_registry_created"])) > 0 {
			return fmt.Errorf("subscriber projection reconciliation cannot safely retire provider group ownership")
		}
		if err := cleanupRetiringSubscriberRegistriesTx(ctx, tx, resource.TenantID, retiringMetadata); err != nil {
			return err
		}
	}

	metadata := cloneMetadata(resource.DestinationMetadata)
	metadata["postwave_subscriber_id"] = subscriberID
	if existingID == "" {
		metadata["postwave_operation"] = "created"
	} else {
		metadata["postwave_operation"] = "updated"
		metadata["postwave_before"] = before
	}
	metadata["postwave_membership_created"] = membershipCreated
	metadata["postwave_membership_before"] = membershipBefore
	metadata["postwave_tag_joins_created"] = tagJoinsCreated
	metadata["postwave_tag_registry_created"] = tagRegistryCreated
	metadata["postwave_group_memberships_created"] = groupMembershipsCreated
	metadata["postwave_group_registry_created"] = groupRegistryCreated
	metadata["postwave_custom_field_registry_created"] = customFieldRegistryCreated
	metadata["postwave_source_field_keys"] = sourceFieldKeys
	metadata["postwave_source_identity_owned"] = sourceIdentityOwned
	metadata["source_ids"] = []string{sub.SourceID}
	if retiringMetadata != nil {
		metadata["postwave_shared_source_reconciliation"] = true
		metadata[subscriberSharedBaselinePresentMetadataKey] = projectionReconcile.BaselineStatusPresent
		if projectionReconcile.BaselineStatusPresent {
			metadata[subscriberSharedBaselineStatusMetadataKey] = string(projectionReconcile.BaselineStatus)
		} else {
			delete(metadata, subscriberSharedBaselineStatusMetadataKey)
		}
		metadata["postwave_retired_source_identity_keys"] = unionMetadataStrings(
			metadata["postwave_retired_source_identity_keys"],
			[]string{subscriberSourceIdentityKey(projectionReconcile.Candidate.Subscriber.SourcePlatform, projectionReconcile.Candidate.Subscriber.SourceID)},
		)
		metadata["postwave_tag_registry_created"] = unionMetadataStrings(metadata["postwave_tag_registry_created"], retiringMetadata["postwave_tag_registry_created"])
		metadata["postwave_custom_field_registry_created"] = unionMetadataStrings(metadata["postwave_custom_field_registry_created"], retiringMetadata["postwave_custom_field_registry_created"])
	}

	if previousMetadata != nil {
		metadata = mergeSubscriberTrackingMetadata(previousMetadata, metadata, authoritativeTags && sameSnapshotSourceIdentity, authoritativeFields && sameSnapshotSourceIdentity)
	}
	if transferSourceIdentity {
		// Ownership is current control state, not cumulative rollback evidence.
		// Only a proven transfer may promote a non-owner survivor ledger.
		metadata["postwave_source_identity_owned"] = true
		if projectionReconcile != nil {
			metadata[subscriberSharedBaselinePresentMetadataKey] = projectionReconcile.BaselineStatusPresent
			if projectionReconcile.BaselineStatusPresent {
				metadata[subscriberSharedBaselineStatusMetadataKey] = string(projectionReconcile.BaselineStatus)
			} else {
				delete(metadata, subscriberSharedBaselineStatusMetadataKey)
			}
		}
	}
	if _, err := subscriberProjectionsFromMetadata(metadata); err != nil {
		return fmt.Errorf("persist bounded subscriber source projections: %w", err)
	}
	after, err := subscriberMirrorStateTx(ctx, tx, resource.TenantID, subscriberID, sub.Email, metadata)
	if err != nil {
		return fmt.Errorf("capture Moosewave subscriber after-image: %w", err)
	}
	metadata["postwave_after"] = after
	consentSourceIDs := metadataStringSlice(metadata["consent_event_source_ids"])
	if !containsMetadataString(consentSourceIDs, sub.SourceID) {
		if err := recordImportedConsentTx(ctx, tx, resource, sub, subscriberID, fields.ConsentProof); err != nil {
			return err
		}
		metadata["consent_event_recorded"] = true
		metadata["consent_event_source_ids"] = unionMetadataStrings(consentSourceIDs, []string{sub.SourceID})
		// Consent/activity rows are compliance audit evidence. Rollback retains
		// them and appends a compensating migration_rollback event instead of
		// erasing the historical record.
		metadata["audit_evidence_retention"] = "append_only_with_compensating_rollback_event"
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO contact_activity (tenant_id, subscriber_email, activity_type, metadata, source, at)
			VALUES ($1::uuid, $2, 'imported', jsonb_build_object('job_id', $3::text, 'source_id', $4::text), $5, now())
		`, resource.TenantID, sub.Email, resource.JobID, sub.SourceID, string(sub.SourcePlatform)); err != nil {
			return fmt.Errorf("record subscriber import activity: %w", err)
		}
	}
	resource.DestinationMetadata = metadata
	return recordImportedResourceTx(ctx, tx, resource)
}

type mirrorFields struct {
	Status            string
	MailchimpStatus   string
	MergeFields       map[string]interface{}
	Groups            []map[string]interface{}
	GDPRPermissions   interface{}
	SignupIP          string
	UnsubscribeReason string
	LastChanged       string
	ActivitySummary   map[string]interface{}
	ConsentProof      map[string]interface{}
	FirstName         string
	LastName          string
	FullName          string
	DisplayName       string
	Locale            string
	Language          string
	Country           string
	Region            string
	Timezone          string
	Rating            interface{}
}

func subscriberMirrorFields(sub canonical.Subscriber) mirrorFields {
	f := mirrorFields{
		Status:          string(sub.Status),
		MailchimpStatus: canonicalStatusToMailchimp(sub.Status),
		MergeFields:     map[string]interface{}{},
		Groups:          []map[string]interface{}{},
		GDPRPermissions: []interface{}{},
		ActivitySummary: map[string]interface{}{},
		ConsentProof:    map[string]interface{}{},
	}
	// Apply the adapter's full Mailchimp merge-field snapshot first, then
	// deterministically overlay ordinary canonical fields. Go map iteration
	// order must not decide whether fields such as name/FNAME survive.
	if value, ok := sub.CustomFields["postwave_mailchimp_merge_fields"]; ok {
		if snapshot, ok := value.(map[string]interface{}); ok {
			for key, fieldValue := range snapshot {
				f.MergeFields[key] = fieldValue
			}
		}
	}
	keys := make([]string, 0, len(sub.CustomFields))
	for key := range sub.CustomFields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value := sub.CustomFields[key]
		if sub.SourcePlatform == canonical.SourceBeehiiv && key == "beehiiv" {
			// Adapter provenance remains in the canonical Moosewave JSON snapshot,
			// but it is not a tenant custom-field definition/search column.
			continue
		}
		if sub.SourcePlatform != canonical.SourceMailchimp || !strings.HasPrefix(key, "postwave_mailchimp_") {
			f.MergeFields[key] = value
			continue
		}
		switch key {
		case "postwave_mailchimp_status":
			if v, ok := value.(string); ok && validMailchimpStatus(v) {
				f.MailchimpStatus = v
			}
		case "postwave_mailchimp_merge_fields":
			// Applied before the deterministic ordinary-field overlay above.
		case "postwave_mailchimp_groups":
			f.Groups = normalizeMailchimpGroups(value)
		case "postwave_mailchimp_marketing_permissions":
			f.GDPRPermissions = value
		case "postwave_mailchimp_signup_ip":
			f.SignupIP, _ = value.(string)
		case "postwave_mailchimp_unsubscribe_reason":
			f.UnsubscribeReason, _ = value.(string)
		case "postwave_mailchimp_last_changed":
			f.LastChanged, _ = value.(string)
		case "postwave_mailchimp_activity_summary":
			if v, ok := value.(map[string]interface{}); ok {
				f.ActivitySummary = v
			}
		case "postwave_mailchimp_consent_proof":
			if v, ok := value.(map[string]interface{}); ok {
				f.ConsentProof = v
			}
		case "postwave_mailchimp_language":
			if v, ok := value.(string); ok {
				f.Language = normalizeLanguage(v)
			}
		case "postwave_mailchimp_location":
			if v, ok := value.(map[string]interface{}); ok {
				f.Country = strings.ToUpper(firstStringField(v, "country_code", "country"))
				f.Region = firstStringField(v, "region", "state", "province")
				f.Timezone = firstStringField(v, "time_zone", "timezone")
			}
		case "postwave_mailchimp_member_rating":
			f.Rating = normalizeMemberRating(value)
		}
	}
	f.Groups = bindMailchimpGroupsToAudience(f.Groups, sub.Tags)
	f.GDPRPermissions = bindMailchimpPermissionsToAudience(f.GDPRPermissions, sub.Tags)
	f.FirstName = firstStringField(f.MergeFields, "FNAME", "first_name", "firstName")
	f.LastName = firstStringField(f.MergeFields, "LNAME", "last_name", "lastName")
	f.FullName = firstStringField(f.MergeFields, "full_name", "FULLNAME", "name", "NAME")
	if f.FullName == "" {
		f.FullName = strings.TrimSpace(f.FirstName + " " + f.LastName)
	}
	f.DisplayName = firstStringField(f.MergeFields, "display_name", "DISPLAY_NAME")
	if f.DisplayName == "" {
		f.DisplayName = f.FullName
	}
	if f.Language != "" && f.Country != "" {
		f.Locale = f.Language + "-" + f.Country
	} else {
		f.Locale = f.Language
	}
	if f.Status == "" {
		f.Status = string(canonical.StatusDisabled)
	}
	return f
}

func normalizeLanguage(language string) string {
	language = strings.ToLower(strings.TrimSpace(language))
	if idx := strings.IndexAny(language, "-_"); idx >= 0 {
		language = language[:idx]
	}
	if len(language) != 2 {
		return ""
	}
	return language
}

func normalizeMemberRating(value interface{}) interface{} {
	var rating int
	switch typed := value.(type) {
	case int:
		rating = typed
	case int64:
		rating = int(typed)
	case float64:
		rating = int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		rating = int(parsed)
	}
	if rating < 1 || rating > 5 {
		return nil
	}
	return rating
}

func defensibleImportedConsentAt(sub canonical.Subscriber, finalStatus, sourceStatus string) interface{} {
	if finalStatus != string(canonical.StatusEnabled) || sub.ConsentTimestamp == nil {
		return nil
	}
	switch sub.ConsentSource {
	case canonical.ConsentDoubleOptIn, canonical.ConsentSingleOptIn:
		return sub.ConsentTimestamp.UTC()
	default:
		// Mailchimp does not consistently expose the acquisition mode for
		// ordinary subscribed members. A timestamp_opt plus final subscribed
		// status is positive evidence even when single-vs-double is unknown.
		if sub.SourcePlatform == canonical.SourceMailchimp && sourceStatus == "subscribed" {
			return sub.ConsentTimestamp.UTC()
		}
		return nil
	}
}

func quarantineMailchimpWithoutConsentEvidence(sub canonical.Subscriber) canonical.Subscriber {
	if sub.SourcePlatform != canonical.SourceMailchimp || sub.Status != canonical.StatusEnabled || sub.ConsentTimestamp != nil {
		return sub
	}
	if subscriberMirrorFields(sub).MailchimpStatus == "subscribed" {
		sub.Status = canonical.StatusUnconfirmed
	}
	return sub
}

func firstStringField(values map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value, ok := values[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func normalizeMailchimpGroups(value interface{}) []map[string]interface{} {
	out := []map[string]interface{}{}
	appendGroup := func(group map[string]interface{}) {
		sourceID, _ := group["source_id"].(string)
		if sourceID == "" {
			sourceID, _ = group["id"].(string)
		}
		if strings.TrimSpace(sourceID) == "" {
			return
		}
		name, _ := group["name"].(string)
		if strings.TrimSpace(name) == "" {
			name = sourceID
		}
		category := firstStringField(group, "category", "category_name", "group_title")
		categoryID := firstStringField(group, "category_id", "group_id")
		audienceID := firstStringField(group, "audience_id", "list_id")
		if category == "" && categoryID != "" {
			category = "Mailchimp category " + categoryID
		}
		if category == "" {
			category = "Mailchimp interests"
		}
		groupType := normalizeMailchimpGroupType(firstStringField(group, "type", "display_type"))
		displayOrder := normalizeDisplayOrder(group["display_order"])
		registryCategory := mailchimpGroupRegistryCategory(category, categoryID, audienceID)
		out = append(out, map[string]interface{}{
			"id":                sourceID,
			"source_id":         sourceID,
			"name":              name,
			"category":          category,
			"category_id":       categoryID,
			"audience_id":       audienceID,
			"registry_category": registryCategory,
			"type":              groupType,
			"display_order":     displayOrder,
			"source_platform":   "mailchimp",
		})
	}
	switch typed := value.(type) {
	case []map[string]interface{}:
		for _, group := range typed {
			appendGroup(group)
		}
	case []interface{}:
		for _, item := range typed {
			if group, ok := item.(map[string]interface{}); ok {
				appendGroup(group)
			}
		}
	}
	return out
}

func bindMailchimpGroupsToAudience(groups []map[string]interface{}, tags []string) []map[string]interface{} {
	audiences := []string{}
	seen := map[string]struct{}{}
	for _, tag := range tags {
		if audienceID, ok := sourceAudienceIDFromTag(tag); ok {
			if _, exists := seen[audienceID]; !exists {
				seen[audienceID] = struct{}{}
				audiences = append(audiences, audienceID)
			}
		}
	}
	if len(audiences) != 1 {
		return groups
	}
	out := make([]map[string]interface{}, 0, len(groups))
	for _, group := range groups {
		copy := make(map[string]interface{}, len(group)+2)
		for key, value := range group {
			copy[key] = value
		}
		if firstStringField(copy, "audience_id") == "" {
			copy["audience_id"] = audiences[0]
			copy["registry_category"] = mailchimpGroupRegistryCategory(
				firstStringField(copy, "category"), firstStringField(copy, "category_id"), audiences[0])
		}
		out = append(out, copy)
	}
	return out
}

func bindMailchimpPermissionsToAudience(value interface{}, tags []string) interface{} {
	audienceID := ""
	for _, tag := range tags {
		candidate, ok := sourceAudienceIDFromTag(tag)
		if !ok {
			continue
		}
		if audienceID != "" && audienceID != candidate {
			return value
		}
		audienceID = candidate
	}
	if audienceID == "" {
		return value
	}
	items := []interface{}{}
	switch typed := value.(type) {
	case []interface{}:
		items = typed
	case []map[string]interface{}:
		for _, item := range typed {
			items = append(items, item)
		}
	default:
		return value
	}
	out := make([]interface{}, 0, len(items))
	for _, item := range items {
		permission, ok := item.(map[string]interface{})
		if !ok {
			out = append(out, item)
			continue
		}
		copy := make(map[string]interface{}, len(permission)+1)
		for key, field := range permission {
			copy[key] = field
		}
		copy["audience_id"] = audienceID
		out = append(out, copy)
	}
	return out
}

func mailchimpGroupRegistryCategory(category, categoryID, audienceID string) string {
	category = strings.TrimSpace(category)
	if category == "" {
		category = "Mailchimp interests"
	}
	scope := strings.TrimSpace(audienceID)
	if scope == "" {
		scope = "unscoped"
	}
	definition := strings.TrimSpace(categoryID)
	if definition == "" {
		definition = "category"
	}
	return fmt.Sprintf("%s [mailchimp:%s:%s]", category, scope, definition)
}

func normalizeMailchimpGroupType(groupType string) string {
	switch strings.ToLower(strings.TrimSpace(groupType)) {
	case "checkboxes":
		return "checkbox"
	case "radio", "dropdown", "hidden", "checkbox":
		return strings.ToLower(strings.TrimSpace(groupType))
	default:
		return "checkbox"
	}
}

func normalizeDisplayOrder(value interface{}) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return 0
	}
}

func canonicalStatusToMailchimp(status canonical.SubscriberStatus) string {
	switch status {
	case canonical.StatusEnabled:
		return "subscribed"
	case canonical.StatusBlocklisted:
		return "cleaned"
	case canonical.StatusDisabled:
		return "unsubscribed"
	default:
		return "non_subscribed"
	}
}

func validMailchimpStatus(status string) bool {
	switch status {
	case "subscribed", "unsubscribed", "non_subscribed", "cleaned", "pending", "transactional", "archived", "deleted":
		return true
	default:
		return false
	}
}

func mailchimpStatusRank(status string) int {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "cleaned":
		return 90
	case "unsubscribed":
		return 80
	case "transactional":
		return 79
	case "archived":
		return 78
	case "deleted":
		return 77
	case "pending":
		return 60
	case "non_subscribed":
		return 59
	case "subscribed":
		return 10
	default:
		return 20
	}
}

func normalizedConsentSource(source canonical.ConsentSource) string {
	switch source {
	case canonical.ConsentDoubleOptIn, canonical.ConsentSingleOptIn, canonical.ConsentImport, canonical.ConsentAPI, canonical.ConsentUnknown:
		return string(source)
	default:
		return string(canonical.ConsentUnknown)
	}
}

func subscriberWasErasedTx(ctx context.Context, tx *sql.Tx, tenantID, email string) (bool, error) {
	var erased bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM email_suppressions
			 WHERE tenant_id = $1::uuid
			   AND lower(email::text) = lower($2)
			   AND COALESCE((metadata ->> 'gdpr_erasure')::boolean, false)
		)
	`, tenantID, email).Scan(&erased)
	return erased, err
}

func subscriberSuppressedTx(ctx context.Context, tx *sql.Tx, tenantID, email string) (bool, error) {
	var suppressed bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM suppressions
			 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
			UNION ALL
			SELECT 1 FROM email_suppressions
			 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
			   AND (expires_at IS NULL OR expires_at > now())
		)
	`, tenantID, email).Scan(&suppressed)
	return suppressed, err
}

func subscriberBeforeImageTx(ctx context.Context, tx *sql.Tx, tenantID, email string) (string, map[string]interface{}, error) {
	var id, raw string
	err := tx.QueryRowContext(ctx, `
		SELECT id::text, jsonb_build_object(
			'status', status,
			'consent_timestamp', consent_timestamp,
			'consent_source', consent_source,
			'consent_email_marketing_at', consent_email_marketing_at,
			'custom_fields', custom_fields,
			'tags', to_jsonb(tags),
			'source_id', source_id,
			'source_platform', source_platform,
			'mailchimp_status', mailchimp_status,
			'merge_fields', merge_fields,
			'groups', groups,
			'gdpr_permissions', gdpr_permissions,
			'signup_ip', signup_ip,
			'unsubscribe_reason', unsubscribe_reason,
			'mailchimp_last_changed', mailchimp_last_changed,
			'activity_summary', activity_summary,
			'first_name', first_name,
			'last_name', last_name,
			'full_name', full_name,
			'display_name', display_name,
			'locale', locale,
			'language', language,
			'country', country,
			'region', region,
			'timezone', timezone,
			'rating', rating,
			'updated_at', updated_at
		)::text
		FROM subscribers
		WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
		FOR UPDATE
	`, tenantID, email).Scan(&id, &raw)
	if err == sql.ErrNoRows {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	var snapshot map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		return "", nil, err
	}
	return id, snapshot, nil
}

// subscriberMirrorStateTx captures every mutable Moosewave surface that the
// subscriber import owns. Rollback compares this after-image before changing
// either Moosewave or Listmonk, so a later UI edit or overlapping migration is
// never silently overwritten.
func subscriberMirrorStateTx(ctx context.Context, tx *sql.Tx, tenantID, subscriberID, email string, metadata map[string]interface{}) (map[string]interface{}, error) {
	id, core, err := subscriberBeforeImageTx(ctx, tx, tenantID, email)
	if err != nil {
		return nil, err
	}
	if id == "" || id != subscriberID {
		return nil, fmt.Errorf("subscriber %s no longer resolves to expected email %q", subscriberID, email)
	}
	customIDs := metadataStringSlice(metadata["postwave_custom_field_registry_created"])
	if customIDs == nil {
		customIDs = []string{}
	}
	customIDsRaw, _ := json.Marshal(customIDs)
	if err := lockSubscriberMirrorRowsTx(ctx, tx, tenantID, subscriberID, string(customIDsRaw)); err != nil {
		return nil, err
	}
	state := map[string]interface{}{"subscriber": core}
	queries := []struct {
		key   string
		query string
		args  []interface{}
	}{
		{
			key: "list_memberships",
			query: `SELECT COALESCE(jsonb_agg(jsonb_build_object(
				'list_id', list_id, 'removed_at', removed_at, 'listmonk_list_id', listmonk_list_id,
				'email', email, 'source', source, 'source_id', source_id, 'metadata', metadata
			) ORDER BY list_id), '[]'::jsonb)::text
			FROM list_subscribers WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
			args: []interface{}{tenantID, subscriberID},
		},
		{
			key: "tag_memberships",
			query: `SELECT COALESCE(jsonb_agg(jsonb_build_object(
				'tag_id', st.tag_id, 'name', t.name::text, 'source', st.source,
				'applied_by', st.applied_by, 'applied_at', st.applied_at
			) ORDER BY st.tag_id), '[]'::jsonb)::text
			FROM subscriber_tags st
			JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
			WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid`,
			args: []interface{}{tenantID, subscriberID},
		},
		{
			key: "group_memberships",
			query: `SELECT COALESCE(jsonb_agg(jsonb_build_object(
				'membership_id', gm.id, 'group_id', gm.group_id, 'joined_at', gm.joined_at,
				'category', g.category, 'name', g.name, 'type', g.type,
				'display_order', g.display_order, 'source_id', g.source_id, 'updated_at', g.updated_at
			) ORDER BY gm.id), '[]'::jsonb)::text
			FROM subscriber_group_memberships gm
			JOIN subscriber_groups g ON g.tenant_id = gm.tenant_id AND g.id = gm.group_id
			WHERE gm.tenant_id = $1::uuid AND gm.subscriber_id = $2::uuid`,
			args: []interface{}{tenantID, subscriberID},
		},
	}
	queries = append(queries, struct {
		key   string
		query string
		args  []interface{}
	}{
		key: "created_custom_field_registry",
		query: `WITH wanted AS (
			SELECT value::uuid AS id FROM jsonb_array_elements_text($2::jsonb)
		)
		SELECT COALESCE(jsonb_agg(jsonb_build_object(
			'id', f.id, 'key', f.key, 'label', f.label, 'type', f.type,
			'searchable', f.searchable, 'updated_at', f.updated_at
		) ORDER BY f.id), '[]'::jsonb)::text
		FROM tenant_custom_fields f JOIN wanted w ON w.id = f.id
		WHERE f.tenant_id = $1::uuid`,
		args: []interface{}{tenantID, string(customIDsRaw)},
	})
	for _, query := range queries {
		var raw string
		if err := tx.QueryRowContext(ctx, query.query, query.args...).Scan(&raw); err != nil {
			return nil, err
		}
		var value interface{}
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			return nil, err
		}
		state[query.key] = value
	}
	return state, nil
}

// lockSubscriberMirrorRowsTx closes the check-then-restore race for mutable
// child/registry rows. The subscriber itself is already locked by
// subscriberBeforeImageTx; these locks prevent a concurrent membership or
// registry edit from landing after the exact after-image check but before the
// rollback DELETE/UPDATE statements in the same transaction.
func lockSubscriberMirrorRowsTx(ctx context.Context, tx *sql.Tx, tenantID, subscriberID, customIDsJSON string) error {
	locks := []struct {
		query string
		args  []interface{}
	}{
		{`SELECT id::text FROM list_subscribers WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid ORDER BY id FOR UPDATE`, []interface{}{tenantID, subscriberID}},
		{`SELECT tag_id::text FROM subscriber_tags WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid ORDER BY tag_id FOR UPDATE`, []interface{}{tenantID, subscriberID}},
		{`SELECT t.id::text FROM tags t JOIN subscriber_tags st ON st.tenant_id = t.tenant_id AND st.tag_id = t.id WHERE st.tenant_id = $1::uuid AND st.subscriber_id = $2::uuid ORDER BY t.id FOR UPDATE OF t`, []interface{}{tenantID, subscriberID}},
		{`SELECT id::text FROM subscriber_group_memberships WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid ORDER BY id FOR UPDATE`, []interface{}{tenantID, subscriberID}},
		{`SELECT g.id::text FROM subscriber_groups g JOIN subscriber_group_memberships gm ON gm.tenant_id = g.tenant_id AND gm.group_id = g.id WHERE gm.tenant_id = $1::uuid AND gm.subscriber_id = $2::uuid ORDER BY g.id FOR UPDATE OF g`, []interface{}{tenantID, subscriberID}},
		{`SELECT f.id::text FROM tenant_custom_fields f JOIN (SELECT value::uuid AS id FROM jsonb_array_elements_text($2::jsonb)) wanted ON wanted.id = f.id WHERE f.tenant_id = $1::uuid ORDER BY f.id FOR UPDATE OF f`, []interface{}{tenantID, customIDsJSON}},
	}
	for _, lock := range locks {
		rows, err := tx.QueryContext(ctx, lock.query, lock.args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var ignored string
			if err := rows.Scan(&ignored); err != nil {
				_ = rows.Close()
				return err
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}

func checkContactPlanLimitTx(ctx context.Context, tx *sql.Tx, tenantID string, increment int) error {
	count, limit, tier, err := contactPlanCapacityTx(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if increment <= 0 {
		increment = 1
	}
	if limit > 0 && count+increment > limit {
		return fmt.Errorf("%w: tier=%s current=%d limit=%d", ErrContactPlanLimitExceeded, tier, count, limit)
	}
	return nil
}

func contactPlanCapacityTx(ctx context.Context, tx *sql.Tx, tenantID string) (count, limit int, tier string, err error) {
	var slug string
	if err := tx.QueryRowContext(ctx, `
		SELECT t.slug, lower(COALESCE(bs.tier, t.tier, 'studio'))
		  FROM tenants t
		  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
		 WHERE t.id = $1::uuid
		 FOR UPDATE OF t
	`, tenantID).Scan(&slug, &tier); err != nil {
		return 0, 0, "", err
	}
	if slug == "demo" {
		return 0, 0, tier, nil
	}
	limit = contactLimitsByTier[tier]
	if limit == 0 {
		limit = contactLimitsByTier["studio"]
	}
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid`, tenantID).Scan(&count); err != nil {
		return 0, 0, tier, err
	}
	return count, limit, tier, nil
}

func persistAudienceMembershipsTx(ctx context.Context, tx *sql.Tx, resource ImportedResource, sub canonical.Subscriber, subscriberID string, audiences map[string]AudienceMapping) ([]string, []map[string]interface{}, []string, error) {
	created := []string{}
	before := []map[string]interface{}{}
	touched := []string{}
	fields := subscriberMirrorFields(sub)
	proofRaw, _ := json.Marshal(fields.ConsentProof)
	for _, tag := range sub.Tags {
		sourceID, ok := sourceAudienceIDFromTag(tag)
		if !ok {
			continue
		}
		mapping, ok := audiences[sourceID]
		if !ok {
			return nil, nil, nil, fmt.Errorf("subscriber %q references audience %q without a destination mapping", sub.Email, sourceID)
		}
		var membershipID string
		var removedAt sql.NullTime
		var oldListmonkID sql.NullInt64
		var oldEmail sql.NullString
		var oldSource, oldSourceID string
		var oldMetadataRaw []byte
		err := tx.QueryRowContext(ctx, `
			SELECT id::text, removed_at, listmonk_list_id, email, source, COALESCE(source_id, ''), COALESCE(metadata, '{}'::jsonb)
			  FROM list_subscribers
			 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND subscriber_id = $3::uuid
			 FOR UPDATE
		`, resource.TenantID, mapping.PostwaveID, subscriberID).Scan(&membershipID, &removedAt, &oldListmonkID, &oldEmail, &oldSource, &oldSourceID, &oldMetadataRaw)
		if err != nil && err != sql.ErrNoRows {
			return nil, nil, nil, err
		}
		if err == sql.ErrNoRows {
			sourceEventID := fmt.Sprintf("migration:%s:%s:%s", resource.JobID, sourceID, sub.SourceID)
			if err := tx.QueryRowContext(ctx, `
				INSERT INTO list_subscribers
					(tenant_id, list_id, subscriber_id, listmonk_list_id, email, source, source_id, removed_at, metadata)
				VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'migration', $6, NULL,
					jsonb_build_object('migration_job_id', $7::text, 'source_audience_id', $8::text,
						'mailchimp_status', $9::text, 'source_member_id', $10::text, 'consent_proof', $11::jsonb))
				RETURNING id::text
			`, resource.TenantID, mapping.PostwaveID, subscriberID, mapping.ListmonkID, sub.Email,
				sourceEventID, resource.JobID, sourceID, fields.MailchimpStatus, sub.SourceID, string(proofRaw)).Scan(&membershipID); err != nil {
				return nil, nil, nil, err
			}
			created = append(created, membershipID)
			touched = append(touched, membershipID)
			continue
		}
		oldMetadata := map[string]interface{}{}
		_ = json.Unmarshal(oldMetadataRaw, &oldMetadata)
		before = append(before, map[string]interface{}{
			"id":               membershipID,
			"removed_at":       nullableTimeValue(removedAt),
			"listmonk_list_id": nullableIntValue(oldListmonkID),
			"email":            nullableStringValue(oldEmail),
			"source":           oldSource,
			"source_id":        oldSourceID,
			"metadata":         oldMetadata,
		})
		if _, err := tx.ExecContext(ctx, `
			UPDATE list_subscribers
			   SET removed_at = NULL,
			       listmonk_list_id = COALESCE(listmonk_list_id, $4),
			       email = COALESCE(email, $5),
			       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
					'migration_job_id', $6::text, 'source_audience_id', $7::text, 'mailchimp_status', $8::text,
					'source_member_id', $9::text, 'consent_proof', $10::jsonb)
			 WHERE tenant_id = $1::uuid AND id = $2::uuid AND subscriber_id = $3::uuid
		`, resource.TenantID, membershipID, subscriberID, mapping.ListmonkID, sub.Email,
			resource.JobID, sourceID, fields.MailchimpStatus, sub.SourceID, string(proofRaw)); err != nil {
			return nil, nil, nil, err
		}
		touched = append(touched, membershipID)
	}
	return created, before, uniqueSortedStrings(touched), nil
}

func importedResourceMetadataByDestinationTx(ctx context.Context, tx *sql.Tx, resource ImportedResource) (map[string]interface{}, error) {
	var raw []byte
	err := tx.QueryRowContext(ctx, `
		SELECT destination_metadata
		  FROM migration_imported_resources
		 WHERE tenant_id = $1::uuid AND job_id = $2::uuid AND resource_type = $3
		   AND destination_type = $4 AND destination_id = $5 AND rolled_back_at IS NULL
		 FOR UPDATE
	`, resource.TenantID, resource.JobID, resource.ResourceType, resource.DestinationType, resource.DestinationID).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var metadata map[string]interface{}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		return nil, err
	}
	return metadata, nil
}

func subscriberSnapshotSourceMatches(before map[string]interface{}, sub canonical.Subscriber) bool {
	if before == nil {
		return false
	}
	platform, _ := before["source_platform"].(string)
	sourceID, _ := before["source_id"].(string)
	return strings.EqualFold(strings.TrimSpace(platform), strings.TrimSpace(string(sub.SourcePlatform))) &&
		strings.TrimSpace(sourceID) != "" &&
		strings.TrimSpace(sourceID) == strings.TrimSpace(sub.SourceID)
}

func subscriberTrackedSourceMatches(before, metadata map[string]interface{}, sub canonical.Subscriber) bool {
	if before == nil || metadata == nil {
		return false
	}
	platform, _ := before["source_platform"].(string)
	if !strings.EqualFold(strings.TrimSpace(platform), strings.TrimSpace(string(sub.SourcePlatform))) {
		return false
	}
	sourceID := strings.TrimSpace(sub.SourceID)
	if sourceID == "" {
		return false
	}
	return containsMetadataString(metadataStringSlice(metadata["source_ids"]), sourceID)
}

func sourceOwnedSubscriberFieldKeys(before map[string]interface{}, previouslyOwned, incoming []string, isNew bool) []string {
	if isNew {
		return append([]string(nil), incoming...)
	}
	owned := make(map[string]struct{}, len(previouslyOwned))
	for _, key := range previouslyOwned {
		owned[strings.ToLower(strings.TrimSpace(key))] = struct{}{}
	}
	out := make([]string, 0, len(incoming))
	for _, key := range incoming {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "" {
			continue
		}
		if _, ok := owned[normalized]; ok || subscriberSnapshotFieldEmpty(before, normalized) {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

func subscriberSnapshotFieldEmpty(before map[string]interface{}, key string) bool {
	if before == nil {
		return true
	}
	custom, _ := before["custom_fields"].(map[string]interface{})
	if value, ok := custom[key]; ok && value != nil && strings.TrimSpace(fmt.Sprint(value)) != "" {
		return false
	}
	aliases := []string(nil)
	switch key {
	case "first_name", "firstname", "fname":
		aliases = []string{"first_name"}
	case "last_name", "lastname", "lname":
		aliases = []string{"last_name"}
	case "name", "full_name", "fullname":
		aliases = []string{"full_name", "display_name"}
	case "display_name":
		aliases = []string{"display_name", "full_name"}
	case "locale":
		aliases = []string{"locale"}
	case "language":
		aliases = []string{"language"}
	case "country", "country_code":
		aliases = []string{"country"}
	case "region", "state", "province":
		aliases = []string{"region"}
	case "timezone", "time_zone":
		aliases = []string{"timezone"}
	case "rating", "member_rating":
		aliases = []string{"rating"}
	}
	for _, alias := range aliases {
		if value, ok := before[alias]; ok && value != nil && strings.TrimSpace(fmt.Sprint(value)) != "" {
			return false
		}
	}
	return true
}

func containsSubscriberFieldKey(keys []string, candidates ...string) bool {
	wanted := make(map[string]struct{}, len(candidates))
	for _, key := range candidates {
		wanted[strings.ToLower(strings.TrimSpace(key))] = struct{}{}
	}
	for _, key := range keys {
		if _, ok := wanted[strings.ToLower(strings.TrimSpace(key))]; ok {
			return true
		}
	}
	return false
}

func mergeSubscriberTrackingMetadata(previous, incoming map[string]interface{}, authoritativeTagJoins ...bool) map[string]interface{} {
	merged := cloneMetadata(incoming)
	for key, value := range previous {
		merged[key] = value
	}
	// Before-images remain the first pre-migration state, while after-images
	// advance with each same-job source row so rollback can detect later user
	// edits without losing the original restore target.
	if value, ok := incoming["listmonk_after"]; ok {
		merged["listmonk_after"] = value
	}
	if value, ok := incoming["postwave_after"]; ok {
		merged["postwave_after"] = value
	}
	if value, ok := incoming["postwave_source_snapshot_present"]; ok {
		// This is the current source traversal state, not cumulative rollback
		// evidence. A later reappearance must replace an earlier absence marker.
		merged["postwave_source_snapshot_present"] = value
	}
	merged["postwave_membership_created"] = unionMetadataStrings(previous["postwave_membership_created"], incoming["postwave_membership_created"])
	merged["postwave_membership_before"] = unionMetadataObjectsByID(previous["postwave_membership_before"], incoming["postwave_membership_before"])
	if len(authoritativeTagJoins) > 0 && authoritativeTagJoins[0] {
		merged["postwave_tag_joins_created"] = metadataStringSlice(incoming["postwave_tag_joins_created"])
	} else {
		merged["postwave_tag_joins_created"] = unionMetadataStrings(previous["postwave_tag_joins_created"], incoming["postwave_tag_joins_created"])
	}
	merged["postwave_tag_registry_created"] = unionMetadataStrings(previous["postwave_tag_registry_created"], incoming["postwave_tag_registry_created"])
	merged["postwave_group_memberships_created"] = unionMetadataStrings(previous["postwave_group_memberships_created"], incoming["postwave_group_memberships_created"])
	merged["postwave_group_registry_created"] = unionMetadataStrings(previous["postwave_group_registry_created"], incoming["postwave_group_registry_created"])
	merged["postwave_custom_field_registry_created"] = unionMetadataStrings(previous["postwave_custom_field_registry_created"], incoming["postwave_custom_field_registry_created"])
	if len(authoritativeTagJoins) > 1 && authoritativeTagJoins[1] {
		merged["postwave_source_field_keys"] = metadataStringSlice(incoming["postwave_source_field_keys"])
	}
	merged["consent_event_source_ids"] = unionMetadataStrings(previous["consent_event_source_ids"], incoming["consent_event_source_ids"])
	merged["source_ids"] = unionMetadataStrings(previous["source_ids"], incoming["source_ids"])
	merged[subscriberSourceProjectionsMetadataKey] = mergeSubscriberProjectionMetadata(previous[subscriberSourceProjectionsMetadataKey], incoming[subscriberSourceProjectionsMetadataKey])
	if metadataBool(previous, "postwave_shared_source_reconciliation") || metadataBool(incoming, "postwave_shared_source_reconciliation") {
		merged["postwave_shared_source_reconciliation"] = true
	}
	merged["postwave_retired_source_identity_keys"] = unionMetadataStrings(previous["postwave_retired_source_identity_keys"], incoming["postwave_retired_source_identity_keys"])
	return merged
}

func importedConsentAction(sub canonical.Subscriber, mailchimpStatus string) string {
	// Consent evidence describes the incoming source record, never the merged
	// destination result. A pre-existing destination suppression can make the
	// final row disabled/blocklisted without proving that Mailchimp recorded an
	// opt-out, and must not be misattributed to the source.
	if defensibleImportedConsentAt(sub, string(sub.Status), mailchimpStatus) != nil {
		return "imported"
	}
	if sub.SourcePlatform == canonical.SourceMailchimp {
		if strings.EqualFold(strings.TrimSpace(mailchimpStatus), "unsubscribed") {
			return "opted_out"
		}
		return ""
	}
	if sub.Status == canonical.StatusDisabled || sub.Status == canonical.StatusBlocklisted {
		return "opted_out"
	}
	return ""
}

func recordImportedConsentTx(ctx context.Context, tx *sql.Tx, resource ImportedResource, sub canonical.Subscriber, subscriberID string, proof map[string]interface{}) error {
	createdAt := time.Now().UTC()
	if sub.ConsentTimestamp != nil {
		createdAt = sub.ConsentTimestamp.UTC()
	}
	mailchimpStatus := subscriberMirrorFields(sub).MailchimpStatus
	action := importedConsentAction(sub, mailchimpStatus)
	if action == "" {
		// No source grant and no source opt-out is not a denial. The contact is
		// quarantined as unconfirmed and its raw proof remains on the subscriber
		// plus import activity without fabricating a consent decision.
		return nil
	}
	preferences, _ := json.Marshal(map[string]interface{}{
		"migration_job_id": resource.JobID,
		"source_id":        sub.SourceID,
		"consent_source":   sub.ConsentSource,
		"proof":            proof,
	})
	_, err := tx.ExecContext(ctx, `
		INSERT INTO consent_events
			(tenant_id, subject_type, subject_id, subject_email, channel, category, action, source, preferences, proof_text, created_at)
		VALUES ($1::uuid, 'subscriber', $2, $3, 'import', 'email_marketing', $4, $5, $6::jsonb, $7, $8)
	`, resource.TenantID, subscriberID, sub.Email, action, "migration:"+string(sub.SourcePlatform), string(preferences), "Imported source consent evidence retained in preferences", createdAt)
	return err
}

// RestoreSubscriberMirrorAndMark restores or deletes the Moosewave mirror
// according to the durable operation marker, restores pre-existing list
// memberships, and marks the ledger row rolled back atomically.
func RestoreSubscriberMirrorAndMark(ctx context.Context, db *sql.DB, tenantID string, resource ImportedResource) (err error) {
	if metadataBool(resource.DestinationMetadata, "postwave_shared_source_reconciliation") {
		return fmt.Errorf("%w: subscriber ledger %s contains a shared-source retirement reconciliation; rollback must rebuild from active source projections and cannot restore its stale pre-reconciliation before-image", ErrRollbackConflict, resource.ID)
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	if applied, present := resource.DestinationMetadata["postwave_mirror_applied"].(bool); present && !applied {
		// The external-intent reconciler recovered a Listmonk mutation that
		// happened before Moosewave mirror persistence began. There is no local
		// before/after image to restore; atomically close only the ledger row.
		return markImportedResourceRolledBackTx(ctx, tx, resource.ID)
	}
	metadata := resource.DestinationMetadata
	operation, _ := metadata["postwave_operation"].(string)
	subscriberID, _ := metadata["postwave_subscriber_id"].(string)
	if operation == "" || subscriberID == "" {
		return fmt.Errorf("subscriber rollback ledger %s lacks Moosewave operation/before-image metadata", resource.ID)
	}
	if err := validateSubscriberMirrorStateTx(ctx, tx, tenantID, resource); err != nil {
		return err
	}

	if err := restoreMembershipsTx(ctx, tx, tenantID, metadata); err != nil {
		return err
	}
	if err := restoreSubscriberTagsTx(ctx, tx, tenantID, subscriberID, metadata); err != nil {
		return err
	}
	if err := restoreSubscriberGroupsTx(ctx, tx, tenantID, subscriberID, metadata); err != nil {
		return err
	}
	email, _ := metadata["email"].(string)
	switch operation {
	case "created":
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO consent_events
				(tenant_id, subject_type, subject_id, subject_email, channel, category, action, source, preferences, proof_text)
			VALUES ($1::uuid, 'subscriber', $2, NULLIF($3, ''), 'import', 'email_marketing', 'revoked', 'migration_rollback',
				jsonb_build_object('resource_id', $4::text), 'Migration-created subscriber rolled back')
		`, tenantID, subscriberID, email, resource.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
			return err
		}
	case "updated":
		before, ok := metadata["postwave_before"].(map[string]interface{})
		if !ok || before == nil {
			return fmt.Errorf("subscriber rollback ledger %s lacks Moosewave before-image", resource.ID)
		}
		beforeRaw, _ := json.Marshal(before)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO consent_events
				(tenant_id, subject_type, subject_id, subject_email, channel, category, action, source, preferences, proof_text)
			VALUES ($1::uuid, 'subscriber', $2, NULLIF($3, ''), 'import', 'email_marketing',
				CASE WHEN NULLIF($4::jsonb ->> 'consent_email_marketing_at', '') IS NULL THEN 'revoked' ELSE 'imported' END,
				'migration_rollback', jsonb_build_object('resource_id', $5::text), 'Pre-migration consent state restored')
		`, tenantID, subscriberID, email, string(beforeRaw), resource.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE subscribers SET
				status = $3::jsonb ->> 'status',
				consent_timestamp = NULLIF($3::jsonb ->> 'consent_timestamp', '')::timestamptz,
				consent_source = $3::jsonb ->> 'consent_source',
				consent_email_marketing_at = NULLIF($3::jsonb ->> 'consent_email_marketing_at', '')::timestamptz,
				custom_fields = COALESCE($3::jsonb -> 'custom_fields', '{}'::jsonb),
				tags = ARRAY(SELECT jsonb_array_elements_text(COALESCE($3::jsonb -> 'tags', '[]'::jsonb))),
				source_id = NULLIF($3::jsonb ->> 'source_id', ''),
				source_platform = NULLIF($3::jsonb ->> 'source_platform', ''),
				mailchimp_status = $3::jsonb ->> 'mailchimp_status',
				merge_fields = COALESCE($3::jsonb -> 'merge_fields', '{}'::jsonb),
				groups = COALESCE($3::jsonb -> 'groups', '[]'::jsonb),
				gdpr_permissions = COALESCE($3::jsonb -> 'gdpr_permissions', '[]'::jsonb),
				signup_ip = NULLIF($3::jsonb ->> 'signup_ip', '')::inet,
				unsubscribe_reason = NULLIF($3::jsonb ->> 'unsubscribe_reason', ''),
				mailchimp_last_changed = NULLIF($3::jsonb ->> 'mailchimp_last_changed', '')::timestamptz,
				activity_summary = COALESCE($3::jsonb -> 'activity_summary', '{}'::jsonb),
				first_name = COALESCE($3::jsonb ->> 'first_name', ''),
				last_name = COALESCE($3::jsonb ->> 'last_name', ''),
				full_name = COALESCE($3::jsonb ->> 'full_name', ''),
				display_name = COALESCE($3::jsonb ->> 'display_name', ''),
				locale = NULLIF($3::jsonb ->> 'locale', ''),
				language = NULLIF($3::jsonb ->> 'language', ''),
				country = NULLIF($3::jsonb ->> 'country', ''),
				region = NULLIF($3::jsonb ->> 'region', ''),
				timezone = NULLIF($3::jsonb ->> 'timezone', ''),
				rating = NULLIF($3::jsonb ->> 'rating', '')::smallint,
				updated_at = COALESCE(NULLIF($3::jsonb ->> 'updated_at', '')::timestamptz, now())
			WHERE tenant_id = $1::uuid AND id = $2::uuid
		`, tenantID, subscriberID, string(beforeRaw)); err != nil {
			return err
		}
	default:
		return fmt.Errorf("subscriber rollback ledger %s has unknown Moosewave operation %q", resource.ID, operation)
	}
	if err := restoreImportedCustomFieldsTx(ctx, tx, tenantID, metadata); err != nil {
		return err
	}
	return markImportedResourceRolledBackTx(ctx, tx, resource.ID)
}

// ValidateSubscriberMirrorUnchanged is a fail-closed rollback preflight. It
// detects later edits to subscriber fields, list memberships, native tags,
// groups, and migration-created custom-field definitions.
func ValidateSubscriberMirrorUnchanged(ctx context.Context, db *sql.DB, tenantID string, resource ImportedResource) (err error) {
	if metadataBool(resource.DestinationMetadata, "postwave_shared_source_reconciliation") {
		return fmt.Errorf("%w: subscriber ledger %s contains a shared-source retirement reconciliation; rollback is blocked to prevent reintroducing retired source targeting", ErrRollbackConflict, resource.ID)
	}
	if applied, present := resource.DestinationMetadata["postwave_mirror_applied"].(bool); present && !applied {
		return nil
	}
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("subscriber rollback validation requires DB and tenant")
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	return validateSubscriberMirrorStateTx(ctx, tx, tenantID, resource)
}

// CleanupSubscriberMigrationRegistries performs a final deduplicated sweep
// after every subscriber row has been restored. Per-row cleanup alone leaks a
// registry created by subscriber A when subscriber B temporarily references
// it, because only A owns the created marker.
func CleanupSubscriberMigrationRegistries(ctx context.Context, db *sql.DB, tenantID string, resources []ImportedResource) (err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" {
		return fmt.Errorf("subscriber registry cleanup requires DB and tenant")
	}
	metadata := map[string]interface{}{}
	for _, resource := range resources {
		metadata["postwave_tag_registry_created"] = unionMetadataStrings(metadata["postwave_tag_registry_created"], resource.DestinationMetadata["postwave_tag_registry_created"])
		metadata["postwave_group_registry_created"] = unionMetadataStrings(metadata["postwave_group_registry_created"], resource.DestinationMetadata["postwave_group_registry_created"])
		metadata["postwave_custom_field_registry_created"] = unionMetadataStrings(metadata["postwave_custom_field_registry_created"], resource.DestinationMetadata["postwave_custom_field_registry_created"])
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	if err := restoreSubscriberTagsTx(ctx, tx, tenantID, "", metadata); err != nil {
		return err
	}
	if err := restoreSubscriberGroupsTx(ctx, tx, tenantID, "", metadata); err != nil {
		return err
	}
	return restoreImportedCustomFieldsTx(ctx, tx, tenantID, metadata)
}

// CleanupSubscriberMigrationRegistriesForJob is the bounded production form
// of the final sweep. It derives the deduplicated IDs set-wise from ledger
// JSON, so rollback does not retain every subscriber snapshot in memory.
func CleanupSubscriberMigrationRegistriesForJob(ctx context.Context, db *sql.DB, tenantID, jobID string) (err error) {
	if db == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(jobID) == "" {
		return fmt.Errorf("subscriber registry cleanup requires DB, tenant, and job")
	}
	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)
	deletes := []string{
		`DELETE FROM tags t
		 WHERE t.tenant_id = $1::uuid
		   AND t.id IN (
			SELECT DISTINCT value::uuid
			  FROM migration_imported_resources r
			 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.destination_metadata -> 'postwave_tag_registry_created', '[]'::jsonb)) value
			 WHERE r.tenant_id = $1::uuid AND r.job_id = $2::uuid AND r.resource_type = 'subscriber'
		   )
		   AND NOT EXISTS (SELECT 1 FROM subscriber_tags st WHERE st.tenant_id = t.tenant_id AND st.tag_id = t.id)`,
		`DELETE FROM subscriber_groups g
		 WHERE g.tenant_id = $1::uuid
		   AND g.id IN (
			SELECT DISTINCT value::uuid
			  FROM migration_imported_resources r
			 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.destination_metadata -> 'postwave_group_registry_created', '[]'::jsonb)) value
			 WHERE r.tenant_id = $1::uuid AND r.job_id = $2::uuid AND r.resource_type = 'subscriber'
		   )
		   AND NOT EXISTS (SELECT 1 FROM subscriber_group_memberships gm WHERE gm.tenant_id = g.tenant_id AND gm.group_id = g.id)`,
		`DELETE FROM tenant_custom_fields f
		 WHERE f.tenant_id = $1::uuid
		   AND f.id IN (
			SELECT DISTINCT value::uuid
			  FROM migration_imported_resources r
			 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.destination_metadata -> 'postwave_custom_field_registry_created', '[]'::jsonb)) value
			 WHERE r.tenant_id = $1::uuid AND r.job_id = $2::uuid AND r.resource_type = 'subscriber'
		   )
		   AND NOT EXISTS (
			SELECT 1 FROM subscribers s
			 WHERE s.tenant_id = f.tenant_id AND (s.custom_fields ? f.key OR s.merge_fields ? f.key)
		   )`,
	}
	for _, query := range deletes {
		if _, err := tx.ExecContext(ctx, query, tenantID, jobID); err != nil {
			return err
		}
	}
	return nil
}

func validateSubscriberMirrorStateTx(ctx context.Context, tx *sql.Tx, tenantID string, resource ImportedResource) error {
	metadata := resource.DestinationMetadata
	subscriberID, _ := metadata["postwave_subscriber_id"].(string)
	email, _ := metadata["email"].(string)
	expected, ok := metadata["postwave_after"].(map[string]interface{})
	if subscriberID == "" || email == "" || !ok || expected == nil {
		return fmt.Errorf("subscriber rollback ledger %s lacks a valid Moosewave after-image", resource.ID)
	}
	current, err := subscriberMirrorStateTx(ctx, tx, tenantID, subscriberID, email, metadata)
	if err != nil {
		return fmt.Errorf("%w: Moosewave subscriber %s: %v", ErrRollbackConflict, subscriberID, err)
	}
	expectedRaw, err := json.Marshal(expected)
	if err != nil {
		return err
	}
	currentRaw, err := json.Marshal(current)
	if err != nil {
		return err
	}
	if !bytes.Equal(expectedRaw, currentRaw) {
		return fmt.Errorf("%w: Moosewave subscriber %s fields or memberships diverged", ErrRollbackConflict, subscriberID)
	}
	return nil
}

func syncSubscriberTagsTx(ctx context.Context, tx *sql.Tx, tenantID, subscriberID string, tagNames, previousOwnedTagIDs []string, authoritative bool) ([]string, []string, error) {
	activeOwnedJoins := map[string]struct{}{}
	if authoritative {
		for _, tagID := range previousOwnedTagIDs {
			if tagID = strings.TrimSpace(tagID); tagID != "" {
				activeOwnedJoins[tagID] = struct{}{}
			}
		}
	}
	createdRegistry := []string{}
	incomingTagIDs := map[string]struct{}{}
	incomingOrder := []string{}
	for _, name := range normalizeSubscriberTags(tagNames) {
		// The registry keeps the source spelling: it is what the trigger-built
		// subscribers.tags projection (and tag-name segment predicates) show.
		// citext keeps both the lookup and the uniqueness case-insensitive, so
		// a source tag that differs only in case from a registered one ("vip"
		// against "VIP") resolves to that row and the subscriber keeps the
		// registered spelling. That import used to fail: the upsert merged the
		// source spelling into subscribers.tags with a case-sensitive DISTINCT,
		// and the array budget/dedupe trigger rejected the result. Succeeding
		// here is an intended improvement, pinned by
		// TestDBSubscriberImportResolvesCaseVariantOfRegisteredTag.
		var tagID string
		err := tx.QueryRowContext(ctx, `
			INSERT INTO tags (tenant_id, name)
			VALUES ($1::uuid, $2::citext)
			ON CONFLICT (tenant_id, name) DO NOTHING
			RETURNING id::text
		`, tenantID, name).Scan(&tagID)
		if err == nil {
			createdRegistry = append(createdRegistry, tagID)
		} else if err == sql.ErrNoRows {
			if err := tx.QueryRowContext(ctx, `SELECT id::text FROM tags WHERE tenant_id = $1::uuid AND name = $2::citext`, tenantID, name).Scan(&tagID); err != nil {
				return nil, nil, err
			}
		} else {
			return nil, nil, err
		}
		if _, duplicate := incomingTagIDs[tagID]; duplicate {
			continue
		}
		incomingTagIDs[tagID] = struct{}{}
		incomingOrder = append(incomingOrder, tagID)
	}
	// The joins are written as one DELETE and one INSERT, never one statement
	// per tag. Every subscriber_tags row change fires the 1774 projection
	// trigger (AFTER, FOR EACH ROW), which rebuilds subscribers.tags. AFTER ROW
	// triggers fire once the whole statement's rows are in place, so the first
	// rebuild writes the final array and the rest find it already current
	// (tag_membership_rebuild_array_1774 updates only when the array IS
	// DISTINCT FROM the joins). Each statement therefore adds at most one
	// subscribers row version; one statement per tag added one per tag, each
	// non-HOT because subscribers_tags_gin indexes the array. A statement with
	// nothing to do is skipped, and ON CONFLICT DO NOTHING writes no row for a
	// join that already exists, so an unchanged tag set writes nothing at all.
	// A changed set still costs one rebuild per statement. Writing the array
	// in the subscriber upsert would save that, but it is the write that hands
	// the joins to the reconcile trigger (see the comment on that upsert).
	//
	// Retire stale source-owned joins before adding new ones: the membership
	// budget trigger (BEFORE ROW) counts the joins present at each insert,
	// including rows inserted earlier by the same statement, so a full source
	// replacement must not transiently hold both the old and the new sets.
	if authoritative {
		stale := []string{}
		for _, tagID := range previousOwnedTagIDs {
			tagID = strings.TrimSpace(tagID)
			if tagID == "" {
				continue
			}
			if _, retained := incomingTagIDs[tagID]; retained {
				continue
			}
			// A malformed ledger id must fail the import, as the per-tag
			// $3::uuid cast used to. Casting inside the set-wise DELETE would
			// not: PostgreSQL may never evaluate the cast when no join matches.
			parsed, err := uuid.Parse(tagID)
			if err != nil {
				return nil, nil, fmt.Errorf("subscriber tag ownership ledger holds malformed tag id %q: %w", tagID, err)
			}
			stale = append(stale, parsed.String())
			delete(activeOwnedJoins, tagID)
		}
		if len(stale) > 0 {
			staleRaw, err := json.Marshal(stale)
			if err != nil {
				return nil, nil, err
			}
			if _, err = tx.ExecContext(ctx, `
				DELETE FROM subscriber_tags
				 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
				   AND tag_id IN (SELECT value::uuid FROM jsonb_array_elements_text($3::jsonb))
				   AND source = 'migration'
			`, tenantID, subscriberID, string(staleRaw)); err != nil {
				return nil, nil, err
			}
		}
	}
	if len(incomingOrder) > 0 {
		incomingRaw, err := json.Marshal(incomingOrder)
		if err != nil {
			return nil, nil, err
		}
		// RETURNING yields only the joins this statement created; a join that
		// already existed (an operator's, or one kept from an earlier import)
		// conflicts and is not claimed.
		rows, err := tx.QueryContext(ctx, `
			INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, source)
			SELECT $1::uuid, $2::uuid, incoming.value::uuid, 'migration'
			  FROM jsonb_array_elements_text($3::jsonb) WITH ORDINALITY AS incoming(value, ord)
			 ORDER BY incoming.ord
			ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING
			RETURNING tag_id::text
		`, tenantID, subscriberID, string(incomingRaw))
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var tagID string
			if err = rows.Scan(&tagID); err != nil {
				_ = rows.Close()
				return nil, nil, err
			}
			activeOwnedJoins[tagID] = struct{}{}
		}
		if err = rows.Err(); err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		if err = rows.Close(); err != nil {
			return nil, nil, err
		}
	}
	owned := make([]string, 0, len(activeOwnedJoins))
	for tagID := range activeOwnedJoins {
		owned = append(owned, tagID)
	}
	sort.Strings(owned)
	sort.Strings(createdRegistry)
	return owned, createdRegistry, nil
}

func restoreSubscriberTagsTx(ctx context.Context, tx *sql.Tx, tenantID, subscriberID string, metadata map[string]interface{}) error {
	for _, tagID := range metadataStringSlice(metadata["postwave_tag_joins_created"]) {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM subscriber_tags
			 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND tag_id = $3::uuid
		`, tenantID, subscriberID, tagID); err != nil {
			return err
		}
	}
	for _, tagID := range metadataStringSlice(metadata["postwave_tag_registry_created"]) {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM tags t
			 WHERE t.tenant_id = $1::uuid AND t.id = $2::uuid
			   AND NOT EXISTS (
				SELECT 1 FROM subscriber_tags st
				 WHERE st.tenant_id = t.tenant_id AND st.tag_id = t.id
			   )
		`, tenantID, tagID); err != nil {
			return err
		}
	}
	return nil
}

func syncSubscriberGroupsTx(ctx context.Context, tx *sql.Tx, tenantID, subscriberID string, groups []map[string]interface{}) ([]string, []string, error) {
	createdMemberships := []string{}
	createdRegistry := []string{}
	for _, group := range groups {
		name, _ := group["name"].(string)
		sourceID, _ := group["source_id"].(string)
		category, _ := group["registry_category"].(string)
		if strings.TrimSpace(category) == "" {
			category, _ = group["category"].(string)
		}
		groupType, _ := group["type"].(string)
		displayOrder := normalizeDisplayOrder(group["display_order"])
		name = strings.TrimSpace(name)
		sourceID = strings.TrimSpace(sourceID)
		category = strings.TrimSpace(category)
		if category == "" {
			category = "Mailchimp interests"
		}
		groupType = normalizeMailchimpGroupType(groupType)
		if name == "" || sourceID == "" {
			continue
		}
		var groupID string
		err := tx.QueryRowContext(ctx, `
			INSERT INTO subscriber_groups (tenant_id, category, name, type, display_order, source_id)
			VALUES ($1::uuid, $2, $3, $4, $5, $6)
			ON CONFLICT (tenant_id, category, name) DO NOTHING
			RETURNING id::text
		`, tenantID, category, name, groupType, displayOrder, sourceID).Scan(&groupID)
		if err == nil {
			createdRegistry = append(createdRegistry, groupID)
		} else if err == sql.ErrNoRows {
			if err := tx.QueryRowContext(ctx, `
				SELECT id::text FROM subscriber_groups
				 WHERE tenant_id = $1::uuid AND category = $2 AND name = $3
			`, tenantID, category, name).Scan(&groupID); err != nil {
				return nil, nil, err
			}
		} else {
			return nil, nil, err
		}
		var membershipID string
		err = tx.QueryRowContext(ctx, `
			INSERT INTO subscriber_group_memberships (tenant_id, subscriber_id, group_id)
			VALUES ($1::uuid, $2::uuid, $3::uuid)
			ON CONFLICT (tenant_id, subscriber_id, group_id) DO NOTHING
			RETURNING id::text
		`, tenantID, subscriberID, groupID).Scan(&membershipID)
		if err == nil {
			createdMemberships = append(createdMemberships, membershipID)
		} else if err != sql.ErrNoRows {
			return nil, nil, err
		}
	}
	return createdMemberships, createdRegistry, nil
}

func restoreSubscriberGroupsTx(ctx context.Context, tx *sql.Tx, tenantID, _ string, metadata map[string]interface{}) error {
	for _, membershipID := range metadataStringSlice(metadata["postwave_group_memberships_created"]) {
		if _, err := tx.ExecContext(ctx, `DELETE FROM subscriber_group_memberships WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, membershipID); err != nil {
			return err
		}
	}
	for _, groupID := range metadataStringSlice(metadata["postwave_group_registry_created"]) {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM subscriber_groups g
			 WHERE g.tenant_id = $1::uuid AND g.id = $2::uuid
			   AND NOT EXISTS (
				SELECT 1 FROM subscriber_group_memberships gm
				 WHERE gm.tenant_id = g.tenant_id AND gm.group_id = g.id
			   )
		`, tenantID, groupID); err != nil {
			return err
		}
	}
	return nil
}

func registerImportedCustomFieldsTx(ctx context.Context, tx *sql.Tx, tenantID string, fields map[string]interface{}) ([]string, error) {
	created := []string{}
	if len(fields) == 0 {
		return created, nil
	}
	var maxFields int
	var mode string
	if err := tx.QueryRowContext(ctx, `SELECT max_custom_fields, COALESCE(NULLIF(custom_fields_mode, ''), 'auto') FROM tenants WHERE id = $1::uuid FOR UPDATE`, tenantID).Scan(&maxFields, &mode); err != nil {
		return nil, err
	}
	if mode == "off" {
		return created, nil
	}
	for key, value := range fields {
		key = strings.TrimSpace(key)
		if key == "" || strings.HasPrefix(key, "postwave_") {
			continue
		}
		inferred := inferCustomFieldType(value)
		var id, existingType string
		err := tx.QueryRowContext(ctx, `
			SELECT id::text, type FROM tenant_custom_fields
			 WHERE tenant_id = $1::uuid AND key = $2
		`, tenantID, key).Scan(&id, &existingType)
		if err == nil {
			if !customFieldTypesCompatible(existingType, inferred) {
				return nil, fmt.Errorf("custom field %q has registered type %s but imported value is %s", key, existingType, inferred)
			}
			continue
		}
		if err != sql.ErrNoRows {
			return nil, err
		}
		if mode == "strict" {
			return nil, fmt.Errorf("custom field %q is not declared and tenant custom_fields_mode is strict", key)
		}
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM tenant_custom_fields WHERE tenant_id = $1::uuid`, tenantID).Scan(&count); err != nil {
			return nil, err
		}
		if maxFields >= 0 && count+1 > maxFields {
			return nil, fmt.Errorf("tenant custom-field limit exceeded: current=%d limit=%d", count, maxFields)
		}
		label := strings.TrimSpace(strings.NewReplacer("_", " ", "-", " ").Replace(key))
		if label == "" {
			label = key
		}
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO tenant_custom_fields (tenant_id, key, label, type, searchable)
			VALUES ($1::uuid, $2, $3, $4, false)
			RETURNING id::text
		`, tenantID, key, label, inferred).Scan(&id); err != nil {
			return nil, err
		}
		created = append(created, id)
	}
	return created, nil
}

func containsMetadataString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func inferCustomFieldType(value interface{}) string {
	switch value.(type) {
	case bool:
		return "boolean"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, json.Number:
		return "number"
	case []interface{}, []string:
		return "array"
	case map[string]interface{}:
		return "object"
	default:
		return "string"
	}
}

func customFieldTypesCompatible(existing, incoming string) bool {
	if existing == incoming {
		return true
	}
	// String-like configured formats remain compatible with imported scalar
	// strings; the migration never weakens the existing definition.
	if incoming == "string" {
		switch existing {
		case "date", "email", "url", "phone", "region", "enum":
			return true
		}
	}
	return false
}

func restoreImportedCustomFieldsTx(ctx context.Context, tx *sql.Tx, tenantID string, metadata map[string]interface{}) error {
	for _, fieldID := range metadataStringSlice(metadata["postwave_custom_field_registry_created"]) {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM tenant_custom_fields f
			 WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid
			   AND NOT EXISTS (
				SELECT 1 FROM subscribers s
				 WHERE s.tenant_id = f.tenant_id
				   AND (s.custom_fields ? f.key OR s.merge_fields ? f.key)
			   )
		`, tenantID, fieldID); err != nil {
			return err
		}
	}
	return nil
}

func restoreMembershipsTx(ctx context.Context, tx *sql.Tx, tenantID string, metadata map[string]interface{}) error {
	for _, id := range metadataStringSlice(metadata["postwave_membership_created"]) {
		if _, err := tx.ExecContext(ctx, `DELETE FROM list_subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id); err != nil {
			return err
		}
	}
	for _, before := range metadataObjectSlice(metadata["postwave_membership_before"]) {
		id, _ := before["id"].(string)
		if id == "" {
			continue
		}
		raw, _ := json.Marshal(before)
		if _, err := tx.ExecContext(ctx, `
			UPDATE list_subscribers SET
				removed_at = NULLIF($3::jsonb ->> 'removed_at', '')::timestamptz,
				listmonk_list_id = NULLIF($3::jsonb ->> 'listmonk_list_id', '')::bigint,
				email = CASE
					WHEN NOT ($3::jsonb ? 'email') THEN email
					WHEN jsonb_typeof($3::jsonb -> 'email') = 'string' THEN ($3::jsonb ->> 'email')::citext
					ELSE NULL
				END,
				source = COALESCE(NULLIF($3::jsonb ->> 'source', ''), source),
					source_id = NULLIF($3::jsonb ->> 'source_id', ''),
					metadata = COALESCE($3::jsonb -> 'metadata', '{}'::jsonb)
			WHERE tenant_id = $1::uuid AND id = $2::uuid
		`, tenantID, id, string(raw)); err != nil {
			return err
		}
	}
	return nil
}

func nonNilInterfaceMap(in map[string]interface{}) map[string]interface{} {
	if in == nil {
		return map[string]interface{}{}
	}
	return in
}

func cloneMetadata(in map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func metadataBool(metadata map[string]interface{}, key string) bool {
	value, _ := metadata[key].(bool)
	return value
}

func unionMetadataStrings(values ...interface{}) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, value := range values {
		for _, item := range metadataStringSlice(value) {
			if item == "" {
				continue
			}
			if _, ok := seen[item]; ok {
				continue
			}
			seen[item] = struct{}{}
			out = append(out, item)
		}
	}
	return out
}

func metadataStringSlice(value interface{}) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []interface{}:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func unionMetadataObjectsByID(values ...interface{}) []map[string]interface{} {
	out := []map[string]interface{}{}
	seen := map[string]struct{}{}
	for _, value := range values {
		for _, item := range metadataObjectSlice(value) {
			id, _ := item["id"].(string)
			if id != "" {
				if _, ok := seen[id]; ok {
					continue
				}
				seen[id] = struct{}{}
			}
			out = append(out, item)
		}
	}
	return out
}

func metadataObjectSlice(value interface{}) []map[string]interface{} {
	switch typed := value.(type) {
	case []map[string]interface{}:
		return typed
	case []interface{}:
		out := make([]map[string]interface{}, 0, len(typed))
		for _, item := range typed {
			if object, ok := item.(map[string]interface{}); ok {
				out = append(out, object)
			}
		}
		return out
	default:
		return nil
	}
}

func nullableTimeValue(value sql.NullTime) interface{} {
	if !value.Valid {
		return nil
	}
	return value.Time.UTC().Format(time.RFC3339Nano)
}

func nullableIntValue(value sql.NullInt64) interface{} {
	if !value.Valid {
		return nil
	}
	return value.Int64
}

func nullableStringValue(value sql.NullString) interface{} {
	if !value.Valid {
		return nil
	}
	return value.String
}
