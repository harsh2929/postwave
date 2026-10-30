// SPDX-License-Identifier: AGPL-3.0-only
package sending

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

const dedicatedIPJSONMaxBodyBytes int64 = 8 << 10

// DedicatedIPHandlersDeps wires the per-tenant dedicated-IP read/write
// admin endpoints.
type DedicatedIPHandlersDeps struct {
	Repo   *DedicatedIPRepo
	Logger *slog.Logger
}

// MountDedicatedIPRoutes mounts:
//
//	GET    /api/v1/sending/dedicated-ips                   — list tenant's IPs
//	POST   /api/v1/sending/dedicated-ips                   — register a new IP
//	GET    /api/v1/sending/dedicated-ips/snapshots         — latest reputation per IP
//	POST   /api/v1/sending/dedicated-ips/{id}/drain        — manual halt
func MountDedicatedIPRoutes(r chi.Router, d *DedicatedIPHandlersDeps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/sending/dedicated-ips", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(
		"/api/v1/sending/dedicated-ips", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).Get(
		"/api/v1/sending/dedicated-ips/snapshots", d.Snapshots)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post(
		"/api/v1/sending/dedicated-ips/{id}/drain", d.Drain)
}

// CreateDedicatedIPInput is the request body for POST.
type CreateDedicatedIPInput struct {
	IP                 string `json:"ip"`
	Pool               string `json:"pool"`
	Provider           string `json:"provider"`
	ProviderResourceID string `json:"provider_resource_id"`
}

// List GET /api/v1/sending/dedicated-ips
func (d *DedicatedIPHandlersDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeDedicatedIPJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	rows, err := d.Repo.ListByTenant(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeDedicatedIPJSON(w, http.StatusOK, map[string]any{"ips": rows})
}

// Create POST /api/v1/sending/dedicated-ips
func (d *DedicatedIPHandlersDeps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeDedicatedIPJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateDedicatedIPInput
	if err := httpbody.DecodeJSON(w, r, dedicatedIPJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err),
			httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.IP == "" {
		writeDedicatedIPJSON(w, http.StatusBadRequest, errEnv("missing_ip", "ip is required"))
		return
	}
	if in.Pool == "" {
		in.Pool = "paid_pro"
	}
	if in.Provider == "" {
		in.Provider = "postmark"
	}
	a, err := d.Repo.Assign(r.Context(), t.ID, in.IP, in.Pool, in.Provider, in.ProviderResourceID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeDedicatedIPJSON(w, http.StatusCreated, a)
}

// Snapshots GET /api/v1/sending/dedicated-ips/snapshots — returns the
// most-recent reputation snapshot per IP for the tenant.
func (d *DedicatedIPHandlersDeps) Snapshots(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeDedicatedIPJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	reps, err := d.Repo.LatestSnapshotsByTenant(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Roll up into a PoolReputation summary so the dashboard can
	// render "your Pro pool is at 87% health" without re-aggregating.
	byPool := map[string][]IPReputation{}
	for _, rep := range reps {
		byPool[rep.Pool] = append(byPool[rep.Pool], rep)
	}
	pools := make(map[string]PoolReputation, len(byPool))
	for name, ips := range byPool {
		pools[name] = AggregatePool(name, ips)
	}
	writeDedicatedIPJSON(w, http.StatusOK, map[string]any{
		"ips":   reps,
		"pools": pools,
	})
}

// Drain POST /api/v1/sending/dedicated-ips/{id}/drain — manual halt.
//
// Tenant-scoped: MarkDrainingForTenant binds the UPDATE to the caller's
// tenant_id via db.WithTenant, so a tenant that knows or guesses
// another tenant's assignment id still cannot halt their pool.
func (d *DedicatedIPHandlersDeps) Drain(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeDedicatedIPJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		writeDedicatedIPJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	if err := d.Repo.MarkDrainingForTenant(r.Context(), t.ID, id, HaltReasonManual); err != nil {
		if errors.Is(err, ErrAssignmentNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "assignment not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeDedicatedIPJSON(w, http.StatusAccepted, map[string]any{"id": id, "status": "draining"})
}

// --- helpers ---

func writeDedicatedIPJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type errEnvelope struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func errEnv(code, msg string) errEnvelope { return errEnvelope{Code: code, Message: msg} }
