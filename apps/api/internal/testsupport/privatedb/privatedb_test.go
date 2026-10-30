// SPDX-License-Identifier: AGPL-3.0-only

package privatedb

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
)

const selfTestPrefix = "postwave_privatedb_selftest_"

// unreachableAdminURL refuses connections at once, so a test can tell whether
// a step connected before it failed.
const unreachableAdminURL = "postgres://postwave@127.0.0.1:1/postwave?connect_timeout=2&sslmode=disable"

// TestDSNPointsEveryFormAtThePrivateDatabase proves the rewrite that every
// private-database connection string goes through. However the configured URL
// names its database, the result names only the private one and keeps the
// server, role and options. A string whose rewrite would still reach another
// database is refused.
func TestDSNPointsEveryFormAtThePrivateDatabase(t *testing.T) {
	private := Database{name: selfTestPrefix + "0123456789ab", prefix: selfTestPrefix}
	wantURL := "postgres://postwave_app:pw@127.0.0.1:5432/" + private.name + "?sslmode=disable"
	for _, tc := range []struct{ dsn, want string }{
		{"postgres://postwave_app:pw@127.0.0.1:5432/postwave?sslmode=disable", wantURL},
		{"postgres://postwave_app:pw@127.0.0.1:5432/?dbname=postwave&sslmode=disable", wantURL},
		{"postgres://postwave_app:pw@127.0.0.1:5432/postwave?database=postwave&sslmode=disable", wantURL},
		{"postgres://postwave_app:pw@127.0.0.1:5432/postwave?dbname=a&database=b&sslmode=disable", wantURL},
		{
			"host=127.0.0.1 port=5432 user=postwave_app password=pw dbname=postwave sslmode=disable",
			"host=127.0.0.1 port=5432 user=postwave_app password=pw dbname=postwave sslmode=disable dbname=" + private.name,
		},
	} {
		got, err := private.DSN(tc.dsn)
		if err != nil || got != tc.want {
			t.Errorf("DSN(%q) = %q, %v; want %q", tc.dsn, got, err, tc.want)
		}
	}
	// A trailing backslash escapes the space before the appended dbname, which
	// then becomes part of the password; the database stays postwave.
	escaped := `host=127.0.0.1 user=postwave_app dbname=postwave password=pw\`
	if got, err := private.DSN(escaped); err == nil {
		t.Errorf("DSN(%q) = %q, want a refusal: it still connects to postwave", escaped, got)
	}
	if got, err := (Database{}).DSN(wantURL); err == nil {
		t.Errorf("the zero Database pointed %q at %q, want a refusal", wantURL, got)
	}
}

// TestIsAcceptsOnlyThePrivateDatabase pins the rule every refusal rests on.
func TestIsAcceptsOnlyThePrivateDatabase(t *testing.T) {
	private := Database{name: selfTestPrefix + "0123456789ab", prefix: selfTestPrefix}
	if !private.Is(private.name) {
		t.Errorf("%q is not its own database", private.name)
	}
	for _, current := range []string{"", "postwave", selfTestPrefix, private.name + "0", strings.ToUpper(private.name)} {
		if private.Is(current) {
			t.Errorf("Is(%q) = true for the private database %q", current, private.name)
		}
	}
	for _, current := range []string{"", "postwave"} {
		if (Database{}).Is(current) {
			t.Errorf("the zero Database claims %q", current)
		}
	}
	// A name without the prefix is never private, even when it matches.
	if unprefixed := (Database{name: "postwave", prefix: selfTestPrefix}); unprefixed.Is("postwave") {
		t.Error("a database named without the prefix was treated as private")
	}
}

// TestCreateRefusesAPrefixItCannotName checks the prefix before connecting:
// with an unreachable server, any error but the prefix's would mean it
// connected first.
func TestCreateRefusesAPrefixItCannotName(t *testing.T) {
	for _, prefix := range []string{
		"",
		"postwave_",
		"postwave_x",
		"Postwave_x_",
		"postwave_X_",
		"postwave_x-y_",
		"other_x_",
		"postwave_" + strings.Repeat("x", maxNameBytes-suffixDigits-len("postwave_")) + "_",
	} {
		name, attempts, err := create(unreachableAdminURL, Spec{Prefix: prefix})
		if err == nil || !strings.Contains(err.Error(), "database prefix") || name != "" || attempts != 0 {
			t.Errorf("create with prefix %q = %q, %d, %v; want the prefix refused before any attempt", prefix, name, attempts, err)
		}
	}
	longest := "postwave_" + strings.Repeat("x", maxNameBytes-suffixDigits-len("postwave_")-1) + "_"
	if _, _, err := create(unreachableAdminURL, Spec{Prefix: longest, Migrations: []migrationrunner.MigrationFile{}}); err == nil ||
		strings.Contains(err.Error(), "database prefix") {
		t.Errorf("create with the longest valid prefix %q = %v; want it to reach the server", longest, err)
	}
}

// TestMainFailsTheRunWhenADatabaseCannotBeDropped proves a database left
// behind fails the run instead of going unseen, and never hides a failure the
// tests already reported.
func TestMainFailsTheRunWhenADatabaseCannotBeDropped(t *testing.T) {
	undroppable := NewShared(Spec{Prefix: selfTestPrefix, Label: "undroppable database"})
	undroppable.name = selfTestPrefix + "0123456789ab"
	undroppable.adminURL = unreachableAdminURL
	never := NewShared(Spec{Prefix: selfTestPrefix})

	for _, tc := range []struct {
		tests, want int
		shared      []*Shared
		wantOutput  bool
	}{
		{tests: 0, want: 0, shared: []*Shared{never}},
		{tests: 3, want: 3, shared: []*Shared{never}},
		{tests: 0, want: 1, shared: []*Shared{never, undroppable}, wantOutput: true},
		{tests: 3, want: 3, shared: []*Shared{undroppable}, wantOutput: true},
	} {
		var stderr bytes.Buffer
		ran := false
		got := runAndDrop(func() int { ran = true; return tc.tests }, &stderr, tc.shared)
		if !ran || got != tc.want {
			t.Errorf("tests exiting %d with %d shared database(s): ran=%v code=%d, want %d", tc.tests, len(tc.shared), ran, got, tc.want)
		}
		wantLine := "FAIL: drop undroppable database " + undroppable.name + ": "
		if hasLine := strings.HasPrefix(stderr.String(), wantLine); hasLine != tc.wantOutput {
			t.Errorf("tests exiting %d: stderr %q, want a %q line: %v", tc.tests, stderr.String(), wantLine, tc.wantOutput)
		}
	}
	if undroppable.Current().Name() != undroppable.name {
		t.Error("a database that could not be dropped was forgotten")
	}
}

// fatalRecorder stands in for a test so a Fatalf path can be observed: it
// records the failure and ends the calling goroutine, as the real one does,
// and keeps the cleanups for the caller to run.
type fatalRecorder struct {
	testing.TB
	mu       sync.Mutex
	fatal    string
	cleanups []func()
}

func (r *fatalRecorder) Helper() {}

func (r *fatalRecorder) Fatalf(format string, args ...any) {
	r.mu.Lock()
	r.fatal = fmt.Sprintf(format, args...)
	r.mu.Unlock()
	runtime.Goexit()
}

func (r *fatalRecorder) Errorf(format string, args ...any) {
	r.TB.Errorf("unexpected Errorf from the code under test: "+format, args...)
}

func (r *fatalRecorder) Cleanup(f func()) {
	r.mu.Lock()
	r.cleanups = append(r.cleanups, f)
	r.mu.Unlock()
}

// run calls f as the recorded test and reports how it failed, if it did.
func (r *fatalRecorder) run(f func(testing.TB)) string {
	done := make(chan struct{})
	go func() {
		defer close(done)
		f(r)
	}()
	<-done
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fatal
}

func (r *fatalRecorder) runCleanups() {
	r.mu.Lock()
	cleanups := r.cleanups
	r.cleanups = nil
	r.mu.Unlock()
	for i := len(cleanups) - 1; i >= 0; i-- {
		cleanups[i]()
	}
}

func selfTestAdminURL(t *testing.T) string {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; the helper's own database proofs need a role that can create databases")
	}
	return adminURL
}

// firstMigration is the smallest real history: it proves a Spec's migrations
// are the ones applied without paying for the whole history.
func firstMigration(t *testing.T) []migrationrunner.MigrationFile {
	t.Helper()
	history, err := History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(history) < 2 || history[0].Version != "0001_init_tenants" {
		t.Fatalf("History starts %d file(s) at %q, want the ordered history from 0001_init_tenants", len(history), history[0].Version)
	}
	return history[:1]
}

func databaseExists(t *testing.T, adminURL, name string) bool {
	t.Helper()
	ctx := context.Background()
	control, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect the administrative database: %v", err)
	}
	defer func() { _ = control.Close(context.Background()) }()
	var exists bool
	if err := control.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil {
		t.Fatalf("look up database %s: %v", name, err)
	}
	return exists
}

func currentDatabase(ctx context.Context, q Querier) (string, error) {
	var current string
	err := q.QueryRow(ctx, `SELECT current_database()`).Scan(&current)
	return current, err
}

// TestForTestMigratesConnectsRefusesAndDrops follows one per-test database
// through its whole life.
func TestForTestMigratesConnectsRefusesAndDrops(t *testing.T) {
	adminURL := selfTestAdminURL(t)
	migrations := firstMigration(t)
	var name string
	t.Run("lifetime", func(t *testing.T) {
		private := ForTest(t, adminURL, Spec{
			Prefix:     selfTestPrefix,
			Label:      "self-test database",
			Migrations: migrations,
			Check:      Applied(migrations[0].Version),
		})
		name = private.Name()
		if !strings.HasPrefix(name, selfTestPrefix) || len(name) != len(selfTestPrefix)+suffixDigits {
			t.Fatalf("database name %q, want %s and %d hexadecimal digits", name, selfTestPrefix, suffixDigits)
		}
		if !databaseExists(t, adminURL, name) {
			t.Fatalf("database %s does not exist while its test runs", name)
		}
		pool := private.Connect(t, adminURL, "administrative")
		var tenants, versions int
		if err := pool.QueryRow(context.Background(), `
SELECT (SELECT count(*) FROM pg_class WHERE relname = 'tenants' AND relkind IN ('r', 'p'))::int,
       (SELECT count(*) FROM schema_migrations)::int`).Scan(&tenants, &versions); err != nil {
			t.Fatalf("read the migrated database: %v", err)
		}
		if tenants != 1 || versions != 1 {
			t.Fatalf("migrated database has tenants tables=%d, ledger rows=%d; want exactly the first migration", tenants, versions)
		}

		// The DSN form reaches the same database.
		dsn, err := private.DSN(adminURL)
		if err != nil {
			t.Fatalf("DSN: %v", err)
		}
		viaDSN, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			t.Fatalf("connect through the DSN: %v", err)
		}
		defer viaDSN.Close()
		current, err := currentDatabase(context.Background(), viaDSN)
		if err != nil || current != name {
			t.Fatalf("DSN connects to %q, %v; want %q", current, err, name)
		}

		// A connection anywhere else is refused.
		shared, err := pgxpool.New(context.Background(), adminURL)
		if err != nil {
			t.Fatalf("connect the administrative database: %v", err)
		}
		defer shared.Close()
		recorder := &fatalRecorder{TB: t}
		refusal := recorder.run(func(tb testing.TB) {
			private.RequireConnected(tb, context.Background(), shared, "a self-test statement")
		})
		if !strings.HasPrefix(refusal, "refusing a self-test statement in database ") {
			t.Fatalf("RequireConnected on another database = %q, want a refusal", refusal)
		}
		recorder = &fatalRecorder{TB: t}
		if refusal := recorder.run(func(tb testing.TB) {
			private.RequireConnected(tb, context.Background(), pool, "a self-test statement")
		}); refusal != "" {
			t.Fatalf("RequireConnected on the private database refused: %s", refusal)
		}
		recorder = &fatalRecorder{TB: t}
		if refusal := recorder.run(func(tb testing.TB) {
			Database{}.RequireConnected(tb, context.Background(), pool, "a self-test statement")
		}); !strings.HasPrefix(refusal, "refusing a self-test statement in database ") {
			t.Fatalf("the zero Database accepted %s: %q", name, refusal)
		}
	})
	if name == "" {
		t.Fatal("the lifetime subtest never created a database")
	}
	if databaseExists(t, adminURL, name) {
		if err := drop(adminURL, name); err != nil {
			t.Errorf("drop leftover %s: %v", name, err)
		}
		t.Fatalf("database %s outlived its test", name)
	}
}

// TestForTestDropsADatabaseItCouldNotFinish proves a database whose check
// failed fails its test and is still dropped when the test ends.
func TestForTestDropsADatabaseItCouldNotFinish(t *testing.T) {
	adminURL := selfTestAdminURL(t)
	var built string
	recorder := &fatalRecorder{TB: t}
	failure := recorder.run(func(tb testing.TB) {
		ForTest(tb, adminURL, Spec{
			Prefix:     selfTestPrefix,
			Label:      "unfinished self-test database",
			Migrations: firstMigration(t),
			Check: func(ctx context.Context, admin *pgxpool.Pool) error {
				var err error
				built, err = currentDatabase(ctx, admin)
				if err != nil {
					return err
				}
				return &pgconn.PgError{Code: "42P01", Message: "simulated missing relation"}
			},
		})
	})
	if built == "" {
		t.Fatal("the check never ran")
	}
	t.Cleanup(func() {
		if databaseExists(t, adminURL, built) {
			if err := drop(adminURL, built); err != nil {
				t.Errorf("drop leftover %s: %v", built, err)
			}
		}
	})
	if !strings.Contains(failure, "unfinished self-test database: check "+built) || !strings.Contains(failure, "simulated missing relation") {
		t.Fatalf("ForTest failure = %q, want the check's error for %s", failure, built)
	}
	if !databaseExists(t, adminURL, built) {
		t.Fatalf("database %s was dropped before its test ended", built)
	}
	recorder.runCleanups()
	if databaseExists(t, adminURL, built) {
		t.Fatalf("database %s survived the end of the test whose check failed", built)
	}
}

// TestCreateRetriesOnlyTheLockTableRunningOut proves the bounded 53200 retry:
// a database interrupted that way is dropped and replaced, any other failure
// is returned at once, and the retries stop at Attempts.
func TestCreateRetriesOnlyTheLockTableRunningOut(t *testing.T) {
	adminURL := selfTestAdminURL(t)
	migrations := firstMigration(t)
	lockTableFull := &pgconn.PgError{Code: "53200", Message: "simulated: out of shared memory"}

	// failFirst fails the first n checks with fail, and records the database
	// each check ran in.
	failFirst := func(n int, fail error, seen *[]string) func(context.Context, *pgxpool.Pool) error {
		return func(ctx context.Context, admin *pgxpool.Pool) error {
			current, err := currentDatabase(ctx, admin)
			if err != nil {
				return err
			}
			*seen = append(*seen, current)
			if len(*seen) <= n {
				return fail
			}
			return nil
		}
	}
	dropAtEnd := func(name string) {
		t.Cleanup(func() {
			if name != "" {
				if err := drop(adminURL, name); err != nil {
					t.Errorf("drop %s: %v", name, err)
				}
			}
		})
	}

	t.Run("53200 once", func(t *testing.T) {
		var seen []string
		name, attempts, err := create(adminURL, Spec{Prefix: selfTestPrefix, Migrations: migrations, Check: failFirst(1, lockTableFull, &seen)})
		dropAtEnd(name)
		if err != nil || attempts != 2 || len(seen) != 2 || seen[1] != name || seen[0] == name {
			t.Fatalf("create = %q, %d, %v after checks in %v; want success on a second database", name, attempts, err, seen)
		}
		if databaseExists(t, adminURL, seen[0]) {
			t.Fatalf("the interrupted database %s was not dropped before the retry", seen[0])
		}
		if !databaseExists(t, adminURL, name) {
			t.Fatalf("the database create returned, %s, does not exist", name)
		}
	})

	t.Run("other failure", func(t *testing.T) {
		var seen []string
		other := &pgconn.PgError{Code: "42P01", Message: "simulated missing relation"}
		name, attempts, err := create(adminURL, Spec{Prefix: selfTestPrefix, Migrations: migrations, Check: failFirst(1, other, &seen)})
		dropAtEnd(name)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "42P01" || attempts != 1 || len(seen) != 1 || name != seen[0] {
			t.Fatalf("create = %q, %d, %v after checks in %v; want the 42P01 failure from one attempt", name, attempts, err, seen)
		}
		if !databaseExists(t, adminURL, name) {
			t.Fatalf("create dropped %s itself; the caller must be left to drop it", name)
		}
	})

	t.Run("53200 every time", func(t *testing.T) {
		var seen []string
		name, attempts, err := create(adminURL, Spec{Prefix: selfTestPrefix, Migrations: migrations, Check: failFirst(Attempts, lockTableFull, &seen)})
		dropAtEnd(name)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "53200" || attempts != Attempts || len(seen) != Attempts || name != seen[Attempts-1] {
			t.Fatalf("create = %q, %d, %v after checks in %v; want the 53200 failure after %d attempts", name, attempts, err, seen, Attempts)
		}
		for _, interrupted := range seen[:Attempts-1] {
			if databaseExists(t, adminURL, interrupted) {
				t.Fatalf("the interrupted database %s was not dropped", interrupted)
			}
		}
		if !databaseExists(t, adminURL, name) {
			t.Fatalf("create dropped its last database %s; the caller must be left to drop it", name)
		}
	})
}

// TestSharedCreatesOnceAndDrops proves a shared database is built by the first
// Require only, reused by every later one, and gone after Drop.
func TestSharedCreatesOnceAndDrops(t *testing.T) {
	adminURL := selfTestAdminURL(t)
	checks := 0
	shared := NewShared(Spec{
		Prefix:     selfTestPrefix,
		Label:      "shared self-test database",
		Migrations: firstMigration(t),
		Check: func(context.Context, *pgxpool.Pool) error {
			checks++
			return nil
		},
	})
	t.Cleanup(func() {
		if err := shared.Drop(); err != nil {
			t.Errorf("drop: %v", err)
		}
	})
	if current := shared.Current(); current.Name() != "" {
		t.Fatalf("Current before Require = %q, want no database", current.Name())
	}
	first := shared.Require(t, adminURL)
	second := shared.Require(t, adminURL)
	if first.Name() == "" || second.Name() != first.Name() || checks != 1 {
		t.Fatalf("Require twice = %q then %q after %d build(s); want one database built once", first.Name(), second.Name(), checks)
	}
	if !shared.Current().Is(first.Name()) || !databaseExists(t, adminURL, first.Name()) {
		t.Fatalf("shared database %s is not current or does not exist", first.Name())
	}
	if err := shared.Drop(); err != nil {
		t.Fatalf("Drop: %v", err)
	}
	if databaseExists(t, adminURL, first.Name()) {
		t.Fatalf("shared database %s survived Drop", first.Name())
	}
	if current := shared.Current(); current.Name() != "" || current.Is(first.Name()) {
		t.Fatalf("Current after Drop = %q, want no database", current.Name())
	}
	if err := shared.Drop(); err != nil {
		t.Fatalf("a second Drop = %v, want nothing to do", err)
	}
}

// TestExclusiveHoldsTheDatabaseUntilTheTestEnds proves Exclusive gives one
// test at a time the shared database, from the call until the test's cleanups
// run.
func TestExclusiveHoldsTheDatabaseUntilTheTestEnds(t *testing.T) {
	shared := NewShared(Spec{Prefix: selfTestPrefix})
	first := &fatalRecorder{TB: t}
	if failure := first.run(func(tb testing.TB) { shared.Exclusive(tb) }); failure != "" {
		t.Fatalf("first Exclusive failed: %s", failure)
	}
	second := &fatalRecorder{TB: t}
	acquired := make(chan string, 1)
	go func() { acquired <- second.run(func(tb testing.TB) { shared.Exclusive(tb) }) }()
	select {
	case <-acquired:
		t.Fatal("a second test took the database while the first still held it")
	case <-time.After(200 * time.Millisecond):
	}
	first.runCleanups()
	select {
	case failure := <-acquired:
		if failure != "" {
			t.Fatalf("second Exclusive failed: %s", failure)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the second test never got the database after the first one ended")
	}
	second.runCleanups()
}

// TestSharedRepeatsItsFirstFailure proves a build refused before it creates
// anything fails every Require and leaves no database behind. It needs no
// server, so it cannot tell a repeated build from a remembered one: a misnamed
// prefix fails the same way every time. TestSharedKeepsAndRepeatsAFailedBuild
// proves the build is not repeated.
func TestSharedRepeatsItsFirstFailure(t *testing.T) {
	shared := NewShared(Spec{Prefix: "not_a_postwave_prefix_", Label: "misnamed database"})
	for i := 1; i <= 2; i++ {
		recorder := &fatalRecorder{TB: t}
		failure := recorder.run(func(tb testing.TB) { shared.Require(tb, unreachableAdminURL) })
		if !strings.HasPrefix(failure, "misnamed database: database prefix ") {
			t.Fatalf("Require #%d failure = %q, want the first build's error", i, failure)
		}
	}
	if !shared.attempted || shared.Current().Name() != "" {
		t.Fatal("a failed shared build was not recorded as attempted, or left a database behind")
	}
}

// TestSharedKeepsAndRepeatsAFailedBuild follows a shared build that fails after
// CREATE DATABASE, because its Check, Applied, refuses a version the
// migrations did not record. Each Require fails with that first error and
// builds nothing more: the Check runs once. The failed database stays current,
// so that Main can drop it, and Main does.
func TestSharedKeepsAndRepeatsAFailedBuild(t *testing.T) {
	adminURL := selfTestAdminURL(t)
	history, err := History()
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(history) < 2 {
		t.Fatalf("History has %d file(s), want at least two", len(history))
	}
	// A real version, one the migrations below do not apply.
	missing := history[1].Version
	var built []string
	shared := NewShared(Spec{
		Prefix:     selfTestPrefix,
		Label:      "failing shared self-test database",
		Migrations: history[:1],
		Check: func(ctx context.Context, admin *pgxpool.Pool) error {
			current, err := currentDatabase(ctx, admin)
			if err != nil {
				return err
			}
			built = append(built, current)
			return Applied(missing)(ctx, admin)
		},
	})
	t.Cleanup(func() {
		for _, name := range built {
			if databaseExists(t, adminURL, name) {
				if err := drop(adminURL, name); err != nil {
					t.Errorf("drop leftover %s: %v", name, err)
				}
			}
		}
	})

	var failures []string
	for i := 0; i < 2; i++ {
		recorder := &fatalRecorder{TB: t}
		failures = append(failures, recorder.run(func(tb testing.TB) { shared.Require(tb, adminURL) }))
	}
	if len(built) != 1 {
		t.Fatalf("two Requires built and checked %d database(s) %v; a failed shared build must not be repeated",
			len(built), built)
	}
	name := built[0]
	want := "failing shared self-test database: check " + name + " after migrating it: " +
		fmt.Sprintf("migration ledger rows for %s = 0, want 1", missing)
	for i, failure := range failures {
		if failure != want {
			t.Fatalf("Require #%d failure = %q, want the first build's %q", i+1, failure, want)
		}
	}
	if current := shared.Current(); current.Name() != name || !current.Is(name) {
		t.Fatalf("Current after the failed build = %q, want the failed database %s, so that Main can drop it",
			current.Name(), name)
	}
	if !databaseExists(t, adminURL, name) {
		t.Fatalf("the failed database %s is gone before Main ran", name)
	}

	var stderr bytes.Buffer
	if code := runAndDrop(func() int { return 0 }, &stderr, []*Shared{shared}); code != 0 || stderr.Len() != 0 {
		t.Fatalf("runAndDrop = %d with %q, want 0 and nothing reported", code, stderr.String())
	}
	if databaseExists(t, adminURL, name) {
		t.Fatalf("Main left the failed shared database %s on the server", name)
	}
	if current := shared.Current(); current.Name() != "" {
		t.Fatalf("Current after Main = %q, want no database", current.Name())
	}
}
