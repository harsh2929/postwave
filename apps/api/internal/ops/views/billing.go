package views

import "context"

// MonthlySendsCap returns the tier's monthly-send quota — the same values the
// limits enforcer uses (studio 2,000 / sending 50,000 / pro 500,000). Unknown
// tiers default to the studio floor rather than "unlimited" (never under-report
// a tenant's proximity to the cap).
func MonthlySendsCap(tier string) int {
	switch tier {
	case "sending":
		return 50000
	case "pro":
		return 500000
	default:
		return 2000
	}
}

// UsageFraction is used/cap, guarding a zero cap. Over-quota returns > 1.0 so an
// operator sees the overage.
func UsageFraction(used, cap int) float64 {
	if cap <= 0 {
		return 0
	}
	return float64(used) / float64(cap)
}

// BillingRow is one tenant's billing + quota health for the ops console.
type BillingRow struct {
	TenantID      string  `json:"tenant_id"`
	Slug          string  `json:"slug"`
	Name          string  `json:"name"`
	Tier          string  `json:"tier"`
	Dunning       bool    `json:"dunning"`
	MonthlyUsed   int     `json:"monthly_sends_used"`
	MonthlyCap    int     `json:"monthly_sends_cap"`
	UsageFraction float64 `json:"usage_fraction"`
}

// BillingByTenant returns per-tenant billing + quota, dunning first then highest
// quota usage — the two things that make an operator act. Usage comes from the
// maintained tenant_usage_snapshots for the current month.
func (r *Reader) BillingByTenant(ctx context.Context, limit int) ([]BillingRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	// Via the ops_billing_by_tenant SECURITY DEFINER function: postwave_ops has no
	// SELECT on tenants/billing_state/tenant_usage_snapshots (migration 1738).
	rows, err := r.Pool.Query(ctx,
		`SELECT tenant_id, slug, name, tier, dunning, monthly_used
		   FROM ops_billing_by_tenant($1)`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BillingRow{}
	for rows.Next() {
		var row BillingRow
		if err := rows.Scan(&row.TenantID, &row.Slug, &row.Name, &row.Tier, &row.Dunning, &row.MonthlyUsed); err != nil {
			return nil, err
		}
		row.MonthlyCap = MonthlySendsCap(row.Tier)
		row.UsageFraction = UsageFraction(row.MonthlyUsed, row.MonthlyCap)
		out = append(out, row)
	}
	return out, rows.Err()
}
