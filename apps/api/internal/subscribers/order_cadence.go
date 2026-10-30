package subscribers

// SUB-062 — Average time between orders per profile.
//
// This is the read/hydration surface for the order-cadence metric. The
// underlying signal (average_days_between_orders) is the same well-known
// subscriber_computed_traits key that the SUB-061 replenishment-cadence
// worker and PATCH surface write (replenishment_cadence.go). SUB-062 layers
// a compact, first-class projection (OrderCadenceMetrics) that is hydrated
// inline on GET /api/v1/subscribers/{id} so the slideover's "Repeat Purchase
// Behavior" card can render the cadence without a second round-trip.
//
// No new table and no new trait key: SUB-062 reads the same
// average_days_between_orders / last_order_at traits that SUB-061 maintains,
// projecting them into a metric shape suited to the detail card. The reader
// is best-effort (an unscored profile yields a nil projection that the GET
// handler simply omits).

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// OrderCadenceMetrics is the SUB-062 compact projection hydrated inline on
// the subscriber detail GET. AverageDaysBetweenOrders is the rolling mean
// number of days between consecutive orders; LastComputedAt is when the
// cadence worker last refreshed it. A nil *OrderCadenceMetrics means the
// profile has no computed cadence yet (no, or a single, order).
type OrderCadenceMetrics struct {
	AverageDaysBetweenOrders float64   `json:"average_days_between_orders"`
	LastComputedAt           time.Time `json:"last_computed_at"`
}

// GetOrderCadenceMetrics reads the average_days_between_orders computed trait
// for a subscriber and projects it into OrderCadenceMetrics. Returns
// ErrNotFound when the subscriber does not exist. Returns (nil, nil) when the
// trait has never been computed for this subscriber (no order cadence yet) —
// callers treat a nil projection as "omit the card".
func (r *Repo) GetOrderCadenceMetrics(ctx context.Context, tenantID, subscriberID string) (*OrderCadenceMetrics, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	var valueRaw []byte
	var computedAt time.Time
	err = tx.QueryRow(ctx, `
SELECT value, computed_at
  FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND key = $3`,
		tenantID, sub.ID, TraitAverageDaysBetweenOrders).Scan(&valueRaw, &computedAt)
	if err != nil {
		// pgx.ErrNoRows ⇒ no cadence trait yet. Commit (read-only) and
		// surface a nil projection rather than an error.
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return nil, commitErr
		}
		return nil, nil
	}
	avg := decodeTraitFloat(valueRaw)
	if avg == nil {
		return nil, tx.Commit(ctx)
	}
	out := &OrderCadenceMetrics{AverageDaysBetweenOrders: *avg, LastComputedAt: computedAt.UTC()}
	return out, tx.Commit(ctx)
}

// hydrateOrderCadence attaches the SUB-062 OrderCadenceMetrics + the SUB-061
// expected_next_order_at projection onto a subscriber for the detail GET.
// Best-effort: a read failure returns the error so the caller can log it, but
// the caller does not fail the GET on it.
func (r *Repo) hydrateOrderCadence(ctx context.Context, tenantID string, sub *Subscriber) error {
	cad, err := r.GetReplenishmentCadence(ctx, tenantID, sub.ID)
	if err != nil {
		return err
	}
	if cad == nil {
		return nil
	}
	if cad.ExpectedNextOrderAt != nil {
		sub.ExpectedNextOrderAt = cad.ExpectedNextOrderAt
	}
	if cad.AverageDaysBetweenOrders != nil {
		anchor := cad.ComputedAt
		if anchor == nil {
			now := time.Now().UTC()
			anchor = &now
		}
		sub.OrderCadenceMetrics = &OrderCadenceMetrics{
			AverageDaysBetweenOrders: *cad.AverageDaysBetweenOrders,
			LastComputedAt:           anchor.UTC(),
		}
	}
	return nil
}
