// SPDX-License-Identifier: AGPL-3.0-only

package commerce

import "testing"

// Every shape a connector actually emits must classify.
//
// The table is drawn from the real event types in this package rather than
// invented ones: Stripe's object types (`refunds`, `disputes`), Razorpay's four
// `refund.*` topics normalised to underscores, and the `order_refunded` this
// repo's own upsertOrder emits. A classifier that only matched invented names
// would pass its test and reverse nothing in production.
func TestEveryConnectorsReversalShapeClassifies(t *testing.T) {
	for _, tc := range []struct{ event, want string }{
		{"refund_created", "refund"},
		{"refund_processed", "refund"},
		{"refund_failed", "refund"},
		{"refund_speed_changed", "refund"},
		{"charge_refunded", "refund"},
		{"order_refunded", "refund"},
		{"refunds", "refund"},
		{"charge_dispute_created", "dispute"},
		{"disputes", "dispute"},
		// A lost dispute is a chargeback, and must not collapse into "dispute":
		// a refund policy working and one that failed are different findings.
		{"charge_dispute_closed", "chargeback"},
		{"dispute_lost", "chargeback"},
		{"chargeback_received", "chargeback"},
		// Not reversals.
		{"order_created", ""},
		{"cart_abandoned", ""},
		{"customer_created", ""},
		{"", ""},
	} {
		if got := reversalKindFor(tc.event); got != tc.want {
			t.Errorf("reversalKindFor(%q) = %q, want %q", tc.event, got, tc.want)
		}
	}
}

// The order reference is looked for most-specific-first.
//
// An event carrying both an order_id and a payment_id must use the order_id:
// they can name different objects, and the one that says "order" is the one
// that means it.
func TestOrderRefCandidatesPreferTheExplicitOrder(t *testing.T) {
	if orderRefCandidates[0] != "order_id" {
		t.Fatalf("first candidate = %q, want order_id", orderRefCandidates[0])
	}
	orderAt, paymentAt := -1, -1
	for i, k := range orderRefCandidates {
		if k == "order_id" {
			orderAt = i
		}
		if k == "payment_id" {
			paymentAt = i
		}
	}
	if orderAt == -1 || paymentAt == -1 || orderAt > paymentAt {
		t.Fatalf("order_id (%d) must be tried before payment_id (%d)", orderAt, paymentAt)
	}
}
