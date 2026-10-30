package listmonk

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/migrate/canonical"
)

const (
	klaviyoAccountFingerprintCursorKey        = "klaviyo_account_fingerprint"
	maxKlaviyoCrossJobSubscriberIdentities    = 1024
	customerIOWorkspaceFingerprintCursorKey   = "customerio_workspace_fingerprint"
	maxCustomerIOCrossJobSubscriberIdentities = 1024
)

type klaviyoCrossJobSubscriberIdentity struct {
	JobID    string
	Metadata map[string]interface{}
}

// validateKlaviyoSubscriberAccountLineage fails before any Listmonk request
// when a stable profile identity is still active in another unrolled-back job
// for the exact same tenant and opaque Klaviyo account fingerprint. Same-job
// email moves remain valid: the completed full snapshot writes the new email,
// then its existing job-scoped reconciliation disables the old destination.
func validateKlaviyoSubscriberAccountLineage(ctx context.Context, db *sql.DB, tenantID, jobID string, sub canonical.Subscriber) (err error) {
	if sub.SourcePlatform != canonical.SourceKlaviyo {
		return nil
	}
	tenantID = strings.TrimSpace(tenantID)
	jobID = strings.TrimSpace(jobID)
	sourceID := strings.TrimSpace(sub.SourceID)
	email := strings.ToLower(strings.TrimSpace(sub.Email))
	if db == nil || tenantID == "" || jobID == "" || sourceID == "" || email == "" {
		return fmt.Errorf("Klaviyo subscriber lineage guard requires tenant, job, stable profile id, and email")
	}

	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)

	var accountFingerprint string
	if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(cursor ->> 'klaviyo_account_fingerprint', '')
  FROM migration_jobs
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND source = 'klaviyo'
`, tenantID, jobID).Scan(&accountFingerprint); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("Klaviyo subscriber lineage guard cannot prove the current migration job/account binding")
		}
		return fmt.Errorf("load current Klaviyo migration account binding: %w", err)
	}
	decoded, decodeErr := hex.DecodeString(accountFingerprint)
	if decodeErr != nil || len(decoded) != sha256.Size {
		return fmt.Errorf("Klaviyo subscriber lineage guard cannot prove the current migration job/account binding")
	}

	rows, err := tx.QueryContext(ctx, `
SELECT imported.job_id::text, imported.destination_metadata
  FROM migration_imported_resources AS imported
  JOIN migration_jobs AS lineage_job
    ON lineage_job.tenant_id = imported.tenant_id
   AND lineage_job.id = imported.job_id
 WHERE imported.tenant_id = $1::uuid
   AND imported.job_id <> $2::uuid
   AND imported.resource_type = 'subscriber'
   AND imported.source_platform = 'klaviyo'
   AND imported.source_id = $3
   AND imported.rolled_back_at IS NULL
   AND lineage_job.source = 'klaviyo'
   AND lineage_job.status <> 'rolled_back'
   AND lineage_job.cursor ->> 'klaviyo_account_fingerprint' = $4
 ORDER BY imported.created_at ASC, imported.id ASC
 LIMIT $5
 FOR UPDATE OF imported
`, tenantID, jobID, sourceID, accountFingerprint, maxKlaviyoCrossJobSubscriberIdentities+1)
	if err != nil {
		return fmt.Errorf("load cross-job Klaviyo subscriber lineage: %w", err)
	}
	defer func() { _ = rows.Close() }()

	evidence := make([]klaviyoCrossJobSubscriberIdentity, 0)
	for rows.Next() {
		if len(evidence) >= maxKlaviyoCrossJobSubscriberIdentities {
			return fmt.Errorf("Klaviyo stable profile identity exceeds the bounded cross-job lineage inventory; reconcile prior migrations before retrying")
		}
		var item klaviyoCrossJobSubscriberIdentity
		var raw []byte
		if err := rows.Scan(&item.JobID, &raw); err != nil {
			return fmt.Errorf("scan cross-job Klaviyo subscriber lineage: %w", err)
		}
		if err := json.Unmarshal(raw, &item.Metadata); err != nil {
			return fmt.Errorf("decode cross-job Klaviyo subscriber lineage: %w", err)
		}
		evidence = append(evidence, item)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("load cross-job Klaviyo subscriber lineage: %w", err)
	}
	return validateKlaviyoCrossJobSubscriberEvidence(email, evidence)
}

func validateKlaviyoCrossJobSubscriberEvidence(email string, evidence []klaviyoCrossJobSubscriberIdentity) error {
	email = strings.ToLower(strings.TrimSpace(email))
	for _, item := range evidence {
		if value, present := item.Metadata["postwave_source_snapshot_present"]; present && !metadataBoolValue(value) {
			continue
		}
		if value, present := item.Metadata["postwave_source_identity_owned"]; present && !metadataBoolValue(value) {
			continue
		}
		trackedEmail, _ := item.Metadata["email"].(string)
		trackedEmail = strings.ToLower(strings.TrimSpace(trackedEmail))
		if trackedEmail == "" {
			return fmt.Errorf("Klaviyo stable profile identity has incomplete cross-job destination evidence; reconcile migration job %s before retrying", item.JobID)
		}
		if trackedEmail != email {
			return fmt.Errorf("Klaviyo stable profile identity is active at a different destination email in unrolled-back migration job %s; reconnect that job and run its full-snapshot delta before retrying", item.JobID)
		}
		return fmt.Errorf("Klaviyo stable profile identity is already owned by unrolled-back migration job %s; reconnect or continue that job instead of creating a second lineage", item.JobID)
	}
	return nil
}

type customerIOCrossJobSubscriberIdentity struct {
	JobID    string
	Metadata map[string]interface{}
}

// validateCustomerIOSubscriberWorkspaceLineage prevents a legacy or bypassed
// second job from claiming an immutable cio_id already owned by the same
// tenant/region/workspace lineage. Normal API creation already enforces a
// single lineage; this write-side guard keeps direct workers and old jobs safe.
func validateCustomerIOSubscriberWorkspaceLineage(ctx context.Context, db *sql.DB, tenantID, jobID string, sub canonical.Subscriber) (err error) {
	if sub.SourcePlatform != canonical.SourceCustomerIO {
		return nil
	}
	tenantID = strings.TrimSpace(tenantID)
	jobID = strings.TrimSpace(jobID)
	sourceID := strings.TrimSpace(sub.SourceID)
	email := strings.ToLower(strings.TrimSpace(sub.Email))
	if db == nil || tenantID == "" || jobID == "" || sourceID == "" || email == "" {
		return fmt.Errorf("Customer.io subscriber lineage guard requires tenant, job, stable cio_id, and email")
	}

	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)

	var workspaceFingerprint string
	if err := tx.QueryRowContext(ctx, `
SELECT COALESCE(cursor ->> 'customerio_workspace_fingerprint', '')
  FROM migration_jobs
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND source = 'customerio'
`, tenantID, jobID).Scan(&workspaceFingerprint); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("Customer.io subscriber lineage guard cannot prove the current migration job/workspace binding")
		}
		return fmt.Errorf("load current Customer.io migration workspace binding: %w", err)
	}
	decoded, decodeErr := hex.DecodeString(workspaceFingerprint)
	if decodeErr != nil || len(decoded) != sha256.Size || workspaceFingerprint != strings.ToLower(workspaceFingerprint) {
		return fmt.Errorf("Customer.io subscriber lineage guard cannot prove the current migration job/workspace binding")
	}

	rows, err := tx.QueryContext(ctx, `
SELECT imported.job_id::text, imported.destination_metadata
  FROM migration_imported_resources AS imported
  JOIN migration_jobs AS lineage_job
    ON lineage_job.tenant_id = imported.tenant_id
   AND lineage_job.id = imported.job_id
 WHERE imported.tenant_id = $1::uuid
   AND imported.job_id <> $2::uuid
   AND imported.resource_type = 'subscriber'
   AND imported.source_platform = 'customerio'
   AND imported.source_id = $3
   AND imported.rolled_back_at IS NULL
   AND lineage_job.source = 'customerio'
   AND lineage_job.status <> 'rolled_back'
   AND lineage_job.cursor ->> 'customerio_workspace_fingerprint' = $4
 ORDER BY imported.created_at ASC, imported.id ASC
 LIMIT $5
 FOR UPDATE OF imported
`, tenantID, jobID, sourceID, workspaceFingerprint, maxCustomerIOCrossJobSubscriberIdentities+1)
	if err != nil {
		return fmt.Errorf("load cross-job Customer.io subscriber lineage: %w", err)
	}
	defer func() { _ = rows.Close() }()

	evidence := make([]customerIOCrossJobSubscriberIdentity, 0)
	for rows.Next() {
		if len(evidence) >= maxCustomerIOCrossJobSubscriberIdentities {
			return fmt.Errorf("Customer.io stable cio_id exceeds the bounded cross-job lineage inventory; reconcile prior migrations before retrying")
		}
		var item customerIOCrossJobSubscriberIdentity
		var raw []byte
		if err := rows.Scan(&item.JobID, &raw); err != nil {
			return fmt.Errorf("scan cross-job Customer.io subscriber lineage: %w", err)
		}
		if err := json.Unmarshal(raw, &item.Metadata); err != nil {
			return fmt.Errorf("decode cross-job Customer.io subscriber lineage: %w", err)
		}
		evidence = append(evidence, item)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("load cross-job Customer.io subscriber lineage: %w", err)
	}
	return validateCustomerIOCrossJobSubscriberEvidence(email, evidence)
}

func validateCustomerIOCrossJobSubscriberEvidence(email string, evidence []customerIOCrossJobSubscriberIdentity) error {
	email = strings.ToLower(strings.TrimSpace(email))
	for _, item := range evidence {
		if value, present := item.Metadata["postwave_source_snapshot_present"]; present && !metadataBoolValue(value) {
			continue
		}
		if value, present := item.Metadata["postwave_source_identity_owned"]; present && !metadataBoolValue(value) {
			continue
		}
		trackedEmail, _ := item.Metadata["email"].(string)
		trackedEmail = strings.ToLower(strings.TrimSpace(trackedEmail))
		if trackedEmail == "" {
			return fmt.Errorf("Customer.io stable cio_id has incomplete cross-job destination evidence; reconcile migration job %s before retrying", item.JobID)
		}
		if trackedEmail != email {
			return fmt.Errorf("Customer.io stable cio_id is active at a different destination email in unrolled-back migration job %s; reconnect that job and run its full-snapshot delta before retrying", item.JobID)
		}
		return fmt.Errorf("Customer.io stable cio_id is already owned by unrolled-back migration job %s; reconnect or continue that job instead of creating a second lineage", item.JobID)
	}
	return nil
}

// validateIncrementalSubscriberEmailIdentity runs while the caller holds the
// tenant subscriber batch lease. It only accepts an incremental profile write
// when every active, source-owned ledger row for that stable provider identity
// already targets the same email. Snapshot-reconciled historical rows carry
// postwave_source_snapshot_present=false and no longer block later replay.
func validateIncrementalSubscriberEmailIdentity(ctx context.Context, db *sql.DB, tenantID, jobID string, sub canonical.Subscriber) (err error) {
	tenantID = strings.TrimSpace(tenantID)
	jobID = strings.TrimSpace(jobID)
	sourceID := strings.TrimSpace(sub.SourceID)
	email := strings.ToLower(strings.TrimSpace(sub.Email))
	if db == nil || tenantID == "" || jobID == "" || sourceID == "" || sub.SourcePlatform == "" || email == "" {
		return fmt.Errorf("incremental subscriber email-identity guard requires tenant, job, source platform, stable source id, and email")
	}

	tx, err := beginTenantTx(ctx, db, tenantID)
	if err != nil {
		return err
	}
	defer commitTx(tx, &err)

	rows, err := tx.QueryContext(ctx, `
SELECT destination_id, destination_metadata
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid
   AND job_id = $2::uuid
   AND resource_type = 'subscriber'
   AND source_platform = $3
   AND source_id = $4
   AND rolled_back_at IS NULL
 ORDER BY created_at ASC, id ASC
`, tenantID, jobID, string(sub.SourcePlatform), sourceID)
	if err != nil {
		return fmt.Errorf("load incremental subscriber source identity: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var evidence []map[string]interface{}
	for rows.Next() {
		var destinationID string
		var raw []byte
		if err := rows.Scan(&destinationID, &raw); err != nil {
			return fmt.Errorf("scan incremental subscriber source identity: %w", err)
		}
		var metadata map[string]interface{}
		if err := json.Unmarshal(raw, &metadata); err != nil {
			return fmt.Errorf("decode incremental subscriber source identity: %w", err)
		}
		if len(evidence) >= 1024 {
			return fmt.Errorf("incremental subscriber source identity has too many ledger destinations; run a full source snapshot before replay")
		}
		evidence = append(evidence, metadata)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("load incremental subscriber source identity: %w", err)
	}
	return validateIncrementalSubscriberEmailEvidence(email, evidence)
}

func validateIncrementalSubscriberEmailEvidence(email string, evidence []map[string]interface{}) error {
	email = strings.ToLower(strings.TrimSpace(email))
	active := 0
	for _, metadata := range evidence {
		if value, present := metadata["postwave_source_snapshot_present"]; present && !metadataBoolValue(value) {
			continue
		}
		if value, present := metadata["postwave_source_identity_owned"]; present && !metadataBoolValue(value) {
			continue
		}
		trackedEmail, _ := metadata["email"].(string)
		trackedEmail = strings.ToLower(strings.TrimSpace(trackedEmail))
		if trackedEmail == "" {
			return fmt.Errorf("incremental subscriber source identity has incomplete destination evidence; run a full source snapshot before replay")
		}
		if trackedEmail != email {
			return fmt.Errorf("incremental subscriber source identity changed email while its prior source-owned destination remains active; run a full source snapshot before replay")
		}
		active++
		if active > 1 {
			return fmt.Errorf("incremental subscriber source identity has multiple active destinations; run a full source snapshot before replay")
		}
	}
	return nil
}

func metadataBoolValue(value interface{}) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}
