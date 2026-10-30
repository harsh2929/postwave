// SPDX-License-Identifier: AGPL-3.0-only
package byok

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	pwkms "github.com/postwave/postwave/packages/kms"
)

const byokJSONMaxBodyBytes int64 = 16 << 10 // 16 KiB; key payloads are tiny

// Deps wires the BYOK admin handlers.
type Deps struct {
	Repo       AdminKeyStore
	Registry   *pwkms.Registry
	Retirement KeyRetirementChecker
	Logger     *slog.Logger
}

// AdminKeyStore is the lifecycle surface used by the HTTP API. Keeping it
// narrow makes the health-before-activation privacy boundary testable without
// a privileged database connection.
type AdminKeyStore interface {
	List(ctx context.Context, tenantID string) ([]Key, error)
	Create(ctx context.Context, tenantID string, in CreateInput) (*Key, error)
	Get(ctx context.Context, tenantID, id string) (*Key, error)
	Activate(ctx context.Context, tenantID, id string) (*Key, error)
	MarkDeleted(ctx context.Context, tenantID, id string) error
	RecordHealthCheck(ctx context.Context, tenantID, id string, ok bool, errMsg string) error
}

// KeyRetirementChecker proves that no registered production ciphertext still
// embeds a key before the key row can be retired.
type KeyRetirementChecker interface {
	CountKeyReferences(ctx context.Context, tenantID, keyID string) (int64, error)
}

// MountRoutes registers BYOK admin endpoints. All routes require
// ScopeAdmin — BYOK lifecycle is an org-owner-only operation.
//
//	GET    /api/v1/byok/keys              — list keys for tenant
//	POST   /api/v1/byok/keys              — register a new (inactive) key
//	GET    /api/v1/byok/keys/{id}          — get a single key
//	POST   /api/v1/byok/keys/{id}/activate — flip to active (atomic rotation)
//	POST   /api/v1/byok/keys/{id}/health   — round-trip a probe via the provider
//	DELETE /api/v1/byok/keys/{id}          — soft-delete (must not be active)
//	GET    /api/v1/byok/providers          — list available providers
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/byok/keys", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/byok/keys", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/byok/keys/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/byok/keys/{id}/activate", d.Activate)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Post("/api/v1/byok/keys/{id}/health", d.Health)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Delete("/api/v1/byok/keys/{id}", d.Delete)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/byok/providers", d.Providers)
}

// CreateInputHTTP is the public payload for POST /api/v1/byok/keys.
type CreateInputHTTP struct {
	Provider    string `json:"provider"`
	KeyRef      string `json:"key_ref"`
	Description string `json:"description"`
}

// List GET /api/v1/byok/keys
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	keys, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

// Create POST /api/v1/byok/keys
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in CreateInputHTTP
	if err := httpbody.DecodeJSON(w, r, byokJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Provider = strings.ToLower(strings.TrimSpace(in.Provider))
	in.KeyRef = strings.TrimSpace(in.KeyRef)
	if !pwkms.IsValidProvider(in.Provider) {
		httperror.Write(w, http.StatusBadRequest, "invalid_provider",
			"provider is not recognized")
		return
	}
	if d.Registry == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "byok_unavailable", "BYOK providers are not configured")
		return
	}
	if _, err := d.Registry.Get(in.Provider); err != nil {
		httperror.Write(w, http.StatusBadRequest, "provider_unavailable", "provider is not available in this deployment")
		return
	}
	if in.KeyRef == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_key_ref",
			"key_ref is required (KMS ARN / GCP resource name / Vault key / Tink keyset id)")
		return
	}
	creator := ""
	if u, ok := middleware.UserFromContext(r.Context()); ok && u != nil {
		creator = u.ID
	}
	k, err := d.Repo.Create(r.Context(), t.ID, CreateInput{
		Provider:        in.Provider,
		KeyRef:          in.KeyRef,
		Description:     in.Description,
		CreatedByUserID: creator,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, k)
}

// Get GET /api/v1/byok/keys/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	k, err := d.Repo.Get(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "key not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, k)
}

// Activate POST /api/v1/byok/keys/{id}/activate
func (d *Deps) Activate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	k, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "key not found or deleted")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if d.Registry == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "byok_unavailable", "BYOK providers are not configured")
		return
	}
	provider, err := d.Registry.Get(k.Provider)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "provider_unconfigured", "key provider is not available in this deployment")
		return
	}
	if err := provider.HealthCheck(r.Context(), k.KeyRef); err != nil {
		_ = d.Repo.RecordHealthCheck(r.Context(), t.ID, id, false, err.Error())
		httperror.Write(w, http.StatusBadGateway, "health_failed", "key health check failed; activation was not performed")
		return
	}
	if err := d.Repo.RecordHealthCheck(r.Context(), t.ID, id, true, ""); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	k, err = d.Repo.Activate(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "key not found or deleted")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, k)
}

// Health POST /api/v1/byok/keys/{id}/health
//
// Round-trips a probe DEK through the provider to confirm:
//   - Network reachability to the KMS endpoint
//   - Caller identity / IAM has both Encrypt + Decrypt permission
//   - The key_ref resolves to a usable KEK
//
// Records the outcome on the row so the admin UI can render a
// "last verified ✓" badge.
func (d *Deps) Health(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	k, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "key not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if d.Registry == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "byok_unavailable", "BYOK providers are not configured")
		return
	}
	provider, err := d.Registry.Get(k.Provider)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "provider_unconfigured", "request configuration is invalid")
		return
	}

	healthErr := provider.HealthCheck(r.Context(), k.KeyRef)
	ok2 := healthErr == nil
	internalMessage := ""
	if healthErr != nil {
		internalMessage = healthErr.Error()
	}
	if recErr := d.Repo.RecordHealthCheck(r.Context(), t.ID, id, ok2, internalMessage); recErr != nil {
		// Don't fail the request just because we couldn't persist the
		// result — the operator still wants to know the live answer.
		_ = recErr
	}

	status := http.StatusOK
	code := "ok"
	if !ok2 {
		status = http.StatusBadGateway
		code = "health_failed"
	}
	publicMessage := ""
	if !ok2 {
		publicMessage = httperror.MessageForStatus(status)
	}
	writeJSON(w, status, map[string]any{
		"key_id":   k.ID,
		"provider": k.Provider,
		"ok":       ok2,
		"code":     code,
		"error":    publicMessage,
	})
}

// Delete DELETE /api/v1/byok/keys/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	if d.Retirement == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "retirement_unavailable", "key retirement verification is not configured")
		return
	}
	references, err := d.Retirement.CountKeyReferences(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	if references > 0 {
		httperror.Write(w, http.StatusConflict, "key_still_referenced", "key cannot be retired while encrypted data still references it")
		return
	}
	if err := d.Repo.MarkDeleted(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "key not found")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "cannot_delete", httperror.MessageForStatus(http.StatusBadRequest))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Providers GET /api/v1/byok/providers
func (d *Deps) Providers(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	if d.Registry != nil {
		names = d.Registry.Names()
	}
	sort.Strings(names)
	writeJSON(w, http.StatusOK, map[string]any{
		"providers": names,
		"supported": names,
	})
}

// --- small helpers ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// Compile-time checks for production wiring.
var _ AdminKeyStore = (*Repo)(nil)
var _ KeyRetirementChecker = (*Reencryptor)(nil)

// Compile-time silence for unused symbols when handlers are mounted
// from elsewhere.
var _ = context.Background
