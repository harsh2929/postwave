// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — admin endpoints for previewing Klaviyo translations.
//
//	POST /api/v1/klaviyo/translate/segment   body: raw Klaviyo segment JSON
//	POST /api/v1/klaviyo/translate/flow      body: raw Klaviyo flow JSON
//
// Both endpoints return the translated artifact + warnings. They do
// NOT persist — persistence is done by the importer worker once an
// admin reviews the preview.

package klaviyo_migrate

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const maxPayloadBytes = 4 << 20

// Deps bundles collaborators for the Klaviyo translation handlers. Logger
// may be nil — httperror.WriteInternal handles that gracefully but the
// caller loses request_id+tenant_id+err enrichment on internal failures.
type Deps struct {
	Logger *slog.Logger
}

// MountRoutes mounts the translation endpoints.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil {
		d = &Deps{}
	}
	r.Post("/api/v1/klaviyo/translate/segment", d.translateSegmentHandler)
	r.Post("/api/v1/klaviyo/translate/flow", d.translateFlowHandler)
}

func (d *Deps) translateSegmentHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
		return
	}
	body, err := httpbody.ReadJSONAtMost(r, maxPayloadBytes, httpbody.Options{})
	if err != nil {
		if status := httpbody.StatusCode(err); status != http.StatusBadRequest {
			httpbody.WriteError(w, err)
			return
		}
		// Body read errors can include MaxBytesError text (safe) or
		// transport-level text (unsafe). Treat as infrastructure and
		// avoid echoing err.Error().
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out, err := TranslateSegment(body)
	if err != nil {
		// TranslateSegment errors come from our own translator and
		// json.Unmarshal on caller-supplied JSON; the text is
		// operator-safe (no DB internals) so surface verbatim under
		// the safe-echo allowlist via WriteValidation.
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) translateFlowHandler(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "no tenant in context")
		return
	}
	body, err := httpbody.ReadJSONAtMost(r, maxPayloadBytes, httpbody.Options{})
	if err != nil {
		if status := httpbody.StatusCode(err); status != http.StatusBadRequest {
			httpbody.WriteError(w, err)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	out, err := TranslateFlow(body)
	if err != nil {
		httperror.WriteValidation(w, "validation_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
