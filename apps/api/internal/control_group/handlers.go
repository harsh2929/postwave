// SPDX-License-Identifier: AGPL-3.0-only
package control_group

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const controlGroupMaxBody int64 = 32 << 10 // 32 KiB

// Deps wires repo + handlers.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the control-group API:
//
//	GET    /api/v1/control-groups
//	POST   /api/v1/control-groups
//	GET    /api/v1/control-groups/{id}
//	PATCH  /api/v1/control-groups/{id}
//	DELETE /api/v1/control-groups/{id}
//	GET    /api/v1/control-groups/{id}/report?window=30
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/control-groups", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/control-groups", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/control-groups/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Patch("/api/v1/control-groups/{id}", d.Update)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Delete("/api/v1/control-groups/{id}", d.Delete)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/control-groups/{id}/report", d.Report)
}

// List handles GET /api/v1/control-groups.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// Create handles POST /api/v1/control-groups.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, controlGroupMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// Get handles GET /api/v1/control-groups/{id}.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	out, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Update handles PATCH /api/v1/control-groups/{id}.
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, controlGroupMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete handles DELETE /api/v1/control-groups/{id}.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		d.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Report handles GET /api/v1/control-groups/{id}/report.
func (d *Deps) Report(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	window := 30
	if v := strings.TrimSpace(r.URL.Query().Get("window")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			window = n
		}
	}
	rep, err := d.Repo.Report(r.Context(), t.ID, id, window)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (d *Deps) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	default:
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
