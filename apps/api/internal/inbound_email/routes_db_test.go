// SPDX-License-Identifier: AGPL-3.0-only
//
// Integration test for MatchRoutes — verifies the priority ordering +
// stop_on_match semantics actually behave as advertised against a
// live Postgres. The pure routeMatches/globMatch tests cover the
// predicate; this one covers the SELECT + cursor flow.

package inbound_email

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newRoutesTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed inbound_routes tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func randHex(t *testing.T) string {
	t.Helper()
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b[:])
}

func seedRoutesTenant(t *testing.T, pool *pgxpool.Pool) (string, func()) {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var id string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&id); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, false)`, id); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		id, "routes-test-"+randHex(t), "Routes test"); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, id)
		_, _ = conn.Exec(ctx,
			`DELETE FROM inbound_routes WHERE tenant_id = $1::uuid`, id)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, id)
	}
	return id, cleanup
}

// insertRoute is a tiny helper for seeding test fixtures.
func insertRoute(t *testing.T, pool *pgxpool.Pool, tenantID, name string, prio int, stopOnMatch bool, matchRecipient, matchSubjectPrefix string) {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	_, err = conn.Exec(ctx, `
INSERT INTO inbound_routes
  (tenant_id, name, priority, stop_on_match, enabled,
   match_recipient, match_subject_prefix, actions)
VALUES ($1::uuid, $2, $3, $4, true, $5, $6, '[]'::jsonb)`,
		tenantID, name, prio, stopOnMatch, matchRecipient, matchSubjectPrefix)
	if err != nil {
		t.Fatalf("insert route: %v", err)
	}
}

func TestMatchRoutes_PriorityOrdering(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()

	// Insert routes in INVERSE priority order to verify the query's
	// `ORDER BY priority ASC` actually drives the walk.
	insertRoute(t, pool, tenantID, "lowprio_catchall", 200, true, "*", "")
	insertRoute(t, pool, tenantID, "hipri_specific", 10, true, "support@*", "")

	matched, err := MatchRoutes(context.Background(), pool, tenantID,
		"support@acme.com", "any subject", "alice@example.com")
	if err != nil {
		t.Fatalf("MatchRoutes: %v", err)
	}
	if len(matched) == 0 {
		t.Fatal("expected at least one match, got 0")
	}
	if matched[0].Name != "hipri_specific" {
		t.Errorf("first match should be the priority-10 rule, got %q", matched[0].Name)
	}
}

// stop_on_match=true on the first matching rule must short-circuit
// subsequent rules even when they also match.
func TestMatchRoutes_StopOnMatchShortCircuits(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()

	// Two rules that BOTH match "support@acme.com". Rule A (prio 10)
	// has stop_on_match=true; Rule B (prio 20) would also match but
	// must NOT be returned.
	insertRoute(t, pool, tenantID, "A_stop", 10, true, "*", "")
	insertRoute(t, pool, tenantID, "B_after_stop", 20, true, "support@*", "")

	matched, err := MatchRoutes(context.Background(), pool, tenantID,
		"support@acme.com", "subj", "a@b.com")
	if err != nil {
		t.Fatalf("MatchRoutes: %v", err)
	}
	if len(matched) != 1 {
		t.Fatalf("expected exactly 1 match (stop_on_match shortcut), got %d", len(matched))
	}
	if matched[0].Name != "A_stop" {
		t.Errorf("first/only match should be A_stop, got %q", matched[0].Name)
	}
}

// stop_on_match=false on the first matching rule should allow the
// next rule to also match (fall-through).
func TestMatchRoutes_FallThroughWhenNoStop(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()

	insertRoute(t, pool, tenantID, "A_continue", 10, false, "*", "")
	insertRoute(t, pool, tenantID, "B_also_matches", 20, true, "support@*", "")

	matched, err := MatchRoutes(context.Background(), pool, tenantID,
		"support@acme.com", "subj", "a@b.com")
	if err != nil {
		t.Fatalf("MatchRoutes: %v", err)
	}
	if len(matched) != 2 {
		t.Fatalf("expected 2 matches (A_continue falls through), got %d", len(matched))
	}
}

// Disabled routes must be invisible to MatchRoutes even when their
// patterns would otherwise match.
func TestMatchRoutes_DisabledHidden(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()

	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set guc: %v", err)
	}
	_, err = conn.Exec(ctx, `
INSERT INTO inbound_routes
  (tenant_id, name, priority, stop_on_match, enabled,
   match_recipient, match_subject_prefix, actions)
VALUES ($1::uuid, 'disabled_catchall', 10, true, false, '*', '', '[]'::jsonb)`,
		tenantID)
	if err != nil {
		t.Fatalf("insert disabled: %v", err)
	}
	matched, err := MatchRoutes(context.Background(), pool, tenantID,
		"anyone@anywhere.com", "any", "x@y.com")
	if err != nil {
		t.Fatalf("MatchRoutes: %v", err)
	}
	if len(matched) != 0 {
		t.Errorf("disabled route surfaced in matches: %d", len(matched))
	}
}
