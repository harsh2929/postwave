// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_operations.go — bulk subscriber actions (delete / tag /
// untag / unsubscribe / move-to-list) operating against EITHER an
// explicit id list OR a segment-defined audience.
//
// Endpoints (admin-scoped, mounted alongside existing subscriber
// routes):
//
//   POST /api/v1/subscribers/bulk/delete       hard delete + GDPR
//                                                 right-to-erasure
//                                                 audit row.
//   POST /api/v1/subscribers/bulk/tag          add a tag to many
//                                                 subscribers.
//   POST /api/v1/subscribers/bulk/untag        remove a tag.
//   POST /api/v1/subscribers/bulk/unsubscribe  set status='blocklisted'.
//   POST /api/v1/subscribers/bulk/move-to-list add to a list (see
//                                                 bulk_add_to_list.go).
//
// All bodies share the BulkTarget shape:
//
//   { "subscriber_ids": [...] }
//   { "segment_id": "..." }
//
// Bulk operations are bounded:
//   * Explicit lists capped at 10,000 ids per call.
//   * Segment-based ops walk the segment's resolved set; the
//     resolver caps the audience at 100k (segments.MaxAudience).
//
// All operations are tx-atomic per tenant — partial application is
// not surfaced; either every row is updated or none.

package subscribers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
)

// MaxBulkIDs caps the explicit-ID list for one bulk call. Lower
// than the export cap because we're issuing DELETEs/UPDATEs (write
// volume) not SELECTs (read volume).
const MaxBulkIDs = 10_000

// BulkTarget is the AUDIENCE selector shared across operations.
// Exactly one of SubscriberIDs / SegmentID must be supplied.
type BulkTarget struct {
	SubscriberIDs []string `json:"subscriber_ids,omitempty"`
	SegmentID     string   `json:"segment_id,omitempty"`
}

// BulkResult is the wire shape returned by every endpoint.
//
// RecoveryToken / RecoveryUntil (SUB-099) are populated only by reversible
// operations such as tag / untag. Privacy erasure and consent withdrawal are
// deliberately irreversible: those handlers never persist a replay snapshot
// and never return a recovery token.
//
// RecoveryExpired is set true by /subscribers/bulk/recover when the supplied
// token resolved to a row whose recovery_until has already passed (or was
// already redeemed) — it lets the client distinguish "no such token" from
// "the undo window closed".
type BulkResult struct {
	Affected        int            `json:"affected"`
	Skipped         int            `json:"skipped,omitempty"`
	Source          string         `json:"source"` // "explicit_ids" | "segment"
	RecoveryToken   string         `json:"recovery_token,omitempty"`
	RecoveryUntil   string         `json:"recovery_until,omitempty"`
	RecoveryExpired bool           `json:"recovery_expired,omitempty"`
	Exclusions      map[string]int `json:"exclusions,omitempty"`
}

// MountBulkRoutes registers the five bulk endpoints. Signature
// matches the other Mount* functions in this package — (r, d) so
// main.go's call style stays consistent.
//
// Each route is wrapped with observability.RecordSurfaceFunc so
// pw_subscribers_bulk_<action>_total + pw_subscribers_duration_seconds
// are emitted for every call (Phase 4 p4d-recordsurface-wire-subscribers).
func MountBulkRoutes(r chi.Router, d *Deps) {
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Post("/api/v1/subscribers/bulk/delete",
		observability.RecordSurfaceFunc("subscribers", "bulk_delete", d.BulkDelete))
	r.With(admin).Post("/api/v1/subscribers/bulk/tag",
		observability.RecordSurfaceFunc("subscribers", "bulk_tag", d.BulkTag))
	r.With(admin).Post("/api/v1/subscribers/bulk/untag",
		observability.RecordSurfaceFunc("subscribers", "bulk_untag", d.BulkUntag))
	r.With(admin).Post("/api/v1/subscribers/bulk/unsubscribe",
		observability.RecordSurfaceFunc("subscribers", "bulk_unsubscribe", d.BulkUnsubscribe))
	r.With(admin).Post("/api/v1/subscribers/bulk/move-to-list",
		observability.RecordSurfaceFunc("subscribers", "bulk_move_to_list", d.BulkMoveToList))

	// SUB-099 — undo redemption for the reversible bulk verbs above.
	r.With(admin).Post("/api/v1/subscribers/bulk/recover",
		observability.RecordSurfaceFunc("subscribers", "bulk_recover", d.BulkRecover))

	// SUB-100-bulk-verbs — extended bulk verbs. resubscribe is the inverse
	// of unsubscribe; add-to-list shares semantics with move-to-list;
	// set-custom-field / update-merge-field patch the jsonb columns;
	// grant/revoke-consent append to the consent_events ledger; and
	// export-by-segment streams a CSV of the resolved audience.
	r.With(admin).Post("/api/v1/subscribers/bulk/resubscribe",
		observability.RecordSurfaceFunc("subscribers", "bulk_resubscribe", d.BulkResubscribe))
	r.With(admin).Post("/api/v1/subscribers/bulk/add-to-list",
		observability.RecordSurfaceFunc("subscribers", "bulk_add_to_list", d.BulkMoveToList))
	r.With(admin).Post("/api/v1/subscribers/bulk/set-custom-field",
		observability.RecordSurfaceFunc("subscribers", "bulk_set_custom_field", d.BulkSetCustomField))
	r.With(admin).Post("/api/v1/subscribers/bulk/update-merge-field",
		observability.RecordSurfaceFunc("subscribers", "bulk_update_merge_field", d.BulkUpdateMergeField))
	r.With(admin).Post("/api/v1/subscribers/bulk/grant-consent",
		observability.RecordSurfaceFunc("subscribers", "bulk_grant_consent", d.BulkGrantConsent))
	r.With(admin).Post("/api/v1/subscribers/bulk/revoke-consent",
		observability.RecordSurfaceFunc("subscribers", "bulk_revoke_consent", d.BulkRevokeConsent))
	r.With(admin).Post("/api/v1/subscribers/bulk/export-by-segment",
		observability.RecordSurfaceFunc("subscribers", "bulk_export_by_segment", d.BulkExportBySegment))
}

// newRecoveryToken mints a single-use, URL-safe recovery token for a
// reversible bulk operation (SUB-099). 32 random bytes hex-encoded gives a
// 64-char token with 256 bits of entropy — collisions across a tenant are
// effectively impossible, and the tenant-scoped UNIQUE index on
// subscriber_bulk_recovery is the backstop.
func newRecoveryToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// recoveryWindowReversible is the short undo window for non-privacy actions
// such as tag and untag. Erasure and withdrawal never use this mechanism.
const recoveryWindowReversible = 10 * time.Minute

// recoveryTagRow binds an undo receipt to the exact subscriber revision
// produced by the original tag mutation. If any later writer advances the
// profile, recovery skips that row instead of silently overwriting newer work.
type recoveryTagRow struct {
	ID        string    `json:"id"`
	UpdatedAt time.Time `json:"updated_at"`
}

// recordRecovery inserts a single reverse-operation row inside the supplied
// tenant tx and returns the minted token + expiry. snapshot carries the
// operation-specific replay payload (see migration 1300). It is a no-op
// (returns empty token, nil error) when affected == 0, so a bulk op that
// touched nothing does not litter the recovery table.
func recordRecovery(ctx context.Context, tx pgx.Tx, tenantID, operation string, affected int, window time.Duration, snapshot map[string]any) (string, time.Time, error) {
	if affected <= 0 {
		return "", time.Time{}, nil
	}
	token, err := newRecoveryToken()
	if err != nil {
		return "", time.Time{}, err
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return "", time.Time{}, err
	}
	until := time.Now().UTC().Add(window)
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_bulk_recovery
       (tenant_id, recovery_token, operation, subscriber_snapshot,
        affected_count, recovery_until)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6)`,
		tenantID, token, operation, raw, affected, until); err != nil {
		return "", time.Time{}, err
	}
	return token, until, nil
}

// resolveAudience returns the subscriber ids the operation applies
// to, plus the human-readable source label for the response.
func (d *Deps) resolveAudience(ctx context.Context, tenantID string, target BulkTarget) ([]string, string, error) {
	if len(target.SubscriberIDs) > 0 && target.SegmentID != "" {
		return nil, "", errors.New("supply either subscriber_ids OR segment_id, not both")
	}
	if len(target.SubscriberIDs) > 0 {
		if len(target.SubscriberIDs) > MaxBulkIDs {
			return nil, "", errors.New("subscriber_ids exceeds 10,000-id cap")
		}
		ids := make([]string, 0, len(target.SubscriberIDs))
		seen := make(map[string]struct{}, len(target.SubscriberIDs))
		for _, raw := range target.SubscriberIDs {
			parsed, err := uuid.Parse(strings.TrimSpace(raw))
			if err != nil {
				return nil, "", errors.New("subscriber_ids must contain valid UUIDs")
			}
			id := parsed.String()
			if _, duplicate := seen[id]; duplicate {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
		return ids, "explicit_ids", nil
	}
	if target.SegmentID != "" {
		ids, err := d.resolveSegmentMembers(ctx, tenantID, target.SegmentID)
		if err != nil {
			return nil, "", err
		}
		return ids, "segment", nil
	}
	return nil, "", errors.New("either subscriber_ids or segment_id required")
}

// resolveSegmentMembers returns the subscriber ids for the segment.
// We do this in the bulk-operation package (rather than calling the
// segments package directly) to keep the dependency graph clean —
// segments→subscribers would otherwise be a cycle. The query is a
// straight scan against segment_subscribers (the materialised
// membership table the segments evaluator writes).
func (d *Deps) resolveSegmentMembers(ctx context.Context, tenantID, segmentID string) ([]string, error) {
	tx, err := db.WithTenant(ctx, d.Repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text FROM segment_subscribers
 WHERE tenant_id = $1::uuid AND segment_id::text = $2
 LIMIT 100000`, tenantID, segmentID)
	if err != nil {
		// Schema variance fallback: if segment_subscribers doesn't
		// exist, we can't resolve. Return an empty list rather than
		// 500 — the caller will see Affected=0 and re-check segment.
		return []string{}, nil
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return ids, rows.Err()
}

// --- Delete ---

// bulkDeleteAddress is the minimum transient projection needed to create a
// permanent erasure tombstone. It is never serialized: cleartext addresses
// must live only long enough to write the suppression rows that prevent a
// later re-import. Durable outbox and audit payloads carry counts/opaque UUIDs,
// never addresses.
type bulkDeleteAddress struct {
	Email        string
	SubscriberID string
	ListmonkID   int64
	IsCanonical  bool
}

// captureBulkDeleteState locks the selected canonical subscriber rows before
// reading subscriber_emails. The parent-row UPDATE lock conflicts with the FK
// key-share lock required by a concurrent address insert, so no new attached
// address can appear between this snapshot and the parent DELETE.
func captureBulkDeleteState(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	ids []string,
) ([]Subscriber, []bulkDeleteAddress, error) {
	rows, err := tx.Query(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])
 ORDER BY id
 FOR UPDATE`, tenantID, ids)
	if err != nil {
		return nil, nil, fmt.Errorf("bulk delete: lock subscribers: %w", err)
	}
	subscribers, err := scanSubscribers(rows)
	if err != nil {
		return nil, nil, fmt.Errorf("bulk delete: capture subscribers: %w", err)
	}
	if len(subscribers) == 0 {
		return subscribers, []bulkDeleteAddress{}, nil
	}

	byID := make(map[string]Subscriber, len(subscribers))
	capturedIDs := make([]string, 0, len(subscribers))
	addressesByEmail := make(map[string]bulkDeleteAddress, len(subscribers)*2)
	addAddress := func(sub Subscriber, email string) error {
		email = strings.TrimSpace(email)
		if email == "" {
			return errors.New("bulk delete: captured an empty subscriber address")
		}
		key := strings.ToLower(email)
		candidate := bulkDeleteAddress{
			Email:        email,
			SubscriberID: sub.ID,
			ListmonkID:   listmonkIDFromCustomFields(sub.CustomFields),
			IsCanonical:  strings.EqualFold(email, strings.TrimSpace(sub.Email)),
		}
		if existing, ok := addressesByEmail[key]; ok {
			if existing.SubscriberID != sub.ID {
				return errors.New("bulk delete: one address resolved to multiple subscribers")
			}
			candidate.IsCanonical = candidate.IsCanonical || existing.IsCanonical
		}
		addressesByEmail[key] = candidate
		return nil
	}
	for _, sub := range subscribers {
		byID[sub.ID] = sub
		capturedIDs = append(capturedIDs, sub.ID)
		if err := addAddress(sub, sub.Email); err != nil {
			return nil, nil, err
		}
		// primary_email should normally mirror an attached address. Include it
		// defensively so a historical row with a broken junction cannot evade
		// the permanent erasure gate.
		if strings.TrimSpace(sub.PrimaryEmail) != "" {
			if err := addAddress(sub, sub.PrimaryEmail); err != nil {
				return nil, nil, err
			}
		}
	}

	addressRows, err := tx.Query(ctx, `
SELECT subscriber_id::text, email::text
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND subscriber_id = ANY($2::uuid[])
 ORDER BY subscriber_id, id
 FOR UPDATE`, tenantID, capturedIDs)
	if err != nil {
		return nil, nil, fmt.Errorf("bulk delete: lock attached addresses: %w", err)
	}
	for addressRows.Next() {
		var subscriberID, email string
		if err := addressRows.Scan(&subscriberID, &email); err != nil {
			addressRows.Close()
			return nil, nil, fmt.Errorf("bulk delete: scan attached address: %w", err)
		}
		sub, ok := byID[subscriberID]
		if !ok {
			addressRows.Close()
			return nil, nil, errors.New("bulk delete: attached address escaped the locked audience")
		}
		if err := addAddress(sub, email); err != nil {
			addressRows.Close()
			return nil, nil, err
		}
	}
	addressRows.Close()
	if err := addressRows.Err(); err != nil {
		return nil, nil, fmt.Errorf("bulk delete: read attached addresses: %w", err)
	}

	// Stable ordering makes suppression writes and tests deterministic and
	// avoids leaking caller ordering into durable artifacts.
	addresses := make([]bulkDeleteAddress, 0, len(addressesByEmail))
	for _, address := range addressesByEmail {
		addresses = append(addresses, address)
	}
	slices.SortFunc(addresses, func(a, b bulkDeleteAddress) int {
		return strings.Compare(strings.ToLower(a.Email), strings.ToLower(b.Email))
	})
	return subscribers, addresses, nil
}

func writeBulkDeleteSuppressions(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	addresses []bulkDeleteAddress,
) error {
	if len(addresses) == 0 {
		return nil
	}
	emails := make([]string, 0, len(addresses))
	subscriberIDs := make([]string, 0, len(addresses))
	listmonkIDs := make([]int64, 0, len(addresses))
	canonical := make([]bool, 0, len(addresses))
	for _, address := range addresses {
		emails = append(emails, address.Email)
		subscriberIDs = append(subscriberIDs, address.SubscriberID)
		listmonkIDs = append(listmonkIDs, address.ListmonkID)
		canonical = append(canonical, address.IsCanonical)
	}
	if _, err := tx.Exec(ctx, `
WITH erased_addresses AS (
    SELECT *
      FROM unnest($2::text[], $3::uuid[], $4::bigint[], $5::boolean[])
           AS address(email, subscriber_id, listmonk_id, is_canonical)
)
INSERT INTO email_suppressions
       (tenant_id, email, reason, source, metadata, expires_at)
SELECT $1::uuid,
       address.email,
       'manual',
       'gdpr_bulk_delete',
       jsonb_strip_nulls(jsonb_build_object(
           'gdpr_erasure', true,
           'deleted_at', now(),
           'deleted_subscriber_id', address.subscriber_id::text,
           'listmonk_id', NULLIF(address.listmonk_id, 0),
           'is_canonical', address.is_canonical
       )),
       NULL
  FROM erased_addresses AS address
ON CONFLICT (tenant_id, email, reason) DO UPDATE SET
       source = EXCLUDED.source,
       metadata = email_suppressions.metadata || EXCLUDED.metadata,
       suppressed_at = now(),
       expires_at = NULL`, tenantID, emails, subscriberIDs, listmonkIDs, canonical); err != nil {
		return fmt.Errorf("bulk delete: write legacy suppressions: %w", err)
	}
	if _, err := tx.Exec(ctx, `
WITH erased_addresses AS (
    SELECT *
      FROM unnest($2::text[], $3::uuid[], $4::bigint[], $5::boolean[])
           AS address(email, subscriber_id, listmonk_id, is_canonical)
)
INSERT INTO subscriber_suppressions
       (tenant_id, email, reason, source, metadata, expires_at)
SELECT $1::uuid,
       address.email,
       'dsar_deletion',
       'api',
       jsonb_strip_nulls(jsonb_build_object(
           'gdpr_erasure', true,
           'deleted_at', now(),
           'deleted_subscriber_id', address.subscriber_id::text,
           'listmonk_id', NULLIF(address.listmonk_id, 0),
           'is_canonical', address.is_canonical
       )),
       NULL
  FROM erased_addresses AS address
ON CONFLICT (tenant_id, email) DO UPDATE SET
       reason = 'dsar_deletion',
       source = 'api',
       metadata = subscriber_suppressions.metadata || EXCLUDED.metadata,
       expires_at = NULL`, tenantID, emails, subscriberIDs, listmonkIDs, canonical); err != nil {
		return fmt.Errorf("bulk delete: write canonical suppressions: %w", err)
	}
	return nil
}

func (d *Deps) BulkDelete(w http.ResponseWriter, r *http.Request) {
	t, target, ok := d.bulkPreflight(w, r)
	if !ok {
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, target)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// captureBulkDeleteState takes subscriber/address row locks before the
	// DELETE cascades into push_devices. Establish the tenant writer order first
	// so a concurrent device upsert cannot hold this lease while waiting on an
	// FK key-share lock for one of those rows.
	if err := pushauthoritylock.Exclusive(r.Context(), tx, t.ID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	subscribers, addresses, err := captureBulkDeleteState(r.Context(), tx, t.ID, ids)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	deletedIDs := make([]string, 0, len(subscribers))
	for _, sub := range subscribers {
		deletedIDs = append(deletedIDs, sub.ID)
	}
	if len(deletedIDs) > 0 {
		command, err := tx.Exec(r.Context(), `
DELETE FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])`, t.ID, deletedIDs)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		if command.RowsAffected() != int64(len(subscribers)) {
			httperror.WriteInternal(w, d.Logger,
				errors.New("bulk delete: locked audience changed before deletion"),
				httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if err := writeBulkDeleteSuppressions(r.Context(), tx, t.ID, addresses); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	for i := range subscribers {
		if err := writeErasureReceipt(r.Context(), tx, t.ID, &subscribers[i]); err != nil {
			httperror.WriteInternal(w, d.Logger,
				fmt.Errorf("bulk delete: write erasure receipt: %w", err),
				httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}

	skipped := len(ids) - len(subscribers)
	activityParams := map[string]any{
		"address_count":    len(addresses),
		"irreversible":     true,
		"recovery_created": false,
	}
	if err := recordBulkVerbAudit(r.Context(), tx, t.ID, "delete", source,
		len(subscribers), skipped, activityParams, "admin:"+middleware.AuditMetaFromRequest(r).ActorType); err != nil {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("bulk delete: append activity audit: %w", err),
			httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	meta := middleware.AuditMetaFromRequest(r)
	meta.TenantID = t.ID
	// UserID provides request attribution without retaining a potentially
	// PII-bearing display label in this privacy-erasure artifact.
	meta.ActorLabel = ""
	if err := db.Audit(r.Context(), tx, meta, "subscriber.bulk_deleted", "subscribers", "", map[string]any{
		"count":             len(subscribers),
		"address_count":     len(addresses),
		"source":            source,
		"suppression_added": true,
		"irreversible":      true,
		"recovery_created":  false,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger,
			fmt.Errorf("bulk delete: append audit: %w", err),
			httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	for _, sub := range subscribers {
		if err := d.Repo.appendEngineDelete(r.Context(), tx, t.ID, sub.ID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	res := BulkResult{
		Affected: len(subscribers),
		Skipped:  skipped,
		Source:   source,
	}
	if skipped > 0 {
		res.Exclusions = map[string]int{"missing_or_outside_tenant": skipped}
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Tag / Untag ---

type bulkTagInput struct {
	BulkTarget
	Tag string `json:"tag"`
}

func (d *Deps) BulkTag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in bulkTagInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Tag = strings.TrimSpace(in.Tag)
	if in.Tag == "" {
		httperror.WriteValidation(w, "missing_tag", "tag is required")
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, in.BulkTarget)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// Upsert the tag into subscriber.tags array column. Subscribers
	// schema stores tags as a text[] for fast set-ops; we use
	// ARRAY ... UNION to dedupe. RETURN the ids that did NOT already carry
	// the tag so the SUB-099 undo snapshot only reverses the rows this op
	// actually changed (re-untagging a row that had the tag before would be
	// wrong).
	tagRows, err := tx.Query(r.Context(), `
UPDATE subscribers
   SET tags = (
         SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, ARRAY[]::text[]) || ARRAY[$3]::text[]))
       ),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
   AND NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY[$3]::text[])
RETURNING id::text, updated_at`,
		t.ID, ids, in.Tag)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	changed := make([]string, 0, len(ids))
	recoveryRows := make([]recoveryTagRow, 0, len(ids))
	for tagRows.Next() {
		var row recoveryTagRow
		if err := tagRows.Scan(&row.ID, &row.UpdatedAt); err != nil {
			tagRows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		changed = append(changed, row.ID)
		recoveryRows = append(recoveryRows, row)
	}
	tagRows.Close()
	if err := tagRows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// SUB-099 — undo = remove the tag from exactly the rows we just added it
	// to. The receipt is revision-bound so a later mutation makes that row
	// ineligible for automatic recovery instead of being overwritten.
	token, until, err := recordRecovery(r.Context(), tx, t.ID, "tag", len(changed), recoveryWindowReversible, map[string]any{
		"rows": recoveryRows,
		"tag":  in.Tag,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := d.Repo.appendEngineSyncMany(r.Context(), tx, t.ID, changed); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	if err := db.Audit(r.Context(), tx, auditMeta, "subscriber.bulk_tagged", "subscribers", "", map[string]any{
		"affected": len(changed),
		"source":   source,
		"tag":      in.Tag,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := emitBulkTagHistory(r.Context(), tx, t.ID, in.Tag, "bulk_applied",
		len(changed), len(ids), source, auditMeta.UserID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	res := BulkResult{
		Affected: len(changed),
		Source:   source,
	}
	if token != "" {
		res.RecoveryToken = token
		res.RecoveryUntil = until.Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, res)
}

func (d *Deps) BulkUntag(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in bulkTagInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Tag = strings.TrimSpace(in.Tag)
	if in.Tag == "" {
		httperror.WriteValidation(w, "missing_tag", "tag is required")
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, in.BulkTarget)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	// RETURN only the rows that actually had the tag (so the count + the
	// SUB-099 re-tag snapshot reflect real changes, not no-ops on rows that
	// never carried the tag).
	tagRows, err := tx.Query(r.Context(), `
UPDATE subscribers
   SET tags = array_remove(COALESCE(tags, ARRAY[]::text[]), $3),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
   AND COALESCE(tags, ARRAY[]::text[]) @> ARRAY[$3]::text[]
RETURNING id::text, updated_at`,
		t.ID, ids, in.Tag)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	changed := make([]string, 0, len(ids))
	recoveryRows := make([]recoveryTagRow, 0, len(ids))
	for tagRows.Next() {
		var row recoveryTagRow
		if err := tagRows.Scan(&row.ID, &row.UpdatedAt); err != nil {
			tagRows.Close()
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
		changed = append(changed, row.ID)
		recoveryRows = append(recoveryRows, row)
	}
	tagRows.Close()
	if err := tagRows.Err(); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// SUB-099 — undo = re-add the tag to exactly the rows we removed it from.
	token, until, err := recordRecovery(r.Context(), tx, t.ID, "untag", len(changed), recoveryWindowReversible, map[string]any{
		"rows": recoveryRows,
		"tag":  in.Tag,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := d.Repo.appendEngineSyncMany(r.Context(), tx, t.ID, changed); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	if err := db.Audit(r.Context(), tx, auditMeta, "subscriber.bulk_untagged", "subscribers", "", map[string]any{
		"affected": len(changed),
		"source":   source,
		"tag":      in.Tag,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := emitBulkTagHistory(r.Context(), tx, t.ID, in.Tag, "bulk_unapplied",
		len(changed), len(ids), source, auditMeta.UserID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	res := BulkResult{
		Affected: len(changed),
		Source:   source,
	}
	if token != "" {
		res.RecoveryToken = token
		res.RecoveryUntil = until.Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Unsubscribe ---

func (d *Deps) BulkUnsubscribe(w http.ResponseWriter, r *http.Request) {
	t, target, ok := d.bulkPreflight(w, r)
	if !ok {
		return
	}
	ids, source, err := d.resolveAudience(r.Context(), t.ID, target)
	if err != nil {
		httperror.WriteValidation(w, "invalid_target", err.Error())
		return
	}
	// Serializable isolation closes the classification/write race with another
	// administrative bulk operation. A conflict aborts instead of letting an
	// older scope overwrite a newer consent decision.
	tx, err := db.WithTenantOptions(r.Context(), d.Repo.Pool, t.ID, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	if strings.TrimSpace(auditMeta.ActorLabel) == "" {
		auditMeta.ActorLabel = actorFromRequest(r)
	}
	changed, err := d.applyBulkUnsubscribe(r.Context(), tx, t.ID, ids, source, auditMeta)
	if err != nil {
		d.writeBulkUnsubscribeErr(w, r, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		d.writeBulkUnsubscribeErr(w, r, err)
		return
	}
	res := BulkResult{
		Affected: len(changed),
		Source:   source,
		Skipped:  len(ids) - len(changed),
	}
	if res.Skipped > 0 {
		res.Exclusions = map[string]int{"already_withdrawn_or_missing": res.Skipped}
	}
	writeJSON(w, http.StatusOK, res)
}

func (d *Deps) writeBulkUnsubscribeErr(
	w http.ResponseWriter,
	r *http.Request,
	err error,
) {
	err = mapEmailConsentSerializationError(err)
	switch {
	case errors.Is(err, ErrConcurrentConsentDecision):
		w.Header().Set("Retry-After", "1")
		httperror.Write(
			w,
			http.StatusConflict,
			"concurrent_consent_change",
			"another consent or suppression decision is in progress; review the audience and retry the complete bulk request",
		)
	case errors.Is(err, ErrEmailSuppressionEvidenceConflict):
		httperror.Write(
			w,
			http.StatusConflict,
			"suppression_evidence_conflict",
			"the suppression evidence changed while this audience was reviewed; refresh the audience before retrying",
		)
	default:
		tenantID := ""
		if tenant, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = tenant.ID
		}
		httperror.WriteInternal(
			w,
			d.Logger,
			err,
			httperror.WithTenantIDLog(r.Context(), tenantID),
		)
	}
}

// --- shared preflight: decode body + extract tenant ---

func (d *Deps) bulkPreflight(w http.ResponseWriter, r *http.Request) (*middleware.Tenant, BulkTarget, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return nil, BulkTarget{}, false
	}
	var target BulkTarget
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &target, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return nil, BulkTarget{}, false
	}
	return t, target, true
}

// (writeJSON + writeJSONErr live in handlers.go; reuse those.)
