// SPDX-License-Identifier: AGPL-3.0-only
package commerce

// SUB-061 (Expected Date of Next Order per profile) +
// SUB-062 (Average time between orders per profile) — cadence analyzer.
//
// This worker recomputes a per-subscriber replenishment cadence from the
// tenant's order history (commerce_orders, joined to a subscriber by email)
// and upserts three well-known traits onto subscriber_computed_traits
// (table 0324):
//
//   * average_days_between_orders  — value_type 'number'
//   * last_order_at                — value_type 'datetime' (cadence anchor)
//   * expected_next_order_at       — value_type 'datetime'
//                                    (= last_order_at + average_days)
//
// The cadence math itself is a pure function (computeCadence over a sorted
// slice of order timestamps) so the logic is unit-testable without a live
// database; the repo method handles only the IO (read orders, upsert traits)
// around it. The subscribers package reads the traits back via
// GET/PATCH /api/v1/subscribers/{id}/replenishment-cadence (SUB-061) and the
// inline hydration on GET /api/v1/subscribers/{id} (SUB-061 / SUB-062).
//
// No new table — this reuses the existing computed-traits infrastructure,
// mirroring catalog_attributes.go (SUB-013).

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Cadence trait keys — must match the subscribers package's well-known keys.
const (
	cadenceTraitAverageDays  = "average_days_between_orders"
	cadenceTraitLastOrderAt  = "last_order_at"
	cadenceTraitExpectedNext = "expected_next_order_at"
)

// Cadence is the computed replenishment cadence for one subscriber.
// AverageDays is the mean number of days between consecutive orders;
// LastOrderAt is the most recent order timestamp; ExpectedNextOrderAt is the
// forward projection (LastOrderAt + AverageDays). Valid is false when fewer
// than two orders exist (no inter-order delta can be measured).
type Cadence struct {
	AverageDays         float64
	LastOrderAt         time.Time
	ExpectedNextOrderAt time.Time
	OrderCount          int
	Valid               bool
}

// computeCadence derives a Cadence from a subscriber's order timestamps. The
// input need not be sorted — it is sorted ascending internally. Cadence is
// the arithmetic mean of the gaps between consecutive orders, in days.
// Returns Valid=false when fewer than two orders exist or every order shares
// the same instant (a degenerate zero-span history).
func computeCadence(orderedAt []time.Time) Cadence {
	if len(orderedAt) < 2 {
		c := Cadence{OrderCount: len(orderedAt)}
		if len(orderedAt) == 1 {
			c.LastOrderAt = orderedAt[0].UTC()
		}
		return c
	}
	sorted := make([]time.Time, len(orderedAt))
	copy(sorted, orderedAt)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Before(sorted[j]) })

	first := sorted[0]
	last := sorted[len(sorted)-1]
	span := last.Sub(first)
	if span <= 0 {
		// All orders at the same instant — no measurable cadence.
		return Cadence{OrderCount: len(sorted), LastOrderAt: last.UTC()}
	}
	gaps := len(sorted) - 1
	avgDays := span.Hours() / 24.0 / float64(gaps)
	next := last.UTC().Add(time.Duration(avgDays * float64(24*time.Hour)))
	return Cadence{
		AverageDays:         avgDays,
		LastOrderAt:         last.UTC(),
		ExpectedNextOrderAt: next,
		OrderCount:          len(sorted),
		Valid:               true,
	}
}

// CadenceResult is the per-subscriber outcome of one
// BackfillReplenishmentCadence run, returned so the caller can log a summary.
type CadenceResult struct {
	SubscriberID        string
	AverageDays         float64
	LastOrderAt         time.Time
	ExpectedNextOrderAt time.Time
}

// BackfillReplenishmentCadence recomputes the replenishment cadence for every
// subscriber in the tenant that has at least two attributable orders, and
// upserts average_days_between_orders / last_order_at / expected_next_order_at
// onto subscriber_computed_traits. since bounds how far back to read orders
// (zero = all time). Idempotent: re-running overwrites the three traits with
// freshly-computed values. Returns one result per subscriber updated.
func (r *Repo) BackfillReplenishmentCadence(ctx context.Context, tenantID string, since time.Time) ([]CadenceResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Read attributable orders joined to a subscriber by email, oldest first
	// per subscriber. Only paid/refunded orders count as a fulfilled order
	// in the cadence; pending/cancelled never shipped.
	rows, err := tx.Query(ctx, `
SELECT s.id::text, co.ordered_at
  FROM commerce_orders co
  JOIN subscribers s
    ON s.tenant_id = co.tenant_id
   AND lower(s.email::text) = lower(co.customer_email::text)
 WHERE co.tenant_id = $1::uuid
   AND co.customer_email IS NOT NULL
   AND co.status IN ('paid', 'refunded')
   AND ($2 = '-infinity'::timestamptz OR co.ordered_at >= $2)
 ORDER BY s.id, co.ordered_at ASC`, tenantID, normalizeSince(since))
	if err != nil {
		return nil, err
	}
	bySub := map[string][]time.Time{}
	order := []string{}
	for rows.Next() {
		var subID string
		var at time.Time
		if err := rows.Scan(&subID, &at); err != nil {
			rows.Close()
			return nil, err
		}
		if _, seen := bySub[subID]; !seen {
			order = append(order, subID)
		}
		bySub[subID] = append(bySub[subID], at)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	results := []CadenceResult{}
	for _, subID := range order {
		cad := computeCadence(bySub[subID])
		if !cad.Valid {
			continue
		}
		if err := upsertCadenceTrait(ctx, tx, tenantID, subID, cadenceTraitAverageDays, "number", jsonNumber(cad.AverageDays), cad.LastOrderAt); err != nil {
			return nil, err
		}
		if err := upsertCadenceTrait(ctx, tx, tenantID, subID, cadenceTraitLastOrderAt, "datetime", jsonString(cad.LastOrderAt.Format(time.RFC3339)), cad.LastOrderAt); err != nil {
			return nil, err
		}
		if err := upsertCadenceTrait(ctx, tx, tenantID, subID, cadenceTraitExpectedNext, "datetime", jsonString(cad.ExpectedNextOrderAt.Format(time.RFC3339)), cad.LastOrderAt); err != nil {
			return nil, err
		}
		results = append(results, CadenceResult{
			SubscriberID:        subID,
			AverageDays:         cad.AverageDays,
			LastOrderAt:         cad.LastOrderAt,
			ExpectedNextOrderAt: cad.ExpectedNextOrderAt,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return results, nil
}

// jsonNumber marshals a float as a JSON number literal for jsonb storage.
func jsonNumber(f float64) string {
	b, _ := json.Marshal(f)
	return string(b)
}

// jsonString marshals a string as a JSON string literal for jsonb storage.
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// upsertCadenceTrait writes one computed-trait row inside the supplied tx,
// source fixed to 'model' (these are derived signals). On conflict it
// overwrites the value so re-running the backfill is idempotent. Mirrors
// upsertCatalogTrait (catalog_attributes.go).
func upsertCadenceTrait(ctx context.Context, tx pgx.Tx, tenantID, subscriberID, key, valueType, valueJSON string, computedAt time.Time) error {
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
	if err != nil {
		return fmt.Errorf("upsert cadence trait %s for subscriber %s: %w", key, subscriberID, err)
	}
	return nil
}
