// SPDX-License-Identifier: AGPL-3.0-only

package partition_rotator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var rotatedTables = []string{
	"audit_log", "subscriber_events", "campaign_report_events", "event_log", "web_vitals_events",
}

// appPool connects as the role the API runs the rotator with. db.New refuses
// a superuser or BYPASSRLS role, and the check below refuses the table owner:
// either would pass these tests while production fails.
func appPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping partition rotator DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	var ownsAuditLog bool
	if err := pool.QueryRow(ctx, `
SELECT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.audit_log'::regclass), 'MEMBER')`,
	).Scan(&ownsAuditLog); err != nil {
		t.Fatalf("inspect role: %v", err)
	}
	if ownsAuditLog {
		t.Fatal("DATABASE_URL connects as (a member of) the owner of audit_log; run these tests as postwave_app")
	}
	return pool
}

// failOnWarn is a slog handler that records every warning the worker logs; the
// worker swallows per-table failures after logging them, so the log is where
// a failed DDL step shows up.
type failOnWarn struct{ buf *bytes.Buffer }

func (h failOnWarn) Enabled(_ context.Context, level slog.Level) bool { return level >= slog.LevelWarn }
func (h failOnWarn) Handle(_ context.Context, record slog.Record) error {
	h.buf.WriteString(record.Message)
	record.Attrs(func(attr slog.Attr) bool {
		h.buf.WriteString(" " + attr.Key + "=" + attr.Value.String())
		return true
	})
	h.buf.WriteString("\n")
	return nil
}
func (h failOnWarn) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h failOnWarn) WithGroup(string) slog.Handler      { return h }

// Migration 0339 pre-created partitions through the month it ran in plus two,
// and on a database migrated in autumn 2026 the last are the _p2026_12
// children. The rotator was meant to keep ahead of that, but it ran as
// postwave_app and issued the DDL itself: "permission denied for schema
// public", every night, and from 2027-01-01 every audit write fails with "no
// partition of relation audit_log found for row".
//
// This runs the rotator as that role with its clock set to the month after the
// newest child any rotated table has, so every table needs a partition that
// does not exist yet and only the rotator can make it.
func TestRotatorCreatesPartitionsAsTheApplicationRole(t *testing.T) {
	pool := appPool(t)
	ctx := context.Background()
	var newest time.Time
	if err := pool.QueryRow(ctx, `
SELECT max(to_date(right(c.relname, 7), 'YYYY_MM'))::timestamp
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
 WHERE p.relname = ANY($1) AND c.relname ~ '_p[0-9]{4}_[0-9]{2}$'`, rotatedTables).Scan(&newest); err != nil {
		t.Fatalf("find the newest child: %v", err)
	}
	month := firstOfMonth(newest).AddDate(0, 1, 0)
	// partition_rotator_ensure_month creates nothing past twelve months ahead
	// of the database's clock, and the worker asks for DefaultLeadMonths more
	// after `month`. Each run of this test on the same database moves the
	// newest child forward, so a reused database runs out of months to create.
	if last := month.AddDate(0, DefaultLeadMonths, 0); last.After(firstOfMonth(time.Now().UTC()).AddDate(0, 12, 0)) {
		t.Skipf("this database already has partitions through %s; the rotator may create "+
			"months only through twelve ahead, so run this test on a freshly migrated clone",
			newest.Format("2006-01"))
	}
	warnings := &bytes.Buffer{}
	worker := &Worker{
		Pool:   pool,
		Logger: slog.New(failOnWarn{buf: warnings}),
		Now:    func() time.Time { return month.AddDate(0, 0, 14) },
	}

	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if strings.Contains(warnings.String(), "ensure partition failed") {
		t.Fatalf("the rotator could not create partitions:\n%s", warnings.String())
	}
	// With its clock months ahead, the worker also believed live children
	// had outlived retention and asked to detach them. The owner functions
	// judge retention by the database's clock, so every child still inside
	// its table's retention window on that clock must still be attached. (A
	// child long past it, like the held 2024 child the disposable-database
	// test leaves detached on purpose, is not live.)
	var detachedLive int
	if err := pool.QueryRow(ctx, `
SELECT count(*)
  FROM pg_class c
  JOIN partition_rotator_config cfg
    ON cfg.table_name = ANY($1) AND c.relname ~ ('^' || cfg.table_name || '_p[0-9]{4}_[0-9]{2}$')
 WHERE c.relkind = 'r'
   AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = c.oid)
   AND to_date(right(c.relname, 7), 'YYYY_MM') + interval '1 month'
       > date_trunc('month', now()) - make_interval(days => cfg.retention_days)`, rotatedTables).Scan(&detachedLive); err != nil {
		t.Fatalf("count detached children: %v", err)
	}
	if detachedLive != 0 {
		t.Fatalf("%d live month children were detached on the worker's skewed clock", detachedLive)
	}

	suffix := month.Format("2006_01")
	for _, table := range rotatedTables {
		assertRotatorChild(t, pool, table, table+"_p"+suffix)
	}
	assertAuditChildGuarded(t, pool, "audit_log_p"+suffix)
	probe := month.AddDate(0, 0, 14).Add(12 * time.Hour)
	if landed := insertAuditProbe(t, pool, probe); landed != "audit_log_p"+suffix {
		t.Fatalf("an audit row dated %s landed in %s", probe.Format(time.RFC3339), landed)
	}
}

// The date the outage would have started: with the rotator's clock in
// November 2026, January 2027 must be writable — whether migration 2060's
// heal step or the rotator made the partition.
// A request that writes a tenant and then its audit row locks tenants, then
// audit_log. Creating an audit_log partition locks both too, because the new
// child clones audit_log's foreign key to tenants. Taken the other way round
// (audit_log first, tenants second) the two deadlock and PostgreSQL aborts one
// of them, which can be the request. The rotator must take its locks in the
// request's order and give up before the deadlock check, so the request never
// waits on it and never fails for it.
func TestCreatingAPartitionNeverDeadlocksARequest(t *testing.T) {
	adminURL := os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; the request's locks need a role that may take them")
	}
	pool := appPool(t)
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("admin connect: %v", err)
	}
	t.Cleanup(admin.Close)

	var newest time.Time
	if err = pool.QueryRow(ctx, `
SELECT max(to_date(right(c.relname, 7), 'YYYY_MM'))::timestamp
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'public.audit_log'::regclass AND c.relname ~ '_p[0-9]{4}_[0-9]{2}$'`).Scan(&newest); err != nil {
		t.Fatalf("find the newest audit_log child: %v", err)
	}
	month := firstOfMonth(newest).AddDate(0, 1, 0)
	if month.After(firstOfMonth(time.Now().UTC()).AddDate(0, 12, 0)) {
		t.Skipf("audit_log already has partitions through %s; run on a freshly migrated clone", newest.Format("2006-01"))
	}

	request, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin request: %v", err)
	}
	defer func() { _ = request.Rollback(ctx) }()
	// The request's first write: its tenant.
	if _, err = request.Exec(ctx, `LOCK TABLE tenants IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatalf("request tenant write: %v", err)
	}

	type outcome struct {
		created bool
		err     error
	}
	rotated := make(chan outcome, 1)
	ensure := func() {
		var created bool
		scanErr := pool.QueryRow(ctx, `SELECT public.partition_rotator_ensure_month('audit_log', $1::date)`,
			month.Format("2006-01-02")).Scan(&created)
		rotated <- outcome{created, scanErr}
	}
	go ensure()

	// Once the rotator is waiting on a lock, the request writes its audit row.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if watchErr := admin.QueryRow(ctx, `
SELECT count(*) FROM pg_locks
 WHERE NOT granted AND relation IN ('public.tenants'::regclass, 'public.audit_log'::regclass)`).Scan(&waiting); watchErr != nil {
			t.Fatalf("watch locks: %v", watchErr)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the rotator never waited for the request's tenant lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	start := time.Now()
	if _, err = request.Exec(ctx, `LOCK TABLE ONLY audit_log IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatalf("the request's audit write failed: %v", err)
	}
	if waited := time.Since(start); waited > 250*time.Millisecond {
		t.Fatalf("the request's audit write waited %s on the rotator; it must not wait on it", waited)
	}
	if err = request.Commit(ctx); err != nil {
		t.Fatalf("commit request: %v", err)
	}

	got := <-rotated
	var pgErr *pgconn.PgError
	if errors.As(got.err, &pgErr) && pgErr.Code == "55P03" {
		// It yielded (its wait outlasted its lock_timeout); the worker retries.
		go ensure()
		got = <-rotated
	}
	if got.err != nil || !got.created {
		t.Fatalf("ensure %s = (%t, %v), want the month created without a deadlock",
			month.Format("2006-01"), got.created, got.err)
	}
}

func TestJanuary2027AuditWritesLand(t *testing.T) {
	pool := appPool(t)
	ctx := context.Background()
	warnings := &bytes.Buffer{}
	worker := &Worker{
		Pool:   pool,
		Logger: slog.New(failOnWarn{buf: warnings}),
		Now:    func() time.Time { return time.Date(2026, time.November, 15, 3, 0, 0, 0, time.UTC) },
	}
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	// Only creation matters here. On its November 2026 clock the worker may
	// also ask to retire children that the owner functions, judging by the
	// database's clock, rightly refuse (a database another test has already
	// rotated has some); those refusals are covered by the tests below.
	if strings.Contains(warnings.String(), "ensure partition failed") {
		t.Fatalf("the rotator could not create partitions:\n%s", warnings.String())
	}
	for _, table := range rotatedTables {
		assertRotatorChild(t, pool, table, table+"_p2027_01")
	}
	assertAuditChildGuarded(t, pool, "audit_log_p2027_01")
	probe := time.Date(2027, time.January, 15, 12, 0, 0, 0, time.UTC)
	if landed := insertAuditProbe(t, pool, probe); landed != "audit_log_p2027_01" {
		t.Fatalf("the January 2027 audit row landed in %s", landed)
	}
}

// assertRotatorChild checks that child is an attached partition of table,
// owned like every other child by the table's owner and not granted to the
// application role: a child owned by postwave_app would have no row-level
// security and be readable across every tenant by its owner.
func assertRotatorChild(t *testing.T, pool *pgxpool.Pool, table, child string) {
	t.Helper()
	var attached, ownedByParentOwner bool
	var appPrivileges string
	err := pool.QueryRow(context.Background(), `
SELECT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = c.oid AND inhparent = p.oid),
       c.relowner = p.relowner,
       COALESCE((SELECT string_agg(privilege_type, ',') FROM information_schema.role_table_grants
                  WHERE grantee = 'postwave_app' AND table_name = c.relname), '')
  FROM pg_class c, pg_class p
 WHERE c.oid = to_regclass('public.' || $1) AND p.oid = to_regclass('public.' || $2)`,
		child, table).Scan(&attached, &ownedByParentOwner, &appPrivileges)
	if err != nil {
		t.Fatalf("%s was not created: %v", child, err)
	}
	if !attached {
		t.Fatalf("%s exists but is not a partition of %s", child, table)
	}
	if !ownedByParentOwner || appPrivileges != "" {
		t.Fatalf("%s: owned by the parent's owner = %v, postwave_app privileges = %q; want the "+
			"owner's table with no direct grants, like every other child", child, ownedByParentOwner, appPrivileges)
	}
}

// assertAuditChildGuarded checks the immutability triggers and read indexes
// every audit_log child carries.
func assertAuditChildGuarded(t *testing.T, pool *pgxpool.Pool, child string) {
	t.Helper()
	var triggers, indexes int
	if err := pool.QueryRow(context.Background(), `
SELECT (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.' || $1)
          AND NOT tgisinternal AND tgname IN ($1 || '_no_update', $1 || '_no_delete')),
       (SELECT count(*) FROM pg_indexes WHERE tablename = $1)`, child,
	).Scan(&triggers, &indexes); err != nil {
		t.Fatalf("inspect %s: %v", child, err)
	}
	if triggers != 2 || indexes != 6 {
		t.Fatalf("%s has %d immutability triggers and %d indexes; want 2 and 6 "+
			"(primary key plus the five 0339 gives every audit child)", child, triggers, indexes)
	}
}

// insertAuditProbe writes one audit row at `at` through the parent, as the
// application's audit writer does, and reports the partition it landed in.
// The transaction is rolled back.
func insertAuditProbe(t *testing.T, pool *pgxpool.Pool, at time.Time) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, kv := range [][2]string{{"app.tenant_id", tenantID}, {"app.audit_internal_writer", "true"}} {
		if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, kv[0], kv[1]); err != nil {
			t.Fatalf("set %s: %v", kv[0], err)
		}
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'partition-rotator-test', 'partition-rotator-' || right($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	var landedIn string
	if err := tx.QueryRow(ctx, `
INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type)
VALUES ($1::uuid, 'partition_rotator_probe', $2, '{}', 'system')
RETURNING tableoid::regclass::text`, tenantID, at).Scan(&landedIn); err != nil {
		t.Fatalf("audit insert dated %s: %v", at.Format(time.RFC3339), err)
	}
	return landedIn
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// The application role may now ask the table owner to detach and drop
// partitions, so the owner must refuse everything retention protects. None of
// these calls changes the database.
func TestDestructiveMaintenanceRefusesWhatRetentionProtects(t *testing.T) {
	pool := appPool(t)
	ctx := context.Background()
	// A child to aim at: the rotator creates next month's (idempotent).
	next := firstOfMonth(time.Now().UTC()).AddDate(0, 1, 0)
	if err := (&Worker{Pool: pool}).ensurePartition(ctx, "audit_log", next); err != nil {
		t.Fatalf("ensure next month's audit child: %v", err)
	}
	live := "audit_log_p" + next.Format("2006_01")

	refusals := []struct {
		name, sql string
		args      []any
		wantState string
	}{
		{"detach a live audit child", `SELECT partition_rotator_detach('audit_log', $1)`, []any{live}, "55000"},
		{"drop an attached audit child", `SELECT partition_rotator_drop_detached('audit_log', $1)`, []any{live}, "55000"},
		{"detach the legacy partition", `SELECT partition_rotator_detach('audit_log', 'audit_log_legacy')`, nil, "22023"},
		{"drop another table's child", `SELECT partition_rotator_drop_detached('audit_log', 'event_log_p2027_01')`, nil, "22023"},
		{"touch a table that is not rotated", `SELECT partition_rotator_drop_detached('tenants', 'tenants_p2027_01')`, nil, "22023"},
		{"create a mid-month partition", `SELECT partition_rotator_ensure_month('audit_log', '2027-01-15')`, nil, "22023"},
		// Each call locks the parent and adds to the catalog: the application
		// role gets the rotator's window (last month to twelve ahead) and no more.
		{"create a month years ahead", `SELECT partition_rotator_ensure_month('web_vitals_events', '9999-12-01')`, nil, "22023"},
		{"create a month thirteen months ahead", `SELECT partition_rotator_ensure_month('event_log', $1::date)`, []any{firstOfMonth(time.Now().UTC()).AddDate(0, 13, 0).Format("2006-01-02")}, "22023"},
		{"create a past month", `SELECT partition_rotator_ensure_month('event_log', '2000-01-01')`, nil, "22023"},
		{"issue DDL directly", `CREATE TABLE audit_log_p2031_01 PARTITION OF audit_log FOR VALUES FROM ('2031-01-01') TO ('2031-02-01')`, nil, "42501"},
		{"shorten a retention window", `UPDATE partition_rotator_config SET retention_days = 1 WHERE table_name = 'audit_log'`, nil, "42501"},
	}
	for _, refusal := range refusals {
		t.Run(refusal.name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatalf("begin: %v", err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			_, err = tx.Exec(ctx, refusal.sql, refusal.args...)
			if got := sqlState(err); got != refusal.wantState {
				t.Fatalf("SQLSTATE %q (err %v), want %q", got, err, refusal.wantState)
			}
		})
	}

	// The bookkeeping the worker writes stays writable.
	if _, err := pool.Exec(ctx, `UPDATE partition_rotator_config SET last_rotated_at = now(), updated_at = now() WHERE table_name = 'audit_log'`); err != nil {
		t.Fatalf("bookkeeping update: %v", err)
	}
}

// The destructive path needs months that are already past retention, and no
// database the shared tests use has any: _legacy holds everything before the
// 0339 cutover. On a disposable database whose owner URL is supplied, this
// shrinks _legacy, creates January and February 2024, and lets the worker
// retire them under the configured windows.
func TestRotatorRetiresExpiredPartitionsOnADisposableDatabase(t *testing.T) {
	ownerURL := os.Getenv("POSTWAVE_PARTITION_ROTATOR_DISPOSABLE_OWNER_URL")
	if ownerURL == "" {
		t.Skip("POSTWAVE_PARTITION_ROTATOR_DISPOSABLE_OWNER_URL not set; this test rewrites partition bounds")
	}
	pool := appPool(t)
	ctx := context.Background()
	owner, connectErr := pgxpool.New(ctx, ownerURL)
	if connectErr != nil {
		t.Fatalf("owner connect: %v", connectErr)
	}
	t.Cleanup(owner.Close)
	// A previous run leaves its 2024 children behind (the held one on
	// purpose); the owner clears them so the run starts from the same state.
	for _, leftover := range []string{"event_log_p2024_01", "audit_log_p2024_01", "audit_log_p2024_02"} {
		if _, err := owner.Exec(ctx, `DROP TABLE IF EXISTS `+leftover); err != nil {
			t.Fatalf("clear %s: %v", leftover, err)
		}
	}
	for _, table := range []string{"event_log", "audit_log"} {
		if _, err := owner.Exec(ctx, `ALTER TABLE `+table+` DETACH PARTITION `+table+`_legacy`); err != nil {
			t.Fatalf("detach %s_legacy: %v", table, err)
		}
		if _, err := owner.Exec(ctx, `ALTER TABLE `+table+` ATTACH PARTITION `+table+`_legacy FOR VALUES FROM ('-infinity') TO ('2024-01-01')`); err != nil {
			t.Fatalf("re-attach %s_legacy ending 2024-01-01 (it must hold no later rows): %v", table, err)
		}
	}
	// Hard retention for audit_log at the 730-day floor, so the drop path runs.
	if _, err := owner.Exec(ctx, `UPDATE partition_rotator_config SET hard_retention_days = 730 WHERE table_name = 'audit_log'`); err != nil {
		t.Fatalf("configure audit hard retention: %v", err)
	}

	worker := &Worker{Pool: pool, Logger: slog.New(slog.NewTextHandler(os.Stderr, nil))}
	// Months this far back are outside what the application role may create,
	// so the owner creates them, as an operator's backfill would.
	for _, spec := range []struct {
		table string
		month time.Time
	}{
		{"event_log", time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC)},
		{"audit_log", time.Date(2024, time.January, 1, 0, 0, 0, 0, time.UTC)},
		{"audit_log", time.Date(2024, time.February, 1, 0, 0, 0, 0, time.UTC)},
	} {
		child := spec.table + "_p" + spec.month.Format("2006_01")
		ddl := fmt.Sprintf(`CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')`,
			child, spec.table, spec.month.Format("2006-01-02"), spec.month.AddDate(0, 1, 0).Format("2006-01-02"))
		if _, err := owner.Exec(ctx, ddl); err != nil {
			t.Fatalf("create %s: %v", child, err)
		}
	}
	// January 2024 holds an audit row under legal hold; February holds none.
	tenantID := uuid.NewString()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	// Rolled back on any failure below, so the pool can close.
	defer func() { _ = tx.Rollback(ctx) }()
	for _, kv := range [][2]string{{"app.tenant_id", tenantID}, {"app.audit_internal_writer", "true"}} {
		if _, err := tx.Exec(ctx, `SELECT set_config($1, $2, true)`, kv[0], kv[1]); err != nil {
			t.Fatalf("set %s: %v", kv[0], err)
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'rotator-hold', 'rotator-hold-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO audit_log (tenant_id, action, at, metadata, actor_type, legal_hold) VALUES ($1::uuid, 'held', '2024-01-10T00:00:00Z', '{}', 'system', true)`, tenantID); err != nil {
		t.Fatalf("seed held audit row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	exists := func(name string) (present, attached bool) {
		t.Helper()
		if err := pool.QueryRow(ctx, `
SELECT to_regclass('public.' || $1) IS NOT NULL,
       EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid = to_regclass('public.' || $1))`, name).Scan(&present, &attached); err != nil {
			t.Fatalf("inspect %s: %v", name, err)
		}
		return present, attached
	}
	if present, _ := exists("event_log_p2024_01"); present {
		t.Fatal("event_log_p2024_01 is past event_log's 30-day hard retention and was not dropped")
	}
	if present, _ := exists("audit_log_p2024_02"); present {
		t.Fatal("audit_log_p2024_02 is past the 730-day floor, holds no legal hold, and was not dropped")
	}
	present, attached := exists("audit_log_p2024_01")
	if !present || attached {
		t.Fatalf("audit_log_p2024_01: present=%v attached=%v; want detached (past retention) but "+
			"kept, because it holds an audit row under legal hold", present, attached)
	}
}
