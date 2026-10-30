// SPDX-License-Identifier: AGPL-3.0-only
package dedupeinfo

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP surface.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

const dedupeJSONMaxBodyBytes int64 = 8 << 10 // 8 KiB

// MountRoutes registers the SUB-021 settings surface:
//
//	GET /api/v1/settings/deduplication   (read; read:subscribers)
//	PUT /api/v1/settings/deduplication   (set; admin)
//
// The mutating PUT requires the admin scope since it changes a workspace
// policy that drives server-side filtering for every operator; the read
// surface is read-scoped.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/settings/deduplication", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Put("/api/v1/settings/deduplication", d.Update)
}

// Get GET /api/v1/settings/deduplication
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	s, err := d.Repo.Load(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// Update PUT /api/v1/settings/deduplication
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, dedupeJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.MergeConfidenceThreshold == nil {
		httperror.WriteValidation(w, "validation_failed",
			"merge_confidence_threshold is required")
		return
	}
	v := *in.MergeConfidenceThreshold
	if v < MinThreshold || v > MaxThreshold {
		httperror.WriteValidation(w, "invalid_threshold",
			"merge_confidence_threshold must be between 0 and 1")
		return
	}
	s, err := d.Repo.Upsert(r.Context(), t.ID, v)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
