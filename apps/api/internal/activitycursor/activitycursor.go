// SPDX-License-Identifier: AGPL-3.0-only
//
// Package activitycursor is the cross-device "resume where you left off"
// cursor (Apple-level integration blueprint, Phase 1 — Continuity). It stores
// one @postwave/route-map (entity_key, entity_id) reference per user — the
// most recently viewed entity — server-side, so any of the user's devices can
// offer "Continue — <entity>". It is an ID reference only; no customer content
// is stored.
//
// RLS is tenant-scoped (migration 1777). Per-USER isolation is enforced by the
// handlers, which always pin user_id to the acting session user — a user can
// only ever read or write their own cursor. The route is session-only (a
// per-user continuity signal makes no sense for a shared API key).

package activitycursor

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// maxEntityKeyLen / maxEntityIDLen mirror the bounds enforced by the migration
// CHECKs and by @postwave/route-map's isSafeResourceId, so a crafted body is
// rejected at the edge rather than by the DB constraint.
const (
	maxEntityKeyLen = 64
	maxEntityIDLen  = 256
)

// Cursor is the wire shape of the stored reference.
type Cursor struct {
	EntityKey string    `json:"entity_key"`
	EntityID  string    `json:"entity_id"`
	ViewedAt  time.Time `json:"viewed_at"`
}

// Repo is the data layer.
type Repo struct{ Pool *db.Pool }

// Put upserts the user's single cursor to the given entity reference.
func (r *Repo) Put(ctx context.Context, tenantID, userID, entityKey, entityID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO activity_cursor (tenant_id, user_id, entity_key, entity_id, viewed_at)
VALUES ($1::uuid, $2::uuid, $3, $4, now())
ON CONFLICT (tenant_id, user_id)
DO UPDATE SET entity_key = EXCLUDED.entity_key,
              entity_id  = EXCLUDED.entity_id,
              viewed_at  = EXCLUDED.viewed_at`,
		tenantID, userID, entityKey, entityID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Get returns the user's cursor, or (nil, nil) when none is set.
func (r *Repo) Get(ctx context.Context, tenantID, userID string) (*Cursor, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var c Cursor
	err = tx.QueryRow(ctx, `
SELECT entity_key, entity_id, viewed_at
  FROM activity_cursor
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
		tenantID, userID).Scan(&c.EntityKey, &c.EntityID, &c.ViewedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	return &c, tx.Commit(ctx)
}

// Deps mounts the HTTP surface.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers GET + PUT /api/v1/activity/last-viewed. Callers wrap
// this in a session-only auth group.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/activity/last-viewed", d.Get)
	r.Put("/api/v1/activity/last-viewed", d.Put)
}

func (d *Deps) actor(w http.ResponseWriter, r *http.Request) (tenantID, userID string, ok bool) {
	t, tok := middleware.TenantFromContext(r.Context())
	u, uok := middleware.UserFromContext(r.Context())
	if !tok || !uok || u.ID == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_session",
			"sign in to resume where you left off")
		return "", "", false
	}
	return t.ID, u.ID, true
}

// Get returns the acting user's resume cursor, or 204 when none.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	cursor, err := d.Repo.Get(r.Context(), tenantID, userID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if cursor == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, cursor)
}

type putBody struct {
	EntityKey string `json:"entity_key"`
	EntityID  string `json:"entity_id"`
}

// Put records the acting user's most-recently-viewed entity.
func (d *Deps) Put(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := d.actor(w, r)
	if !ok {
		return
	}
	var body putBody
	// httpbody rather than a bare decoder over MaxBytesReader. The two differ on
	// the case that actually happens: an over-size body. The old form collapsed
	// every decode failure into 400 `invalid_json`, so a client sending more
	// than 4 KiB was told its JSON was malformed when the JSON was fine and the
	// body was simply too big — a message that sends someone looking in the
	// wrong place. httpbody distinguishes them and answers 413 with the limit.
	//
	// Unknown fields stay ALLOWED, deliberately: this endpoint is called by three
	// clients that version independently, and a newer one sending a field this
	// build does not know is not an error worth failing a resume cursor over.
	if err := httpbody.DecodeJSON(w, r, 4096, &body); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if !validRef(body.EntityKey, body.EntityID) {
		httperror.Write(w, http.StatusBadRequest, "invalid_entity_ref",
			"entity_key and entity_id must be non-empty and within bounds")
		return
	}
	if err := d.Repo.Put(r.Context(), tenantID, userID, body.EntityKey, body.EntityID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validRef enforces the same bounds as the migration CHECKs. The concrete
// entity_key is validated against @postwave/route-map on the CLIENT (which
// owns the registry); the server enforces only the length/charset envelope so
// a bad reference cannot corrupt the row or leak content.
func validRef(entityKey, entityID string) bool {
	if entityKey == "" || entityID == "" {
		return false
	}
	if len(entityKey) > maxEntityKeyLen || len(entityID) > maxEntityIDLen {
		return false
	}
	return isBoundedToken(entityKey) && isBoundedToken(entityID)
}

// isBoundedToken accepts printable ASCII without control characters or
// whitespace — enough for route-map slugs and opaque ids, tight enough to
// reject smuggled content/newlines.
func isBoundedToken(s string) bool {
	for _, r := range s {
		if r <= 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
