package subscribers

// SUB-009 — soft-delete (archive) + retention reconciliation.
//
// Archive sets subscribers.archived_at = now() (reversible); Unarchive
// clears it. Archived rows are hidden from List/Get/Search by default
// (the WHERE archived_at IS NULL filter lives in repo.go) but preserved
// so audit-join keys survive — distinct from the GDPR hard-erasure path
// (Repo.Delete), which destroys the row and writes a permanent
// suppression.
//
// subscriber_retention_policy (migration 0426) holds the per-tenant
// retention_days / max_archived knobs the reconciler reads; the API
// surface to read/write it ships here so operators can configure it.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// RetentionPolicy is the per-tenant archived-subscriber retention config.
type RetentionPolicy struct {
	RetentionDays int        `json:"retention_days"`
	MaxArchived   int        `json:"max_archived"`
	LastPurgedAt  *time.Time `json:"last_purged_at,omitempty"`
}

// Archive soft-deletes by id or email: sets archived_at = now() when it
// is currently NULL, and returns the resulting row. Re-archiving an
// already-archived row is a no-op that returns the existing row (the
// timestamp is preserved, not bumped). Returns ErrNotFound when no row
// matches.
func (r *Repo) Archive(ctx context.Context, tenantID, id, ifMatchToken string, auditMeta db.AuditMeta) (*Subscriber, error) {
	return r.setArchived(ctx, tenantID, id, ifMatchToken, true, auditMeta)
}

// Unarchive clears archived_at (restores the row to the active list).
// No-op + returns the row when it is already active. ErrNotFound when no
// row matches.
func (r *Repo) Unarchive(ctx context.Context, tenantID, id, ifMatchToken string, auditMeta db.AuditMeta) (*Subscriber, error) {
	return r.setArchived(ctx, tenantID, id, ifMatchToken, false, auditMeta)
}

// setArchived is the single transactional archive state machine. It binds the
// operator's decision to the exact subscriber revision, serialises concurrent
// writers, and commits the projection, engine reconciliation, webhook intent,
// and audit evidence together. A downstream failure cannot leave an archived
// row without its compliance trail or delivery-engine update.
func (r *Repo) setArchived(
	ctx context.Context,
	tenantID, id, ifMatchToken string,
	archived bool,
	auditMeta db.AuditMeta,
) (*Subscriber, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	current, err := scanSubscriber(tx.QueryRow(ctx, `
SELECT `+subscriberColumns+`
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND (id::text = $2 OR lower(email::text) = lower($2))
 FOR UPDATE`, tenantID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(ifMatchToken) == "" || ifMatchToken != current.Version {
		return nil, ErrPreconditionFailed
	}
	if (current.ArchivedAt != nil) == archived {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return current, nil
	}

	archivedAtSQL := "NULL"
	if archived {
		archivedAtSQL = "clock_timestamp()"
	}
	updated, err := scanSubscriber(tx.QueryRow(ctx, `
UPDATE subscribers
   SET archived_at = `+archivedAtSQL+`,
       updated_at  = clock_timestamp()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING `+subscriberColumns, tenantID, current.ID))
	if err != nil {
		return nil, err
	}
	if err := r.appendEngineSync(ctx, tx, tenantID, updated.ID, ""); err != nil {
		return nil, err
	}
	if r.Webhooks != nil {
		if _, err := r.Webhooks.Fire(ctx, tx, WebhookFireInput{
			TenantID:       tenantID,
			EventType:      EventSubscriberUpdated,
			Body:           updated,
			IdempotencyKey: "subscriber-archive-state:" + updated.ID + ":" + updated.Version,
		}); err != nil {
			return nil, fmt.Errorf("dispatch subscriber archive webhook: %w", err)
		}
	}
	action := "subscriber.unarchived"
	if archived {
		action = "subscriber.archived"
	}
	auditMeta.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, action, "subscriber", updated.ID, map[string]any{
		"archived":         archived,
		"previous_version": current.Version,
		"new_version":      updated.Version,
	}); err != nil {
		return nil, fmt.Errorf("audit subscriber archive state: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}

// GetRetentionPolicy returns the tenant's archived-subscriber retention
// policy, defaulting to the zero policy (no auto-purge) when none is set.
func (r *Repo) GetRetentionPolicy(ctx context.Context, tenantID string) (*RetentionPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p RetentionPolicy
	err = tx.QueryRow(ctx, `
SELECT retention_days, max_archived, last_purged_at
  FROM subscriber_retention_policy
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&p.RetentionDays, &p.MaxArchived, &p.LastPurgedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return &RetentionPolicy{}, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	return &p, tx.Commit(ctx)
}

// SetRetentionPolicy upserts the tenant's retention policy and returns
// the persisted row.
func (r *Repo) SetRetentionPolicy(ctx context.Context, tenantID string, in RetentionPolicy) (*RetentionPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p RetentionPolicy
	err = tx.QueryRow(ctx, `
INSERT INTO subscriber_retention_policy (tenant_id, retention_days, max_archived)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (tenant_id) DO UPDATE SET
    retention_days = EXCLUDED.retention_days,
    max_archived   = EXCLUDED.max_archived,
    updated_at     = now()
RETURNING retention_days, max_archived, last_purged_at`,
		tenantID, in.RetentionDays, in.MaxArchived).Scan(&p.RetentionDays, &p.MaxArchived, &p.LastPurgedAt)
	if err != nil {
		return nil, err
	}
	return &p, tx.Commit(ctx)
}

// MountSoftDeleteRoutes registers the archive / unarchive + retention
// policy routes. Archive/unarchive are write-scoped; the policy GET is
// read-scoped and PUT is write-scoped.
func MountSoftDeleteRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/archive", d.Archive)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/unarchive", d.Unarchive)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/retention-policy", d.GetRetentionPolicy)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/subscribers/retention-policy", d.SetRetentionPolicy)
}

// Archive PATCH /api/v1/subscribers/{id}/archive
func (d *Deps) Archive(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	token, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		httpcache.WritePreconditionRequired(w)
		return
	}
	id := chi.URLParam(r, "id")
	sub, err := d.Repo.Archive(r.Context(), t.ID, id, token, middleware.AuditMetaFromRequest(r))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.emit(t.ID, "subscriber.archived", map[string]any{"id": sub.ID})
	w.Header().Set("ETag", sub.Version)
	writeJSON(w, http.StatusOK, sub)
}

// Unarchive PATCH /api/v1/subscribers/{id}/unarchive
func (d *Deps) Unarchive(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	token, present, wildcard := httpcache.ParseIfMatch(r)
	if !present || wildcard {
		httpcache.WritePreconditionRequired(w)
		return
	}
	id := chi.URLParam(r, "id")
	sub, err := d.Repo.Unarchive(r.Context(), t.ID, id, token, middleware.AuditMetaFromRequest(r))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "subscriber not found"))
			return
		}
		if errors.Is(err, ErrPreconditionFailed) {
			httpcache.WritePreconditionFailed(w)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.emit(t.ID, "subscriber.unarchived", map[string]any{"id": sub.ID})
	w.Header().Set("ETag", sub.Version)
	writeJSON(w, http.StatusOK, sub)
}

// GetRetentionPolicy GET /api/v1/subscribers/retention-policy
func (d *Deps) GetRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetRetentionPolicy(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SetRetentionPolicy PUT /api/v1/subscribers/retention-policy
func (d *Deps) SetRetentionPolicy(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in RetentionPolicy
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.RetentionDays < 0 || in.MaxArchived < 0 {
		httperror.WriteValidation(w, "validation_failed", "retention_days and max_archived must be >= 0")
		return
	}
	out, err := d.Repo.SetRetentionPolicy(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// isTruthy reports whether a query-param string represents an affirmative
// boolean (1/true/yes/on, case-insensitive). Empty/unset → false.
func isTruthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
