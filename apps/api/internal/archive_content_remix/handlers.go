// SPDX-License-Identifier: AGPL-3.0-only
package archive_content_remix

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const remixMaxBodyBytes int64 = 32 << 10

// Deps wires the HTTP surface for the content remix feature.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the content remix endpoints. The /remix action
// is gated on ScopeWriteCampaigns because the deliverables are
// campaign drafts; the read endpoints use ScopeReadCampaigns.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)

	r.With(write).Post("/api/v1/campaigns/{id}/remix", d.CreateJob)
	r.With(read).Get("/api/v1/content-remix/jobs", d.ListJobs)
	r.With(read).Get("/api/v1/content-remix/jobs/{id}", d.GetJob)
}

// CreateJob handles POST /api/v1/campaigns/{id}/remix.
//
// Happy path:
//  1. Validate body + kinds.
//  2. Persist a pending Job + N pending Assets (+ TTS rows where applicable).
//  3. Return 202 with the job id; worker picks up the assets asynchronously.
func (d *Deps) CreateJob(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	campaignID := chi.URLParam(r, "id")
	if campaignID == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "campaign id required")
		return
	}
	var in CreateJobInput
	if err := httpbody.DecodeJSON(w, r, remixMaxBodyBytes, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and the error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	job, assets, err := d.Repo.CreateJob(r.Context(), t.ID, in, campaignID, actorFromCtx(r))
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"job":    job,
		"assets": assets,
	})
}

// ListJobs handles GET /api/v1/content-remix/jobs?limit=50.
func (d *Deps) ListJobs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	limit := 50
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 {
			limit = n
		}
	}
	jobs, err := d.Repo.ListJobs(r.Context(), t.ID, limit)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}

// GetJob handles GET /api/v1/content-remix/jobs/{id}.
func (d *Deps) GetJob(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	jobID := chi.URLParam(r, "id")
	if jobID == "" {
		writeErr(w, http.StatusBadRequest, "missing_id", "job id required")
		return
	}
	job, assets, err := d.Repo.GetJob(r.Context(), t.ID, jobID)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job":    job,
		"assets": assets,
	})
}

// writeRepoErr maps repo errors to HTTP status codes.
//
// Sentinel errors (ErrBadRequest / ErrNotFound / ErrUnavailable) are
// constructed inside this package via fmt.Errorf("%w: <operator-text>", ...)
// so their .Error() output is operator-authored and safe to surface.
// Any unmapped error here is by definition unexpected (typically a raw
// pgx or db.WithTenant failure with sensitive text) — route those through
// httperror.WriteInternal so the raw text is logged server-side but the
// client only sees the generic 500 envelope.
func (d *Deps) writeRepoErr(w http.ResponseWriter, ctx context.Context, err error) {
	switch {
	case errors.Is(err, ErrBadRequest):
		httperror.Write(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, ErrUnavailable):
		httperror.Write(w, http.StatusServiceUnavailable, "unavailable", httperror.MessageInternal)
	default:
		httperror.WriteInternal(w, d.Logger, err, ctx)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// actorFromCtx pulls a best-effort actor label off the request for
// audit. Refined in v2 once we wire a real principal helper into the
// shared middleware package — for now we surface the auth method so the
// audit trail at least distinguishes session vs api-key vs system.
func actorFromCtx(r *http.Request) string {
	switch apikeys.AuthMethodFromContext(r.Context()) {
	case apikeys.AuthMethodAPIKey:
		return "apikey"
	case apikeys.AuthMethodSession:
		return "user"
	}
	return "system"
}

// (kept to silence unused-import warnings in stub-mode tests)
var _ = db.WithTenant
