// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceretention

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type DBRepository struct{ Pool *db.Pool }

var _ Repository = (*DBRepository)(nil)

func NewRepository(pool *db.Pool) (*DBRepository, error) {
	if pool == nil {
		return nil, ErrInvalidConfiguration
	}
	return &DBRepository{Pool: pool}, nil
}

// Ready proves the three retention tables are forced-RLS tables and that the
// connection does not bypass RLS. Version/key deletion must never be run from
// a privileged application connection.
func (r *DBRepository) Ready(ctx context.Context) error {
	if r == nil || r.Pool == nil {
		return ErrInvalidConfiguration
	}
	var ready, privileged bool
	err := r.Pool.QueryRow(ctx, `
SELECT COUNT(*) = 3 AND bool_and(c.relrowsecurity) AND bool_and(c.relforcerowsecurity),
       COALESCE(bool_or(current_setting('is_superuser') = 'on' OR role.rolbypassrls), true)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles role ON role.rolname = current_user
 WHERE n.nspname = 'public'
   AND c.relname = ANY($1::text[])`, []string{
		"campaign_assurance_raw_output_retention_tasks",
		"campaign_assurance_raw_output_version_receipts",
		"campaign_assurance_raw_output_retention_receipts",
	}).Scan(&ready, &privileged)
	if err != nil || !ready || privileged {
		return fmt.Errorf("%w: v2013 forced-RLS schema and restricted role are required", ErrInvalidConfiguration)
	}
	return nil
}

func (r *DBRepository) ClaimExpired(
	ctx context.Context,
	workerID string,
	limit int,
	leaseTTL time.Duration,
) ([]Claim, error) {
	workerID = strings.TrimSpace(workerID)
	if r == nil || r.Pool == nil || workerID == "" || len(workerID) > 200 ||
		limit < 1 || limit > 500 || leaseTTL < 10*time.Second || leaseTTL > 30*time.Minute {
		return nil, ErrInvalidConfiguration
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Discovery is bounded independently of claiming. The grouping rejects
	// conflicting hashes/expirations for one key and snapshots all campaign
	// scopes so a later campaign cascade cannot erase hold provenance.
	if _, err := tx.Exec(ctx, `
WITH candidates AS (
    SELECT extraction.tenant_id,
           extraction.raw_output_object_ref AS object_ref,
           min(extraction.raw_output_hash) AS raw_output_sha256,
           min(extraction.raw_output_expires_at) AS raw_output_expires_at,
           (array_agg(extraction.id ORDER BY extraction.created_at, extraction.id))[1] AS source_extraction_id,
           (array_agg(extraction.receipt_hash ORDER BY extraction.created_at, extraction.id))[1] AS source_receipt_sha256,
           encode(digest(convert_to(
               string_agg(extraction.id::text || ':' || extraction.receipt_hash, ','
                          ORDER BY extraction.id::text), 'UTF8'), 'sha256'), 'hex') AS source_manifest_sha256,
           array_agg(DISTINCT extraction.campaign_id ORDER BY extraction.campaign_id) AS campaign_ids,
           encode(digest(convert_to(
               array_to_string(array_agg(DISTINCT extraction.campaign_id ORDER BY extraction.campaign_id), ','),
               'UTF8'), 'sha256'), 'hex') AS campaign_scope_sha256
      FROM campaign_assurance_extractions extraction
     WHERE extraction.raw_output_object_ref IS NOT NULL
       AND extraction.raw_output_hash IS NOT NULL
       AND extraction.raw_output_expires_at IS NOT NULL
     GROUP BY extraction.tenant_id, extraction.raw_output_object_ref
    HAVING count(DISTINCT extraction.raw_output_hash) = 1
       AND count(DISTINCT extraction.raw_output_expires_at) = 1
       AND max(extraction.raw_output_expires_at) <= statement_timestamp()
       AND bool_and(NOT campaign_assurance_legal_hold_active(
            extraction.tenant_id, extraction.campaign_id
       ))
     ORDER BY min(extraction.raw_output_expires_at), extraction.tenant_id,
              extraction.raw_output_object_ref
     LIMIT $1
)
INSERT INTO campaign_assurance_raw_output_retention_tasks (
    tenant_id, object_ref, object_ref_sha256, raw_output_sha256,
    raw_output_expires_at, source_extraction_id, source_receipt_sha256,
    source_manifest_sha256, campaign_ids, campaign_scope_sha256
)
SELECT tenant_id, object_ref,
       encode(digest(convert_to(object_ref, 'UTF8'), 'sha256'), 'hex'),
       raw_output_sha256, raw_output_expires_at, source_extraction_id,
       source_receipt_sha256, source_manifest_sha256, campaign_ids,
       campaign_scope_sha256
  FROM candidates
ON CONFLICT (tenant_id, object_ref) DO NOTHING`, limit); err != nil {
		return nil, fmt.Errorf("discover expired raw output: %w", err)
	}

	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT task.tenant_id, task.id
      FROM campaign_assurance_raw_output_retention_tasks task
     WHERE task.raw_output_expires_at <= statement_timestamp()
       AND (
            (task.state IN ('pending', 'retry')
                AND (task.retry_not_before IS NULL OR task.retry_not_before <= statement_timestamp()))
            OR (task.state = 'leased' AND task.lease_expires_at <= statement_timestamp())
       )
       AND NOT EXISTS (
            SELECT 1
              FROM campaign_assurance_raw_output_retention_receipts receipt
             WHERE receipt.tenant_id = task.tenant_id AND receipt.task_id = task.id
               AND receipt.outcome = 'deleted'
       )
       AND NOT EXISTS (
            SELECT 1 FROM unnest(task.campaign_ids) AS held_campaign(campaign_id)
             WHERE campaign_assurance_legal_hold_active(
                task.tenant_id, held_campaign.campaign_id
             )
       )
       AND NOT EXISTS (
            SELECT 1
              FROM campaign_assurance_extractions extraction
             WHERE extraction.tenant_id = task.tenant_id
               AND extraction.raw_output_object_ref = task.object_ref
               AND (
                    extraction.raw_output_hash IS DISTINCT FROM task.raw_output_sha256
                    OR extraction.raw_output_expires_at IS NULL
                    OR extraction.raw_output_expires_at > statement_timestamp()
                    OR campaign_assurance_legal_hold_active(
                        extraction.tenant_id, extraction.campaign_id
                    )
               )
       )
     ORDER BY task.raw_output_expires_at, task.tenant_id, task.id
     LIMIT $1
     FOR UPDATE SKIP LOCKED
), claimed AS (
    UPDATE campaign_assurance_raw_output_retention_tasks task
       SET state = 'leased', attempt_count = task.attempt_count + 1,
           lease_token = gen_random_uuid(), lease_owner = $2,
           lease_expires_at = statement_timestamp() + $3::interval,
           retry_not_before = NULL, last_failure_code = NULL
      FROM candidates
     WHERE task.tenant_id = candidates.tenant_id AND task.id = candidates.id
    RETURNING task.*
)
SELECT tenant_id::text, id::text, object_ref, object_ref_sha256,
       raw_output_sha256, source_manifest_sha256, campaign_scope_sha256,
       raw_output_expires_at, attempt_count, lease_token::text, lease_expires_at
  FROM claimed
 ORDER BY raw_output_expires_at, tenant_id, id`, limit, workerID, leaseTTL.String())
	if err != nil {
		return nil, fmt.Errorf("claim expired raw output: %w", err)
	}
	defer rows.Close()
	claims := make([]Claim, 0, limit)
	for rows.Next() {
		var claim Claim
		if err := rows.Scan(&claim.TenantID, &claim.TaskID, &claim.ObjectReference,
			&claim.ObjectReferenceHash, &claim.RawOutputHash, &claim.SourceManifestHash,
			&claim.CampaignScopeHash, &claim.ExpiresAt, &claim.Attempt,
			&claim.LeaseToken, &claim.LeaseExpiresAt); err != nil {
			return nil, err
		}
		claim.ObjectKey, err = parseObjectReference(claim.ObjectReference)
		if err != nil {
			return nil, err
		}
		claim, err = normalizeClaim(claim)
		if err != nil {
			return nil, err
		}
		claims = append(claims, claim)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claims, nil
}

func (r *DBRepository) LoadVersion(ctx context.Context, raw Claim) (*VersionIdentity, error) {
	claim, err := normalizeClaim(raw)
	if err != nil || r == nil || r.Pool == nil {
		return nil, ErrInvalidIdentity
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var backend, bucket, versionID, contentHash, proofHash, receiptHash pgtype.Text
	var byteSize pgtype.Int8
	err = tx.QueryRow(ctx, `
SELECT version.storage_backend, version.bucket, version.storage_version_id,
       version.content_sha256, version.byte_size, version.provider_proof_sha256,
       version.receipt_hash
  FROM campaign_assurance_raw_output_retention_tasks task
  LEFT JOIN campaign_assurance_raw_output_version_receipts version
    ON version.tenant_id = task.tenant_id AND version.task_id = task.id
 WHERE task.tenant_id = $1::uuid AND task.id = $2::uuid
   AND task.state = 'leased' AND task.attempt_count = $3
   AND task.lease_token = $4::uuid AND task.lease_expires_at > statement_timestamp()`,
		claim.TenantID, claim.TaskID, claim.Attempt, claim.LeaseToken).Scan(
		&backend, &bucket, &versionID, &contentHash, &byteSize, &proofHash, &receiptHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrLeaseLost
	}
	if err != nil {
		return nil, err
	}
	if !backend.Valid {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, nil
	}
	version := VersionIdentity{
		Backend: backend.String, Bucket: bucket.String, ObjectKey: claim.ObjectKey,
		VersionID: versionID.String, ContentSHA256: contentHash.String,
		ByteSize: byteSize.Int64, ProviderProofSHA256: proofHash.String,
		ReceiptHash: receiptHash.String,
	}
	version, err = normalizeVersion(claim, version)
	if err != nil {
		return nil, ErrIdentityConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &version, nil
}

func (r *DBRepository) RecordVersion(
	ctx context.Context,
	rawClaim Claim,
	rawVersion VersionIdentity,
) (VersionIdentity, error) {
	claim, err := normalizeClaim(rawClaim)
	if err != nil || r == nil || r.Pool == nil {
		return VersionIdentity{}, ErrInvalidIdentity
	}
	if rawVersion.ReceiptHash != "" {
		return VersionIdentity{}, ErrInvalidIdentity
	}
	version, err := normalizeVersion(claim, rawVersion)
	if err != nil {
		return VersionIdentity{}, err
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return VersionIdentity{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var receiptHash string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_raw_output_version_receipts (
    tenant_id, task_id, attempt_no, resolved_by_claim_token,
    storage_backend, bucket, storage_version_id, content_sha256, byte_size,
    provider_proof_sha256, object_ref_sha256, storage_version_sha256, receipt_hash
) VALUES (
    $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13
)
ON CONFLICT (tenant_id, task_id) DO NOTHING
RETURNING receipt_hash`, claim.TenantID, claim.TaskID, claim.Attempt, claim.LeaseToken,
		version.Backend, version.Bucket, version.VersionID, version.ContentSHA256,
		version.ByteSize, version.ProviderProofSHA256, claim.ObjectReferenceHash,
		sha256Hex(version.VersionID), strings.Repeat("0", 64)).Scan(&receiptHash)
	if errors.Is(err, pgx.ErrNoRows) {
		var stored VersionIdentity
		err = tx.QueryRow(ctx, `
SELECT storage_backend, bucket, storage_version_id, content_sha256, byte_size,
       provider_proof_sha256, receipt_hash
  FROM campaign_assurance_raw_output_version_receipts
 WHERE tenant_id = $1::uuid AND task_id = $2::uuid`, claim.TenantID, claim.TaskID).Scan(
			&stored.Backend, &stored.Bucket, &stored.VersionID, &stored.ContentSHA256,
			&stored.ByteSize, &stored.ProviderProofSHA256, &stored.ReceiptHash)
		stored.ObjectKey = claim.ObjectKey
		if err != nil || stored.Backend != version.Backend || stored.Bucket != version.Bucket ||
			stored.ObjectKey != version.ObjectKey || stored.VersionID != version.VersionID ||
			stored.ContentSHA256 != version.ContentSHA256 || stored.ByteSize != version.ByteSize ||
			stored.ProviderProofSHA256 != version.ProviderProofSHA256 {
			return VersionIdentity{}, ErrIdentityConflict
		}
		receiptHash = stored.ReceiptHash
	} else if err != nil {
		return VersionIdentity{}, fmt.Errorf("record exact raw-output version: %w", err)
	}
	version.ReceiptHash = receiptHash
	if err := tx.Commit(ctx); err != nil {
		return VersionIdentity{}, err
	}
	return version, nil
}

func (r *DBRepository) RecordFailure(
	ctx context.Context,
	rawClaim Claim,
	code string,
	cause error,
	workerID string,
	retryAfter time.Duration,
) error {
	claim, err := normalizeClaim(rawClaim)
	if err != nil || r == nil || r.Pool == nil || retryAfter < time.Second || retryAfter > 24*time.Hour {
		return ErrInvalidIdentity
	}
	code, failureHash, err := normalizeFailure(code, cause)
	if err != nil {
		return err
	}
	workerID = strings.TrimSpace(workerID)
	if workerID == "" || len(workerID) > 200 {
		return ErrInvalidIdentity
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := insertAttemptReceipt(ctx, tx, claim, attemptReceipt{
		Outcome: "failure", FailureCode: code, FailureHash: failureHash,
		WorkerHash: sha256Hex(workerID),
	}); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
UPDATE campaign_assurance_raw_output_retention_tasks
   SET state = 'retry', lease_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, retry_not_before = statement_timestamp() + $5::interval,
       last_failure_code = $6
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'leased'
   AND attempt_count = $3 AND lease_token = $4::uuid`, claim.TenantID, claim.TaskID,
		claim.Attempt, claim.LeaseToken, retryAfter.String(), code)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return tx.Commit(ctx)
}

func (r *DBRepository) DeleteUnderLegalHoldFence(
	ctx context.Context,
	rawClaim Claim,
	rawVersion VersionIdentity,
	workerID string,
	retryAfter time.Duration,
	deleteExact func(context.Context) (DeleteResult, error),
) (AttemptOutcome, error) {
	claim, err := normalizeClaim(rawClaim)
	if err != nil || r == nil || r.Pool == nil || deleteExact == nil ||
		retryAfter < time.Second || retryAfter > 24*time.Hour {
		return AttemptOutcome{}, ErrInvalidIdentity
	}
	version, err := normalizeVersion(claim, rawVersion)
	if err != nil || !hashPattern.MatchString(version.ReceiptHash) {
		return AttemptOutcome{}, ErrInvalidIdentity
	}
	workerID = strings.TrimSpace(workerID)
	if workerID == "" || len(workerID) > 200 {
		return AttemptOutcome{}, ErrInvalidIdentity
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return AttemptOutcome{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// This lock key is exactly the one migration 2013's legal-hold trigger
	// takes. It remains held while the bounded external exact-version call runs.
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(
    hashtextextended('campaign-assurance-raw-output:' || $1::uuid::text, 0)
)`, claim.TenantID); err != nil {
		return AttemptOutcome{}, err
	}
	var authorized bool
	err = tx.QueryRow(ctx, `
SELECT task.state = 'leased'
   AND task.attempt_count = $3
   AND task.lease_token = $4::uuid
   AND task.lease_expires_at > statement_timestamp()
   AND task.raw_output_expires_at <= statement_timestamp()
   AND version.receipt_hash = $5
   AND version.storage_version_sha256 = $6
   AND NOT EXISTS (
        SELECT 1 FROM unnest(task.campaign_ids) AS held_campaign(campaign_id)
         WHERE campaign_assurance_legal_hold_active(
            task.tenant_id, held_campaign.campaign_id
         )
   )
   AND NOT EXISTS (
        SELECT 1 FROM campaign_assurance_extractions extraction
         WHERE extraction.tenant_id = task.tenant_id
           AND extraction.raw_output_object_ref = task.object_ref
           AND (
                extraction.raw_output_hash IS DISTINCT FROM task.raw_output_sha256
                OR extraction.raw_output_expires_at IS NULL
                OR extraction.raw_output_expires_at > statement_timestamp()
                OR campaign_assurance_legal_hold_active(
                    extraction.tenant_id, extraction.campaign_id
                )
           )
   )
  FROM campaign_assurance_raw_output_retention_tasks task
  JOIN campaign_assurance_raw_output_version_receipts version
    ON version.tenant_id = task.tenant_id AND version.task_id = task.id
 WHERE task.tenant_id = $1::uuid AND task.id = $2::uuid
 FOR UPDATE OF task`, claim.TenantID, claim.TaskID, claim.Attempt, claim.LeaseToken,
		version.ReceiptHash, sha256Hex(version.VersionID)).Scan(&authorized)
	if errors.Is(err, pgx.ErrNoRows) {
		return AttemptOutcome{}, ErrLeaseLost
	}
	if err != nil {
		return AttemptOutcome{}, err
	}
	if !authorized {
		cause := ErrDeletionNotAuthorized
		if err := insertAttemptReceipt(ctx, tx, claim, attemptReceipt{
			Outcome: "deferred", FailureCode: "legal_hold_or_reference_conflict",
			FailureHash: sha256Hex(cause.Error()), WorkerHash: sha256Hex(workerID),
		}); err != nil {
			return AttemptOutcome{}, err
		}
		if err := releaseForRetry(ctx, tx, claim, "legal_hold_or_reference_conflict", retryAfter); err != nil {
			return AttemptOutcome{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return AttemptOutcome{}, err
		}
		return AttemptOutcome{Outcome: "deferred", FailureCode: "legal_hold_or_reference_conflict"}, nil
	}

	result, deleteErr := deleteExact(ctx)
	if deleteErr == nil {
		deleteErr = validateDeleteResult(version, result)
	}
	if deleteErr != nil {
		code := stableFailureCode(deleteErr)
		if errors.Is(deleteErr, ErrUnprovenDeletionResponse) {
			code = "exact_delete_unproven"
		}
		if err := insertAttemptReceipt(ctx, tx, claim, attemptReceipt{
			Outcome: "failure", VersionReceiptHash: version.ReceiptHash,
			RequestedVersionHash: sha256Hex(version.VersionID), FailureCode: code,
			FailureHash: sha256Hex(deleteErr.Error()), WorkerHash: sha256Hex(workerID),
		}); err != nil {
			return AttemptOutcome{}, err
		}
		if err := releaseForRetry(ctx, tx, claim, code, retryAfter); err != nil {
			return AttemptOutcome{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return AttemptOutcome{}, err
		}
		return AttemptOutcome{Outcome: "failure", FailureCode: code}, deleteErr
	}

	receipt := attemptReceipt{
		Outcome: "deleted", VersionReceiptHash: version.ReceiptHash,
		RequestedVersionHash: sha256Hex(version.VersionID),
		Disposition:          result.Disposition, DeleteMarker: result.DeleteMarker,
		WorkerHash: sha256Hex(workerID),
	}
	if result.ResponseVersion != "" {
		receipt.ResponseVersionHash = sha256Hex(result.ResponseVersion)
	}
	if result.ProviderRequestIDHash != "" {
		receipt.ProviderRequestHash = result.ProviderRequestIDHash
	}
	if err := insertAttemptReceipt(ctx, tx, claim, receipt); err != nil {
		return AttemptOutcome{}, err
	}
	tag, err := tx.Exec(ctx, `
UPDATE campaign_assurance_raw_output_retention_tasks
   SET state = 'complete', lease_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, retry_not_before = NULL, last_failure_code = NULL,
       completed_at = statement_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'leased'
   AND attempt_count = $3 AND lease_token = $4::uuid`, claim.TenantID, claim.TaskID,
		claim.Attempt, claim.LeaseToken)
	if err != nil {
		return AttemptOutcome{}, err
	}
	if tag.RowsAffected() != 1 {
		return AttemptOutcome{}, ErrLeaseLost
	}
	if err := tx.Commit(ctx); err != nil {
		return AttemptOutcome{}, err
	}
	return AttemptOutcome{Outcome: "deleted", Disposition: result.Disposition}, nil
}

type attemptReceipt struct {
	Outcome              string
	VersionReceiptHash   string
	RequestedVersionHash string
	ResponseVersionHash  string
	Disposition          string
	DeleteMarker         bool
	ProviderRequestHash  string
	FailureCode          string
	FailureHash          string
	WorkerHash           string
}

func insertAttemptReceipt(ctx context.Context, tx pgx.Tx, claim Claim, receipt attemptReceipt) error {
	_, err := tx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_retention_receipts (
    tenant_id, task_id, attempt_no, claim_token, outcome,
    object_ref_sha256, raw_output_sha256, source_manifest_sha256,
    campaign_scope_sha256, version_receipt_hash, requested_version_sha256,
    response_version_sha256, delete_disposition, delete_marker,
    provider_request_id_sha256, failure_code, failure_sha256,
    worker_id_sha256, receipt_hash
) VALUES (
    $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9,
    NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), $14,
    NULLIF($15, ''), NULLIF($16, ''), NULLIF($17, ''), $18, $19
)`, claim.TenantID, claim.TaskID, claim.Attempt, claim.LeaseToken, receipt.Outcome,
		claim.ObjectReferenceHash, claim.RawOutputHash, claim.SourceManifestHash,
		claim.CampaignScopeHash, receipt.VersionReceiptHash, receipt.RequestedVersionHash,
		receipt.ResponseVersionHash, receipt.Disposition, receipt.DeleteMarker,
		receipt.ProviderRequestHash, receipt.FailureCode, receipt.FailureHash,
		receipt.WorkerHash, strings.Repeat("0", 64))
	if err != nil {
		return fmt.Errorf("append raw-output retention receipt: %w", err)
	}
	return nil
}

func releaseForRetry(
	ctx context.Context,
	tx pgx.Tx,
	claim Claim,
	code string,
	retryAfter time.Duration,
) error {
	tag, err := tx.Exec(ctx, `
UPDATE campaign_assurance_raw_output_retention_tasks
   SET state = 'retry', lease_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, retry_not_before = statement_timestamp() + $5::interval,
       last_failure_code = $6
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'leased'
   AND attempt_count = $3 AND lease_token = $4::uuid`, claim.TenantID, claim.TaskID,
		claim.Attempt, claim.LeaseToken, retryAfter.String(), code)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrLeaseLost
	}
	return nil
}

func validateDeleteResult(version VersionIdentity, result DeleteResult) error {
	if result.Disposition != DispositionDeleted && result.Disposition != DispositionAlreadyMissing {
		return ErrUnprovenDeletionResponse
	}
	if result.ResponseVersion != "" && result.ResponseVersion != version.VersionID {
		return ErrUnprovenDeletionResponse
	}
	if len(result.ResponseVersion) > 1024 || strings.ContainsAny(result.ResponseVersion, "\x00\r\n") ||
		result.ProviderRequestIDHash != "" && !hashPattern.MatchString(result.ProviderRequestIDHash) {
		return ErrUnprovenDeletionResponse
	}
	return nil
}
