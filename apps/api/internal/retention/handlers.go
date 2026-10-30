// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — admin-scoped HTTP surface for the retention sweeper.
//
// POST /api/v1/retention/run
//   Triggers one immediate sweep cycle for the calling tenant and
//   returns the per-class rows-purged count. Mirrors the
//   sunset/run pattern so operators can verify "did the policy
//   change actually evict rows?" without waiting for the next
//   tick of the background goroutine.
//
// Scope: admin. Anything that walks every per-tenant retention
// dimension and issues hard deletes is unambiguously a privileged
// operation.

package retention

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// HandlerDeps wires the admin endpoint.
type HandlerDeps struct {
	Sweeper *Sweeper
}

// MountRoutes registers POST /api/v1/retention/run on r. Nil-safe.
func (d *HandlerDeps) MountRoutes(r chi.Router) {
	if d == nil || d.Sweeper == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
		Post("/api/v1/retention/run", d.Run)
}

// Run handles POST /api/v1/retention/run.
//
// Response shape:
//
//	{ "tenant_id": "...",
//	  "purged": { "unsubscribed_subscribers": 4, "inbound_email_bodies": 0, ... } }
//
// Errors that occur during a particular class sweep are logged
// inside SweepOnceForTenant and the corresponding class is omitted
// from "purged" (so the caller knows it didn't succeed) — the
// top-level response is still 200 because partial progress is
// better than rolling the whole thing back.
func (d *HandlerDeps) Run(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]string{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	purged, err := d.Sweeper.SweepOnceForTenant(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "sweep_failed", "message": "an internal error occurred"},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tenant_id": t.ID,
		"purged":    purged,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
