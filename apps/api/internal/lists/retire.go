package lists

// retire.go — DELETE /api/v1/lists/{id}: delete the engine list AND retire
// everything Moosewave keyed on it.
//
// The handler used to proxy the delete to Listmonk and stop. The list's
// identity survived in list_id_map, so /api/v1/lists/{deletedId}/subscribers
// kept answering 200, a bulk add-to-list could still target the deleted list's
// uuid, and memberships stayed attached to a list that no longer existed.
//
// Now, in one tenant transaction held across the upstream call:
//
//  1. The identity is locked FOR UPDATE. Every first-party membership writer
//     re-reads it FOR KEY SHARE (ResolveListIdentityTx) in the transaction
//     that writes: the Members tab, CSV import, list merge, the subscribers
//     bulk add-to-list, and the owned writer CRM syncs and flow "Move to list"
//     actions use. None of them can write to this list while it is being
//     deleted, and none can write to it afterwards. The engine's own event
//     mirror (listmonk_events) resolves before its transaction; Listmonk emits
//     no membership events for a list it has deleted, so only an event
//     already in flight when the delete lands can reach it.
//  2. Listmonk deletes the list. A refusal rolls everything back.
//  3. Active memberships and their owner rows are soft-removed — the record
//     of who was on the list survives, as it does for every other removal.
//  4. List-scoped webhook endpoints are tombstoned; they can never fire again.
//  5. The identity is retired (migration 2051): from the moment this commits,
//     every resolver in the application reports the list as not found.
//
// If the commit fails after Listmonk deleted the list, the request fails and a
// retry converges: Listmonk answers a delete of a missing list with 200
// (verified against v6.1.0), so the retry performs steps 3-5 and commits.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// retiredListFootprint is what retiring one list identity changed.
type retiredListFootprint struct {
	MembershipsRemoved int64
	WebhooksDeleted    int
}

func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	engineID, ok := parseInt64Strict(id)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errEnv("bad_id", "id must be a positive integer"))
		return
	}
	if d.Repo == nil || d.Repo.Pool == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("repo_unavailable", listsUnavailableMessage))
		return
	}
	ctx := r.Context()
	tx, err := db.WithTenant(ctx, d.Repo.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(ctx, tenant.ID))
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()

	identity, mapped, err := lockEngineListIdentity(ctx, tx, tenant.ID, engineID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(ctx, tenant.ID))
		return
	}
	if !mapped {
		// No identity: Moosewave never keyed anything on this list, so there is
		// nothing to lock or retire — but the list must still be this tenant's
		// to delete (engine_tenancy.go). Release the tenant transaction first:
		// the proof opens its own, and holding this one across the proof and
		// the upstream call would take two pooled connections for nothing.
		_ = tx.Rollback(ctx)
		sole, proofErr := d.Repo.isSoleTenant(ctx, tenant.ID)
		if proofErr != nil {
			httperror.WriteInternal(w, d.Logger, proofErr, httperror.WithTenantIDLog(ctx, tenant.ID))
			return
		}
		if !sole {
			writeJSON(w, http.StatusNotFound, errEnv("list_not_found", "list not found"))
			return
		}
	}

	body, status, err := d.proxy(r, http.MethodDelete, "/api/lists/"+strconv.FormatInt(engineID, 10), nil)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(ctx, tenant.ID))
		return
	}
	if status < 200 || status > 299 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(body)
		return
	}

	var footprint retiredListFootprint
	if mapped {
		footprint, err = retireListIdentityTx(ctx, tx, tenant.ID, identity)
		if err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(ctx, tenant.ID))
			return
		}
		if err := tx.Commit(ctx); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(ctx, tenant.ID))
			return
		}
	}
	audit.EmitOrLog(ctx, d.auditPool(), "list.delete", "list", id, nil, nil, map[string]any{
		"engine_id":           engineID,
		"postwave_uuid":       identity.UUID,
		"memberships_removed": footprint.MembershipsRemoved,
		"webhooks_deleted":    footprint.WebhooksDeleted,
	})
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// lockEngineListIdentity reads the tenant's live identity for engineID FOR
// UPDATE. mapped is false when the tenant has none.
func lockEngineListIdentity(ctx context.Context, tx pgx.Tx, tenantID string, engineID int64) (ListIdentity, bool, error) {
	var identity ListIdentity
	err := tx.QueryRow(ctx, `
SELECT postwave_uuid::text, listmonk_bigint_id
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND listmonk_bigint_id = $2
   FOR UPDATE`, tenantID, engineID).Scan(&identity.UUID, &identity.EngineID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ListIdentity{}, false, nil
	}
	if err != nil {
		return ListIdentity{}, false, fmt.Errorf("lists: lock list identity: %w", err)
	}
	return identity, true, nil
}

// retireListIdentityTx soft-removes the list's memberships and their owners,
// tombstones its scoped webhooks, and retires the identity, all in tx.
func retireListIdentityTx(ctx context.Context, tx pgx.Tx, tenantID string, identity ListIdentity) (retiredListFootprint, error) {
	var footprint retiredListFootprint
	tag, err := tx.Exec(ctx, `
UPDATE list_subscribers
   SET removed_at = now()
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND removed_at IS NULL`, tenantID, identity.UUID)
	if err != nil {
		return footprint, fmt.Errorf("lists: remove memberships of a deleted list: %w", err)
	}
	footprint.MembershipsRemoved = tag.RowsAffected()
	if _, err = tx.Exec(ctx, `
UPDATE list_subscriber_sources
   SET removed_at = now()
 WHERE tenant_id = $1::uuid
   AND list_id = $2::uuid
   AND removed_at IS NULL`, tenantID, identity.UUID); err != nil {
		return footprint, fmt.Errorf("lists: remove membership owners of a deleted list: %w", err)
	}
	footprint.WebhooksDeleted, err = outbound_webhooks.DeleteListScopedTx(ctx, tx, tenantID, identity.UUID)
	if err != nil {
		return footprint, fmt.Errorf("lists: delete webhooks of a deleted list: %w", err)
	}
	var retired bool
	if err = tx.QueryRow(ctx, `SELECT retire_list_identity($1::uuid)`, identity.UUID).Scan(&retired); err != nil {
		return footprint, fmt.Errorf("lists: retire list identity: %w", err)
	}
	if !retired {
		// The row is held FOR UPDATE by this transaction, so nobody else can
		// have retired it; a false here means the database disagrees with the
		// lock we hold, and committing would leave the identity live.
		return footprint, errors.New("lists: list identity was not retired")
	}
	return footprint, nil
}
