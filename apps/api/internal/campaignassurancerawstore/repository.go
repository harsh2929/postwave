// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancerawstore

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

func (r *DBRepository) Ready(ctx context.Context) error {
	if r == nil || r.Pool == nil {
		return ErrInvalidConfiguration
	}
	var ready, privileged bool
	err := r.Pool.QueryRow(ctx, `
SELECT count(*) = 3 AND bool_and(c.relrowsecurity) AND bool_and(c.relforcerowsecurity),
       COALESCE(bool_or(current_setting('is_superuser') = 'on' OR role.rolbypassrls), true)
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles role ON role.rolname = current_user
 WHERE n.nspname = 'public'
   AND c.relname = ANY($1::text[])`, []string{
		"campaign_assurance_raw_output_write_intents",
		"campaign_assurance_raw_output_write_receipts",
		"campaign_assurance_raw_output_cleanup_receipts",
	}).Scan(&ready, &privileged)
	if err != nil || !ready || privileged {
		return fmt.Errorf("%w: v2016 forced-RLS schema and restricted role are required", ErrNotReady)
	}
	return nil
}

func (r *DBRepository) BeginWrite(ctx context.Context, raw WriteIntentInput) (WriteIntent, error) {
	input, err := normalizeIntent(raw)
	if err != nil || r == nil || r.Pool == nil {
		return WriteIntent{}, ErrInvalidIdentity
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return WriteIntent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_write_intents (
    tenant_id, id, object_rest, object_key, object_ref, content_sha256,
    checksum_sha256_base64, content_type, byte_size, bucket, kms_key_id_sha256
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (tenant_id, id) DO NOTHING`, input.TenantID, input.IntentID,
		input.ObjectRest, input.ObjectKey, input.ObjectRef, input.ContentSHA256,
		input.ChecksumBase64, input.ContentType, input.ByteSize, input.Bucket, input.KMSKeyIDHash)
	if err != nil {
		return WriteIntent{}, fmt.Errorf("insert raw-output write intent: %w", err)
	}
	intent, err := loadIntent(ctx, tx, input.TenantID, input.ObjectRest, false)
	if err != nil || intent.WriteIntentInput != input || (intent.State != "pending" && intent.State != "ready") {
		if err == nil {
			err = ErrObjectConflict
		}
		return WriteIntent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WriteIntent{}, err
	}
	return intent, nil
}

func (r *DBRepository) RecordVersion(
	ctx context.Context,
	intent WriteIntent,
	raw VersionReceipt,
) (VersionReceipt, error) {
	receipt, err := normalizeReceipt(intent, raw)
	if err != nil || receipt.ReceiptHash != "" || r == nil || r.Pool == nil {
		return VersionReceipt{}, ErrInvalidIdentity
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return VersionReceipt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var receiptHash string
	err = tx.QueryRow(ctx, `
INSERT INTO campaign_assurance_raw_output_write_receipts (
    tenant_id, intent_id, resolved_by_claim_token, storage_backend, bucket,
    object_key, storage_version_id, storage_version_sha256, content_sha256,
    checksum_sha256_base64, content_type, byte_size, kms_key_id_sha256,
    provider_proof_sha256, receipt_hash
) VALUES (
    $1::uuid, $2::uuid, NULLIF($3, '')::uuid, 's3', $4, $5, $6,
    encode(digest(convert_to($6, 'UTF8'), 'sha256'), 'hex'), $7, $8,
    $9, $10, $11, $12, repeat('0', 64)
)
ON CONFLICT (tenant_id, intent_id) DO NOTHING
RETURNING receipt_hash`, receipt.TenantID, receipt.IntentID, intent.LeaseToken,
		receipt.Bucket, receipt.ObjectKey, receipt.VersionID, receipt.ContentSHA256,
		receipt.ChecksumBase64, receipt.ContentType, receipt.ByteSize,
		receipt.KMSKeyIDHash, receipt.ProviderProofHash).Scan(&receiptHash)
	if errors.Is(err, pgx.ErrNoRows) {
		stored, loadErr := loadVersionTx(ctx, tx, receipt.TenantID, receipt.ObjectRest, receipt.ContentSHA256)
		if loadErr != nil || !sameVersion(stored, receipt) {
			return VersionReceipt{}, ErrObjectConflict
		}
		receiptHash = stored.ReceiptHash
	} else if err != nil {
		return VersionReceipt{}, fmt.Errorf("insert exact raw-output write receipt: %w", err)
	}
	receipt.ReceiptHash = receiptHash
	if err := tx.Commit(ctx); err != nil {
		return VersionReceipt{}, err
	}
	return receipt, nil
}

func (r *DBRepository) LoadVersion(
	ctx context.Context,
	tenantID, rest, expectedHash string,
) (VersionReceipt, error) {
	if r == nil || r.Pool == nil {
		return VersionReceipt{}, ErrInvalidConfiguration
	}
	if _, _, _, err := canonicalRest(tenantID, rest); err != nil || expectedHash != "" && !hashPattern.MatchString(expectedHash) {
		return VersionReceipt{}, ErrInvalidIdentity
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return VersionReceipt{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	receipt, err := loadVersionTx(ctx, tx, tenantID, rest, expectedHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return VersionReceipt{}, ErrReceiptUnavailable
	}
	if err != nil {
		return VersionReceipt{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return VersionReceipt{}, err
	}
	return receipt, nil
}

func (r *DBRepository) ClaimCleanup(
	ctx context.Context,
	tenantID, rest, workerID string,
	leaseTTL time.Duration,
) (WriteIntent, error) {
	workerID = strings.TrimSpace(workerID)
	if r == nil || r.Pool == nil || workerID == "" || len(workerID) > 200 ||
		leaseTTL < 10*time.Second || leaseTTL > 30*time.Minute {
		return WriteIntent{}, ErrInvalidConfiguration
	}
	if _, _, _, err := canonicalRest(tenantID, rest); err != nil {
		return WriteIntent{}, err
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return WriteIntent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedTenant, claimedRest string
	err = tx.QueryRow(ctx, `
UPDATE campaign_assurance_raw_output_write_intents intent
   SET state = 'cleanup_leased', attempt_count = intent.attempt_count + 1,
       lease_token = gen_random_uuid(), lease_owner = $3,
       lease_expires_at = statement_timestamp() + $4::interval,
       retry_not_before = NULL, last_failure_code = NULL
 WHERE intent.tenant_id = $1::uuid AND intent.object_rest = $2
   AND (
        intent.state IN ('pending', 'ready', 'cleanup_retry')
        OR (intent.state = 'cleanup_leased' AND intent.lease_expires_at <= statement_timestamp())
   )
   AND NOT EXISTS (
        SELECT 1 FROM campaign_assurance_extractions extraction
         WHERE extraction.tenant_id = intent.tenant_id
           AND extraction.raw_output_object_ref = intent.object_ref
   )
RETURNING intent.tenant_id::text, intent.object_rest`, tenantID, rest, workerID, leaseTTL.String()).Scan(
		&claimedTenant, &claimedRest)
	if errors.Is(err, pgx.ErrNoRows) {
		return WriteIntent{}, ErrCleanupNotAuthorized
	}
	if err != nil {
		return WriteIntent{}, err
	}
	intent, err := loadIntent(ctx, tx, claimedTenant, claimedRest, true)
	if err != nil {
		return WriteIntent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return WriteIntent{}, err
	}
	return intent, nil
}

func (r *DBRepository) ClaimOrphans(
	ctx context.Context,
	workerID string,
	limit int,
	orphanGrace, leaseTTL time.Duration,
) ([]WriteIntent, error) {
	workerID = strings.TrimSpace(workerID)
	if r == nil || r.Pool == nil || workerID == "" || len(workerID) > 200 || limit < 1 || limit > 500 ||
		orphanGrace < time.Minute || orphanGrace > 24*time.Hour || leaseTTL < 10*time.Second || leaseTTL > 30*time.Minute {
		return nil, ErrInvalidConfiguration
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT intent.tenant_id, intent.id
      FROM campaign_assurance_raw_output_write_intents intent
     WHERE (
            (intent.state IN ('pending', 'ready')
                AND intent.created_at <= statement_timestamp() - $2::interval)
            OR (intent.state = 'cleanup_retry'
                AND intent.retry_not_before <= statement_timestamp())
            OR (intent.state = 'cleanup_leased'
                AND intent.lease_expires_at <= statement_timestamp())
       )
       AND NOT EXISTS (
            SELECT 1 FROM campaign_assurance_extractions extraction
             WHERE extraction.tenant_id = intent.tenant_id
               AND extraction.raw_output_object_ref = intent.object_ref
       )
     ORDER BY intent.created_at, intent.tenant_id, intent.id
     LIMIT $1
     FOR UPDATE SKIP LOCKED
), claimed AS (
    UPDATE campaign_assurance_raw_output_write_intents intent
       SET state = 'cleanup_leased', attempt_count = intent.attempt_count + 1,
           lease_token = gen_random_uuid(), lease_owner = $3,
           lease_expires_at = statement_timestamp() + $4::interval,
           retry_not_before = NULL, last_failure_code = NULL
      FROM candidates
     WHERE intent.tenant_id = candidates.tenant_id AND intent.id = candidates.id
    RETURNING intent.tenant_id, intent.id
)
SELECT intent.tenant_id::text, intent.id::text, intent.object_rest, intent.object_key,
       intent.object_ref, intent.content_sha256, intent.checksum_sha256_base64,
       intent.content_type, intent.byte_size, intent.bucket, intent.kms_key_id_sha256,
       intent.state, intent.attempt_count, intent.lease_token::text,
       intent.lease_owner, intent.lease_expires_at, intent.created_at,
       receipt.storage_version_id, receipt.provider_proof_sha256,
       receipt.receipt_hash, receipt.recorded_at
  FROM claimed
  JOIN campaign_assurance_raw_output_write_intents intent
    ON intent.tenant_id = claimed.tenant_id AND intent.id = claimed.id
  LEFT JOIN campaign_assurance_raw_output_write_receipts receipt
    ON receipt.tenant_id = intent.tenant_id AND receipt.intent_id = intent.id
 ORDER BY intent.created_at, intent.tenant_id, intent.id`, limit, orphanGrace.String(), workerID, leaseTTL.String())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	intents := make([]WriteIntent, 0, limit)
	for rows.Next() {
		intent, scanErr := scanIntent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		intents = append(intents, intent)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return intents, nil
}

func (r *DBRepository) RecordCleanup(
	ctx context.Context,
	intent WriteIntent,
	version VersionReceipt,
	result CleanupResult,
) error {
	if r == nil || r.Pool == nil || intent.State != "cleanup_leased" || !canonicalUUID(intent.LeaseToken) ||
		strings.TrimSpace(intent.LeaseOwner) == "" || len(intent.LeaseOwner) > 200 ||
		intent.Attempt < 1 || (result.Disposition != CleanupDeleted && result.Disposition != CleanupAlreadyMissing) ||
		result.ResponseVersion != "" && (len(result.ResponseVersion) > 1024 || strings.ContainsAny(result.ResponseVersion, "\x00\r\n")) ||
		result.ProviderRequestIDHash != "" && !hashPattern.MatchString(result.ProviderRequestIDHash) {
		return ErrInvalidIdentity
	}
	versionHash, versionReceiptHash, responseHash := "", "", ""
	if version.VersionID != "" {
		if _, err := normalizeReceipt(intent, version); err != nil || !hashPattern.MatchString(version.ReceiptHash) {
			if err != nil {
				return err
			}
			return ErrInvalidIdentity
		}
		versionHash, versionReceiptHash = sha256Hex([]byte(version.VersionID)), version.ReceiptHash
	}
	if result.Disposition == CleanupDeleted && versionHash == "" {
		return ErrInvalidIdentity
	}
	if result.ResponseVersion != "" {
		if version.VersionID == "" || result.ResponseVersion != version.VersionID {
			return ErrObjectConflict
		}
		responseHash = sha256Hex([]byte(result.ResponseVersion))
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_cleanup_receipts (
    tenant_id, intent_id, attempt_no, claim_token, outcome,
    object_ref_sha256, content_sha256, version_receipt_hash,
    requested_version_sha256, response_version_sha256, delete_marker,
    provider_request_id_sha256, worker_id_sha256, receipt_hash
) VALUES (
    $1::uuid, $2::uuid, $3, $4::uuid, $5,
    encode(digest(convert_to($6, 'UTF8'), 'sha256'), 'hex'), $7,
    NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, ''), $11,
    NULLIF($12, ''), encode(digest(convert_to($13, 'UTF8'), 'sha256'), 'hex'),
    repeat('0', 64)
)`, intent.TenantID, intent.IntentID, intent.Attempt, intent.LeaseToken, result.Disposition,
		intent.ObjectRef, intent.ContentSHA256, versionReceiptHash, versionHash,
		responseHash, result.DeleteMarker, result.ProviderRequestIDHash, intent.LeaseOwner)
	if err != nil {
		return fmt.Errorf("append raw-output cleanup receipt: %w", err)
	}
	tag, err := tx.Exec(ctx, `
UPDATE campaign_assurance_raw_output_write_intents
   SET state = 'cleaned', lease_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, retry_not_before = NULL,
       last_failure_code = NULL, completed_at = statement_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'cleanup_leased'
   AND attempt_count = $3 AND lease_token = $4::uuid`, intent.TenantID, intent.IntentID,
		intent.Attempt, intent.LeaseToken)
	if err != nil || tag.RowsAffected() != 1 {
		if err == nil {
			err = ErrCleanupNotAuthorized
		}
		return err
	}
	return tx.Commit(ctx)
}

func (r *DBRepository) RecordCleanupFailure(
	ctx context.Context,
	intent WriteIntent,
	version *VersionReceipt,
	code string,
	cause error,
	retryAfter time.Duration,
) error {
	code = strings.TrimSpace(code)
	if r == nil || r.Pool == nil || intent.State != "cleanup_leased" || !canonicalUUID(intent.LeaseToken) ||
		strings.TrimSpace(intent.LeaseOwner) == "" || len(intent.LeaseOwner) > 200 ||
		intent.Attempt < 1 || cause == nil || !regexpFailure.MatchString(code) ||
		retryAfter < time.Second || retryAfter > 24*time.Hour {
		return ErrInvalidIdentity
	}
	versionReceiptHash, requestedVersionHash := "", ""
	if version != nil {
		if _, err := normalizeReceipt(intent, *version); err != nil || !hashPattern.MatchString(version.ReceiptHash) {
			if err != nil {
				return err
			}
			return ErrInvalidIdentity
		}
		versionReceiptHash = version.ReceiptHash
		requestedVersionHash = sha256Hex([]byte(version.VersionID))
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_assurance_raw_output_cleanup_receipts (
    tenant_id, intent_id, attempt_no, claim_token, outcome,
    object_ref_sha256, content_sha256, version_receipt_hash,
    requested_version_sha256, failure_code, failure_sha256,
    worker_id_sha256, receipt_hash
) VALUES (
    $1::uuid, $2::uuid, $3, $4::uuid, 'failure',
    encode(digest(convert_to($5, 'UTF8'), 'sha256'), 'hex'), $6,
    NULLIF($7, ''), NULLIF($8, ''), $9,
    encode(digest(convert_to($10, 'UTF8'), 'sha256'), 'hex'),
    encode(digest(convert_to($11, 'UTF8'), 'sha256'), 'hex'), repeat('0', 64)
)`, intent.TenantID, intent.IntentID, intent.Attempt, intent.LeaseToken,
		intent.ObjectRef, intent.ContentSHA256, versionReceiptHash, requestedVersionHash,
		code, cause.Error(), intent.LeaseOwner)
	if err != nil {
		return fmt.Errorf("append raw-output cleanup failure: %w", err)
	}
	tag, err := tx.Exec(ctx, `
UPDATE campaign_assurance_raw_output_write_intents
   SET state = 'cleanup_retry', lease_token = NULL, lease_owner = NULL,
       lease_expires_at = NULL, retry_not_before = statement_timestamp() + $5::interval,
       last_failure_code = $6
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND state = 'cleanup_leased'
   AND attempt_count = $3 AND lease_token = $4::uuid`, intent.TenantID, intent.IntentID,
		intent.Attempt, intent.LeaseToken, retryAfter.String(), code)
	if err != nil || tag.RowsAffected() != 1 {
		if err == nil {
			err = ErrCleanupNotAuthorized
		}
		return err
	}
	return tx.Commit(ctx)
}

func loadIntent(ctx context.Context, tx pgx.Tx, tenantID, rest string, forUpdate bool) (WriteIntent, error) {
	query := `
SELECT intent.tenant_id::text, intent.id::text, intent.object_rest, intent.object_key,
       intent.object_ref, intent.content_sha256, intent.checksum_sha256_base64,
       intent.content_type, intent.byte_size, intent.bucket, intent.kms_key_id_sha256,
       intent.state, intent.attempt_count, COALESCE(intent.lease_token::text, ''),
       COALESCE(intent.lease_owner, ''), intent.lease_expires_at, intent.created_at,
       receipt.storage_version_id, receipt.provider_proof_sha256,
       receipt.receipt_hash, receipt.recorded_at
  FROM campaign_assurance_raw_output_write_intents intent
  LEFT JOIN campaign_assurance_raw_output_write_receipts receipt
    ON receipt.tenant_id = intent.tenant_id AND receipt.intent_id = intent.id
 WHERE intent.tenant_id = $1::uuid AND intent.object_rest = $2`
	if forUpdate {
		query += " FOR UPDATE OF intent"
	}
	return scanIntent(tx.QueryRow(ctx, query, tenantID, rest))
}

func loadVersionTx(ctx context.Context, tx pgx.Tx, tenantID, rest, expectedHash string) (VersionReceipt, error) {
	var receipt VersionReceipt
	err := tx.QueryRow(ctx, `
SELECT intent.tenant_id::text, intent.id::text, intent.object_rest, intent.object_key,
       intent.object_ref, receipt.bucket, receipt.storage_version_id,
       receipt.content_sha256, receipt.checksum_sha256_base64, receipt.content_type,
       receipt.byte_size, receipt.kms_key_id_sha256, receipt.provider_proof_sha256,
       receipt.receipt_hash, receipt.recorded_at
  FROM campaign_assurance_raw_output_write_intents intent
  JOIN campaign_assurance_raw_output_write_receipts receipt
    ON receipt.tenant_id = intent.tenant_id AND receipt.intent_id = intent.id
 WHERE intent.tenant_id = $1::uuid AND intent.object_rest = $2
   AND ($3 = '' OR receipt.content_sha256 = $3)`, tenantID, rest, expectedHash).Scan(
		&receipt.TenantID, &receipt.IntentID, &receipt.ObjectRest, &receipt.ObjectKey,
		&receipt.ObjectRef, &receipt.Bucket, &receipt.VersionID, &receipt.ContentSHA256,
		&receipt.ChecksumBase64, &receipt.ContentType, &receipt.ByteSize,
		&receipt.KMSKeyIDHash, &receipt.ProviderProofHash, &receipt.ReceiptHash, &receipt.RecordedAt)
	return receipt, err
}

type scanner interface{ Scan(...any) error }

func scanIntent(row scanner) (WriteIntent, error) {
	var intent WriteIntent
	var leaseExpires, recordedAt pgtype.Timestamptz
	var versionID, providerProofHash, receiptHash pgtype.Text
	err := row.Scan(
		&intent.TenantID, &intent.IntentID, &intent.ObjectRest, &intent.ObjectKey,
		&intent.ObjectRef, &intent.ContentSHA256, &intent.ChecksumBase64,
		&intent.ContentType, &intent.ByteSize, &intent.Bucket, &intent.KMSKeyIDHash,
		&intent.State, &intent.Attempt, &intent.LeaseToken, &intent.LeaseOwner,
		&leaseExpires, &intent.CreatedAt, &versionID, &providerProofHash, &receiptHash, &recordedAt)
	if err != nil {
		return WriteIntent{}, err
	}
	if leaseExpires.Valid {
		intent.LeaseExpiresAt = leaseExpires.Time.UTC()
	}
	if versionID.Valid {
		intent.Version = &VersionReceipt{
			TenantID: intent.TenantID, IntentID: intent.IntentID, ObjectRest: intent.ObjectRest,
			ObjectKey: intent.ObjectKey, ObjectRef: intent.ObjectRef, Bucket: intent.Bucket,
			VersionID: versionID.String, ContentSHA256: intent.ContentSHA256,
			ChecksumBase64: intent.ChecksumBase64, ContentType: intent.ContentType,
			ByteSize: intent.ByteSize, KMSKeyIDHash: intent.KMSKeyIDHash,
			ProviderProofHash: providerProofHash.String, ReceiptHash: receiptHash.String,
		}
		if recordedAt.Valid {
			intent.Version.RecordedAt = recordedAt.Time.UTC()
		}
	}
	return intent, nil
}
