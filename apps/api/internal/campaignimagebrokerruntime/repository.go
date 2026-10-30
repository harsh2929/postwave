// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/campaignimagebroker"
	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	ErrCacheConflict    = errors.New("campaign image broker runtime: immutable OCR cache conflict")
	ErrEvidenceConflict = errors.New("campaign image broker runtime: immutable raster evidence conflict")
)

type Repository struct {
	Pool           *db.Pool
	CacheRetention time.Duration
}

var _ campaignimagebroker.OCRCache = (*Repository)(nil)

func NewRepository(pool *db.Pool, cacheRetention time.Duration) (*Repository, error) {
	if pool == nil || cacheRetention < time.Hour || cacheRetention > 30*24*time.Hour {
		return nil, ErrInvalidConfiguration
	}
	return &Repository{Pool: pool, CacheRetention: cacheRetention}, nil
}

// Ready proves the three v1933 tables are installed with forced RLS and that
// the configured runtime connection cannot bypass those policies.
func (r *Repository) Ready(ctx context.Context) error {
	if r == nil || r.Pool == nil {
		return ErrInvalidConfiguration
	}
	var ready, privileged bool
	err := r.Pool.QueryRow(ctx, `
SELECT
    COUNT(*) = 3 AND bool_and(c.relrowsecurity) AND bool_and(c.relforcerowsecurity),
    COALESCE(bool_or(current_setting('is_superuser') = 'on' OR role.rolbypassrls), true)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_roles AS role ON role.rolname = current_user
WHERE n.nspname = 'public'
  AND c.relname = ANY($1::text[])`, []string{
		"campaign_image_ocr_cache_entries",
		"campaign_image_raster_evidence",
		"campaign_image_raster_deletion_receipts",
	}).Scan(&ready, &privileged)
	if err != nil {
		return fmt.Errorf("%w: inspect image-broker schema", ErrNotReady)
	}
	if !ready || privileged {
		return fmt.Errorf("%w: v1933 forced-RLS schema or restricted runtime role is unavailable", ErrNotReady)
	}
	return nil
}

func (r *Repository) Get(ctx context.Context, rawKey campaignimagebroker.CacheKey) (campaignimagebroker.OCROutput, bool, error) {
	key, err := normalizeCacheKey(rawKey)
	if err != nil {
		return campaignimagebroker.OCROutput{}, false, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, key.TenantID)
	if err != nil {
		return campaignimagebroker.OCROutput{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var output campaignimagebroker.OCROutput
	var outputHash string
	err = tx.QueryRow(ctx, `
SELECT ocr_text, ocr_language, ocr_confidence, output_hash
FROM campaign_image_ocr_cache_entries
WHERE tenant_id = $1::uuid AND asset_sha256 = $2 AND raster_sha256 = $3
  AND ocr_runtime_version = $4 AND engine = $5 AND engine_version = $6
  AND language_hint = $7 AND expires_at > statement_timestamp()`,
		key.TenantID, key.AssetSHA256, key.RasterSHA256, key.OCRRuntimeVersion,
		key.Engine, key.EngineVersion, key.LanguageHint,
	).Scan(&output.Text, &output.Language, &output.Confidence, &outputHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return campaignimagebroker.OCROutput{}, false, nil
	}
	if err != nil {
		return campaignimagebroker.OCROutput{}, false, fmt.Errorf("read exact OCR cache: %w", err)
	}
	if digestOCROutput(output) != outputHash {
		return campaignimagebroker.OCROutput{}, false, ErrCacheConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return campaignimagebroker.OCROutput{}, false, err
	}
	return cloneOCROutput(output), true, nil
}

func (r *Repository) Put(ctx context.Context, rawKey campaignimagebroker.CacheKey, rawOutput campaignimagebroker.OCROutput) error {
	key, err := normalizeCacheKey(rawKey)
	if err != nil {
		return err
	}
	output, err := normalizeCacheOutput(rawOutput)
	if err != nil {
		return err
	}
	outputHash := digestOCROutput(output)
	tx, err := db.WithTenantWorker(ctx, r.Pool, key.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_image_ocr_cache_entries (
    tenant_id, asset_sha256, raster_sha256, ocr_runtime_version,
    engine, engine_version, language_hint, ocr_text, ocr_language,
    ocr_confidence, output_hash, expires_at
) VALUES (
    $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
    statement_timestamp() + $12::interval
)
ON CONFLICT (tenant_id, asset_sha256, raster_sha256, ocr_runtime_version,
             engine, engine_version, language_hint)
DO NOTHING`, key.TenantID, key.AssetSHA256, key.RasterSHA256, key.OCRRuntimeVersion,
		key.Engine, key.EngineVersion, key.LanguageHint, output.Text, output.Language,
		output.Confidence, outputHash, r.CacheRetention.String()); err != nil {
		return fmt.Errorf("store exact OCR cache: %w", err)
	}
	var storedHash string
	if err := tx.QueryRow(ctx, `
SELECT output_hash
FROM campaign_image_ocr_cache_entries
WHERE tenant_id = $1::uuid AND asset_sha256 = $2 AND raster_sha256 = $3
  AND ocr_runtime_version = $4 AND engine = $5 AND engine_version = $6
  AND language_hint = $7`, key.TenantID, key.AssetSHA256, key.RasterSHA256,
		key.OCRRuntimeVersion, key.Engine, key.EngineVersion, key.LanguageHint).Scan(&storedHash); err != nil {
		return fmt.Errorf("verify exact OCR cache: %w", err)
	}
	if storedHash != outputHash {
		return ErrCacheConflict
	}
	return tx.Commit(ctx)
}

type EvidenceRecordInput struct {
	TenantID       string
	ObjectKey      string
	Bucket         string
	StorageVersion string
	KMSKeyIDHash   string
	RasterSHA256   string
	MediaType      string
	ByteSize       int64
	ExpiresAt      time.Time
}

type EvidenceRecord struct {
	TenantID       string
	ID             string
	ObjectKey      string
	Bucket         string
	StorageVersion string
	KMSKeyIDHash   string
	RasterSHA256   string
	MediaType      string
	ByteSize       int64
	ExpiresAt      time.Time
}

func (r *Repository) RecordEvidence(ctx context.Context, raw EvidenceRecordInput) (EvidenceRecord, error) {
	input, err := normalizeEvidenceInput(raw)
	if err != nil {
		return EvidenceRecord{}, err
	}
	if !input.ExpiresAt.After(time.Now().UTC()) {
		return EvidenceRecord{}, fmt.Errorf("%w: new raster evidence must have future retention", ErrInvalidConfiguration)
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, input.TenantID)
	if err != nil {
		return EvidenceRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_image_raster_evidence (
    tenant_id, object_key, bucket, storage_version_id, kms_key_id_hash,
    raster_sha256, media_type, byte_size, expires_at
) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (tenant_id, object_key, storage_version_id) DO NOTHING`,
		input.TenantID, input.ObjectKey, input.Bucket, input.StorageVersion,
		input.KMSKeyIDHash, input.RasterSHA256, input.MediaType, input.ByteSize, input.ExpiresAt); err != nil {
		return EvidenceRecord{}, fmt.Errorf("record raster evidence: %w", err)
	}
	record, err := scanEvidence(tx.QueryRow(ctx, `
SELECT tenant_id::text, id::text, object_key, bucket, storage_version_id,
       kms_key_id_hash, raster_sha256, media_type, byte_size, expires_at
FROM campaign_image_raster_evidence
WHERE tenant_id = $1::uuid AND object_key = $2 AND storage_version_id = $3`,
		input.TenantID, input.ObjectKey, input.StorageVersion))
	if err != nil {
		return EvidenceRecord{}, fmt.Errorf("read raster evidence: %w", err)
	}
	if record.Bucket != input.Bucket || record.StorageVersion != input.StorageVersion ||
		record.KMSKeyIDHash != input.KMSKeyIDHash || record.RasterSHA256 != input.RasterSHA256 ||
		record.MediaType != input.MediaType || record.ByteSize != input.ByteSize ||
		!record.ExpiresAt.Equal(input.ExpiresAt) {
		return EvidenceRecord{}, ErrEvidenceConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return EvidenceRecord{}, err
	}
	return record, nil
}

func (r *Repository) ListExpiredEvidence(ctx context.Context, limit int) ([]EvidenceRecord, error) {
	if r == nil || r.Pool == nil || limit < 1 || limit > 1000 {
		return nil, ErrInvalidConfiguration
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT evidence.tenant_id::text, evidence.id::text, evidence.object_key,
       evidence.bucket, evidence.storage_version_id, evidence.kms_key_id_hash,
       evidence.raster_sha256, evidence.media_type, evidence.byte_size,
       evidence.expires_at
FROM campaign_image_raster_evidence AS evidence
LEFT JOIN campaign_image_raster_deletion_receipts AS deletion
  ON deletion.tenant_id = evidence.tenant_id AND deletion.evidence_id = evidence.id
WHERE evidence.expires_at <= statement_timestamp()
  AND deletion.evidence_id IS NULL
  -- Legal hold. NULL campaign because raster evidence is content-addressed and
  -- deduplicated across campaigns: this row carries no campaign column, so the
  -- sweep cannot prove it is unrelated to a held one. Any active hold for the
  -- tenant therefore suspends it. Over-retaining is recoverable; deleting
  -- evidence under hold is not.
  AND NOT campaign_assurance_legal_hold_active(evidence.tenant_id, NULL)
ORDER BY evidence.expires_at, evidence.tenant_id, evidence.id
LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("list expired raster evidence: %w", err)
	}
	defer rows.Close()
	result := make([]EvidenceRecord, 0, limit)
	for rows.Next() {
		record, scanErr := scanEvidence(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

type DeletionReceiptInput struct {
	Evidence               EvidenceRecord
	ResponseStorageVersion string
	DeleteMarker           bool
	ProviderRequestIDHash  string
}

func (r *Repository) RecordDeletion(ctx context.Context, raw DeletionReceiptInput) error {
	input, receiptHash, err := normalizeDeletionReceipt(raw)
	if err != nil {
		return err
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, input.Evidence.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
INSERT INTO campaign_image_raster_deletion_receipts (
    tenant_id, evidence_id, object_key_sha256, requested_storage_version,
    response_storage_version, delete_marker, provider_request_id_hash,
    receipt_hash
)
SELECT evidence.tenant_id, evidence.id, $3, evidence.storage_version_id,
       NULLIF($4, ''), $5, NULLIF($6, ''), $7
FROM campaign_image_raster_evidence AS evidence
WHERE evidence.tenant_id = $1::uuid AND evidence.id = $2::uuid
  AND evidence.object_key = $8 AND evidence.storage_version_id = $9
ON CONFLICT (tenant_id, evidence_id) DO NOTHING`,
		input.Evidence.TenantID, input.Evidence.ID, sha256Hex([]byte(input.Evidence.ObjectKey)),
		input.ResponseStorageVersion, input.DeleteMarker, input.ProviderRequestIDHash,
		receiptHash, input.Evidence.ObjectKey, input.Evidence.StorageVersion)
	if err != nil {
		return fmt.Errorf("record raster deletion receipt: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var storedVersion, storedObjectHash string
		if err := tx.QueryRow(ctx, `
SELECT requested_storage_version, object_key_sha256
FROM campaign_image_raster_deletion_receipts
WHERE tenant_id = $1::uuid AND evidence_id = $2::uuid`,
			input.Evidence.TenantID, input.Evidence.ID).Scan(&storedVersion, &storedObjectHash); err != nil {
			return ErrEvidenceConflict
		}
		if storedVersion != input.Evidence.StorageVersion ||
			storedObjectHash != sha256Hex([]byte(input.Evidence.ObjectKey)) {
			return ErrEvidenceConflict
		}
	}
	return tx.Commit(ctx)
}

func (r *Repository) SweepExpiredCache(ctx context.Context, limit int) (int64, error) {
	if r == nil || r.Pool == nil || limit < 1 || limit > 10_000 {
		return 0, ErrInvalidConfiguration
	}
	tx, err := db.WithWorkerScope(ctx, r.Pool)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := tx.Exec(ctx, `
WITH expired AS (
    SELECT tenant_id, asset_sha256, raster_sha256, ocr_runtime_version,
           engine, engine_version, language_hint
    FROM campaign_image_ocr_cache_entries
    WHERE expires_at <= statement_timestamp()
      -- Legal hold; see ListExpiredEvidence for why the campaign is NULL. The
      -- OCR cache is keyed by content hash and shared across campaigns, so
      -- there is nothing narrower to ask.
      AND NOT campaign_assurance_legal_hold_active(tenant_id, NULL)
    ORDER BY expires_at, tenant_id
    LIMIT $1
)
DELETE FROM campaign_image_ocr_cache_entries AS cache
USING expired
WHERE cache.tenant_id = expired.tenant_id
  AND cache.asset_sha256 = expired.asset_sha256
  AND cache.raster_sha256 = expired.raster_sha256
  AND cache.ocr_runtime_version = expired.ocr_runtime_version
  AND cache.engine = expired.engine
  AND cache.engine_version = expired.engine_version
  AND cache.language_hint = expired.language_hint`, limit)
	if err != nil {
		return 0, fmt.Errorf("sweep expired OCR cache: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

func normalizeCacheKey(key campaignimagebroker.CacheKey) (campaignimagebroker.CacheKey, error) {
	tenantID, err := uuid.Parse(key.TenantID)
	if err != nil || tenantID.String() != key.TenantID || !validSHA256(key.AssetSHA256) ||
		!validSHA256(key.RasterSHA256) || !methodIdentityPattern.MatchString(key.OCRRuntimeVersion) ||
		!methodIdentityPattern.MatchString(key.Engine) || !methodIdentityPattern.MatchString(key.EngineVersion) ||
		!validBoundedText(key.LanguageHint, 64) {
		return campaignimagebroker.CacheKey{}, fmt.Errorf("%w: invalid exact OCR cache identity", ErrInvalidConfiguration)
	}
	return key, nil
}

func normalizeCacheOutput(output campaignimagebroker.OCROutput) (campaignimagebroker.OCROutput, error) {
	if !validBoundedText(output.Text, 32<<10) || !validBoundedText(output.Language, 64) ||
		output.Confidence != nil && (math.IsNaN(*output.Confidence) || math.IsInf(*output.Confidence, 0) ||
			*output.Confidence < 0 || *output.Confidence > 1) {
		return campaignimagebroker.OCROutput{}, fmt.Errorf("%w: invalid OCR cache output", ErrInvalidConfiguration)
	}
	return cloneOCROutput(output), nil
}

func cloneOCROutput(output campaignimagebroker.OCROutput) campaignimagebroker.OCROutput {
	if output.Confidence != nil {
		value := *output.Confidence
		output.Confidence = &value
	}
	return output
}

func digestOCROutput(output campaignimagebroker.OCROutput) string {
	canonical := struct {
		Text       string   `json:"text"`
		Language   string   `json:"language"`
		Confidence *float64 `json:"confidence"`
	}{output.Text, output.Language, output.Confidence}
	body, _ := json.Marshal(canonical)
	return sha256Hex(body)
}

func normalizeEvidenceInput(input EvidenceRecordInput) (EvidenceRecordInput, error) {
	tenantID, err := uuid.Parse(input.TenantID)
	if err != nil || tenantID.String() != input.TenantID || input.ObjectKey == "" || len(input.ObjectKey) > 1024 ||
		strings.TrimSpace(input.ObjectKey) != input.ObjectKey || strings.ContainsAny(input.ObjectKey, "\r\n\x00") ||
		strings.Contains(input.ObjectKey, "../") || strings.HasPrefix(input.ObjectKey, "/") ||
		!bucketPattern.MatchString(input.Bucket) || input.StorageVersion == "" || len(input.StorageVersion) > 1024 ||
		strings.ContainsAny(input.StorageVersion, "\r\n\x00") || !validSHA256(input.KMSKeyIDHash) ||
		!validSHA256(input.RasterSHA256) || input.MediaType != "image/png" || input.ByteSize < 1 ||
		input.ByteSize > defaultMaxRasterBytes || input.ExpiresAt.IsZero() {
		return EvidenceRecordInput{}, fmt.Errorf("%w: invalid raster evidence identity", ErrInvalidConfiguration)
	}
	input.ExpiresAt = input.ExpiresAt.UTC()
	return input, nil
}

type rowScanner interface{ Scan(...any) error }

func scanEvidence(row rowScanner) (EvidenceRecord, error) {
	var record EvidenceRecord
	err := row.Scan(&record.TenantID, &record.ID, &record.ObjectKey, &record.Bucket,
		&record.StorageVersion, &record.KMSKeyIDHash, &record.RasterSHA256,
		&record.MediaType, &record.ByteSize, &record.ExpiresAt)
	return record, err
}

func normalizeDeletionReceipt(input DeletionReceiptInput) (DeletionReceiptInput, string, error) {
	if _, err := normalizeEvidenceInput(EvidenceRecordInput{
		TenantID: input.Evidence.TenantID, ObjectKey: input.Evidence.ObjectKey,
		Bucket: input.Evidence.Bucket, StorageVersion: input.Evidence.StorageVersion,
		KMSKeyIDHash: input.Evidence.KMSKeyIDHash, RasterSHA256: input.Evidence.RasterSHA256,
		MediaType: input.Evidence.MediaType, ByteSize: input.Evidence.ByteSize,
		ExpiresAt: input.Evidence.ExpiresAt,
	}); err != nil {
		return DeletionReceiptInput{}, "", err
	}
	if parsed, err := uuid.Parse(input.Evidence.ID); err != nil || parsed.String() != input.Evidence.ID ||
		len(input.ResponseStorageVersion) > 1024 || strings.ContainsAny(input.ResponseStorageVersion, "\r\n\x00") ||
		input.ProviderRequestIDHash != "" && !validSHA256(input.ProviderRequestIDHash) {
		return DeletionReceiptInput{}, "", fmt.Errorf("%w: invalid raster deletion receipt", ErrInvalidConfiguration)
	}
	canonical := struct {
		TenantID              string `json:"tenant_id"`
		EvidenceID            string `json:"evidence_id"`
		ObjectKeySHA256       string `json:"object_key_sha256"`
		RequestedVersion      string `json:"requested_storage_version"`
		ResponseVersion       string `json:"response_storage_version,omitempty"`
		DeleteMarker          bool   `json:"delete_marker"`
		ProviderRequestIDHash string `json:"provider_request_id_hash,omitempty"`
	}{
		TenantID: input.Evidence.TenantID, EvidenceID: input.Evidence.ID,
		ObjectKeySHA256:  sha256Hex([]byte(input.Evidence.ObjectKey)),
		RequestedVersion: input.Evidence.StorageVersion,
		ResponseVersion:  input.ResponseStorageVersion, DeleteMarker: input.DeleteMarker,
		ProviderRequestIDHash: input.ProviderRequestIDHash,
	}
	body, _ := json.Marshal(canonical)
	sum := sha256.Sum256(body)
	return input, hex.EncodeToString(sum[:]), nil
}
