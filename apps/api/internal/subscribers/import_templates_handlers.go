// SPDX-License-Identifier: AGPL-3.0-only
//
// import_templates_handlers.go — SUB-109 CRUD HTTP surface for reusable
// import-mapping templates.
//
//   POST   /api/v1/subscriber-import-templates       save (upsert by name)
//   GET    /api/v1/subscriber-import-templates       list (newest-first)
//   DELETE /api/v1/subscriber-import-templates/{id}  remove one
//
// Read uses ScopeReadSubscribers; the mutating verbs use
// ScopeWriteSubscribers. The persistence + tenant clamp live in
// import_templates_repo.go.

package subscribers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountImportTemplateRoutes registers the SUB-109 import-mapping template
// CRUD endpoints.
func MountImportTemplateRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscriber-import-templates", d.SaveImportTemplate)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscriber-import-templates", d.ListImportTemplates)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/subscriber-import-templates/{id}", d.DeleteImportTemplate)
}

// SaveImportTemplate POST /api/v1/subscriber-import-templates.
//
// Body: { "name": "...", "mapping": {...}, "source_hint": "..." }. Saving
// under an existing name overwrites that template (upsert), so the desktop
// "Save as template" affordance is safe to re-run.
func (d *Deps) SaveImportTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in SaveImportTemplateInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Name = normalizeTemplateName(in.Name)
	if in.Name == "" {
		httperror.WriteValidation(w, "missing_name", "name is required")
		return
	}
	tmpl, err := d.Repo.SaveImportTemplate(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, tmpl)
}

// ListImportTemplates GET /api/v1/subscriber-import-templates.
func (d *Deps) ListImportTemplates(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	items, err := d.Repo.ListImportTemplates(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// DeleteImportTemplate DELETE /api/v1/subscriber-import-templates/{id}.
func (d *Deps) DeleteImportTemplate(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	id := chi.URLParam(r, "id")
	if id == "" {
		httperror.WriteValidation(w, "missing_id", "template id is required")
		return
	}
	if err := d.Repo.DeleteImportTemplate(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", "template not found"))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
