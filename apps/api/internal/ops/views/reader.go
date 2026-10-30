package views

import (
	"context"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TenantRow is one line in the cross-tenant directory.
type TenantRow struct {
	TenantID         string       `json:"tenant_id"`
	Slug             string       `json:"slug"`
	Name             string       `json:"name"`
	Tier             string       `json:"tier"`
	CurrentPeriodEnd *time.Time   `json:"current_period_end,omitempty"`
	Dunning          bool         `json:"dunning"`
	SendingPaused    bool         `json:"sending_paused"`
	Health           TenantHealth `json:"health"`
	CreatedAt        time.Time    `json:"created_at"`
}

// Reader runs the ops console's read-only, cross-tenant queries. It holds the
// platform-scoped ops pool and never sets a per-tenant GUC.
type Reader struct {
	Pool *pgxpool.Pool
}

// ListTenants returns the tenant directory, newest first. search (optional)
// filters by name or slug (case-insensitive prefix). Cross-tenant by design.
//
// The read goes through the ops_tenant_directory SECURITY DEFINER function, not
// a direct base-table SELECT: the ops pool connects as postwave_ops, which has
// no SELECT on tenants/billing_state (see migration 1738). sending_paused is a
// JSONB path on tenants.metadata (the kill switch is not a table) — the function
// derives it from the same path.
func (r *Reader) ListTenants(ctx context.Context, search string, limit int) ([]TenantRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	search = escapeLikePrefix(strings.TrimSpace(search))
	rows, err := r.Pool.Query(ctx,
		`SELECT tenant_id, slug, name, tier, current_period_end,
		        dunning, sending_paused, created_at
		   FROM ops_tenant_directory($1, $2)`, search, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TenantRow{}
	for rows.Next() {
		var row TenantRow
		if err := rows.Scan(&row.TenantID, &row.Slug, &row.Name, &row.Tier,
			&row.CurrentPeriodEnd, &row.Dunning, &row.SendingPaused, &row.CreatedAt); err != nil {
			return nil, err
		}
		row.Health = DeriveTenantHealth(row.SendingPaused, row.Dunning)
		out = append(out, row)
	}
	return out, rows.Err()
}

// escapeLikePrefix keeps operator searches literal. Without this, '%' and '_'
// supplied by a caller become PostgreSQL wildcard operators and can turn a
// prefix lookup into an unintended cross-tenant scan.
func escapeLikePrefix(search string) string {
	search = strings.ReplaceAll(search, `\`, `\\`)
	search = strings.ReplaceAll(search, `%`, `\%`)
	search = strings.ReplaceAll(search, `_`, `\_`)
	return search
}
