// best_send_hour.go — nightly recompute of per-subscriber best-send-hour.
//
// The job iterates subscribers whose best_send_hour_at is older than the
// configured stale window (default 14 days) or has never been computed,
// reads up to 1000 of their most-recent open events, and writes back the
// modal hour-of-week.
//
// Only subscribers with >= MinOpens historical opens are updated; cold
// subs are left NULL so the API surface can fall back to the tenant mean.
//
// Mirrors RecurrenceScanner's lifecycle: a goroutine ticking on Interval.

package worker

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// BestSendHourScanner runs the nightly recompute. Inject the same pgx pool
// the API uses; the scanner sets app.tenant_id per subscriber so RLS gates
// the update correctly.
type BestSendHourScanner struct {
	Pool        *pgxpool.Pool
	Logger      *slog.Logger
	Interval    time.Duration
	StaleWindow time.Duration
	BatchSize   int
	Now         func() time.Time
}

// minOpens mirrors send_time_opt.MinOpens — duplicated here to avoid
// importing apps/api into the automation service (LICENSE-BOUNDARY rule).
const minOpens = 5

// Run loops until ctx cancellation.
func (s *BestSendHourScanner) Run(ctx context.Context) {
	if s.Interval <= 0 {
		s.Interval = 24 * time.Hour
	}
	if s.StaleWindow <= 0 {
		s.StaleWindow = 14 * 24 * time.Hour
	}
	if s.BatchSize <= 0 {
		s.BatchSize = 500
	}
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.tick(ctx); err != nil {
				s.logger().Warn("best_send_hour scan failed", "err", err.Error())
			}
		}
	}
}

func (s *BestSendHourScanner) tick(ctx context.Context) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = panicError("best_send_hour scan", r)
		}
	}()
	cutoff := s.now().Add(-s.StaleWindow)
	rows, err := s.Pool.Query(ctx, `
SELECT tenant_id::text, email::text
FROM subscribers
WHERE best_send_hour_at IS NULL OR best_send_hour_at < $1
ORDER BY best_send_hour_at NULLS FIRST
LIMIT $2`, cutoff, s.BatchSize)
	if err != nil {
		return err
	}
	type row struct{ tenant, email string }
	stale := []row{}
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.tenant, &r.email); err != nil {
			rows.Close()
			return err
		}
		stale = append(stale, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range stale {
		if err := s.recomputeOne(ctx, r.tenant, r.email); err != nil {
			s.logger().Warn("best_send_hour recompute failed",
				"tenant", r.tenant, "email_redacted", redactEmail(r.email), "err", err.Error())
		}
	}
	return nil
}

func (s *BestSendHourScanner) recomputeOne(ctx context.Context, tenantID, email string) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
SELECT at FROM subscriber_events
WHERE tenant_id = $1::uuid AND subscriber_email = $2 AND event_type = 'opened'
ORDER BY at DESC
LIMIT 1000`, tenantID, strings.ToLower(email))
	if err != nil {
		return err
	}
	hours := []int{}
	for rows.Next() {
		var at time.Time
		if err := rows.Scan(&at); err != nil {
			rows.Close()
			return err
		}
		hours = append(hours, hourOfWeek(at))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	now := s.now()
	if len(hours) < minOpens {
		// Stamp computed_at so we don't reconsider this subscriber until the
		// next stale window. Leaves best_send_hour NULL.
		_, err := tx.Exec(ctx,
			`UPDATE subscribers SET best_send_hour_at = $3, updated_at = now()
             WHERE tenant_id = $1::uuid AND email = $2`,
			tenantID, strings.ToLower(email), now)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	best, _ := mode(hours)
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET best_send_hour = $3, best_send_hour_at = $4, updated_at = now()
WHERE tenant_id = $1::uuid AND email = $2`,
		tenantID, strings.ToLower(email), best, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *BestSendHourScanner) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *BestSendHourScanner) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func hourOfWeek(t time.Time) int {
	t = t.UTC()
	return int(t.Weekday())*24 + t.Hour()
}

func mode(hours []int) (int, int) {
	if len(hours) == 0 {
		return 0, 0
	}
	counts := make(map[int]int, 24)
	for _, h := range hours {
		counts[h]++
	}
	bestHour, bestCount := -1, 0
	for h := 0; h < 168; h++ {
		c := counts[h]
		if c > bestCount {
			bestHour, bestCount = h, c
		}
	}
	if bestHour < 0 {
		bestHour = hours[0]
		bestCount = counts[bestHour]
	}
	return bestHour, bestCount
}
