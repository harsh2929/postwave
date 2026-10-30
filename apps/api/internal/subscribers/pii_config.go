// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-072 — AI gateway / privacy firewall for prompts (HTTP surface).
//
// This file is the subscriber-package HTTP surface for the PII gateway. The
// tokenization/sanitization engine lives in the sibling pii_gateway package
// (sanitizer + token registry + repo); here we expose the per-tenant control
// plane an operator uses to mark which subscriber fields are PII-sensitive, plus
// the internal token-lookup endpoint an async detokenization flow calls.
//
// Endpoints:
//
//	GET   /api/v1/settings/pii-config          (read field-sensitivity flags; read scope)
//	PATCH /api/v1/settings/pii-config          (set field-sensitivity flags; admin scope)
//	POST  /internal/pii-gateway/tokens         (resolve token->value for detokenization; admin scope)
//
// The engine is intercepted at the model call via pii_gateway.WrapVoiceClient in
// the AI composition path (wired in main.go); this package owns only the config
// and token reversal HTTP surface so the subscribers settings UI has a backend.

package subscribers

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/pii_gateway"
)

// PIIGatewayStore is the minimal slice of pii_gateway.Repo the subscriber
// handlers need. Defined as an interface so tests can pass a fake without a live
// DB, and so the dependency is explicit. The concrete *pii_gateway.Repo
// satisfies it.
type PIIGatewayStore interface {
	LoadConfig(ctx context.Context, tenantID string) ([]pii_gateway.FieldSensitivity, error)
	UpsertConfig(ctx context.Context, tenantID string, in []pii_gateway.UpdateFieldInput) ([]pii_gateway.FieldSensitivity, error)
	LookupToken(ctx context.Context, tenantID, token string) (string, error)
}

// UpdatePIIConfigInput is the PATCH /api/v1/settings/pii-config body — a batch
// of field-sensitivity flags. Each entry upserts one (tenant, field) flag.
type UpdatePIIConfigInput struct {
	Fields []pii_gateway.UpdateFieldInput `json:"fields"`
}

// LookupTokenInput is the POST /internal/pii-gateway/tokens body.
type LookupTokenInput struct {
	Token string `json:"token"`
}

// MountPIIConfigRoutes wires the SUB-072 control-plane + internal token surface.
// The read is read-scoped; the mutating PATCH and the internal token lookup are
// admin-scoped (they change/inspect a workspace privacy policy + reverse PII).
func MountPIIConfigRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/settings/pii-config", d.GetPIIConfig)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Patch("/api/v1/settings/pii-config", d.UpdatePIIConfig)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/internal/pii-gateway/tokens", d.LookupPIIToken)
}

// GetPIIConfig GET /api/v1/settings/pii-config
func (d *Deps) GetPIIConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.PIIGateway == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "pii_gateway_unconfigured", "PII gateway is not configured")
		return
	}
	cfg, err := d.PIIGateway.LoadConfig(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"built_in_fields": pii_gateway.BuiltInSensitiveFields,
		"fields":          cfg,
	})
}

// UpdatePIIConfig PATCH /api/v1/settings/pii-config
func (d *Deps) UpdatePIIConfig(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.PIIGateway == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "pii_gateway_unconfigured", "PII gateway is not configured")
		return
	}
	var in UpdatePIIConfigInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Fields) == 0 {
		httperror.WriteValidation(w, "validation_failed", "fields is required and must be non-empty")
		return
	}
	cfg, err := d.PIIGateway.UpsertConfig(r.Context(), t.ID, in.Fields)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.emit(t.ID, "subscriber.pii_config.updated", map[string]any{
		"field_count": len(cfg),
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"built_in_fields": pii_gateway.BuiltInSensitiveFields,
		"fields":          cfg,
	})
}

// LookupPIIToken POST /internal/pii-gateway/tokens — resolves a single token to
// its cleartext value for an async detokenization flow. 404s an unknown/expired
// token so a caller cannot probe the store.
func (d *Deps) LookupPIIToken(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d.PIIGateway == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "pii_gateway_unconfigured", "PII gateway is not configured")
		return
	}
	var in LookupTokenInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Token == "" {
		httperror.WriteValidation(w, "validation_failed", "token is required")
		return
	}
	value, err := d.PIIGateway.LookupToken(r.Context(), t.ID, in.Token)
	if err != nil {
		if err == pii_gateway.ErrNotFound {
			httperror.Write(w, http.StatusNotFound, "not_found", "token not found or expired")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": in.Token, "value": value})
}
