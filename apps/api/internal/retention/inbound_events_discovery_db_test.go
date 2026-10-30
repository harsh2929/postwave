// SPDX-License-Identifier: AGPL-3.0-only

package retention

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestInboundEventRetentionDiscovery_DB proves the complete RLS path:
// unscoped callers see no events, a transaction-local worker can discover the
// owning tenant but cannot delete, and the tenant-scoped retention path can
// remove only expired rows.
func TestInboundEventRetentionDiscovery_DB(t *testing.T) {
	appURL := os.Getenv("DATABASE_URL")
	if appURL == "" {
		t.Skip("DATABASE_URL not set; skipping inbound-event retention RLS integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	appConfig, err := pgxpool.ParseConfig(appURL)
	if err != nil {
		t.Fatalf("parse app database URL: %v", err)
	}
	// A single connection makes the recycled-session regression deterministic:
	// listTenants must survive a prior tenant-scoped SET LOCAL leaving an empty
	// custom-GUC placeholder on that same PostgreSQL session.
	appConfig.MaxConns = 1
	app, err := pgxpool.NewWithConfig(ctx, appConfig)
	if err != nil {
		t.Fatalf("connect app pool: %v", err)
	}
	t.Cleanup(app.Close)

	var bypassRLS, appRole bool
	if err := app.QueryRow(ctx, `
SELECT r.rolsuper OR r.rolbypassrls,
       pg_has_role(current_user, 'postwave_app', 'member')
  FROM pg_roles r
 WHERE r.rolname = current_user`).Scan(&bypassRLS, &appRole); err != nil {
		t.Fatalf("inspect application database role: %v", err)
	}
	if bypassRLS || !appRole {
		t.Skip("DATABASE_URL must use a non-BYPASSRLS role covered by postwave_app policies")
	}

	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = appURL
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin pool: %v", err)
	}
	t.Cleanup(admin.Close)

	var policyExists bool
	if err := admin.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = 'inbound_events'
       AND policyname = 'inbound_events_retention_worker_select'
)`).Scan(&policyExists); err != nil {
		t.Fatalf("inspect migration 1787 policy: %v", err)
	}
	if !policyExists {
		t.Fatalf("migration 1787 is not applied to this integration database")
	}

	tenantID := uuid.NewString()
	endpointID := uuid.NewString()
	slug := "retention-rls-" + uuid.NewString()
	// One scoped CONNECTION for every seed, not a bare pool Exec.
	//
	// `POSTWAVE_ADMIN_DATABASE_URL` is optional and falls back to the app URL,
	// where `tenant_isolation_insert` requires id = current_setting('app.tenant_id')
	// and inbound_webhook_endpoints has the matching tenant policy. The bare
	// Execs left that unset, so every seed was rejected and the Skipf reported
	// it as a PASS — in a test whose entire subject is RLS. Seeding THROUGH the
	// policy exercises the path production uses; the assertions below still run
	// as the app role.
	seedConn, seedErr := admin.Acquire(ctx)
	if seedErr != nil {
		t.Fatalf("acquire retention seed conn: %v", seedErr)
	}
	defer seedConn.Release()
	if _, err := seedConn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant scope for seed: %v", err)
	}
	if _, err := seedConn.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'inbound-event-retention-rls-test', $2, 'studio')`,
		tenantID, "inbound-event-retention-"+tenantID); err != nil {
		t.Fatalf("seed retention tenant: %v", err)
	}
	// Bound explicitly. The bare `admin.Exec` DELETE this replaces carried no
	// tenant binding of its own: it matched the row only when the pool happened
	// to hand it the seed connection above, whose session-level app.tenant_id
	// survived its release. On any other connection the tenants DELETE policy
	// hides the row, and the tenant leaked without an error.
	t.Cleanup(func() { deleteRetentionTestTenant(t, admin, tenantID) })
	if _, err := seedConn.Exec(ctx, `
INSERT INTO inbound_webhook_endpoints (id, tenant_id, slug, secret, name, enabled)
VALUES ($1::uuid, $2::uuid, $3, 'integration-test-secret', 'Retention RLS test', true)`,
		endpointID, tenantID, slug); err != nil {
		t.Fatalf("seed inbound endpoint: %v", err)
	}
	if _, err := seedConn.Exec(ctx, `
INSERT INTO inbound_events (
    tenant_id, endpoint_id, headers, body_bytes, signature_valid,
    received_at, source_event_id
) VALUES
    ($1::uuid, $2::uuid, '{}'::jsonb, '{"age":"expired"}'::text::bytea, true,
     now() - interval '10 days', $3),
    ($1::uuid, $2::uuid, '{}'::jsonb, '{"age":"fresh"}'::text::bytea, true,
     now(), $4)`, tenantID, endpointID, "expired-"+tenantID, "fresh-"+tenantID); err != nil {
		t.Fatalf("seed inbound events: %v", err)
	}

	var unscopedCount int
	if err := app.QueryRow(ctx,
		`SELECT count(*) FROM inbound_events WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&unscopedCount); err != nil {
		t.Fatalf("unscoped inbound-event read: %v", err)
	}
	if unscopedCount != 0 {
		t.Fatalf("unscoped caller saw %d inbound events; want 0", unscopedCount)
	}

	// WORKER scope, deliberately — this block asserts that a cross-tenant worker
	// can SELECT inbound events but cannot DELETE them. A tenant transaction
	// here would legitimately be allowed to delete, turning the assertion into
	// a test of nothing.
	workerTx, err := db.WithWorkerScope(ctx, app)
	if err != nil {
		t.Fatalf("begin worker discovery: %v", err)
	}
	var workerCount int
	if err := workerTx.QueryRow(ctx,
		`SELECT count(*) FROM inbound_events WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&workerCount); err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("worker inbound-event read: %v", err)
	}
	if workerCount != 2 {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("worker saw %d inbound events; want 2", workerCount)
	}
	deleteTag, err := workerTx.Exec(ctx,
		`DELETE FROM inbound_events WHERE tenant_id = $1::uuid`, tenantID)
	if err != nil {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("worker DELETE should be denied as zero visible rows, got error: %v", err)
	}
	if deleted := deleteTag.RowsAffected(); deleted != 0 {
		_ = workerTx.Rollback(ctx)
		t.Fatalf("worker DELETE affected %d rows; SELECT-only policy was broadened", deleted)
	}
	if err := workerTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback worker discovery: %v", err)
	}

	recycledTx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatalf("prime recycled tenant session: %v", err)
	}
	if err := recycledTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback recycled tenant session: %v", err)
	}

	sweeper := &Sweeper{Pool: app, BatchSize: 1, MaxBatchesPerTenant: 4}
	tenants, err := sweeper.listTenants(ctx)
	if err != nil {
		t.Fatalf("list retention tenants: %v", err)
	}
	if !slices.Contains(tenants, tenantID) {
		t.Fatalf("inbound-event tenant %s was not discovered; got %v", tenantID, tenants)
	}
	purged, err := sweeper.sweepInboundWebhookEvents(ctx, tenantID, 1)
	if err != nil {
		t.Fatalf("sweep inbound events: %v", err)
	}
	if purged != 1 {
		t.Fatalf("purged inbound events = %d, want 1 expired row", purged)
	}

	verifyTx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatalf("begin tenant verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(ctx) }()
	var expired, fresh int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE received_at < now() - interval '1 day'),
       count(*) FILTER (WHERE received_at >= now() - interval '1 day')
  FROM inbound_events
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&expired, &fresh); err != nil {
		t.Fatalf("verify inbound-event retention: %v", err)
	}
	if expired != 0 || fresh != 1 {
		t.Fatalf("retention result expired=%d fresh=%d; want expired=0 fresh=1", expired, fresh)
	}
}
