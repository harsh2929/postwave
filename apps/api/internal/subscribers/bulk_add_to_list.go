// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_add_to_list.go — POST /api/v1/subscribers/bulk/add-to-list (and its
// historical alias /bulk/move-to-list): add an audience to one list,
// reversibly.
//
// THE LIST ID. Every first-party client fills its list picker from the
// catalogue (GET /api/v1/lists), whose rows are keyed on Listmonk's engine
// bigint, so "10" is what arrives. Moosewave membership is keyed on the list's
// Moosewave uuid. The handler used to bind the raw value into `$2::uuid`, so
// every click from the web, desktop and mobile apps was a 22P02 and a 500, while
// an arbitrary uuid was accepted and written as a membership of a list that did
// not exist. The id is now resolved through list_id_map inside the write
// transaction (lists.ResolveListIdentityTx): either form is accepted, an
// unknown list is a 404, and nothing is ever written against an id nobody
// minted.
//
// THE ROW. A membership written here is complete: the engine id and address
// are denormalised the way every other writer does it (the subscriber's Lists
// panel names a list through listmonk_list_id), the source is 'admin', and a
// 'source:admin' owner row joins the membership ledger so a CRM scan that drops
// the contact cannot silently undo an operator's explicit add.
//
// REMOVED MEMBERS. Membership removal is a soft delete everywhere in this
// codebase. The old `ON CONFLICT DO NOTHING` let that tombstone win, so a
// contact removed from a list could never be put back through this verb: the
// call returned 200, counted them as skipped, and they stayed removed. A
// tombstoned membership is now revived, as lists.AddMembers and
// AddEmailToListOwned already do, and the undo receipt records what it looked
// like before so recovery can put the tombstone back rather than delete it.

package subscribers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// bulkAddToListSource is the membership source and owner this verb writes.
// 'admin' distinguishes an operator's bulk action from a Members-tab or API add
// ('api') in the list growth and source-mix analytics.
const (
	bulkAddToListSource   = "admin"
	bulkAddToListOwnerKey = "source:admin"
)

// Exclusion keys reported when an id in the audience was not added. Stable
// wire values: clients key their copy on them.
const (
	bulkListExclusionAlreadyMember = "already_on_list"
	bulkListExclusionMissing       = "missing_or_outside_tenant"
)

type bulkMoveInput struct {
	BulkTarget
	ListID string `json:"list_id"`
}

type bulkInsertedListSubscriber struct {
	ID      string
	Email   string
	ListID  string
	AddedAt time.Time
}

func bulkListSubscriberAddedPayload(
	source string,
	rec bulkInsertedListSubscriber,
) map[string]any {
	return map[string]any{
		"subscriber_id": rec.ID,
		"email":         rec.Email,
		"list_id":       rec.ListID,
		"source":        source,
	}
}

// bulkListSubscriberAddedIdempotencyKey is derived only from the membership
// identity and the exact added_at value persisted with that membership. A
// retry that observes the same row therefore deduplicates, while a future
// remove/re-add revision can produce a distinct delivery intent.
func bulkListSubscriberAddedIdempotencyKey(
	tenantID string,
	rec bulkInsertedListSubscriber,
) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		tenantID,
		rec.ListID,
		rec.ID,
		rec.AddedAt.UTC().Format(time.RFC3339Nano),
	}, "\x00")))
	return "list-membership-added:" + hex.EncodeToString(sum[:])
}

func (d *Deps) fireBulkListSubscriberAdded(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, source string,
	rec bulkInsertedListSubscriber,
) error {
	if d == nil || d.Repo == nil || d.Repo.Webhooks == nil {
		return nil
	}
	_, err := d.Repo.Webhooks.Fire(ctx, tx, WebhookFireInput{
		TenantID:       tenantID,
		EventType:      outbound_webhooks.EventListSubscriberAdded,
		Body:           bulkListSubscriberAddedPayload(source, rec),
		IdempotencyKey: bulkListSubscriberAddedIdempotencyKey(tenantID, rec),
	})
	return err
}

// bulkListAddition is what one add-to-list write did, row by row.
type bulkListAddition struct {
	// Added holds every membership this operation made active: fresh inserts
	// and revived tombstones alike. Both are "added" from the list's point of
	// view and both fire list.subscriber.added.
	Added []bulkInsertedListSubscriber
	// Receipt is the undo snapshot, one row per entry in Added.
	Receipt []recoveryListRow
	// AlreadyMember counts audience members who were already active members.
	AlreadyMember int
	// Missing counts audience ids with no subscriber in this tenant.
	Missing int
}

// priorListMembership is a membership row as it stood before this operation,
// read under FOR UPDATE so a concurrent writer cannot change it underneath us.
type priorListMembership struct {
	AddedAt   time.Time
	RemovedAt *time.Time
	Source    string
}

func (d *Deps) BulkMoveToList(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in bulkMoveInput
	if err := httpbody.DecodeJSONWith(w, r, subscriberJSONMaxBodyBytes, &in, httpbody.Options{DisallowUnknownFields: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.ListID == "" {
		httperror.WriteValidation(w, "missing_list_id", "list_id required")
		return
	}
	// Shape first, before the audience is resolved or a transaction opened: a
	// malformed id is the caller's mistake and must never reach a ::uuid cast.
	if _, _, err := lists.ParseListID(in.ListID); err != nil {
		httperror.WriteValidation(w, "invalid_list_id",
			"list_id must be the list's numeric id or its UUID")
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

	list, err := lists.ResolveListIdentityTx(r.Context(), tx, t.ID, in.ListID)
	if errors.Is(err, lists.ErrListIDNotMapped) {
		httperror.Write(w, http.StatusNotFound, "list_not_found",
			"That list doesn't exist in this workspace. It may have been deleted; refresh and choose the list again.")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	addition, err := addAudienceToList(r.Context(), tx, t.ID, list, ids)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	// UNDO. The receipt names the memberships THIS operation made active, never
	// the ids it was handed: some were already on the list, and removing those
	// would delete memberships this operation never made. Each row carries the
	// exact added_at it wrote (so a later leave-and-rejoin is skipped rather
	// than revoked) and, for a revived tombstone, the tombstone itself (so the
	// undo restores it instead of erasing the record of who left and when).
	// The list is recorded by its canonical uuid, which is what the replay and
	// the list_joined enrolment cancellation compare against.
	token, until, err := recordRecovery(r.Context(), tx, t.ID, "add_to_list", len(addition.Added), recoveryWindowReversible, map[string]any{
		"rows":    addition.Receipt,
		"list_id": list.UUID,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	skipped := len(ids) - len(addition.Added)
	exclusions := bulkListExclusions(addition)
	if err := recordBulkVerbAudit(r.Context(), tx, t.ID, "add_to_list", source, len(addition.Added), skipped, map[string]any{
		"list_id":        list.UUID,
		"engine_list_id": list.EngineID,
		"exclusions":     exclusions,
	}, actorFromRequest(r)); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	auditMeta := middleware.AuditMetaFromRequest(r)
	auditMeta.TenantID = t.ID
	if err := db.Audit(r.Context(), tx, auditMeta, "subscriber.bulk_added_to_list", "list", list.UUID, map[string]any{
		"affected":       len(addition.Added),
		"skipped":        skipped,
		"source":         source,
		"engine_list_id": list.EngineID,
		"exclusions":     exclusions,
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}

	// Persist customer delivery intent before the membership transaction
	// commits. A fanout failure rolls the membership write back; a process
	// crash after commit cannot lose the already-persisted delivery row.
	for _, rec := range addition.Added {
		if err := d.fireBulkListSubscriberAdded(r.Context(), tx, t.ID, source, rec); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
			return
		}
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// The Bus is presentation/realtime-only. Emit AFTER commit so an SSE
	// subscriber can issue a follow-up read against a consistent view; the
	// customer webhook does not depend on this best-effort process-local path.
	for _, rec := range addition.Added {
		d.emit(t.ID, outbound_webhooks.EventListSubscriberAdded,
			bulkListSubscriberAddedPayload(source, rec))
	}
	res := BulkResult{
		Affected: len(addition.Added),
		Source:   source,
		Skipped:  skipped,
	}
	if len(exclusions) > 0 {
		res.Exclusions = exclusions
	}
	if token != "" {
		res.RecoveryToken = token
		res.RecoveryUntil = until.Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, res)
}

func bulkListExclusions(addition bulkListAddition) map[string]int {
	out := map[string]int{}
	if addition.AlreadyMember > 0 {
		out[bulkListExclusionAlreadyMember] = addition.AlreadyMember
	}
	if addition.Missing > 0 {
		out[bulkListExclusionMissing] = addition.Missing
	}
	return out
}

// addAudienceToList makes every subscriber in ids an active member of list,
// inside the caller's tenant transaction, and reports exactly what it changed.
//
// Three statements, each set-based:
//
//  1. The audience is resolved against subscribers under RLS and locked FOR
//     KEY SHARE. An id that is unknown, or belongs to another tenant, simply is
//     not found and is reported as missing. Inserting it blindly raised an FK
//     error (a 500) for an unknown id and, because referential checks bypass
//     RLS, accepted another tenant's subscriber.
//  2. Existing memberships of those subscribers are read FOR UPDATE, so the
//     before-image recorded for a revived tombstone is the one this
//     transaction actually overwrites.
//  3. Non-members and removed members are upserted together with their owner
//     rows. The DO UPDATE only fires for a tombstone, so an active membership
//     can never be rewritten.
func addAudienceToList(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	list lists.ListIdentity,
	ids []string,
) (bulkListAddition, error) {
	var out bulkListAddition
	if len(ids) == 0 {
		return out, nil
	}
	found, err := lockBulkListAudience(ctx, tx, tenantID, ids)
	if err != nil {
		return out, err
	}
	out.Missing = len(ids) - len(found)
	prior, err := lockPriorListMemberships(ctx, tx, tenantID, list.UUID, found)
	if err != nil {
		return out, err
	}
	candidates := make([]string, 0, len(found))
	for _, id := range found {
		if existing, ok := prior[id]; ok && existing.RemovedAt == nil {
			out.AlreadyMember++
			continue
		}
		candidates = append(candidates, id)
	}
	if len(candidates) == 0 {
		return out, nil
	}

	rows, err := tx.Query(ctx, `
WITH candidate AS (
    SELECT s.id, s.email
      FROM subscribers s
     WHERE s.tenant_id = $1::uuid
       AND s.id = ANY($3::uuid[])
),
membership AS (
    INSERT INTO list_subscribers
        (tenant_id, list_id, subscriber_id, listmonk_list_id, email, source, added_at, removed_at)
    SELECT $1::uuid, $2::uuid, c.id, $4, c.email, $5, now(), NULL
      FROM candidate c
    ON CONFLICT (tenant_id, list_id, subscriber_id) DO UPDATE
       SET removed_at       = NULL,
           added_at         = EXCLUDED.added_at,
           source           = EXCLUDED.source,
           email            = COALESCE(EXCLUDED.email, list_subscribers.email),
           listmonk_list_id = COALESCE(EXCLUDED.listmonk_list_id, list_subscribers.listmonk_list_id)
     WHERE list_subscribers.removed_at IS NOT NULL
    RETURNING subscriber_id, email, added_at
),
owner AS (
    INSERT INTO list_subscriber_sources
        (tenant_id, list_id, subscriber_id, email, source, owner_key,
         first_seen_at, last_seen_at, removed_at, metadata)
    SELECT $1::uuid, $2::uuid, m.subscriber_id, m.email, $5, $6,
           m.added_at, m.added_at, NULL, '{"owner":"bulk_add_to_list"}'::jsonb
      FROM membership m
    ON CONFLICT (tenant_id, list_id, subscriber_id, owner_key) DO UPDATE
       SET email        = EXCLUDED.email,
           last_seen_at = EXCLUDED.last_seen_at,
           removed_at   = NULL
    RETURNING subscriber_id
)
SELECT m.subscriber_id::text, COALESCE(m.email::text, ''), m.added_at
  FROM membership m
 ORDER BY m.subscriber_id`,
		tenantID, list.UUID, candidates, list.EngineID, bulkAddToListSource, bulkAddToListOwnerKey)
	if err != nil {
		return out, fmt.Errorf("bulk add to list: upsert memberships: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		rec := bulkInsertedListSubscriber{ListID: list.UUID}
		if err := rows.Scan(&rec.ID, &rec.Email, &rec.AddedAt); err != nil {
			return out, fmt.Errorf("bulk add to list: scan membership: %w", err)
		}
		receipt := recoveryListRow{ID: rec.ID, AddedAt: rec.AddedAt.UTC().Format(time.RFC3339Nano)}
		if before, ok := prior[rec.ID]; ok && before.RemovedAt != nil {
			receipt.Revived = &recoveryListRevival{
				RemovedAt: before.RemovedAt.UTC().Format(time.RFC3339Nano),
				AddedAt:   before.AddedAt.UTC().Format(time.RFC3339Nano),
				Source:    before.Source,
			}
		}
		out.Added = append(out.Added, rec)
		out.Receipt = append(out.Receipt, receipt)
	}
	if err := rows.Err(); err != nil {
		return out, fmt.Errorf("bulk add to list: read memberships: %w", err)
	}
	// A candidate the upsert did not return lost a race with a concurrent
	// writer that made it an active member first. It is on the list, which is
	// what was asked for, so it is reported as already there.
	out.AlreadyMember += len(candidates) - len(out.Added)
	return out, nil
}

// lockBulkListAudience returns the ids in ids that name a subscriber of this
// tenant, locking each FOR KEY SHARE so the subscriber cannot be erased between
// this read and the membership insert that references it.
func lockBulkListAudience(ctx context.Context, tx pgx.Tx, tenantID string, ids []string) ([]string, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])
 ORDER BY id
   FOR KEY SHARE`, tenantID, ids)
	if err != nil {
		return nil, fmt.Errorf("bulk add to list: resolve audience: %w", err)
	}
	found, err := scanRecoverySubscriberIDs(rows)
	if err != nil {
		return nil, fmt.Errorf("bulk add to list: read audience: %w", err)
	}
	return found, nil
}

// lockPriorListMemberships reads the existing membership rows of subscriberIDs
// on listUUID, active or removed, FOR UPDATE.
func lockPriorListMemberships(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, listUUID string,
	subscriberIDs []string,
) (map[string]priorListMembership, error) {
	out := make(map[string]priorListMembership, len(subscriberIDs))
	if len(subscriberIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text, added_at, removed_at, source
  FROM list_subscribers
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND subscriber_id = ANY($3::uuid[])
 ORDER BY subscriber_id
   FOR UPDATE`, tenantID, listUUID, subscriberIDs)
	if err != nil {
		return nil, fmt.Errorf("bulk add to list: lock memberships: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var row priorListMembership
		if err := rows.Scan(&id, &row.AddedAt, &row.RemovedAt, &row.Source); err != nil {
			return nil, fmt.Errorf("bulk add to list: scan membership: %w", err)
		}
		out[id] = row
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("bulk add to list: read memberships: %w", err)
	}
	return out, nil
}
