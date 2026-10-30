// SPDX-License-Identifier: AGPL-3.0-only
//
// profile_links.go — HTTP surface for binding custom object records to a
// subscriber profile (SUB-011). The profile_object_links table + RLS
// already exist (migration 0201); these are its first endpoints.
//
//	GET    /api/v1/subscribers/{id}/custom-objects            list links for a subscriber
//	POST   /api/v1/subscribers/{id}/custom-objects            link a record
//	PATCH  /api/v1/subscribers/{id}/custom-objects/{link_id}  update relationship/metadata
//	DELETE /api/v1/subscribers/{id}/custom-objects/{link_id}  unlink

package customobjects

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// MountProfileLinkRoutes mounts the per-subscriber custom-object link
// routes on r. Wired separately from MountRoutes so the subscriber-
// drilldown region in main.go can opt in independently.
func (d *Deps) MountProfileLinkRoutes(r chi.Router) {
	r.Get("/api/v1/subscribers/{id}/custom-objects", d.ListProfileLinks)
	r.Post("/api/v1/subscribers/{id}/custom-objects", d.CreateProfileLink)
	r.Patch("/api/v1/subscribers/{id}/custom-objects/{link_id}", d.UpdateProfileLink)
	r.Delete("/api/v1/subscribers/{id}/custom-objects/{link_id}", d.DeleteProfileLink)
}

func (d *Deps) ListProfileLinks(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	subID := chi.URLParam(r, "id")
	out, err := d.Store.ListProfileLinks(r.Context(), t.ID, subID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) CreateProfileLink(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	subID := chi.URLParam(r, "id")
	var p CreateProfileLinkParams
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	if p.ObjectRecordID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_field", "objectRecordId required")
		return
	}
	out, err := d.Store.CreateProfileLink(r.Context(), t.ID, subID, p)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "record not found")
			return
		}
		if errors.Is(err, ErrConflict) {
			httperror.Write(w, http.StatusConflict, "link_exists", "this record is already linked to the subscriber with that relationship")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (d *Deps) UpdateProfileLink(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	linkID := chi.URLParam(r, "link_id")
	var p UpdateProfileLinkParams
	if err := httpbody.DecodeJSON(w, r, maxRequestBytes, &p); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	out, err := d.Store.UpdateProfileLink(r.Context(), t.ID, linkID, p)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "link not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteProfileLink(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	linkID := chi.URLParam(r, "link_id")
	if err := d.Store.DeleteProfileLink(r.Context(), t.ID, linkID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "link not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
