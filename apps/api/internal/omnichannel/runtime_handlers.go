// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/runtimecapability"
)

// MountRuntimeRoutes registers the send-execution spine endpoints on top of the
// control-plane routes. Kept separate so the runtime can be mounted (or not)
// independently of the catalog/CRUD surface.
func (d *Deps) MountRuntimeRoutes(r chi.Router) {
	read := apikeys.RequireScope(apikeys.ScopeReadCampaigns)
	write := apikeys.RequireScope(apikeys.ScopeWriteCampaigns)
	r.With(write).Post("/api/v1/omnichannel/campaigns/{id}/materialize", d.Materialize)
	r.With(write).Post("/api/v1/omnichannel/campaigns/{id}/evaluate", d.Evaluate)
	r.With(write).Post("/api/v1/omnichannel/campaigns/{id}/dispatch", d.Dispatch)
	r.With(read).Get("/api/v1/omnichannel/campaigns/{id}/report", d.Report)
}

func (d *Deps) sender() ChannelSender {
	if d.Sender != nil {
		return d.Sender
	}
	return DefaultSender
}

// Materialize is retained as an authenticated compatibility boundary while
// execution is contained. It must not touch the repository in this state.
func (d *Deps) Materialize(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runtimecapability.WriteUnavailable(w, omnichannelRuntime)
}

// Evaluate is fail-closed until materialization and dispatch have a certified,
// durable orchestration contract.
func (d *Deps) Evaluate(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runtimecapability.WriteUnavailable(w, omnichannelRuntime)
}

// Dispatch is fail-closed. In particular it never interprets a queued/no-op
// adapter outcome as a completed send.
func (d *Deps) Dispatch(w http.ResponseWriter, r *http.Request) {
	if _, ok := tenantID(r); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	runtimecapability.WriteUnavailable(w, omnichannelRuntime)
}

// Report returns path-level send analytics over channel_send_history.
func (d *Deps) Report(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.repo().Report(r.Context(), tenantID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
