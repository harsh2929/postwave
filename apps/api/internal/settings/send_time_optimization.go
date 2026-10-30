// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace-level send-time-optimization toggle (desktop gap A24).
//
//	GET /api/v1/settings/send-time-optimization → {"enabled": bool}
//	PUT /api/v1/settings/send-time-optimization ← {"enabled": bool}
//
// The flag lives on tenant_send_settings (migration 0299 + 0372) — the
// existing tenant-level send-defaults row — NOT a new table. Missing
// row reads as enabled=true, matching both the column default and the
// desktop's historical device-local default-on behaviour.
//
// New campaigns read this flag at creation time and persist a 24-hour
// per-recipient optimization window. Queue materialization then schedules
// each recipient at their best known hour inside that window.
package settings

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SendTimeOptimization is the wire shape for both GET and PUT
// responses. Deliberately minimal — the desktop only needs the flag.
type SendTimeOptimization struct {
	Enabled bool `json:"enabled"`
}

// sendTimeOptimizationPut is the PUT request body. Pointer so an
// omitted field is a 400 instead of silently defaulting to false.
type sendTimeOptimizationPut struct {
	Enabled *bool `json:"enabled"`
}

// SendTimeOptimizationRepo reads/writes the
// tenant_send_settings.send_time_optimization_enabled column.
type SendTimeOptimizationRepo struct{ Pool *db.Pool }

// Get returns the workspace flag. A missing row reads as enabled=true
// (the column default) so brand-new tenants match the historical
// default-on posture without needing a row write.
func (r *SendTimeOptimizationRepo) Get(ctx context.Context, tenantID string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var enabled bool
	err = tx.QueryRow(ctx, `
SELECT COALESCE(send_time_optimization_enabled, true)
  FROM tenant_send_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&enabled)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return true, tx.Commit(ctx)
		}
		return false, err
	}
	return enabled, tx.Commit(ctx)
}

// Put upserts the flag onto the tenant_send_settings row. The other
// columns keep their defaults on first insert ('none' strategy etc. —
// see migration 0299) and are untouched on update.
func (r *SendTimeOptimizationRepo) Put(ctx context.Context, tenantID, userID string, enabled bool) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO tenant_send_settings (tenant_id, send_time_optimization_enabled, updated_at, updated_by)
VALUES ($1::uuid, $2, now(), NULLIF($3,'')::uuid)
ON CONFLICT (tenant_id) DO UPDATE SET
    send_time_optimization_enabled = EXCLUDED.send_time_optimization_enabled,
    updated_at                     = now(),
    updated_by                     = COALESCE(EXCLUDED.updated_by, tenant_send_settings.updated_by)`,
		tenantID, enabled, userID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SendTimeOptimizationDeps mounts the HTTP surface.
type SendTimeOptimizationDeps struct {
	Repo   *SendTimeOptimizationRepo
	Logger *slog.Logger
}

// MountRoutes wires GET/PUT /api/v1/settings/send-time-optimization.
// Reads are open to any authenticated tenant member (the SendTime page
// renders for everyone); writes are admin-only via the same
// RequireScope(ScopeAdmin) gate the rest of the /settings/* family
// uses (admin scope for API keys, owner/admin role for sessions).
func (d *SendTimeOptimizationDeps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/settings/send-time-optimization", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Put("/api/v1/settings/send-time-optimization", d.Put)
}

// Get GET /api/v1/settings/send-time-optimization.
func (d *SendTimeOptimizationDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	enabled, err := d.Repo.Get(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, SendTimeOptimization{Enabled: enabled})
}

// Put PUT /api/v1/settings/send-time-optimization.
func (d *SendTimeOptimizationDeps) Put(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	userID := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		userID = u.ID
	}
	var in sendTimeOptimizationPut
	if err := httpbody.DecodeJSON(w, r, settingsJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_enabled",
			`body must be {"enabled": true|false}`))
		return
	}
	// Snapshot the pre-write value so the audit row carries a diff.
	before, beforeErr := d.Repo.Get(r.Context(), t.ID)
	if err := d.Repo.Put(r.Context(), t.ID, userID, *in.Enabled); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if beforeErr == nil {
		emitSettingsAudit(r.Context(), d.Repo.Pool, r, t.ID,
			"settings.send_time_optimization.updated", "tenant_send_settings", t.ID,
			SendTimeOptimization{Enabled: before}, SendTimeOptimization{Enabled: *in.Enabled})
	} else {
		emitSettingsAudit(r.Context(), d.Repo.Pool, r, t.ID,
			"settings.send_time_optimization.updated", "tenant_send_settings", t.ID,
			nil, SendTimeOptimization{Enabled: *in.Enabled})
	}
	writeJSON(w, http.StatusOK, SendTimeOptimization{Enabled: *in.Enabled})
}
