// SPDX-License-Identifier: AGPL-3.0-only
//
// Package dashboardnotify is the server-side emitter for dashboard signals —
// detected anomalies and audience milestones (DASHBOARD#44).
//
// The audit found a complete push stack with nothing pushing dashboard events
// into it: the desktop app polls and raises its own local OS notification, so
// the signal only exists while a laptop is awake and open. Mobile had the
// token, the categories and the deep-link router and received none of it,
// because no producer ever emitted these events. A dashboard belongs on a
// phone precisely for the moments you are NOT looking at it, and that requires
// a server-side emitter — this one.
//
// Shape and invariants:
//
//   - It is a WORKER, not a request path: the anomaly rows it reads are
//     written inline by DashboardStats, and a person who never opens the
//     dashboard must still be told.
//   - Cross-tenant enumeration happens only inside db.WithWorkerScope; every
//     read of tenant-owned data re-enters db.WithTenant, so a sweep never
//     leaks a broad RLS capability into per-tenant work.
//   - It keeps NO high-water state of its own. Idempotency is the
//     notification_feed dedupe key (unique on (tenant_id, user_id,
//     dedupe_key)), which is the same identity every delivery channel already
//     carries. A restarted, duplicated, or re-scheduled sweep re-derives the
//     same keys and fans out nothing twice — that property is the reason a
//     `dashboard_notification_state` table does not exist here.
//   - Milestones notify only the HIGHEST threshold crossed, so switching the
//     emitter on for an existing 400k-subscriber workspace produces one
//     notification, not eleven.
package dashboardnotify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
)

// Canonical event types. They intentionally reuse the existing dotted
// vocabulary so the manifest codegen phase can adopt them unchanged.
const (
	EventAnomaly   = "analytics.anomaly"
	EventMilestone = "audience.milestone"
)

const (
	// Hourly, matching the dashboard digest sender. A dashboard signal is not
	// a real-time alert — it is "you should know about this today" — and the
	// sweep costs one bounded count per tenant, so a tighter interval would
	// buy minutes of latency for a multiple of the load.
	defaultInterval      = time.Hour
	defaultAnomalyWindow = 24 * time.Hour
	maxAnomaliesPerSweep = 5
	maxTenantsPerSweep   = 5000
)

// MilestoneThresholds are the audience sizes worth interrupting someone for.
// Deliberately sparse and super-linear: a milestone is a celebration, and one
// that fires every thousand subscribers stops being one.
var MilestoneThresholds = []int{
	100, 500, 1_000, 5_000, 10_000, 25_000, 50_000,
	100_000, 250_000, 500_000, 1_000_000,
}

// Dispatcher is the unified notification chokepoint (notifyfanout.Fanout).
type Dispatcher interface {
	Dispatch(ctx context.Context, tenantID string, userIDs []string, ev notifyfanout.Event) []notifyfanout.Delivery
}

// Emitter sweeps every tenant and fans dashboard signals to its operators.
type Emitter struct {
	Pool     *db.Pool
	Fanout   Dispatcher
	Interval time.Duration
	// AnomalyWindow bounds how recently an anomaly must have been detected to
	// still be worth an interruption. A spike from last week is history, not
	// news.
	AnomalyWindow time.Duration
	Now           func() time.Time
	Logger        *slog.Logger
}

func (e *Emitter) now() time.Time {
	if e != nil && e.Now != nil {
		return e.Now()
	}
	return time.Now().UTC()
}

func (e *Emitter) log() *slog.Logger {
	if e != nil && e.Logger != nil {
		return e.Logger
	}
	return slog.Default()
}

func (e *Emitter) configured() bool {
	return e != nil && e.Pool != nil && e.Fanout != nil
}

// Run sweeps on an interval until ctx is cancelled. An unconfigured emitter
// (no pool or no fanout) returns immediately rather than spinning.
func (e *Emitter) Run(ctx context.Context) {
	if !e.configured() {
		return
	}
	interval := e.Interval
	if interval <= 0 {
		interval = defaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	if err := e.Tick(ctx); err != nil && !errors.Is(err, context.Canceled) {
		e.log().Warn("dashboardnotify: sweep failed", "err", err.Error())
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.Tick(ctx); err != nil && !errors.Is(err, context.Canceled) {
				e.log().Warn("dashboardnotify: sweep failed", "err", err.Error())
			}
		}
	}
}

// Tick performs one sweep. Exported for deterministic tests and one-shot
// operational runs. A failure for one tenant never aborts the others: a single
// workspace with a broken row must not silence the rest of the fleet.
func (e *Emitter) Tick(ctx context.Context) error {
	if !e.configured() {
		return errors.New("dashboardnotify: emitter is not configured")
	}
	tenantIDs, err := e.tenantIDs(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, tenantID := range tenantIDs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		operators, err := e.operatorIDs(ctx, tenantID)
		if err != nil {
			errs = append(errs, fmt.Errorf("operators for %s: %w", tenantID, err))
			continue
		}
		if len(operators) == 0 {
			continue
		}
		if err := e.emitAnomalies(ctx, tenantID, operators); err != nil {
			errs = append(errs, fmt.Errorf("anomalies for %s: %w", tenantID, err))
		}
		if err := e.emitMilestone(ctx, tenantID, operators); err != nil {
			errs = append(errs, fmt.Errorf("milestone for %s: %w", tenantID, err))
		}
	}
	return errors.Join(errs...)
}

// tenantIDs is the one deliberately cross-tenant step, mirroring the dashboard
// digest worker: the worker policy may enumerate tenants and nothing else.
func (e *Emitter) tenantIDs(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, e.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY id LIMIT $1`, maxTenantsPerSweep)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, 64)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// operatorIDs resolves the owner+admin recipients, tenant-scoped so RLS is the
// boundary rather than the WHERE clause alone.
func (e *Emitter) operatorIDs(ctx context.Context, tenantID string) ([]string, error) {
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text FROM users
 WHERE tenant_id = $1::uuid AND role = ANY($2::text[])
 ORDER BY created_at ASC`, tenantID, []string{"owner", "admin"})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0, 4)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

type anomalyRow struct {
	metric    string
	dayBucket time.Time
	value     int
	mean      float64
	zScore    float64
}

func (e *Emitter) emitAnomalies(ctx context.Context, tenantID string, operators []string) error {
	window := e.AnomalyWindow
	if window <= 0 {
		window = defaultAnomalyWindow
	}
	rows, err := e.recentAnomalies(ctx, tenantID, e.now().Add(-window))
	if err != nil {
		return err
	}
	for _, row := range rows {
		title, body := anomalyCopy(row)
		e.Fanout.Dispatch(ctx, tenantID, operators, notifyfanout.Event{
			Type:  EventAnomaly,
			Kind:  EventAnomaly,
			Title: title,
			Body:  body,
			// The native payload stays content-light on purpose: an id and a
			// metric name, never a customer row.
			MobileBody: "An unusual " + row.metric + " spike was detected.",
			URL:        "/app/analytics",
			EntityID:   row.metric,
			// One notification per metric per day, forever — the anomaly row
			// itself is upserted on (tenant, metric, day_bucket), so a
			// re-detection must not re-interrupt anyone.
			DedupeKey: EventAnomaly + ":" + row.metric + ":" + row.dayBucket.UTC().Format("2006-01-02"),
			Payload: map[string]any{
				"metric":     row.metric,
				"day_bucket": row.dayBucket.UTC().Format("2006-01-02"),
				"value":      row.value,
				"mean":       row.mean,
				"z_score":    row.zScore,
			},
		})
	}
	return nil
}

func (e *Emitter) recentAnomalies(ctx context.Context, tenantID string, since time.Time) ([]anomalyRow, error) {
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT metric, day_bucket, value, mean, z_score
  FROM dashboard_anomalies
 WHERE tenant_id = $1::uuid AND detected_at >= $2
 ORDER BY detected_at DESC
 LIMIT $3`, tenantID, since, maxAnomaliesPerSweep)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]anomalyRow, 0, maxAnomaliesPerSweep)
	for rows.Next() {
		var row anomalyRow
		if err := rows.Scan(&row.metric, &row.dayBucket, &row.value, &row.mean, &row.zScore); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (e *Emitter) emitMilestone(ctx context.Context, tenantID string, operators []string) error {
	count, err := e.audienceSize(ctx, tenantID)
	if err != nil {
		return err
	}
	threshold := HighestCrossedMilestone(count)
	if threshold == 0 {
		return nil
	}
	label := formatThousands(threshold)
	e.Fanout.Dispatch(ctx, tenantID, operators, notifyfanout.Event{
		Type:       EventMilestone,
		Kind:       EventMilestone,
		Title:      label + " subscribers 🎉",
		Body:       "Your audience just passed " + label + " active subscribers.",
		MobileBody: "Your audience just passed " + label + " active subscribers.",
		URL:        "/app/subscribers",
		EntityID:   strconv.Itoa(threshold),
		// Crossing a threshold is a once-ever event per workspace. The feed's
		// unique dedupe index makes that true across replicas and restarts
		// without any state of our own — including when the count later dips
		// back below the line and rises again.
		DedupeKey: EventMilestone + ":" + strconv.Itoa(threshold),
		Payload: map[string]any{
			"threshold":   threshold,
			"subscribers": count,
		},
	})
	return nil
}

// audienceSize counts the ACTIVE audience only. Counting blocklisted or
// unconfirmed rows would celebrate a number the operator cannot email.
//
// The count is deliberately BOUNDED at one past the largest threshold. Nothing
// above that changes the answer, and the bound is what keeps a fleet-wide
// hourly sweep from turning into a full count over every large workspace's
// subscriber table. It rides subscribers_tenant_status_idx.
func (e *Emitter) audienceSize(ctx context.Context, tenantID string) (int, error) {
	tx, err := db.WithTenant(ctx, e.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ceiling := MilestoneThresholds[len(MilestoneThresholds)-1] + 1
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM (
    SELECT 1 FROM subscribers
     WHERE tenant_id = $1::uuid AND status = 'enabled'
     LIMIT $2
) AS bounded`, tenantID, ceiling).Scan(&count); err != nil {
		return 0, err
	}
	return count, tx.Commit(ctx)
}

// HighestCrossedMilestone returns the largest threshold count has reached, or
// 0 when the audience has not reached the first one.
func HighestCrossedMilestone(count int) int {
	best := 0
	for _, threshold := range MilestoneThresholds {
		if count >= threshold {
			best = threshold
		}
	}
	return best
}

// anomalyCopy renders operator-facing copy. It never interpolates customer
// data — an anomaly is about a metric series, so the only variables are the
// metric name and its own numbers.
func anomalyCopy(row anomalyRow) (title, body string) {
	title = "Unusual " + row.metric + " activity"
	body = fmt.Sprintf("%s hit %d on %s (typical is about %.0f).",
		row.metric, row.value, row.dayBucket.UTC().Format("Jan 2"), row.mean)
	return title, body
}

// formatThousands renders 1000 -> "1,000". Small and local: the alternative is
// a locale dependency for three call sites of celebration copy.
func formatThousands(value int) string {
	digits := strconv.Itoa(value)
	if len(digits) <= 3 {
		return digits
	}
	lead := len(digits) % 3
	out := digits[:lead]
	for index := lead; index < len(digits); index += 3 {
		if out != "" {
			out += ","
		}
		out += digits[index : index+3]
	}
	return out
}
