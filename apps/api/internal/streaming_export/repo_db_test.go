// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for the SUB-111 streaming-export gaps:
//
//   - fetchEventBatch honors the connection's configured event-type
//     filters (config.field_filters) so a connection scoped to a subset
//     of event types never ships the others;
//   - Repo.StreamingExportTenants enumerates the distinct tenant ids that
//     own an active streaming-export connection (cross-tenant, under the
//     worker_select gate from migration 1117).
//
// Skip without DATABASE_URL (the established pg-backed pattern, mirroring
// analytics/followup_surfaces_db_test.go). Fixtures live under throwaway
// tenants; cleanup is the tenant DELETE (warehouse_connections /
// subscriber_events / subscribers / streaming_export_runs all cascade on
// tenant_id).

package streaming_export

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func seDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed streaming-export tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func seTenant(t *testing.T, pool *db.Pool, ctx context.Context) string {
	t.Helper()
	tenantID := seUUID(t)
	slug := "se-" + tenantID[:8]
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("bind tenant guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
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
	return tenantID
}

// seExec runs one statement inside a tenant-bound tx + commits.
func seExec(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, sql string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("exec %.60s...: %v", sql, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
}

func seConnection(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, name, status string) string {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO warehouse_connections (tenant_id, name, provider, direction, status, config, cadence)
VALUES ($1::uuid, $2, $3, 'export', $4, '{}'::jsonb, 'hourly')
RETURNING id::text`, tenantID, name, ProviderStreamingExport, status).Scan(&id); err != nil {
		t.Fatalf("insert connection: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit connection: %v", err)
	}
	return id
}

func seEvent(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, email, eventType string, at time.Time) {
	t.Helper()
	seExec(t, pool, ctx, tenantID, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2, $3, $4::timestamptz)`, tenantID, email, eventType, at)
}

// TestFetchEventBatchHonorsEventTypeFilters proves that when a
// connection's config carries event-type filters, only those event types
// are read by the batch query — the core gap (#1) closed by this change.
func TestFetchEventBatchHonorsEventTypeFilters(t *testing.T) {
	pool := seDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seTenant(t, pool, ctx)
	repo := &Repo{Pool: pool}

	email := "filt-" + tenantID[:8] + "@example.com"
	base := time.Now().UTC().Add(-30 * time.Minute)
	// Spread one of each type across the window.
	seEvent(t, pool, ctx, tenantID, email, "opened", base.Add(1*time.Minute))
	seEvent(t, pool, ctx, tenantID, email, "clicked", base.Add(2*time.Minute))
	seEvent(t, pool, ctx, tenantID, email, "bounced", base.Add(3*time.Minute))
	seEvent(t, pool, ctx, tenantID, email, "unsubscribed", base.Add(4*time.Minute))

	windowStart := base.Add(-1 * time.Minute)
	windowEnd := base.Add(10 * time.Minute)

	run := func(filters []string) []string {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		rows, err := repo.fetchEventBatch(ctx, tx, tenantID, windowStart, windowEnd, 1000, filters)
		if err != nil {
			t.Fatalf("fetchEventBatch(%v): %v", filters, err)
		}
		_ = tx.Commit(ctx)
		got := make([]string, 0, len(rows))
		for _, r := range rows {
			got = append(got, r.EventType)
		}
		sort.Strings(got)
		return got
	}

	// No filter → every event type ships.
	all := run(nil)
	if len(all) != 4 {
		t.Fatalf("no-filter batch = %v, want 4 rows", all)
	}

	// Filter to a subset → only those types ship.
	subset := run([]string{"opened", "clicked"})
	want := []string{"clicked", "opened"}
	if len(subset) != len(want) {
		t.Fatalf("filtered batch = %v, want %v", subset, want)
	}
	for i := range want {
		if subset[i] != want[i] {
			t.Fatalf("filtered batch = %v, want %v", subset, want)
		}
	}

	// Filter to a single type → exactly that type, no others.
	single := run([]string{"bounced"})
	if len(single) != 1 || single[0] != "bounced" {
		t.Fatalf("single-filter batch = %v, want [bounced]", single)
	}

	// Filter to a type with no events in the window → empty batch.
	none := run([]string{"complained"})
	if len(none) != 0 {
		t.Fatalf("non-matching filter batch = %v, want empty", none)
	}
}

// TestStreamingExportTenantsListsActiveConnections proves the
// TenantLister returns exactly the tenants that own an active
// streaming-export connection — gap (#3), the cross-tenant enumeration
// the scheduled worker depends on (migration 1117 worker_select gate).
func TestStreamingExportTenantsListsActiveConnections(t *testing.T) {
	pool := seDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	repo := &Repo{Pool: pool}

	// Tenant A: one active streaming-export connection → must appear.
	tenantActive := seTenant(t, pool, ctx)
	seConnection(t, pool, ctx, tenantActive, "active-se", "active")

	// Tenant B: only a paused streaming-export connection → must NOT appear.
	tenantPaused := seTenant(t, pool, ctx)
	seConnection(t, pool, ctx, tenantPaused, "paused-se", "paused")

	// Tenant C: an active connection of a DIFFERENT provider → must NOT
	// appear (the enumeration is provider-scoped).
	tenantOther := seTenant(t, pool, ctx)
	seExec(t, pool, ctx, tenantOther, `
INSERT INTO warehouse_connections (tenant_id, name, provider, direction, status, config, cadence)
VALUES ($1::uuid, 'other', 's3', 'export', 'active', '{}'::jsonb, 'hourly')`, tenantOther)

	got, err := repo.StreamingExportTenants(ctx)
	if err != nil {
		t.Fatalf("StreamingExportTenants: %v", err)
	}
	set := make(map[string]bool, len(got))
	for _, id := range got {
		set[id] = true
	}
	if !set[tenantActive] {
		t.Fatalf("active streaming-export tenant %s missing from %v", tenantActive, got)
	}
	if set[tenantPaused] {
		t.Fatalf("paused-only tenant %s should not be listed", tenantPaused)
	}
	if set[tenantOther] {
		t.Fatalf("non-streaming-provider tenant %s should not be listed", tenantOther)
	}
}
