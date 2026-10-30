// SPDX-License-Identifier: AGPL-3.0-only

// Package privatedb gives a database test a PostgreSQL database of its own.
// It creates the database on the configured server, migrates it, points
// connections at it, refuses to act anywhere else, and drops it.
//
// It is test support only. Only _test.go files, and other test-support
// packages under internal/testsupport, may import it:
// TestProductionCodeDoesNotImportTestSupport fails if any other Go file in
// apps/api does. It is an ordinary package only because Go cannot share
// _test.go code between packages.
//
// # Why a private database
//
// CI runs every Go package's tests in parallel against one shared database.
// Some proofs cannot run there. They take table-wide locks that every tenant
// DELETE queues behind, sweep every tenant's rows, move deployment-wide
// state, or stop the migration history part-way. So each of them creates a
// database on the same server with the administrative URL's credentials, and
// applies the migration history with the runner CI's migrate step uses.
//
// # Lifecycles
//
// A Shared database belongs to one test process. The first test that needs it
// creates it, every later test reuses it (-count repeats included), and
// TestMain drops it through Main. ForTest creates a database for one test and
// drops it when that test ends.
//
// # What every private database has in common
//
//   - Naming: Spec.Prefix followed by 12 random hexadecimal digits.
//   - Retry: other packages' tenant deletes can briefly fill PostgreSQL's
//     shared lock table. The statement that needs a lock at that moment fails
//     with SQLSTATE 53200, which says nothing about the migrations. An
//     attempt that fails that way is dropped and repeated on a new database,
//     up to Attempts times, waiting 2 s and then 4 s.
//   - Pointing: Database.Connect and Database.DSN point a connection string at
//     the private database whatever form it takes. DSN refuses a string that
//     would still reach another database.
//   - Refusing: Database.RequireConnected fails the test unless a connection is
//     in the private database, and Connect checks every pool it opens that
//     way. A statement meant for the private database therefore cannot reach
//     the shared one.
//   - Dropping: DROP DATABASE ... WITH (FORCE), which ends any session a
//     failed test left open. A database that cannot be dropped fails the test
//     or the run, because it would otherwise go unseen.
package privatedb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
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

// Attempts bounds how many databases one Shared.Require or ForTest call
// creates when SQLSTATE 53200 interrupts building them.
const Attempts = 3

const (
	sqlStateLockTableFull = "53200"
	suffixDigits          = 12
	// maxNameBytes is PostgreSQL's identifier limit, NAMEDATALEN - 1.
	maxNameBytes = 63
	// createTimeout bounds creating and migrating one database, retries
	// included.
	createTimeout = 8 * time.Minute
)

var prefixPattern = regexp.MustCompile(`^postwave_[a-z0-9_]*_$`)

// Spec says how to build a private database.
type Spec struct {
	// Prefix starts every database name. It must match ^postwave_[a-z0-9_]*_$.
	// A database without it is never treated as private.
	Prefix string
	// Label names the database in logs and failures.
	Label string
	// Migrations are applied in order. Nil applies the whole history in
	// infra/migrations, so the database is at head.
	Migrations []migrationrunner.MigrationFile
	// Check, when set, runs after the migrations on an administrative pool in
	// the new database. An error fails the attempt.
	Check func(ctx context.Context, admin *pgxpool.Pool) error
}

func (s Spec) label() string {
	if s.Label == "" {
		return "private database"
	}
	return s.Label
}

// Applied returns a Spec.Check that fails unless schema_migrations records
// version exactly once.
func Applied(version string) func(context.Context, *pgxpool.Pool) error {
	return func(ctx context.Context, admin *pgxpool.Pool) error {
		var rows int
		if err := admin.QueryRow(ctx,
			`SELECT count(*)::int FROM schema_migrations WHERE version = $1`, version,
		).Scan(&rows); err != nil {
			return fmt.Errorf("read the migration ledger: %w", err)
		}
		if rows != 1 {
			return fmt.Errorf("migration ledger rows for %s = %d, want 1", version, rows)
		}
		return nil
	}
}

// History loads the whole ordered migration history from infra/migrations.
func History() ([]migrationrunner.MigrationFile, error) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		return nil, errors.New("resolve privatedb's source path to find infra/migrations")
	}
	files, err := migrationrunner.LoadFiles(
		filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "..", "infra", "migrations"),
	)
	if err != nil {
		return nil, fmt.Errorf("load migrations: %w", err)
	}
	return files, nil
}

// Database is one private database. The zero Database is no database: Is
// reports false for every name, and DSN refuses every string.
type Database struct {
	name   string
	prefix string
}

// Name returns the database's name, or "" for the zero Database.
func (d Database) Name() string { return d.name }

// Is reports whether current, a current_database() result, is this private
// database.
func (d Database) Is(current string) bool {
	return d.name != "" && current == d.name && strings.HasPrefix(current, d.prefix)
}

// Querier is a pool, a connection or a transaction.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// RequireConnected fails the test unless q is connected to d. Call it on the
// connection or transaction that will run a statement which must never reach
// any other database; action names that statement in the failure.
func (d Database) RequireConnected(t testing.TB, ctx context.Context, q Querier, action string) {
	t.Helper()
	var current string
	if err := q.QueryRow(ctx, `SELECT current_database()`).Scan(&current); err != nil {
		t.Fatalf("read the current database before %s: %v", action, err)
	}
	if !d.Is(current) {
		t.Fatalf("refusing %s in database %q: only the private database %q may run it", action, current, d.name)
	}
}

// Connect opens a pool on connString's server with its role and options,
// connected to d, and closes it when the test ends. role names the pool in
// failures.
func (d Database) Connect(t testing.TB, connString, role string) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		t.Fatalf("parse the %s database URL: %v", role, err)
	}
	config.ConnConfig.Database = d.name
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatalf("connect the %s role to %s: %v", role, d.name, err)
	}
	t.Cleanup(pool.Close)
	d.RequireConnected(t, context.Background(), pool, "the "+role+" pool")
	return pool
}

// DSN points a libpq connection string, URL or keyword/value form, at d with
// the same server, role and options. It is for code that takes only a string,
// such as db.New or an environment variable.
//
// In a URL, a dbname or database query parameter overrides the path, so both
// are removed. In the keyword/value form the last setting wins, so dbname is
// appended. The result is then parsed the way pgx parses it when it connects,
// environment and service file included, and refused unless it names d.
func (d Database) DSN(dsn string) (string, error) {
	if d.name == "" {
		return "", errors.New("no private database to point the connection string at")
	}
	rewritten := dsn + " dbname=" + d.name
	if strings.Contains(dsn, "://") {
		u, err := url.Parse(dsn)
		if err != nil {
			return "", err
		}
		u.Path = "/" + d.name
		u.RawPath = ""
		query := u.Query()
		query.Del("dbname")
		query.Del("database")
		u.RawQuery = query.Encode()
		rewritten = u.String()
	}
	config, err := pgconn.ParseConfig(rewritten)
	if err != nil {
		return "", fmt.Errorf("parse the connection string pointed at %s: %w", d.name, err)
	}
	if config.Database != d.name {
		return "", fmt.Errorf("the connection string pointed at %s connects to database %q instead", d.name, config.Database)
	}
	return rewritten, nil
}

// ForTest creates and migrates a private database for t alone and drops it
// when t ends. Cleanups registered after ForTest returns, such as closing the
// pools Connect opens, run before the drop. A database that was created but
// could not be migrated is dropped too.
func ForTest(t testing.TB, adminURL string, spec Spec) Database {
	t.Helper()
	started := time.Now()
	name, attempts, err := create(adminURL, spec)
	if name != "" {
		t.Cleanup(func() {
			if dropErr := drop(adminURL, name); dropErr != nil {
				t.Errorf("drop %s %s: %v", spec.label(), name, dropErr)
			}
		})
	}
	t.Log(report(spec, name, attempts, time.Since(started), err))
	if err != nil {
		t.Fatalf("%s: %v", spec.label(), err)
	}
	return Database{name: name, prefix: spec.Prefix}
}

// Shared is a private database for a whole test process. Declare one per
// package with NewShared, call Require from each test that needs it, and drop
// it from TestMain with Main.
type Shared struct {
	spec Spec

	mu        sync.Mutex // guards the fields below
	attempted bool
	name      string // set once CREATE DATABASE succeeds, even if migrating then fails
	adminURL  string
	err       error

	// exclusive is held by each test that calls Exclusive, until it ends.
	exclusive sync.Mutex
}

// NewShared declares a Shared database. Nothing is created until Require.
func NewShared(spec Spec) *Shared {
	return &Shared{spec: spec}
}

// Require returns the shared database, creating and migrating it with
// adminURL on the first call. Later calls return the first call's result,
// including its error, so a failed migration is not repeated once per test:
// each call fails its test with that error. The call that did the work logs
// how it went.
func (s *Shared) Require(t testing.TB, adminURL string) Database {
	t.Helper()
	database, logLine, err := s.ensure(adminURL)
	if logLine != "" {
		t.Log(logLine)
	}
	if err != nil {
		t.Fatalf("%s: %v", s.spec.label(), err)
	}
	return database
}

func (s *Shared) ensure(adminURL string) (Database, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attempted {
		return s.current(), "", s.err
	}
	s.attempted = true
	s.adminURL = adminURL
	started := time.Now()
	var attempts int
	s.name, attempts, s.err = create(adminURL, s.spec)
	return s.current(), report(s.spec, s.name, attempts, time.Since(started), s.err), s.err
}

// Exclusive gives the calling test sole use of the shared database, among the
// tests that call Exclusive, until the test ends. Call it right after Require,
// so every cleanup the test registers later runs while it still holds the
// database.
func (s *Shared) Exclusive(t testing.TB) {
	s.exclusive.Lock()
	t.Cleanup(s.exclusive.Unlock)
}

// Current returns the shared database, or the zero Database if this process
// has not created it.
func (s *Shared) Current() Database {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current()
}

func (s *Shared) current() Database {
	if s.name == "" {
		return Database{}
	}
	return Database{name: s.name, prefix: s.spec.Prefix}
}

// Drop drops the shared database if this process created one.
func (s *Shared) Drop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.name == "" {
		return nil
	}
	if err := drop(s.adminURL, s.name); err != nil {
		return fmt.Errorf("drop %s %s: %w", s.spec.label(), s.name, err)
	}
	s.name = ""
	return nil
}

// Main runs the package's tests, drops each shared database the process
// created, and exits. A database that cannot be dropped fails the run, because
// it would otherwise go unseen. Call it as the whole of TestMain.
func Main(m *testing.M, shared ...*Shared) {
	os.Exit(runAndDrop(m.Run, os.Stderr, shared))
}

func runAndDrop(run func() int, stderr io.Writer, shared []*Shared) int {
	code := run()
	for _, s := range shared {
		if err := s.Drop(); err != nil {
			_, _ = fmt.Fprintf(stderr, "FAIL: %v\n", err)
			if code == 0 {
				code = 1
			}
		}
	}
	return code
}

func report(spec Spec, name string, attempts int, elapsed time.Duration, err error) string {
	outcome := "created and migrated"
	if err != nil {
		outcome = "failed to create and migrate"
	}
	return fmt.Sprintf("%s %s %q in %s (attempts: %d)",
		outcome, spec.label(), name, elapsed.Round(time.Millisecond), attempts)
}

// create creates a database and migrates it. An attempt that fails with
// SQLSTATE 53200 is dropped and repeated on a new database, up to Attempts
// times. It returns the name of the last database it created, even when
// migrating that one failed, so the caller can still drop it.
func create(adminURL string, spec Spec) (name string, attempts int, err error) {
	if !prefixPattern.MatchString(spec.Prefix) || len(spec.Prefix)+suffixDigits > maxNameBytes {
		return "", 0, fmt.Errorf("database prefix %q must match %s and leave %d of PostgreSQL's %d name bytes for the suffix",
			spec.Prefix, prefixPattern, suffixDigits, maxNameBytes)
	}
	files := spec.Migrations
	if files == nil {
		if files, err = History(); err != nil {
			return "", 0, err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), createTimeout)
	defer cancel()
	control, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return "", 0, fmt.Errorf("connect the administrative database: %w", err)
	}
	defer func() { _ = control.Close(context.Background()) }()

	for attempts = 1; ; attempts++ {
		name, err = attempt(ctx, control, adminURL, spec, files)
		var pgErr *pgconn.PgError
		lockTableFull := errors.As(err, &pgErr) && pgErr.Code == sqlStateLockTableFull
		if err == nil || !lockTableFull || attempts == Attempts {
			return name, attempts, err
		}
		if name != "" {
			if dropErr := dropWith(ctx, control, name); dropErr != nil {
				return name, attempts, fmt.Errorf("%w; drop %s before retrying: %w", err, name, dropErr)
			}
		}
		select {
		case <-ctx.Done():
			return "", attempts, fmt.Errorf("%w; retry after SQLSTATE 53200: %w", err, ctx.Err())
		case <-time.After(time.Duration(attempts) * 2 * time.Second):
		}
	}
}

// attempt is one try of create. It returns the name as soon as the database
// exists.
func attempt(
	ctx context.Context,
	control *pgx.Conn,
	adminURL string,
	spec Spec,
	files []migrationrunner.MigrationFile,
) (string, error) {
	suffix := make([]byte, suffixDigits/2)
	if _, err := rand.Read(suffix); err != nil {
		return "", fmt.Errorf("name the database: %w", err)
	}
	name := spec.Prefix + hex.EncodeToString(suffix)
	if _, err := control.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		return "", fmt.Errorf("create database %s: %w", name, err)
	}
	config, err := pgxpool.ParseConfig(adminURL)
	if err != nil {
		return name, fmt.Errorf("parse the administrative database URL: %w", err)
	}
	config.ConnConfig.Database = name
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return name, fmt.Errorf("connect %s: %w", name, err)
	}
	defer pool.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err = migrationrunner.RunWithOptions(
		ctx, pool, files, logger, migrationrunner.RunOptions{AllowUnsafe: true},
	); err != nil {
		return name, fmt.Errorf("migrate %s: %w", name, err)
	}
	if spec.Check != nil {
		if err = spec.Check(ctx, pool); err != nil {
			return name, fmt.Errorf("check %s after migrating it: %w", name, err)
		}
	}
	return name, nil
}

func drop(adminURL, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	control, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return fmt.Errorf("connect the administrative database: %w", err)
	}
	defer func() { _ = control.Close(context.Background()) }()
	return dropWith(ctx, control, name)
}

// dropWith drops name. FORCE ends any session a failed or interrupted test
// left open.
func dropWith(ctx context.Context, control *pgx.Conn, name string) error {
	_, err := control.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
	return err
}
