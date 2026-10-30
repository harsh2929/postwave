// Package worker — recurrence scanner.
//
// RecurrenceScanner runs nightly, scans the campaigns table for rows with
// a non-null recurrence_cron, computes which fire times fall in the next
// 24h window, and creates child campaigns for each. The actual cron
// parsing lives in apps/api/internal/campaigns; we mirror the algorithm
// here in a tiny self-contained form so the automation service does not
// need to import the api gateway.

package worker

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// RecurrenceCandidate is a campaign row with a recurrence expression.
type RecurrenceCandidate struct {
	ID       string
	TenantID string
	Name     string
	Subject  string
	Cron     string
	Until    *time.Time
	LastRun  *time.Time
}

// RecurrenceScanner periodically materializes child campaigns from
// recurrences whose next fire times fall in the upcoming window.
type RecurrenceScanner struct {
	Pool           *pgxpool.Pool
	Logger         *slog.Logger
	Window         time.Duration
	Interval       time.Duration
	Now            func() time.Time
	RuntimeEnabled bool
}

// Run loops until ctx cancellation.
func (s *RecurrenceScanner) Run(ctx context.Context) {
	if err := s.scheduledMaterializationAllowed(); err != nil {
		code, message := campaigndispatch.PublicError(err)
		s.logger().Warn("recurrence scanner disabled", "code", code, "reason", message)
		return
	}
	if s.Interval <= 0 {
		s.Interval = 24 * time.Hour
	}
	if s.Window <= 0 {
		s.Window = 24 * time.Hour
	}
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.tick(ctx); err != nil {
				s.logger().Warn("recurrence scan failed", "err", err.Error())
			}
		}
	}
}

// Trigger runs one scan immediately and returns the candidate count it
// processed (along with any error). This is the admin "run now" entry
// point for testing recurrence config without waiting for the 24h
// interval. Safe to call concurrently with the Run loop — both end up
// in tick() which is idempotent (per-campaign markLastRun gates re-fire).
func (s *RecurrenceScanner) Trigger(ctx context.Context) (processed int, err error) {
	// Defer the metric observation so both early-error returns and the
	// happy path land in the same call site. processed is the named
	// return so it carries whatever count we built up before erroring.
	defer func() { observeRecurrenceRun(processed, err) }()
	defer func() {
		if r := recover(); r != nil {
			err = panicError("recurrence trigger", r)
		}
	}()
	if err := s.scheduledMaterializationAllowed(); err != nil {
		return 0, err
	}
	now := s.now()
	candidates, lerr := s.list(ctx, now)
	if lerr != nil {
		return 0, lerr
	}
	processed = 0
	for _, c := range candidates {
		spec, err := parseCron(c.Cron)
		if err != nil {
			s.logger().Warn("bad cron in db", "campaign", c.ID, "err", err.Error())
			continue
		}
		from := now
		if c.LastRun != nil && c.LastRun.After(from) {
			from = *c.LastRun
		}
		until := now.Add(s.Window)
		if c.Until != nil && c.Until.Before(until) {
			until = *c.Until
		}
		fires := dueWithin(spec, from, until)
		for _, fire := range fires {
			if err := s.spawn(ctx, c, fire); err != nil {
				s.logger().Warn("spawn child failed", "campaign", c.ID, "err", err.Error())
				continue
			}
			processed++
		}
		if len(fires) > 0 {
			_ = s.markLastRun(ctx, c.TenantID, c.ID, fires[len(fires)-1])
		}
	}
	return processed, nil
}

func (s *RecurrenceScanner) tick(ctx context.Context) (err error) {
	// Mirror Trigger: emit a metric per tick run, even on error. The
	// processed counter sums children spawned across both call paths so
	// dashboards don't have to UNION two series.
	processed := 0
	defer func() { observeRecurrenceRun(processed, err) }()
	defer func() {
		if r := recover(); r != nil {
			err = panicError("recurrence scan", r)
		}
	}()
	if err := s.scheduledMaterializationAllowed(); err != nil {
		return err
	}
	now := s.now()
	candidates, lerr := s.list(ctx, now)
	if lerr != nil {
		return lerr
	}
	for _, c := range candidates {
		spec, perr := parseCron(c.Cron)
		if perr != nil {
			s.logger().Warn("bad cron in db", "campaign", c.ID, "err", perr.Error())
			continue
		}
		from := now
		if c.LastRun != nil && c.LastRun.After(from) {
			from = *c.LastRun
		}
		until := now.Add(s.Window)
		if c.Until != nil && c.Until.Before(until) {
			until = *c.Until
		}
		fires := dueWithin(spec, from, until)
		for _, fire := range fires {
			if serr := s.spawn(ctx, c, fire); serr != nil {
				s.logger().Warn("spawn child failed",
					"parent", c.ID, "fire", fire, "err", serr.Error())
				continue
			}
			processed++
		}
		if len(fires) > 0 {
			if merr := s.markLastRun(ctx, c.TenantID, c.ID, fires[len(fires)-1]); merr != nil {
				s.logger().Warn("mark last_run failed", "campaign", c.ID, "err", merr.Error())
			}
		}
	}
	return nil
}

func (s *RecurrenceScanner) list(ctx context.Context, asOf time.Time) ([]RecurrenceCandidate, error) {
	// Cross-tenant scan. We rely on the worker's DB role being able to
	// read this table; in production this is a privileged role configured
	// via DATABASE_URL (mirrors the approvals SweepExpired pattern). Per-
	// tenant inserts in `spawn` set app.tenant_id explicitly so RLS gates
	// writes correctly.
	const q = `
SELECT id::text, tenant_id::text, name, COALESCE(subject,''),
       recurrence_cron, recurrence_until, recurrence_last_run
FROM campaigns
WHERE recurrence_cron IS NOT NULL
  AND (recurrence_until IS NULL OR recurrence_until > $1)`
	rows, err := s.Pool.Query(ctx, q, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []RecurrenceCandidate{}
	for rows.Next() {
		var c RecurrenceCandidate
		if err := rows.Scan(&c.ID, &c.TenantID, &c.Name, &c.Subject,
			&c.Cron, &c.Until, &c.LastRun); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *RecurrenceScanner) spawn(ctx context.Context, parent RecurrenceCandidate, fire time.Time) error {
	// Defense in depth: even a direct call that bypasses Run/Trigger cannot
	// materialize scheduled campaign state while release/runtime policy is shut.
	if err := s.scheduledMaterializationAllowed(); err != nil {
		return err
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, parent.TenantID); err != nil {
		return err
	}
	// ON CONFLICT DO NOTHING against the partial unique index on
	// (parent_campaign_id, send_at) from migration 0168. Closes the
	// multi-replica race where two scanner ticks both spawn a child
	// for the same parent at the same fire time. The first insert
	// wins; the second is a no-op. Worker audit CRITICAL #2.
	const q = `
INSERT INTO campaigns (tenant_id, parent_campaign_id, name, subject,
        status, audience_list_id, audience_segment_id, send_at)
SELECT tenant_id, id, name || ' (recurrence)',
       subject, 'scheduled',
       audience_list_id, audience_segment_id, $2
FROM campaigns WHERE id = $1::uuid
ON CONFLICT (parent_campaign_id, send_at)
  WHERE parent_campaign_id IS NOT NULL AND send_at IS NOT NULL
  DO NOTHING`
	if _, err := tx.Exec(ctx, q, parent.ID, fire); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *RecurrenceScanner) scheduledMaterializationAllowed() error {
	runtimeEnabled := s != nil && s.RuntimeEnabled
	return campaigndispatch.CheckScheduledMaterialization(runtimeEnabled)
}

func (s *RecurrenceScanner) markLastRun(ctx context.Context, tenantID, campaignID string, at time.Time) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE campaigns SET recurrence_last_run=$2, updated_at=now() WHERE id=$1::uuid`,
		campaignID, at); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *RecurrenceScanner) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *RecurrenceScanner) logger() *slog.Logger {
	if s != nil && s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// ----- minimal cron parser, mirrored from apps/api/internal/campaigns -----

type cronSpec struct {
	mins, hours, dom, mon, dow []int
}

func parseCron(expr string) (*cronSpec, error) {
	parts := strings.Fields(strings.TrimSpace(expr))
	if len(parts) != 5 {
		return nil, fmt.Errorf("expected 5 fields, got %d", len(parts))
	}
	get := func(s string, lo, hi int) ([]int, error) {
		if s == "*" {
			return nil, nil
		}
		out := []int{}
		for _, raw := range strings.Split(s, ",") {
			v, err := strconv.Atoi(strings.TrimSpace(raw))
			if err != nil {
				return nil, fmt.Errorf("not int: %q", raw)
			}
			if v < lo || v > hi {
				return nil, fmt.Errorf("out of range: %d", v)
			}
			out = append(out, v)
		}
		return out, nil
	}
	c := &cronSpec{}
	var err error
	if c.mins, err = get(parts[0], 0, 59); err != nil {
		return nil, err
	}
	if c.hours, err = get(parts[1], 0, 23); err != nil {
		return nil, err
	}
	if c.dom, err = get(parts[2], 1, 31); err != nil {
		return nil, err
	}
	if c.mon, err = get(parts[3], 1, 12); err != nil {
		return nil, err
	}
	if c.dow, err = get(parts[4], 0, 6); err != nil {
		return nil, err
	}
	return c, nil
}

func inSet(allowed []int, v int) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if a == v {
			return true
		}
	}
	return false
}

func cronMatches(c *cronSpec, t time.Time) bool {
	return inSet(c.mins, t.Minute()) &&
		inSet(c.hours, t.Hour()) &&
		inSet(c.dom, t.Day()) &&
		inSet(c.mon, int(t.Month())) &&
		inSet(c.dow, int(t.Weekday()))
}

func dueWithin(c *cronSpec, from, until time.Time) []time.Time {
	if !until.After(from) {
		return nil
	}
	out := []time.Time{}
	t := from.Truncate(time.Minute)
	if t.Before(from) {
		t = t.Add(time.Minute)
	}
	for t.Before(until) {
		if cronMatches(c, t) {
			out = append(out, t)
		}
		t = t.Add(time.Minute)
	}
	return out
}
