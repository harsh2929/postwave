// SPDX-License-Identifier: AGPL-3.0-only
package cost

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// CostRow is one bucket of an aggregation result. Group-by columns that
// weren't requested are returned as nil.
type CostRow struct {
	APIKeyID   *string    `json:"apiKeyId,omitempty"`
	ActorType  *string    `json:"actorType,omitempty"`
	Kind       *string    `json:"kind,omitempty"`
	Day        *time.Time `json:"day,omitempty"`
	Cents      int64      `json:"cents"`
	Microcents int64      `json:"microcents"`
	Quantity   int64      `json:"quantity"`
	Count      int64      `json:"count"`
}

// allowedGroupBy enumerates the group-by columns we permit. Anything else is
// rejected — we are not building a generic SQL gateway here.
var allowedGroupBy = map[string]string{
	"api_key_id": "api_key_id::text",
	"actor_type": "actor_type",
	"kind":       "kind",
	"day":        "date_trunc('day', at)",
}

// Aggregate sums cost_ledger rows for `tenantID` since `since`, grouped by
// the requested columns. An empty groupBy slice returns a single grand-total
// row.
func (r *Repo) Aggregate(ctx context.Context, tenantID string, since time.Time, groupBy []string) ([]CostRow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	selects := []string{}
	groups := []string{}
	for _, g := range groupBy {
		expr, ok := allowedGroupBy[g]
		if !ok {
			return nil, fmt.Errorf("cost: unsupported group_by %q", g)
		}
		selects = append(selects, fmt.Sprintf("%s AS %s", expr, g))
		groups = append(groups, expr)
	}
	selects = append(selects,
		"COALESCE(SUM(microcents), 0)::bigint AS microcents",
		"COALESCE(SUM(quantity), 0)::bigint AS quantity",
		"COUNT(*)::bigint                    AS count",
	)

	q := "SELECT " + strings.Join(selects, ", ") +
		" FROM cost_ledger WHERE tenant_id = $1::uuid AND at >= $2"
	if len(groups) > 0 {
		q += " GROUP BY " + strings.Join(groups, ", ")
		q += " ORDER BY microcents DESC"
	}

	rows, err := tx.Query(ctx, q, tenantID, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []CostRow{}
	for rows.Next() {
		dest := []any{}
		var apiKeyID, actorType, kind *string
		var day *time.Time
		for _, g := range groupBy {
			switch g {
			case "api_key_id":
				dest = append(dest, &apiKeyID)
			case "actor_type":
				dest = append(dest, &actorType)
			case "kind":
				dest = append(dest, &kind)
			case "day":
				dest = append(dest, &day)
			}
		}
		var microcents, qty, count int64
		dest = append(dest, &microcents, &qty, &count)
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		// Round to display cents from the PRECISE microcent total, so a tenant
		// with many sub-cent AI calls no longer sums to $0.
		out = append(out, CostRow{
			APIKeyID:   apiKeyID,
			ActorType:  actorType,
			Kind:       kind,
			Day:        day,
			Cents:      int64(CentsFromMicrocents(microcents)),
			Microcents: microcents,
			Quantity:   qty,
			Count:      count,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// LedgerPage returns raw entries newest-first for the tenant.
func (r *Repo) LedgerPage(ctx context.Context, tenantID string, since time.Time, cursor int64, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, api_key_id::text, actor_type, kind,
       cents, quantity, at, metadata
FROM cost_ledger
WHERE tenant_id = $1::uuid
  AND at >= $2
  AND ($3 = 0 OR id < $3)
ORDER BY id DESC
LIMIT $4`, tenantID, since, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Entry{}
	for rows.Next() {
		var e Entry
		var apiKeyID, actorType *string
		var kind string
		var meta map[string]any
		if err := rows.Scan(&e.ID, &e.TenantID, &apiKeyID, &actorType, &kind,
			&e.Cents, &e.Quantity, &e.At, &meta); err != nil {
			return nil, err
		}
		e.APIKeyID = apiKeyID
		e.ActorType = actorType
		e.Kind = Kind(kind)
		if meta == nil {
			meta = map[string]any{}
		}
		e.Metadata = meta
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ParseSince parses values like "24h", "7d", "30m". Returns the resulting
// time.Time. Empty defaults to 24h.
func ParseSince(s string) (time.Time, error) {
	if s == "" {
		return time.Now().Add(-24 * time.Hour), nil
	}
	if strings.HasSuffix(s, "d") {
		days := strings.TrimSuffix(s, "d")
		var n int
		if _, err := fmt.Sscanf(days, "%d", &n); err != nil || n <= 0 {
			return time.Time{}, errors.New("cost: bad day value")
		}
		return time.Now().Add(-time.Duration(n) * 24 * time.Hour), nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return time.Time{}, err
	}
	return time.Now().Add(-d), nil
}
