package views

import (
	"context"
	"net/http"
)

// BillingLister is the narrow read surface. *Reader satisfies it.
type BillingLister interface {
	BillingByTenant(ctx context.Context, limit int) ([]BillingRow, error)
}

// BillingHandler serves GET /api/internal/ops/views/billing/by-tenant. Fail-loud.
func BillingHandler(l BillingLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := viewLimit(r)
		rows, err := l.BillingByTenant(r.Context(), limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "billing_unavailable", "billing is unavailable")
			return
		}
		writeViewJSON(w, map[string]any{"tenants": rows, "truncated": len(rows) >= limit})
	}
}
