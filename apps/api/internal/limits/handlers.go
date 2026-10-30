// SPDX-License-Identifier: AGPL-3.0-only
//
// handlers.go — read-side of plan limits. Returns per-resource
// current/limit/percent so the dashboard can render usage bars +
// the billing portal can show "you're at 87% of monthly sends".

package limits

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Handlers wires the GET endpoints.
type Handlers struct {
	Pool   *db.Pool
	Logger *slog.Logger
}

// MountRoutes registers GET /api/v1/limits/usage. Read-reports scope
// so any operator viewing the dashboard can see usage; only admin
// can change tier (handled elsewhere via billing).
func (h *Handlers) MountRoutes(r chi.Router) {
	if h == nil || h.Pool == nil {
		return
	}
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/limits/usage", h.Usage)
}

// UsageRow is one resource line in the response.
type UsageRow struct {
	Resource string  `json:"resource"`
	Current  int     `json:"current"`
	Limit    int     `json:"limit"`
	Percent  float64 `json:"percent"` // 0..100; 100+ when over cap (still report)
	Exceeded bool    `json:"exceeded"`
}

// UsageResponse is the wire shape.
type UsageResponse struct {
	Tier string     `json:"tier"`
	Rows []UsageRow `json:"rows"`
}

// Usage GET /api/v1/limits/usage.
func (h *Handlers) Usage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	tx, err := db.WithTenant(r.Context(), h.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	tier := "studio"
	_ = tx.QueryRow(r.Context(), `
SELECT COALESCE(bs.tier, t.tier, 'studio')
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, t.ID).Scan(&tier)
	tier = canonicalTier(tier)
	lim, configured := configuredLimits(tier)
	if !configured {
		lim = tierLimits["studio"]
		tier = "studio"
	}

	resources := []Resource{
		ResourceContacts,
		ResourceCampaigns,
		ResourceAutomations,
		ResourceLandingPages,
		ResourcePopupForms,
		ResourceEcommerceIntegrations,
		ResourceMonthlySends,
		ResourceSeats,
		ResourceAICredits,
		ResourceAutomationExecutions,
		ResourceTrackedEvents,
		ResourceAPIOperations,
		ResourceAssetStorage,
	}
	resp := UsageResponse{Tier: tier, Rows: make([]UsageRow, 0, len(resources))}
	for _, res := range resources {
		current, limit, err := currentAndLimit(r.Context(), tx, t.ID, res, lim)
		if err != nil {
			// Skip the broken row; the operator dashboard renders
			// what's available rather than 500'ing the whole panel.
			continue
		}
		row := UsageRow{
			Resource: string(res),
			Current:  current,
			Limit:    limit,
		}
		if limit > 0 {
			row.Percent = float64(current) / float64(limit) * 100.0
			if row.Percent > 100 {
				row.Exceeded = true
			}
		}
		resp.Rows = append(resp.Rows, row)
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// keep ctx imported for future timeout-aware usage.
var _ context.Context = nil
