package tags

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// BulkMaxSubscribers caps a single bulk apply/unapply call. Mirrors the
// listsearch hard limit pattern so a single HTTP request never holds an
// open tx over more than 1000 join-row inserts.
const BulkMaxSubscribers = 1000

// BulkResult is the response payload for the apply/unapply endpoints.
// applied is the number of rows actually mutated; skipped is the
// (requested - applied) count — for apply that means existing-or-
// invalid join rows, for unapply that means rows that weren't present.
type BulkResult struct {
	Applied int `json:"applied"`
	Skipped int `json:"skipped"`
}

// BulkInput is the JSON body for both /apply and /unapply.
type BulkInput struct {
	SubscriberIDs  []string `json:"subscriber_ids"`
	IdempotencyKey string   `json:"idempotency_key"`
	Source         string   `json:"source"`
}

// ErrBulkTooLarge is returned when the caller submits more than
// BulkMaxSubscribers ids in one request.
var ErrBulkTooLarge = errors.New("tags: bulk size exceeds limit")

// Apply performs a single-round-trip bulk insert into subscriber_tags
// using unnest($::uuid[]) ON CONFLICT DO NOTHING. The number of rows
// the INSERT actually wrote is returned in BulkResult.Applied — the
// remainder counts as Skipped (already-applied or invalid subscriber).
//
// One batched tag_history row with action='bulk_applied' and
// metadata.subscriber_count is emitted at the end so the audit log
// stays scannable. idempotencyKey is optional; when non-empty the
// (tenant, tag, key) tuple is checked against tag_bulk_idempotency
// and a cached result is returned on retry.
func (r *SubscriberTagsRepo) BulkApply(ctx context.Context, tenantID, tagID string, subscriberIDs []string, appliedBy, source, idempotencyKey string) (BulkResult, error) {
	return r.bulkOp(ctx, tenantID, tagID, subscriberIDs, appliedBy, source, idempotencyKey, true)
}

// BulkUnapply mirrors BulkApply for removal. The DELETE … WHERE
// subscriber_id = ANY($::uuid[]) clamps the work to one round-trip.
func (r *SubscriberTagsRepo) BulkUnapply(ctx context.Context, tenantID, tagID string, subscriberIDs []string, actorID, source, idempotencyKey string) (BulkResult, error) {
	return r.bulkOp(ctx, tenantID, tagID, subscriberIDs, actorID, source, idempotencyKey, false)
}

func (r *SubscriberTagsRepo) bulkOp(ctx context.Context, tenantID, tagID string, subscriberIDs []string, actorID, source, idempotencyKey string, apply bool) (BulkResult, error) {
	if strings.TrimSpace(source) == "" {
		if apply {
			source = "bulk_apply"
		} else {
			source = "bulk_unapply"
		}
	}
	ids := dedupeNonEmpty(subscriberIDs)
	if len(ids) > BulkMaxSubscribers {
		return BulkResult{}, ErrBulkTooLarge
	}
	op := "apply"
	if !apply {
		op = "unapply"
	}
	if len(ids) == 0 {
		return BulkResult{Applied: 0, Skipped: 0}, nil
	}
	reqHash := hashBulkRequest(tagID, op, ids)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return BulkResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The private 1774 event trigger can preserve a removal actor/source only
	// through transaction-local assertions. The event labels this evidence as
	// session_asserted rather than treating it as cryptographic identity.
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.actor_id', $1, true),
       set_config('app.tag_membership_source', $2, true)`, actorID, source); err != nil {
		return BulkResult{}, err
	}

	// Idempotency replay path: when the (tenant, tag, key) tuple is
	// already known we return the cached counters as long as the hashed
	// payload matches. A mismatch surfaces an explicit error so callers
	// can react like Stripe-style idempotency-key reuse.
	if idempotencyKey != "" {
		// Serialize first-use races before reading the ledger. Without this,
		// two concurrent requests could both miss, mutate, and return different
		// counters even though only one receipt row wins ON CONFLICT.
		if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(hashtextextended(
  'postwave:tag-bulk:' || $1 || ':' || $2 || ':' || $3, 1774
))`, tenantID, tagID, idempotencyKey); err != nil {
			return BulkResult{}, err
		}
		var hash string
		var cached BulkResult
		var op0 string
		err := tx.QueryRow(ctx, `
SELECT request_hash, applied, skipped, op
  FROM tag_bulk_idempotency
 WHERE tenant_id = $1::uuid AND tag_id = $2::uuid AND idempotency_key = $3`,
			tenantID, tagID, idempotencyKey).Scan(&hash, &cached.Applied, &cached.Skipped, &op0)
		switch {
		case err == nil:
			if hash != reqHash || op0 != op {
				return BulkResult{}, errors.New("idempotency_key_request_mismatch")
			}
			return cached, tx.Commit(ctx)
		case !isNoRows(err):
			// Pre-0276 deploy (no idempotency table). Treat as cache-miss
			// so the bulk op still completes.
			if !strings.Contains(err.Error(), "tag_bulk_idempotency") {
				return BulkResult{}, err
			}
		}
	}
	var tagExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM tags WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, tenantID, tagID).Scan(&tagExists); err != nil {
		return BulkResult{}, err
	}
	if !tagExists {
		return BulkResult{}, ErrNotFound
	}

	var applied int
	if apply {
		// One INSERT … SELECT FROM unnest() … ON CONFLICT DO NOTHING
		// RETURNING. The RETURNING row count is the actual number of new
		// join rows (existing pairs are silently skipped).
		rows, err := tx.Query(ctx, `
INSERT INTO subscriber_tags (tenant_id, subscriber_id, tag_id, applied_by, source)
SELECT $1::uuid, sid::uuid, $2::uuid, NULLIF($4, '')::uuid, $5
  FROM unnest($3::uuid[]) AS sid
 WHERE EXISTS (
   SELECT 1 FROM subscribers s
    WHERE s.tenant_id = $1::uuid AND s.id = sid::uuid
 )
ON CONFLICT (tenant_id, subscriber_id, tag_id) DO NOTHING
RETURNING subscriber_id`,
			tenantID, tagID, ids, actorID, source)
		if err != nil {
			return BulkResult{}, err
		}
		for rows.Next() {
			var sid string
			if err := rows.Scan(&sid); err != nil {
				rows.Close()
				return BulkResult{}, err
			}
			applied++
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return BulkResult{}, err
		}
	} else {
		cmd, err := tx.Exec(ctx, `
DELETE FROM subscriber_tags
 WHERE tenant_id = $1::uuid
   AND tag_id    = $2::uuid
   AND subscriber_id = ANY($3::uuid[])`,
			tenantID, tagID, ids)
		if err != nil {
			return BulkResult{}, err
		}
		applied = int(cmd.RowsAffected())
	}
	skipped := len(ids) - applied
	if skipped < 0 {
		skipped = 0
	}

	// One batched audit row. Avoids N-row history bloat on a 1k call.
	if r.History != nil && applied > 0 {
		action := "bulk_applied"
		if !apply {
			action = "bulk_unapplied"
		}
		meta := map[string]any{
			"subscriber_count": applied,
			"requested_count":  len(ids),
			"skipped":          skipped,
		}
		if idempotencyKey != "" {
			meta["idempotency_key"] = idempotencyKey
		}
		_ = r.History.EmitTx(ctx, tx, HistoryEvent{
			TenantID: tenantID,
			TagID:    tagID,
			Action:   action,
			Source:   source,
			ActorID:  actorID,
			Metadata: meta,
		})
	}

	// Cache the response so a retry returns the same counters.
	if idempotencyKey != "" {
		if _, err := tx.Exec(ctx, `
INSERT INTO tag_bulk_idempotency
       (tenant_id, tag_id, idempotency_key, request_hash, op, applied, skipped)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, tag_id, idempotency_key) DO NOTHING`,
			tenantID, tagID, idempotencyKey, reqHash, op, applied, skipped); err != nil {
			if !strings.Contains(err.Error(), "tag_bulk_idempotency") {
				return BulkResult{}, err
			}
		}
	}

	return BulkResult{Applied: applied, Skipped: skipped}, tx.Commit(ctx)
}

// dedupeNonEmpty removes blank entries + duplicates while preserving
// first-seen order. The PRIMARY KEY on subscriber_tags would dedupe
// anyway, but trimming here keeps the audit metadata.requested_count
// honest (and lets us short-circuit the BulkMaxSubscribers check).
func dedupeNonEmpty(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

// hashBulkRequest derives a SHA-256 over (op, tag_id, sorted ids) so
// a replay with the same key but different ids is detectable. Sorting
// makes the hash order-insensitive — clients reordering the array
// shouldn't trigger an idempotency mismatch.
func hashBulkRequest(tagID, op string, ids []string) string {
	cp := make([]string, len(ids))
	copy(cp, ids)
	sort.Strings(cp)
	h := sha256.New()
	h.Write([]byte(op))
	h.Write([]byte{'\n'})
	h.Write([]byte(tagID))
	h.Write([]byte{'\n'})
	for _, id := range cp {
		h.Write([]byte(id))
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ---- HTTP handlers --------------------------------------------------

// BulkApply POST /api/v1/tags/{id}/apply — bulk-apply a tag to N
// subscribers in a single round trip. Honours the Idempotency-Key
// request header (or body field, for clients that can't set headers).
func (d *Deps) BulkApply(w http.ResponseWriter, r *http.Request) {
	d.bulkHandler(w, r, true)
}

// BulkUnapply POST /api/v1/tags/{id}/unapply — bulk-remove the tag
// from N subscribers in a single round trip.
func (d *Deps) BulkUnapply(w http.ResponseWriter, r *http.Request) {
	d.bulkHandler(w, r, false)
}

func (d *Deps) bulkHandler(w http.ResponseWriter, r *http.Request, apply bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if d.SubscriberTagsRepo == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("bulk_unavailable",
			"subscriber_tags repo not wired"))
		return
	}
	tagID := strings.TrimSpace(chi.URLParam(r, "id"))
	parsedTagID, err := uuid.Parse(tagID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_tag_id", "tag id must be a UUID"))
		return
	}
	tagID = parsedTagID.String()
	var in BulkInput
	if err := httpbody.DecodeJSON(w, r, bulkJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	// Header wins over body for the idempotency key — matches the
	// canonical idempotency middleware contract used elsewhere.
	if v := strings.TrimSpace(r.Header.Get("Idempotency-Key")); v != "" {
		in.IdempotencyKey = v
	}
	in.IdempotencyKey = strings.TrimSpace(in.IdempotencyKey)
	if len(in.IdempotencyKey) > 255 {
		writeJSON(w, http.StatusBadRequest, errEnv("idempotency_key_too_long",
			"Idempotency-Key exceeds 255 chars"))
		return
	}
	in.Source = strings.TrimSpace(in.Source)
	if len(in.Source) > 32 {
		writeJSON(w, http.StatusBadRequest, errEnv("invalid_source",
			"source exceeds 32 bytes"))
		return
	}
	if len(in.SubscriberIDs) > BulkMaxSubscribers {
		writeJSON(w, http.StatusRequestEntityTooLarge, errEnv("bulk_too_large",
			"subscriber_ids exceeds 1000"))
		return
	}
	for index, rawID := range in.SubscriberIDs {
		parsedID, parseErr := uuid.Parse(strings.TrimSpace(rawID))
		if parseErr != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_subscriber_id",
				"subscriber_ids must contain only UUIDs"))
			return
		}
		in.SubscriberIDs[index] = parsedID.String()
	}
	var res BulkResult
	if apply {
		res, err = d.SubscriberTagsRepo.BulkApply(r.Context(), t.ID, tagID,
			in.SubscriberIDs, actorID(r), in.Source, in.IdempotencyKey)
	} else {
		res, err = d.SubscriberTagsRepo.BulkUnapply(r.Context(), t.ID, tagID,
			in.SubscriberIDs, actorID(r), in.Source, in.IdempotencyKey)
	}
	if err != nil {
		if errors.Is(err, ErrBulkTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "bulk_too_large", err.Error())
			return
		}
		if err.Error() == "idempotency_key_request_mismatch" {
			httperror.Write(w, http.StatusUnprocessableEntity,
				"idempotency_key_request_mismatch",
				"Idempotency-Key reused with a different request body.")
			return
		}
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "tag not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// p4d-audit-emit-wire-tags — one batched audit_log row per bulk
	// call (NOT N rows). Per-subscriber tag_history rows still emit
	// inside the repo tx; this is the cross-cutting audit row so
	// compliance scans see "user X bulk-applied tag Y to N subs".
	action := "tag.bulk_apply"
	if !apply {
		action = "tag.bulk_unapply"
	}
	audit.EmitOrLog(r.Context(), d.repoPool(), action, "tag", tagID, nil, nil, map[string]any{
		"requested_count": len(in.SubscriberIDs),
		"applied":         res.Applied,
		"skipped":         res.Skipped,
		"source":          in.Source,
	})
	writeJSON(w, http.StatusOK, res)
}

// bulkJSONMaxBodyBytes — 1k subscriber ids @ ~37 bytes each + envelope
// fits comfortably in 64 KiB.
const bulkJSONMaxBodyBytes int64 = 64 << 10
