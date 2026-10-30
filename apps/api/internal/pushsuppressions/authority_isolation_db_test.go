// SPDX-License-Identifier: AGPL-3.0-only
//
// The push-suppression database proofs run in a private database.
//
// CI runs every Go package in parallel against one database, and three things
// these proofs must do would stall other packages' tenant fixtures there:
//
//   - TestLegacyDeploymentBarrierBlocksWriterUntilAuthoritySyncIsReady holds
//     migration 1996's deployment barrier: SHARE ROW EXCLUSIVE on tenants and
//     on push_token_suppressions. The first lock blocks every tenant INSERT
//     and DELETE; the second blocks every tenant DELETE too, because each one
//     cascades into push_token_suppressions. Taking the barrier also waits
//     behind any tenant write already in flight and queues every later one
//     behind itself. The barrier is the thing under test, so it cannot be
//     narrowed or taken with NOWAIT and still prove the migration's semantics.
//   - The TRUNCATE-denial probes take ACCESS EXCLUSIVE before the trigger can
//     refuse, on four tables every tenant DELETE cascades into (and one every
//     tenant INSERT writes through the registry-seed trigger).
//   - TestAuthorityDatabaseContract's no-GUC administrative statements take the
//     authority-domain advisory lock exclusively, the same lock every tenant
//     DELETE's statement trigger takes, so on a shared database each one
//     serializes against every other package's tenant cleanup.
//
// So the first proof in a test process creates a database with the admin
// URL's credentials and applies the whole migration history, through
// internal/testsupport/privatedb, which owns naming, the SQLSTATE 53200 retry,
// pointing connections at the database and dropping it. Every proof in the
// process, -count repeats included, then uses it, one test at a time (none
// calls t.Parallel), and TestMain drops it. Advisory locks are per database,
// so nothing here reaches the shared one.

package pushsuppressions

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// privatePushSuppressionDatabase is this process's private database.
var privatePushSuppressionDatabase = privatedb.NewShared(privatedb.Spec{
	Prefix: "postwave_pushsuppressions_",
	Label:  "private push-suppression database",
	Check:  privatedb.Applied("1996_push_suppression_authorities"),
})

// TestMain drops the private database once every test has finished. A
// database that cannot be dropped fails the run, because it would otherwise go
// unseen.
func TestMain(m *testing.M) {
	privatedb.Main(m, privatePushSuppressionDatabase)
}

// sharedTestDatabaseURLs returns the administrative and postwave_app URLs CI
// sets for every package. They name the server and the credentials; the
// proofs connect to the private database on that server, never to the one the
// URLs name.
func sharedTestDatabaseURLs() (string, string) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("POSTWAVE_ADMIN_DATABASE_URL"))
	}
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if appURL == "" {
		appURL = strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	}
	return adminURL, appURL
}

// privatePushSuppressionDatabaseURLs creates and migrates the private database
// on first use and returns adminURL and appURL pointed at it.
func privatePushSuppressionDatabaseURLs(t *testing.T, adminURL, appURL string) (string, string) {
	t.Helper()
	if adminURL == "" || appURL == "" {
		t.Skip("an admin or a postwave_app database URL is not set; both are required " +
			"(PUSH_SUPPRESSIONS_ADMIN_TEST_DATABASE_URL and PUSH_SUPPRESSIONS_APP_TEST_DATABASE_URL, " +
			"or POSTWAVE_TEST_ADMIN_DATABASE_URL and DATABASE_URL)")
	}
	private := privatePushSuppressionDatabase.Require(t, adminURL)
	privateAdminURL, err := private.DSN(adminURL)
	if err != nil {
		t.Fatalf("point the administrative URL at %s: %v", private.Name(), err)
	}
	privateAppURL, err := private.DSN(appURL)
	if err != nil {
		t.Fatalf("point the application URL at %s: %v", private.Name(), err)
	}
	return privateAdminURL, privateAppURL
}

// requireInPrivatePushSuppressionDatabase fails the test unless q is connected
// to this process's private database. Every table-level lock in this package
// is taken after this check, on the connection it checked.
func requireInPrivatePushSuppressionDatabase(t *testing.T, ctx context.Context, q privatedb.Querier) {
	t.Helper()
	privatePushSuppressionDatabase.Current().RequireConnected(t, ctx, q, "a table-level lock")
}

// truncatePrivatePushSuppressionTable issues TRUNCATE on one connection after
// proving that connection is in the private database, and that the statement
// can reach table's own BEFORE TRUNCATE triggers and nothing else's (see
// requireTruncateReachesOnlyTheTablesTriggers). It returns TRUNCATE's error.
func truncatePrivatePushSuppressionTable(t *testing.T, ctx context.Context, admin *pgxpool.Pool, table string) error {
	t.Helper()
	conn, err := admin.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire an administrative connection: %v", err)
	}
	defer conn.Release()
	requireInPrivatePushSuppressionDatabase(t, ctx, conn)
	requireTruncateReachesOnlyTheTablesTriggers(t, ctx, conn, table)
	_, err = conn.Exec(ctx, "TRUNCATE TABLE "+pgx.Identifier{"public", table}.Sanitize())
	return err
}

// requireTruncateReachesOnlyTheTablesTriggers proves the premise that lets a
// refusal carrying the trigger's message stand for "this table's trigger
// refused": a plain TRUNCATE of table fires table's own BEFORE TRUNCATE
// triggers, and no other refusal can come first.
//
//   - No foreign key may reference the table. PostgreSQL checks those before
//     it fires any BEFORE TRUNCATE trigger, and refuses a truncate that would
//     break one with 0A000 and a message of its own, so the probe would never
//     reach the trigger. A table that gains one must be probed by truncating
//     it together with the tables that reference it, in a form that still
//     tells its trigger's refusal from theirs.
//   - The table must be an ordinary table with no inheritance children or
//     partitions. TRUNCATE without ONLY also truncates those and fires their
//     triggers, and all four tables share one trigger function and one message,
//     so a descendant's trigger could otherwise answer for a missing one here.
func requireTruncateReachesOnlyTheTablesTriggers(t *testing.T, ctx context.Context, q privatedb.Querier, table string) {
	t.Helper()
	var kind string
	var referencedBy, descendants []string
	if err := q.QueryRow(ctx, `
SELECT c.relkind::text,
       ARRAY(SELECT fk.conrelid::regclass::text || ' (' || fk.conname || ')'
               FROM pg_catalog.pg_constraint AS fk
              WHERE fk.contype = 'f' AND fk.confrelid = c.oid
              ORDER BY 1),
       ARRAY(SELECT child.inhrelid::regclass::text
               FROM pg_catalog.pg_inherits AS child
              WHERE child.inhparent = c.oid
              ORDER BY 1)
  FROM pg_catalog.pg_class AS c
 WHERE c.oid = $1::regclass`, pgx.Identifier{"public", table}.Sanitize()).Scan(&kind, &referencedBy, &descendants); err != nil {
		t.Fatalf("read how TRUNCATE %s reaches its triggers: %v", table, err)
	}
	if len(referencedBy) != 0 {
		t.Fatalf("foreign keys %v reference %s, so PostgreSQL refuses TRUNCATE %s before any BEFORE TRUNCATE trigger "+
			"runs and this probe cannot reach the trigger. Truncate it together with the tables that reference it, "+
			"in a form that tells its trigger's refusal from theirs.", referencedBy, table, table)
	}
	if kind != "r" || len(descendants) != 0 {
		t.Fatalf("%s has relkind %q and descendants %v: TRUNCATE would also fire the descendants' triggers, "+
			"which share this trigger's message, so this probe needs an ordinary table with no descendants",
			table, kind, descendants)
	}
}

// requirePushSuppressionTruncateRefused requires the refusal to come from the
// authority domain's BEFORE TRUNCATE trigger: its message, not only its
// SQLSTATE. The trigger raises 0A000 (feature_not_supported), a code
// PostgreSQL itself uses for other refusals. Checking the code alone would let
// another 0A000 error stand in for the trigger's refusal and hide a missing
// trigger. With the premise truncatePrivatePushSuppressionTable proves first,
// that message can only come from the probed table's own trigger.
func requirePushSuppressionTruncateRefused(t *testing.T, err error) {
	t.Helper()
	requirePushSuppressionPGError(t, err, "0A000", "")
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Message != "push suppression authority domain cannot be truncated" {
		t.Fatalf("TRUNCATE error=%v, want the push suppression authority domain truncate trigger's refusal", err)
	}
}
