// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed integration tests for the Repo. Mirrors the
// DATABASE_URL-skip pattern used elsewhere — runs in CI when a live
// Postgres is wired, t.Skip otherwise.

package apikeycalls

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// newApiKeyCallsTestPool opens the pool the way the API does (db.New), so the
// repository runs on connections configured like production's: among other
// things, a GUC a statement leaves set on a session is reset when the
// connection goes back to the pool.
func newApiKeyCallsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed apikeycalls tests")
	}
	pool, err := db.New(context.Background(), url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randHexBytes(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

// seedTenant creates a tenant + returns (tenantID, cleanup). The
// cleanup deletes the tenant, and the ON DELETE CASCADE from tenants removes
// its api_key_calls rows: a tenant session cannot delete them itself
// (migration 2048).
//
// app.tenant_id is bound for the transaction only (set_config(..., true)),
// never for the session. This helper used to bind it for the session on a
// pooled connection, and the binding outlived the helper: every later statement
// on that connection saw this tenant's rows through RLS, including the
// retention purge, which is meant to run with no tenant at all. The purge test
// passed for that reason alone while the real sweeper deleted nothing.
func seedTenant(t *testing.T, pool *pgxpool.Pool) (string, func()) {
	t.Helper()
	ctx := context.Background()
	var id string
	if err := pool.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed tenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, id); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		id, "apikc-test-"+randHexBytes(t, 4), "apikc test"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed tenant: %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		tx, err := pool.Begin(ctx)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(ctx) }()
		_, _ = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, id)
		_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
		_ = tx.Commit(ctx)
	}
	return id, cleanup
}

func seedAPIKey(t *testing.T, pool *pgxpool.Pool, tenantID, prefix string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed API key: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("set API-key tenant scope: %v", err)
	}
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO api_keys (tenant_id, label, prefix, key_hash, scopes)
VALUES ($1::uuid, 'stats prefix fixture', $2, $3, '{}')
RETURNING id::text`, tenantID, prefix, randHexBytes(t, 32)).Scan(&id); err != nil {
		t.Fatalf("seed API key: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed API key: %v", err)
	}
	return id
}

func deleteAPIKey(t *testing.T, pool *pgxpool.Pool, tenantID, keyID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin delete API key: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("set API-key delete tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM api_keys WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, keyID); err != nil {
		t.Fatalf("delete API key: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit delete API key: %v", err)
	}
}

func TestRepo_InsertAndList_BasicRoundTrip(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}

	call := &Call{
		TenantID:   tenantID,
		Method:     "GET",
		Path:       "/api/v1/subscribers",
		ToolName:   "subscribers_list",
		StatusCode: 200,
		LatencyMs:  42,
		UserAgent:  "postwave-mcp-server/0.1.0",
		RemoteIP:   "1.2.3.4",
	}
	if err := repo.Insert(context.Background(), call); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	rows, err := repo.List(context.Background(), ListFilter{TenantID: tenantID})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	got := rows[0]
	if got.Method != "GET" || got.Path != "/api/v1/subscribers" || got.ToolName != "subscribers_list" {
		t.Errorf("scan: got %+v", got)
	}
	if got.StatusCode != 200 || got.LatencyMs != 42 {
		t.Errorf("status/latency: got %d / %d", got.StatusCode, got.LatencyMs)
	}
}

func TestRepo_List_MCPOnlyFilter(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "postwave-mcp-server/1.0.0",
	})
	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "curl/8.0",
	})
	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "POSTWAVE-MCP-SERVER/2.0.0", // uppercase is normalized by the strict classifier
	})
	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "postwave-mcp-server/garbage", // forged prefix must not poison MCP-only responses
	})

	// MCPOnly: should match the two postwave-mcp-server entries.
	mcp, err := repo.List(ctx, ListFilter{TenantID: tenantID, MCPOnly: true})
	if err != nil {
		t.Fatalf("List MCP: %v", err)
	}
	if len(mcp) != 2 {
		t.Errorf("MCPOnly = %d, want 2", len(mcp))
	}

	// All: includes the forged prefix as ordinary/unverified traffic.
	all, err := repo.List(ctx, ListFilter{TenantID: tenantID})
	if err != nil {
		t.Fatalf("List all: %v", err)
	}
	if len(all) != 4 {
		t.Errorf("All = %d, want 4", len(all))
	}
}

func TestRepo_List_RespectsLimitAndCursor(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	for i := 0; i < 5; i++ {
		mustInsert(t, repo, &Call{
			TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
			UserAgent: "postwave-mcp-server/1.0.0",
		})
	}

	first, err := repo.List(ctx, ListFilter{TenantID: tenantID, Limit: 2})
	if err != nil {
		t.Fatalf("List page 1: %v", err)
	}
	if len(first) != 2 {
		t.Fatalf("page 1 = %d, want 2", len(first))
	}
	second, err := repo.List(ctx, ListFilter{
		TenantID: tenantID, Limit: 2, BeforeID: first[len(first)-1].ID,
	})
	if err != nil {
		t.Fatalf("List page 2: %v", err)
	}
	if len(second) != 2 {
		t.Fatalf("page 2 = %d, want 2", len(second))
	}
	// Pages should not overlap.
	if first[0].ID == second[0].ID {
		t.Error("page 1 and page 2 share their first row")
	}
}

func TestRepoListUntilPlaceholderComposition(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "postwave-mcp-server/1.0.0",
	})

	until := time.Now().UTC().Add(time.Minute)
	rows, err := repo.List(context.Background(), ListFilter{
		TenantID: tenantID,
		Until:    &until,
		Limit:    1,
	})
	if err != nil {
		t.Fatalf("until-only query placeholder drift: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("until-only rows=%d want=1", len(rows))
	}
	rows, err = repo.List(context.Background(), ListFilter{
		TenantID: tenantID,
		Until:    &until,
		BeforeID: rows[0].ID + 1,
		Limit:    1,
	})
	if err != nil || len(rows) != 1 {
		t.Fatalf("until+cursor query placeholder drift: rows=%d err=%v", len(rows), err)
	}
}

func TestRepo_GetStats_HeadlineAggregates(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	// 3 successes, 1 4xx, 1 5xx.
	for _, sc := range []int{200, 201, 200, 404, 500} {
		mustInsert(t, repo, &Call{
			TenantID:   tenantID,
			Method:     "GET",
			Path:       "/x",
			ToolName:   "x_tool",
			StatusCode: sc,
			LatencyMs:  10 * sc / 100, // arbitrary spread
			UserAgent:  "postwave-mcp-server/1.0.0",
		})
	}

	stats, err := repo.GetStats(ctx, tenantID, true, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	if stats.TotalCalls != 5 {
		t.Errorf("total = %d, want 5", stats.TotalCalls)
	}
	if stats.SuccessfulCalls != 3 {
		t.Errorf("successful = %d, want 3", stats.SuccessfulCalls)
	}
	wantRate := 3.0 / 5.0
	if stats.SuccessRate < wantRate-1e-6 || stats.SuccessRate > wantRate+1e-6 {
		t.Errorf("success rate = %f, want %f", stats.SuccessRate, wantRate)
	}
	if stats.LastCallAt == nil {
		t.Error("last call at not set")
	}
	if len(stats.TopTools) != 1 || stats.TopTools[0].ToolName != "x_tool" {
		t.Errorf("top tools = %+v", stats.TopTools)
	}
	// Status breakdown: expect classes 2 (3 hits), 4 (1), 5 (1).
	byClass := map[int]int{}
	for _, sf := range stats.StatusBreakdown {
		byClass[sf.Class] = sf.Calls
	}
	if byClass[2] != 3 || byClass[4] != 1 || byClass[5] != 1 {
		t.Errorf("status breakdown wrong: %+v", byClass)
	}
}

func TestRepoGetStatsJoinsLivePrefixAndKeepsRemovedKeyFallback(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}

	liveID := seedAPIKey(t, pool, tenantID, "pw_live_a1b2")
	mustInsert(t, repo, &Call{
		TenantID: tenantID, APIKeyID: &liveID, APIKeyPrefix: "",
		Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "postwave-mcp-server/1.0.0",
	})

	removedID := seedAPIKey(t, pool, tenantID, "pw_live_c3d4")
	mustInsert(t, repo, &Call{
		TenantID: tenantID, APIKeyID: &removedID, APIKeyPrefix: "pw_live_c3d4",
		Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "postwave-mcp-server/1.0.0",
	})
	deleteAPIKey(t, pool, tenantID, removedID)

	stats, err := repo.GetStats(context.Background(), tenantID, true, 7*24*time.Hour)
	if err != nil {
		t.Fatalf("GetStats: %v", err)
	}
	byPrefix := make(map[string]KeyFrequency, len(stats.TopAPIKeys))
	for _, key := range stats.TopAPIKeys {
		byPrefix[key.APIKeyPrefix] = key
	}
	if got, ok := byPrefix["pw_live_a1b2"]; !ok || got.APIKeyID == nil || *got.APIKeyID != liveID || got.Calls != 1 {
		t.Fatalf("live joined prefix missing: %+v", stats.TopAPIKeys)
	}
	if got, ok := byPrefix["pw_live_c3d4"]; !ok || got.APIKeyID != nil || got.Calls != 1 {
		t.Fatalf("removed-key frozen label missing/unsafe: %+v", stats.TopAPIKeys)
	}
}

func TestRepo_Trend_FillsEmptyBuckets(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", StatusCode: 200,
		UserAgent: "postwave-mcp-server/1.0.0",
	})

	points, err := repo.Trend(ctx, tenantID, true, 24*time.Hour)
	if err != nil {
		t.Fatalf("Trend: %v", err)
	}
	// Both boundaries come from the same DB timestamp and the current partial
	// hour is included, so 24h is exactly 25 points.
	if len(points) != 25 {
		t.Errorf("buckets = %d, want exactly 25", len(points))
	}
	var total int
	for _, p := range points {
		total += p.Calls
	}
	if total != 1 {
		t.Errorf("sum across buckets = %d, want 1", total)
	}
}

func TestRepoListAfterIDAppliesExactToolFilterAndIncludesCost(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}

	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", ToolName: "reports_list",
		StatusCode: 200, UserAgent: "postwave-mcp-server/1.2.3", CostMicros: 37,
	})
	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/x", ToolName: "campaigns_list",
		StatusCode: 200, UserAgent: "postwave-mcp-server/1.2.3", CostMicros: 91,
	})

	rows, err := repo.listAfterID(context.Background(), tenantID, 0, true, "reports_list", 10)
	if err != nil {
		t.Fatalf("listAfterID: %v", err)
	}
	if len(rows) != 1 || rows[0].ToolName != "reports_list" || rows[0].CostMicros != 37 {
		t.Fatalf("filtered live rows=%+v", rows)
	}
}

// PurgeOlderThan is the retention sweeper's statement: it deletes the expired
// rows of EVERY tenant, and the count it returns covers all of them. Every API
// test package shares one database in CI, so other tenants' rows can be
// expired too, and "purged exactly 1" was a claim about the whole database. This
// test asserts exactly what happened to its own rows, and holds the returned
// count to what it can prove regardless of anyone else's.
//
// It runs the purge as the sweeper does: in worker scope, with no tenant bound
// (see seedTenant). Under RLS a DELETE whose WHERE reads the table's columns
// sees only the rows a SELECT policy lets it see, as well as the rows a DELETE
// policy lets it delete.
func TestRepo_PurgeOlderThan_DeletesOldOnly(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	tenantID, cleanup := seedTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	// Three rows past the cutoff, the last by a minute, and two inside it, the
	// first by a minute. api_key_calls is intentionally append-only for tenant
	// requests, so the test must not rely on an UPDATE grant that production
	// correctly does not have.
	cutoff := time.Now().UTC().AddDate(0, 0, -90)
	mustInsertAt(t, pool, tenantID, "/expired-long-ago", cutoff.AddDate(0, 0, -10))
	mustInsertAt(t, pool, tenantID, "/expired-yesterday", cutoff.AddDate(0, 0, -1))
	mustInsertAt(t, pool, tenantID, "/expired-just", cutoff.Add(-time.Minute))
	mustInsertAt(t, pool, tenantID, "/retained-just", cutoff.Add(time.Minute))
	mustInsert(t, repo, &Call{
		TenantID: tenantID, Method: "GET", Path: "/new", StatusCode: 200,
	})
	const ownExpired = 3

	// The batch size bounds one call, and the count is the rows that call
	// deleted. At least this test's three rows are expired, so a batch of one
	// deletes exactly one row, whoever it belongs to.
	n, err := repo.PurgeOlderThan(ctx, cutoff, 1)
	if err != nil {
		t.Fatalf("PurgeOlderThan(batch 1): %v", err)
	}
	if n == 0 {
		t.Fatalf("the purge deleted nothing, although this test's %d rows are expired. "+
			"It runs in worker scope with no tenant bound, as the sweeper does: check that "+
			"a SELECT policy on api_key_calls lets the worker see expired rows, since the "+
			"DELETE policy alone does not", ownExpired)
	}
	if n != 1 {
		t.Errorf("a batch of 1 purged %d rows, want exactly 1 (at least %d rows are expired)", n, ownExpired)
	}

	// Then purge as the sweeper does, in full batches, until a batch comes back
	// short: no expired row was left when that batch ran.
	const batch = 1000
	purged := n
	for calls := 1; ; calls++ {
		n, err = repo.PurgeOlderThan(ctx, cutoff, batch)
		if err != nil {
			t.Fatalf("PurgeOlderThan(batch %d): %v", batch, err)
		}
		if n < 0 || n > batch {
			t.Fatalf("a batch of %d purged %d rows", batch, n)
		}
		purged += n
		if n < batch {
			break
		}
		if calls == 100 {
			t.Fatalf("still purging full batches after %d rows", purged)
		}
	}
	if purged < ownExpired {
		t.Errorf("purged %d rows in all, want at least this test's %d expired rows", purged, ownExpired)
	}

	remaining, err := repo.List(ctx, ListFilter{TenantID: tenantID})
	if err != nil {
		t.Fatalf("List after purge: %v", err)
	}
	paths := make(map[string]int, len(remaining))
	for _, row := range remaining {
		paths[row.Path]++
	}
	if len(remaining) != 2 || paths["/retained-just"] != 1 || paths["/new"] != 1 {
		t.Errorf("after purge, rows = %+v; want exactly /retained-just and /new", remaining)
	}
}

// The sweep binds no tenant, so one pass must reach the expired rows of every
// tenant, and leave each tenant's unexpired rows alone.
func TestRepo_PurgeOlderThan_ReachesEveryTenant(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	firstID, cleanupFirst := seedTenant(t, pool)
	defer cleanupFirst()
	secondID, cleanupSecond := seedTenant(t, pool)
	defer cleanupSecond()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	cutoff := time.Now().UTC().AddDate(0, 0, -90)
	tenants := []string{firstID, secondID}
	for _, tenantID := range tenants {
		mustInsertAt(t, pool, tenantID, "/expired", cutoff.Add(-time.Minute))
		mustInsertAt(t, pool, tenantID, "/retained", cutoff.Add(time.Minute))
	}

	const batch = 1000
	purged := 0
	for calls := 1; ; calls++ {
		n, err := repo.PurgeOlderThan(ctx, cutoff, batch)
		if err != nil {
			t.Fatalf("PurgeOlderThan(batch %d): %v", batch, err)
		}
		purged += n
		if n < batch {
			break
		}
		if calls == 100 {
			t.Fatalf("still purging full batches after %d rows", purged)
		}
	}
	if purged < len(tenants) {
		t.Errorf("purged %d rows in all, want at least the %d expired rows of this test's tenants", purged, len(tenants))
	}

	for i, tenantID := range tenants {
		rows, err := repo.List(ctx, ListFilter{TenantID: tenantID})
		if err != nil {
			t.Fatalf("List tenant %d after purge: %v", i+1, err)
		}
		if len(rows) != 1 || rows[0].Path != "/retained" {
			t.Errorf("tenant %d after purge: rows = %+v; want exactly /retained", i+1, rows)
		}
	}
}

// Migration 2048 opens call records across tenants to one capability only: the
// retention sweep's, app.retention_worker together with app.outbox_worker, as
// PurgeOlderThan binds them. This test holds every other scope postwave_app can
// open with no tenant, and another tenant's session, to reading and deleting
// none of a tenant's rows, and the tenant's own session to deleting none of
// them. The full retention scope must see and delete them all, so the
// refusals are not vacuous. Every transaction here rolls back.
func TestCrossTenantCallRecordsNeedTheRetentionCapability(t *testing.T) {
	pool := newApiKeyCallsTestPool(t)
	ownerID, cleanupOwner := seedTenant(t, pool)
	defer cleanupOwner()
	otherID, cleanupOther := seedTenant(t, pool)
	defer cleanupOther()
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	now := time.Now().UTC()
	mustInsertAt(t, pool, ownerID, "/owner-first", now)
	mustInsertAt(t, pool, ownerID, "/owner-second", now)
	mustInsertAt(t, pool, otherID, "/other", now)
	const ownerRows = 2

	setting := func(t *testing.T, tx pgx.Tx, name string) {
		t.Helper()
		if _, err := tx.Exec(ctx, `SELECT set_config($1, 'true', true)`, name); err != nil {
			t.Fatalf("set %s: %v", name, err)
		}
	}
	scopes := []struct {
		name  string
		begin func(t *testing.T) pgx.Tx
		// reads and deletes are how many of the owner's rows the scope may
		// read, and delete by a DELETE that names them.
		reads, deletes int
		// unfiltered is what a DELETE with no WHERE may remove in the scope, or
		// -1 to skip it: in the retention scope it would reach every tenant's
		// rows in the shared database.
		unfiltered int64
		// inserts is whether the scope may add a call record for the owner.
		// Only the owner's own session may: 2048's cross-tenant policy is
		// SELECT-only, and widening it to FOR ALL would let its USING clause
		// double as the WITH CHECK, so the retention scope could forge call
		// records for any tenant.
		inserts bool
	}{
		{
			name: "retention scope (app.outbox_worker and app.retention_worker)",
			begin: func(t *testing.T) pgx.Tx {
				tx, err := db.WithWorkerScope(ctx, pool)
				if err != nil {
					t.Fatalf("begin worker scope: %v", err)
				}
				setting(t, tx, "app.retention_worker")
				return tx
			},
			reads:      ownerRows,
			deletes:    ownerRows,
			unfiltered: -1,
		},
		{
			name: "plain worker scope (app.outbox_worker)",
			begin: func(t *testing.T) pgx.Tx {
				tx, err := db.WithWorkerScope(ctx, pool)
				if err != nil {
					t.Fatalf("begin worker scope: %v", err)
				}
				return tx
			},
		},
		{
			name: "app.retention_worker without the worker scope",
			begin: func(t *testing.T) pgx.Tx {
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatalf("begin: %v", err)
				}
				setting(t, tx, "app.retention_worker")
				return tx
			},
		},
		{
			name: "another tenant's session",
			begin: func(t *testing.T) pgx.Tx {
				tx, err := db.WithTenant(ctx, pool, otherID)
				if err != nil {
					t.Fatalf("begin other tenant: %v", err)
				}
				return tx
			},
		},
		{
			// The table is append-only for tenant requests: the tenant reads
			// its own rows and deletes none of them.
			name: "the owner's own session",
			begin: func(t *testing.T) pgx.Tx {
				tx, err := db.WithTenant(ctx, pool, ownerID)
				if err != nil {
					t.Fatalf("begin owner tenant: %v", err)
				}
				return tx
			},
			reads:   ownerRows,
			inserts: true,
		},
	}
	for _, sc := range scopes {
		t.Run(sc.name, func(t *testing.T) {
			tx := sc.begin(t)
			defer func() { _ = tx.Rollback(ctx) }()

			// Probe an INSERT for the owner inside a savepoint, so the counts
			// below see the owner's two seeded rows whatever the probe does.
			if _, err := tx.Exec(ctx, `SAVEPOINT probe_insert`); err != nil {
				t.Fatalf("savepoint: %v", err)
			}
			_, insErr := tx.Exec(ctx, `
INSERT INTO api_key_calls (tenant_id, method, path, status_code, latency_ms)
VALUES ($1::uuid, 'GET', '/forged', 200, 0)`, ownerID)
			if sc.inserts {
				if insErr != nil {
					t.Errorf("the owner's session cannot add its own call record: %v", insErr)
				}
			} else {
				var pgErr *pgconn.PgError
				if !errors.As(insErr, &pgErr) || pgErr.Code != "42501" {
					t.Errorf("the scope adds a call record for the owner (err %v); want "+
						"SQLSTATE 42501, a row-level security refusal", insErr)
				}
			}
			if _, err := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT probe_insert`); err != nil {
				t.Fatalf("roll back the insert probe: %v", err)
			}

			var visible int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM api_key_calls WHERE tenant_id = $1::uuid`, ownerID).Scan(&visible); err != nil {
				t.Fatalf("count the owner's rows: %v", err)
			}
			if visible != sc.reads {
				t.Errorf("the scope reads %d of the owner's rows, want %d", visible, sc.reads)
			}
			tag, err := tx.Exec(ctx, `DELETE FROM api_key_calls WHERE tenant_id = $1::uuid`, ownerID)
			if err != nil {
				t.Fatalf("delete the owner's rows: %v", err)
			}
			if got := tag.RowsAffected(); got != int64(sc.deletes) {
				t.Errorf("the scope deletes %d of the owner's rows, want %d", got, sc.deletes)
			}
			if sc.unfiltered < 0 {
				return
			}
			// A DELETE with no WHERE reads no column, so no SELECT policy
			// applies: only the DELETE policies decide which rows it removes.
			tag, err = tx.Exec(ctx, `DELETE FROM api_key_calls`)
			if err != nil {
				t.Fatalf("unfiltered delete: %v", err)
			}
			if got := tag.RowsAffected(); got != sc.unfiltered {
				t.Errorf("an unfiltered DELETE removes %d rows, want %d", got, sc.unfiltered)
			}
		})
	}

	rows, err := repo.List(ctx, ListFilter{TenantID: ownerID})
	if err != nil {
		t.Fatalf("List the owner's rows: %v", err)
	}
	if len(rows) != ownerRows {
		t.Errorf("the owner has %d rows after every scope rolled back, want %d", len(rows), ownerRows)
	}
}

func mustInsert(t *testing.T, repo *Repo, c *Call) {
	t.Helper()
	if err := repo.Insert(context.Background(), c); err != nil {
		t.Fatalf("Insert: %v", err)
	}
}

func mustInsertAt(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	path string,
	calledAt time.Time,
) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin insert-at tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		t.Fatalf("set insert-at tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO api_key_calls
  (tenant_id, method, path, status_code, latency_ms, called_at)
VALUES ($1::uuid, 'GET', $2, 200, 0, $3)`, tenantID, path, calledAt); err != nil {
		t.Fatalf("insert row at %s: %v", calledAt, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit insert-at tx: %v", err)
	}
}

// Compile-time guard for errors package usage (silences linter when
// errors is unused in this build).
var _ = errors.New
