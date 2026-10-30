// SPDX-License-Identifier: AGPL-3.0-only
//
// catalog_backfill_listener_db_test.go — pg-backed test for SUB-013: the
// catalog-attributes listener, fired from the commerce-event ingest path,
// recomputes favorite_category + last_viewed_sku onto
// subscriber_computed_traits from sample commerce_events. Skips cleanly
// without DATABASE_URL, matching the project-wide pg-backed test convention
// (merge/apply_db_test.go).

package commerce

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newCatalogTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed catalog backfill test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedCatalogTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'catalog-backfill-test', 'catalog-backfill-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// seedCatalogIntegration creates a shopify integration and returns its id.
func seedCatalogIntegration(t *testing.T, pool *pgxpool.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	shop := fmt.Sprintf("catalog-%d.myshopify.com", time.Now().UnixNano())
	if err := tx.QueryRow(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status)
VALUES ($1::uuid, 'shopify', $2, 'connected')
RETURNING id::text`, tenantID, shop).Scan(&id); err != nil {
		t.Fatalf("seed integration: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit integration seed: %v", err)
	}
	return id
}

func seedCatalogSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

func seedCommerceEvent(t *testing.T, pool *pgxpool.Pool, tenantID, integrationID, email string, meta map[string]any, at time.Time) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	raw, _ := json.Marshal(meta)
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, customer_email, metadata, at)
VALUES ($1::uuid, $2::uuid, 'order_created', $3, $4::jsonb, $5)`,
		tenantID, integrationID, email, string(raw), at); err != nil {
		t.Fatalf("seed commerce event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit event seed: %v", err)
	}
}

func readTrait(t *testing.T, pool *pgxpool.Pool, tenantID, subscriberID, key string) (string, bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var value string
	err = tx.QueryRow(ctx, `
SELECT value::text FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = $3`,
		tenantID, subscriberID, key).Scan(&value)
	if err != nil {
		return "", false
	}
	_ = tx.Commit(ctx)
	return value, true
}

// TestCatalogBackfillListener_ProducesAttributes pins SUB-013: firing the
// listener over sample commerce_events writes the expected favorite_category
// (highest-count category) + last_viewed_sku (most recent SKU) onto the
// subscriber's computed traits. Uses the synchronous listener so the
// assertion does not race the production goroutine.
func TestCatalogBackfillListener_ProducesAttributes(t *testing.T) {
	pool := newCatalogTestPool(t)
	const tenantID = "00000000-0000-4000-8000-0099b71fc0de"
	seedCatalogTenant(t, pool, tenantID)
	integrationID := seedCatalogIntegration(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	email := fmt.Sprintf("catalog-shopper-%d@example.test", suffix)
	subID := seedCatalogSubscriber(t, pool, tenantID, email)

	base := time.Now().UTC().Add(-24 * time.Hour)
	// Two "shoes" touches and one "hats"; shoes should win. The most recent
	// SKU is SKU-LATEST.
	seedCommerceEvent(t, pool, tenantID, integrationID, email,
		map[string]any{"category": "shoes", "sku": "SKU-A"}, base)
	seedCommerceEvent(t, pool, tenantID, integrationID, email,
		map[string]any{"category": "shoes", "sku": "SKU-B"}, base.Add(time.Hour))
	seedCommerceEvent(t, pool, tenantID, integrationID, email,
		map[string]any{"category": "hats", "sku": "SKU-LATEST"}, base.Add(2*time.Hour))

	repo := &Repo{Pool: pool}
	repo.CatalogBackfill = NewSyncCatalogBackfillListener(repo, nil)

	// Drive the same internal hook the ingest paths call. Synchronous
	// listener → the traits are written by the time Trigger returns.
	repo.triggerCatalogBackfill(tenantID)
	repo.CatalogBackfill.Wait()

	favRaw, ok := readTrait(t, pool, tenantID, subID, "favorite_category")
	if !ok {
		t.Fatal("favorite_category trait was not written by the listener")
	}
	var fav FavoriteCategory
	if err := json.Unmarshal([]byte(favRaw), &fav); err != nil {
		t.Fatalf("favorite_category not JSON: %v (%s)", err, favRaw)
	}
	if fav.Category != "shoes" || fav.Count != 2 {
		t.Fatalf("favorite_category = %+v, want shoes/2", fav)
	}

	skuRaw, ok := readTrait(t, pool, tenantID, subID, "last_viewed_sku")
	if !ok {
		t.Fatal("last_viewed_sku trait was not written by the listener")
	}
	var sku string
	if err := json.Unmarshal([]byte(skuRaw), &sku); err != nil {
		t.Fatalf("last_viewed_sku not JSON: %v (%s)", err, skuRaw)
	}
	if sku != "SKU-LATEST" {
		t.Fatalf("last_viewed_sku = %q, want SKU-LATEST", sku)
	}
}
