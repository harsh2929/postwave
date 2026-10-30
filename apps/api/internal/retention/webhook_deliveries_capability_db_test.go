// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The sweep may purge expired deliveries. A tenant may not erase its own.
//
// `sweepInboundWebhookDeliveries` runs on the application pool as
// `postwave_app`, which held no DELETE on `webhook_deliveries`, so every sweep
// raised "permission denied". Delivery rows carry request and response bodies:
// a window that is never enforced means third-party payloads retained
// indefinitely past the point the product promised to drop them.
//
// This drives the REAL sweep, not just the policy — the export fix's third
// mutation showed that asserting the RLS contract alone leaves the code path
// that depends on it uncovered.
func TestTheWebhookDeliverySweepPurgesAndOnlyItCan(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping webhook delivery retention test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'wh-retention', 'wh-retention-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	// webhook_deliveries.webhook_id is a foreign key, so the parent must exist.
	var webhookID string
	if err := seed.QueryRow(ctx, `
INSERT INTO webhooks (tenant_id, url, secret_hash)
VALUES ($1::uuid, 'https://example.invalid/hook', 'x')
RETURNING id::text`, tenantID).Scan(&webhookID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed webhook: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO webhook_deliveries (webhook_id, tenant_id, event, at)
VALUES ($2::uuid, $1::uuid, 'probe.event', now() - interval '400 days')`,
		tenantID, webhookID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed delivery: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		cx, cerr := db.WithTenant(bg, pool, tenantID)
		if cerr != nil {
			return
		}
		defer func() { _ = cx.Rollback(bg) }()
		_, _ = cx.Exec(bg, `SELECT set_config('app.retention_worker', 'true', true)`)
		_, _ = cx.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cx.Commit(bg)
	})

	// An ordinary tenant request must not erase delivery evidence.
	plain, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant(plain): %v", err)
	}
	tag, plainErr := plain.Exec(ctx, `DELETE FROM webhook_deliveries WHERE tenant_id = $1::uuid`, tenantID)
	if plainErr == nil && tag.RowsAffected() > 0 {
		_ = plain.Rollback(ctx)
		t.Fatalf("an ordinary request deleted %d delivery row(s); the grant added "+
			"for retention has become a way for a tenant to erase its own evidence",
			tag.RowsAffected())
	}
	_ = plain.Rollback(ctx)

	// The real sweep must purge it.
	sweeper := &Sweeper{Pool: pool}
	purged, err := sweeper.sweepInboundWebhookDeliveries(ctx, tenantID, 30)
	if err != nil {
		t.Fatalf("sweepInboundWebhookDeliveries: %v. Request and response bodies "+
			"are retained past the window the product promises.", err)
	}
	if purged != 1 {
		t.Fatalf("the sweep purged %d expired deliveries, want 1", purged)
	}
}
