// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// honeypotURLVars are the variables honeypotAppPool reads, in order. The
// dedicated one is for a machine whose DATABASE_URL is a superuser; CI sets
// DATABASE_URL and TEST_DATABASE_URL to postwave_app and nothing else.
var honeypotURLVars = []string{
	"POSTWAVE_HONEYPOT_APP_TEST_DATABASE_URL", "DATABASE_URL", "TEST_DATABASE_URL",
}

// honeypotAppPool returns the pool the repository under test runs on, and
// fails the test unless row-level security binds that pool's role.
//
// A superuser or BYPASSRLS role sees every tenant's rows, so an isolation test
// run through one proves nothing about the policy it claims to be testing.
// Whether RLS applies is read from the connection itself. It used to be
// inferred from POSTWAVE_HONEYPOT_APP_TEST_DATABASE_URL being set, and CI
// never sets it, so all four tests here skipped on every CI run even though
// CI's DATABASE_URL role was RLS-bound all along. A role that bypasses RLS is
// a failure, never a skip: the only skip left is a machine with no database.
func honeypotAppPool(t *testing.T, ctx context.Context) *db.Pool {
	t.Helper()
	var source, appURL string
	for _, name := range honeypotURLVars {
		if appURL = strings.TrimSpace(os.Getenv(name)); appURL != "" {
			source = name
			break
		}
	}
	if appURL == "" {
		t.Skip("DATABASE_URL not set (nor TEST_DATABASE_URL or POSTWAVE_HONEYPOT_APP_TEST_DATABASE_URL); " +
			"skipping the honeypot PostgreSQL proof")
	}
	pool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect honeypot app database (%s): %v", source, err)
	}
	t.Cleanup(pool.Close)
	var present bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.engagement_honeypot_fetches') IS NOT NULL`).Scan(&present); err != nil {
		t.Fatalf("probe schema: %v", err)
	}
	if !present {
		t.Fatal("migration 1977 has not been applied to the honeypot test database")
	}
	requireHoneypotRLS(t, ctx, pool, source)
	// db.Pool is an alias for pgxpool.Pool, so the restricted pool is the value.
	return pool
}

// requireHoneypotRLS fails t unless row-level security applies to
// engagement_honeypot_fetches for pool's role. The role must be neither a
// superuser nor BYPASSRLS, and row_security_active must report the table's
// policies in force for it. The second check catches what the first cannot:
// a table whose RLS was switched off, or one without FORCE ROW LEVEL SECURITY
// reached as its owner. (A session with row_security off needs no check: its
// queries on the table fail outright.) source names the variable the URL
// came from.
func requireHoneypotRLS(t *testing.T, ctx context.Context, pool *db.Pool, source string) {
	t.Helper()
	var role string
	var bypassesRLS, policiesActive bool
	if err := pool.QueryRow(ctx, `
SELECT current_user::text, r.rolsuper OR r.rolbypassrls,
       row_security_active('public.engagement_honeypot_fetches'::regclass)
  FROM pg_roles AS r
 WHERE r.rolname = current_user`).Scan(&role, &bypassesRLS, &policiesActive); err != nil {
		t.Fatalf("reading the honeypot pool's role: %v", err)
	}
	// Two different remedies, so two messages: the first is the connection's
	// fault, the second the schema's.
	switch {
	case bypassesRLS:
		t.Fatalf("%s connects as %q, a superuser or BYPASSRLS role that row-level security does "+
			"not bind, so these tests cannot prove tenant isolation; set "+
			"POSTWAVE_HONEYPOT_APP_TEST_DATABASE_URL to an RLS-bound role such as postwave_app",
			source, role)
	case !policiesActive:
		t.Fatalf("row-level security is not in force on engagement_honeypot_fetches for %q (from %s): "+
			"the table has it disabled, or %q owns the table and it is not forced, so these tests "+
			"cannot prove tenant isolation; migration 1977 enables and forces it", role, source, role)
	}
}

// seedHoneypotTenant creates a tenant that belongs to the calling test alone,
// and removes it with every fetch recorded under it when the test ends.
//
// engagement_honeypot_fetches.tenant_id references tenants(id) (migration
// 2045): a fetch recorded for an invented tenant id is refused rather than
// stored as an orphan. A fresh id per test also keeps these tests to their own
// rows in a database that other packages' tests use at the same moment. Nothing
// another test writes can fall into this tenant's window, and the teardown
// deletes only this tenant.
//
// The insert runs under the new tenant's own app.tenant_id. That is the only
// shape the tenants INSERT policy admits for postwave_app. The teardown runs
// under the same scope. Get the pool from honeypotAppPool before calling this:
// cleanups run last-registered-first, so the pool then outlives the teardown.
func seedHoneypotTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	tenantID := uuid.NewString()
	if err := inHoneypotTenantTx(t, pool, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'honeypot', 'studio')`,
			tenantID, "honeypot-"+tenantID)
		return err
	}); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() { removeHoneypotTenant(t, pool, tenantID) })
	return tenantID
}

// removeHoneypotTenant deletes one test's honeypot rows and then its tenant.
// A teardown that fails, or that finds no tenant to delete, is reported rather
// than ignored: either way the test's rows were not removed as intended.
func removeHoneypotTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	var removed int64
	err := inHoneypotTenantTx(t, pool, tenantID, func(ctx context.Context, tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`DELETE FROM engagement_honeypot_fetches WHERE tenant_id = $1::uuid`, tenantID); err != nil {
			return fmt.Errorf("delete honeypot fetches: %w", err)
		}
		tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		if err != nil {
			return fmt.Errorf("delete tenant: %w", err)
		}
		removed = tag.RowsAffected()
		return nil
	})
	if err != nil {
		t.Errorf("teardown of tenant %s failed, so the tenant and its rows leaked: %v", tenantID, err)
		return
	}
	if removed != 1 {
		t.Errorf("teardown deleted %d tenant rows for %s, want 1", removed, tenantID)
	}
}

// inHoneypotTenantTx runs one fixture step (the tenant seed or its teardown) in
// a transaction scoped to tenantID, and commits it. It uses its own bounded
// context. So it also works from t.Cleanup after the test's context is
// cancelled, and a lock wait cannot hold the package until the go test timeout.
//
// It retries while Postgres reports that its shared lock table is full
// (SQLSTATE 53200, "out of shared memory"). Deleting a tenant cascades through
// every foreign key that references tenants(id) (735 at migration 2045). It
// holds a lock on each of those tables and their indexes until commit: about
// 3,300 locks for one DELETE. The shared lock table holds about
// max_locks_per_transaction x max_connections entries for the whole server,
// every database on it included. At the image default of 64, which a shared
// local server may still run, a few tenant deletes from packages running at
// the same moment can fill it. CI raises the setting to 512 (the service
// container in .github/workflows/test.yml and infra/aws/codebuild/ci-group.sh),
// so there the retry is a backstop rather than the usual path. It also replays
// a step Postgres picked as a deadlock victim (40P01): a tenant delete can
// deadlock with another package's DDL on a table it cascades through. Both are
// contention on the shared database, not a defect in the code under test, and
// both clear on their own. The whole transaction is rolled back and run again.
// Only fixture steps retry; the calls under test run once.
func inHoneypotTenantTx(
	t *testing.T, pool *db.Pool, tenantID string, fn func(context.Context, pgx.Tx) error,
) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	backoff := 50 * time.Millisecond
	for {
		err := runHoneypotTenantTx(ctx, pool, tenantID, fn)
		var pgErr *pgconn.PgError
		if err == nil || !errors.As(err, &pgErr) || (pgErr.Code != "53200" && pgErr.Code != "40P01") {
			return err
		}
		t.Logf("tenant %s: transient SQLSTATE %s, retrying in %v: %v", tenantID, pgErr.Code, backoff, err)
		select {
		case <-ctx.Done():
			return fmt.Errorf("still failing after retrying: %w", err)
		case <-time.After(backoff):
		}
		backoff = min(2*backoff, 2*time.Second)
	}
}

func runHoneypotTenantTx(
	ctx context.Context, pool *db.Pool, tenantID string, fn func(context.Context, pgx.Tx) error,
) error {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func honeypotFetch(tenantID string, recipient string, at time.Time, technique Technique) Fetch {
	digest := sha256.Sum256([]byte(recipient))
	return Fetch{
		Claim: Claim{
			TenantID:              tenantID,
			CampaignID:            "8e3d1c6a-0000-4000-8000-0000000000c1",
			RecipientIdentityHMAC: hex.EncodeToString(digest[:]),
			Technique:             technique,
			IssuedAt:              at.Add(-time.Hour),
		},
		FetchedAt: at,
		UserAgent: "ExampleScanner/1.0",
		IP:        "203.0.113.10",
	}
}

func TestHoneypotEvidenceIsTenantIsolated_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := honeypotAppPool(t, ctx)
	repo := &Repo{Pool: pool}

	tenantA := seedHoneypotTenant(t, pool)
	tenantB := seedHoneypotTenant(t, pool)
	at := time.Now().UTC().Truncate(time.Microsecond)

	if err := repo.RecordFetch(ctx, honeypotFetch(tenantA, "iso-a", at, TechniqueHTMLComment)); err != nil {
		t.Fatalf("record for tenant A: %v", err)
	}

	mine, err := repo.ListFetches(ctx, tenantA, at.Add(-time.Hour), at.Add(time.Hour), 0)
	if err != nil {
		t.Fatalf("list for tenant A: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("tenant A saw %d rows, want 1", len(mine))
	}

	theirs, err := repo.ListFetches(ctx, tenantB, at.Add(-time.Hour), at.Add(time.Hour), 0)
	if err != nil {
		t.Fatalf("list for tenant B: %v", err)
	}
	if len(theirs) != 0 {
		t.Errorf("tenant B saw %d of tenant A's honeypot rows", len(theirs))
	}

	// ListFetches filters on tenant_id itself, so the checks above hold with or
	// without the row-level security policy. The policy is checked on its own
	// here, by statements that name tenant A's rows outright. Under A's scope
	// the read finds A's row, so the zero under B's scope is the policy at
	// work, not a query that matches nothing.
	if n := honeypotRowsVisible(t, ctx, pool, tenantA, tenantA); n != 1 {
		t.Fatalf("under tenant A's own scope %d of its rows are visible, want 1", n)
	}
	if n := honeypotRowsVisible(t, ctx, pool, tenantB, tenantA); n != 0 {
		t.Errorf("under tenant B's scope the row-level security policy let %d of tenant A's rows through", n)
	}
	err = writeHoneypotRowUnder(ctx, pool, tenantB, tenantA)
	if !isRLSRefusal(err) {
		t.Errorf("a row for tenant A written under tenant B's scope was not refused by the "+
			"row-level security policy (want SQLSTATE 42501): %v", err)
	}
}

// honeypotRowsVisible counts owner's rows as seen under scope's app.tenant_id.
func honeypotRowsVisible(t *testing.T, ctx context.Context, pool *db.Pool, scope, owner string) int {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, scope)
	if err != nil {
		t.Fatalf("scope %s: %v", scope, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err = tx.QueryRow(ctx,
		`SELECT count(*) FROM engagement_honeypot_fetches WHERE tenant_id = $1::uuid`, owner).Scan(&n); err != nil {
		t.Fatalf("count tenant %s's rows under scope %s: %v", owner, scope, err)
	}
	return n
}

// writeHoneypotRowUnder inserts a valid row for owner under scope's
// app.tenant_id and rolls it back, returning the insert's error. Rolling back
// keeps a row the policy should have refused out of the table either way.
func writeHoneypotRowUnder(ctx context.Context, pool *db.Pool, scope, owner string) error {
	tx, err := db.WithTenant(ctx, pool, scope)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	digest := sha256.Sum256([]byte("cross-tenant-write"))
	_, err = tx.Exec(ctx, `
INSERT INTO engagement_honeypot_fetches (
    tenant_id, campaign_id, recipient_identity_hmac, technique, token_issued_at, fetched_at
) VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
		owner, "8e3d1c6a-0000-4000-8000-0000000000c1", hex.EncodeToString(digest[:]),
		string(TechniqueHTMLComment))
	return err
}

// isRLSRefusal reports whether err is a row-level security WITH CHECK refusal.
func isRLSRefusal(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42501" &&
		strings.Contains(pgErr.Message, "row-level security")
}

func TestRepeatFetchKeepsTheFirstObservation_DB(t *testing.T) {
	// A scanner retries and a gateway re-scans days later. The first arrival is
	// the one whose latency relative to delivery still means something, so a
	// later fetch must not overwrite it.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := honeypotAppPool(t, ctx)
	repo := &Repo{Pool: pool}

	tenant := seedHoneypotTenant(t, pool)
	first := time.Now().UTC().Truncate(time.Microsecond)

	if err := repo.RecordFetch(ctx, honeypotFetch(tenant, "repeat", first, TechniqueHTMLComment)); err != nil {
		t.Fatalf("first record: %v", err)
	}
	later := honeypotFetch(tenant, "repeat", first.Add(48*time.Hour), TechniqueHTMLComment)
	later.UserAgent = "SomeOtherScanner/2.0"
	if err := repo.RecordFetch(ctx, later); err != nil {
		t.Fatalf("repeat record: %v", err)
	}

	rows, err := repo.ListFetches(ctx, tenant, first.Add(-time.Hour), first.Add(72*time.Hour), 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("stored %d rows for one recipient and technique, want 1", len(rows))
	}
	if !rows[0].FetchedAt.Equal(first) {
		t.Errorf("FetchedAt = %v, want the first observation %v", rows[0].FetchedAt, first)
	}
	if rows[0].UserAgent != "ExampleScanner/1.0" {
		t.Errorf("UserAgent = %q; the later fetch overwrote the first observation", rows[0].UserAgent)
	}
}

func TestBothCertifyingTechniquesAreStoredSeparately_DB(t *testing.T) {
	// Per-technique rows are what eventually answer whether the CSS decoy still
	// earns the spam-filter cost of carrying hidden content. Collapsing them at
	// write time would destroy that comparison before it could be made.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := honeypotAppPool(t, ctx)
	repo := &Repo{Pool: pool}

	tenant := seedHoneypotTenant(t, pool)
	at := time.Now().UTC().Truncate(time.Microsecond)

	for _, technique := range CertifyingTechniques() {
		if err := repo.RecordFetch(ctx, honeypotFetch(tenant, "both", at, technique)); err != nil {
			t.Fatalf("record %s: %v", technique, err)
		}
	}
	rows, err := repo.ListFetches(ctx, tenant, at.Add(-time.Hour), at.Add(time.Hour), 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != len(CertifyingTechniques()) {
		t.Errorf("stored %d rows, want one per certifying technique (%d)",
			len(rows), len(CertifyingTechniques()))
	}
}

func TestDatabaseRejectsAnUnknownTechnique_DB(t *testing.T) {
	// The closed vocabulary lives in the database as well as in Go. These rows
	// build certification evidence, so a technique arriving by ANY path — a
	// backfill, a future service, a hand-written insert — must be rejected at
	// write time rather than silently trusted at read time.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool := honeypotAppPool(t, ctx)

	// A real tenant, so the technique is the only thing wrong with the row. The
	// assertion also names the constraint: since migration 2045 an invented
	// tenant id is refused by the tenant foreign key as well, and a bare
	// err != nil cannot tell that refusal from the vocabulary check.
	tenant := seedHoneypotTenant(t, pool)
	tx, err := db.WithTenant(ctx, pool, tenant)
	if err != nil {
		t.Fatalf("scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	digest := sha256.Sum256([]byte("unknown-technique"))
	_, err = tx.Exec(ctx, `
INSERT INTO engagement_honeypot_fetches (
    tenant_id, campaign_id, recipient_identity_hmac, technique, token_issued_at, fetched_at
) VALUES ($1::uuid, $2::uuid, $3, 'invisible_ink', now(), now())`,
		tenant, "8e3d1c6a-0000-4000-8000-0000000000c1", hex.EncodeToString(digest[:]))
	if err == nil {
		t.Fatal("the database accepted a technique outside the closed vocabulary")
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" ||
		pgErr.ConstraintName != "engagement_honeypot_fetches_technique" {
		t.Errorf("insert was refused, but not by the technique vocabulary check: %v", err)
	}
}
