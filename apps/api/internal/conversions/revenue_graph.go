// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The read side of the structural edges.
//
// Columns that are written and never read are the exact failure this ledger
// exists to catch: they cost write throughput, they look like a working
// feature in a schema dump, and they answer nothing. The edges are only worth
// having if "revenue by flow" is a question someone can ask, so this is the
// asking.
//
// GET /api/v1/conversions/revenue-graph?edge=flow&days=90
//
// One edge per call, deliberately. A combined response would have to decide
// how to present a conversion that carries three edges at once, and every way
// of doing that smuggles in the precedence rule the write side refused to
// invent. Asking per edge keeps each denominator explicit: "revenue that
// touched a flow" and "revenue that touched a discount" legitimately overlap,
// and a caller comparing them should see that in the shape of the API rather
// than discover it later.

// revenueEdgeKind names one queryable edge and the column behind it.
//
// A fixed table rather than an interpolated column name: the parameter reaches
// SQL as an identifier, and the only safe way to accept an identifier from a
// caller is to not accept one.
var revenueEdgeKinds = map[string]struct {
	Column string
	Label  string
}{
	"flow":       {"flow_id", "Flow the subscriber was enrolled in"},
	"form":       {"form_id", "Form the address came through"},
	"discount":   {"discount_id", "Discount redeemed"},
	"referral":   {"referrer_subscriber_id", "Subscriber who referred this one"},
	"experiment": {"experiment_variant_id", "Experiment arm the subscriber sat in"},
	"campaign":   {"campaign_id", "Campaign last clicked"},
}

// RevenueGraphRow is one node's share of the money.
type RevenueGraphRow struct {
	// NodeID is the edge's value — a flow id, a form id, a variant key. Never
	// empty: rows with no edge are excluded rather than bucketed under "", which
	// would read as a node called "unknown" that owns most of the revenue.
	NodeID string `json:"node_id"`
	// Conversions counts rows, AmountCents sums money. Both are reported
	// because a node with many small conversions and one with a single large
	// one are different findings, and a single number hides which you have.
	Conversions int64 `json:"conversions"`
	AmountCents int64 `json:"amount_cents"`
	// ReversedCents is money given back against this node's conversions —
	// refunds, disputes and chargebacks. Reported ALONGSIDE the gross figure
	// rather than subtracted from it: a node that earned 100 and refunded 90 is
	// a different finding from one that earned 10, and a single net number
	// makes them identical.
	ReversedCents int64 `json:"reversed_cents"`
}

// RevenueGraphResult is the answer plus what it excluded, so the caller can
// tell a small graph from a mostly-unattributed one.
type RevenueGraphResult struct {
	Edge  string `json:"edge"`
	Label string `json:"label"`
	Days  int    `json:"days"`
	// Currency the AmountCents figures are in — the window's dominant currency.
	// Empty when the window holds no monetary conversions at all.
	Currency string            `json:"currency,omitempty"`
	Rows     []RevenueGraphRow `json:"rows"`
	// WithoutEdge is how many in-window conversions carry no value for this
	// edge. Without it, a graph built from three attributed conversions out of
	// nine thousand looks identical to one built from all of them.
	WithoutEdge int64 `json:"without_edge"`
	// UnattributedCents is the money in those rows. A caller deciding whether
	// to trust the graph needs the missing money, not just the missing count.
	UnattributedCents int64 `json:"unattributed_cents"`
	// ReversedCents is the total given back across every node in this graph.
	// Present at the top level so "how much of this window's revenue survived"
	// is one subtraction rather than a sum over rows the LIMIT may have cut.
	ReversedCents int64 `json:"reversed_cents"`
}

// RevenueGraph groups in-window conversions by one structural edge.
//
// Revenue is reported in ONE currency — the dominant one for the window, the
// same rule CampaignAttribution uses — because summing USD and JPY cents into a
// single integer produces a number that is wrong in a way no reader can see.
// Conversion COUNTS deliberately include every row regardless of currency and
// regardless of whether it carried money at all: a count is currency-free, and
// a flow that drove twelve non-monetary signups should not vanish from its own
// graph.
func (r *Repo) RevenueGraph(ctx context.Context, tenantID, edge string, days int, now time.Time) (*RevenueGraphResult, error) {
	spec, ok := revenueEdgeKinds[edge]
	if !ok {
		return nil, fmt.Errorf("conversions: unknown edge %q", edge)
	}
	since := windowStartUTC(now, days)

	// Tenant-scoped tx, not a bare pool query. Under RLS a pool query returns
	// zero rows and is indistinguishable from an edge nothing ever wrote —
	// which is exactly how this function first reported an empty graph over
	// correctly populated data.
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	totals, err := currencyTotals(ctx, tx, tenantID, since, "")
	if err != nil {
		return nil, err
	}
	dominant := dominantCurrency(totals)

	out := &RevenueGraphResult{
		Edge: edge, Label: spec.Label, Days: days,
		Currency: dominant, Rows: []RevenueGraphRow{},
	}

	// Reversals are summed from a LATERAL per conversion rather than joined:
	// a plain LEFT JOIN would multiply the conversion's amount_cents by its
	// number of reversals, so an order refunded twice would report double the
	// revenue it earned. That is the classic fan-out bug, and it would inflate
	// exactly the rows a reader is most worried about.
	rows, err := tx.Query(ctx, fmt.Sprintf(`
SELECT c.%s::text AS node_id,
       count(*)::bigint,
       COALESCE(sum(c.amount_cents) FILTER (WHERE COALESCE(c.currency, '') = $3), 0)::bigint,
       COALESCE(sum(rev.reversed), 0)::bigint
  FROM conversions c
  LEFT JOIN LATERAL (
      SELECT COALESCE(sum(r.amount_cents), 0) AS reversed
        FROM conversion_reversals r
       WHERE r.tenant_id = c.tenant_id AND r.conversion_id = c.id
  ) rev ON TRUE
 WHERE c.tenant_id = $1::uuid
   AND c.occurred_at >= $2
   AND c.%s IS NOT NULL
 GROUP BY 1
 ORDER BY 3 DESC, 2 DESC, 1
 LIMIT 200`, spec.Column, spec.Column), tenantID, since, dominant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var row RevenueGraphRow
		if err := rows.Scan(&row.NodeID, &row.Conversions, &row.AmountCents, &row.ReversedCents); err != nil {
			return nil, err
		}
		out.Rows = append(out.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, fmt.Sprintf(`
SELECT count(*)::bigint,
       COALESCE(sum(amount_cents) FILTER (WHERE COALESCE(currency, '') = $3), 0)::bigint
  FROM conversions
 WHERE tenant_id = $1::uuid
   AND occurred_at >= $2
   AND %s IS NULL`, spec.Column), tenantID, since, dominant).
		Scan(&out.WithoutEdge, &out.UnattributedCents); err != nil {
		return nil, err
	}

	// Window-wide reversals, counted independently of the LIMIT 200 above so the
	// total is not quietly the total of the top 200 nodes.
	if err := tx.QueryRow(ctx, fmt.Sprintf(`
SELECT COALESCE(sum(r.amount_cents), 0)::bigint
  FROM conversion_reversals r
  JOIN conversions c ON c.id = r.conversion_id AND c.tenant_id = r.tenant_id
 WHERE r.tenant_id = $1::uuid
   AND c.occurred_at >= $2
   AND c.%s IS NOT NULL`, spec.Column), tenantID, since).
		Scan(&out.ReversedCents); err != nil {
		return nil, err
	}
	return out, nil
}

// MountRevenueGraph registers the read surface next to the attribution routes.
func MountRevenueGraph(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/conversions/revenue-graph", d.AdminRevenueGraph)
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Get("/api/v1/conversions/revenue-graph/edges", d.AdminRevenueGraphEdges)
}

// AdminRevenueGraphEdges GET /api/v1/conversions/revenue-graph/edges
//
// The enumeration exists so a caller discovers the edge names instead of
// guessing one and being refused — the same reason the experiment identity
// publishes its system keys.
func (d *Deps) AdminRevenueGraphEdges(w http.ResponseWriter, r *http.Request) {
	type edge struct {
		Edge  string `json:"edge"`
		Label string `json:"label"`
	}
	out := make([]edge, 0, len(revenueEdgeKinds))
	for k, v := range revenueEdgeKinds {
		out = append(out, edge{Edge: k, Label: v.Label})
	}
	// Map iteration is random; a response whose order changes per request is
	// unusable for a caching client and for a diffable test.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Edge < out[j-1].Edge; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// AdminRevenueGraph GET /api/v1/conversions/revenue-graph
func (d *Deps) AdminRevenueGraph(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context required")
		return
	}
	edge := r.URL.Query().Get("edge")
	if _, known := revenueEdgeKinds[edge]; !known {
		httperror.Write(w, http.StatusBadRequest, "invalid_edge",
			"edge must be one of the values listed by GET /api/v1/conversions/revenue-graph/edges")
		return
	}
	days, ok := parseDays(r.URL.Query().Get("days"))
	if !ok {
		httperror.Write(w, http.StatusBadRequest, "invalid_days", "days must be an integer between 1 and 365")
		return
	}
	out, err := d.Repo.RevenueGraph(r.Context(), t.ID, edge, days, time.Now())
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
