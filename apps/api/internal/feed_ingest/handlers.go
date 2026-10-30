// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — HTTP surface for RSS/recurring feed sources:
//
//	GET    /api/v1/feed-sources            → {"items":[FeedSource…]}
//	POST   /api/v1/feed-sources            → 201 FeedSource
//	GET    /api/v1/feed-sources/{id}       → FeedSource
//	PATCH  /api/v1/feed-sources/{id}       → FeedSource
//	DELETE /api/v1/feed-sources/{id}       → 204
//	POST   /api/v1/feed-sources/{id}/poll  → 200 PollResult (synchronous-bounded)
//	GET    /api/v1/feed-sources/{id}/runs  → {"items":[Run…]}
//
// Scopes follow the campaigns surface (these endpoints exist to mint
// draft campaigns): reads need read:campaigns, mutations + manual poll
// need write:campaigns.
package feed_ingest

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const feedIngestMaxBody int64 = 64 << 10 // 64 KiB

// Deps wires the feed-sources handlers.
type Deps struct {
	Repo   *Repo
	Poller *Poller
	Logger *slog.Logger
	// RequireHTTPS rejects plaintext feed URLs (set in non-dev,
	// mirroring outbound webhooks / audience syncs).
	RequireHTTPS bool
}

// MountRoutes registers the per-tenant feed-sources API.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/feed-sources", d.ListSources)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/feed-sources", d.CreateSource)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/feed-sources/{id}", d.GetSource)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Patch("/api/v1/feed-sources/{id}", d.UpdateSource)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Delete("/api/v1/feed-sources/{id}", d.DeleteSource)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/feed-sources/{id}/poll", d.PollSource)
	r.With(apikeys.RequireScope(apikeys.ScopeReadCampaigns)).
		Get("/api/v1/feed-sources/{id}/runs", d.ListRuns)
}

// writeRepoErr routes repository errors to the correct httperror
// helper (same contract as audience_destinations):
//
//   - ErrNotFound → fixed 404 envelope, no error text.
//   - ErrInvalidInput → 400 with the package-authored message verbatim.
//   - Everything else → generic 500 that never leaks err.Error().
func (d *Deps) writeRepoErr(w http.ResponseWriter, ctx context.Context, err error) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "resource not found")
	case errors.Is(err, ErrInvalidInput):
		httperror.WriteValidation(w, "invalid_input", err.Error())
	default:
		httperror.WriteInternal(w, d.Logger, err, ctx)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ListSources GET /api/v1/feed-sources.
func (d *Deps) ListSources(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.Repo.ListSources(r.Context(), t.ID)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GetSource GET /api/v1/feed-sources/{id}.
func (d *Deps) GetSource(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetSource(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// CreateSource POST /api/v1/feed-sources.
func (d *Deps) CreateSource(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, feedIngestMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateCreate(&in, d.RequireHTTPS); err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	out, err := d.Repo.CreateSource(r.Context(), t.ID, in)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// UpdateSource PATCH /api/v1/feed-sources/{id}.
func (d *Deps) UpdateSource(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, feedIngestMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpdateSource(r.Context(), t.ID, chi.URLParam(r, "id"), in, d.RequireHTTPS)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteSource DELETE /api/v1/feed-sources/{id}.
func (d *Deps) DeleteSource(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.Repo.DeleteSource(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PollSource POST /api/v1/feed-sources/{id}/poll — synchronous-bounded
// manual poll. A failed poll is still HTTP 200 with status:"failed" +
// error so the UI can render the run outcome rather than a transport
// error (same contract as audience-syncs' RunSync).
func (d *Deps) PollSource(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.Poller == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "poller_unavailable",
			"feed poller not configured on this server")
		return
	}
	res, err := d.Poller.Poll(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ListRuns GET /api/v1/feed-sources/{id}/runs.
func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	// 404 for unknown source ids (vs an empty list for a known source
	// with no runs yet) keeps the UI's not-found handling honest.
	if _, err := d.Repo.GetSource(r.Context(), t.ID, id); err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	runs, err := d.Repo.ListRuns(r.Context(), t.ID, id, 25)
	if err != nil {
		d.writeRepoErr(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": runs})
}
