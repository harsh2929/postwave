// SPDX-License-Identifier: AGPL-3.0-only
package accounts

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// accountJSONMaxBodyBytes caps an account create/update body. The metadata
// blob is meant for a handful of org traits, not a document store.
const accountJSONMaxBodyBytes int64 = 32 << 10 // 32 KiB

// Deps bundles the repo for handler wiring.
type Deps struct {
	Repo *Repo
	// Logger is used by httperror.WriteInternal so 5xx responses log the
	// underlying error server-side while returning a generic envelope.
	// nil-safe at the call site.
	Logger *slog.Logger
}

// MountRoutes registers the accounts CRUD endpoints. Reads are
// read:subscribers-scoped, writes are write:subscribers-scoped — accounts
// are part of the subscriber/CRM surface, so they reuse those scopes
// rather than minting a new one.
func MountRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/accounts", d.List)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).Get("/api/v1/accounts/{id}", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Post("/api/v1/accounts", d.Create)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Patch("/api/v1/accounts/{id}", d.Update)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).Delete("/api/v1/accounts/{id}", d.Delete)
}

// List GET /api/v1/accounts
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.List(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Get GET /api/v1/accounts/{id}
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	a, err := d.Repo.Get(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "account not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// Create POST /api/v1/accounts
func (d *Deps) Create(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateInput
	if err := httpbody.DecodeJSON(w, r, accountJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Industry = strings.TrimSpace(in.Industry)
	in.Country = strings.TrimSpace(in.Country)
	if err := validateName(in.Name); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_name", err.Error())
		return
	}
	if err := validateIndustry(in.Industry); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_industry", err.Error())
		return
	}
	if err := validateCountry(in.Country); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_country", err.Error())
		return
	}
	a, err := d.Repo.Create(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, a)
}

// Update PATCH /api/v1/accounts/{id}
func (d *Deps) Update(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	var in UpdateInput
	if err := httpbody.DecodeJSON(w, r, accountJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if err := validateName(name); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_name", err.Error())
			return
		}
		in.Name = &name
	}
	if in.Industry != nil {
		industry := strings.TrimSpace(*in.Industry)
		if err := validateIndustry(industry); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_industry", err.Error())
			return
		}
		in.Industry = &industry
	}
	if in.Country != nil {
		country := strings.TrimSpace(*in.Country)
		if err := validateCountry(country); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_country", err.Error())
			return
		}
		in.Country = &country
	}
	a, err := d.Repo.Update(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "account not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// Delete DELETE /api/v1/accounts/{id}
func (d *Deps) Delete(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("missing_id", "id required"))
		return
	}
	if err := d.Repo.Delete(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "account not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// validateName enforces a non-empty, length-capped account name.
func validateName(s string) error {
	if s == "" {
		return errors.New("name required")
	}
	if len(s) > MaxNameLength {
		return fmt.Errorf("name must be %d characters or fewer", MaxNameLength)
	}
	return nil
}

func validateIndustry(s string) error {
	if len(s) > MaxIndustryLength {
		return fmt.Errorf("industry must be %d characters or fewer", MaxIndustryLength)
	}
	return nil
}

func validateCountry(s string) error {
	if len(s) > MaxCountryLength {
		return fmt.Errorf("country must be %d characters or fewer", MaxCountryLength)
	}
	return nil
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
