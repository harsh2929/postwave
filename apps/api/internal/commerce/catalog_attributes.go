// SPDX-License-Identifier: AGPL-3.0-only
package commerce

// SUB-013 — catalog-linked profile attributes worker.
//
// Listens to commerce_events for the catalog-relevant signals
// (product_created/order_created and, where the ingester emits it,
// product_viewed via the event metadata), aggregates a per-subscriber
// favorite_category histogram and last_viewed_sku, and upserts the result
// onto subscriber_computed_traits (table 0324) under the two well-known
// keys 'favorite_category' and 'last_viewed_sku'. No new table is
// required — this reuses the existing computed-traits infrastructure that
// the subscribers package reads back via GET
// /api/v1/subscribers/{id}/catalog-attributes.
//
// The aggregation itself is a set of pure functions (categoryHistogram,
// pickFavoriteCategory, latestSKU) so the logic is unit-testable without a
// live database; the repo method handles only the IO (read events, upsert
// traits) around them.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// catalogSignal is one normalized catalog touch derived from a
// commerce_events row: which subscriber (by email), what category and SKU,
// and when. category/sku may be empty when the event didn't carry them.
type catalogSignal struct {
	Email    string
	Category string
	SKU      string
	At       time.Time
}

// FavoriteCategory is the JSON-shaped value stored under the
// 'favorite_category' computed trait: the winning category, how many
// catalog touches voted for it, and the timestamp of the most recent touch
// in that category.
type FavoriteCategory struct {
	Category  string    `json:"category"`
	Count     int       `json:"count"`
	Timestamp time.Time `json:"timestamp"`
}

// categoryHistogram counts catalog touches per non-empty category for a
// single subscriber's signals. Empty categories are ignored.
func categoryHistogram(signals []catalogSignal) map[string]int {
	hist := map[string]int{}
	for _, s := range signals {
		c := strings.TrimSpace(s.Category)
		if c == "" {
			continue
		}
		hist[c]++
	}
	return hist
}

// pickFavoriteCategory chooses the winning category: highest count, ties
// broken by the most recent touch timestamp, then lexically for full
// determinism. Returns (zero, false) when no signal carried a category.
func pickFavoriteCategory(signals []catalogSignal) (FavoriteCategory, bool) {
	hist := categoryHistogram(signals)
	if len(hist) == 0 {
		return FavoriteCategory{}, false
	}
	// Latest timestamp per category, for tie-breaking + the stored value.
	latest := map[string]time.Time{}
	for _, s := range signals {
		c := strings.TrimSpace(s.Category)
		if c == "" {
			continue
		}
		if t, ok := latest[c]; !ok || s.At.After(t) {
			latest[c] = s.At
		}
	}
	cats := make([]string, 0, len(hist))
	for c := range hist {
		cats = append(cats, c)
	}
	sort.Slice(cats, func(i, j int) bool {
		ci, cj := cats[i], cats[j]
		if hist[ci] != hist[cj] {
			return hist[ci] > hist[cj]
		}
		if !latest[ci].Equal(latest[cj]) {
			return latest[ci].After(latest[cj])
		}
		return ci < cj
	})
	win := cats[0]
	return FavoriteCategory{Category: win, Count: hist[win], Timestamp: latest[win]}, true
}

// latestSKU returns the SKU of the most recent signal that carried one.
// Returns ("", false) when no signal carried a SKU.
func latestSKU(signals []catalogSignal) (string, bool) {
	var bestSKU string
	var bestAt time.Time
	found := false
	for _, s := range signals {
		sku := strings.TrimSpace(s.SKU)
		if sku == "" {
			continue
		}
		if !found || s.At.After(bestAt) {
			bestSKU = sku
			bestAt = s.At
			found = true
		}
	}
	return bestSKU, found
}

// signalFromEvent normalizes a commerce_events metadata blob + product
// join into a catalogSignal. category is read from the event metadata
// (category / collection / product_type keys, first non-empty wins) and
// sku from the metadata sku/source_id. Returns (zero, false) when the
// event has no email (can't attribute it to a subscriber).
func signalFromEvent(email string, metadata map[string]any, at time.Time) (catalogSignal, bool) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return catalogSignal{}, false
	}
	return catalogSignal{
		Email:    email,
		Category: firstNonEmptyString(metadata, "category", "collection", "product_type"),
		SKU:      firstNonEmptyString(metadata, "sku", "source_id", "product_id"),
		At:       at,
	}, true
}

// firstNonEmptyString returns the first key whose value is a non-empty
// string. Non-string values are skipped.
func firstNonEmptyString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}

// CatalogAttributeResult is the per-subscriber outcome of one
// BackfillCatalogAttributes run, returned so the worker / caller can log a
// summary.
type CatalogAttributeResult struct {
	SubscriberID     string
	FavoriteCategory *FavoriteCategory
	LastViewedSKU    string
}

// BackfillCatalogAttributes recomputes favorite_category + last_viewed_sku
// for every subscriber in the tenant that has commerce_events with an
// attributable email, and upserts the results onto
// subscriber_computed_traits. since bounds how far back to read events
// (zero = all time). It is idempotent: re-running overwrites the two
// traits with the freshly-computed values. Returns one result per
// subscriber updated.
func (r *Repo) BackfillCatalogAttributes(ctx context.Context, tenantID string, since time.Time) ([]CatalogAttributeResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Read catalog-relevant events joined to a subscriber by email.
	rows, err := tx.Query(ctx, `
SELECT s.id::text, ce.customer_email::text, ce.metadata, ce.at
  FROM commerce_events ce
  JOIN subscribers s
    ON s.tenant_id = ce.tenant_id
   AND lower(s.email::text) = lower(ce.customer_email::text)
 WHERE ce.tenant_id = $1::uuid
   AND ce.customer_email IS NOT NULL
   AND ($2 = '-infinity'::timestamptz OR ce.at >= $2)
 ORDER BY s.id, ce.at ASC`, tenantID, normalizeSince(since))
	if err != nil {
		return nil, err
	}
	bySub := map[string][]catalogSignal{}
	order := []string{}
	for rows.Next() {
		var subID, email string
		var metaRaw []byte
		var at time.Time
		if err := rows.Scan(&subID, &email, &metaRaw, &at); err != nil {
			rows.Close()
			return nil, err
		}
		meta := map[string]any{}
		if len(metaRaw) > 0 {
			_ = json.Unmarshal(metaRaw, &meta)
		}
		sig, ok := signalFromEvent(email, meta, at)
		if !ok {
			continue
		}
		if _, seen := bySub[subID]; !seen {
			order = append(order, subID)
		}
		bySub[subID] = append(bySub[subID], sig)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	results := []CatalogAttributeResult{}
	for _, subID := range order {
		signals := bySub[subID]
		res := CatalogAttributeResult{SubscriberID: subID}
		if fav, ok := pickFavoriteCategory(signals); ok {
			res.FavoriteCategory = &fav
			valueRaw, err := json.Marshal(fav)
			if err != nil {
				return nil, fmt.Errorf("marshal favorite_category for subscriber %s: %w", subID, err)
			}
			if err := upsertCatalogTrait(ctx, tx, tenantID, subID, "favorite_category", "json", string(valueRaw), fav.Timestamp); err != nil {
				return nil, err
			}
		}
		if sku, ok := latestSKU(signals); ok {
			res.LastViewedSKU = sku
			valueRaw, err := json.Marshal(sku)
			if err != nil {
				return nil, fmt.Errorf("marshal last_viewed_sku for subscriber %s: %w", subID, err)
			}
			if err := upsertCatalogTrait(ctx, tx, tenantID, subID, "last_viewed_sku", "string", string(valueRaw), time.Now().UTC()); err != nil {
				return nil, err
			}
		}
		if res.FavoriteCategory != nil || res.LastViewedSKU != "" {
			results = append(results, res)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return results, nil
}

// normalizeSince maps a zero time to the SQL -infinity sentinel so the
// "all time" path uses the same parametrized query.
func normalizeSince(since time.Time) string {
	if since.IsZero() {
		return "-infinity"
	}
	return since.UTC().Format(time.RFC3339Nano)
}

// upsertCatalogTrait writes one computed-trait row inside the supplied tx,
// source fixed to 'model' (these are derived signals). On conflict it
// overwrites the value so re-running the backfill is idempotent.
func upsertCatalogTrait(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, key, valueType, valueJSON string, computedAt time.Time) error {
	_, err := tx.Exec(ctx, `
INSERT INTO subscriber_computed_traits
    (tenant_id, subscriber_id, key, value, value_type, source, computed_at)
VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, 'model', $6)
ON CONFLICT (tenant_id, subscriber_id, key) DO UPDATE SET
    value       = EXCLUDED.value,
    value_type  = EXCLUDED.value_type,
    source      = EXCLUDED.source,
    computed_at = EXCLUDED.computed_at,
    updated_at  = now()`,
		tenantID, subscriberID, key, valueJSON, valueType, computedAt)
	return err
}
