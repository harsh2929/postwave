// Subscribers merge / dedup.
//
// Combines a primary subscriber row with one duplicate (matched on
// row id, not on email — callers find duplicates however they like).
// Scalar conflicts follow explicit restrictive/canonical rules; collection
// state is unioned or deduplicated. Address evidence and suppressions preserve
// their exact historical email, operational satellites move to the survivor,
// and immutable evidence remains attached to a PII-minimised lineage
// tombstone instead of being rewritten or cascade-deleted.
//
// One transaction per call (RLS-bound). Returns a small audit row
// describing what moved.

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/gdprpermissions"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"

	"github.com/go-chi/chi/v5"
)

// ErrSameSubscriber is returned when primary_id == duplicate_id.
var ErrSameSubscriber = errors.New("subscribers: primary and duplicate are the same")

// MergeInput is the request body for POST /api/v1/subscribers/merge.
// We accept a single duplicate per call so the caller can give the user
// a clear "merging X into Y" affordance; bulk merges fan out client-side.
type MergeInput struct {
	PrimaryID   string `json:"primary_id"`
	DuplicateID string `json:"duplicate_id"`
	// Both strong revisions are required. A merge destroys DuplicateID and
	// rewrites PrimaryID, so binding the decision to only one row would still
	// allow a concurrent consent/profile change on the other to be lost.
	PrimaryVersion   string `json:"primary_version"`
	DuplicateVersion string `json:"duplicate_version"`
	// Signals (SUB-025) is the optional identity-resolution evidence behind
	// this merge: which heuristic fired (case_diff / plus_alias / dot_alias /
	// external_id_claim / manual ...) and at what confidence. When present
	// each signal is persisted into subscriber_merge_audit_log in the SAME tx
	// as the merge so the granular "why were these judged the same person"
	// provenance is captured alongside the high-level audit_log row. Omitting
	// it leaves the merge behaviour unchanged.
	Signals []MergeSignal `json:"signals,omitempty"`
	// AuditMeta is transport context supplied by the handler, never JSON.
	AuditMeta db.AuditMeta `json:"-"`
	Bulk      bool         `json:"-"`
}

// MergeSignal is one identity-resolution signal that contributed to a merge
// decision. Kind is free text (the application owns the vocabulary so new
// heuristics need no migration); Confidence, when supplied, is clamped/
// validated to [0,1]. Metadata carries optional structured context (matched
// value, normaliser version, ...).
type MergeSignal struct {
	Kind       string         `json:"kind"`
	Confidence *float64       `json:"confidence,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// MergeResult is the response body.
type MergeResult struct {
	PrimaryID          string `json:"primary_id"`
	DuplicateID        string `json:"duplicate_id"`
	EventsMoved        int64  `json:"events_moved"`
	SuppressionsMoved  int64  `json:"suppressions_moved"`
	TagsMerged         int    `json:"tags_merged"`
	CustomFieldsMerged int    `json:"custom_fields_merged"`
	// SignalsRecorded (SUB-025) is the count of identity-resolution signal
	// rows persisted into subscriber_merge_audit_log for this merge. Zero
	// when the caller supplied no signals.
	SignalsRecorded int `json:"signals_recorded"`
	// PrimaryVersion is the survivor's fresh revision and is repeated in ETag.
	PrimaryVersion string `json:"primary_version"`
}

// MountMergeRoutes registers the merge endpoint. Wrapped with
// observability.RecordSurfaceFunc so pw_subscribers_merge_total +
// pw_subscribers_duration_seconds are emitted (Phase 4
// p4d-recordsurface-wire-subscribers).
func MountMergeRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/merge",
			observability.RecordSurfaceFunc("subscribers", "merge", d.MergeHandler))
}

// MergeHandler POST /api/v1/subscribers/merge
func (d *Deps) MergeHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in MergeInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns typed validation errors whose .Error() text is
		// operator-safe (size/format/json-shape messages).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.PrimaryID != "" && in.PrimaryID == in.DuplicateID {
		httperror.WriteValidation(w, "same_subscriber", ErrSameSubscriber.Error())
		return
	}
	if missingMergeVersion(in.PrimaryVersion) || missingMergeVersion(in.DuplicateVersion) {
		httpcache.WritePreconditionRequired(w)
		return
	}
	in.AuditMeta = middleware.AuditMetaFromRequest(r)
	in.AuditMeta.TenantID = t.ID
	res, err := d.Repo.Merge(r.Context(), t.ID, in)
	if err != nil {
		switch {
		case errors.Is(err, ErrSameSubscriber):
			// Typed sentinel — safe to echo.
			httperror.WriteValidation(w, "same_subscriber", err.Error())
			return
		case errors.Is(err, ErrMergePreconditionRequired):
			httpcache.WritePreconditionRequired(w)
			return
		case errors.Is(err, ErrPreconditionFailed):
			httpcache.WritePreconditionFailed(w)
			return
		case errors.Is(err, ErrNotFound):
			httperror.Write(w, http.StatusNotFound, "not_found", "one or both subscribers no longer exist")
			return
		case errors.Is(err, ErrErasureBlocked):
			httperror.Write(w, http.StatusConflict, "erasure_blocked", "an irreversible privacy-erasure tombstone prevents this identity merge")
			return
		case errors.Is(err, ErrMergeConflict):
			httperror.Write(w, http.StatusConflict, "merge_conflict", "the profiles have conflicting protected relationships and require review")
			return
		}
		// Unknown error from the merge path (could be a pgx/DB error
		// whose text is sensitive). Route through WriteInternal so the
		// raw text is logged but not returned to the caller.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// SUB-119: bridge the public merge to the in-process SSE Bus so the
	// desktop's "subscriber.*" wildcard sees subscriber.merged, mirroring the
	// identify path's d.emit("subscriber.merged", ...). The outbound webhook is
	// fired inside Repo.Merge; this is the SSE counterpart. nil-safe.
	d.emit(t.ID, EventSubscriberMerged, map[string]any{
		"primary_id":   res.PrimaryID,
		"duplicate_id": res.DuplicateID,
	})
	w.Header().Set("ETag", res.PrimaryVersion)
	writeJSON(w, http.StatusOK, res)
}

// Merge performs the dedup atomically.
func (r *Repo) Merge(ctx context.Context, tenantID string, in MergeInput) (*MergeResult, error) {
	if in.PrimaryID == "" || in.DuplicateID == "" {
		return nil, errors.New("primary_id and duplicate_id required")
	}
	if in.PrimaryID == in.DuplicateID {
		return nil, ErrSameSubscriber
	}
	if missingMergeVersion(in.PrimaryVersion) || missingMergeVersion(in.DuplicateVersion) {
		return nil, ErrMergePreconditionRequired
	}
	tx, txErr := db.WithTenant(ctx, r.Pool, tenantID)
	if txErr != nil {
		return nil, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out, txErr := r.mergeCanonicalInTx(ctx, tx, tenantID, in.PrimaryID, in.DuplicateID, canonicalMergeOptions{
		PrimaryVersion: in.PrimaryVersion, DuplicateVersion: in.DuplicateVersion,
		Signals: in.Signals, AuditMeta: in.AuditMeta, AuditReason: "reviewed_public_merge", Bulk: in.Bulk,
	})
	if txErr != nil {
		return nil, txErr
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &MergeResult{
		PrimaryID:          in.PrimaryID,
		DuplicateID:        in.DuplicateID,
		EventsMoved:        out.EventsMoved,
		SuppressionsMoved:  out.SuppressionsKept,
		TagsMerged:         out.TagsMerged,
		CustomFieldsMerged: out.CustomFieldsMerged,
		SignalsRecorded:    out.SignalsRecorded,
		PrimaryVersion:     out.Subscriber.Version,
	}, nil
}

func missingMergeVersion(version string) bool {
	trimmed := strings.TrimSpace(version)
	return trimmed == "" || trimmed == "*"
}

// recordMergeSignals validates and persists the SUB-025 identity-resolution
// signal breakdown for a merge into subscriber_merge_audit_log. One row per
// signal, all inside the caller's tx. A signal with an empty Kind is skipped
// (there is no evidence to record). A confidence outside [0,1] is a hard
// validation error — the caller's contract is a probability. Returns the
// number of rows written.
//
// A missing subscriber_merge_audit_log table (deployment not yet migrated to
// 0487) is tolerated as a no-op so the merge itself still succeeds.
func recordMergeSignals(ctx context.Context, tx pgx.Tx, tenantID, primaryID, duplicateID string, signals []MergeSignal) (int, error) {
	recorded := 0
	for _, s := range signals {
		kind := strings.TrimSpace(s.Kind)
		if kind == "" {
			continue
		}
		if s.Confidence != nil && (*s.Confidence < 0 || *s.Confidence > 1) {
			return recorded, fmt.Errorf("merge signal %q: confidence must be between 0 and 1", kind)
		}
		meta := s.Metadata
		if meta == nil {
			meta = map[string]any{}
		}
		metaRaw, _ := json.Marshal(meta)
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_merge_audit_log
    (tenant_id, primary_id, duplicate_id, signal_kind, confidence, metadata)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb)`,
			tenantID, primaryID, duplicateID, kind, s.Confidence, string(metaRaw)); err != nil {
			if isUndefinedTable(err) {
				return recorded, nil
			}
			return recorded, err
		}
		recorded++
	}
	return recorded, nil
}

// earliestConsent returns the older of two non-nil timestamps, or the only
// non-nil one. It is used for historical chronology such as the first consent
// and earliest archive boundary; purpose grants use a separate fail-closed
// intersection and are never created by merge.
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

// strictestStatus orders the database's canonical Listmonk-compatible states
// by deliverability risk. Unknown legacy values fail closed to disabled rather
// than accidentally outranking into a sendable value.
func strictestStatus(a, b string) string {
	rank := func(s string) int {
		switch s {
		case StatusBlocklisted:
			return 4
		case StatusDisabled:
			return 3
		case StatusUnconfirmed:
			return 2
		case StatusEnabled:
			return 1
		default:
			return 5
		}
	}
	if strings.TrimSpace(a) == "" || strings.TrimSpace(b) == "" {
		return StatusDisabled
	}
	if rank(a) >= rank(b) {
		if rank(a) == 5 {
			return StatusDisabled
		}
		return a
	}
	if rank(b) == 5 {
		return StatusDisabled
	}
	return b
}

// unionGDPRPermissions preserves the canonical Mailchimp-compatible array
// shape and applies most-restrictive-wins semantics to matching permissions.
func unionGDPRPermissions(a, b []map[string]any) []map[string]any {
	return gdprpermissions.MergeRestrictive(a, b)
}

type mergeRow struct {
	email            string
	tags             []string
	cf               map[string]any
	status           string
	consentTimestamp *time.Time
	gdprPermissions  []map[string]any
}

func loadMergeRow(ctx context.Context, tx pgx.Tx, tenantID, id string) (*mergeRow, error) {
	var (
		email     string
		tags      []string
		cfBytes   []byte
		status    string
		consentTs *time.Time
		gdprBytes []byte
	)
	if err := tx.QueryRow(ctx, `
SELECT email::text,
       COALESCE(tags, ARRAY[]::text[]),
       COALESCE(custom_fields, '{}'::jsonb),
       COALESCE(status, ''),
       consent_timestamp,
       COALESCE(gdpr_permissions, '[]'::jsonb)
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&email, &tags, &cfBytes, &status, &consentTs, &gdprBytes); err != nil {
		return nil, err
	}
	cf := map[string]any{}
	if len(cfBytes) > 0 {
		_ = json.Unmarshal(cfBytes, &cf)
	}
	gdpr, err := gdprpermissions.Decode(gdprBytes)
	if err != nil {
		return nil, fmt.Errorf("decode gdpr_permissions: %w", err)
	}
	return &mergeRow{
		email:            email,
		tags:             tags,
		cf:               cf,
		status:           status,
		consentTimestamp: consentTs,
		gdprPermissions:  gdpr,
	}, nil
}

// movePerEmail re-points rows in `table` whose `column` matches
// `fromEmail` to instead match `toEmail`, then deletes any rows that
// still match `fromEmail` (e.g. those skipped by the UNIQUE
// constraint). The UNIQUE precondition is hard-coded to
// (tenant_id, <column>) which is what both suppressions tables use.
// Tables that don't exist on a given deployment are tolerated (the
// SQLSTATE undefined_table is mapped to 0 affected rows).
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
		// Tolerate "relation does not exist" for deployments that
		// haven't migrated past 0060/0027 yet.
		if isUndefinedTable(err) {
			return 0, nil
		}
		return 0, err
	}
	deleteQ := `DELETE FROM ` + table + ` WHERE tenant_id = $1::uuid AND ` + col + ` = $2`
	if _, err := tx.Exec(ctx, deleteQ, tenantID, fromEmail); err != nil {
		if isUndefinedTable(err) {
			return ct.RowsAffected(), nil
		}
		return ct.RowsAffected(), err
	}
	return ct.RowsAffected(), nil
}

// repointSubscriberEmail moves every email-keyed historical / state row
// for a subscriber from oldEmail to newEmail inside the supplied tx. It is
// the SUB-024 counterpart to the Merge path's per-table re-pointing: the
// Update handler calls it when a PATCH rotates a subscriber's address so the
// rename does not orphan the row's prior events, topic subscriptions,
// tracking prefs, automation runs, or sequence enrollments.
//
// Tables fall into two shapes, each with its own collision rule:
//
//   - "loose" tables (subscriber_events, automation_executions) have NO
//     UNIQUE constraint on email, so a blind UPDATE moves every row.
//   - "scoped" tables carry a composite UNIQUE that includes
//     subscriber_email plus one or more discriminator columns
//     (subscriber_topics: topic_id; sequence_enrollments: sequence_id;
//     subscriber_tracking_prefs: just the tenant+email PK). Re-pointing a
//     row whose (newEmail, <discriminators>) tuple already exists would
//     violate that UNIQUE, so we move only the non-colliding rows and then
//     delete whatever still references oldEmail (the new address already
//     has the canonical row).
//
// Every statement tolerates a missing table (SQLSTATE 42P01) so a
// deployment that hasn't migrated a given satellite table is unaffected —
// matching movePerEmail's behaviour. Returns the first non-tolerated error.
const (
	projectionMutationEmailRotation   = "email_rotation"
	projectionMutationSubscriberMerge = "subscriber_merge"
	projectionMutationAnonymousStitch = "anonymous_stitch"
)

// repointProjectedSubscriberEvents is the only application-role authority for
// changing subscriber_events.subscriber_email after migration 1964. The
// database function updates unlinked canonical rows normally and, for linked
// rows, mirrors campaign_report_events plus appends a chained before/after
// receipt before this transaction may commit.
func repointProjectedSubscriberEvents(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	oldEmails []string,
	newEmail, purpose string,
) error {
	if len(oldEmails) == 0 || newEmail == "" {
		return nil
	}
	switch purpose {
	case projectionMutationEmailRotation,
		projectionMutationSubscriberMerge,
		projectionMutationAnonymousStitch:
	default:
		return fmt.Errorf("subscriber event projection mutation purpose %q is invalid", purpose)
	}
	var affected int64
	err := tx.QueryRow(ctx, `
SELECT campaign_report_projection_repoint_subscriber_events(
       $1::uuid, $2::citext[], $3::citext, $4, gen_random_uuid()
	  )`, tenantID, oldEmails, newEmail, purpose).Scan(&affected)
	return err
}

func repointSubscriberEmail(ctx context.Context, tx pgx.Tx, tenantID, oldEmail, newEmail string) error {
	return repointSubscriberEmailForPurpose(
		ctx, tx, tenantID, oldEmail, newEmail, projectionMutationEmailRotation,
	)
}

func repointSubscriberEmailForPurpose(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, oldEmail, newEmail, purpose string,
) error {
	if oldEmail == "" || newEmail == "" || strings.EqualFold(oldEmail, newEmail) {
		return nil
	}
	// Retry enqueue uses this same tenant-scoped transaction lock before it
	// resolves address aliases. Whichever commits first therefore wins a clean
	// serial order: enqueue-first is repointed below; rotation-first makes the
	// later enqueue resolve oldEmail to the new canonical address.
	if err := subscriberidentitylock.Tenant(ctx, tx, tenantID); err != nil {
		return err
	}
	if err := repointProjectedSubscriberEvents(
		ctx, tx, tenantID, []string{oldEmail}, newEmail, purpose,
	); err != nil {
		return err
	}
	// Unprojected loose tables have no UNIQUE on subscriber_email, so every
	// historical row can move without collision loss. Keeping send-log history
	// attached to the canonical address is also a frequency-cap invariant: an
	// address rotation must not reset the recipient's active lookback.
	for _, table := range []string{"automation_executions", "subscriber_send_log"} {
		if _, err := tx.Exec(ctx, `
UPDATE `+table+` SET subscriber_email = $1
 WHERE tenant_id = $2::uuid AND subscriber_email = $3`,
			newEmail, tenantID, oldEmail); err != nil {
			if !isUndefinedTable(err) {
				return err
			}
		}
	}
	// Scoped tables: composite UNIQUE keyed on subscriber_email + extra
	// discriminator columns. Move only rows whose target tuple is free,
	// then drop any remaining oldEmail rows (the newEmail row already wins).
	scoped := []struct {
		table string
		// discriminators are the non-email columns in the UNIQUE/PK that
		// must match for two rows to collide on the new address. Empty
		// means the UNIQUE is just (tenant_id, subscriber_email).
		discriminators []string
	}{
		{"subscriber_topics", []string{"topic_id"}},
		{"sequence_enrollments", []string{"sequence_id"}},
		{"subscriber_tracking_prefs", nil},
	}
	for _, s := range scoped {
		if err := repointScopedEmail(ctx, tx, s.table, s.discriminators, tenantID, oldEmail, newEmail); err != nil {
			return err
		}
	}
	if err := repointIntelligentRetryEmail(ctx, tx, tenantID, oldEmail, newEmail); err != nil {
		return err
	}
	return nil
}

// repointIntelligentRetryEmail merges retry tuples conservatively before it
// removes the non-canonical address. A generic "target row wins" collision is
// unsafe here: an old dismissed row could be discarded in favour of a pending
// target and silently re-enable a retry for the same person/campaign/reason.
//
// Status precedence is deliberately safety-biased:
//
//	dismissed > retried > canonical live retrying > ready > pending > failed
//
// Dismissal is sticky; retried prevents a second successful retry. A live
// worker already holding the canonical target keeps its exact id/revision and
// may finish normally. Any retrying state attached to the losing old address
// is reset to pending and receives a new revision: its worker's in-memory email
// is stale, so allowing its lease CAS to pass could incorrectly mark the moved
// event failed. Stale target leases are reset too. created_at always moves
// backwards to the earliest source so identity consolidation cannot extend the
// privacy-retention deadline.
func repointIntelligentRetryEmail(ctx context.Context, tx pgx.Tx, tenantID, oldEmail, newEmail string) error {
	leaseSeconds := int64(intelligent_retry.RetryClaimLeaseDuration / time.Second)
	// Lock every affected tuple in stable id order before deriving collision
	// state. This serializes against worker CAS updates and prevents a mixed
	// snapshot across the merge/update/delete statements below.
	if _, err := tx.Exec(ctx, `
SELECT id
  FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid
   AND subscriber_email IN ($2::citext, $3::citext)
 ORDER BY id
 FOR UPDATE`, tenantID, oldEmail, newEmail); err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}

	// Fold each colliding old-address row into its canonical target. The target
	// id survives so an already-live canonical worker keeps a valid lease. All
	// other active source workers are invalidated by the later source delete.
	if _, err := tx.Exec(ctx, `
UPDATE intelligent_retry_events AS target
   SET status = CASE
         WHEN target.status = 'dismissed' OR source.status = 'dismissed'
           THEN 'dismissed'
         WHEN target.status = 'retried' OR source.status = 'retried'
           THEN 'retried'
         WHEN target.status = 'retrying'
          AND target.updated_at > statement_timestamp() - ($4::bigint * interval '1 second')
           THEN 'retrying'
         WHEN target.status = 'ready' OR source.status = 'ready'
           THEN 'ready'
         WHEN target.status IN ('pending', 'retrying')
           OR source.status IN ('pending', 'retrying')
           THEN 'pending'
         ELSE 'failed'
       END,
       retry_after = LEAST(target.retry_after, source.retry_after),
       attempts = LEAST(
           2147483647::bigint,
           target.attempts::bigint + source.attempts::bigint
       )::integer,
       breakdown = CASE
         WHEN source.updated_at > target.updated_at THEN source.breakdown
         ELSE target.breakdown
       END,
       created_at = LEAST(target.created_at, source.created_at),
       updated_at = CASE
         -- Preserve a canonical worker's exact CAS revision when it remains
         -- the winning live state. Changing this timestamp would orphan it.
         WHEN target.status = 'retrying'
          AND target.updated_at > statement_timestamp() - ($4::bigint * interval '1 second')
          AND source.status <> 'dismissed'
          AND source.status <> 'retried'
           THEN target.updated_at
         ELSE GREATEST(
             clock_timestamp(),
             target.updated_at + interval '1 microsecond',
             source.updated_at + interval '1 microsecond'
         )
       END
  FROM intelligent_retry_events AS source
 WHERE target.tenant_id=$1::uuid
   AND target.subscriber_email=$3::citext
   AND source.tenant_id=target.tenant_id
   AND source.subscriber_email=$2::citext
   AND source.campaign_id=target.campaign_id
   AND source.reason=target.reason`, tenantID, oldEmail, newEmail, leaseSeconds); err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}

	// Non-colliding tuples retain their id and retry chronology, but every move
	// advances the revision. A retrying row is reset to pending so a worker that
	// claimed the old address cannot pass its old (status, updated_at) lease CAS.
	if _, err := tx.Exec(ctx, `
UPDATE intelligent_retry_events AS source
   SET subscriber_email=$3,
       status=CASE WHEN source.status='retrying' THEN 'pending' ELSE source.status END,
       updated_at=GREATEST(clock_timestamp(), source.updated_at + interval '1 microsecond')
 WHERE source.tenant_id=$1::uuid
   AND source.subscriber_email=$2::citext
   AND NOT EXISTS (
       SELECT 1
         FROM intelligent_retry_events AS target
        WHERE target.tenant_id=source.tenant_id
          AND target.subscriber_email=$3::citext
          AND target.campaign_id=source.campaign_id
          AND target.reason=source.reason
   )`, tenantID, oldEmail, newEmail); err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}

	// Only collision sources remain under oldEmail; their state has already
	// been folded into the canonical row above.
	if _, err := tx.Exec(ctx, `
DELETE FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid AND subscriber_email=$2::citext`, tenantID, oldEmail); err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}
	return nil
}

// RepointSubscriberEmail exposes the canonical email-rotation helper to other
// tenant-scoped subscriber write surfaces. Callers must pass their open
// transaction so the subscriber row and every email-keyed satellite commit or
// roll back together.
func RepointSubscriberEmail(ctx context.Context, tx pgx.Tx, tenantID, oldEmail, newEmail string) error {
	return repointSubscriberEmail(ctx, tx, tenantID, oldEmail, newEmail)
}

// repointScopedEmail re-points one composite-keyed table from oldEmail to
// newEmail, honouring a UNIQUE on (tenant_id, subscriber_email,
// <discriminators...>). Rows whose target tuple already exists under
// newEmail are skipped by the NOT EXISTS guard and then deleted, so the
// canonical newEmail row survives and no UNIQUE is violated. A missing
// table is tolerated (42P01 -> no-op).
func repointScopedEmail(ctx context.Context, tx pgx.Tx, table string, discriminators []string, tenantID, oldEmail, newEmail string) error {
	// Build the per-discriminator equality predicate shared by the
	// collision check (NOT EXISTS) so the moved row can't clash on the
	// new address.
	var collide strings.Builder
	for _, d := range discriminators {
		collide.WriteString(" AND s2." + d + " = t." + d)
	}
	updateQ := `
UPDATE ` + table + ` t SET subscriber_email = $1
 WHERE t.tenant_id = $2::uuid AND t.subscriber_email = $3
   AND NOT EXISTS (
       SELECT 1 FROM ` + table + ` s2
        WHERE s2.tenant_id = $2::uuid AND s2.subscriber_email = $1` + collide.String() + `
   )`
	if _, err := tx.Exec(ctx, updateQ, newEmail, tenantID, oldEmail); err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM `+table+` WHERE tenant_id = $1::uuid AND subscriber_email = $2`,
		tenantID, oldEmail); err != nil {
		if isUndefinedTable(err) {
			return nil
		}
		return err
	}
	return nil
}

func isUndefinedTable(err error) bool {
	// pgx returns *pgconn.PgError, which exposes SQLState(). Duck-type
	// it so we don't need to import pgconn here.
	type pgxErrorWithCode interface {
		SQLState() string
	}
	var coder pgxErrorWithCode
	if errors.As(err, &coder) {
		return coder.SQLState() == "42P01"
	}
	return false
}

func unionStrings(a, b []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, v := range a {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	for _, v := range b {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

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
