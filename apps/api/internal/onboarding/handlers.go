// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP surface for the sample-data seeder. Mounted on:
//
//	GET    /api/v1/onboarding/sample-data
//	POST   /api/v1/onboarding/sample-data
//	DELETE /api/v1/onboarding/sample-data
//
// Both routes resolve tenant from middleware context — never from the
// request body — so cross-tenant leakage is impossible at the handler
// layer too. The Seeder's writes additionally enforce RLS via the
// tenant-bound tx (db.WithTenant).

package onboarding

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Deps wires the seeder behind the http.Handler.
type Deps struct {
	Seeder *Seeder
	Logger *slog.Logger
}

// Seed is the POST handler.
func (d *Deps) Seed(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d == nil || d.Seeder == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("seeder_unavailable", "sample-data seeder not configured"))
		return
	}
	res, err := d.Seeder.Seed(r.Context(), t.ID)
	if err != nil {
		// Return 500 with the partial counts attached so the UI can
		// suggest a "Remove sample data" follow-up — no fake-success.
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{
				"code":    "seed_failed",
				"message": "an internal error occurred",
			},
			"partial_counts": res.Counts,
		})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// Status is the GET handler (desktop-audit gap A29): reports whether
// the tenant currently has sample data, from the same tenants.metadata
// marker Seed sets and Remove clears. Read-only — replaces the
// desktop's per-device localStorage flag with a workspace truth.
//
//	GET /api/v1/onboarding/sample-data
//	→ {"seeded": bool, "seeded_at"?: timestamptz, "counts"?: {...}}
func (d *Deps) Status(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d == nil || d.Seeder == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("seeder_unavailable", "sample-data seeder not configured"))
		return
	}
	res, err := d.Seeder.Status(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// Remove is the DELETE handler.
func (d *Deps) Remove(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if d == nil || d.Seeder == nil {
		writeJSON(w, http.StatusServiceUnavailable, errEnv("seeder_unavailable", "sample-data seeder not configured"))
		return
	}
	res, err := d.Seeder.Remove(r.Context(), t.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
