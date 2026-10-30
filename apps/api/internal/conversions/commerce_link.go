// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Commerce orders become conversions, and their refunds reverse them.
//
// These take a pgx.Tx rather than owning one, so the commerce writer can record
// an order and its revenue atomically: an order that committed while its
// conversion did not would be revenue that silently never existed, and the two
// facts are the same fact.
//
// The direction of the dependency is deliberate. conversions knows nothing
// about Stripe, Shopify or Razorpay; commerce hands it money, an email, a time
// and an order id. Anything provider-shaped stays on the commerce side of this
// boundary.

// CommerceOrderConversion is one paid order, expressed as revenue.
type CommerceOrderConversion struct {
	// OrderID is commerce_orders.id — the key that lets this order's refund
	// find this conversion later. Required; without it the row is
	// indistinguishable from an API-reported conversion and can never be
	// reversed.
	OrderID     string
	Email       string
	AmountCents int64
	Currency    string
	OccurredAt  time.Time
	// CampaignID is the order's own attribution hint, if commerce captured one.
	CampaignID string
	EventName  string
}

// ErrMissingOrderID is returned when the linking key is absent.
var ErrMissingOrderID = errors.New("conversions: commerce order id required")

// RecordCommerceOrder records (or refreshes) the conversion for one paid order.
//
// Idempotent on (tenant_id, commerce_order_id), which is what makes it safe to
// call from upsertOrder — that runs on every webhook redelivery and every
// backfill pass, and without the unique index a provider retrying six times
// would report six times the revenue.
//
// On a repeat call the MONEY is refreshed (an order total corrected upstream
// should correct the revenue) but the structural edges are NOT re-resolved.
// Edges record the touches that preceded the purchase; re-resolving them on a
// webhook that arrives a week later would let a flow the customer entered
// afterwards retroactively claim credit for a sale it could not have caused.
func RecordCommerceOrder(ctx context.Context, tx pgx.Tx, tenantID string, in CommerceOrderConversion) error {
	orderID := strings.TrimSpace(in.OrderID)
	if orderID == "" {
		return ErrMissingOrderID
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	eventName := strings.TrimSpace(in.EventName)
	if eventName == "" {
		eventName = "purchase"
	}
	occurredAt := in.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}

	// Edges are best-effort, exactly as on the API ingest path: a failed join
	// must cost the graph, never the money.
	var edges structuralEdges
	if email != "" {
		lookupErr, savepointErr := runBestEffortInSavepoint(ctx, tx, structuralEdgeLookupSavepoint, func() error {
			var err error
			edges, err = lookupStructuralEdges(ctx, tx, tenantID, email, occurredAt)
			return err
		})
		if savepointErr != nil {
			return savepointErr
		}
		if lookupErr != nil {
			slog.Error("conversions: commerce edge lookup failed",
				"tenant_id", tenantID, "order_id", orderID, "err", lookupErr.Error())
			edges = structuralEdges{}
		}
	}

	var amount *int64
	if in.AmountCents != 0 {
		v := in.AmountCents
		amount = &v
	}

	_, err := tx.Exec(ctx, `
WITH requested_campaign AS (
    SELECT id FROM campaigns
     WHERE tenant_id = $1::uuid AND id = NULLIF($8, '')::uuid
)
INSERT INTO conversions
    (tenant_id, subscriber_email, event_name, amount_cents, currency, occurred_at,
     commerce_order_id, campaign_id, attributed_via,
     flow_id, form_id, discount_id, referrer_subscriber_id, experiment_variant_id)
SELECT $1::uuid, NULLIF($2, ''), $3, $4, NULLIF($5, ''), $6,
       $7::uuid, requested_campaign.id,
       CASE WHEN requested_campaign.id IS NULL THEN $10 ELSE $9 END,
       NULLIF($11, '')::uuid, NULLIF($12, '')::uuid, NULLIF($13, '')::uuid,
       NULLIF($14, ''), NULLIF($15, '')
  FROM (VALUES (1)) AS anchor(_)
  LEFT JOIN requested_campaign ON TRUE
ON CONFLICT (tenant_id, commerce_order_id) WHERE commerce_order_id IS NOT NULL
DO UPDATE SET
    amount_cents = EXCLUDED.amount_cents,
    currency     = EXCLUDED.currency`,
		tenantID, email, eventName, amount, in.Currency, occurredAt,
		orderID, in.CampaignID, AttributedViaExplicit, AttributedViaNone,
		edges.FlowID, edges.FormID, edges.DiscountID,
		edges.ReferrerSubscriberID, edges.ExperimentVariantID)
	if err != nil {
		return fmt.Errorf("record commerce conversion: %w", err)
	}
	return nil
}

// Reversal is money going back out: a refund, a dispute, or a lost dispute.
type Reversal struct {
	// OrderID identifies the conversion being reversed, via the same key the
	// order was recorded under.
	OrderID string
	// Kind is 'refund', 'dispute' or 'chargeback'. They are kept apart because
	// they say different things about the customer: a refund is a policy
	// working, a chargeback is one that failed.
	Kind        string
	AmountCents int64
	Currency    string
	OccurredAt  time.Time
	// ExternalRef is the provider's id for the refund or dispute — the
	// idempotency key. A provider redelivering the same refund must not reverse
	// the money twice.
	ExternalRef string
	Source      string
}

// ErrUnknownReversalKind is returned for a kind outside the permitted three.
var ErrUnknownReversalKind = errors.New("conversions: unknown reversal kind")

var reversalKinds = map[string]bool{"refund": true, "dispute": true, "chargeback": true}

// RecordReversal records money returned against the conversion for an order.
//
// Returns (false, nil) when there is no conversion for that order — which is
// the ordinary case for a refund of an order that predates conversion
// ingestion, and is a fact worth reporting to the caller rather than an error
// worth failing a webhook over.
//
// The conversion's amount_cents is deliberately NOT decremented. Two partial
// refunds and a later dispute are three facts with three dates; overwriting one
// number destroys the sequence, and "refunded twice then disputed" is exactly
// the shape somebody eventually needs to see.
func RecordReversal(ctx context.Context, tx pgx.Tx, tenantID string, in Reversal) (bool, error) {
	orderID := strings.TrimSpace(in.OrderID)
	if orderID == "" {
		return false, ErrMissingOrderID
	}
	kind := strings.TrimSpace(in.Kind)
	if !reversalKinds[kind] {
		return false, ErrUnknownReversalKind
	}
	ref := strings.TrimSpace(in.ExternalRef)
	if ref == "" {
		// Without a stable provider id there is no way to tell a redelivery
		// from a second genuine refund, and guessing would either double-count
		// the money or silently drop a real one. Derive it from the order so
		// the common "one full refund" case stays idempotent.
		ref = "order:" + orderID + ":" + kind
	}
	source := strings.TrimSpace(in.Source)
	if source == "" {
		source = "commerce"
	}
	occurredAt := in.OccurredAt
	if occurredAt.IsZero() {
		occurredAt = time.Now().UTC()
	}

	var conversionID int64
	err := tx.QueryRow(ctx, `
SELECT id FROM conversions
 WHERE tenant_id = $1::uuid AND commerce_order_id = $2::uuid
 LIMIT 1`, tenantID, orderID).Scan(&conversionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}

	var amount *int64
	if in.AmountCents != 0 {
		v := in.AmountCents
		if v < 0 {
			v = -v
		}
		amount = &v
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_reversals
    (tenant_id, conversion_id, kind, amount_cents, currency, occurred_at, source, external_ref)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), $6, $7, $8)
ON CONFLICT (tenant_id, source, external_ref) DO NOTHING`,
		tenantID, conversionID, kind, amount, in.Currency, occurredAt, source, ref); err != nil {
		return false, fmt.Errorf("record reversal: %w", err)
	}
	return true, nil
}
