// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrLeaseLost      = errors.New("pii_scanner: scan lease lost")
	ErrSubscriberGone = errors.New("pii_scanner: subscriber no longer exists")
)

const (
	DefaultScanMaxAttempts       = 8
	MaxRepairBatch               = 200
	MaxReconcileBatch            = 500
	MaxScanSubscriberBytes       = 4 << 20
	maxCoverageFieldNameBytes    = 1024
	maxCoverageStoredFieldBytes  = 256 << 10
	maxCoverageStoredJSONBytes   = 2 << 20
	maxCoverageScanContractBytes = 512
	maxCoverageScanContracts     = 32
	scannerAvailabilityHeartbeat = 5 * time.Second
	scannerAvailabilityGrace     = 20 * time.Second
	minLeaseTTL                  = time.Second
	maxLeaseTTL                  = 10 * time.Minute
)

func optionalCoverageScanContract(scanContracts []string) (string, error) {
	if len(scanContracts) > 1 {
		return "", ErrInvalidInput
	}
	if len(scanContracts) == 0 {
		return "", nil
	}
	contract := strings.TrimSpace(scanContracts[0])
	if len(contract) > maxCoverageScanContractBytes || strings.ContainsAny(contract, "\x00\r\n") {
		return "", ErrInvalidInput
	}
	if contract != "" {
		if _, ok := parseCoverageScanContract(contract); !ok {
			return "", ErrInvalidInput
		}
	}
	return contract, nil
}

func requiredCoverageScanContract(scanContract string) (string, error) {
	contract, err := optionalCoverageScanContract([]string{scanContract})
	if err != nil || contract == "" {
		return "", ErrInvalidInput
	}
	return contract, nil
}

type coverageContractMetadata struct {
	ScannerName           string
	ScannerVersion        string
	DetectorName          string
	DetectorVersion       string
	PolicyName            string
	PolicyVersion         string
	FingerprintScheme     string
	FingerprintKeyVersion string
	KeyCommitment         string
}

func parseCoverageNameVersion(component, prefix string) (string, string, bool) {
	value, found := strings.CutPrefix(component, prefix+"=")
	if !found {
		return "", "", false
	}
	name, version, split := strings.Cut(value, "@")
	if !split || !fingerprintKeyVersionRE.MatchString(name) || !fingerprintKeyVersionRE.MatchString(version) {
		return "", "", false
	}
	return name, version, true
}

func parseCoverageScanContract(scanContract string) (coverageContractMetadata, bool) {
	var metadata coverageContractMetadata
	parts := strings.Split(scanContract, "|")
	if len(parts) != 5 {
		return metadata, false
	}
	seen := map[string]bool{}
	for _, component := range parts {
		switch {
		case strings.HasPrefix(component, "scanner="):
			if seen["scanner"] {
				return metadata, false
			}
			seen["scanner"] = true
			var ok bool
			metadata.ScannerName, metadata.ScannerVersion, ok = parseCoverageNameVersion(component, "scanner")
			if !ok {
				return metadata, false
			}
		case strings.HasPrefix(component, "detector="):
			if seen["detector"] {
				return metadata, false
			}
			seen["detector"] = true
			var ok bool
			metadata.DetectorName, metadata.DetectorVersion, ok = parseCoverageNameVersion(component, "detector")
			if !ok {
				return metadata, false
			}
		case strings.HasPrefix(component, "policy="):
			if seen["policy"] {
				return metadata, false
			}
			seen["policy"] = true
			var ok bool
			metadata.PolicyName, metadata.PolicyVersion, ok = parseCoverageNameVersion(component, "policy")
			if !ok {
				return metadata, false
			}
		case strings.HasPrefix(component, "fingerprint="):
			if seen["fingerprint"] {
				return metadata, false
			}
			seen["fingerprint"] = true
			var ok bool
			metadata.FingerprintScheme, metadata.FingerprintKeyVersion, ok = parseCoverageNameVersion(component, "fingerprint")
			if !ok || metadata.FingerprintScheme != FingerprintSchemeHMACSHA256V1 ||
				metadata.FingerprintKeyVersion == LegacyFingerprintKeyVersion {
				return metadata, false
			}
		case strings.HasPrefix(component, "key_commitment="+FingerprintSchemeHMACSHA256V1+":"):
			if seen["key_commitment"] {
				return metadata, false
			}
			seen["key_commitment"] = true
			metadata.KeyCommitment = strings.TrimPrefix(component, "key_commitment="+FingerprintSchemeHMACSHA256V1+":")
			if !isFullFingerprint(metadata.KeyCommitment) {
				return metadata, false
			}
		default:
			return metadata, false
		}
	}
	return metadata, len(seen) == 5
}

func coverageKeyAttestation(scanContract string) (string, string, bool) {
	metadata, ok := parseCoverageScanContract(scanContract)
	return metadata.FingerprintKeyVersion, metadata.KeyCommitment, ok
}

func coverageFingerprintIdentity(scanContract string) (string, string, bool) {
	metadata, ok := parseCoverageScanContract(scanContract)
	return metadata.FingerprintScheme, metadata.FingerprintKeyVersion, ok
}

func normalizeLeaseTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return 2 * time.Minute
	}
	if ttl < minLeaseTTL {
		return minLeaseTTL
	}
	if ttl > maxLeaseTTL {
		return maxLeaseTTL
	}
	return ttl
}

var allowedScanErrorCodes = map[string]bool{
	"scanner_unavailable":         true,
	"database_unavailable":        true,
	"detector_failure":            true,
	"scan_truncated":              true,
	"lease_lost":                  true,
	"invalid_subscriber_snapshot": true,
	"internal_failure":            true,
}

// recordDetectionsTx is the transaction-sharing form used by the durable
// worker so findings and the processed-revision watermark commit atomically.
func recordDetectionsTx(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string, dets []Detection) (int, error) {
	inserted := 0
	for _, det := range dets {
		if !IsValidDetectionType(string(det.DetectedType)) {
			return 0, ErrInvalidInput
		}
		det.FieldName = strings.TrimSpace(det.FieldName)
		det.Fingerprint = strings.ToLower(strings.TrimSpace(det.Fingerprint))
		det.FingerprintScheme = strings.TrimSpace(det.FingerprintScheme)
		det.FingerprintKeyVersion = strings.TrimSpace(det.FingerprintKeyVersion)
		if det.FieldName == "" || utf8.RuneCountInString(det.FieldName) > 256 || det.Confidence < 0 || det.Confidence > 1 ||
			!isFullFingerprint(det.Fingerprint) || det.FingerprintScheme != FingerprintSchemeHMACSHA256V1 ||
			!fingerprintKeyVersionRE.MatchString(det.FingerprintKeyVersion) || det.FingerprintKeyVersion == LegacyFingerprintKeyVersion ||
			det.ScannerName != ScannerName || det.ScannerVersion != ScannerVersion ||
			det.DetectorName != DetectorName || det.DetectorVersion != DetectorVersion ||
			det.PolicyName != PolicyName || det.PolicyVersion != PolicyVersion {
			return 0, ErrInvalidInput
		}
		var isInsert bool
		err := tx.QueryRow(ctx, `
WITH upsert AS (
    INSERT INTO subscriber_pii_findings
           (tenant_id, subscriber_id, field_name, detected_type, confidence, raw_value_hash,
            fingerprint_scheme, fingerprint_key_version,
            scanner_name, scanner_version, detector_name, detector_version, policy_name, policy_version)
    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (tenant_id, subscriber_id, field_name, detected_type, raw_value_hash,
                 fingerprint_scheme, fingerprint_key_version,
                 scanner_name, scanner_version, detector_name, detector_version,
                 policy_name, policy_version)
    DO NOTHING
    RETURNING (xmax = 0) AS is_insert
)
SELECT COALESCE(bool_or(is_insert), false) FROM upsert`,
			tenantID, subscriberID, det.FieldName, string(det.DetectedType),
			det.Confidence, det.Fingerprint, det.FingerprintScheme, det.FingerprintKeyVersion,
			ScannerName, ScannerVersion, DetectorName, DetectorVersion, PolicyName, PolicyVersion).Scan(&isInsert)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && (pgErr.Code == "22P02" || pgErr.Code == "23503") {
				return 0, ErrInvalidInput
			}
			return 0, err
		}
		if isInsert {
			inserted++
		}
	}
	return inserted, nil
}

// ClaimScanIntents atomically leases a bounded cross-tenant batch. No
// subscriber value is selected in worker scope; returned rows are UUID and
// revision metadata only.
func (r *Repo) ClaimScanIntents(ctx context.Context, ownerID string, leaseTTL time.Duration, limit int, expectedScanContract string) ([]ScanIntent, error) {
	owner, err := uuid.Parse(strings.TrimSpace(ownerID))
	if err != nil {
		return nil, ErrInvalidInput
	}
	expectedScanContract, err = requiredCoverageScanContract(expectedScanContract)
	if err != nil {
		return nil, err
	}
	leaseTTL = normalizeLeaseTTL(leaseTTL)
	if limit < 1 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Claims and config disable share a tenant advisory fence. Selecting only the
	// first bounded due window avoids an O(tenant-count) lock sweep; stable UUID
	// order prevents cross-tenant batch deadlocks. A disable that wins before the
	// shared lock is visible to the claim statement's newer READ COMMITTED
	// snapshot, while a claim that wins is fully committed and revocable before
	// the disable transaction can return.
	tenantRows, err := tx.Query(ctx, `
WITH due AS (
    SELECT intent.tenant_id
      FROM subscriber_pii_scan_intents intent
      JOIN tenant_pii_scan_coverage coverage
        ON coverage.tenant_id = intent.tenant_id
     WHERE coverage.scan_enabled
       AND coverage.status NOT IN ('disabled', 'unavailable')
       AND coverage.scan_contract = $1
       AND (
           (intent.status IN ('pending', 'retry_wait') AND intent.available_at <= now())
           OR (intent.status = 'leased' AND intent.lease_expires_at <= now())
       )
     ORDER BY intent.available_at, intent.first_enqueued_at,
              intent.tenant_id, intent.subscriber_id
     LIMIT 100
)
SELECT DISTINCT tenant_id::text
  FROM due
 ORDER BY tenant_id`, expectedScanContract)
	if err != nil {
		return nil, err
	}
	claimTenantIDs := []string{}
	for tenantRows.Next() {
		var tenantID string
		if err := tenantRows.Scan(&tenantID); err != nil {
			tenantRows.Close()
			return nil, err
		}
		claimTenantIDs = append(claimTenantIDs, tenantID)
	}
	if err := tenantRows.Err(); err != nil {
		tenantRows.Close()
		return nil, err
	}
	tenantRows.Close()
	if len(claimTenantIDs) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return []ScanIntent{}, nil
	}
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock_shared(fence.lock_key)
  FROM (
      SELECT hashtextextended(tenant_id::text, 1762) AS lock_key
        FROM unnest($1::uuid[]) tenant_id
       ORDER BY tenant_id
  ) fence`, claimTenantIDs); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
WITH exhausted_candidates AS (
    SELECT intent.tenant_id, intent.subscriber_id
      FROM subscriber_pii_scan_intents intent
      JOIN tenant_pii_scan_coverage coverage
        ON coverage.tenant_id = intent.tenant_id
     WHERE coverage.scan_enabled
       AND coverage.status NOT IN ('disabled', 'unavailable')
       AND coverage.scan_contract = $4
       AND intent.tenant_id = ANY($5::uuid[])
       AND intent.attempts >= intent.max_attempts
       AND (
           (intent.status IN ('pending', 'retry_wait') AND intent.available_at <= now())
           OR (intent.status = 'leased' AND intent.lease_expires_at <= now())
       )
     ORDER BY intent.available_at, intent.first_enqueued_at,
              intent.tenant_id, intent.subscriber_id
     FOR UPDATE OF intent SKIP LOCKED
     LIMIT 100
), exhausted AS (
    UPDATE subscriber_pii_scan_intents intent
       SET status = 'dead_letter',
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           claimed_revision = NULL, claimed_generation = NULL,
           last_error_code = CASE WHEN intent.status = 'leased' THEN 'lease_lost' ELSE 'internal_failure' END,
           dead_lettered_at = now(), updated_at = now()
      FROM exhausted_candidates candidate
     WHERE intent.tenant_id = candidate.tenant_id
       AND intent.subscriber_id = candidate.subscriber_id
    RETURNING intent.tenant_id, intent.subscriber_id, intent.last_error_code
), exhausted_states AS (
    UPDATE subscriber_pii_scan_states state
       SET state = 'dead_letter', last_error_code = exhausted.last_error_code,
           last_failure_at = now(), updated_at = now()
      FROM exhausted
     WHERE state.tenant_id = exhausted.tenant_id
       AND state.subscriber_id = exhausted.subscriber_id
    RETURNING state.tenant_id
), candidates AS (
    SELECT intent.tenant_id, intent.subscriber_id, coverage.generation
      FROM subscriber_pii_scan_intents intent
      JOIN tenant_pii_scan_coverage coverage
        ON coverage.tenant_id = intent.tenant_id
     WHERE coverage.scan_enabled
       AND coverage.status NOT IN ('disabled', 'unavailable')
       AND coverage.scan_contract = $4
       AND intent.tenant_id = ANY($5::uuid[])
       AND intent.attempts < intent.max_attempts
       AND (
           (intent.status IN ('pending', 'retry_wait') AND intent.available_at <= now())
           OR
           (intent.status = 'leased' AND intent.lease_expires_at <= now())
       )
     ORDER BY intent.available_at, intent.first_enqueued_at,
              intent.tenant_id, intent.subscriber_id
     FOR UPDATE OF intent SKIP LOCKED
     LIMIT $3
), claimed AS (
    UPDATE subscriber_pii_scan_intents intent
       SET status = 'leased',
           attempts = intent.attempts + 1,
           target_generation = GREATEST(intent.target_generation, candidates.generation),
           lease_owner = $1::uuid,
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
           claimed_revision = intent.target_revision,
           claimed_generation = GREATEST(intent.target_generation, candidates.generation),
           last_claimed_at = now(),
           last_error_code = NULL,
           dead_lettered_at = NULL,
           updated_at = now()
      FROM candidates
     WHERE intent.tenant_id = candidates.tenant_id
       AND intent.subscriber_id = candidates.subscriber_id
    RETURNING intent.tenant_id, intent.subscriber_id,
              intent.target_revision, intent.target_generation,
              intent.claimed_revision, intent.claimed_generation,
              intent.attempts, intent.max_attempts,
              intent.lease_owner::text, intent.lease_token::text,
              intent.lease_expires_at
), claimed_states AS (
    UPDATE subscriber_pii_scan_states state
       SET state = 'leased', last_attempt_at = now(), updated_at = now()
      FROM claimed
     WHERE state.tenant_id = claimed.tenant_id
       AND state.subscriber_id = claimed.subscriber_id
    RETURNING state.tenant_id
), changed_tenants AS (
    SELECT tenant_id, bool_or(degraded) AS degraded
      FROM (
          SELECT exhausted.tenant_id, true AS degraded FROM exhausted
          UNION ALL
          SELECT claimed.tenant_id, false AS degraded FROM claimed
      ) changed
     GROUP BY tenant_id
), changed_coverage AS (
    UPDATE tenant_pii_scan_coverage coverage
       SET snapshot_exact = false,
           status = CASE
               WHEN NOT coverage.scan_enabled THEN 'disabled'
               WHEN coverage.status = 'unavailable' THEN 'unavailable'
               WHEN changed.degraded THEN 'degraded'
               ELSE 'catching_up'
           END,
           dirty_epoch = dirty_epoch + 1,
           reconciliation_requested_at = CASE
               WHEN coverage.status = 'unavailable' THEN coverage.reconciliation_requested_at
               ELSE now()
           END,
           updated_at = now()
      FROM changed_tenants changed
     WHERE coverage.tenant_id = changed.tenant_id
       AND coverage.scan_enabled
       AND coverage.status NOT IN ('disabled', 'unavailable')
       AND coverage.scan_contract = $4
    RETURNING coverage.tenant_id
)
SELECT tenant_id::text, subscriber_id::text, target_revision, target_generation,
       claimed_revision, claimed_generation, attempts, max_attempts,
       lease_owner::text, lease_token::text, lease_expires_at,
       changed_coverage.tenant_id IS NOT NULL AS claim_still_enabled
  FROM claimed
  LEFT JOIN changed_coverage USING (tenant_id)`, owner.String(), leaseTTL.Milliseconds(), limit, expectedScanContract, claimTenantIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	intents := []ScanIntent{}
	claimCrossedDisable := false
	for rows.Next() {
		var intent ScanIntent
		var claimStillEnabled bool
		intent.ScanContract = expectedScanContract
		if err := rows.Scan(
			&intent.TenantID, &intent.SubscriberID,
			&intent.TargetRevision, &intent.TargetGeneration,
			&intent.ClaimedRevision, &intent.ClaimedGeneration,
			&intent.Attempts, &intent.MaxAttempts,
			&intent.LeaseOwner, &intent.LeaseToken, &intent.LeaseExpiresAt,
			&claimStillEnabled,
		); err != nil {
			return nil, err
		}
		claimCrossedDisable = claimCrossedDisable || !claimStillEnabled
		intents = append(intents, intent)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if claimCrossedDisable {
		// The config transition committed while this statement was waiting for the
		// tenant coverage row. Roll back every lease in this rare mixed batch rather
		// than returning even one value-fetch capability from an obsolete snapshot.
		if err := tx.Rollback(ctx); err != nil {
			return nil, err
		}
		return []ScanIntent{}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return intents, nil
}

func (r *Repo) RenewScanLease(ctx context.Context, intent ScanIntent, leaseTTL time.Duration) error {
	if !validScanLease(intent) {
		return ErrInvalidInput
	}
	leaseTTL = normalizeLeaseTTL(leaseTTL)
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cmd, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_intents
   SET lease_expires_at = now() + ($7::bigint * interval '1 millisecond'),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND status = 'leased' AND lease_owner = $3::uuid AND lease_token = $4::uuid
   AND claimed_revision = $5 AND claimed_generation = $6
   AND EXISTS (
       SELECT 1 FROM tenant_pii_scan_coverage coverage
        WHERE coverage.tenant_id = subscriber_pii_scan_intents.tenant_id
          AND coverage.scan_enabled
          AND coverage.status NOT IN ('disabled', 'unavailable')
          AND coverage.generation = $6
          AND coverage.scan_contract = $8
   )
   AND lease_expires_at > now()`,
		intent.TenantID, intent.SubscriberID, intent.LeaseOwner, intent.LeaseToken,
		intent.ClaimedRevision, intent.ClaimedGeneration, leaseTTL.Milliseconds(), intent.ScanContract)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

// LoadClaimedSubscriberSnapshot fetches the current revision and bounded
// current-profile projection only while the exact durable lease and tenant
// coverage contract remain executable. It locks subscriber -> intent ->
// coverage before touching values, so a disable must either revoke the lease
// first (and this returns ErrLeaseLost without projecting data) or wait for this
// bounded fetch to finish before the opt-out transaction can return.
func (r *Repo) LoadClaimedSubscriberSnapshot(ctx context.Context, intent ScanIntent) (*SubscriberSnapshot, error) {
	if !validScanLease(intent) {
		return nil, ErrInvalidInput
	}
	return r.loadSubscriberSnapshot(ctx, intent.TenantID, intent.SubscriberID, &intent)
}

// loadSubscriberSnapshot is the projection primitive kept unexported so the
// production worker cannot accidentally bypass lease validation. Tests use a
// nil claim only to exercise projection bounds independently of queue timing.
func (r *Repo) loadSubscriberSnapshot(ctx context.Context, tenantID, subscriberID string, claim *ScanIntent) (*SubscriberSnapshot, error) {
	options := pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
	if claim != nil {
		// The claimed path takes a SHARE lock on the subscriber before reading
		// revision/projection values, so READ COMMITTED is both consistent and
		// materially safer than REPEATABLE READ here. Under REPEATABLE READ, an
		// unrelated concurrent coverage update between the subscriber lock and
		// coverage authorization can raise SQLSTATE 40001 and strand healthy
		// intents in retry_wait. SHARE blocks every subscriber UPDATE/DELETE while
		// remaining compatible across parallel scanners for the same tenant.
		options = pgx.TxOptions{IsoLevel: pgx.ReadCommitted, AccessMode: pgx.ReadWrite}
	}
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, options)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var revision int64
	revisionSQL := `
SELECT GREATEST(pii_scan_revision, 1)
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`
	if claim != nil {
		revisionSQL += ` FOR SHARE`
	}
	if err := tx.QueryRow(ctx, revisionSQL, tenantID, subscriberID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSubscriberGone
		}
		return nil, err
	}
	if claim != nil {
		var liveLease bool
		if err := tx.QueryRow(ctx, `
SELECT true
  FROM subscriber_pii_scan_intents intent
  JOIN tenant_pii_scan_coverage coverage
    ON coverage.tenant_id = intent.tenant_id
 WHERE intent.tenant_id = $1::uuid AND intent.subscriber_id = $2::uuid
   AND intent.status = 'leased'
   AND intent.lease_owner = $3::uuid AND intent.lease_token = $4::uuid
   AND intent.claimed_revision = $5 AND intent.claimed_generation = $6
   AND intent.lease_expires_at > now()
   AND coverage.scan_enabled
   AND coverage.status NOT IN ('disabled', 'unavailable')
   AND coverage.generation = $6 AND coverage.scan_contract = $7
 FOR SHARE OF intent, coverage`, claim.TenantID, claim.SubscriberID,
			claim.LeaseOwner, claim.LeaseToken, claim.ClaimedRevision,
			claim.ClaimedGeneration, claim.ScanContract).Scan(&liveLease); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrLeaseLost
			}
			return nil, err
		}
	}

	rows, err := tx.Query(ctx, `
WITH subscriber AS MATERIALIZED (
    SELECT first_name, last_name, full_name, display_name,
           unsubscribe_reason, tags, custom_fields, merge_fields,
           groups, gdpr_permissions, activity_summary,
           source_id, source_platform, external_id, timezone, locale,
           language, country, region
      FROM subscribers
     WHERE tenant_id = $1::uuid AND id = $2::uuid
), object_documents AS MATERIALIZED (
    SELECT document.namespace, document.body
      FROM subscriber s
      CROSS JOIN LATERAL (VALUES
          ('custom_fields'::text, COALESCE(s.custom_fields, '{}'::jsonb)),
          ('merge_fields'::text, COALESCE(s.merge_fields, '{}'::jsonb)),
          ('subscriber.activity_summary'::text, COALESCE(s.activity_summary, '{}'::jsonb))
      ) document(namespace, body)
), array_documents AS MATERIALIZED (
    SELECT document.namespace, document.body
      FROM subscriber s
      CROSS JOIN LATERAL (VALUES
          ('subscriber.groups'::text, COALESCE(s.groups, '[]'::jsonb)),
          ('subscriber.gdpr_permissions'::text, COALESCE(s.gdpr_permissions, '[]'::jsonb))
      ) document(namespace, body)
), projected AS (
    SELECT fixed.field_name,
           CASE WHEN pg_column_size(COALESCE(fixed.field_value, '')) > $7
                THEN '' ELSE left(COALESCE(fixed.field_value, ''), $3) END AS field_value,
           false AS declared,
           pg_column_size(COALESCE(fixed.field_value, '')) > $7 AS source_truncated
      FROM subscriber s
      CROSS JOIN LATERAL (VALUES
          ('subscriber.first_name'::text, s.first_name::text),
          ('subscriber.last_name'::text, s.last_name::text),
          ('subscriber.full_name'::text, s.full_name::text),
          ('subscriber.display_name'::text, s.display_name::text),
          ('subscriber.unsubscribe_reason'::text, s.unsubscribe_reason::text),
          ('subscriber.source_id'::text, s.source_id::text),
          ('subscriber.source_platform'::text, s.source_platform::text),
          ('subscriber.external_id'::text, s.external_id::text),
          ('subscriber.timezone'::text, s.timezone::text),
          ('subscriber.locale'::text, s.locale::text),
          ('subscriber.language'::text, s.language::text),
          ('subscriber.country'::text, s.country::text),
          ('subscriber.region'::text, s.region::text)
      ) fixed(field_name, field_value)

    UNION ALL
    SELECT 'subscriber.tags[' || tag.ordinality::text || ']',
           CASE WHEN pg_column_size(tag.value) > $7 THEN '' ELSE left(tag.value, $3) END,
           false,
           pg_column_size(tag.value) > $7
      FROM subscriber s
      CROSS JOIN LATERAL unnest(
          CASE WHEN pg_column_size(s.tags) <= $8 AND cardinality(s.tags) <= 1024
               THEN s.tags ELSE '{}'::text[] END
      ) WITH ORDINALITY tag(value, ordinality)
    UNION ALL
    SELECT 'subscriber.tags', '', false, true
      FROM subscriber s
     WHERE pg_column_size(s.tags) > $8 OR cardinality(s.tags) > 1024

    UNION ALL
    SELECT document.namespace || '.' || left(entry.key, $6),
           CASE
               WHEN pg_column_size(entry.value) > $7 THEN ''
               WHEN jsonb_typeof(entry.value) = 'string' THEN left(entry.value #>> '{}', $3)
               ELSE left(entry.value::text, $3)
           END,
           CASE WHEN document.namespace = 'custom_fields' THEN EXISTS (
               SELECT 1 FROM tenant_custom_fields field
                WHERE field.tenant_id = $1::uuid AND field.key = entry.key
                  AND (COALESCE(field.config, '{}'::jsonb) @> '{"pii_flag": true}'::jsonb
                       OR lower(COALESCE(field.config ->> 'data_classification', '')) IN ('pii','phi','pci','sensitive'))
           ) ELSE false END,
           pg_column_size(entry.value) > $7
      FROM object_documents document
      CROSS JOIN LATERAL jsonb_each(
          CASE WHEN pg_column_size(document.body) <= $8
                     AND jsonb_typeof(document.body) = 'object'
               THEN document.body ELSE '{}'::jsonb END
      ) entry
    UNION ALL
    SELECT document.namespace, '', false, true
      FROM object_documents document
     WHERE pg_column_size(document.body) > $8
        OR jsonb_typeof(document.body) IS DISTINCT FROM 'object'

    UNION ALL
    SELECT document.namespace || '[' || entry.ordinality::text || ']',
           CASE
               WHEN pg_column_size(entry.value) > $7 THEN ''
               WHEN jsonb_typeof(entry.value) = 'string' THEN left(entry.value #>> '{}', $3)
               ELSE left(entry.value::text, $3)
           END,
           false,
           pg_column_size(entry.value) > $7
      FROM array_documents document
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN pg_column_size(document.body) <= $8
                     AND jsonb_typeof(document.body) = 'array'
               THEN document.body ELSE '[]'::jsonb END
      ) WITH ORDINALITY entry(value, ordinality)
    UNION ALL
    SELECT document.namespace, '', false, true
      FROM array_documents document
     WHERE pg_column_size(document.body) > $8
        OR jsonb_typeof(document.body) IS DISTINCT FROM 'array'
), bounded_candidates AS MATERIALIZED (
    SELECT field_name, field_value, declared, source_truncated
      FROM projected
     WHERE source_truncated OR NULLIF(btrim(field_value), '') IS NOT NULL
     ORDER BY field_name
     LIMIT ($4 + 1)
), candidate_count AS (
    SELECT count(*)::integer AS value FROM bounded_candidates
)
SELECT substring(convert_to(candidate.field_name, 'UTF8') from 1 for $6) AS field_name_bytes,
       substring(convert_to(candidate.field_value, 'UTF8') from 1 for $3) AS field_bytes,
       candidate.declared,
       candidate.source_truncated OR octet_length(candidate.field_value) > $5 AS transport_truncated,
       candidate_count.value AS candidate_fields
  FROM bounded_candidates candidate
 CROSS JOIN candidate_count
 LIMIT $4`, tenantID, subscriberID, MaxScanFieldBytes+1, MaxScanFields, MaxScanFieldBytes,
		maxCoverageFieldNameBytes+1, maxCoverageStoredFieldBytes, maxCoverageStoredJSONBytes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := map[string]any{}
	declared := map[string]bool{}
	usedNames := map[string]bool{}
	candidateFields := 0
	transportTruncated := false
	transportBytes := 0
	for rows.Next() {
		var rawNameBytes, value []byte
		var isDeclared, fieldTruncated bool
		var total int
		if err := rows.Scan(&rawNameBytes, &value, &isDeclared, &fieldTruncated, &total); err != nil {
			return nil, err
		}
		rawName, _ := boundedUTF8(string(rawNameBytes), maxCoverageFieldNameBytes)
		name := uniqueCoverageFieldName(rawName, usedNames)
		if transportBytes+len(value) > MaxScanSubscriberBytes {
			transportTruncated = true
			candidateFields = total
			rows.Close()
			break
		}
		fields[name] = string(value)
		transportBytes += len(value)
		if isDeclared {
			declared[name] = true
		}
		candidateFields = total
		transportTruncated = transportTruncated || fieldTruncated
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &SubscriberSnapshot{
		Revision:           revision,
		Fields:             fields,
		Declared:           declared,
		CandidateFields:    candidateFields,
		TransportBytes:     transportBytes,
		TransportTruncated: transportTruncated,
	}, nil
}

func safeCoverageFieldName(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '_'
		}
		return r
	}, strings.TrimSpace(value))
	runes := []rune(value)
	if len(runes) > 256 {
		runes = runes[:256]
	}
	if len(runes) == 0 {
		return "unnamed_field"
	}
	return string(runes)
}

func uniqueCoverageFieldName(value string, used map[string]bool) string {
	base := safeCoverageFieldName(value)
	if !used[base] {
		used[base] = true
		return base
	}
	for suffixNumber := 2; ; suffixNumber++ {
		suffix := fmt.Sprintf("#%d", suffixNumber)
		prefix := []rune(base)
		if keep := 256 - utf8.RuneCountInString(suffix); len(prefix) > keep {
			prefix = prefix[:keep]
		}
		candidate := string(prefix) + suffix
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
}

func validScanLease(intent ScanIntent) bool {
	_, tenantErr := uuid.Parse(strings.TrimSpace(intent.TenantID))
	_, subscriberErr := uuid.Parse(strings.TrimSpace(intent.SubscriberID))
	_, ownerErr := uuid.Parse(strings.TrimSpace(intent.LeaseOwner))
	_, tokenErr := uuid.Parse(strings.TrimSpace(intent.LeaseToken))
	_, contractErr := requiredCoverageScanContract(intent.ScanContract)
	return tenantErr == nil && subscriberErr == nil && ownerErr == nil && tokenErr == nil && contractErr == nil &&
		intent.ClaimedRevision >= 1 && intent.ClaimedGeneration >= 0
}

func applySnapshotCoverageLimits(snapshot *SubscriberSnapshot, result *ScanResult) error {
	if snapshot == nil || result == nil {
		return ErrInvalidInput
	}
	candidateFields := snapshot.CandidateFields
	// Compatibility for internal callers that construct a snapshot directly.
	// Production snapshots carry a bounded count: MaxScanFields+1 means "at
	// least one field over the limit," not the exact cardinality of a larger row.
	if candidateFields == 0 && len(snapshot.Fields) > 0 {
		candidateFields = len(snapshot.Fields)
	}
	if candidateFields < len(snapshot.Fields) {
		return ErrInvalidInput
	}
	if candidateFields > MaxScanFields {
		result.FieldsOverLimit = candidateFields - MaxScanFields
		result.Truncated = true
	}
	if snapshot.TransportTruncated {
		result.Truncated = true
	}
	return nil
}

// CompleteScan commits findings and the revision/generation watermark in one
// tenant transaction. A concurrent subscriber write only raises the target;
// completion leaves that newer target pending rather than falsely covering it.
func (r *Repo) CompleteScan(ctx context.Context, intent ScanIntent, snapshot *SubscriberSnapshot, result ScanResult, fingerprintKeyVersion string) (int, bool, error) {
	fingerprintKeyVersion = strings.TrimSpace(fingerprintKeyVersion)
	if snapshot == nil || snapshot.Revision < intent.ClaimedRevision || !validScanLease(intent) ||
		!fingerprintKeyVersionRE.MatchString(fingerprintKeyVersion) || fingerprintKeyVersion == LegacyFingerprintKeyVersion {
		return 0, false, ErrInvalidInput
	}
	for _, detection := range result.Detections {
		if detection.FingerprintScheme != FingerprintSchemeHMACSHA256V1 ||
			detection.FingerprintKeyVersion != fingerprintKeyVersion {
			return 0, false, ErrInvalidInput
		}
	}
	if err := applySnapshotCoverageLimits(snapshot, &result); err != nil {
		return 0, false, ErrInvalidInput
	}
	tx, err := db.WithTenant(ctx, r.Pool, intent.TenantID)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Hold the subscriber parent before any child lease/state lock. This both
	// makes erasure win cleanly before work starts and prevents an FK-cascade
	// delete from interleaving with intent -> state mutations.
	var subscriberPresent bool
	if err := tx.QueryRow(ctx, `
SELECT true FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR KEY SHARE`, intent.TenantID, intent.SubscriberID).Scan(&subscriberPresent); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, ErrLeaseLost
		}
		return 0, false, err
	}
	var targetRevision, targetGeneration int64
	if err := tx.QueryRow(ctx, `
SELECT intent.target_revision, intent.target_generation
  FROM subscriber_pii_scan_intents intent
  JOIN tenant_pii_scan_coverage coverage ON coverage.tenant_id = intent.tenant_id
 WHERE intent.tenant_id = $1::uuid AND intent.subscriber_id = $2::uuid
	AND intent.status = 'leased' AND intent.lease_owner = $3::uuid AND intent.lease_token = $4::uuid
	AND intent.claimed_revision = $5 AND intent.claimed_generation = $6
	AND coverage.scan_enabled
	AND coverage.status NOT IN ('disabled', 'unavailable')
	AND coverage.generation = $6
	AND coverage.scan_contract = $7
	AND intent.lease_expires_at > now()
 FOR UPDATE OF intent, coverage`, intent.TenantID, intent.SubscriberID, intent.LeaseOwner, intent.LeaseToken,
		intent.ClaimedRevision, intent.ClaimedGeneration, intent.ScanContract).Scan(&targetRevision, &targetGeneration); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, ErrLeaseLost
		}
		return 0, false, err
	}
	inserted, err := recordDetectionsTx(ctx, tx, intent.TenantID, intent.SubscriberID, result.Detections)
	if err != nil {
		return 0, false, err
	}
	// "clean" is the persisted compatibility code for no findings in this
	// bounded current-profile projection; it is never a whole-profile-history
	// or tenant-content certification.
	outcome := "clean"
	state := "scanned"
	if len(result.Detections) > 0 {
		outcome, state = "findings", "findings"
	}
	needsMore := targetRevision > snapshot.Revision || targetGeneration > intent.ClaimedGeneration
	if result.Truncated {
		outcome, state, needsMore = "truncated", "truncated", false
	} else if needsMore {
		state = "pending"
	}
	cmd, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_states
   SET observed_revision = GREATEST(observed_revision, $3),
       scanned_revision = GREATEST(scanned_revision, $3),
       scanned_generation = GREATEST(scanned_generation, $4),
       state = $5,
       last_outcome = $6,
       last_error_code = CASE WHEN $6 = 'truncated' THEN 'scan_truncated' ELSE NULL END,
       fields_scanned = $7,
       fields_declared = $8,
       fields_reserved = $9,
       fields_over_limit = $10,
       detections_retained = $11,
       scanner_name = $12, scanner_version = $13,
       detector_name = $14, detector_version = $15,
       policy_name = $16, policy_version = $17,
       fingerprint_scheme = $18, fingerprint_key_version = $19,
       last_scanned_at = now(),
       last_failure_at = CASE WHEN $6 = 'truncated' THEN now() ELSE last_failure_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		intent.TenantID, intent.SubscriberID, snapshot.Revision, intent.ClaimedGeneration,
		state, outcome, result.FieldsScanned, result.FieldsDeclared, result.FieldsReserved,
		result.FieldsOverLimit, len(result.Detections), ScannerName, ScannerVersion,
		DetectorName, DetectorVersion, PolicyName, PolicyVersion,
		FingerprintSchemeHMACSHA256V1, fingerprintKeyVersion)
	if err != nil {
		return 0, false, err
	}
	if cmd.RowsAffected() != 1 {
		return 0, false, ErrSubscriberGone
	}

	if result.Truncated {
		cmd, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_intents
   SET status = 'dead_letter', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       claimed_revision = NULL, claimed_generation = NULL,
       last_error_code = 'scan_truncated', dead_lettered_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND status = 'leased' AND lease_owner = $3::uuid AND lease_token = $4::uuid
   AND claimed_revision = $5 AND claimed_generation = $6
   AND lease_expires_at > now()`, intent.TenantID, intent.SubscriberID, intent.LeaseOwner,
			intent.LeaseToken, intent.ClaimedRevision, intent.ClaimedGeneration)
		if err != nil {
			return 0, false, err
		}
		if cmd.RowsAffected() != 1 {
			return 0, false, ErrLeaseLost
		}
	} else if needsMore {
		cmd, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_intents
   SET status = 'pending', attempts = 0, available_at = now(),
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       claimed_revision = NULL, claimed_generation = NULL,
       last_error_code = NULL, dead_lettered_at = NULL, updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND status = 'leased' AND lease_owner = $3::uuid AND lease_token = $4::uuid
   AND claimed_revision = $5 AND claimed_generation = $6
   AND lease_expires_at > now()`, intent.TenantID, intent.SubscriberID, intent.LeaseOwner,
			intent.LeaseToken, intent.ClaimedRevision, intent.ClaimedGeneration)
		if err != nil {
			return 0, false, err
		}
		if cmd.RowsAffected() != 1 {
			return 0, false, ErrLeaseLost
		}
	} else {
		cmd, err := tx.Exec(ctx, `
DELETE FROM subscriber_pii_scan_intents
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND status = 'leased' AND lease_owner = $3::uuid AND lease_token = $4::uuid
   AND claimed_revision = $5 AND claimed_generation = $6
   AND lease_expires_at > now()
   AND target_revision <= $7 AND target_generation <= $8`,
			intent.TenantID, intent.SubscriberID, intent.LeaseOwner, intent.LeaseToken,
			intent.ClaimedRevision, intent.ClaimedGeneration,
			snapshot.Revision, intent.ClaimedGeneration)
		if err != nil {
			return 0, false, err
		}
		if cmd.RowsAffected() != 1 {
			return 0, false, ErrLeaseLost
		}
	}
	if _, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       status = CASE
           WHEN NOT scan_enabled THEN 'disabled'
           WHEN status = 'unavailable' THEN 'unavailable'
           WHEN $2 THEN 'degraded'
           ELSE 'catching_up'
       END,
       reconciliation_requested_at = CASE WHEN scan_enabled THEN now() ELSE reconciliation_requested_at END,
       last_scanned_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid`, intent.TenantID, result.Truncated); err != nil {
		return 0, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, false, err
	}
	return inserted, needsMore, nil
}

func (r *Repo) FailScanIntent(ctx context.Context, intent ScanIntent, code string, retryAt time.Time) (bool, error) {
	if !validScanLease(intent) {
		return false, ErrInvalidInput
	}
	if !allowedScanErrorCodes[code] {
		code = "internal_failure"
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var attempts, maxAttempts int
	if err := tx.QueryRow(ctx, `
SELECT attempts, max_attempts
  FROM subscriber_pii_scan_intents
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND status = 'leased' AND lease_owner = $3::uuid AND lease_token = $4::uuid
   AND claimed_revision = $5 AND claimed_generation = $6
   AND lease_expires_at > now()
 FOR UPDATE`, intent.TenantID, intent.SubscriberID, intent.LeaseOwner, intent.LeaseToken,
		intent.ClaimedRevision, intent.ClaimedGeneration).Scan(&attempts, &maxAttempts); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, ErrLeaseLost
		}
		return false, err
	}
	dead := attempts >= maxAttempts
	status := "retry_wait"
	if dead {
		status = "dead_letter"
	}
	if retryAt.IsZero() {
		retryAt = time.Now().UTC()
	}
	cmd, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_intents
   SET status = $7,
       available_at = $8,
       lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
       claimed_revision = NULL, claimed_generation = NULL,
       last_error_code = $9,
       dead_lettered_at = CASE WHEN $7 = 'dead_letter' THEN now() ELSE NULL END,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND status = 'leased' AND lease_owner = $3::uuid AND lease_token = $4::uuid
   AND claimed_revision = $5 AND claimed_generation = $6
   AND lease_expires_at > now()`, intent.TenantID, intent.SubscriberID,
		intent.LeaseOwner, intent.LeaseToken, intent.ClaimedRevision, intent.ClaimedGeneration,
		status, retryAt, code)
	if err != nil {
		return false, err
	}
	if cmd.RowsAffected() != 1 {
		return false, ErrLeaseLost
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_states
   SET state = $3, last_error_code = $4, last_failure_at = now(), updated_at = now()
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`,
		intent.TenantID, intent.SubscriberID, status, code); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       status = CASE
           WHEN NOT scan_enabled THEN 'disabled'
           WHEN status = 'unavailable' THEN 'unavailable'
           WHEN $2 THEN 'degraded'
           ELSE 'catching_up'
       END,
       reconciliation_requested_at = CASE WHEN scan_enabled THEN now() ELSE reconciliation_requested_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid`, intent.TenantID, dead); err != nil {
		return false, err
	}
	return dead, tx.Commit(ctx)
}

// SetScannerAvailability is a persisted system-state transition. It never
// burns per-row retry budgets while a deployment is missing its dedicated key.
func (r *Repo) SetScannerAvailability(ctx context.Context, available bool, scanContracts ...string) error {
	_, err := r.activateScannerContract(ctx, available, scanContracts...)
	return err
}

// scannerContractFastPath handles the overwhelmingly common steady-state
// tick without taking the deployment-wide runtime row FOR UPDATE. Claims still
// require the exact tenant contract, so a rotation after this read safely
// yields zero work. Only the five-second heartbeat CAS takes a row lock.
func (r *Repo) scannerContractFastPath(ctx context.Context, available bool, scanContract string) (bool, bool, error) {
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return false, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var activeContract *string
	var history []string
	var status string
	var activeRecently, heartbeatDue bool
	if err := tx.QueryRow(ctx, `
SELECT scan_contract, scan_contract_history, availability_status,
       COALESCE(last_available_at > now() - ($1::bigint * interval '1 millisecond'), false),
       COALESCE(last_available_at <= now() - ($2::bigint * interval '1 millisecond'), true)
  FROM pii_scan_runtime_contract
 WHERE singleton`, scannerAvailabilityGrace.Milliseconds(), scannerAvailabilityHeartbeat.Milliseconds()).Scan(
		&activeContract, &history, &status, &activeRecently, &heartbeatDue,
	); err != nil {
		return false, false, err
	}
	handled, accepted := false, false
	switch {
	case available && activeContract != nil && *activeContract == scanContract &&
		status == "available" && activeRecently:
		handled, accepted = true, true
		if heartbeatDue {
			if _, err := tx.Exec(ctx, `
UPDATE pii_scan_runtime_contract
   SET last_available_at = now(), updated_at = now()
 WHERE singleton AND scan_contract = $1 AND availability_status = 'available'
   AND last_available_at <= now() - ($2::bigint * interval '1 millisecond')`,
				scanContract, scannerAvailabilityHeartbeat.Milliseconds()); err != nil {
				return false, false, err
			}
		}
	case available && activeContract != nil && *activeContract != scanContract:
		for _, seen := range history {
			if seen == scanContract {
				handled, accepted = true, false
				break
			}
		}
	case !available && status == "unavailable":
		handled, accepted = true, false
	case !available && status == "available" && activeRecently:
		// Another healthy replica has refreshed the deployment heartbeat within
		// the grace window; this keyless replica cannot declare a fleet outage.
		handled, accepted = true, false
	}
	if err := tx.Commit(ctx); err != nil {
		return false, false, err
	}
	return handled, accepted, nil
}

// activateScannerContract persists availability and returns whether this
// worker's executable contract is the deployment-wide active contract. A false
// result is fail-closed rolling-deploy fencing: the caller must not claim work
// with a stale, already-seen contract.
func (r *Repo) activateScannerContract(ctx context.Context, available bool, scanContracts ...string) (bool, error) {
	forceAvailabilityTransition := len(scanContracts) == 0
	scanContract, err := optionalCoverageScanContract(scanContracts)
	if err != nil {
		return false, err
	}
	if available && scanContract == "" && !forceAvailabilityTransition {
		return false, ErrInvalidInput
	}
	if !forceAvailabilityTransition {
		handled, accepted, fastErr := r.scannerContractFastPath(ctx, available, scanContract)
		if fastErr != nil {
			return false, fastErr
		}
		if handled {
			return accepted, nil
		}
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var activeContract *string
	var contractHistory []string
	var availabilityStatus string
	var activeRecently, heartbeatDue bool
	if err = tx.QueryRow(ctx, `
SELECT scan_contract, scan_contract_history, availability_status,
       COALESCE(last_available_at > now() - ($1::bigint * interval '1 millisecond'), false),
       COALESCE(last_available_at <= now() - ($2::bigint * interval '1 millisecond'), true)
  FROM pii_scan_runtime_contract
 WHERE singleton
 FOR UPDATE`, scannerAvailabilityGrace.Milliseconds(), scannerAvailabilityHeartbeat.Milliseconds()).Scan(
		&activeContract, &contractHistory, &availabilityStatus, &activeRecently, &heartbeatDue,
	); err != nil {
		return false, err
	}
	if contractHistory == nil {
		contractHistory = []string{}
	}
	accepted := true
	contractChanged := false
	if available && scanContract != "" {
		contractChanged = activeContract == nil || *activeContract != scanContract
		if contractChanged {
			alreadySeen := false
			keyConflict := false
			requestedKeyVersion, requestedCommitment, _ := coverageKeyAttestation(scanContract)
			for _, seen := range contractHistory {
				if seen == scanContract {
					alreadySeen = true
					break
				}
				seenKeyVersion, seenCommitment, seenOK := coverageKeyAttestation(seen)
				if seenOK && seenKeyVersion == requestedKeyVersion && seenCommitment != requestedCommitment {
					keyConflict = true
				}
			}
			if alreadySeen || keyConflict || len(contractHistory) >= maxCoverageScanContracts {
				if alreadySeen || keyConflict {
					accepted = false
				} else {
					// Retain a bounded rollback window without permanently bricking
					// contract #33. A replica more than 32 provenance transitions old
					// is outside the supported rolling-deployment overlap window.
					contractHistory = append(contractHistory[1:], scanContract)
				}
			} else {
				contractHistory = append(contractHistory, scanContract)
			}
		}
	}
	activeWorker := available && (scanContract == "" || accepted)
	availabilityRecovered := activeWorker && availabilityStatus != "available"
	availabilityLost := !activeWorker && (forceAvailabilityTransition || availabilityStatus == "unknown" ||
		(availabilityStatus == "available" && !activeRecently))
	if activeWorker && (contractChanged || availabilityRecovered || heartbeatDue) {
		var cmd pgconn.CommandTag
		cmd, err = tx.Exec(ctx, `
UPDATE pii_scan_runtime_contract
   SET scan_contract = CASE WHEN $1 = '' THEN scan_contract ELSE $1 END,
       scan_contract_history = $2::text[],
       availability_status = 'available', last_available_at = now(),
       updated_at = now()
 WHERE singleton`, scanContract, contractHistory)
		if err == nil && cmd.RowsAffected() != 1 {
			err = errors.New("pii_scanner: runtime contract singleton missing")
		}
	} else if availabilityLost {
		_, err = tx.Exec(ctx, `
UPDATE pii_scan_runtime_contract
   SET availability_status = 'unavailable', updated_at = now()
 WHERE singleton`)
	}
	if err == nil {
		switch {
		case activeWorker && contractChanged:
			// A genuinely new deployment contract advances every currently
			// enabled tenant exactly once. Config transitions bind the active
			// singleton contract themselves, so this is the only O(tenant-count)
			// path and it runs once per provenance change, never once per tick.
			_, err = tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET generation = generation + CASE WHEN scan_contract IS DISTINCT FROM $1 THEN 1 ELSE 0 END,
       scan_contract = $1,
       status = 'backfill_pending', snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       reconciliation_requested_at = now(),
       backfill_started_at = CASE WHEN scan_contract IS DISTINCT FROM $1 THEN NULL ELSE backfill_started_at END,
       backfill_completed_at = NULL,
       reconcile_lease_owner = NULL, reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL,
       reconcile_cursor = CASE WHEN scan_contract IS DISTINCT FROM $1 THEN NULL ELSE reconcile_cursor END,
       updated_at = now()
	 WHERE scan_enabled`, scanContract)
		case availabilityRecovered:
			// Steady-state ticks use the partial (status, ...) coverage index and
			// touch only rows that a prior unavailable transition invalidated.
			// They do not probe or rewrite the full enabled-tenant population.
			_, err = tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = 'backfill_pending', snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       reconciliation_requested_at = now(),
       backfill_completed_at = NULL,
       reconcile_lease_owner = NULL, reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL, updated_at = now()
	 WHERE scan_enabled AND status = 'unavailable'`)
		case availabilityLost:
			_, err = tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = 'unavailable', snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       reconcile_lease_owner = NULL, reconcile_lease_token = NULL,
       reconcile_lease_expires_at = NULL, updated_at = now()
	 WHERE scan_enabled AND status <> 'unavailable'`)
		}
	}
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return accepted, nil
}

func (r *Repo) RequeueDeadLetters(ctx context.Context, tenantID, subscriberID string, limit int) (int64, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > MaxRepairBatch {
		limit = MaxRepairBatch
	}
	if subscriberID != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(subscriberID))
		if err != nil || parsed.String() != strings.ToLower(strings.TrimSpace(subscriberID)) {
			return 0, ErrInvalidInput
		}
		subscriberID = parsed.String()
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT tenant_id, subscriber_id
      FROM subscriber_pii_scan_intents
     WHERE tenant_id = $1::uuid AND status = 'dead_letter'
       AND ($2 = '' OR subscriber_id = $2::uuid)
     ORDER BY dead_lettered_at, subscriber_id
     FOR UPDATE SKIP LOCKED
     LIMIT $3
), changed AS (
    UPDATE subscriber_pii_scan_intents intent
       SET status = 'pending', attempts = 0, available_at = now(),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           claimed_revision = NULL, claimed_generation = NULL,
           last_error_code = NULL, dead_lettered_at = NULL,
           last_enqueued_at = now(), updated_at = now()
      FROM candidates
     WHERE intent.tenant_id = candidates.tenant_id
       AND intent.subscriber_id = candidates.subscriber_id
    RETURNING intent.subscriber_id
)
SELECT subscriber_id::text FROM changed`, tenantID, subscriberID, limit)
	if err != nil {
		return 0, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE subscriber_pii_scan_states
   SET state = 'pending', last_error_code = NULL, updated_at = now()
	 WHERE tenant_id = $1::uuid AND subscriber_id = ANY($2::uuid[])`, tenantID, ids); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `
UPDATE tenant_pii_scan_coverage
   SET status = CASE WHEN scan_enabled THEN 'catching_up' ELSE 'disabled' END,
       snapshot_exact = false,
       dirty_epoch = dirty_epoch + 1,
       reconciliation_requested_at = CASE WHEN scan_enabled THEN now() ELSE reconciliation_requested_at END,
       updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

func scanFailureCode(err error) string {
	var pgErr *pgconn.PgError
	switch {
	case errors.Is(err, ErrScannerUnavailable):
		return "scanner_unavailable"
	case errors.Is(err, ErrLeaseLost):
		return "lease_lost"
	case errors.Is(err, ErrSubscriberGone):
		return "invalid_subscriber_snapshot"
	case errors.As(err, &pgErr):
		return "database_unavailable"
	default:
		return "internal_failure"
	}
}

func validateRepairInput(in *ScanRepairInput) error {
	if in == nil {
		return ErrInvalidInput
	}
	in.Action = strings.ToLower(strings.TrimSpace(in.Action))
	in.SubscriberID = strings.ToLower(strings.TrimSpace(in.SubscriberID))
	in.Confirmation = strings.TrimSpace(in.Confirmation)
	if in.Confirmation != "REPAIR PII COVERAGE" {
		return fmt.Errorf("%w: confirmation must be REPAIR PII COVERAGE", ErrInvalidInput)
	}
	if in.Limit < 0 || in.Limit > MaxRepairBatch {
		return fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalidInput, MaxRepairBatch)
	}
	switch in.Action {
	case "request_reconciliation":
		if in.SubscriberID != "" {
			return fmt.Errorf("%w: subscriber_id is not accepted for reconciliation", ErrInvalidInput)
		}
	case "requeue_dead_letters":
		if in.SubscriberID != "" {
			parsed, err := uuid.Parse(in.SubscriberID)
			if err != nil || parsed.String() != in.SubscriberID {
				return fmt.Errorf("%w: subscriber_id must be a canonical UUID", ErrInvalidInput)
			}
		}
	default:
		return fmt.Errorf("%w: unsupported repair action", ErrInvalidInput)
	}
	return nil
}
