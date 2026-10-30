// SPDX-License-Identifier: AGPL-3.0-only
package experiments

import (
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

// The surface systems register through.
//
// Without it the identity table is a phantom: nine systems that could register
// and no way to, so the table stays empty while the registry keeps reporting
// hypothesis 0 of 9 — and the code would read as though the gap were closed.

type IdentityDeps struct {
	Repo   *IdentityRepo
	Logger *slog.Logger
}

func (d *IdentityDeps) MountRoutes(r chi.Router) {
	if d == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/experiments/identities", d.List)
	// Writing down what a test is for is an editor action, not an admin one:
	// the person who designs the experiment is the person who knows the
	// hypothesis, and requiring admin would put it out of their reach.
	r.With(apikeys.RequireScope(apikeys.ScopeWriteCampaigns)).
		Post("/api/v1/experiments/identities", d.Register)
	// The registry itself, so a caller can discover which nine keys exist
	// rather than guessing and being refused.
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/experiments/systems", d.ListSystems)
}

func (d *IdentityDeps) ListSystems(w http.ResponseWriter, r *http.Request) {
	type sys struct {
		Key     string   `json:"key"`
		Surface string   `json:"surface"`
		Table   string   `json:"table"`
		Has     []string `json:"has"`
		Missing []string `json:"missing"`
	}
	out := make([]sys, 0, len(Systems))
	for _, s := range Systems {
		has := make([]string, 0, len(s.Has))
		for _, c := range s.Has {
			has = append(has, string(c))
		}
		missing := make([]string, 0)
		for _, c := range s.Missing() {
			missing = append(missing, string(c))
		}
		out = append(out, sys{Key: s.Key, Surface: s.Surface, Table: s.Table, Has: has, Missing: missing})
	}
	writeIdentityJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *IdentityDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	items, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeIdentityJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *IdentityDeps) Register(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in Identity
	if err := httpbody.DecodeJSON(w, r, 16<<10, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	err := d.Repo.Register(r.Context(), t.ID, in)
	if errors.Is(err, ErrUnknownSystem) {
		// Named explicitly: a caller guessing a key needs to know the key is
		// wrong, not that something failed. The systems endpoint lists the nine.
		httperror.WriteValidation(w, "unknown_system",
			"system_key must be one of the registered experiment systems; see GET /api/v1/experiments/systems")
		return
	}
	if err != nil && err.Error() == "experiments: external_id required" {
		httperror.WriteValidation(w, "missing_external_id", "external_id required")
		return
	}
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeIdentityJSON(w, http.StatusOK, map[string]any{"registered": true})
}

func writeIdentityJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
