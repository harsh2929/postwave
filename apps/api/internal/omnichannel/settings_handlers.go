// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// MountSettingsRoutes registers the sender-profile + smart-sending management
// surface that backs the dispatch readiness + Smart-Sending gates.
func (d *Deps) MountSettingsRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(read).Get("/api/v1/omnichannel/sender-profiles", d.ListSenderProfiles)
	r.With(write).Put("/api/v1/omnichannel/sender-profiles", d.UpsertSenderProfile)
	r.With(write).Delete("/api/v1/omnichannel/sender-profiles/{id}", d.DeleteSenderProfile)
	r.With(read).Get("/api/v1/omnichannel/smart-sending", d.ListSmartSendingPolicies)
	r.With(write).Put("/api/v1/omnichannel/smart-sending", d.UpsertSmartSendingPolicy)
	r.With(write).Delete("/api/v1/omnichannel/smart-sending/{id}", d.DeleteSmartSendingPolicy)
	r.With(read).Get("/api/v1/omnichannel/templates", d.ListTemplates)
	r.With(write).Put("/api/v1/omnichannel/templates", d.UpsertTemplate)
	r.With(write).Delete("/api/v1/omnichannel/templates/{id}", d.DeleteTemplate)
}

func (d *Deps) ListTemplates(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().ListTemplates(r.Context(), tenantID, r.URL.Query().Get("channel"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) UpsertTemplate(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in MessageTemplate
	if err := httpbody.DecodeJSON(w, r, omnichannelJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.repo().UpsertTemplate(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteTemplate(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.repo().DeleteTemplate(r.Context(), tenantID, chi.URLParam(r, "id")); err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (d *Deps) ListSenderProfiles(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().ListSenderProfiles(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) UpsertSenderProfile(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in SenderProfile
	if err := httpbody.DecodeJSON(w, r, omnichannelJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.repo().UpsertSenderProfile(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteSenderProfile(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.repo().DeleteSenderProfile(r.Context(), tenantID, chi.URLParam(r, "id")); err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

func (d *Deps) ListSmartSendingPolicies(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().ListSmartSendingPolicies(r.Context(), tenantID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (d *Deps) UpsertSmartSendingPolicy(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in SmartSendingPolicy
	if err := httpbody.DecodeJSON(w, r, omnichannelJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.repo().UpsertSmartSendingPolicy(r.Context(), tenantID, in)
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteSmartSendingPolicy(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if err := d.repo().DeleteSmartSendingPolicy(r.Context(), tenantID, chi.URLParam(r, "id")); err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}
