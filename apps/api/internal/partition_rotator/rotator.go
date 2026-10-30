// SPDX-License-Identifier: AGPL-3.0-only
//
// Package partition_rotator owns the nightly worker that keeps the five
// month-partitioned event tables (see migration 0339) healthy:
//
//   - Pre-creates the NEXT month's partition before the calendar
//     boundary so writes on the 1st-of-month don't trip an
//     ERROR: "no partition of relation … found for row".
//   - DETACHes partitions older than the per-table soft retention
//     window. Detached children stay on disk (still readable by a
//     direct table reference, invisible to a query against the parent),
//     giving on-call a 24h window to ATTACH them back if a regression
//     surfaces.
//   - DROPs detached children older than the hard retention ceiling,
//     reclaiming disk.
//
// Wiring shape mirrors apps/api/internal/audit/trim.go: one Worker
// struct, a single Run goroutine on a 24h ticker that fans out across
// every row in `partition_rotator_config`. The worker has no per-tenant
// fan-out — partitions are global, not tenant-scoped.
//
// The worker runs as postwave_app, which may not create, detach or drop
// tables: that needs CREATE on schema public and ownership of the
// partitioned parents. Every DDL step therefore goes through a SECURITY
// DEFINER function owned by the table owner (migration 2060):
// partition_rotator_ensure_month, partition_rotator_detach and
// partition_rotator_drop_detached. They accept only the five rotated tables
// and the <table>_pYYYY_MM children, and the destructive two enforce the
// configured retention windows (plus audit_log's 730-day floor and legal
// hold) themselves. When the worker issued the DDL directly, every tick
// failed with "permission denied for schema public" and no partition past
// the ones migration 0339 pre-created was ever made.
//
// Observability counters (Prometheus surface metrics — see
// observability.MustRegisterSurfaceCounter):
//
//	pw_partition_rotator_create_total {outcome,reason,table}
//	pw_partition_rotator_detach_total {outcome,reason,table}
//	pw_partition_rotator_drop_total   {outcome,reason,table}
//	pw_partition_rotator_tick_total   {outcome,reason}
//
// Why one tick per 24h and not per-hour: month boundaries are coarse,
// and the DETACH/DROP operations take an AccessExclusiveLock on the
// parent for the duration of the catalog update (millisecond-class,
// but still a contention point on a hot write path). Running once at
// the off-peak window keeps the operator's load profile predictable.
package partition_rotator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/leader"

	"github.com/postwave/postwave/apps/api/internal/observability"
)

// Defaults the worker falls back to when its fields are zero-valued.
// Picked to match the migration's own seeded defaults so an operator
// debugging the worker locally and an operator reading the SQL see the
// same numbers.
const (
	// DefaultInterval is the gap between rotator ticks. The work
	// itself is cheap (a handful of metadata-only DDL statements per
	// table), so the interval is tuned to "once per night, off-peak".
	DefaultInterval = 24 * time.Hour
	// DefaultLeadMonths is the count of month-partitions kept ahead
	// of "current" so a long weekend without a deploy can't run out
	// of partitions. Two is the migration's seed.
	DefaultLeadMonths = 2
	// DefaultHardRetentionFloorDays is the lower bound the worker
	// will enforce on the configured hard_retention_days, even if
	// the row in partition_rotator_config gets set below it. 730d
	// (two years) is the floor SOC 2 commits us to.
	DefaultHardRetentionFloorDays = 730
)

// Surface counters. Registered package-init-time so a worker that
// never gets ticked still surfaces zeros for the dashboards.
var (
	createCounter = observability.MustRegisterSurfaceCounter(
		"partition_rotator", "create", "table",
	)
	detachCounter = observability.MustRegisterSurfaceCounter(
		"partition_rotator", "detach", "table",
	)
	dropCounter = observability.MustRegisterSurfaceCounter(
		"partition_rotator", "drop", "table",
	)
	tickCounter = observability.MustRegisterSurfaceCounter(
		"partition_rotator", "tick",
	)
)

// Worker is the partition_rotator main loop. Construct with a Pool
// + Logger and call Run from a goroutine; Run returns when ctx is
// cancelled.
//
// The worker is single-instance by design: every operation takes an
// AccessExclusiveLock on the parent table, so a second concurrent
// worker would just block on the first. Concurrency safety is therefore
// "lock contention, not data race". We do NOT use FOR UPDATE SKIP
// LOCKED on the config table for the same reason.
type Worker struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger

	// Interval defaults to DefaultInterval. Override via
	// POSTWAVE_PARTITION_ROTATOR_INTERVAL_SECONDS at the call site
	// (see apps/api/main.go).
	Interval time.Duration

	// LeadMonths defaults to DefaultLeadMonths.
	LeadMonths int

	// Now is injected for tests. Defaults to time.Now.
	Now func() time.Time
}

// Run blocks until ctx is cancelled, ticking on Interval. The first
// tick happens immediately so a bounce of the gateway during a
// partition-low window self-heals on boot.
func (w *Worker) Run(ctx context.Context) {
	if w.Pool == nil {
		w.log().Warn("partition_rotator: nil pool, worker disabled")
		return
	}
	interval := w.Interval
	if interval <= 0 {
		interval = DefaultInterval
	}
	// First tick fires immediately, then on the ticker cadence.
	w.scheduledTick(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.scheduledTick(ctx)
		}
	}
}

// scheduledTick runs one rotation sweep behind a cross-instance advisory lock so
// that, on a horizontally-scaled deployment, exactly ONE replica performs the
// singleton DDL (create/drop partitions) per tick — not every replica racing on
// the same AccessExclusiveLock. Operator-triggered rotations (handlers.go) call
// runOnce directly and are intentionally NOT gated.
func (w *Worker) scheduledTick(ctx context.Context) {
	// ran=false means another replica holds the singleton lock this tick —
	// expected, and nothing to do about it here.
	_, err := leader.Run(ctx, w.Pool, "partition-rotator", w.runOnce)
	if err != nil && !errors.Is(err, context.Canceled) {
		w.log().Warn("partition_rotator: tick failed", "err", err.Error())
	}
}

// runOnce performs one rotation sweep across every row in
// partition_rotator_config. Exposed (lowercase) for the admin handler
// in handlers.go to call directly; the http surface lets operators
// trigger an immediate rotation without waiting for the next ticker.
func (w *Worker) runOnce(ctx context.Context) error {
	cfgs, err := w.loadConfigs(ctx)
	if err != nil {
		tickCounter.WithLabelValues("error", "load_configs").Inc()
		return fmt.Errorf("load configs: %w", err)
	}
	for _, c := range cfgs {
		if !c.Enabled {
			continue
		}
		if err := w.rotateTable(ctx, c); err != nil && !errors.Is(err, context.Canceled) {
			w.log().Warn("partition_rotator: rotate failed",
				"table", c.TableName, "err", err.Error())
			// Don't bail the whole tick on one table failure — let
			// the others make progress and surface the error via
			// the per-table counters.
			continue
		}
	}
	tickCounter.WithLabelValues("ok", "").Inc()
	return nil
}

// Config models one row of partition_rotator_config.
type Config struct {
	TableName         string
	RetentionDays     int
	HardRetentionDays int
	Enabled           bool
}

// loadConfigs reads every row from partition_rotator_config under the
// worker GUC so the global-table RLS-less policy applies.
func (w *Worker) loadConfigs(ctx context.Context) ([]Config, error) {
	conn, err := w.Pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire: %w", err)
	}
	defer conn.Release()

	rows, err := conn.Query(ctx, `
		SELECT table_name, retention_days, hard_retention_days, enabled
		  FROM partition_rotator_config
		 ORDER BY table_name`)
	if err != nil {
		return nil, fmt.Errorf("select: %w", err)
	}
	defer rows.Close()
	var out []Config
	for rows.Next() {
		var c Config
		if err := rows.Scan(&c.TableName, &c.RetentionDays, &c.HardRetentionDays, &c.Enabled); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		// Apply the hard-retention floor regardless of what the DB
		// row says — defence-in-depth against an operator typo
		// deleting 7y of audit log.
		if c.HardRetentionDays < DefaultHardRetentionFloorDays && c.TableName == "audit_log" {
			c.HardRetentionDays = DefaultHardRetentionFloorDays
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// rotateTable executes the three rotation steps for a single table:
// create-ahead, detach-old, drop-detached-very-old. Each step records
// its own counter; failures in one don't stop the others (so a
// permission glitch on DROP doesn't prevent fresh partitions being
// created).
func (w *Worker) rotateTable(ctx context.Context, c Config) error {
	now := w.now()

	// Step 1: ensure the next LeadMonths month partitions exist.
	leadMonths := w.LeadMonths
	if leadMonths <= 0 {
		leadMonths = DefaultLeadMonths
	}
	for i := 0; i <= leadMonths; i++ {
		monthStart := firstOfMonth(now).AddDate(0, i, 0)
		if err := w.ensurePartition(ctx, c.TableName, monthStart); err != nil {
			createCounter.WithLabelValues("error", "ddl", c.TableName).Inc()
			w.log().Warn("partition_rotator: ensure partition failed",
				"table", c.TableName, "month", monthStart.Format("2006-01"), "err", err.Error())
			// Continue with the others — the next tick will retry.
		}
	}

	// Step 2: DETACH partitions older than retention_days.
	if err := w.detachOld(ctx, c, now); err != nil {
		detachCounter.WithLabelValues("error", "ddl", c.TableName).Inc()
		w.log().Warn("partition_rotator: detach failed",
			"table", c.TableName, "err", err.Error())
	}

	// Step 3: DROP detached partitions older than hard_retention_days.
	if err := w.dropOld(ctx, c, now); err != nil {
		dropCounter.WithLabelValues("error", "ddl", c.TableName).Inc()
		w.log().Warn("partition_rotator: drop failed",
			"table", c.TableName, "err", err.Error())
	}

	// Update last_rotated_at bookkeeping. Best-effort — a transient
	// failure here doesn't affect correctness; the next tick will
	// overwrite it.
	if _, err := w.Pool.Exec(ctx, `
		UPDATE partition_rotator_config
		   SET last_rotated_at = now(), updated_at = now()
		 WHERE table_name = $1`, c.TableName); err != nil {
		w.log().Debug("partition_rotator: bookkeeping update failed",
			"table", c.TableName, "err", err.Error())
	}

	return nil
}

// ensurePartition creates a month partition if it doesn't already
// exist. Idempotent: partition_rotator_ensure_month answers false for a
// month that already has a child (or lies inside the _legacy partition),
// so a second worker or a manual operator run is a no-op. It creates the
// child as the table owner with the per-child indexes and, for
// audit_log, the BEFORE UPDATE / BEFORE DELETE immutability triggers.
func (w *Worker) ensurePartition(ctx context.Context, table string, monthStart time.Time) error {
	// The function checks the same allow-list; failing here keeps a bad
	// config row from reaching the database at all.
	if !isAllowedTable(table) {
		return fmt.Errorf("disallowed table: %q", table)
	}
	month := monthStart.Format("2006-01-02")
	var created bool
	err := retryTransientDDL(ctx, func() error {
		return w.Pool.QueryRow(ctx,
			`SELECT public.partition_rotator_ensure_month($1, $2::date)`, table, month,
		).Scan(&created)
	})
	if err != nil {
		return fmt.Errorf("ensure %s month %s: %w", table, month, err)
	}
	if !created {
		return nil
	}
	createCounter.WithLabelValues("ok", "", table).Inc()
	w.log().Info("partition_rotator: created partition",
		"table", table, "child", fmt.Sprintf("%s_p%s", table, monthStart.Format("2006_01")),
		"from", month,
		"to", monthStart.AddDate(0, 1, 0).Format("2006-01-02"))
	return nil
}

// ddlRetryDelays spaces the retries of a partition DDL call that lost a lock
// race. The owner functions give up after 500ms (under PostgreSQL's deadlock
// check, so a request never becomes the victim), and a lost race is transient
// by definition: the other transaction finishes and the call succeeds, so
// waiting for the next tick (hours away) would only leave the month uncreated
// for longer.
var ddlRetryDelays = []time.Duration{250 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second}

// retryTransientDDL runs call, and again after each delay in ddlRetryDelays
// while it fails with a deadlock (40P01) or a lock timeout (55P03). Any other
// error, and the last transient one, is returned as is.
func retryTransientDDL(ctx context.Context, call func() error) error {
	err := call()
	for _, delay := range ddlRetryDelays {
		if !isTransientLockError(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(delay):
		}
		err = call()
	}
	return err
}

func isTransientLockError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "55P03")
}

// detachOld walks every attached partition of `c.TableName` and
// DETACHes any whose upper-bound is older than now - retention_days.
//
// The detach runs inside partition_rotator_detach, a function, so it
// cannot be DETACH CONCURRENTLY (which refuses to run in a transaction
// block). The lock is AccessExclusive on the parent for the duration of
// the catalog update — millisecond-scale, bounded by the function's 500ms
// lock_timeout, and timed for the off-peak ticker window.
//
// We deliberately skip the legacy partition (suffix `_legacy`) so the
// historical data stays attached until an operator manually decides to
// archive it.
func (w *Worker) detachOld(ctx context.Context, c Config, now time.Time) error {
	cutoff := firstOfMonth(now).AddDate(0, 0, -c.RetentionDays)
	children, err := w.attachedPartitions(ctx, c.TableName)
	if err != nil {
		return fmt.Errorf("list: %w", err)
	}
	// One refused child (a lock timeout, a window the config no longer
	// allows) must not hold every older child back until it clears.
	var refused []error
	for _, ch := range children {
		if strings.HasSuffix(ch.Child, "_legacy") {
			continue
		}
		// Detach when the partition's UPPER bound is at-or-before the
		// cutoff (i.e. the whole month it covers is already older
		// than retention_days).
		if !ch.UpperBound.Before(cutoff) && !ch.UpperBound.Equal(cutoff) {
			continue
		}
		// The function re-checks the retention window against the
		// operator-managed config (and audit_log's 730-day floor), so a
		// wrong cutoff here fails loudly instead of detaching live data.
		var detached bool
		if err := retryTransientDDL(ctx, func() error {
			return w.Pool.QueryRow(ctx,
				`SELECT public.partition_rotator_detach($1, $2)`, c.TableName, ch.Child,
			).Scan(&detached)
		}); err != nil {
			refused = append(refused, fmt.Errorf("detach %s: %w", ch.Child, err))
			continue
		}
		if !detached {
			continue
		}
		detachCounter.WithLabelValues("ok", "", c.TableName).Inc()
		w.log().Info("partition_rotator: detached partition",
			"table", c.TableName, "child", ch.Child,
			"upper_bound", ch.UpperBound.Format("2006-01-02"),
			"retention_days", c.RetentionDays)
	}
	// Bookkeeping.
	if _, err := w.Pool.Exec(ctx, `
		UPDATE partition_rotator_config
		   SET last_detached_at = now()
		 WHERE table_name = $1`, c.TableName); err != nil {
		w.log().Debug("partition_rotator: detach bookkeeping update failed",
			"table", c.TableName, "err", err.Error())
	}
	return errors.Join(refused...)
}

// dropOld walks the *detached* children — children that look like a
// month partition (suffix _pYYYY_MM) but are no longer attached to the
// parent — and DROPs any older than hard_retention_days.
//
// "Detached" is identified by absence from pg_partition_tree of the
// parent, combined with a naming match on the child. We deliberately
// don't drop the `_legacy` partition here — it's a manual archive
// operation.
func (w *Worker) dropOld(ctx context.Context, c Config, now time.Time) error {
	cutoff := firstOfMonth(now).AddDate(0, 0, -c.HardRetentionDays)
	candidates, err := w.detachedCandidates(ctx, c.TableName)
	if err != nil {
		return fmt.Errorf("list detached: %w", err)
	}
	// A child under legal hold stays until the hold lifts; it must not
	// hold every other expired child back with it.
	var refused []error
	for _, name := range candidates {
		monthStart, ok := parseChildMonth(c.TableName, name)
		if !ok {
			continue
		}
		// Drop when the partition's start-of-month is older than the
		// hard-retention cutoff. We use start-of-month (not upper
		// bound) so a partition for "2022-01" with cutoff "2022-02"
		// is dropped — its data is definitionally older than the
		// floor.
		if !monthStart.Before(cutoff) {
			continue
		}
		// The function refuses an attached child, one inside the hard
		// retention window, and an audit_log child under the 730-day
		// floor or holding legal_hold rows.
		var dropped bool
		if err := w.Pool.QueryRow(ctx,
			`SELECT public.partition_rotator_drop_detached($1, $2)`, c.TableName, name,
		).Scan(&dropped); err != nil {
			refused = append(refused, fmt.Errorf("drop %s: %w", name, err))
			continue
		}
		if !dropped {
			continue
		}
		dropCounter.WithLabelValues("ok", "", c.TableName).Inc()
		w.log().Info("partition_rotator: dropped partition",
			"table", c.TableName, "child", name,
			"month", monthStart.Format("2006-01"),
			"hard_retention_days", c.HardRetentionDays)
	}
	if _, err := w.Pool.Exec(ctx, `
		UPDATE partition_rotator_config
		   SET last_dropped_at = now()
		 WHERE table_name = $1`, c.TableName); err != nil {
		w.log().Debug("partition_rotator: drop bookkeeping update failed",
			"table", c.TableName, "err", err.Error())
	}
	return errors.Join(refused...)
}

// AttachedPartition models one row from pg_inherits / pg_class for
// the parent's attached children.
type AttachedPartition struct {
	Child      string
	UpperBound time.Time
}

func (w *Worker) attachedPartitions(ctx context.Context, parent string) ([]AttachedPartition, error) {
	// We extract the partition bound expression from pg_class +
	// pg_get_expr(pg_class.relpartbound). It looks like
	//   FOR VALUES FROM ('2024-01-01 00:00:00+00') TO ('2024-02-01 00:00:00+00')
	// — we just need the TO value to drive the retention compare.
	rows, err := w.Pool.Query(ctx, `
		SELECT c.relname,
		       pg_get_expr(c.relpartbound, c.oid)
		  FROM pg_inherits i
		  JOIN pg_class    c ON c.oid = i.inhrelid
		  JOIN pg_class    p ON p.oid = i.inhparent
		 WHERE p.relname = $1
		 ORDER BY c.relname`, parent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AttachedPartition
	for rows.Next() {
		var child, bound string
		if err := rows.Scan(&child, &bound); err != nil {
			return nil, err
		}
		upper, ok := parseBoundUpper(bound)
		if !ok {
			// MINVALUE / unparseable bound (e.g. legacy partition
			// with -infinity). Treat as "never expire from auto-
			// rotation" — operator decides.
			continue
		}
		out = append(out, AttachedPartition{Child: child, UpperBound: upper})
	}
	return out, rows.Err()
}

// detachedCandidates returns child tables that look like our
// partition-naming convention (parent_pYYYY_MM) but are not currently
// attached to the parent.
func (w *Worker) detachedCandidates(ctx context.Context, parent string) ([]string, error) {
	rows, err := w.Pool.Query(ctx, `
		SELECT c.relname
		  FROM pg_class c
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = current_schema()
		   AND c.relkind = 'r'
		   AND c.relname LIKE $1
		   AND NOT EXISTS (
		         SELECT 1 FROM pg_inherits i
		           JOIN pg_class p ON p.oid = i.inhparent
		          WHERE i.inhrelid = c.oid
		            AND p.relname  = $2
		       )
		 ORDER BY c.relname`, parent+`_p%`, parent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// RunOnce exposes a single tick to callers that want to drive the
// rotator from the admin HTTP surface or from a test. Stable name —
// the handler in handlers.go calls into this.
func (w *Worker) RunOnce(ctx context.Context) error {
	if w.Pool == nil {
		return errors.New("partition_rotator: nil pool")
	}
	return w.runOnce(ctx)
}

// ─── small helpers ─────────────────────────────────────────────────────

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

func (w *Worker) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now().UTC()
}

func firstOfMonth(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// parseBoundUpper extracts the upper bound from a partition bound
// expression formatted as
//
//	FOR VALUES FROM ('lower') TO ('upper')
//
// or — for the legacy partition —
//
//	FOR VALUES FROM (MINVALUE) TO ('upper')
//
// Returns ok=false if the upper looks unparseable.
func parseBoundUpper(expr string) (time.Time, bool) {
	// Find the substring after the last "TO (" and before the next ")".
	idx := strings.LastIndex(expr, "TO (")
	if idx < 0 {
		return time.Time{}, false
	}
	rest := expr[idx+len("TO ("):]
	end := strings.Index(rest, ")")
	if end < 0 {
		return time.Time{}, false
	}
	raw := strings.TrimSpace(rest[:end])
	// Strip surrounding quotes if present.
	raw = strings.TrimPrefix(raw, "'")
	raw = strings.TrimSuffix(raw, "'")
	// Try common timestamp layouts. PG renders a bound in the session
	// TimeZone: "+00" in UTC, but "+05:30" (India), "+05:45" (Nepal) or
	// "-03:30" (Newfoundland) elsewhere, and a bound it cannot parse is
	// treated as never expiring, so both offset forms must be accepted.
	for _, layout := range []string{
		"2006-01-02 15:04:05-07",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

// parseChildMonth parses a child table name "<parent>_pYYYY_MM" into
// the first-of-month timestamp it covers. ok=false if the name doesn't
// match the convention (e.g. parent_legacy).
func parseChildMonth(parent, child string) (time.Time, bool) {
	prefix := parent + "_p"
	if !strings.HasPrefix(child, prefix) {
		return time.Time{}, false
	}
	suffix := child[len(prefix):]
	if len(suffix) != len("2006_01") {
		return time.Time{}, false
	}
	t, err := time.Parse("2006_01", suffix)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

// isAllowedTable mirrors the CHECK constraint on partition_rotator_config.
// Used as a defence-in-depth gate before any fmt.Sprintf-into-SQL.
func isAllowedTable(t string) bool {
	switch t {
	case "audit_log",
		"subscriber_events",
		"campaign_report_events",
		"event_log",
		"web_vitals_events":
		return true
	}
	return false
}
