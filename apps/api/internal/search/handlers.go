// SPDX-License-Identifier: AGPL-3.0-only
package search

import (
	"context"
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

const searchMaxBody int64 = 4 << 10 // 4 KiB

// Deps wires repo + handlers.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the palette + misc Wave-3 endpoints.
//
//	GET   /api/v1/search?q=...&limit=20
//	GET   /api/v1/blocklist/auto-suppress
//	PATCH /api/v1/blocklist/auto-suppress
//	GET   /api/v1/lists/{id}/inbox-reality
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/search", d.Search)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/blocklist/auto-suppress", d.GetAutoSuppress)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/blocklist/auto-suppress", d.SetAutoSuppress)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/lists/{id}/inbox-reality", d.ListInboxReality)
}

// Search handles GET /api/v1/search.
func (d *Deps) Search(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := 20
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 50 {
			limit = n
		}
	}
	out, err := d.Repo.Query(r.Context(), t.ID, q, limit)
	if err != nil {
		d.writeErr(w, r.Context(), err, "search_failed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetAutoSuppress returns the per-tenant blocklist auto-suppress flag.
func (d *Deps) GetAutoSuppress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	state, err := d.Repo.GetBlocklistAutoSuppressState(r.Context(), t.ID)
	if err != nil {
		d.writeErr(w, r.Context(), err, "get_auto_suppress_failed")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// SetAutoSuppress updates the per-tenant blocklist auto-suppress flag.
func (d *Deps) SetAutoSuppress(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in BlocklistAutoSuppress
	if err := httpbody.DecodeJSON(w, r, searchMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := d.Repo.SetBlocklistAutoSuppress(r.Context(), t.ID, in.AutoSuppress); err != nil {
		d.writeErr(w, r.Context(), err, "set_auto_suppress_failed")
		return
	}
	state, err := d.Repo.GetBlocklistAutoSuppressState(r.Context(), t.ID)
	if err != nil {
		d.writeErr(w, r.Context(), err, "get_auto_suppress_receipt_failed")
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// ListInboxReality handles GET /api/v1/lists/{id}/inbox-reality.
func (d *Deps) ListInboxReality(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	limit := 10
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 25 {
			limit = n
		}
	}
	rows, err := d.Repo.InboxRealityForList(r.Context(), t.ID, id, limit)
	if err != nil {
		d.writeErr(w, r.Context(), err, "inbox_reality_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"list_id": id,
		"items":   rows,
	})
}

func (d *Deps) writeErr(w http.ResponseWriter, ctx context.Context, err error, _ string) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	default:
		httperror.WriteInternal(w, d.Logger, err, ctx)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}
