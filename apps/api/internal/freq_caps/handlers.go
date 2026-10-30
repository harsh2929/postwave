// SPDX-License-Identifier: AGPL-3.0-only
package freq_caps

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the HTTP surface.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal to record server-side
	// detail (tenant_id+request_id+err) without leaking err.Error() to
	// callers. Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers the per-tenant CRUD + dry-run endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/frequency-caps", d.list)
	r.With(admin).Post("/api/v1/frequency-caps", d.create)
	r.With(admin).Patch("/api/v1/frequency-caps/{id}", d.patch)
	r.With(admin).Delete("/api/v1/frequency-caps/{id}", d.delete)
	r.With(admin).Post("/api/v1/frequency-caps/{id}/test", d.test)
}

func (d *Deps) list(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	caps, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"caps": caps, "count": len(caps)})
}

type createInput struct {
	Label         string `json:"label"`
	Channel       string `json:"channel"`
	MessageType   string `json:"message_type"`
	MaxCount      int    `json:"max_count"`
	WindowSeconds int    `json:"window_seconds"`
	AppliesTo     string `json:"applies_to"`
	Active        *bool  `json:"active"`
}

func (d *Deps) create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in createInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	applies := strings.TrimSpace(in.AppliesTo)
	if applies == "" {
		applies = "all"
	}
	cap := Cap{
		Label:         strings.TrimSpace(in.Label),
		Channel:       strings.TrimSpace(in.Channel),
		MessageType:   strings.TrimSpace(in.MessageType),
		MaxCount:      in.MaxCount,
		WindowSeconds: in.WindowSeconds,
		AppliesTo:     applies,
		Active:        in.Active == nil || *in.Active,
	}
	if err := ValidateCap(cap); err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	out, err := d.Repo.Create(r.Context(), t.ID, cap)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"cap": out})
}

func (d *Deps) patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	var in PatchInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	out, err := d.Repo.Patch(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "cap not found")
			return
		}
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cap": out})
}

func (d *Deps) delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	id := chi.URLParam(r, "id")
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "cap not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// test POSTs a dry-run SendContext and returns the decision. Useful
// in the desktop UI for "would this email get capped for jane@x.com".
type testInput struct {
	SubscriberEmail string `json:"subscriber_email"`
	Channel         string `json:"channel"`
	MessageType     string `json:"message_type"`
}

func (d *Deps) test(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	var in testInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	sctx := SendContext{
		SubscriberEmail: strings.ToLower(strings.TrimSpace(in.SubscriberEmail)),
		Channel:         strings.TrimSpace(in.Channel),
		MessageType:     strings.TrimSpace(in.MessageType),
	}
	dec, err := WouldDefer(r.Context(), d.Repo.Pool, t.ID, sctx)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decision": dec, "context": sctx})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
