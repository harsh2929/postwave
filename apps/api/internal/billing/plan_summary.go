// SPDX-License-Identifier: AGPL-3.0-only
//
// plan_summary.go — GET /api/v1/billing/plan-summary.
//
// One endpoint that answers "what plan am I on, what are its limits,
// how much have I used, and am I about to blow a cap" so there are NO
// billing surprises. It is a read-only composition:
//
//   - per-resource current/limit/percent/exceeded rows come from the
//     limits package (the SAME quota SQL behind /api/v1/limits/usage —
//     no copy-pasted SQL here), and
//   - current_period_end comes from billing_state, and
//   - sends_projection is an HONEST linear extrapolation of
//     monthly_sends to the end of the current calendar-month usage
//     window (the window the cap is actually measured over).
//
// Auth/scope matches GET /api/v1/billing/state exactly (read:reports);
// the route is mounted next to it in main.go.

package billing

import (
	"errors"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var errNoPool = errors.New("billing: db pool not configured")

// PlanSummary GET /api/v1/billing/plan-summary.
func (h *Handlers) PlanSummary(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if h.Repo == nil || h.Repo.Pool == nil {
		httperror.WriteInternal(w, h.Logger, errNoPool, r.Context())
		return
	}

	// Reuse the limits package's per-resource quota computation. This is
	// the single source of truth for current/limit — the projection below
	// reads the monthly_sends row straight out of it so the two can never
	// disagree.
	resources, tier, err := limits.PlanSummaryResources(r.Context(), h.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.Logger, err, r.Context())
		return
	}

	out := limits.PlanSummary{
		Tier:      tier,
		Resources: resources,
	}

	// current_period_end from billing_state when known; omitted otherwise.
	if st, err := h.Repo.GetState(r.Context(), t.ID); err == nil && st != nil && !st.CurrentPeriodEnd.IsZero() {
		s := st.CurrentPeriodEnd.UTC().Format(time.RFC3339)
		out.CurrentPeriodEnd = &s
	}

	// sends_projection: only for monthly_sends. Built from the monthly_sends
	// resource row's real current/limit, divided over the elapsed days of the
	// current calendar month. See limits.ComputeSendsProjection for the
	// formula and the insufficient-data guard.
	if row := findResource(resources, string(limits.ResourceMonthlySends)); row != nil {
		out.SendsProjection = limits.BuildSendsProjection(row, time.Now().UTC())
	}

	writeJSON(w, http.StatusOK, out)
}

func findResource(rows []limits.UsageRow, name string) *limits.UsageRow {
	for i := range rows {
		if rows[i].Resource == name {
			return &rows[i]
		}
	}
	return nil
}
