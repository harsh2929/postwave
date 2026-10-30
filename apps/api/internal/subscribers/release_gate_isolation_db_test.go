// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// Tests that move subscriber_email_consent_release_gate run in a database of
// their own.
//
// The gate is one row for the whole deployment. While it is not open,
// subscriber_email_consent_release_open() is false, and the RESTRICTIVE SELECT
// policy subscriber_emails_nonexpired_positive_visibility hides every
// consent_status = 'subscribed' row from postwave_app in every tenant. The
// policy also filters the WHERE clause of UPDATE and DELETE, which then match
// nothing. CI runs every Go package in parallel against one database. So if
// a test blocks the gate there, even for a second, tests in other packages
// that read or rewrite subscribed addresses at that moment fail: consent
// purpose lookups, the activation firewall, Mailchimp sync and integration
// write-back.
//
// The gate cannot be blocked for one session only:
//   - The writers under test open and commit their own transactions on a
//     *pgxpool.Pool, so they never see a flip left uncommitted on the test's
//     connection.
//   - The gate table is owner-only and is read through a SECURITY DEFINER
//     function with a fixed search_path, so nothing can shadow it.
//   - CREATE DATABASE ... TEMPLATE needs a template with no other sessions,
//     and the shared CI database always has some.
//
// So the first gate test in a test process creates a new database with
// POSTWAVE_TEST_ADMIN_DATABASE_URL and applies the whole migration history,
// through internal/testsupport/privatedb, which owns naming, the SQLSTATE
// 53200 retry, pointing connections at the database and dropping it. Every
// gate test in the process, including -count repeats, then uses that
// database, one test at a time. TestMain drops it at the end. All other tests
// keep using DATABASE_URL.

// isolatedReleaseGate is this process's gate database.
var isolatedReleaseGate = privatedb.NewShared(privatedb.Spec{
	Prefix: "postwave_subscribers_release_gate_",
	Label:  "isolated release-gate database",
	Check:  requireMigratedReleaseGateOpen,
})

// releaseGateDatabase is a gate test's handle on the isolated database.
type releaseGateDatabase struct {
	database privatedb.Database
	adminURL string
}

// requireMigratedReleaseGateOpen is the isolated database's check after it is
// migrated: migration 1766 must leave the gate open, since every gate test
// starts from an open gate.
func requireMigratedReleaseGateOpen(ctx context.Context, admin *pgxpool.Pool) error {
	var status string
	var releaseOpen bool
	if err := admin.QueryRow(ctx, `
SELECT gate.status, subscriber_email_consent_release_open()
  FROM subscriber_email_consent_release_gate AS gate
 WHERE gate.singleton`).Scan(&status, &releaseOpen); err != nil {
		return fmt.Errorf("read the migrated release gate: %w", err)
	}
	if status != "open" || !releaseOpen {
		return fmt.Errorf("migrated release gate is %q (release_open=%v); migration 1766 must leave it open",
			status, releaseOpen)
	}
	return nil
}

// isolatedReleaseGateDatabase returns the isolated gate database, creating and
// migrating it on first use. It gives the calling test sole use of the
// database until the test ends. Call it once per test, before anything else.
func isolatedReleaseGateDatabase(t *testing.T) releaseGateDatabase {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL is required: release-gate proofs run in their own migrated database")
	}
	database := isolatedReleaseGate.Require(t, adminURL)
	// Held for the whole of each gate test, and taken before any pool opens so
	// it is released after they close. Each gate test needs the gate open when
	// it starts, and restores it before it ends. In between, no other test may
	// use the gate.
	isolatedReleaseGate.Exclusive(t)
	gate := releaseGateDatabase{database: database, adminURL: adminURL}
	gate.requireOpenAndRestoreAtEnd(t)
	return gate
}

// requireOpenAndRestoreAtEnd fails the test when, as it starts, the gate is
// not open or a reconciliation run is still running. Either means an earlier
// gate test did not restore the gate, and a gate that is not open would hide
// every subscribed row this test seeds, so the failure would show up far from
// its cause.
//
// It then makes the test hand the gate back that way however it ends. A test
// that fails part-way can leave the gate blocked, since a reconciliation run
// blocks it until its last batch. It can also leave a run running, which
// start_subscriber_email_consent_reconciliation resumes instead of starting a
// new one. Either way every later gate test in the process would fail as
// well, reporting one failure several times. So when the test ends, a cleanup
// marks any run still running as failed and, if the gate is not open, writes
// the gate row back exactly as it is now. A test that has not failed by then
// but left either behind is failed: every gate test must restore the gate
// itself.
func (g releaseGateDatabase) requireOpenAndRestoreAtEnd(t *testing.T) {
	t.Helper()
	admin := g.adminPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var database, status string
	var releaseOpen bool
	var running []string
	var saved []byte
	if err := admin.QueryRow(ctx, `
SELECT current_database(),
       gate.status,
       subscriber_email_consent_release_open(),
       ARRAY(SELECT run.id::text
               FROM subscriber_email_consent_reconciliation_runs AS run
              WHERE run.status = 'running'
              ORDER BY run.id),
       to_jsonb(gate)
  FROM subscriber_email_consent_release_gate AS gate
 WHERE gate.singleton`).Scan(&database, &status, &releaseOpen, &running, &saved); err != nil {
		t.Fatalf("read release gate in %s: %v", g.database.Name(), err)
	}
	if !g.database.Is(database) {
		t.Fatalf("release gate read from %q: only the isolated database %q may be used", database, g.database.Name())
	}
	if status != "open" || !releaseOpen || len(running) != 0 {
		t.Fatalf("release gate in %s is %q (release_open=%v, running reconciliation runs=%v) as the test starts: "+
			"an earlier gate test did not restore it", g.database.Name(), status, releaseOpen, running)
	}

	// Every column but the key goes back from the saved row, so a column a
	// later migration adds is restored too.
	var columns map[string]json.RawMessage
	if err := json.Unmarshal(saved, &columns); err != nil {
		t.Fatalf("decode saved release gate: %v", err)
	}
	assignments := make([]string, 0, len(columns))
	for column := range columns {
		if column != "singleton" {
			quoted := pgx.Identifier{column}.Sanitize()
			assignments = append(assignments, quoted+" = saved."+quoted)
		}
	}
	slices.Sort(assignments)
	restoreGate := `
UPDATE subscriber_email_consent_release_gate AS gate
   SET ` + strings.Join(assignments, ", ") + `
  FROM jsonb_populate_record(NULL::public.subscriber_email_consent_release_gate, $1::jsonb) AS saved
 WHERE gate.singleton`
	t.Cleanup(func() { g.restoreAtEnd(t, admin, restoreGate, string(saved)) })
}

// restoreAtEnd is requireOpenAndRestoreAtEnd's cleanup. It refuses any
// database but the isolated one, as block does.
func (g releaseGateDatabase) restoreAtEnd(t *testing.T, admin *pgxpool.Pool, restoreGate, saved string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Errorf("begin release gate restore in %s: %v", g.database.Name(), err)
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var database string
	var releaseOpen bool
	var running []string
	if err = tx.QueryRow(ctx, `
SELECT current_database(),
       subscriber_email_consent_release_open(),
       ARRAY(SELECT run.id::text
               FROM subscriber_email_consent_reconciliation_runs AS run
              WHERE run.status = 'running'
              ORDER BY run.id)
  FROM subscriber_email_consent_release_gate AS gate
 WHERE gate.singleton
   FOR UPDATE OF gate`).Scan(&database, &releaseOpen, &running); err != nil {
		t.Errorf("read release gate in %s at the end of the test: %v", g.database.Name(), err)
		return
	}
	if !g.database.Is(database) {
		t.Errorf("refusing to restore the release gate in %q: only the isolated database %q may be restored",
			database, g.database.Name())
		return
	}
	if releaseOpen && len(running) == 0 {
		return
	}
	if !t.Failed() {
		t.Errorf("the test ended with release_open=%v and reconciliation runs %v still running, "+
			"but a gate test must restore the gate itself", releaseOpen, running)
	}
	if len(running) > 0 {
		if _, err = tx.Exec(ctx, `
UPDATE subscriber_email_consent_reconciliation_runs
   SET status = 'failed',
       last_error_code = 'test_ended_mid_run',
       heartbeat_at = clock_timestamp()
 WHERE status = 'running'`); err != nil {
			t.Errorf("fail the reconciliation runs %v the test left running: %v", running, err)
			return
		}
	}
	if !releaseOpen {
		if _, err = tx.Exec(ctx, restoreGate, saved); err != nil {
			t.Errorf("restore release gate in %s: %v", g.database.Name(), err)
			return
		}
	}
	var reopened bool
	if err = tx.QueryRow(ctx, `SELECT subscriber_email_consent_release_open()`).Scan(&reopened); err != nil {
		t.Errorf("read restored release gate in %s: %v", g.database.Name(), err)
		return
	}
	if !reopened {
		t.Errorf("release gate in %s is still not open after restoring it", g.database.Name())
		return
	}
	if err = tx.Commit(ctx); err != nil {
		t.Errorf("commit release gate restore in %s: %v", g.database.Name(), err)
		return
	}
	t.Logf("restored the release gate in %s (it was open=%v; failed runs %v the test left running)",
		g.database.Name(), releaseOpen, running)
}

// adminPool connects the POSTWAVE_TEST_ADMIN_DATABASE_URL role to the isolated
// database. That role ran the migrations, so it owns the gate table.
func (g releaseGateDatabase) adminPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	return g.database.Connect(t, g.adminURL, "admin")
}

// superuserPool is adminPool for fixtures that need superuser rights, such as
// setting session_replication_role.
func (g releaseGateDatabase) superuserPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := g.adminPool(t)
	var superuser bool
	if err := pool.QueryRow(context.Background(), `
SELECT rolsuper FROM pg_roles WHERE rolname = current_user
`).Scan(&superuser); err != nil {
		t.Fatalf("inspect admin role: %v", err)
	}
	if !superuser {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL must be a superuser for the grandfathered-row fixture")
	}
	return pool
}

// appPool connects the DATABASE_URL role, which the RLS proofs are about, to
// the isolated database.
func (g releaseGateDatabase) appPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if appURL == "" {
		t.Skip("DATABASE_URL (postwave_app) is required for release-gate proofs")
	}
	return g.database.Connect(t, appURL, "application")
}

// block sets the isolated gate to blocked until the test ends, then restores
// the row exactly as it was. The gate must be open when this is called: the
// migration leaves it open, and every gate test restores it. So a gate that
// is not open means an earlier gate test failed to restore it.
func (g releaseGateDatabase) block(t *testing.T) {
	t.Helper()
	admin := g.adminPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var database, status string
	var openedAt *time.Time
	var blockedAt time.Time
	if err := admin.QueryRow(ctx, `
SELECT current_database(), gate.status, gate.opened_at, gate.blocked_at
  FROM subscriber_email_consent_release_gate AS gate
 WHERE gate.singleton`).Scan(&database, &status, &openedAt, &blockedAt); err != nil {
		t.Fatalf("read release gate: %v", err)
	}
	if !g.database.Is(database) {
		t.Fatalf("refusing to block the release gate in %q: only the isolated database %q may be blocked",
			database, g.database.Name())
	}
	if status != "open" || openedAt == nil {
		t.Fatalf("release gate in %s is %q (opened_at=%v) before the test: an earlier gate test did not restore it",
			database, status, openedAt)
	}
	if _, err := admin.Exec(ctx, `
UPDATE subscriber_email_consent_release_gate
   SET status = 'blocked',
       opened_at = NULL,
       blocked_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE singleton`); err != nil {
		t.Fatalf("block release gate: %v", err)
	}
	t.Cleanup(func() {
		restoreCtx, restoreCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer restoreCancel()
		if _, err := admin.Exec(restoreCtx, `
UPDATE subscriber_email_consent_release_gate
   SET status = $1,
       opened_at = $2,
       blocked_at = $3,
       updated_at = clock_timestamp()
 WHERE singleton`, status, openedAt, blockedAt); err != nil {
			t.Errorf("restore release gate: %v", err)
		}
	})
}
