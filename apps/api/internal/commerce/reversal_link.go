// SPDX-License-Identifier: AGPL-3.0-only

package commerce

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/conversions"
)

// Refund and dispute events reverse the revenue they belong to.
//
// Every provider connector already ingests these — Stripe as `refunds` and
// `disputes` object types, Razorpay as four `refund.*` events, Shopify as a
// `refunded` order status. They have always landed in commerce_events and gone
// no further, so a campaign kept credit for money that had been handed back.
//
// This is deliberately ONE resolver at the single chokepoint every provider
// event passes through, rather than five provider-specific branches. Providers
// disagree about which identifier a refund carries — Razorpay sends a
// payment_id, Stripe a charge, Shopify the order itself — and a per-provider
// path would mean five places to forget the next time a connector is added.

// reversalKindFor classifies an event type, returning "" when it is not a
// reversal at all.
//
// Substring matching over an exact list on purpose: connectors normalise topics
// differently ("refund_created", "charge_refunded", "order_refunded") and an
// exact list would silently stop matching the first time a provider renamed a
// topic — failing open into "no reversal", which is invisible.
func reversalKindFor(eventType string) string {
	e := strings.ToLower(strings.TrimSpace(eventType))
	switch {
	case e == "":
		return ""
	// Checked before the generic dispute case: a lost dispute is a chargeback,
	// and collapsing the two would make a policy that works look like one that
	// failed.
	case strings.Contains(e, "chargeback"), strings.Contains(e, "dispute_lost"),
		strings.Contains(e, "dispute_closed"):
		return "chargeback"
	case strings.Contains(e, "dispute"):
		return "dispute"
	case strings.Contains(e, "refund"):
		return "refund"
	default:
		return ""
	}
}

// orderRefCandidates lists the metadata keys that might name the order this
// reversal belongs to, most specific first.
//
// Ordered, not a set: if an event carries both an order_id and a payment_id,
// the order_id is the one that means what it says.
var orderRefCandidates = []string{
	"order_id", "order", "order_source_id",
	"payment_id", "charge_id", "charge", "payment_intent_id", "source_id",
}

// resolveReversal records a reversal for a provider event when the event can be
// tied to an order, and reports whether it was.
//
// A miss is NOT an error. Refunds for orders that predate conversion ingestion
// have nothing to reverse, and failing the webhook over that would turn a
// harmless gap into a retry storm. It is logged rather than swallowed, because
// a resolver that silently never fires is indistinguishable from one that was
// never wired — the failure this whole subsystem exists to correct.
func resolveReversal(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in ProviderEventInput) error {
	kind := reversalKindFor(in.EventType)
	if kind == "" {
		return nil
	}
	metadata := nonNilMap(in.Metadata)

	orderUUID := ""
	for _, key := range orderRefCandidates {
		ref := strings.TrimSpace(fmt.Sprint(metadata[key]))
		if ref == "" || ref == "<nil>" {
			continue
		}
		err := tx.QueryRow(ctx, `
SELECT id::text FROM commerce_orders
 WHERE tenant_id = $1::uuid AND integration_id = $2::uuid AND source_id = $3
 LIMIT 1`, tenantID, integrationID, ref).Scan(&orderUUID)
		if err == nil && orderUUID != "" {
			break
		}
		if err != nil && err != pgx.ErrNoRows {
			return err
		}
		orderUUID = ""
	}
	if orderUUID == "" {
		slog.Info("commerce: reversal event could not be tied to an order",
			"tenant_id", tenantID, "event_type", in.EventType,
			"kind", kind, "source_id", in.SourceID)
		return nil
	}

	amount := int64(0)
	for _, key := range []string{"refund_cents", "amount_cents", "dispute_cents"} {
		if v, ok := metadata[key]; ok {
			switch n := v.(type) {
			case int:
				amount = int64(n)
			case int64:
				amount = n
			case float64:
				amount = int64(n)
			}
			if amount != 0 {
				break
			}
		}
	}
	currency := strings.TrimSpace(fmt.Sprint(metadata["currency"]))
	if currency == "<nil>" {
		currency = ""
	}

	// The provider's own id for the refund keys idempotency, so a redelivered
	// webhook cannot reverse the money a second time.
	ref := strings.TrimSpace(in.SourceID)
	if ref == "" {
		ref = strings.TrimSpace(in.ProviderEventID)
	}

	linked, err := conversions.RecordReversal(ctx, tx, tenantID, conversions.Reversal{
		OrderID:     orderUUID,
		Kind:        kind,
		AmountCents: amount,
		Currency:    currency,
		ExternalRef: ref,
		Source:      "commerce",
	})
	if err != nil {
		return err
	}
	if !linked {
		slog.Info("commerce: order has no conversion to reverse",
			"tenant_id", tenantID, "order_id", orderUUID, "kind", kind)
	}
	return nil
}
