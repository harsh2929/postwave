// SPDX-License-Identifier: AGPL-3.0-only
//
// sync_handlers.go — HTTP surface for audience syncs (A13):
//
//	GET    /api/v1/audience-syncs            → {"items":[Sync…]}
//	POST   /api/v1/audience-syncs            → 201 Sync
//	GET    /api/v1/audience-syncs/{id}       → Sync
//	PATCH  /api/v1/audience-syncs/{id}       → Sync
//	DELETE /api/v1/audience-syncs/{id}       → 204
//	POST   /api/v1/audience-syncs/{id}/run   → 200 SyncRun (synchronous-bounded)
//	GET    /api/v1/audience-syncs/{id}/runs  → {"items":[SyncRun…]}
//
// Destination secrets are write-only: every read path masks them
// (secret_set + secret_hint). Run-now executes inline under
// SyncRunTimeout — see sync_runner.go for the v1 execution model.
package audience_destinations

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// SyncDeps wires the audience-syncs handlers.
type SyncDeps struct {
	Repo   *Repo
	Runner *SyncRunner
	Logger *slog.Logger
	// RequireHTTPS rejects plaintext destination URLs (set in non-dev,
	// mirroring outbound webhooks).
	RequireHTTPS bool
}

// MountSyncRoutes registers the per-tenant audience-syncs API.
func MountSyncRoutes(r chi.Router, d *SyncDeps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/audience-syncs", d.ListSyncs)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/audience-syncs", d.CreateSync)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/audience-syncs/{id}", d.GetSync)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/audience-syncs/{id}", d.UpdateSync)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/audience-syncs/{id}", d.DeleteSync)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/audience-syncs/{id}/run", d.RunSync)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/audience-syncs/{id}/runs", d.ListSyncRuns)
}

// writeRepoErr mirrors Deps.writeRepoErr for the sync surface.
func (d *SyncDeps) writeRepoErr(w http.ResponseWriter, r *http.Request, err error) {
	(&Deps{Logger: d.Logger}).writeRepoErr(w, r.Context(), err)
}

// ListSyncs GET /api/v1/audience-syncs.
func (d *SyncDeps) ListSyncs(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	items, err := d.Repo.ListSyncs(r.Context(), t.ID)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// GetSync GET /api/v1/audience-syncs/{id}.
func (d *SyncDeps) GetSync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetSync(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("audience-sync", out.ID, out.UpdatedAt))
	writeJSON(w, http.StatusOK, out)
}

// CreateSync POST /api/v1/audience-syncs.
func (d *SyncDeps) CreateSync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in SyncCreateInput
	if err := httpbody.DecodeJSON(w, r, audienceDestinationsMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := validateCreate(&in, d.RequireHTTPS); err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	// The desktop lists picker may hand us a Listmonk bigint id —
	// normalize to the Moosewave uuid before insert.
	if in.Source.ListID != nil && *in.Source.ListID != "" {
		uuid, err := d.Repo.resolveListRef(r.Context(), t.ID, *in.Source.ListID)
		if err != nil {
			d.writeRepoErr(w, r, err)
			return
		}
		in.Source.ListID = &uuid
	}
	out, err := d.Repo.CreateSync(r.Context(), t.ID, in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("audience-sync", out.ID, out.UpdatedAt))
	writeJSON(w, http.StatusCreated, out)
}

// UpdateSync PATCH /api/v1/audience-syncs/{id}.
func (d *SyncDeps) UpdateSync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in SyncUpdateInput
	if err := httpbody.DecodeJSON(w, r, audienceDestinationsMaxBody, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Source != nil && in.Source.ListID != nil && *in.Source.ListID != "" {
		uuid, err := d.Repo.resolveListRef(r.Context(), t.ID, *in.Source.ListID)
		if err != nil {
			d.writeRepoErr(w, r, err)
			return
		}
		in.Source.ListID = &uuid
	}
	if token, ok := optionalAudienceIfMatch(r); !ok {
		httpcache.WritePreconditionFailed(w)
		return
	} else {
		in.IfMatchToken = token
	}
	out, err := d.Repo.UpdateSync(r.Context(), t.ID, chi.URLParam(r, "id"), in, d.RequireHTTPS)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.Header().Set("ETag", httpcache.ConcurrencyToken("audience-sync", out.ID, out.UpdatedAt))
	writeJSON(w, http.StatusOK, out)
}

// DeleteSync DELETE /api/v1/audience-syncs/{id}.
func (d *SyncDeps) DeleteSync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	ifMatchToken, validIfMatch := optionalAudienceIfMatch(r)
	if !validIfMatch {
		httpcache.WritePreconditionFailed(w)
		return
	}
	if err := d.Repo.DeleteSyncIfCurrent(r.Context(), t.ID, chi.URLParam(r, "id"), ifMatchToken); err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RunSync POST /api/v1/audience-syncs/{id}/run — synchronous-bounded
// v1 execution (see sync_runner.go). Returns the closed run row; a
// failed run is still HTTP 200 with status:"failed" + error so the UI
// can render the run outcome rather than a transport error.
func (d *SyncDeps) RunSync(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.Runner == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "runner_unavailable",
			"audience sync runner not configured on this server")
		return
	}
	ifMatchToken, validIfMatch := optionalAudienceIfMatch(r)
	if !validIfMatch {
		httpcache.WritePreconditionFailed(w)
		return
	}
	run, err := d.Runner.RunIdempotentIfCurrent(r.Context(), t.ID, chi.URLParam(r, "id"), r.Header.Get("Idempotency-Key"), ifMatchToken)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, run)
}

// ListSyncRuns GET /api/v1/audience-syncs/{id}/runs.
func (d *SyncDeps) ListSyncRuns(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	// 404 for unknown sync ids (vs an empty list for a known sync with
	// no runs yet) keeps the UI's not-found handling honest.
	if _, err := d.Repo.GetSync(r.Context(), t.ID, id); err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	runs, err := d.Repo.ListSyncRuns(r.Context(), t.ID, id, 25)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": runs})
}
