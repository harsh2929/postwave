// SPDX-License-Identifier: AGPL-3.0-only

package analytics_integrations

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The cross-tenant sync sweep must actually see work.
//
// `DueForSync` runs with NO tenant GUC — it is a cross-tenant sweep — and sets
// `app.analytics_worker`. No policy read that GUC, so `tenant_id = NULL`, the
// query matched nothing, and no analytics integration was ever synced. The
// failure is indistinguishable from an idle worker: no error, no partial
// result, just an empty batch forever.
//
// Fifth instance of this shape in the schema (1887, 1888, 1890, 1895): a worker
// runs under a capability no policy names.
func TestTheSyncSweepSeesIntegrationsAndCannotWriteThem(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping analytics worker discovery test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'analytics-sweep', 'analytics-sweep-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO analytics_integrations (tenant_id, provider, name, status)
VALUES ($1::uuid, 'segment', 'Segment', 'connected')`, tenantID); err != nil {
		t.Fatalf("seed integration: %v", err)
	}

	// The worker's own scope: capability set, no tenant.
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', '', true),
		        set_config('app.analytics_worker', 'true', true)`); err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	var visible int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM analytics_integrations WHERE tenant_id = $1::uuid`, tenantID).Scan(&visible); err != nil {
		t.Fatalf("worker discovery: %v", err)
	}
	if visible != 1 {
		t.Fatalf("the cross-tenant sweep sees %d integrations, want 1. It returns an "+
			"empty batch forever and nothing is ever synced — which looks exactly "+
			"like a healthy idle worker.", visible)
	}

	// Discovery only. The sweep re-scopes per tenant for every write, and a bug
	// in one tenant's sync must not be able to touch another's configuration.
	tag, err := tx.Exec(ctx,
		`UPDATE analytics_integrations SET status = 'paused' WHERE tenant_id = $1::uuid`, tenantID)
	if err == nil && tag.RowsAffected() > 0 {
		t.Fatalf("the sweep modified %d integration(s) cross-tenant; discovery has "+
			"become a write capability", tag.RowsAffected())
	}
}
