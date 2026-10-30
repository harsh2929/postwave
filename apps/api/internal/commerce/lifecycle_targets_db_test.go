// SPDX-License-Identifier: AGPL-3.0-only

package commerce

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The lifecycle worker's target query ordered a SELECT DISTINCT by columns it
// did not select, which Postgres rejects (SQLSTATE 42P10), so every tick failed
// and no back-in-stock or price-drop watcher was ever evaluated. Nothing ran
// the query. This runs it through the worker's own method, as the app role.
func TestLifecycleEvaluationTargetsRunAndDeduplicateDB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed lifecycle target test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	connected, disconnected := seedLifecycleTargets(t, ctx, pool, tenantID)

	targets, err := (&Repo{Pool: pool}).ListLifecycleEvaluationTargets(ctx, 2000)
	if err != nil {
		t.Fatalf("ListLifecycleEvaluationTargets: %v", err)
	}
	var mine []string
	for _, target := range targets {
		if target.TenantID == tenantID {
			mine = append(mine, target.IntegrationID)
		}
	}
	// A waiting back-in-stock subscription and a watching price-drop watcher on
	// the same integration are one target; a disconnected integration is none.
	if len(mine) != 1 || mine[0] != connected {
		t.Fatalf("targets for the tenant = %v, want only the connected integration %s (disconnected %s excluded)",
			mine, connected, disconnected)
	}
}

func seedLifecycleTargets(t *testing.T, ctx context.Context, pool *db.Pool, tenantID string) (connected, disconnected string) {
	t.Helper()
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	slug := "lifecycle-" + tenantID[:8]
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	integration := func(status, shop string) string {
		var id string
		if err := tx.QueryRow(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status)
VALUES ($1::uuid, 'shopify', $2, $3) RETURNING id::text`, tenantID, shop, status).Scan(&id); err != nil {
			t.Fatalf("insert %s integration: %v", status, err)
		}
		return id
	}
	product := func(integrationID, sourceID string) string {
		var id string
		if err := tx.QueryRow(ctx, `
INSERT INTO commerce_products (tenant_id, integration_id, source_id, title)
VALUES ($1::uuid, $2::uuid, $3, $3) RETURNING id::text`, tenantID, integrationID, sourceID).Scan(&id); err != nil {
			t.Fatalf("insert product: %v", err)
		}
		return id
	}
	waiting := func(integrationID, productID string) {
		if _, err := tx.Exec(ctx, `
INSERT INTO back_in_stock_subscriptions (tenant_id, integration_id, product_id, subscriber_email, status)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'waiter@example.test', 'waiting')`, tenantID, integrationID, productID); err != nil {
			t.Fatalf("insert back-in-stock subscription: %v", err)
		}
	}

	connected = integration("connected", slug+"-a.example.test")
	connectedProduct := product(connected, "sku-a")
	waiting(connected, connectedProduct)
	if _, err := tx.Exec(ctx, `
INSERT INTO price_drop_watchers (tenant_id, integration_id, product_id, subscriber_email, original_price_cents, min_drop_percent, status)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'watcher@example.test', 1000, 10, 'watching')`, tenantID, connected, connectedProduct); err != nil {
		t.Fatalf("insert price-drop watcher: %v", err)
	}
	disconnected = integration("disconnected", slug+"-b.example.test")
	waiting(disconnected, product(disconnected, "sku-b"))
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx2, err := db.WithTenant(ctx2, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx2.Rollback(ctx2) }()
		_, _ = tx2.Exec(ctx2, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = tx2.Commit(ctx2)
	})
	return connected, disconnected
}
