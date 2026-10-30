// SPDX-License-Identifier: AGPL-3.0-only
package compat

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func openPickPool(t *testing.T, url string) *pgxpool.Pool {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	return pool
}

func pickDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	pool := openPickPool(t, url)
	// Closed by t.Cleanup, never by a deferred Close in the test: Go runs a
	// test's defers before its t.Cleanup callbacks, and the tenant teardown
	// below runs from t.Cleanup on this pool. With `defer seed.Close()` the
	// teardown's WithTenant failed on the closed pool, the error was dropped,
	// and every run left the fixture tenant in the shared database.
	t.Cleanup(pool.Close)
	return pool
}

// pickAppPool returns the pool PickLandingVariant runs on, and fails the test
// unless that pool's role is subject to row-level security. The pool is
// POSTWAVE_APP_DATABASE_URL's when that is set (for a local DATABASE_URL that
// is a superuser), and otherwise seed itself: CI's DATABASE_URL connects as
// postwave_app.
//
// The public-slug policy is the only thing that keeps a wrong slug from
// reading a page's variants: the query filters on page id alone. A superuser
// or BYPASSRLS role reads them whatever the slug, and the wrong-slug assertion
// fails for a reason unrelated to the code. Whether RLS applies is read from
// the connection's role. It used to be inferred from whether
// POSTWAVE_APP_DATABASE_URL was set, and CI never sets it, so every CI run
// skipped that assertion even though its DATABASE_URL role was RLS-bound all
// along.
func pickAppPool(t *testing.T, seed *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	pool := seed
	if url := os.Getenv("POSTWAVE_APP_DATABASE_URL"); url != "" {
		pool = openPickPool(t, url)
		t.Cleanup(pool.Close)
	}
	requireRLSBoundRole(t, pool)
	return pool
}

// requireRLSBoundRole fails t unless pool's role is subject to row-level
// security, that is, neither a superuser nor BYPASSRLS.
func requireRLSBoundRole(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var role string
	var bypassesRLS bool
	if err := pool.QueryRow(ctx, `
SELECT current_user::text, rolsuper OR rolbypassrls
  FROM pg_roles
 WHERE rolname = current_user`).Scan(&role, &bypassesRLS); err != nil {
		t.Fatalf("reading the repository pool's role: %v", err)
	}
	if bypassesRLS {
		t.Fatalf("the repository pool connects as %q, which bypasses row-level security, so the "+
			"public-slug assertion cannot be made; point POSTWAVE_APP_DATABASE_URL (or "+
			"DATABASE_URL) at an RLS-bound role such as postwave_app", role)
	}
}

// PickLandingVariant reads a published page's variants via the public-slug RLS
// path, weighted-picks a content arm, and skips empty-content arms so the page
// never blanks.
func TestPickLandingVariant_PublicReadAndSkipEmpty_DB(t *testing.T) {
	seed := pickDB(t)
	ctx := context.Background()
	repo := &Repo{Pool: pickAppPool(t, seed)}
	pool := seed // fixtures are written through the DATABASE_URL pool

	tenantID := "00000000-0000-4000-8000-00f0e6600001"
	slug := "lp-pick-test"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	var pageID string
	if err := tx.QueryRow(ctx, `
INSERT INTO landing_pages (tenant_id, slug, name, status, template, blocks, seo, tracking)
VALUES ($1::uuid, $2, 'Pick Page', 'published', '', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
RETURNING id::text`, tenantID, slug).Scan(&pageID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed page: %v", err)
	}
	// One content arm (should always be picked) + one empty arm (must be skipped).
	if _, err := tx.Exec(ctx, `
INSERT INTO landing_page_variants (tenant_id, page_id, name, weight, blocks, is_control) VALUES
  ($1::uuid, $2::uuid, 'HasContent', 10, '[{"type":"hero"}]'::jsonb, true),
  ($1::uuid, $2::uuid, 'Empty',      10, '[]'::jsonb,               false)`, tenantID, pageID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed variants: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() { deletePickTestTenant(t, pool, tenantID) })

	// Across many random draws the empty arm is never served; the content arm's
	// blocks come back intact (the public-slug RLS path can read them).
	for i := 0; i < 50; i++ {
		pick, err := repo.PickLandingVariant(ctx, slug, pageID, i)
		if err != nil {
			t.Fatalf("PickLandingVariant: %v", err)
		}
		if pick == nil {
			t.Fatal("expected a pick (one content arm exists), got nil")
		}
		if len(pick.Blocks) == 0 {
			t.Fatalf("draw %d served an empty-blocks arm (should be skipped)", i)
		}
	}

	// A wrong slug yields no pick. The public-slug RLS policy enforces this;
	// pickAppPool has already failed the test if the repository's role would
	// bypass it.
	if pick, err := repo.PickLandingVariant(ctx, "no-such-slug", pageID, 3); err != nil || pick != nil {
		t.Fatalf("wrong-slug pick = (%v, %v), want (nil, nil)", pick, err)
	}
}

// deletePickTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deletePickTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deletePickTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deletePickTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
