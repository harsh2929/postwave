// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for commerce-order revenue and its reversal.
// Requires migrations 1942 and 1943.

package conversions

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// seedCommerceOrder creates the integration + order a conversion can hang off.
func seedCommerceOrder(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email string, totalCents int, at time.Time) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var integrationID string
	if err := tx.QueryRow(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider, status)
VALUES ($1::uuid, 'shopify', 'connected') RETURNING id::text`, tenantID).Scan(&integrationID); err != nil {
		t.Fatalf("seed integration: %v", err)
	}
	var orderID string
	if err := tx.QueryRow(ctx, `
INSERT INTO commerce_orders (tenant_id, integration_id, source_id, customer_email, status, total_cents, currency, ordered_at)
VALUES ($1::uuid, $2::uuid, $3, $4, 'paid', $5, 'usd', $6) RETURNING id::text`,
		tenantID, integrationID, "order-"+uuid.NewString()[:8], email, totalCents, at).Scan(&orderID); err != nil {
		t.Fatalf("seed order: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return orderID
}

// A paid order becomes revenue exactly once, however many times it is synced.
//
// This is the constraint the whole ingestion path rests on. upsertOrder runs on
// every webhook redelivery and every backfill pass; without one-conversion-per-
// order a provider retrying six times reports six times the money, and nothing
// downstream could tell that from a genuinely good week.
func TestAnOrderBecomesRevenueExactlyOnceHoweverOftenItIsSynced(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	email := "buyer-" + uuid.NewString()[:8] + "@example.test"
	at := time.Now().UTC()
	orderID := seedCommerceOrder(t, pool, ctx, tenantID, email, 5000, at)

	for i := 0; i < 4; i++ {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		if err := RecordCommerceOrder(ctx, tx, tenantID, CommerceOrderConversion{
			OrderID: orderID, Email: email, AmountCents: 5000, Currency: "usd", OccurredAt: at,
		}); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("RecordCommerceOrder #%d: %v", i, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit #%d: %v", i, err)
		}
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	var total int64
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(sum(amount_cents), 0) FROM conversions
 WHERE tenant_id = $1::uuid AND commerce_order_id = $2::uuid`, tenantID, orderID).Scan(&n, &total); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 || total != 5000 {
		t.Fatalf("four syncs produced %d conversions totalling %d cents, want 1 / 5000 — "+
			"a redelivered webhook would inflate revenue", n, total)
	}
}

// A refund reverses the order's revenue, and does not reverse it twice.
func TestARefundReversesTheOrdersRevenueOnce(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	email := "buyer-" + uuid.NewString()[:8] + "@example.test"
	at := time.Now().UTC()
	orderID := seedCommerceOrder(t, pool, ctx, tenantID, email, 8000, at)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if err := RecordCommerceOrder(ctx, tx, tenantID, CommerceOrderConversion{
		OrderID: orderID, Email: email, AmountCents: 8000, Currency: "usd", OccurredAt: at,
	}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("RecordCommerceOrder: %v", err)
	}
	// The same provider refund, delivered three times.
	for i := 0; i < 3; i++ {
		linked, err := RecordReversal(ctx, tx, tenantID, Reversal{
			OrderID: orderID, Kind: "refund", AmountCents: 8000,
			Currency: "usd", ExternalRef: "re_abc123", OccurredAt: at,
		})
		if err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("RecordReversal #%d: %v", i, err)
		}
		if !linked {
			_ = tx.Rollback(ctx)
			t.Fatal("the refund found no conversion to reverse")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var n int
	var reversed int64
	if err := read.QueryRow(ctx, `
SELECT count(*), COALESCE(sum(r.amount_cents), 0)
  FROM conversion_reversals r
  JOIN conversions c ON c.id = r.conversion_id
 WHERE r.tenant_id = $1::uuid AND c.commerce_order_id = $2::uuid`, tenantID, orderID).Scan(&n, &reversed); err != nil {
		t.Fatalf("read reversals: %v", err)
	}
	if n != 1 || reversed != 8000 {
		t.Fatalf("three deliveries of one refund produced %d reversals totalling %d, "+
			"want 1 / 8000", n, reversed)
	}

	// And the conversion's own amount is untouched — reversals are events, not
	// an edit. "Refunded twice then disputed" must stay reconstructable.
	var gross int64
	if err := read.QueryRow(ctx, `
SELECT amount_cents FROM conversions WHERE tenant_id=$1::uuid AND commerce_order_id=$2::uuid`,
		tenantID, orderID).Scan(&gross); err != nil {
		t.Fatalf("read gross: %v", err)
	}
	if gross != 8000 {
		t.Fatalf("the conversion's gross amount was mutated to %d; reversals must be "+
			"recorded as events so the sequence survives", gross)
	}
}

// Two reversals against one conversion must not multiply its revenue.
//
// The fan-out bug: a plain LEFT JOIN to conversion_reversals repeats the
// conversion row once per reversal, so an order refunded twice reports double
// what it earned — inflating precisely the rows a reader is most worried about.
func TestTwoReversalsDoNotMultiplyTheRevenue(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	email := "buyer-" + uuid.NewString()[:8] + "@example.test"
	at := time.Now().UTC()
	orderID := seedCommerceOrder(t, pool, ctx, tenantID, email, 10000, at)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if err := RecordCommerceOrder(ctx, tx, tenantID, CommerceOrderConversion{
		OrderID: orderID, Email: email, AmountCents: 10000, Currency: "usd",
		OccurredAt: at, CampaignID: "",
	}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("RecordCommerceOrder: %v", err)
	}
	// Two partial refunds, then a dispute: three distinct facts.
	for _, r := range []Reversal{
		{OrderID: orderID, Kind: "refund", AmountCents: 3000, Currency: "usd", ExternalRef: "re_1", OccurredAt: at},
		{OrderID: orderID, Kind: "refund", AmountCents: 2000, Currency: "usd", ExternalRef: "re_2", OccurredAt: at},
		{OrderID: orderID, Kind: "dispute", AmountCents: 1000, Currency: "usd", ExternalRef: "dp_1", OccurredAt: at},
	} {
		if _, err := RecordReversal(ctx, tx, tenantID, r); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("RecordReversal %s: %v", r.ExternalRef, err)
		}
	}
	// Give the conversion an edge so it appears in the graph.
	if _, err := tx.Exec(ctx, `
UPDATE conversions SET experiment_variant_id = 'arm-a'
 WHERE tenant_id = $1::uuid AND commerce_order_id = $2::uuid`, tenantID, orderID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("stamp edge: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	got, err := (&Repo{Pool: pool}).RevenueGraph(ctx, tenantID, "experiment", 30, time.Now())
	if err != nil {
		t.Fatalf("RevenueGraph: %v", err)
	}
	if len(got.Rows) != 1 {
		t.Fatalf("rows = %d, want 1: %+v", len(got.Rows), got.Rows)
	}
	if got.Rows[0].AmountCents != 10000 {
		t.Fatalf("gross = %d, want 10000 — three reversals fanned the conversion "+
			"row out and multiplied its revenue", got.Rows[0].AmountCents)
	}
	if got.Rows[0].Conversions != 1 {
		t.Fatalf("conversions = %d, want 1 — the join counted reversals as sales",
			got.Rows[0].Conversions)
	}
	if got.Rows[0].ReversedCents != 6000 {
		t.Fatalf("reversed = %d, want 6000", got.Rows[0].ReversedCents)
	}
	if got.ReversedCents != 6000 {
		t.Fatalf("window reversed = %d, want 6000", got.ReversedCents)
	}
}

// A refund for an order that never became a conversion is reported, not an error.
func TestARefundWithNothingToReverseIsNotAnError(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	orderID := seedCommerceOrder(t, pool, ctx, tenantID, "nobody@example.test", 100, time.Now().UTC())

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	linked, err := RecordReversal(ctx, tx, tenantID, Reversal{
		OrderID: orderID, Kind: "refund", AmountCents: 100, ExternalRef: "re_orphan",
	})
	if err != nil {
		t.Fatalf("a refund with nothing to reverse must not fail the webhook: %v", err)
	}
	if linked {
		t.Fatal("reported a link to a conversion that does not exist")
	}
}

// A kind outside the permitted three is refused.
func TestAnUnknownReversalKindIsRefused(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := RecordReversal(ctx, tx, tenantID, Reversal{
		OrderID: uuid.NewString(), Kind: "vibes", ExternalRef: "x",
	}); err == nil {
		t.Fatal("an unknown reversal kind was accepted")
	}
}
