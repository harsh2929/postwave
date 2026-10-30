// SPDX-License-Identifier: AGPL-3.0-only
package contact_rating

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires repo + handlers.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers the contact-rating heuristic endpoints.
//
//	POST /api/v1/contact-ratings/recompute        — bulk recompute
//	GET  /api/v1/contact-ratings/{subscriber_id}  — single subscriber view
//
// We deliberately avoid colliding with /api/v1/subscribers/{id}/rating
// (manual set, owned by internal/contact_ratings/) — this surface is
// for the heuristic + per-subscriber introspection.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/contact-ratings/recompute", d.Recompute)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/contact-ratings/{subscriber_id}", d.Get)
}

// Recompute handles POST /api/v1/contact-ratings/recompute. Query
// param ?window=N (days, default 90, max 365).
func (d *Deps) Recompute(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	window := 90
	if v := strings.TrimSpace(r.URL.Query().Get("window")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			window = n
		}
	}
	out, err := d.Repo.Recompute(r.Context(), t.ID, window)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Get returns the per-subscriber rating + signal source.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	sid := strings.TrimSpace(chi.URLParam(r, "subscriber_id"))
	// A path segment that is not a UUID is a CLIENT mistake, and without this
	// guard it reaches Postgres and comes back as `invalid input syntax for
	// type uuid`, which writeErr maps to 500. That turns a bad request into an
	// apparent server fault: the caller sees "internal error", retries, and
	// files a bug against the API. It also masks route shadowing — GET
	// /api/v1/contact-ratings/recompute lands here with sid="recompute" and
	// reports a 500 for what is really "you wanted POST".
	if _, err := uuid.Parse(sid); err != nil {
		httperror.WriteValidation(
			w,
			"invalid_subscriber_id",
			"subscriber_id must be a UUID",
		)
		return
	}
	out, err := d.Repo.Get(r.Context(), t.ID, sid)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrInvalidInput):
		// ErrInvalidInput is our own typed sentinel — err.Error() text
		// is operator-authored and safe to echo to the caller.
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
