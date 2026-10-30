// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — admin-scoped HTTP surface for the partition rotator.
//
// Endpoint:
//
//	POST /api/v1/admin/partition-rotator/run
//	    Triggers one immediate rotation sweep across every row in
//	    partition_rotator_config. Returns 200 with a summary blob so
//	    operators can verify "did the partition I expected to be
//	    detached actually go". Mirrors retention.Run + audit trim.
//
// Auth: ScopeAdmin. The rotator touches global DDL — DETACH /
// DROP TABLE — so this is unambiguously a privileged surface. The
// scope wrapper is intentionally NOT imported here — handlers.go is
// kept dependency-light so the rotator package can be re-used by
// services/* (which don't ship the apikeys package). Callers in
// main.go are expected to wrap MountRoutes' returned middleware
// chain with apikeys.RequireScope(apikeys.ScopeAdmin) at mount time.

package partition_rotator

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// HandlerDeps wires the admin endpoint. Nil-safe: a nil Worker simply
// doesn't mount the route.
type HandlerDeps struct {
	Worker *Worker
}

// MountRoutes registers the admin endpoint on r. The caller is
// responsible for layering the admin-scope guard onto r BEFORE
// calling MountRoutes (e.g.
//
//	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).
//	    Route("/", func(sr chi.Router) { rotatorDeps.MountRoutes(sr) })
//
// — matches the wiring of other privileged surfaces in main.go).
func (d *HandlerDeps) MountRoutes(r chi.Router) {
	if d == nil || d.Worker == nil {
		return
	}
	r.Post("/api/v1/admin/partition-rotator/run", d.Run)
}

// Run handles POST /api/v1/admin/partition-rotator/run.
//
// Response shape on success:
//
//	{ "ok": true }
//
// We deliberately keep the response thin: counters are the canonical
// observability surface and Grafana is the right place to read them.
// Returning a full per-table diff here would tempt callers to build
// dashboards off the response body instead of the metric.
func (d *HandlerDeps) Run(w http.ResponseWriter, r *http.Request) {
	if err := d.Worker.RunOnce(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]string{"code": "rotate_failed", "message": "an internal error occurred"},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
