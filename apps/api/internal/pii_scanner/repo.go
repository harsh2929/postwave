// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a finding id does not match a tenant-scoped row.
var ErrNotFound = errors.New("pii finding not found")

// ErrInvalidInput is returned for a malformed filter / status / config value.
var ErrInvalidInput = errors.New("pii_scanner: invalid input")

// ErrReviewConflict is returned when a finding is already terminal or the
// caller reviewed a stale representation. Both cases are HTTP 409 conflicts;
// no existing receipt is ever overwritten.
var ErrReviewConflict = errors.New("pii_scanner: immutable review conflict")

// ErrScannerUnavailable means the dedicated fingerprint key or another
// scanner dependency is unavailable. Enabling fails closed; durable subscriber
// revisions/intents remain queued without making user writes depend on the
// scanner process.
var ErrScannerUnavailable = errors.New("pii_scanner: scanner unavailable")

// Repo wraps the pgx pool with subscriber_pii_findings + tenant_pii_scan_config
// CRUD. RLS forces app.tenant_id — every method goes through db.WithTenant.
type Repo struct {
	Pool *db.Pool
	// afterListCount is a deterministic test seam for proving count/items share
	// one repeatable-read snapshot. Production leaves it nil.
	afterListCount func()
}

const findingColumns = `f.id::text, f.subscriber_id::text, f.field_name, f.detected_type,
       f.confidence, f.raw_value_hash, f.fingerprint_scheme, f.fingerprint_key_version, f.status,
       f.scanner_name, f.scanner_version, f.detector_name, f.detector_version,
       f.policy_name, f.policy_version,
       f.reviewed_at, COALESCE(f.reviewed_by, ''), f.created_at, f.updated_at,
       r.id::text, r.status, r.reason, r.review_comment, r.evidence_reference,
       r.reviewed_at, r.actor_type, r.actor_id,
       r.scanner_name, r.scanner_version, r.detector_name, r.detector_version,
       r.policy_name, r.policy_version, r.raw_value_hash, r.fingerprint_scheme,
       r.fingerprint_key_version, r.finding_updated_at`

const findingJoin = ` LEFT JOIN subscriber_pii_review_receipts r
  ON r.tenant_id = f.tenant_id AND r.finding_id = f.id`

// scanner is the minimal row interface satisfied by both pgx.Row and pgx.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanFinding(row scanner) (*Finding, error) {
	var f Finding
	var dt string
	var receiptID, receiptStatus, receiptReason, receiptComment, receiptEvidence *string
	var receiptActorType, receiptActorID *string
	var receiptScannerName, receiptScannerVersion, receiptDetectorName, receiptDetectorVersion *string
	var receiptPolicyName, receiptPolicyVersion, receiptFingerprint *string
	var receiptFingerprintScheme, receiptFingerprintKeyVersion *string
	var receiptReviewedAt, receiptFindingUpdatedAt *time.Time
	if err := row.Scan(&f.ID, &f.SubscriberID, &f.FieldName, &dt,
		&f.Confidence, &f.Fingerprint, &f.FingerprintScheme, &f.FingerprintKeyVersion, &f.Status,
		&f.ScannerName, &f.ScannerVersion, &f.DetectorName, &f.DetectorVersion,
		&f.PolicyName, &f.PolicyVersion,
		&f.ReviewedAt, &f.ReviewedBy, &f.CreatedAt, &f.UpdatedAt,
		&receiptID, &receiptStatus, &receiptReason, &receiptComment, &receiptEvidence,
		&receiptReviewedAt, &receiptActorType, &receiptActorID,
		&receiptScannerName, &receiptScannerVersion, &receiptDetectorName, &receiptDetectorVersion,
		&receiptPolicyName, &receiptPolicyVersion, &receiptFingerprint,
		&receiptFingerprintScheme, &receiptFingerprintKeyVersion, &receiptFindingUpdatedAt); err != nil {
		return nil, err
	}
	f.DetectedType = DetectionType(dt)
	if receiptID != nil {
		if receiptStatus == nil || receiptReason == nil || receiptComment == nil || receiptEvidence == nil ||
			receiptReviewedAt == nil || receiptActorType == nil || receiptActorID == nil ||
			receiptScannerName == nil || receiptScannerVersion == nil || receiptDetectorName == nil ||
			receiptDetectorVersion == nil || receiptPolicyName == nil || receiptPolicyVersion == nil ||
			receiptFingerprint == nil || receiptFingerprintScheme == nil || receiptFingerprintKeyVersion == nil || receiptFindingUpdatedAt == nil {
			return nil, errors.New("pii_scanner: incomplete review receipt")
		}
		f.ReviewReceipt = &FindingReviewReceipt{
			ReceiptID:             *receiptID,
			Status:                *receiptStatus,
			Reason:                *receiptReason,
			Comment:               *receiptComment,
			EvidenceReference:     *receiptEvidence,
			ReviewedAt:            *receiptReviewedAt,
			ActorType:             *receiptActorType,
			ActorID:               *receiptActorID,
			ScannerName:           *receiptScannerName,
			ScannerVersion:        *receiptScannerVersion,
			DetectorName:          *receiptDetectorName,
			DetectorVersion:       *receiptDetectorVersion,
			PolicyName:            *receiptPolicyName,
			PolicyVersion:         *receiptPolicyVersion,
			Fingerprint:           *receiptFingerprint,
			FingerprintScheme:     *receiptFingerprintScheme,
			FingerprintKeyVersion: *receiptFingerprintKeyVersion,
			FindingUpdatedAt:      *receiptFindingUpdatedAt,
		}
	}
	return &f, nil
}

// ListFindings returns a deterministic tenant-scoped page. The q filter is
// privacy-safe: it searches field-name metadata, exact UUIDs, and keyed-HMAC
// fingerprint prefixes; it never joins or searches subscriber cleartext.
// Random legacy-redacted migration tokens are intentionally excluded.
func (r *Repo) ListFindings(ctx context.Context, tenantID string, filter FindingFilter) (*FindingPage, error) {
	filter, err := normalizeFindingFilter(filter)
	if err != nil {
		return nil, err
	}
	offset := (filter.Page - 1) * filter.PerPage
	fingerprintPrefix := ""
	if isFingerprintPrefix(filter.Query) {
		fingerprintPrefix = strings.ToLower(filter.Query)
	}
	likeQuery := escapeLikeLiteral(filter.Query)
	var queryUUID *string
	if parsed, parseErr := uuid.Parse(filter.Query); parseErr == nil {
		canonical := parsed.String()
		queryUUID = &canonical
	}

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM subscriber_pii_findings
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR status = $2)
   AND ($3 = '' OR detected_type = $3)
   AND ($4 = '' OR lower(field_name) LIKE '%' || lower($6) || '%' ESCAPE '\'
        OR ($7::uuid IS NOT NULL AND (id = $7::uuid OR subscriber_id = $7::uuid))
        OR ($5 <> '' AND fingerprint_scheme = '`+FingerprintSchemeHMACSHA256V1+`'
            AND raw_value_hash LIKE $5 || '%'))`,
		tenantID, filter.Status, filter.DetectedType, filter.Query, fingerprintPrefix, likeQuery, queryUUID).Scan(&total); err != nil {
		return nil, err
	}
	if r.afterListCount != nil {
		r.afterListCount()
	}

	rows, err := tx.Query(ctx, `
SELECT `+findingColumns+`
  FROM subscriber_pii_findings f`+findingJoin+`
 WHERE f.tenant_id = $1::uuid
   AND ($2 = '' OR f.status = $2)
   AND ($3 = '' OR f.detected_type = $3)
   AND ($4 = '' OR lower(f.field_name) LIKE '%' || lower($6) || '%' ESCAPE '\'
        OR ($7::uuid IS NOT NULL AND (f.id = $7::uuid OR f.subscriber_id = $7::uuid))
        OR ($5 <> '' AND f.fingerprint_scheme = '`+FingerprintSchemeHMACSHA256V1+`'
            AND f.raw_value_hash LIKE $5 || '%'))
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT $8 OFFSET $9`, tenantID, filter.Status, filter.DetectedType, filter.Query, fingerprintPrefix, likeQuery, queryUUID, filter.PerPage, offset)
	if err != nil {
		return nil, err
	}
	items, err := scanFindings(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &FindingPage{Items: items, Total: total, Page: filter.Page, PerPage: filter.PerPage}, nil
}

// ListFindingsForSubscriber returns a bounded deterministic page for one
// tenant-bound subscriber. Query is intentionally ignored here because the
// subscriber identity is already fixed by the path.
func (r *Repo) ListFindingsForSubscriber(ctx context.Context, tenantID, subscriberID string, filter FindingFilter) (*FindingPage, error) {
	parsedSubscriberID, parseErr := uuid.Parse(strings.TrimSpace(subscriberID))
	if parseErr != nil || parsedSubscriberID.String() != strings.ToLower(strings.TrimSpace(subscriberID)) {
		return nil, ErrNotFound
	}
	subscriberID = parsedSubscriberID.String()
	filter.Query = ""
	filter, err := normalizeFindingFilter(filter)
	if err != nil {
		return nil, err
	}
	offset := (filter.Page - 1) * filter.PerPage
	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var subscriberExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, tenantID, subscriberID).Scan(&subscriberExists); err != nil {
		return nil, err
	}
	if !subscriberExists {
		return nil, ErrNotFound
	}
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_pii_findings
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND ($3 = '' OR status = $3)
   AND ($4 = '' OR detected_type = $4)`, tenantID, subscriberID, filter.Status, filter.DetectedType).Scan(&total); err != nil {
		return nil, err
	}
	if r.afterListCount != nil {
		r.afterListCount()
	}
	rows, err := tx.Query(ctx, `
SELECT `+findingColumns+`
  FROM subscriber_pii_findings f`+findingJoin+`
 WHERE f.tenant_id = $1::uuid AND f.subscriber_id = $2::uuid
   AND ($3 = '' OR f.status = $3)
   AND ($4 = '' OR f.detected_type = $4)
 ORDER BY f.created_at DESC, f.id DESC
 LIMIT $5 OFFSET $6`, tenantID, subscriberID, filter.Status, filter.DetectedType, filter.PerPage, offset)
	if err != nil {
		return nil, err
	}
	items, err := scanFindings(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &FindingPage{Items: items, Total: total, Page: filter.Page, PerPage: filter.PerPage}, nil
}

func scanFindings(rows pgx.Rows) ([]Finding, error) {
	defer rows.Close()
	out := []Finding{}
	for rows.Next() {
		f, err := scanFinding(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *f)
	}
	return out, rows.Err()
}

// RecordDetections inserts one finding per versioned detector/policy identity.
// Re-running the same version is idempotent; a detector or policy bump creates
// a new finding instead of relabelling historical evidence or overwriting its
// immutable receipt. Returns the count of newly inserted rows.
func (r *Repo) RecordDetections(ctx context.Context, tenantID, subscriberID string, dets []Detection) (int, error) {
	if len(dets) == 0 {
		return 0, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	inserted, err := recordDetectionsTx(ctx, tx, tenantID, subscriberID, dets)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return inserted, nil
}

// ReviewFinding atomically creates the one immutable receipt and transitions a
// pending finding to its terminal state. SELECT FOR UPDATE serializes competing
// reviewers; expected_updated_at also prevents a stale review after a re-scan.
func (r *Repo) ReviewFinding(ctx context.Context, tenantID, id string, in UpdateFindingInput, actor ReviewActor) (*Finding, error) {
	if err := in.NormalizeAndValidate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	actor.Type = strings.ToLower(strings.TrimSpace(actor.Type))
	actor.ID = strings.ToLower(strings.TrimSpace(actor.ID))
	actorUUID, actorErr := uuid.Parse(actor.ID)
	if (actor.Type != "user" && actor.Type != "api_key") || actorErr != nil || actorUUID.String() != actor.ID {
		return nil, fmt.Errorf("%w: a stable reviewer identity is required", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var currentStatus, fingerprint, fingerprintScheme, fingerprintKeyVersion string
	var scannerName, scannerVersion, detectorName, detectorVersion, policyName, policyVersion string
	var currentUpdatedAt time.Time
	err = tx.QueryRow(ctx, `
SELECT status, raw_value_hash, fingerprint_scheme, fingerprint_key_version,
       scanner_name, scanner_version, detector_name, detector_version,
       policy_name, policy_version, updated_at
  FROM subscriber_pii_findings
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, tenantID, id).Scan(&currentStatus, &fingerprint, &fingerprintScheme, &fingerprintKeyVersion,
		&scannerName, &scannerVersion, &detectorName, &detectorVersion, &policyName, &policyVersion, &currentUpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if currentStatus != StatusPending || !currentUpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return nil, ErrReviewConflict
	}

	var receiptID string
	var reviewedAt time.Time
	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_pii_review_receipts (
    tenant_id, finding_id, status, reason, review_comment, evidence_reference,
    actor_type, actor_id, scanner_name, scanner_version, detector_name,
    detector_version, policy_name, policy_version, raw_value_hash,
    fingerprint_scheme, fingerprint_key_version, finding_updated_at
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
    $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
)
RETURNING id::text, reviewed_at`, tenantID, id, in.Status, in.Reason, in.Comment,
		in.EvidenceReference, actor.Type, actor.ID, scannerName, scannerVersion,
		detectorName, detectorVersion, policyName, policyVersion, fingerprint,
		fingerprintScheme, fingerprintKeyVersion, currentUpdatedAt).Scan(&receiptID, &reviewedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrReviewConflict
		}
		if errors.As(err, &pgErr) && pgErr.Code == "23514" && strings.HasPrefix(pgErr.ConstraintName, "subscriber_pii_review_receipts_") {
			return nil, fmt.Errorf("%w: review receipt violates the persisted safety contract", ErrInvalidInput)
		}
		return nil, err
	}

	reviewedBy := actor.Type + ":" + actor.ID
	tag, err := tx.Exec(ctx, `
UPDATE subscriber_pii_findings
   SET status = $3, reviewed_at = $4, reviewed_by = $5, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND status = 'pending' AND updated_at = $6`, tenantID, id, in.Status, reviewedAt, reviewedBy, currentUpdatedAt)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrReviewConflict
	}

	f, err := scanFinding(tx.QueryRow(ctx, `
SELECT `+findingColumns+`
  FROM subscriber_pii_findings f`+findingJoin+`
 WHERE f.tenant_id = $1::uuid AND f.id = $2::uuid`, tenantID, id))
	if err != nil {
		return nil, err
	}
	if f.ReviewReceipt == nil || f.ReviewReceipt.ReceiptID != receiptID {
		return nil, errors.New("pii_scanner: review receipt was not durably linked")
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return f, nil
}

// DeclaredFieldKeys returns schema keys the tenant has already classified as
// PII/PHI/PCI/sensitive. Shadow discovery must skip these keys: they are known
// sensitive data governed by the ordinary masking/retention policy, not
// undeclared findings. The lookup is tenant-scoped under forced RLS and callers
// must fail closed (skip the scan) if it cannot be completed.
func (r *Repo) DeclaredFieldKeys(ctx context.Context, tenantID string) (map[string]bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT key
  FROM tenant_custom_fields
 WHERE tenant_id = $1::uuid
   AND (
       COALESCE(config, '{}'::jsonb) @> '{"pii_flag": true}'::jsonb
       OR lower(COALESCE(config ->> 'data_classification', '')) IN ('pii', 'phi', 'pci', 'sensitive')
   )`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	declared := map[string]bool{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		declared[key] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return declared, nil
}

// GetScanConfig returns the tenant's scan config. A missing row degrades to the
// conservative default (scanning disabled).
func (r *Repo) GetScanConfig(ctx context.Context, tenantID string) (*ScanConfig, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cfg ScanConfig
	var schedule *string
	err = tx.QueryRow(ctx, `
SELECT scan_enabled, scan_schedule, updated_at
  FROM tenant_pii_scan_config
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&cfg.ScanEnabled, &schedule, &cfg.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		cfg.ScanEnabled = false
		cfg.CoverageEvidence, err = r.getCoverageTx(ctx, tx, tenantID)
		if err != nil {
			return nil, err
		}
		if err := r.getRuntimeContractTx(ctx, tx, &cfg); err != nil {
			return nil, err
		}
		return &cfg, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	if schedule != nil {
		cfg.ScanSchedule = *schedule
	}
	cfg.CoverageEvidence, err = r.getCoverageTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := r.getRuntimeContractTx(ctx, tx, &cfg); err != nil {
		return nil, err
	}
	return &cfg, tx.Commit(ctx)
}

func (r *Repo) getRuntimeContractTx(ctx context.Context, tx pgx.Tx, cfg *ScanConfig) error {
	if cfg == nil {
		return ErrInvalidInput
	}
	var contract *string
	err := tx.QueryRow(ctx, `
SELECT CASE
           WHEN availability_status = 'available'
            AND last_available_at > now() - ($1::bigint * interval '1 millisecond')
               THEN 'available'
           WHEN availability_status = 'unknown' THEN 'unknown'
           ELSE 'unavailable'
       END,
       scan_contract
  FROM pii_scan_runtime_contract
	 WHERE singleton`, scannerAvailabilityGrace.Milliseconds()).Scan(&cfg.RuntimeAvailability, &contract)
	return applyRuntimeContractResult(cfg, contract, err)
}

func applyRuntimeContractResult(cfg *ScanConfig, contract *string, err error) error {
	if cfg == nil {
		return ErrInvalidInput
	}
	if errors.Is(err, pgx.ErrNoRows) {
		// A deployment missing the singleton (or with it hidden by incomplete
		// policy rollout) is an unknown scanner capability, not a tenant-config
		// read failure. Fail closed so the API can report `available: false`
		// instead of turning a recoverable capability state into a 500.
		cfg.RuntimeAvailability = "unknown"
		cfg.RuntimeScanContract = ""
		return nil
	}
	if err != nil {
		return err
	}
	if contract != nil {
		cfg.RuntimeScanContract = *contract
	} else {
		cfg.RuntimeScanContract = ""
	}
	return nil
}

// UpsertScanConfig writes the tenant's scan config, applying the pointer-field
// "omitted = unchanged" semantics on conflict.
func (r *Repo) UpsertScanConfig(ctx context.Context, tenantID string, in UpdateScanConfigInput) (*ScanConfig, error) {
	if in.ScanEnabled == nil && in.ScanSchedule == nil {
		return nil, fmt.Errorf("%w: at least one config field is required", ErrInvalidInput)
	}
	if in.ScanSchedule != nil && strings.TrimSpace(*in.ScanSchedule) != "" {
		return nil, fmt.Errorf("%w: scheduled scans are unavailable; continuous scanning runs from durable subscriber revisions", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	enabledSet := in.ScanEnabled != nil
	enabled := false
	if in.ScanEnabled != nil {
		enabled = *in.ScanEnabled
	}
	scheduleSet := in.ScanSchedule != nil
	schedule := ""
	if in.ScanSchedule != nil {
		schedule = strings.TrimSpace(*in.ScanSchedule)
	}

	var cfg ScanConfig
	var outSchedule *string
	row := tx.QueryRow(ctx, `
INSERT INTO tenant_pii_scan_config (tenant_id, scan_enabled, scan_schedule)
VALUES ($1::uuid, COALESCE($3, false), NULLIF($5, ''))
ON CONFLICT (tenant_id) DO UPDATE SET
    scan_enabled  = CASE WHEN $2 THEN $3 ELSE tenant_pii_scan_config.scan_enabled END,
    scan_schedule = CASE WHEN $4 THEN NULLIF($5, '') ELSE tenant_pii_scan_config.scan_schedule END,
    updated_at = now()
RETURNING scan_enabled, scan_schedule, updated_at`,
		tenantID, enabledSet, enabled, scheduleSet, schedule)
	if err := row.Scan(&cfg.ScanEnabled, &outSchedule, &cfg.UpdatedAt); err != nil {
		return nil, err
	}
	if outSchedule != nil {
		cfg.ScanSchedule = *outSchedule
	}
	cfg.CoverageEvidence, err = r.getCoverageTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := r.getRuntimeContractTx(ctx, tx, &cfg); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// normalizePage clamps the page/per_page params: page ≥ 1, per_page in [1,200],
// defaulting to 50.
func normalizePage(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 50
	}
	if perPage > 200 {
		perPage = 200
	}
	return page, perPage
}

func normalizeFindingFilter(filter FindingFilter) (FindingFilter, error) {
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	filter.DetectedType = strings.ToLower(strings.TrimSpace(filter.DetectedType))
	filter.Query = strings.TrimSpace(filter.Query)
	if filter.Status != "" && !IsValidStatus(filter.Status) {
		return FindingFilter{}, fmt.Errorf("%w: invalid status", ErrInvalidInput)
	}
	if filter.DetectedType != "" && !IsValidDetectionType(filter.DetectedType) {
		return FindingFilter{}, fmt.Errorf("%w: invalid detected_type", ErrInvalidInput)
	}
	if utf8.RuneCountInString(filter.Query) > 128 || strings.IndexFunc(filter.Query, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return FindingFilter{}, fmt.Errorf("%w: q must be 128 printable characters or fewer", ErrInvalidInput)
	}
	if filter.Page > 1_000_000 {
		return FindingFilter{}, fmt.Errorf("%w: page must be 1000000 or fewer", ErrInvalidInput)
	}
	filter.Page, filter.PerPage = normalizePage(filter.Page, filter.PerPage)
	return filter, nil
}

func isFingerprintPrefix(value string) bool {
	if len(value) < 8 || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func isFullFingerprint(value string) bool {
	return len(value) == 64 && isFingerprintPrefix(value)
}

func escapeLikeLiteral(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
