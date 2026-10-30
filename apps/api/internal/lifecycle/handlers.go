// SPDX-License-Identifier: AGPL-3.0-only
package lifecycle

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/events"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const lifecycleMaxBody int64 = 8 << 10 // 8 KiB

// Deps wires repo + handlers.
type Deps struct {
	Repo *Repo
	Bus  *events.Bus
	// Logger is used by httperror.WriteInternal to record server-side
	// failure detail without leaking err.Error() to API callers.
	// Optional; nil is tolerated by httperror.WriteInternal.
	Logger *slog.Logger
}

// MountRoutes registers the lifecycle API:
//
//	GET    /api/v1/subscribers/{id}/lifecycle
//	PUT    /api/v1/subscribers/{id}/lifecycle
//	GET    /api/v1/lifecycle/distribution
//	GET    /api/v1/lifecycle/stages
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/lifecycle", d.Get)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/subscribers/{id}/lifecycle", d.Upsert)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/lifecycle/distribution", d.Distribution)
	r.Get("/api/v1/lifecycle/stages", d.Stages)
}

// Stages returns the static catalog. No tenant scope required (it's a
// constant) — useful for populating frontend dropdowns.
func (d *Deps) Stages(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"stages": AllStages})
}

// Get returns the lifecycle row for a subscriber.
func (d *Deps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	sid := chi.URLParam(r, "id")
	out, err := d.Repo.Get(r.Context(), t.ID, sid)
	if err != nil {
		d.writeErr(w, r, err, "get_failed")
		return
	}
	w.Header().Set("ETag", out.SubscriberVersion)
	writeJSON(w, http.StatusOK, out)
}

// Upsert writes the lifecycle row for a subscriber.
func (d *Deps) Upsert(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	sid := chi.URLParam(r, "id")
	ifMatch, present, wildcard := httpcache.ParseIfMatch(r)
	rawIfMatch := strings.TrimSpace(r.Header.Get("If-Match"))
	if !present || wildcard || strings.HasPrefix(rawIfMatch, "W/") || strings.Contains(rawIfMatch, ",") {
		httpcache.WritePreconditionRequired(w)
		return
	}
	var in UpsertInput
	if err := httpbody.DecodeJSONWith(w, r, lifecycleMaxBody, &in, httpbody.Options{}); err != nil {
		// DecodeJSONWith's error catalog is normalized and operator-authored;
		// preserve the correct 400/413/415 response instead of misclassifying a
		// malformed client body as a server failure.
		httpbody.WriteError(w, err)
		return
	}
	out, err := d.Repo.Upsert(r.Context(), t.ID, sid, in, ifMatch, middleware.AuditMetaFromRequest(r))
	if err != nil {
		d.writeErr(w, r, err, "upsert_failed")
		return
	}
	if out.Transitioned {
		at := time.Now().UTC()
		if out.TransitionedAt != nil {
			at = *out.TransitionedAt
		}
		if d.Bus != nil {
			payload := map[string]any{
				"subscriber_id": out.SubscriberID,
				"stage":         out.Stage,
				"score":         out.Score,
				"at":            at,
			}
			if out.PreviousStage != nil {
				payload["previous_stage"] = *out.PreviousStage
			}
			d.Bus.Publish(events.Event{
				Topic:    "subscriber.lifecycle_stage_changed",
				TenantID: t.ID,
				Payload:  payload,
			})
		}
	}
	w.Header().Set("ETag", out.SubscriberVersion)
	writeJSON(w, http.StatusOK, out)
}

// Distribution returns the per-stage histogram.
func (d *Deps) Distribution(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant not found in request context")
		return
	}
	rows, err := d.Repo.Distribution(r.Context(), t.ID)
	if err != nil {
		d.writeErr(w, r, err, "distribution_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows})
}

func (d *Deps) writeErr(w http.ResponseWriter, r *http.Request, err error, _ string) {
	switch {
	case errors.Is(err, ErrNotFound):
		httperror.Write(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, ErrInvalidInput):
		// ErrInvalidInput is the package's own typed sentinel whose
		// message text is operator-authored and safe to echo to callers.
		httperror.WriteValidation(w, "invalid_input", err.Error())
	case errors.Is(err, ErrPreconditionFailed):
		httpcache.WritePreconditionFailed(w)
	case errors.Is(err, ErrAutomationOutboxRequired):
		if d.Logger != nil {
			d.Logger.ErrorContext(r.Context(), "lifecycle durable automation intent unavailable", "err", err)
		}
		w.Header().Set("Retry-After", "1")
		httperror.Write(w, http.StatusServiceUnavailable, "lifecycle_automation_unavailable", "durable lifecycle automation delivery is unavailable; no change was committed")
	default:
		// Unknown/infrastructure error — never echo err.Error() to the
		// client. Logs server-side with tenant_id+request_id+err.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
