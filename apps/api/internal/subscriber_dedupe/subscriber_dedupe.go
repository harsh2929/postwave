// SPDX-License-Identifier: AGPL-3.0-only
//
// Package subscriber_dedupe owns exhaustive, reviewable duplicate discovery.
// Deterministic identity keys are maintained transactionally in a
// privacy-minimised sidecar; each operator scan materializes one immutable,
// cursor-paged manifest. The package intentionally excludes sampled
// edit-distance guesses: an incomplete heuristic can never support a truthful
// "no duplicates" state or a destructive merge decision.

package subscriber_dedupe

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
)

// Deps wires the tenant-scoped HTTP surface.
type Deps struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers the complete scan lifecycle. The legacy GET route now
// creates the same complete manifest and returns its first cursor page.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Pool == nil {
		return
	}
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(read).Get("/api/v1/subscribers/duplicates", d.List)
	r.With(read).Post("/api/v1/subscribers/duplicate-scans", d.StartScan)
	r.With(read).Get("/api/v1/subscribers/duplicate-scans/{scanID}", d.GetScan)
	r.With(read).Get("/api/v1/subscribers/duplicate-scans/{scanID}/pairs", d.ListScanPairs)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": message},
	})
}
