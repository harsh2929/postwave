package audiences

// HTTP surface for SUB-033 lookalike audiences.
//
//	POST   /api/v1/audiences/lookalike              create + materialise  (write:subscribers)
//	GET    /api/v1/audiences/lookalike/{id}         model metadata        (read:subscribers)
//	GET    /api/v1/audiences/lookalike/{id}/members ranked members (page) (read:subscribers)
//	DELETE /api/v1/audiences/lookalike/{id}         discard model         (write:subscribers)

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const lookalikeJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// Deps bundles the lookalike-audience handler dependencies. Logger is
// optional; when nil httperror.WriteInternal still emits the 500 envelope but
// suppresses the structured log line.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the lookalike-audience routes. The caller is
// responsible for ensuring tenant middleware is in front of them.
func MountRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/audiences/lookalike", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/audiences/lookalike/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/audiences/lookalike/{id}/members", d.Members)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/audiences/lookalike/{id}", d.Delete)
}

// Create POST /api/v1/audiences/lookalike
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateLookalikeInput
	if err := httpbody.DecodeJSON(w, r, lookalikeJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	m, err := d.Repo.CreateLookalike(r.Context(), t.ID, in)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

// Get GET /api/v1/audiences/lookalike/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	m, err := d.Repo.GetLookalike(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// Members GET /api/v1/audiences/lookalike/{id}/members?page=&per_page=
func (d *Deps) Members(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	includePII := r.URL.Query().Get("include_pii") == "true"
	out, err := d.Repo.ListMembers(r.Context(), t.ID, chi.URLParam(r, "id"), page, perPage, includePII)
	if err != nil {
		d.writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Delete DELETE /api/v1/audiences/lookalike/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.Repo.DeleteLookalike(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		d.writeErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeErr maps repo errors to HTTP responses:
//   - ErrNotFound     -> 404
//   - ErrInvalidInput -> 422 with the operator-authored message
//   - anything else   -> generic 500 (logged server-side)
func (d *Deps) writeErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "lookalike audience not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "validation_failed", err.Error())
	default:
		tenantID := ""
		if t, ok := middleware.TenantFromContext(r.Context()); ok {
			tenantID = t.ID
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
