// SPDX-License-Identifier: AGPL-3.0-only
//
// Package pii_scanner implements SUB-071 — shadow-PII discovery.
//
// It performs bounded scans for *undeclared* PII (SSN, credit-card,
// date-of-birth, passport, drivers-license, e-mail, phone, IP, IBAN) and queues
// detections in subscriber_pii_findings for DPO review. Per-tenant scanning is
// gated by tenant_pii_scan_config. Migration 1762 makes the persisted
// scan-relevant current-profile revision and privacy-safe intent transactional
// for every direct writer of that projection, with retry/DLQ and exact
// current-profile reconciliation evidence. Retained history, notes, and event
// or content payload stores are a separate coverage boundary.
//
// The detector is regex + heuristic (Luhn for cards, range checks for SSN); the
// LLM seam is left as a future-extension point on Detector (the regex pass is
// the deterministic baseline a DPO can trust).
package pii_scanner

import (
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// These identifiers are persisted with every detection and copied into the
	// immutable review receipt. They are deliberately explicit: changing a
	// detector or decision policy must create a new version rather than silently
	// changing the meaning of historical findings.
	ScannerName     = "postwave-shadow-pii"
	ScannerVersion  = "2.0.0"
	DetectorName    = "regex-heuristic"
	DetectorVersion = "2.0.0"
	PolicyName      = "undeclared-pii-review"
	PolicyVersion   = "sub-071-v2"

	// Pre-1760 findings had no persisted detector or policy identity. Migration
	// 1760 uses these labels instead of fabricating current provenance.
	LegacyScannerName     = "legacy-unversioned"
	LegacyScannerVersion  = "unknown-pre-1760"
	LegacyDetectorName    = "legacy-unversioned"
	LegacyDetectorVersion = "unknown-pre-1760"
	LegacyPolicyName      = "legacy-unversioned"
	LegacyPolicyVersion   = "unknown-pre-1760"
)

// DetectionType is the closed taxonomy of PII kinds the detector can flag.
// Mirrors the migration 0550 detected_type CHECK constraint.
type DetectionType string

const (
	TypeSSN            DetectionType = "ssn"
	TypeCreditCard     DetectionType = "credit_card"
	TypeDateOfBirth    DetectionType = "date_of_birth"
	TypePassport       DetectionType = "passport"
	TypeDriversLicense DetectionType = "drivers_license"
	TypeEmail          DetectionType = "email"
	TypePhone          DetectionType = "phone"
	TypeIPAddress      DetectionType = "ip_address"
	TypeIBAN           DetectionType = "iban"
	TypeOther          DetectionType = "other"
)

// IsValidDetectionType reports whether s is one of the accepted detection
// types (used to validate inbound filters).
func IsValidDetectionType(s string) bool {
	switch DetectionType(s) {
	case TypeSSN, TypeCreditCard, TypeDateOfBirth, TypePassport,
		TypeDriversLicense, TypeEmail, TypePhone, TypeIPAddress, TypeIBAN, TypeOther:
		return true
	}
	return false
}

// Finding-status lifecycle. Mirrors the migration 0550 status CHECK constraint.
const (
	StatusPending   = "pending"
	StatusReviewed  = "reviewed"
	StatusDismissed = "dismissed"
)

// Outcome-specific review reasons. A reviewed finding and a dismissed false
// positive are materially different compliance decisions, so their reason
// taxonomies intentionally do not overlap.
const (
	ReasonConfirmedPII    = "confirmed_pii"
	ReasonRemediated      = "remediated"
	ReasonAcceptedRisk    = "accepted_risk"
	ReasonFalsePositive   = "false_positive"
	ReasonDuplicate       = "duplicate"
	ReasonTestData        = "test_data"
	ReasonNotPersonalData = "not_personal_data"
	// ReasonLegacyMigrated is response-only. Migration 1760 uses it for old
	// terminal rows whose original rationale was never captured; new review
	// requests cannot submit it.
	ReasonLegacyMigrated = "legacy_migrated"
)

// IsValidStatus reports whether s is one of the review-lifecycle statuses.
func IsValidStatus(s string) bool {
	switch s {
	case StatusPending, StatusReviewed, StatusDismissed:
		return true
	}
	return false
}

// Detection is one PII match the Detector found in a field value. It carries a
// versioned, domain-separated HMAC fingerprint (never the cleartext) so a
// finding can be persisted and de-duped without creating an offline
// enumeration oracle for low-entropy identifiers.
type Detection struct {
	FieldName             string        `json:"field_name"`
	DetectedType          DetectionType `json:"detected_type"`
	Confidence            float64       `json:"confidence"`
	Fingerprint           string        `json:"fingerprint"`
	FingerprintScheme     string        `json:"fingerprint_scheme"`
	FingerprintKeyVersion string        `json:"fingerprint_key_version"`
	ScannerName           string        `json:"scanner_name"`
	ScannerVersion        string        `json:"scanner_version"`
	DetectorName          string        `json:"detector_name"`
	DetectorVersion       string        `json:"detector_version"`
	PolicyName            string        `json:"policy_name"`
	PolicyVersion         string        `json:"policy_version"`
}

// ScanResult makes detector work limits observable to the caller. Truncation
// must never be interpreted as a clean current-profile snapshot; the durable
// worker persists it as an explicit coverage gap and dead-letter repair target.
type ScanResult struct {
	Detections      []Detection
	Truncated       bool
	FieldsScanned   int
	FieldsDeclared  int
	FieldsReserved  int
	FieldsOverLimit int
}

// Finding is the persisted subscriber_pii_findings row (0550).
type Finding struct {
	ID                    string                `json:"id"`
	SubscriberID          string                `json:"subscriber_id"`
	FieldName             string                `json:"field_name"`
	DetectedType          DetectionType         `json:"detected_type"`
	Confidence            float64               `json:"confidence"`
	Fingerprint           string                `json:"fingerprint"`
	FingerprintScheme     string                `json:"fingerprint_scheme"`
	FingerprintKeyVersion string                `json:"fingerprint_key_version"`
	Status                string                `json:"status"`
	ScannerName           string                `json:"scanner_name"`
	ScannerVersion        string                `json:"scanner_version"`
	DetectorName          string                `json:"detector_name"`
	DetectorVersion       string                `json:"detector_version"`
	PolicyName            string                `json:"policy_name"`
	PolicyVersion         string                `json:"policy_version"`
	ReviewedAt            *time.Time            `json:"reviewed_at,omitempty"`
	ReviewedBy            string                `json:"reviewed_by,omitempty"`
	ReviewReceipt         *FindingReviewReceipt `json:"review_receipt,omitempty"`
	CreatedAt             time.Time             `json:"created_at"`
	UpdatedAt             time.Time             `json:"updated_at"`
}

// FindingReviewReceipt is the immutable decision record associated one-to-one
// with a terminal finding. It contains only the versioned keyed fingerprint
// (or a non-recomputable legacy-redacted token), never the matched value.
type FindingReviewReceipt struct {
	ReceiptID             string    `json:"receipt_id"`
	Status                string    `json:"status"`
	Reason                string    `json:"reason"`
	Comment               string    `json:"comment"`
	EvidenceReference     string    `json:"evidence_reference"`
	ReviewedAt            time.Time `json:"reviewed_at"`
	ActorType             string    `json:"actor_type"`
	ActorID               string    `json:"actor_id"`
	ScannerName           string    `json:"scanner_name"`
	ScannerVersion        string    `json:"scanner_version"`
	DetectorName          string    `json:"detector_name"`
	DetectorVersion       string    `json:"detector_version"`
	PolicyName            string    `json:"policy_name"`
	PolicyVersion         string    `json:"policy_version"`
	Fingerprint           string    `json:"fingerprint"`
	FingerprintScheme     string    `json:"fingerprint_scheme"`
	FingerprintKeyVersion string    `json:"fingerprint_key_version"`
	FindingUpdatedAt      time.Time `json:"finding_updated_at"`
}

// FindingPage is the list response shape.
type FindingPage struct {
	Items   []Finding `json:"items"`
	Total   int       `json:"total"`
	Page    int       `json:"page"`
	PerPage int       `json:"per_page"`
}

// FindingFilter is the privacy-safe server-side inbox query. Query never
// touches subscriber email/name/field values; it searches field metadata,
// exact UUIDs, and keyed-fingerprint prefixes only. Random legacy-redacted
// tokens are never searchable.
type FindingFilter struct {
	Status       string
	DetectedType string
	Query        string
	Page         int
	PerPage      int
}

// ScanConfig is the per-tenant scanner config (tenant_pii_scan_config, 0551).
type ScanConfig struct {
	RuntimeAvailability        string            `json:"-"`
	RuntimeScanContract        string            `json:"-"`
	ScanEnabled                bool              `json:"scan_enabled"`
	ScanSchedule               string            `json:"scan_schedule,omitempty"`
	Available                  bool              `json:"available"`
	Status                     string            `json:"status"`
	ExecutionMode              string            `json:"execution_mode"`
	ScheduledScansAvailable    bool              `json:"scheduled_scans_available"`
	ScannerName                string            `json:"scanner_name"`
	ScannerVersion             string            `json:"scanner_version"`
	DetectorName               string            `json:"detector_name"`
	DetectorVersion            string            `json:"detector_version"`
	PolicyName                 string            `json:"policy_name"`
	PolicyVersion              string            `json:"policy_version"`
	FingerprintScheme          string            `json:"fingerprint_scheme,omitempty"`
	FingerprintKeyVersion      string            `json:"fingerprint_key_version,omitempty"`
	Reliability                string            `json:"reliability"`
	Coverage                   string            `json:"coverage"`
	CoverageLimitations        []string          `json:"coverage_limitations"`
	MaxScanFields              int               `json:"max_scan_fields"`
	MaxScanFieldBytes          int               `json:"max_scan_field_bytes"`
	MaxScanSubscriberBytes     int               `json:"max_scan_subscriber_bytes"`
	MaxDetectionsPerField      int               `json:"max_detections_per_field"`
	MaxDetectionsPerSubscriber int               `json:"max_detections_per_subscriber"`
	CoverageEvidence           *CoverageSnapshot `json:"coverage_evidence,omitempty"`
	UpdatedAt                  time.Time         `json:"updated_at,omitempty"`
}

// CoverageSnapshot is the persisted tenant watermark produced by the durable
// current-profile all-writer scanner. snapshot_exact is deliberately explicit:
// every scan-relevant subscribers/config/schema write for that projection
// dirties the row in the same transaction, and only the reconciler can set it
// true while holding that row lock. Counts from a non-exact snapshot are useful
// progress telemetry, never a clean current-profile claim. This evidence says
// nothing about retained history, notes, or event/content payload stores.
type CoverageSnapshot struct {
	// ScanContract is internal comparison evidence. The public config already
	// exposes its individual non-secret provenance fields; omitting this joined
	// representation avoids creating a second client contract.
	ScanContract              string     `json:"-"`
	Generation                int64      `json:"generation"`
	Status                    string     `json:"status"`
	SnapshotExact             bool       `json:"snapshot_exact"`
	TotalSubscribers          int64      `json:"total_subscribers"`
	CoveredSubscribers        int64      `json:"covered_subscribers"`
	PendingSubscribers        int64      `json:"pending_subscribers"`
	RetryingSubscribers       int64      `json:"retrying_subscribers"`
	DeadLetterSubscribers     int64      `json:"dead_letter_subscribers"`
	TruncatedSubscribers      int64      `json:"truncated_subscribers"`
	MissingStateSubscribers   int64      `json:"missing_state_subscribers"`
	CoalescedRevisions        int64      `json:"coalesced_revisions"`
	OldestPendingAt           *time.Time `json:"oldest_pending_at,omitempty"`
	EnableRequestedAt         *time.Time `json:"enable_requested_at,omitempty"`
	BackfillStartedAt         *time.Time `json:"backfill_started_at,omitempty"`
	BackfillCompletedAt       *time.Time `json:"backfill_completed_at,omitempty"`
	ReconciliationRequestedAt *time.Time `json:"reconciliation_requested_at,omitempty"`
	LastReconciledAt          *time.Time `json:"last_reconciled_at,omitempty"`
	LastObservedAt            *time.Time `json:"last_observed_at,omitempty"`
	LastScannedAt             *time.Time `json:"last_scanned_at,omitempty"`
}

// ScanIntent is a privacy-safe durable unit claimed by the worker. It contains
// identity/revision/lease metadata only; subscriber values are fetched later
// under tenant scope and never copied into the queue or coverage ledger.
type ScanIntent struct {
	TenantID          string
	SubscriberID      string
	ScanContract      string
	TargetRevision    int64
	TargetGeneration  int64
	ClaimedRevision   int64
	ClaimedGeneration int64
	Attempts          int
	MaxAttempts       int
	LeaseOwner        string
	LeaseToken        string
	LeaseExpiresAt    time.Time
}

// SubscriberSnapshot is the bounded current-value projection processed for a
// claimed revision. Fields never leave process memory.
type SubscriberSnapshot struct {
	Revision           int64
	Fields             map[string]any
	Declared           map[string]bool
	CandidateFields    int
	TransportBytes     int
	TransportTruncated bool
}

// ScanRepairInput is the admin-only operator recovery contract. Requeue is
// bounded per request; callers repeat until affected=0. Reconciliation is a
// cheap durable request and never scans rows on the HTTP goroutine.
type ScanRepairInput struct {
	Action       string `json:"action"`
	SubscriberID string `json:"subscriber_id,omitempty"`
	Limit        int    `json:"limit,omitempty"`
	Confirmation string `json:"confirmation"`
}

type ScanRepairResult struct {
	Action   string `json:"action"`
	Affected int64  `json:"affected"`
	Status   string `json:"status"`
}

// UpdateScanConfigInput is the POST /api/v1/pii-scan-config body. Pointer
// fields distinguish "omitted" from an explicit value.
type UpdateScanConfigInput struct {
	ScanEnabled  *bool   `json:"scan_enabled"`
	ScanSchedule *string `json:"scan_schedule"`
}

// UpdateFindingInput is the PATCH /api/v1/pii-findings/{id} body.
type UpdateFindingInput struct {
	// Status must be "reviewed" or "dismissed" — a finding cannot be moved
	// back to "pending" via this surface.
	Status            string    `json:"status"`
	Reason            string    `json:"reason"`
	Comment           string    `json:"comment"`
	EvidenceReference string    `json:"evidence_reference"`
	ExpectedUpdatedAt time.Time `json:"expected_updated_at"`
}

// ReviewActor is the stable non-PII principal identity copied into a receipt.
// Email addresses and mutable display labels are deliberately excluded.
type ReviewActor struct {
	Type string
	ID   string
}

var (
	evidenceReferenceRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$`)
	// These shapes mirror migration 1760's receipt CHECK exactly. They are
	// intentionally conservative: a long numeric/internal reference belongs in
	// evidence_reference, not in the free-text rationale.
	longNumericReferenceRE = regexp.MustCompile(`\b(?:[0-9][ -]?){12,18}[0-9]\b`)
	ipv4ShapeRE            = regexp.MustCompile(`\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b`)
	ipv6ShapeRE            = regexp.MustCompile(`(?i)\b[0-9A-F]{1,4}(?::[0-9A-F]{0,4}){2,7}\b`)
)

// NormalizeAndValidate canonicalises a review decision and enforces the
// fail-closed receipt contract before a transaction is opened.
func (in *UpdateFindingInput) NormalizeAndValidate() error {
	if in == nil {
		return ErrInvalidInput
	}
	in.Status = strings.ToLower(strings.TrimSpace(in.Status))
	in.Reason = strings.ToLower(strings.TrimSpace(in.Reason))
	in.Comment = strings.TrimSpace(in.Comment)
	in.EvidenceReference = strings.TrimSpace(in.EvidenceReference)

	if in.Status != StatusReviewed && in.Status != StatusDismissed {
		return errors.New("status must be reviewed or dismissed")
	}
	if !IsValidReviewReason(in.Status, in.Reason) {
		return errors.New("reason is not valid for the selected status")
	}
	if utf8.RuneCountInString(in.Comment) < 1 || utf8.RuneCountInString(in.Comment) > 2000 {
		return errors.New("comment is required and must be 2000 characters or fewer")
	}
	if utf8.RuneCountInString(in.EvidenceReference) < 3 || utf8.RuneCountInString(in.EvidenceReference) > 288 ||
		!evidenceReferenceRE.MatchString(in.EvidenceReference) {
		return errors.New("evidence_reference must be a safe typed reference such as ticket:DPO-123")
	}
	if in.ExpectedUpdatedAt.IsZero() {
		return errors.New("expected_updated_at is required")
	}
	if containsStrongPII(in.Comment) {
		return errors.New("comment must not contain raw personal data; use the evidence reference")
	}
	return nil
}

// IsValidReviewReason enforces the outcome-specific reason taxonomy.
func IsValidReviewReason(status, reason string) bool {
	switch status {
	case StatusReviewed:
		return reason == ReasonConfirmedPII || reason == ReasonRemediated || reason == ReasonAcceptedRisk
	case StatusDismissed:
		return reason == ReasonFalsePositive || reason == ReasonDuplicate || reason == ReasonTestData || reason == ReasonNotPersonalData
	default:
		return false
	}
}

// containsStrongPII rejects the high-confidence forms that should never be
// copied into a reviewer comment. Dates and phone-like ticket numbers are not
// included because they produce unacceptable false positives; the UI also
// instructs reviewers to cite a typed evidence reference instead of raw data.
func containsStrongPII(value string) bool {
	if ssnRE.MatchString(value) || emailRE.MatchString(value) || ibanRE.MatchString(value) ||
		ipv4ShapeRE.MatchString(value) || ipv6ShapeRE.MatchString(value) || longNumericReferenceRE.MatchString(value) {
		return true
	}
	return false
}
