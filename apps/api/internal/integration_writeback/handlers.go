// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const writebackJSONMaxBodyBytes int64 = 1 << 20

// Store is the persistence surface the handlers + runner program against.
type Store interface {
	ListTargets(context.Context, string) ([]Target, error)
	GetTarget(context.Context, string, string) (*Target, error)
	UpsertTarget(context.Context, string, TargetInput) (*Target, error)
	SetTargetStatus(context.Context, string, string, string) (*Target, error)
	RecordRun(context.Context, string, string, string, RunSummary, time.Time, time.Time) (*Run, error)
	ListRuns(context.Context, string, string, int) ([]Run, error)
	ResolveAudience(context.Context, string, *Target) ([]AudienceMember, error)
}

type Deps struct {
	Repo        Store
	Credentials CredentialResolver
	Adapters    map[string]Adapter
	Logger      *slog.Logger
	Now         func() time.Time
}

func (d *Deps) now() time.Time {
	if d != nil && d.Now != nil {
		return d.Now().UTC()
	}
	return time.Now().UTC()
}

func (d *Deps) adapter(provider string) Adapter {
	if d == nil || d.Adapters == nil {
		return nil
	}
	return d.Adapters[provider]
}

func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(admin).Get("/api/v1/integration-writeback/providers", d.ListProviders)
	r.With(read).Get("/api/v1/integration-writeback/targets", d.ListTargets)
	r.With(admin).Post("/api/v1/integration-writeback/targets", d.CreateTarget)
	r.With(read).Get("/api/v1/integration-writeback/targets/{id}", d.GetTarget)
	r.With(admin).Post("/api/v1/integration-writeback/targets/{id}/run", d.RunTarget)
	r.With(admin).Post("/api/v1/integration-writeback/targets/{id}/pause", d.PauseTarget)
	r.With(admin).Post("/api/v1/integration-writeback/targets/{id}/resume", d.ResumeTarget)
	r.With(admin).Delete("/api/v1/integration-writeback/targets/{id}", d.DisconnectTarget)
	r.With(read).Get("/api/v1/integration-writeback/targets/{id}/runs", d.ListRuns)
}

// ListProviders reports which platforms have a write-back adapter wired.
func (d *Deps) ListProviders(w http.ResponseWriter, r *http.Request) {
	type providerInfo struct {
		Provider  string `json:"provider"`
		Available bool   `json:"available"`
	}
	out := []providerInfo{}
	for _, p := range []string{ProviderShopify, ProviderHubSpot, ProviderSalesforce, ProviderPipedrive, ProviderWooCommerce, ProviderZoho, ProviderKlaviyo} {
		out = append(out, providerInfo{Provider: p, Available: d.adapter(p) != nil})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) ListTargets(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListTargets(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) GetTarget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.GetTarget(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) CreateTarget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in TargetInput
	if err := httpbody.DecodeJSON(w, r, writebackJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if d.adapter(in.Provider) == nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", "no write-back adapter for this provider")
		return
	}
	out, err := d.Repo.UpsertTarget(r.Context(), tenantID, in)
	if err != nil {
		httperror.Write(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) RunTarget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	summary, _, err := d.RunWriteback(r.Context(), tenantID, chi.URLParam(r, "id"), "manual")
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) PauseTarget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.SetTargetStatus(r.Context(), tenantID, chi.URLParam(r, "id"), "paused")
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) ResumeTarget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.SetTargetStatus(r.Context(), tenantID, chi.URLParam(r, "id"), "active")
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DisconnectTarget(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if _, err := d.Repo.SetTargetStatus(r.Context(), tenantID, chi.URLParam(r, "id"), "disconnected"); err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) ListRuns(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListRuns(r.Context(), tenantID, chi.URLParam(r, "id"), queryInt(r, "limit", 25))
	if err != nil {
		d.writeRepoError(w, r, tenantID, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) writeRepoError(w http.ResponseWriter, r *http.Request, tenantID string, err error) {
	if err == ErrNotFound {
		httperror.Write(w, http.StatusNotFound, "not_found", "write-back target not found")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
}

func tenantID(r *http.Request) (string, bool) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t.ID == "" {
		return "", false
	}
	return t.ID, true
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	out, err := strconv.Atoi(raw)
	if err != nil || out <= 0 {
		return fallback
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
