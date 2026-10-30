// SPDX-License-Identifier: AGPL-3.0-only
//
// End-to-end: a provider refund event arriving through the normal ingest path
// reverses the revenue of the order it belongs to.
//
// This is the test that matters most in this file. Everything else here checks
// a classifier or a candidate list in isolation, and every one of them would
// still pass if resolveReversal were never called — which is the exact shape of
// failure this subsystem was built to correct.

package commerce

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// seedReversalTenant creates a throwaway tenant with a unique slug.
//
// Not seedCatalogTenant: that one hardcodes its slug, so the second test to use
// it collides on tenants_slug_key.
func seedReversalTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'reversal-test', $2, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, "reversal-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
}

func TestARefundEventArrivingNormallyReversesTheRevenue(t *testing.T) {
	pool := newCatalogTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	seedReversalTenant(t, pool, tenantID)
	t.Cleanup(func() {
		admin, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		_, _ = admin.Exec(context.Background(), `DELETE FROM commerce_integrations WHERE tenant_id=$1::uuid`, tenantID)
		_ = admin.Commit(context.Background())
	})
	integrationID := seedCatalogIntegration(t, pool, tenantID)

	repo := &Repo{Pool: pool}
	sourceID := "order-" + uuid.NewString()[:8]
	email := "buyer-" + uuid.NewString()[:8] + "@example.test"
	at := time.Now().UTC()

	// A paid order arrives the ordinary way.
	if err := repo.UpsertOrder(ctx, tenantID, integrationID, OrderInput{
		SourceID: sourceID, CustomerEmail: email, Status: "paid",
		TotalCents: 12000, Currency: "usd", OrderedAt: &at,
	}); err != nil {
		t.Fatalf("upsert order: %v", err)
	}

	// It became revenue.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var conversionID int64
	var gross int64
	if err := tx.QueryRow(ctx, `
SELECT c.id, c.amount_cents
  FROM conversions c
  JOIN commerce_orders o ON o.id = c.commerce_order_id
 WHERE c.tenant_id = $1::uuid AND o.source_id = $2`, tenantID, sourceID).Scan(&conversionID, &gross); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("a paid order did not become revenue: %v", err)
	}
	if gross != 12000 {
		_ = tx.Rollback(ctx)
		t.Fatalf("revenue = %d, want 12000", gross)
	}
	_ = tx.Rollback(ctx)

	// Now the provider's refund event, shaped the way razorpayRefundEvent
	// shapes one: the order reference lives in metadata, not in a column.
	if err := repo.RecordProviderEvent(ctx, tenantID, integrationID, ProviderEventInput{
		EventType:       "refund_created",
		Provider:        "shopify",
		SourceID:        "re_" + uuid.NewString()[:8],
		ProviderEventID: "refund_created:" + uuid.NewString()[:8],
		Metadata: map[string]any{
			"order_id":     sourceID,
			"refund_cents": 12000,
			"currency":     "usd",
		},
	}); err != nil {
		t.Fatalf("record refund event: %v", err)
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	var kind string
	var reversed int64
	if err := read.QueryRow(ctx, `
SELECT kind, amount_cents FROM conversion_reversals
 WHERE tenant_id = $1::uuid AND conversion_id = $2`, tenantID, conversionID).Scan(&kind, &reversed); err != nil {
		t.Fatalf("the refund arrived and reversed nothing — revenue stays credited "+
			"after the money was handed back: %v", err)
	}
	if kind != "refund" || reversed != 12000 {
		t.Fatalf("reversal = %s / %d, want refund / 12000", kind, reversed)
	}
}
