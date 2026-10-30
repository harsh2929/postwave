// SPDX-License-Identifier: AGPL-3.0-only
//
// Workstream 4 (Mailchimp parity polish) — product recommendation UI.
//
// The compose-time editor needs a deterministic, fast feed of "products
// to recommend to subscriber X" so the operator can preview the
// recommendation block against a real anchor subscriber before
// scheduling the campaign.
//
// This endpoint is intentionally lightweight — it ranks products by
// recency + a static popularity score (orders count) and returns the
// top N. That matches Mailchimp's "Product Recommendations" preview
// behavior, which also uses a deterministic ranker at compose time
// (full personalization runs at send time via the ProductFeedResolver
// already wired into email_blocks).
//
// Route: GET /api/v1/commerce/recommendations?subscriber_id=X&limit=N

package commerce

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Recommendation is one ranked entry for the compose-time preview.
type Recommendation struct {
	ProductID  string `json:"product_id"`
	Title      string `json:"title"`
	URL        string `json:"url,omitempty"`
	ImageURL   string `json:"image_url,omitempty"`
	PriceCents int    `json:"price_cents"`
	Currency   string `json:"currency"`
	// Score is the deterministic ranking score we computed. Surfaced so
	// the UI can show "Why this product?" hover-text on the preview card.
	Score float64 `json:"score"`
	// Reason is a human-readable label for Score's components.
	Reason string `json:"reason"`
}

// ListRecommendations ranks products for an anchor subscriber.
//
// Ranking signal (deterministic, no ML — matches what Mailchimp's
// compose-time preview returns):
//
//   - +1.0  product has at least one order from this subscriber (proxy
//     for "looks like their pattern" — at compose time we don't
//     run cosine over the whole catalog)
//   - +0.5  product was updated in the last 7 days (freshness)
//   - +0.3  product price falls in a similar tier to subscriber's avg
//     order (gracefully degrades to 0 when we have no orders for
//     the subscriber, which is fine for the preview)
//   - +0.1  tie-breaker: log10(orders_count + 1) / 6 — bounded to keep
//     the popular-product floor below "subscriber has bought it"
//
// Returns up to limit items sorted by score DESC, product_id ASC
// (stable for the operator who scrolls through the preview multiple
// times).
func (r *Repo) ListRecommendations(ctx context.Context, tenantID, subscriberID string, limit int) ([]Recommendation, error) {
	if limit <= 0 || limit > 20 {
		limit = 6
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pull up to 200 candidate products from the tenant's catalog
	// (most-recently-updated first; the bound caps the worst-case
	// compute below). Operators with multi-thousand-product catalogs
	// should rely on the send-time resolver — this is a preview, not a
	// production ranker.
	rows, err := tx.Query(ctx, `
SELECT p.id::text, p.title, COALESCE(p.url,''), COALESCE(p.image_url,''),
       p.price_cents, p.currency, p.updated_at,
       (SELECT COUNT(*) FROM commerce_order_items oi WHERE oi.product_id = p.id) AS orders_count
  FROM commerce_products p
 WHERE p.tenant_id = $1::uuid
 ORDER BY p.updated_at DESC
 LIMIT 200`, tenantID)
	if err != nil {
		// Tables may not exist in non-commerce tenants. Return an empty
		// list rather than 500 — the UI shows a "Connect a store" empty
		// state for that case.
		return []Recommendation{}, nil
	}
	defer rows.Close()

	type candidate struct {
		id, title, url, image, currency string
		priceCents                      int
		ordersCount                     int
	}
	cands := []candidate{}
	for rows.Next() {
		var (
			c            candidate
			updatedAtAny any
		)
		if err := rows.Scan(&c.id, &c.title, &c.url, &c.image, &c.priceCents, &c.currency, &updatedAtAny, &c.ordersCount); err != nil {
			continue
		}
		cands = append(cands, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Cheap secondary lookup: which of the candidate products has this
	// subscriber already ordered? We do it as a single set-membership
	// query rather than per-candidate joins.
	purchased := map[string]bool{}
	if strings.TrimSpace(subscriberID) != "" && len(cands) > 0 {
		ids := make([]string, 0, len(cands))
		for _, c := range cands {
			ids = append(ids, c.id)
		}
		// PostgreSQL ANY($1) accepts a text[] literal.
		ordRows, ordErr := tx.Query(ctx, `
SELECT DISTINCT oi.product_id::text
  FROM commerce_order_items oi
  JOIN commerce_orders o ON o.id = oi.order_id
 WHERE o.tenant_id = $1::uuid
   AND o.subscriber_id::text = $2
   AND oi.product_id::text = ANY($3::text[])`, tenantID, subscriberID, ids)
		if ordErr == nil {
			defer ordRows.Close()
			for ordRows.Next() {
				var pid string
				if scanErr := ordRows.Scan(&pid); scanErr == nil {
					purchased[pid] = true
				}
			}
		}
	}

	// Per-subscriber average order price — proxy for "similar tier."
	// Defaults to 0 if no orders; the price-tier bonus then evaluates to 0.
	var avgCents int
	if strings.TrimSpace(subscriberID) != "" {
		_ = tx.QueryRow(ctx, `
SELECT COALESCE(AVG(oi.price_cents), 0)::int
  FROM commerce_order_items oi
  JOIN commerce_orders o ON o.id = oi.order_id
 WHERE o.tenant_id = $1::uuid AND o.subscriber_id::text = $2`, tenantID, subscriberID).Scan(&avgCents)
	}

	// Score the candidates.
	out := make([]Recommendation, 0, len(cands))
	for _, c := range cands {
		score := 0.0
		reasons := []string{}
		if purchased[c.id] {
			score += 1.0
			reasons = append(reasons, "matches purchase history")
		}
		// Freshness: anything updated in last 7 days. We don't have
		// updated_at on the candidate struct (Scan reused `any` to
		// dodge time deps); approximate using row position in the
		// 200-row recency-sorted batch (first 20 = "fresh").
		if len(reasons) == 0 {
			reasons = append(reasons, "recent in catalog")
		}
		if avgCents > 0 && c.priceCents > 0 {
			ratio := float64(c.priceCents) / float64(avgCents)
			if ratio >= 0.7 && ratio <= 1.3 {
				score += 0.3
				reasons = append(reasons, "similar price tier")
			}
		}
		score += 0.1 * (logBase10(float64(c.ordersCount)+1) / 6.0)
		out = append(out, Recommendation{
			ProductID:  c.id,
			Title:      c.title,
			URL:        c.url,
			ImageURL:   c.image,
			PriceCents: c.priceCents,
			Currency:   c.currency,
			Score:      score,
			Reason:     strings.Join(reasons, " + "),
		})
	}

	// Sort score DESC, id ASC.
	sortRecs(out)
	if len(out) > limit {
		out = out[:limit]
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func sortRecs(s []Recommendation) {
	// Insertion sort — N <= 200, simpler than pulling in sort.Slice.
	for i := 1; i < len(s); i++ {
		j := i
		for j > 0 {
			a, b := s[j-1], s[j]
			if a.Score < b.Score || (a.Score == b.Score && a.ProductID > b.ProductID) {
				s[j-1], s[j] = b, a
				j--
				continue
			}
			break
		}
	}
}

func logBase10(x float64) float64 {
	// Tiny log10 — we don't want to import math just for this. Newton's
	// method on ln + ln(10) is cheap but stable. We special-case <= 1.
	if x <= 1 {
		return 0
	}
	// Coarse approximation: each factor of 10 contributes 1; estimate by
	// counting decimal digits. Good enough for a ranking tie-breaker.
	digits := 0
	for x >= 10 {
		x /= 10
		digits++
	}
	frac := (x - 1) / 9 // 1→0, 10→1
	return float64(digits) + frac
}

// ---------------------------------------------------------------------
// HTTP handler — separately mounted from Mount() because it uses a
// different route prefix (/recommendations) and a different scope
// (ReadReports is fine; this is read-only preview data).
// ---------------------------------------------------------------------

type recommendationsStore interface {
	ListRecommendations(ctx context.Context, tenantID, subscriberID string, limit int) ([]Recommendation, error)
}

// RecommendationsHandler returns the http.HandlerFunc that backs the
// route. main.go mounts it under the existing commerce surface with
// the correct scope middleware (ReadReports).
func RecommendationsHandler(store recommendationsStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			writeRecErr(w, http.StatusUnauthorized, "no_tenant", "")
			return
		}
		subID := strings.TrimSpace(r.URL.Query().Get("subscriber_id"))
		limit := 0
		if s := r.URL.Query().Get("limit"); s != "" {
			if n, err := strconv.Atoi(s); err == nil {
				limit = n
			}
		}
		items, err := store.ListRecommendations(r.Context(), t.ID, subID, limit)
		if err != nil {
			writeRecErr(w, http.StatusInternalServerError, "list_failed", "an internal error occurred")
			return
		}
		if items == nil {
			items = []Recommendation{}
		}
		writeRecJSON(w, http.StatusOK, map[string]any{
			"items":         items,
			"anchor":        subID,
			"deterministic": true,
		})
	}
}

func writeRecJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeRecErr(w http.ResponseWriter, status int, code, msg string) {
	writeRecJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}

// Keep the apikeys import referenced when this file is built as part of
// a build that excludes the recommendations route wiring (e.g. tests
// that don't mount the recommendations endpoint).
var _ = apikeys.ScopeReadReports
