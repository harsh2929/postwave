// SPDX-License-Identifier: AGPL-3.0-only
//
// Store.PurgeExpired is a cross-tenant retention sweep by design. It runs under
// worker scope and, whichever tenant owns them, deletes expired
// verification_cache rows, email_health_snapshots rows and terminal job items
// past retention, and expired signup identities. Its tests assert the exact
// count it returns and exactly which rows a LIMIT-bounded sweep picks. Neither
// can be proven on the shared CI database. Every package's tests run there in
// parallel, and other packages legitimately seed expired rows in the same
// tables (internal/sending's recipient-health fixtures, for one). The sweep
// deletes those rows too, so the count and the LIMIT pick would depend on
// timing, and the sweep would delete another package's fixtures mid-test.
//
// The purge tests therefore run the sweep against a private, fully migrated
// database that only they write, one test at a time. Each test empties the
// swept tables before seeding, so it establishes its own precondition. It does
// not depend on an earlier test's teardown. Then, instead of assuming the
// premise, it proves it before the sweep: requireSweepSeesOnlyTenant fails if
// any row in a swept table belongs to anyone but the test's own tenant. With
// that proven, purgeOwnRows can hold the sweep to an exact account. The sweep
// removed precisely the tenant rows the test names, kept every other tenant
// row, created nothing, and returned exactly the number of rows it removed from
// the tables it counts.
//
// The tenants these tests create are never deleted. A tenant delete cascades
// through over 700 foreign keys and holds about 3,300 locks (see the lock-table
// note in .github/workflows/test.yml), and here it would buy nothing: the reset
// already clears every swept row, and TestMain drops the whole database.
//
// The private database is built by internal/testsupport/privatedb, which owns
// naming, the SQLSTATE 53200 retry, pointing connections at the database and
// dropping it.

package verification

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// purgeDatabase is the private purge database. It outlives any single test
// because migrating one costs seconds; the purge tests share it one at a time
// (see purgeDB).
var purgeDatabase = privatedb.NewShared(privatedb.Spec{
	Prefix: "postwave_verification_purge_",
	Label:  "private purge database",
})

// TestMain drops the private purge database once every test has finished. A
// database that cannot be dropped fails the run, because it would otherwise go
// unseen.
func TestMain(m *testing.M) {
	privatedb.Main(m, purgeDatabase)
}

// purgeSweptTable is one table Store.PurgeExpired deletes from or rewrites.
// Key is the SQL expression that identifies a row within its tenant. Counted
// reports whether rows deleted from the table contribute to PurgeExpired's
// return value.
type purgeSweptTable struct {
	name    string
	key     string
	counted bool
}

var purgeSweptTables = []purgeSweptTable{
	{name: "verification_cache", key: "email", counted: true},
	{name: "email_health_snapshots", key: "email", counted: true},
	{name: "verification_job_items", key: "job_id::text || ' ' || email", counted: true},
	// Jobs are scrubbed and watchdog-terminalized, never deleted.
	{name: "verification_jobs", key: "id::text", counted: false},
	{name: "verification_signup_identities", key: "encode(identity_hash, 'hex')", counted: true},
	// Attempts leave by ON DELETE CASCADE from their identity, uncounted.
	{name: "verification_signup_attempts", key: "form_id::text || ' ' || encode(attempt_hash, 'hex')", counted: false},
}

// purgeDB returns an application pool, an administrative pool, and a fresh
// tenant on the private purge database, with every swept table emptied. It
// gives the calling test sole use of that database until the test ends, so a
// test calls it once, before anything else. The
// application pool is built by db.New from DATABASE_URL's credentials, so it
// has the same role, hooks and privileged-role refusal the shared-database
// tests get. The administrative pool bypasses RLS. It is used only for the
// reset and to read ground truth: the premise, and the tenant's footprint.
func purgeDB(t *testing.T) (*db.Pool, *pgxpool.Pool, string) {
	t.Helper()
	appURL := os.Getenv("DATABASE_URL")
	if appURL == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed verification tests")
	}
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; PurgeExpired sweeps every tenant, so its exact counts are provable only on a private migrated database")
	}
	private := purgeDatabase.Require(t, adminURL)
	// Taken before any pool opens, so it is released after they close:
	// t.Cleanup is last in, first out. Each test resets the swept tables and
	// then proves nobody else has rows in them, so no other purge test may
	// write the database in between. The tests do not call t.Parallel today;
	// this keeps the reset safe if one ever does.
	purgeDatabase.Exclusive(t)
	ctx := context.Background()

	appDSN, err := private.DSN(appURL)
	if err != nil {
		t.Fatalf("point DATABASE_URL at %s: %v", private.Name(), err)
	}
	app, err := db.New(ctx, appDSN)
	if err != nil {
		t.Fatalf("connect application role to %s: %v", private.Name(), err)
	}
	t.Cleanup(app.Close)
	// The sweep runs on this pool, so it must reach the private database and
	// nothing else: a sweep of the shared one would delete other packages'
	// rows while the premise, read through the administrative pool, saw only
	// the private one.
	private.RequireConnected(t, ctx, app, "the cross-tenant purge sweep")

	admin := private.Connect(t, adminURL, "administrative")
	// A premise read through RLS would see only what policies let it see, and
	// would prove nothing about the rows the sweep can reach.
	var bypass bool
	if err := admin.QueryRow(ctx,
		`SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&bypass); err != nil {
		t.Fatalf("inspect administrative role: %v", err)
	}
	if !bypass {
		t.Fatal("POSTWAVE_TEST_ADMIN_DATABASE_URL must bypass RLS so the purge premise sees every row")
	}
	// Children first: attempts and job items would cascade anyway, and nothing
	// in this database writes subscriber_imports, the one RESTRICT reference
	// into verification_jobs.
	for _, table := range []string{
		"verification_signup_attempts", "verification_signup_identities",
		"verification_job_items", "verification_jobs",
		"email_health_snapshots", "verification_cache",
	} {
		if _, err := admin.Exec(ctx, "DELETE FROM "+table); err != nil {
			t.Fatalf("reset %s in the private purge database: %v", table, err)
		}
	}
	return app, admin, insertTenant(t, app)
}

// requireSweepSeesOnlyTenant proves the premise every exact purge assertion
// rests on: no row in any swept table belongs to anyone but tenantID.
func requireSweepSeesOnlyTenant(t *testing.T, admin *pgxpool.Pool, tenantID string) {
	t.Helper()
	for _, table := range purgeSweptTables {
		var foreign int
		if err := admin.QueryRow(context.Background(),
			"SELECT count(*) FROM "+table.name+" WHERE tenant_id IS DISTINCT FROM $1::uuid", tenantID).Scan(&foreign); err != nil {
			t.Fatalf("count %s rows outside the test tenant: %v", table.name, err)
		}
		if foreign != 0 {
			t.Fatalf("private purge database holds %d %s row(s) outside tenant %s, so the sweep's count would not be this test's alone",
				foreign, table.name, tenantID)
		}
	}
}

// purgeFootprint maps each swept table to the sorted keys of one tenant's rows.
type purgeFootprint map[string][]string

func readPurgeFootprint(t *testing.T, admin *pgxpool.Pool, tenantID string) purgeFootprint {
	t.Helper()
	footprint := purgeFootprint{}
	for _, table := range purgeSweptTables {
		rows, err := admin.Query(context.Background(),
			"SELECT "+table.key+" FROM "+table.name+" WHERE tenant_id = $1::uuid", tenantID)
		if err != nil {
			t.Fatalf("read %s footprint: %v", table.name, err)
		}
		keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			t.Fatalf("collect %s footprint: %v", table.name, err)
		}
		slices.Sort(keys)
		footprint[table.name] = keys
	}
	return footprint
}

// purgeRun is one sweep's exact account of a tenant's rows.
type purgeRun struct {
	removed int64
	before  purgeFootprint
	gone    purgeFootprint
}

// purgeOwnRows runs the cross-tenant sweep on the private database and
// accounts for it exactly. The premise shows the sweep can see nobody's rows
// but the tenant's, so what it reports removing must equal what the tenant
// lost from the counted tables, and it must not have created any row.
func purgeOwnRows(t *testing.T, s *Store, admin *pgxpool.Pool, tenantID string, limit int) purgeRun {
	t.Helper()
	requireSweepSeesOnlyTenant(t, admin, tenantID)
	before := readPurgeFootprint(t, admin, tenantID)
	removed, err := s.PurgeExpired(context.Background(), limit)
	if err != nil {
		t.Fatalf("PurgeExpired: %v", err)
	}
	after := readPurgeFootprint(t, admin, tenantID)

	gone := purgeFootprint{}
	var counted int64
	for _, table := range purgeSweptTables {
		for _, key := range after[table.name] {
			if !slices.Contains(before[table.name], key) {
				t.Fatalf("PurgeExpired created %s row %q", table.name, key)
			}
		}
		for _, key := range before[table.name] {
			if !slices.Contains(after[table.name], key) {
				gone[table.name] = append(gone[table.name], key)
			}
		}
		if table.counted {
			counted += int64(len(gone[table.name]))
		}
	}
	if removed != counted {
		t.Fatalf("PurgeExpired returned %d, but the only tenant in the database lost %d counted row(s): %v",
			removed, counted, gone)
	}
	return purgeRun{removed: removed, before: before, gone: gone}
}

// requirePurgeRemoved asserts the sweep removed exactly want's rows of the
// tenant, and no other row of it, from every swept table.
func requirePurgeRemoved(t *testing.T, gone, want purgeFootprint) {
	t.Helper()
	known := make(map[string]bool, len(purgeSweptTables))
	for _, table := range purgeSweptTables {
		known[table.name] = true
		expected := slices.Clone(want[table.name])
		slices.Sort(expected)
		if got := gone[table.name]; !slices.Equal(got, expected) {
			t.Errorf("PurgeExpired removed %s rows %q, want exactly %q", table.name, got, expected)
		}
	}
	for table := range want {
		if !known[table] {
			t.Fatalf("requirePurgeRemoved names %q, which PurgeExpired does not sweep", table)
		}
	}
}
