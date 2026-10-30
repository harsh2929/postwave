package views

import (
	"context"
	"net/http"
)

// DeliverabilityLister is the narrow read surface. *Reader satisfies it.
type DeliverabilityLister interface {
	DeliverabilityByTenant(ctx context.Context, limit int) ([]DeliverabilityRow, error)
}

// DeliverabilityHandler serves GET /api/internal/ops/views/deliverability/by-tenant.
// Fail-loud (500 on read error, never an empty 200).
func DeliverabilityHandler(l DeliverabilityLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := viewLimit(r)
		rows, err := l.DeliverabilityByTenant(r.Context(), limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "deliverability_unavailable", "deliverability is unavailable")
			return
		}
		writeViewJSON(w, map[string]any{"tenants": rows, "truncated": len(rows) >= limit})
	}
}
