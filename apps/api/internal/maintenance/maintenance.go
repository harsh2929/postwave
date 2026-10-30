// SPDX-License-Identifier: AGPL-3.0-only
//
// Package maintenance implements scheduled-maintenance windows for
// the status page.
//
//   POST   /api/v1/maintenance-windows         create (admin)
//   GET    /api/v1/maintenance-windows         list (admin)
//   PATCH  /api/v1/maintenance-windows/{id}    update (admin)
//   DELETE /api/v1/maintenance-windows/{id}    cancel (admin)
//
//   GET    /api/status/maintenance             PUBLIC — current +
//                                                upcoming windows
//                                                for the status
//                                                page banner.

package maintenance

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Window is the wire shape.
type Window struct {
	ID          string    `json:"id"`
	TenantID    *string   `json:"tenant_id,omitempty"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Components  []string  `json:"components"`
	StartsAt    time.Time `json:"starts_at"`
	EndsAt      time.Time `json:"ends_at"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
}

// CreateInput is the POST body.
type CreateInput struct {
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Components  []string  `json:"components"`
	StartsAt    time.Time `json:"starts_at"`
	EndsAt      time.Time `json:"ends_at"`
}

// Deps wires the handlers.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountAdminRoutes registers the tenant-scoped admin CRUD.
func MountAdminRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(admin).Get("/api/v1/maintenance-windows", d.List)
	r.With(admin).Post("/api/v1/maintenance-windows", d.Create)
	r.With(admin).Patch("/api/v1/maintenance-windows/{id}", d.Patch)
	r.With(admin).Delete("/api/v1/maintenance-windows/{id}", d.Delete)
}

// MountPublicRoutes registers the unauthenticated status-page
// endpoint. Caller wires on the outer router so the public status
// page can read without auth.
func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	r.Get("/api/status/maintenance", d.Public)
}

// Create POST /api/v1/maintenance-windows.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		writeErr(w, http.StatusBadRequest, "missing_title", "title is required")
		return
	}
	if !in.EndsAt.After(in.StartsAt) {
		writeErr(w, http.StatusBadRequest, "invalid_window",
			"ends_at must be after starts_at")
		return
	}
	if in.StartsAt.Before(time.Now().Add(-1 * time.Hour)) {
		writeErr(w, http.StatusBadRequest, "starts_in_past",
			"starts_at must be in the future (1h tolerance for clock skew)")
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
INSERT INTO maintenance_windows
  (tenant_id, title, description, components, starts_at, ends_at)
VALUES ($1::uuid, $2, $3, $4::text[], $5, $6)
RETURNING id::text`,
		t.ID, in.Title, in.Description, in.Components,
		in.StartsAt.UTC(), in.EndsAt.UTC()).Scan(&id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id})
}

// List GET /api/v1/maintenance-windows.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	rows, err := tx.Query(r.Context(), `
SELECT id::text, tenant_id::text, title, description, components,
       starts_at, ends_at, status, created_at
  FROM maintenance_windows
 WHERE tenant_id = $1::uuid OR tenant_id IS NULL
 ORDER BY starts_at DESC
 LIMIT 200`, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	out := []Window{}
	for rows.Next() {
		var win Window
		var tenantID *string
		if err := rows.Scan(&win.ID, &tenantID, &win.Title, &win.Description,
			&win.Components, &win.StartsAt, &win.EndsAt, &win.Status,
			&win.CreatedAt); err != nil {
			continue
		}
		win.TenantID = tenantID
		out = append(out, win)
	}
	writeJSON(w, http.StatusOK, map[string]any{"windows": out})
}

// Patch PATCH /api/v1/maintenance-windows/{id} — update status /
// title / description / times. Used to flip 'scheduled' →
// 'in_progress' → 'completed' or to cancel.
func (d *Deps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	var in struct {
		Title       string     `json:"title,omitempty"`
		Description string     `json:"description,omitempty"`
		Status      string     `json:"status,omitempty"`
		StartsAt    *time.Time `json:"starts_at,omitempty"`
		EndsAt      *time.Time `json:"ends_at,omitempty"`
	}
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	if in.Status != "" {
		switch in.Status {
		case "scheduled", "in_progress", "completed", "cancelled":
		default:
			writeErr(w, http.StatusBadRequest, "invalid_status", "")
			return
		}
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if in.Title != "" {
		_, _ = tx.Exec(r.Context(),
			`UPDATE maintenance_windows SET title = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			strings.TrimSpace(in.Title), t.ID, id)
	}
	if in.Description != "" {
		_, _ = tx.Exec(r.Context(),
			`UPDATE maintenance_windows SET description = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			in.Description, t.ID, id)
	}
	if in.Status != "" {
		_, _ = tx.Exec(r.Context(),
			`UPDATE maintenance_windows SET status = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			in.Status, t.ID, id)
	}
	if in.StartsAt != nil {
		_, _ = tx.Exec(r.Context(),
			`UPDATE maintenance_windows SET starts_at = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			in.StartsAt.UTC(), t.ID, id)
	}
	if in.EndsAt != nil {
		_, _ = tx.Exec(r.Context(),
			`UPDATE maintenance_windows SET ends_at = $1, updated_at = now()
			   WHERE tenant_id = $2::uuid AND id = $3::uuid`,
			in.EndsAt.UTC(), t.ID, id)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": true})
}

// Delete DELETE /api/v1/maintenance-windows/{id} — cancel via
// soft-flag (status='cancelled'), not hard delete, so the history
// survives for the post-incident report.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	tx, err := db.WithTenant(r.Context(), d.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err := tx.Exec(r.Context(),
		`UPDATE maintenance_windows SET status = 'cancelled', updated_at = now()
		   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
}

// Public GET /api/status/maintenance — unauthenticated; the status
// page reads this to render the "scheduled maintenance" banner.
//
// Returns:
//   - Active windows (now ∈ [starts_at, ends_at])
//   - Upcoming windows (starts_at within next 7 days)
//   - Recently completed (ended within the last 24 hours)
//
// Read directly from the pool with no GUC — the public-banner
// route doesn't have a tenant context, and the tenants_visible RLS
// policy allows NULL-tenant rows through the
// `tenant_id IS NULL` branch.
func (d *Deps) Public(w http.ResponseWriter, r *http.Request) {
	rows, err := d.Pool.Query(r.Context(), `
SELECT id::text, tenant_id::text, title, description, components,
       starts_at, ends_at, status
  FROM maintenance_windows
 WHERE (
   (status IN ('scheduled','in_progress')
     AND ends_at > now()
     AND starts_at < now() + INTERVAL '7 days')
   OR (status = 'completed'
       AND ends_at > now() - INTERVAL '24 hours')
 )
 ORDER BY starts_at ASC
 LIMIT 50`)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer rows.Close()
	now := time.Now().UTC()
	active := []Window{}
	upcoming := []Window{}
	completed := []Window{}
	for rows.Next() {
		var win Window
		var tenantID *string
		if err := rows.Scan(&win.ID, &tenantID, &win.Title, &win.Description,
			&win.Components, &win.StartsAt, &win.EndsAt, &win.Status); err != nil {
			continue
		}
		win.TenantID = tenantID
		switch {
		case win.Status == "completed":
			completed = append(completed, win)
		case !win.StartsAt.After(now) && win.EndsAt.After(now):
			active = append(active, win)
		default:
			upcoming = append(upcoming, win)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"active":          active,
		"upcoming":        upcoming,
		"recent_complete": completed,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep imports referenced.
var (
	_                 = errors.New
	_ context.Context = nil
)
