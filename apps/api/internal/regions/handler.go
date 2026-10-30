// SPDX-License-Identifier: AGPL-3.0-only

package regions

import (
	"encoding/json"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Handlers exposes admin-facing endpoints for the data residency
// surface. The only endpoint today is GET /api/v1/tenant/region —
// dashboard pulls this to render the read-only settings card. Mutation
// is intentionally absent: changing data_region requires the tenant
// migration job (see migration 0055 column comment).
type Handlers struct {
	Pool *db.Pool
}

// regionResponse is the JSON shape returned by GET /api/v1/tenant/region.
// `matches` lets the dashboard render a green check or a warning
// without re-implementing the comparison.
type regionResponse struct {
	DataRegion       Region `json:"data_region"`
	DeploymentRegion Region `json:"deployment_region"`
	Matches          bool   `json:"matches"`
}

// Get handles GET /api/v1/tenant/region. Reads tenants.data_region via
// a tenant-scoped tx (RLS will refuse if the tenant_id binding wasn't
// set, which doubles as a smoke test that the middleware stack is
// wired right).
func (h *Handlers) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeRegionErr(w, http.StatusUnauthorized, "no_tenant", "missing tenant context", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		writeRegionErr(w, http.StatusInternalServerError, "tx_failed", "an internal error occurred", "")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	var dataRegion string
	if err := tx.QueryRow(r.Context(),
		`SELECT data_region FROM tenants WHERE id = $1::uuid`, t.ID,
	).Scan(&dataRegion); err != nil {
		writeRegionErr(w, http.StatusInternalServerError, "query_failed", "an internal error occurred", "")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeRegionErr(w, http.StatusInternalServerError, "commit_failed", "an internal error occurred", "")
		return
	}

	here := Current()
	resp := regionResponse{
		DataRegion:       Region(dataRegion),
		DeploymentRegion: here,
		Matches:          Region(dataRegion) == here,
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}
