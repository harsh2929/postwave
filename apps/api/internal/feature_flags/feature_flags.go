// SPDX-License-Identifier: AGPL-3.0-only
//
// Package feature_flags is a per-tenant key/value toggle registry.
//
// The codebase didn't have one before — gradual rollouts went
// through environment variables or app config, neither of which
// supports "enable for this tenant, not that one". Common ESP
// use cases this unlocks:
//
//   * dark-launch a new sending pipeline behind a flag
//   * give beta-program tenants early access to a feature
//   * A/B variant assignment (value isn't restricted to bool)
//   * disable an expensive feature for a noisy-neighbour tenant
//
// Resolution:
//   Resolve(tenant, key) → tenant override ?? platform default ?? null
//
// Surfaces:
//
//   GET  /api/v1/feature-flags                visible to tenant
//   POST /api/v1/feature-flags                upsert override
//   DELETE /api/v1/feature-flags/{key}        clear override
//   GET  /api/v1/feature-flags/{key}/resolve  effective value
//
// Exported helpers:
//   Resolve(ctx, pool, tenantID, key) string
//   IsEnabled(ctx, pool, tenantID, key) bool

package feature_flags

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const requestJSONMaxBodyBytes int64 = 4 << 10

// Deps wires the HTTP surface.
type Deps struct {
	Pool *db.Pool
	// Logger is used by httperror.WriteInternal to record server-side
	// error detail without echoing it to callers. Optional; nil is
	// tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// Flag is the API projection.
type Flag struct {
	ID        string    `json:"id"`
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	Note      string    `json:"note,omitempty"`
	TenantID  string    `json:"tenant_id,omitempty"`
	IsDefault bool      `json:"is_default"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type upsertReq struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	Note  string `json:"note"`
}

// MountRoutes registers the admin endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/feature-flags", d.List)
	r.With(admin).Post("/api/v1/feature-flags", d.Upsert)
	r.With(admin).Delete("/api/v1/feature-flags/{key}", d.Delete)
	r.With(read).Get("/api/v1/feature-flags/{key}/resolve", d.Resolve)
}

// List GET /api/v1/feature-flags.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, flag_key, value, COALESCE(note, ''),
       COALESCE(tenant_id::text, ''), enabled, created_at, updated_at
  FROM tenant_feature_flags
 WHERE tenant_id IS NULL OR tenant_id = $1::uuid
 ORDER BY flag_key, tenant_id IS NULL DESC`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Flag{}
	for rows.Next() {
		var f Flag
		if err := rows.Scan(&f.ID, &f.Key, &f.Value, &f.Note,
			&f.TenantID, &f.Enabled, &f.CreatedAt, &f.UpdatedAt); err == nil {
			f.IsDefault = f.TenantID == ""
			out = append(out, f)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"flags": out, "count": len(out)})
}

// Upsert POST /api/v1/feature-flags.
func (d *Deps) Upsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var body upsertReq
	if err := httpbody.DecodeJSONWith(w, r, requestJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	key := strings.TrimSpace(body.Key)
	if key == "" || len(key) > 200 {
		httperror.Write(w, http.StatusBadRequest, "bad_key", "1..200 chars required")
		return
	}
	value := strings.TrimSpace(body.Value)
	if value == "" || len(value) > 200 {
		httperror.Write(w, http.StatusBadRequest, "bad_value", "1..200 chars required")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var id string
	err = tx.QueryRow(r.Context(), `
INSERT INTO tenant_feature_flags (tenant_id, flag_key, value, note)
VALUES ($1::uuid, $2, $3, NULLIF($4, ''))
ON CONFLICT (tenant_id, flag_key) WHERE tenant_id IS NOT NULL DO UPDATE SET
    value = EXCLUDED.value,
    note  = EXCLUDED.note,
    updated_at = now()
RETURNING id::text`, t.ID, key, value, body.Note).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "key": key, "value": value})
}

// Delete DELETE /api/v1/feature-flags/{key}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	key := chi.URLParam(r, "key")
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	tag, err := tx.Exec(r.Context(),
		`DELETE FROM tenant_feature_flags WHERE tenant_id = $1::uuid AND flag_key = $2`,
		t.ID, key)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		httperror.Write(w, http.StatusNotFound, "not_found", "no tenant override for this key")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Resolve GET /api/v1/feature-flags/{key}/resolve.
func (d *Deps) Resolve(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	key := chi.URLParam(r, "key")
	val, src, err := resolve(r.Context(), d.Pool, t.ID, key)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key":    key,
		"value":  val,
		"source": src, // "tenant" | "default" | "missing"
	})
}

// --- exported helpers ---

// Resolve returns the effective value for (tenant, key). Empty
// string when neither a tenant override nor a platform default
// exists.
func Resolve(ctx context.Context, pool *db.Pool, tenantID, key string) string {
	v, _, _ := resolve(ctx, pool, tenantID, key)
	return v
}

// IsEnabled is a thin wrapper for the bool case. Treats "true",
// "on", "1", "yes" as true; everything else (including missing)
// as false.
func IsEnabled(ctx context.Context, pool *db.Pool, tenantID, key string) bool {
	v := Resolve(ctx, pool, tenantID, key)
	switch strings.ToLower(v) {
	case "true", "on", "1", "yes", "enabled":
		return true
	}
	return false
}

func resolve(ctx context.Context, pool *db.Pool, tenantID, key string) (string, string, error) {
	if pool == nil || tenantID == "" || key == "" {
		return "", "missing", nil
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return "", "missing", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Tenant override first.
	var val string
	err = tx.QueryRow(ctx, `
SELECT value FROM tenant_feature_flags
 WHERE tenant_id = $1::uuid AND flag_key = $2 AND enabled`,
		tenantID, key).Scan(&val)
	if err == nil {
		return val, "tenant", nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "missing", err
	}
	// Platform default.
	err = tx.QueryRow(ctx, `
SELECT value FROM tenant_feature_flags
 WHERE tenant_id IS NULL AND flag_key = $1 AND enabled`, key).Scan(&val)
	if err == nil {
		return val, "default", nil
	}
	return "", "missing", nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
