// SPDX-License-Identifier: AGPL-3.0-only
//
// The coupon proofs that change a whole table run in a private database.
//
// CI runs every Go package in parallel against one database. Two proofs in
// coupon_allocation_safety_db_test.go act on a table as a whole, and every
// tenant DELETE in every package cascades into those tables:
//
//   - The owner-level append-only proof TRUNCATEs coupon_entitlement_events
//     and requires the statement trigger to refuse. TRUNCATE takes ACCESS
//     EXCLUSIVE before the trigger runs, so on a shared database it waits
//     behind any tenant deletion already in flight and queues every later one
//     (and every reader of the ledger) behind itself.
//   - The un-evidenced-transition proof disables one receipt trigger with
//     ALTER TABLE. That takes SHARE ROW EXCLUSIVE, with the same queueing, and
//     the trigger stays disabled for every session until the cleanup enables
//     it again, so a coupon writer in another package (coderedemption, for
//     one) would silently stop leaving receipts in the meantime.
//
// So the first such proof in a test process creates a database with the
// admin URL's credentials and applies the whole migration history, through
// internal/testsupport/privatedb, which owns naming, the SQLSTATE 53200 retry,
// pointing connections at the database and dropping it. Every such proof in
// the process, -count repeats included, then uses it, one test at a time (none
// calls t.Parallel), and TestMain drops it. All other tests keep using
// DATABASE_URL.

package discounts

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// privateCouponDatabaseState is this process's private database.
var privateCouponDatabaseState = privatedb.NewShared(privatedb.Spec{
	Prefix: "postwave_discounts_ledger_",
	Label:  "private coupon database",
	Check:  privatedb.Applied("1971_coupon_ledger_truncate_and_reservation_floor"),
})

// privateCouponDatabase is a test's handle on the private database: the
// administrative and postwave_app URLs, pointed at it.
type privateCouponDatabase struct {
	database privatedb.Database
	adminURL string
	appURL   string
}

// TestMain drops the private database once every test has finished. A
// database that cannot be dropped fails the run, because it would otherwise go
// unseen.
func TestMain(m *testing.M) {
	privatedb.Main(m, privateCouponDatabaseState)
}

// lookupPrivateCouponDatabase returns the private database, creating and
// migrating it on first use. It reports false, without creating anything, when
// no administrative URL or no DATABASE_URL is configured.
func lookupPrivateCouponDatabase(t *testing.T) (privateCouponDatabase, bool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("POSTWAVE_ADMIN_DATABASE_URL"))
	}
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		return privateCouponDatabase{}, false
	}
	private := privateCouponDatabaseState.Require(t, adminURL)
	privateAdminURL, err := private.DSN(adminURL)
	if err != nil {
		t.Fatalf("point the administrative URL at %s: %v", private.Name(), err)
	}
	privateAppURL, err := private.DSN(appURL)
	if err != nil {
		t.Fatalf("point DATABASE_URL at %s: %v", private.Name(), err)
	}
	return privateCouponDatabase{database: private, adminURL: privateAdminURL, appURL: privateAppURL}, true
}

// requirePrivateCouponDatabase is lookupPrivateCouponDatabase for a proof that
// cannot run anywhere else.
func requirePrivateCouponDatabase(t *testing.T) privateCouponDatabase {
	t.Helper()
	isolated, ok := lookupPrivateCouponDatabase(t)
	if !ok {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL (or POSTWAVE_ADMIN_DATABASE_URL) or DATABASE_URL is not set; " +
			"this proof changes a whole table, so it runs only in a private migrated database created with both")
	}
	return isolated
}

// fixture is newCouponFixture in the private database. newCouponFixture reads
// DATABASE_URL, so the private URL is set for the rest of the test.
func (p privateCouponDatabase) fixture(t *testing.T, in CouponPoolInput, codeCount int) *couponFixture {
	t.Helper()
	t.Setenv("DATABASE_URL", p.appURL)
	return newCouponFixture(t, in, codeCount)
}

// requireConnected fails the test unless q runs in this private database.
// Every table-wide statement in this package runs after this check, on the
// connection or pool it checked.
func (p privateCouponDatabase) requireConnected(t *testing.T, ctx context.Context, q privatedb.Querier) {
	t.Helper()
	p.database.RequireConnected(t, ctx, q, "a table-wide statement")
}

// newOwnerProofCouponFixture returns the fixture for a test that ends in an
// owner-level proof, and the administrative URL that proof must use. With an
// administrative URL configured, the whole test runs in the private database;
// without one it runs against DATABASE_URL and the URL returned is empty, so
// the owner-level half skips.
func newOwnerProofCouponFixture(t *testing.T, in CouponPoolInput, codeCount int) (*couponFixture, string) {
	t.Helper()
	isolated, ok := lookupPrivateCouponDatabase(t)
	if !ok {
		return newCouponFixture(t, in, codeCount), ""
	}
	return isolated.fixture(t, in, codeCount), isolated.adminURL
}

// truncateLedgerInPrivateDatabase issues TRUNCATE coupon_entitlement_events on
// one connection after proving that connection is in the private database,
// and returns its error.
func truncateLedgerInPrivateDatabase(t *testing.T, ctx context.Context, pool *db.Pool) error {
	t.Helper()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire an administrative connection: %v", err)
	}
	defer conn.Release()
	privateCouponDatabaseState.Current().RequireConnected(t, ctx, conn, "a table-wide statement")
	_, err = conn.Exec(ctx, `TRUNCATE coupon_entitlement_events`)
	return err
}
