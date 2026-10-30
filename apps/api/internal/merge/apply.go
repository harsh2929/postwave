// SPDX-License-Identifier: AGPL-3.0-only
//
// apply.go — POST /api/v1/merge/apply (feat/full-surface-wiring
// task 7): execute a subscriber merge transactionally.
//
// This is the write half of the duplicate-finder flow
// (internal/subscriber_dedupe lists candidates; the desktop's
// DuplicatesModal previews the plan with dry_run=true, then applies
// it). The body:
//
//	{"primary_id": "...", "duplicate_id": "...", "dry_run": false}
//
// dry_run=true computes and returns the EXACT plan without writing;
// dry_run=false executes that same plan — both paths share
// computeMergePlan(), so apply provably mirrors the preview.
//
// Merge semantics mirror POST /api/v1/subscribers/merge
// (internal/subscribers/merge.go) field-for-field:
//   - tags             union (primary order first)
//   - custom_fields    union, primary keys win
//   - status           strictest wins (unsubscribed > blocklisted >
//     disabled > enabled)
//   - consent          earliest non-null timestamp (canonical opt-in)
//   - gdpr_permissions union, most-restrictive-wins per key
//   - subscriber_events + suppressions + email_suppressions re-point
//     from the duplicate's email to the primary's
//
// with ONE deliberate divergence: the loser is SOFT-deleted (status →
// 'disabled', a pw:merged tag, and merged_into/merged_at markers in
// custom_fields) instead of hard-DELETEd, so the merge is auditable
// and reversible by an operator. Every apply writes a
// subscriber.merge.applied audit_log row in the same transaction.

package merge

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/gdprpermissions"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const applyJSONMaxBodyBytes int64 = 16 << 10

// mergedLoserTag marks soft-deleted merge losers so segments /
// exports can filter them.
const mergedLoserTag = "pw:merged"

// Typed sentinels — safe to echo to callers.
var (
	ErrSameSubscriber = errors.New("merge: primary and duplicate are the same subscriber")
	ErrAlreadyMerged  = errors.New("merge: duplicate was already merged")
	ErrStaleReview    = errors.New("merge: reviewed subscriber state changed")
	ErrReviewRequired = errors.New("merge: a complete duplicate scan and reviewed plan are required")
	ErrCandidateStale = errors.New("merge: duplicate scan candidate is stale")
)

// applyRequest is the POST body.
type applyRequest struct {
	PrimaryID                  string     `json:"primary_id"`
	DuplicateID                string     `json:"duplicate_id"`
	ScanID                     string     `json:"scan_id"`
	ExpectedPrimaryUpdatedAt   *time.Time `json:"expected_primary_updated_at"`
	ExpectedDuplicateUpdatedAt *time.Time `json:"expected_duplicate_updated_at"`
	ExpectedPlanFingerprint    string     `json:"expected_plan_fingerprint,omitempty"`
	DryRun                     bool       `json:"dry_run,omitempty"`
}

// MergeConflict makes primary-wins behavior reviewable before apply. Values
// are returned only to the authorized operator and never copied into error or
// telemetry strings.
type MergeConflict struct {
	Field          string `json:"field"`
	PrimaryValue   any    `json:"primary_value"`
	DuplicateValue any    `json:"duplicate_value"`
	Resolution     string `json:"resolution"`
}

// MergePlan is the computed outcome — returned by dry_run and
// executed verbatim by apply.
type MergePlan struct {
	Tags                 []string         `json:"tags"`
	CustomFields         map[string]any   `json:"custom_fields"`
	Status               string           `json:"status"`
	ConsentTimestamp     *time.Time       `json:"consent_timestamp,omitempty"`
	GDPRPermissions      []map[string]any `json:"gdpr_permissions"`
	Conflicts            []MergeConflict  `json:"conflicts"`
	PreservedOnDuplicate []string         `json:"preserved_on_duplicate"`
}

// applyResponse is the wire shape.
type applyResponse struct {
	PrimaryID          string    `json:"primary_id"`
	DuplicateID        string    `json:"duplicate_id"`
	DryRun             bool      `json:"dry_run"`
	Plan               MergePlan `json:"plan"`
	EventsMoved        int64     `json:"events_moved"`
	SuppressionsMoved  int64     `json:"suppressions_moved"`
	LoserSoftDeleted   bool      `json:"loser_soft_deleted"`
	PrimaryUpdatedAt   time.Time `json:"primary_updated_at"`
	DuplicateUpdatedAt time.Time `json:"duplicate_updated_at"`
	PlanFingerprint    string    `json:"plan_fingerprint"`
}

// mergeSubjectRow is the per-subscriber state the plan derives from.
type mergeSubjectRow struct {
	email            string
	tags             []string
	cf               map[string]any
	status           string
	consentTimestamp *time.Time
	gdprPermissions  []map[string]any
	updatedAt        time.Time
}

// computeMergePlan applies the documented rules. Pure — unit-tested
// directly, and the single source of truth for preview AND apply.
func computeMergePlan(primary, duplicate mergeSubjectRow) MergePlan {
	conflicts := make([]MergeConflict, 0)
	keys := make([]string, 0, len(primary.cf))
	for key := range primary.cf {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		primaryValue := primary.cf[key]
		duplicateValue, exists := duplicate.cf[key]
		if !exists || valuesEqual(primaryValue, duplicateValue) {
			continue
		}
		conflicts = append(conflicts, MergeConflict{
			Field:          "custom_fields." + key,
			PrimaryValue:   primaryValue,
			DuplicateValue: duplicateValue,
			Resolution:     "primary_wins",
		})
	}
	if primary.status != duplicate.status {
		conflicts = append(conflicts, MergeConflict{
			Field:          "status",
			PrimaryValue:   primary.status,
			DuplicateValue: duplicate.status,
			Resolution:     "most_restrictive_wins",
		})
	}
	return MergePlan{
		Tags:             unionStrings(primary.tags, duplicate.tags),
		CustomFields:     mergeMaps(primary.cf, duplicate.cf),
		Status:           strictestStatus(primary.status, duplicate.status),
		ConsentTimestamp: earliestConsent(primary.consentTimestamp, duplicate.consentTimestamp),
		GDPRPermissions:  unionGDPRPermissions(primary.gdprPermissions, duplicate.gdprPermissions),
		Conflicts:        conflicts,
		PreservedOnDuplicate: []string{
			"email and profile identifiers",
			"audience merge fields and name/location fields",
			"list memberships, notes, and ID-keyed history",
		},
	}
}

func valuesEqual(a, b any) bool {
	aRaw, aErr := json.Marshal(a)
	bRaw, bErr := json.Marshal(b)
	return aErr == nil && bErr == nil && string(aRaw) == string(bRaw)
}

// Apply POST /api/v1/merge/apply.
func (d *Deps) Apply(w http.ResponseWriter, r *http.Request) {
	if d == nil || d.Pool == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "merge_unavailable",
			"merge apply requires a database pool")
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in applyRequest
	if err := httpbody.DecodeJSON(w, r, applyJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.PrimaryID == "" || in.DuplicateID == "" {
		httperror.WriteValidation(w, "missing_ids", "primary_id and duplicate_id required")
		return
	}
	if _, err := uuid.Parse(in.PrimaryID); err != nil {
		httperror.WriteValidation(w, "invalid_primary_id", "primary_id must be a UUID")
		return
	}
	if _, err := uuid.Parse(in.DuplicateID); err != nil {
		httperror.WriteValidation(w, "invalid_duplicate_id", "duplicate_id must be a UUID")
		return
	}
	if in.PrimaryID == in.DuplicateID {
		httperror.WriteValidation(w, "same_subscriber", ErrSameSubscriber.Error())
		return
	}
	if in.ScanID == "" || in.ExpectedPrimaryUpdatedAt == nil || in.ExpectedDuplicateUpdatedAt == nil {
		httperror.Write(w, http.StatusPreconditionRequired, "review_required", ErrReviewRequired.Error())
		return
	}
	if _, err := uuid.Parse(in.ScanID); err != nil {
		httperror.WriteValidation(w, "invalid_scan_id", "scan_id must be a UUID")
		return
	}
	if !in.DryRun && in.ExpectedPlanFingerprint == "" {
		httperror.Write(w, http.StatusPreconditionRequired, "review_required", ErrReviewRequired.Error())
		return
	}
	resp, err := d.apply(r.Context(), t.ID, in, middleware.AuditMetaFromRequest(r))
	if err != nil {
		switch {
		case errors.Is(err, ErrAlreadyMerged):
			httperror.Write(w, http.StatusConflict, "already_merged", err.Error())
		case errors.Is(err, ErrStaleReview):
			httperror.Write(w, http.StatusConflict, "stale_review", "Subscriber data changed after review. Refresh the plan before merging.")
		case errors.Is(err, ErrCandidateStale):
			httperror.Write(w, http.StatusConflict, "candidate_stale", "This duplicate candidate is no longer part of the reviewed scan. Start a new scan.")
		default:
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		}
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// apply runs the whole merge in ONE tenant-scoped transaction —
// plan, primary update, history re-pointing, loser soft-delete, and
// the audit row commit or roll back together.
func (d *Deps) apply(ctx context.Context, tenantID string, in applyRequest, meta db.AuditMeta) (*applyResponse, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize both directions of the same pair before taking row locks. This
	// prevents two operators choosing opposite primaries from deadlocking.
	lockIDs := []string{in.PrimaryID, in.DuplicateID}
	sort.Strings(lockIDs)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		tenantID+":"+lockIDs[0]+":"+lockIDs[1]); err != nil {
		return nil, err
	}

	var (
		scanPrimaryID          string
		scanDuplicateID        string
		scanPrimaryUpdatedAt   time.Time
		scanDuplicateUpdatedAt time.Time
	)
	if err := tx.QueryRow(ctx, `
SELECT pair.primary_id::text, pair.duplicate_id::text,
       pair.primary_updated_at, pair.duplicate_updated_at
  FROM subscriber_duplicate_scan_pairs pair
  JOIN subscriber_duplicate_scans scan
    ON scan.tenant_id = pair.tenant_id AND scan.id = pair.scan_id
 WHERE pair.tenant_id = $1::uuid AND pair.scan_id = $2::uuid
   AND scan.status = 'complete' AND scan.expires_at > now()
   AND ((pair.primary_id = $3::uuid AND pair.duplicate_id = $4::uuid)
     OR (pair.primary_id = $4::uuid AND pair.duplicate_id = $3::uuid))`,
		tenantID, in.ScanID, in.PrimaryID, in.DuplicateID).
		Scan(&scanPrimaryID, &scanDuplicateID, &scanPrimaryUpdatedAt, &scanDuplicateUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCandidateStale
		}
		return nil, err
	}
	// The caller must review the exact versions materialized by the scan. It
	// cannot revive an old pair by substituting newer row versions obtained
	// outside the review flow. Either direction is permitted because the UI
	// lets an operator choose which subscriber survives.
	expectedScanPrimaryUpdatedAt := scanPrimaryUpdatedAt
	expectedScanDuplicateUpdatedAt := scanDuplicateUpdatedAt
	if in.PrimaryID == scanDuplicateID && in.DuplicateID == scanPrimaryID {
		expectedScanPrimaryUpdatedAt = scanDuplicateUpdatedAt
		expectedScanDuplicateUpdatedAt = scanPrimaryUpdatedAt
	}
	if !expectedScanPrimaryUpdatedAt.Equal(in.ExpectedPrimaryUpdatedAt.UTC()) ||
		!expectedScanDuplicateUpdatedAt.Equal(in.ExpectedDuplicateUpdatedAt.UTC()) {
		return nil, ErrCandidateStale
	}

	primary, err := loadMergeSubject(ctx, tx, tenantID, in.PrimaryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCandidateStale
		}
		return nil, err
	}
	duplicate, err := loadMergeSubject(ctx, tx, tenantID, in.DuplicateID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrCandidateStale
		}
		return nil, err
	}
	// A loser of a previous merge must not be merged again — its
	// history was already re-pointed somewhere else.
	if _, alreadyMerged := duplicate.cf["merged_into"]; alreadyMerged {
		return nil, ErrAlreadyMerged
	}
	if !primary.updatedAt.Equal(in.ExpectedPrimaryUpdatedAt.UTC()) ||
		!duplicate.updatedAt.Equal(in.ExpectedDuplicateUpdatedAt.UTC()) {
		return nil, ErrStaleReview
	}

	plan := computeMergePlan(*primary, *duplicate)
	fingerprint, err := mergePlanFingerprint(in.PrimaryID, in.DuplicateID, primary.updatedAt, duplicate.updatedAt, plan)
	if err != nil {
		return nil, err
	}
	resp := &applyResponse{
		PrimaryID:          in.PrimaryID,
		DuplicateID:        in.DuplicateID,
		DryRun:             in.DryRun,
		Plan:               plan,
		PrimaryUpdatedAt:   primary.updatedAt,
		DuplicateUpdatedAt: duplicate.updatedAt,
		PlanFingerprint:    fingerprint,
	}
	if in.DryRun {
		// Preview: compute only — the deferred rollback discards the tx.
		return resp, nil
	}
	if subtle.ConstantTimeCompare([]byte(fingerprint), []byte(in.ExpectedPlanFingerprint)) != 1 {
		return nil, ErrStaleReview
	}

	cfBytes, err := json.Marshal(plan.CustomFields)
	if err != nil {
		return nil, fmt.Errorf("encode merged custom fields: %w", err)
	}
	gdprBytes, err := json.Marshal(plan.GDPRPermissions)
	if err != nil {
		return nil, fmt.Errorf("encode merged GDPR permissions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET tags              = $1::text[],
       custom_fields     = $2::jsonb,
       status            = $3,
       consent_timestamp = $4,
       gdpr_permissions  = $5::jsonb,
       updated_at        = now()
 WHERE tenant_id = $6::uuid AND id = $7::uuid`,
		plan.Tags, string(cfBytes), plan.Status, plan.ConsentTimestamp,
		string(gdprBytes), tenantID, in.PrimaryID); err != nil {
		return nil, err
	}

	// Repoint through the receipt-backed projection mutation authority. It moves
	// every canonical event owned by the duplicate address, mirrors any linked
	// campaign report row, and records immutable before/after fingerprints in
	// this same merge transaction. Direct subscriber_events UPDATE privilege is
	// intentionally revoked by migration 1964.
	var eventsMoved int64
	err = tx.QueryRow(ctx, `
SELECT campaign_report_projection_repoint_subscriber_events(
       $2::uuid, ARRAY[$3::citext], $1::citext,
       'subscriber_merge', gen_random_uuid()
  )`,
		primary.email, tenantID, duplicate.email).Scan(&eventsMoved)
	if err != nil {
		return nil, err
	}
	resp.EventsMoved = eventsMoved

	suppMoved, err := movePerEmail(ctx, tx, "suppressions", "email", tenantID, duplicate.email, primary.email)
	if err != nil {
		return nil, err
	}
	emailSuppMoved, err := movePerEmail(ctx, tx, "email_suppressions", "email", tenantID, duplicate.email, primary.email)
	if err != nil {
		return nil, err
	}
	resp.SuppressionsMoved = suppMoved + emailSuppMoved

	// Soft-delete the loser: disabled + marker tag + provenance in
	// custom_fields. The row (and its email) survives for audit /
	// undo; status='disabled' keeps it out of every send path.
	if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET status        = 'disabled',
       tags          = CASE WHEN $1 = ANY(tags) THEN tags
                            ELSE array_append(tags, $1) END,
       custom_fields = custom_fields
                       || jsonb_build_object('merged_into', $2::text,
                                             'merged_at', to_char(now() AT TIME ZONE 'utc',
                                                                  'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
       updated_at    = now()
 WHERE tenant_id = $3::uuid AND id = $4::uuid`,
		mergedLoserTag, in.PrimaryID, tenantID, in.DuplicateID); err != nil {
		return nil, err
	}
	resp.LoserSoftDeleted = true

	// Audit row in the SAME tx — a merge is a destructive (consent-
	// affecting) operation; GDPR Article 30 needs the trail even when
	// the loser row survives.
	meta.TenantID = tenantID
	if err := db.Audit(ctx, tx, meta, "subscriber.merge.applied", "subscriber", in.PrimaryID,
		map[string]any{
			"primary_id":         in.PrimaryID,
			"duplicate_id":       in.DuplicateID,
			"events_moved":       resp.EventsMoved,
			"suppressions_moved": resp.SuppressionsMoved,
			"merged_status":      plan.Status,
			"tags_merged":        len(plan.Tags),
			"loser_soft_deleted": true,
			"duplicate_scan_id":  in.ScanID,
			"plan_fingerprint":   fingerprint,
		}); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return resp, nil
}

func loadMergeSubject(ctx context.Context, tx pgx.Tx, tenantID, id string) (*mergeSubjectRow, error) {
	var (
		email     string
		tags      []string
		cfBytes   []byte
		status    string
		consentTs *time.Time
		gdprBytes []byte
		updatedAt time.Time
	)
	if err := tx.QueryRow(ctx, `
SELECT email::text,
       COALESCE(tags, ARRAY[]::text[]),
       COALESCE(custom_fields, '{}'::jsonb),
       COALESCE(status, ''),
       consent_timestamp,
       COALESCE(gdpr_permissions, '[]'::jsonb),
       updated_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`,
		tenantID, id).Scan(&email, &tags, &cfBytes, &status, &consentTs, &gdprBytes, &updatedAt); err != nil {
		return nil, err
	}
	cf := map[string]any{}
	if len(cfBytes) > 0 {
		if err := json.Unmarshal(cfBytes, &cf); err != nil {
			return nil, fmt.Errorf("decode subscriber custom fields: %w", err)
		}
		if cf == nil {
			return nil, errors.New("decode subscriber custom fields: expected a JSON object")
		}
	}
	gdpr, err := gdprpermissions.Decode(gdprBytes)
	if err != nil {
		return nil, err
	}
	return &mergeSubjectRow{
		email:            email,
		tags:             tags,
		cf:               cf,
		status:           status,
		consentTimestamp: consentTs,
		gdprPermissions:  gdpr,
		updatedAt:        updatedAt,
	}, nil
}

func mergePlanFingerprint(primaryID, duplicateID string, primaryUpdatedAt, duplicateUpdatedAt time.Time, plan MergePlan) (string, error) {
	payload, err := json.Marshal(struct {
		PrimaryID          string    `json:"primary_id"`
		DuplicateID        string    `json:"duplicate_id"`
		PrimaryUpdatedAt   time.Time `json:"primary_updated_at"`
		DuplicateUpdatedAt time.Time `json:"duplicate_updated_at"`
		Plan               MergePlan `json:"plan"`
	}{primaryID, duplicateID, primaryUpdatedAt.UTC(), duplicateUpdatedAt.UTC(), plan})
	if err != nil {
		return "", fmt.Errorf("encode merge plan fingerprint: %w", err)
	}
	digest := sha256.Sum256(payload)
	return fmt.Sprintf("sha256:%x", digest[:]), nil
}

// ----------------------------------------------------------------------
// Plan rules — kept behaviourally identical to internal/subscribers/
// merge.go (the hard-delete merge). Pure; unit-tested.
// ----------------------------------------------------------------------

// earliestConsent returns the older non-nil consent timestamp — the
// canonical opt-in record regulators care about.
func earliestConsent(a, b *time.Time) *time.Time {
	switch {
	case a == nil:
		return b
	case b == nil:
		return a
	case a.Before(*b):
		return a
	default:
		return b
	}
}

// strictestStatus orders statuses by deliverability risk; anything
// non-enabled wins so a merge can never reanimate an opted-out member.
func strictestStatus(a, b string) string {
	rank := func(s string) int {
		switch s {
		case "unsubscribed":
			return 4
		case "blocklisted":
			return 3
		case "disabled":
			return 2
		case "enabled":
			return 1
		default:
			return 0
		}
	}
	if rank(a) >= rank(b) {
		if rank(a) == 0 && b != "" {
			return b
		}
		return a
	}
	return b
}

// unionGDPRPermissions mirrors the hard-delete merge through the shared
// canonical array implementation.
func unionGDPRPermissions(a, b []map[string]any) []map[string]any {
	return gdprpermissions.MergeRestrictive(a, b)
}

func unionStrings(a, b []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, v := range append(append([]string{}, a...), b...) {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

// mergeMaps unions custom_fields with primary keys winning.
func mergeMaps(primary, duplicate map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range duplicate {
		out[k] = v
	}
	for k, v := range primary {
		out[k] = v
	}
	return out
}

// movePerEmail re-points rows in `table` from fromEmail to toEmail,
// skipping rows that would collide with the (tenant_id, email)
// UNIQUE, then deletes leftovers. Schema errors fail the entire transaction;
// a merge must never silently omit suppression state during a partial rollout.
func movePerEmail(ctx context.Context, tx pgx.Tx, table, col, tenantID, fromEmail, toEmail string) (int64, error) {
	updateQ := `
UPDATE ` + table + ` SET ` + col + ` = $1
 WHERE tenant_id = $2::uuid AND ` + col + ` = $3
   AND NOT EXISTS (
       SELECT 1 FROM ` + table + ` s2
        WHERE s2.tenant_id = $2::uuid AND s2.` + col + ` = $1
   )`
	ct, err := tx.Exec(ctx, updateQ, toEmail, tenantID, fromEmail)
	if err != nil {
		return 0, err
	}
	deleteQ := `DELETE FROM ` + table + ` WHERE tenant_id = $1::uuid AND ` + col + ` = $2`
	if _, err := tx.Exec(ctx, deleteQ, tenantID, fromEmail); err != nil {
		return ct.RowsAffected(), err
	}
	return ct.RowsAffected(), nil
}
