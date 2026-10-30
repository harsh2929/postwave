// SPDX-License-Identifier: AGPL-3.0-only
package landingpages

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

func openVariantPool(t *testing.T, url string) *pgxpool.Pool {
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

func variantsDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	pool := openVariantPool(t, url)
	// Closed by t.Cleanup, never by a deferred Close in the test: Go runs a
	// test's defers before its t.Cleanup callbacks, and seedPageDB's tenant
	// teardown runs from t.Cleanup on this pool. With `defer seed.Close()` the
	// teardown's WithTenant failed on the closed pool, the error was dropped,
	// and every run left both fixture tenants in the shared database.
	t.Cleanup(pool.Close)
	return pool
}

// appPoolFor returns the pool the repository under test runs on, and fails the
// test unless that pool's role is subject to row-level security. The pool is
// POSTWAVE_APP_DATABASE_URL's when that is set (for a local DATABASE_URL that
// is a superuser), and otherwise seed itself: CI's DATABASE_URL connects as
// postwave_app.
//
// The cross-tenant rejection this test asserts is enforced by RLS alone.
// CreateVariant looks the page up with no tenant predicate of its own, so a
// superuser or BYPASSRLS role finds another tenant's page and the assertion
// fails for a reason unrelated to the code. Whether RLS applies is read from
// the connection's role. It used to be inferred from whether
// POSTWAVE_APP_DATABASE_URL was set, and CI never sets it, so every CI run
// skipped the one isolation assertion here even though its DATABASE_URL role
// was RLS-bound all along.
func appPoolFor(t *testing.T, seed *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	pool := seed
	if url := os.Getenv("POSTWAVE_APP_DATABASE_URL"); url != "" {
		pool = openVariantPool(t, url)
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
			"tenant-isolation assertion cannot be made; point POSTWAVE_APP_DATABASE_URL (or "+
			"DATABASE_URL) at an RLS-bound role such as postwave_app", role)
	}
}

// seedPageDB inserts a tenant + published landing page and returns its id.
func seedPageDB(t *testing.T, pool *pgxpool.Pool, tenantID, slug string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("worker scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	var pageID string
	if err := tx.QueryRow(ctx, `
INSERT INTO landing_pages (tenant_id, slug, name, status, template, blocks, seo, tracking)
VALUES ($1::uuid, $2, 'AB Page', 'published', '', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
RETURNING id::text`, tenantID, slug).Scan(&pageID); err != nil {
		t.Fatalf("seed page: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit page seed: %v", err)
	}
	t.Cleanup(func() { deleteVariantTestTenant(t, pool, tenantID) })
	return pageID
}

func recordEvent(t *testing.T, pool *pgxpool.Pool, tenantID, pageID, eventType, variantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO growth_surface_events (tenant_id, surface_type, surface_id, event_type, variant_id)
VALUES ($1::uuid, 'landing_page', $2::uuid, $3, NULLIF($4,'')::uuid)`,
		tenantID, pageID, eventType, variantID); err != nil {
		t.Fatalf("record event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit event: %v", err)
	}
}

// Variant CRUD, per-variant metrics, control-demotion, and cross-tenant page
// rejection, with the repository running under an RLS-bound role.
func TestVariantCRUDMetricsAndIsolation_DB(t *testing.T) {
	seed := variantsDB(t)
	ctx := context.Background()
	repo := &Repo{Pool: appPoolFor(t, seed)}

	tenantA := "00000000-0000-4000-8000-00e0e6600001"
	tenantB := "00000000-0000-4000-8000-00e0e6600002"
	pageA := seedPageDB(t, seed, tenantA, "lp-ab-a")
	pageB := seedPageDB(t, seed, tenantB, "lp-ab-b")

	// Create a control + a B variant.
	ctrl, err := repo.CreateVariant(ctx, tenantA, pageA, VariantInput{Name: "Control", Weight: intPtr(50), IsControl: boolPtr(true)})
	if err != nil {
		t.Fatalf("create control: %v", err)
	}
	b, err := repo.CreateVariant(ctx, tenantA, pageA, VariantInput{Name: "B", Weight: intPtr(50)})
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	// Cross-tenant: tenantA cannot add a variant to tenantB's page. Bound to
	// tenantA, RLS hides pageB from the page lookup, so the page is not found.
	// appPoolFor has already failed the test if the repository's role would
	// bypass RLS.
	if _, err = repo.CreateVariant(ctx, tenantA, pageB, VariantInput{Name: "X"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant CreateVariant error = %v, want ErrNotFound", err)
	}

	// Attribute events: control 3 views/1 conversion; B 2 views/2 conversions.
	recordEvent(t, seed, tenantA, pageA, "view", ctrl.ID)
	recordEvent(t, seed, tenantA, pageA, "view", ctrl.ID)
	recordEvent(t, seed, tenantA, pageA, "view", ctrl.ID)
	recordEvent(t, seed, tenantA, pageA, "conversion", ctrl.ID)
	recordEvent(t, seed, tenantA, pageA, "view", b.ID)
	recordEvent(t, seed, tenantA, pageA, "view", b.ID)
	recordEvent(t, seed, tenantA, pageA, "conversion", b.ID)
	recordEvent(t, seed, tenantA, pageA, "conversion", b.ID)
	// An un-attributed control-page event (NULL variant) must not pollute either.
	recordEvent(t, seed, tenantA, pageA, "view", "")

	list, err := repo.ListVariants(ctx, tenantA, pageA)
	if err != nil {
		t.Fatalf("list variants: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("variants = %d, want 2", len(list))
	}
	// Control-first ordering.
	if !list[0].IsControl || list[0].ID != ctrl.ID {
		t.Fatalf("first variant should be the control")
	}
	byID := map[string]Variant{list[0].ID: list[0], list[1].ID: list[1]}
	if c := byID[ctrl.ID]; c.Views != 3 || c.Conversions != 1 {
		t.Fatalf("control metrics = %d views / %d conv, want 3/1", c.Views, c.Conversions)
	}
	if bb := byID[b.ID]; bb.Views != 2 || bb.Conversions != 2 || bb.ConversionRate != 1.0 {
		t.Fatalf("B metrics = %d/%d rate %.2f, want 2/2/1.00", bb.Views, bb.Conversions, bb.ConversionRate)
	}

	// Control demotion: promoting B flips the control flag.
	if _, err := repo.UpdateVariant(ctx, tenantA, pageA, b.ID, VariantInput{IsControl: boolPtr(true)}); err != nil {
		t.Fatalf("promote B to control: %v", err)
	}
	after, _ := repo.ListVariants(ctx, tenantA, pageA)
	controls := 0
	for _, v := range after {
		if v.IsControl {
			controls++
		}
	}
	if controls != 1 {
		t.Fatalf("controls after demotion = %d, want exactly 1", controls)
	}

	// Delete removes a variant; a foreign id is a 404.
	if err := repo.DeleteVariant(ctx, tenantA, pageA, ctrl.ID); err != nil {
		t.Fatalf("delete control: %v", err)
	}
	if err := repo.DeleteVariant(ctx, tenantA, pageA, "00000000-0000-4000-8000-0000deadbeef"); err == nil {
		t.Fatal("deleting unknown variant should 404")
	}
}

func intPtr(i int) *int    { return &i }
func boolPtr(b bool) *bool { return &b }

// deleteVariantTestTenant removes a tenant the test created, and everything
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
func deleteVariantTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteVariantTestTenantOnce(ctx, pool, tenantID)
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

func deleteVariantTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
