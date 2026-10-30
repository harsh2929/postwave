// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps bundles dependencies for handler wiring.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
	// Cache is optional. When present, metadata reductions, rotation, and
	// revocation invalidate the old hash on this process immediately. Other
	// replicas remain bounded by their cache TTL until distributed invalidation
	// is implemented.
	Cache interface{ Invalidate(string) }
}

const apiKeyJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// List GET /api/v1/api-keys
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Create POST /api/v1/api-keys. Returns plaintext exactly once.
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, apiKeyJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_label", "label required"))
		return
	}
	if len(in.Scopes) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("no_scopes", "at least one scope required"))
		return
	}
	for _, s := range in.Scopes {
		if !IsValidScope(string(s)) {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_scope", "unknown scope "+string(s)))
			return
		}
	}
	plaintext, _, err := NewKey()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// Allowlist validation: empty list = unrestricted (no-op). Non-empty
	// values are CIDR-validated by net.ParseCIDR; rejecting bad entries
	// here gives a useful 400 instead of letting Postgres surface
	// invalid_text_representation as a 500.
	for _, entry := range in.AllowedIPs {
		if entry == "" {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_allowlist",
				"empty entry in allowed_ips"))
			return
		}
		if _, _, err := parseAllowlistEntry(entry); err != nil {
			writeJSON(w, http.StatusBadRequest, errEnv("invalid_allowlist",
				"allowed_ips entry must be a CIDR (e.g. 203.0.113.0/24) or a bare address"))
			return
		}
	}
	principalUserID := ""
	if user, ok := middleware.UserFromContext(r.Context()); ok && user != nil {
		principalUserID = user.ID
	}
	k, err := d.Repo.CreateWithOptions(r.Context(), t.ID, in.Label, plaintext, in.Scopes, CreateOptions{
		AllowedIPs:  in.AllowedIPs,
		SandboxOnly: in.SandboxOnly,
		ExpiresAt:   in.ExpiresAt,
		UserID:      principalUserID,
	})
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, CreateResponse{Key: *k, Plaintext: plaintext})
}

// UpdateInput is the PATCH body — metadata-only (label + scopes); the secret
// is never touched (SETC-040).
type UpdateInput struct {
	Label  string  `json:"label"`
	Scopes []Scope `json:"scopes"`
}

// Update PATCH /api/v1/api-keys/{id} — edit a key's label + scopes without
// rotating it (SETC-040).
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, apiKeyJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	if in.Label == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_label", "label required"))
		return
	}
	if len(in.Scopes) == 0 {
		writeJSON(w, http.StatusBadRequest, errEnv("no_scopes", "at least one scope required"))
		return
	}
	for _, s := range in.Scopes {
		if !IsValidScope(string(s)) {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_scope", "unknown scope "+string(s)))
			return
		}
	}
	oldHash, _ := d.Repo.LiveHashByID(r.Context(), t.ID, id)
	k, err := d.Repo.Update(r.Context(), t.ID, id, in.Label, in.Scopes)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "no such api key"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.invalidateLocal(oldHash)
	writeJSON(w, http.StatusOK, k)
}

// Get GET /api/v1/api-keys/{id} — single-key view (no plaintext).
//
// Returns the same shape as List's items so admin UIs can render the
// detail page without a separate response type. Uses the prefix +
// last_used_at columns to answer "is this key still in use?" without
// exposing the plaintext or hash.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	k, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, k)
}

// Rotate POST /api/v1/api-keys/{id}/rotate — atomic two-row rotation.
//
// Returns the NEW key + plaintext (echoed exactly once) and the id of
// the just-revoked source key. The old plaintext is invalid in the database
// when this returns 201 and is evicted from the issuing process's cache.
// Other replicas can continue accepting a previously cached credential until
// their bounded auth-cache TTL expires. Tenants
// integrating this must update their secret manager BEFORE calling
// rotate, then call rotate, then deploy.
//
// Why no grace period: a grace would mean keeping the old hash valid
// for a window, which preserves the very compromise that motivated
// the rotation. The right "smooth transition" pattern is two parallel
// keys (Create a new one, deploy, then Delete the old one) — which
// the existing Create/Delete pair already supports.
func (d *Deps) Rotate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	oldHash, _ := d.Repo.LiveHashByID(r.Context(), t.ID, id)
	plaintext, _, err := NewKey()
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	newKey, oldID, err := d.Repo.Rotate(r.Context(), t.ID, id, plaintext)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found",
				"key not found, already revoked, or belongs to a different tenant"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.invalidateLocal(oldHash)
	writeJSON(w, http.StatusCreated, RotateResponse{
		Key:       *newKey,
		Plaintext: plaintext,
		RevokedID: oldID,
	})
}

// Delete DELETE /api/v1/api-keys/{id} — soft delete via revoked_at.
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	oldHash, _ := d.Repo.LiveHashByID(r.Context(), t.ID, id)
	if err := d.Repo.Revoke(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	d.invalidateLocal(oldHash)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) invalidateLocal(hash string) {
	if d != nil && d.Cache != nil && hash != "" {
		d.Cache.Invalidate(hash)
	}
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
