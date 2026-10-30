// date_trigger.go — hourly scan for date_field triggers (birthday,
// anniversary, etc.).
//
// For each active automation with a date_field trigger, the worker queries
// subscribers whose custom_field[field_key] matches today + offset_days
// (month + day, year ignored) and enqueues automation events through the
// engine's Trigger entry point. Only fires when the local hour-of-day in
// the trigger's TZ equals the trigger's TimeOfDay hour, so the per-tick
// fan-out stays bounded.

package worker

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/automation/internal/canonical"
	"github.com/postwave/postwave/services/automation/internal/runtime"
)

// DateTriggerScanner runs hourly. The Lister surfaces every active
// automation; the worker filters down to those carrying a date_field
// trigger.
type DateTriggerScanner struct {
	Pool     *pgxpool.Pool
	Engine   *runtime.Engine
	Lister   runtime.AutomationLister
	Logger   *slog.Logger
	Interval time.Duration
	Now      func() time.Time
}

// Run loops until ctx cancellation.
func (s *DateTriggerScanner) Run(ctx context.Context) {
	if s.Interval <= 0 {
		s.Interval = time.Hour
	}
	t := time.NewTicker(s.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.tick(ctx); err != nil {
				s.logger().Warn("date_trigger scan failed", "err", err.Error())
			}
		}
	}
}

func (s *DateTriggerScanner) tick(ctx context.Context) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = panicError("date_trigger scan", r)
		}
	}()
	tenants, err := s.distinctTenants(ctx)
	if err != nil {
		return err
	}
	now := s.now()
	for _, tenantID := range tenants {
		autos, err := s.Lister.ListActiveByTenant(ctx, tenantID)
		if err != nil {
			s.logger().Warn("date_trigger list failed", "tenant", tenantID, "err", err.Error())
			continue
		}
		for _, a := range autos {
			for _, trig := range a.Triggers {
				if trig.Type != canonical.TriggerDateField {
					continue
				}
				if !hourMatchesTrigger(trig, now) {
					continue
				}
				if err := s.fireForAutomation(ctx, tenantID, a.ID, trig, now); err != nil {
					s.logger().Warn("date_trigger fire failed",
						"automation", a.ID, "err", err.Error())
				}
			}
		}
	}
	return nil
}

// hourMatchesTrigger returns true when the trigger's TimeOfDay hour, in
// its TZ, equals the current hour. When TimeOfDay is empty we fire on
// every hourly tick (compat with minimal trigger specs).
func hourMatchesTrigger(t canonical.AutomationTrigger, now time.Time) bool {
	if t.TimeOfDay == "" {
		return true
	}
	loc := time.UTC
	if t.TZ != "" {
		if l, err := time.LoadLocation(t.TZ); err == nil {
			loc = l
		}
	}
	hh, _, err := splitTimeOfDay(t.TimeOfDay)
	if err != nil {
		return false
	}
	return now.In(loc).Hour() == hh
}

func splitTimeOfDay(s string) (int, int, error) {
	parts := strings.SplitN(s, ":", 2)
	if len(parts) != 2 {
		return 0, 0, errBadTimeOfDay
	}
	h, m := 0, 0
	for _, c := range parts[0] {
		if c < '0' || c > '9' {
			return 0, 0, errBadTimeOfDay
		}
		h = h*10 + int(c-'0')
	}
	for _, c := range parts[1] {
		if c < '0' || c > '9' {
			return 0, 0, errBadTimeOfDay
		}
		m = m*10 + int(c-'0')
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, errBadTimeOfDay
	}
	return h, m, nil
}

var errBadTimeOfDay = errors.New("bad time_of_day")

func (s *DateTriggerScanner) fireForAutomation(
	ctx context.Context, tenantID, automationID string,
	trig canonical.AutomationTrigger, now time.Time,
) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `
SELECT email::text, custom_fields->>$2
FROM subscribers
WHERE tenant_id = $1::uuid
  AND status = 'enabled'
  AND custom_fields ? $2`, tenantID, trig.Field)
	if err != nil {
		return err
	}
	type hit struct{ email, val string }
	hits := []hit{}
	for rows.Next() {
		var h hit
		if err := rows.Scan(&h.email, &h.val); err != nil {
			rows.Close()
			return err
		}
		if canonical.MatchDateField(trig, h.val, now) {
			hits = append(hits, h)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, h := range hits {
		payload := map[string]interface{}{
			"trigger_type": canonical.TriggerDateField,
			"field_key":    trig.Field,
			"field_value":  h.val,
			"at":           now,
		}
		if err := s.Engine.Trigger(ctx, automationID,
			canonical.TriggerDateField, h.email, payload); err != nil {
			s.logger().Warn("date_trigger Trigger() failed",
				"automation", automationID, "email_redacted", redactEmail(h.email), "err", err.Error())
		}
	}
	return nil
}

func (s *DateTriggerScanner) distinctTenants(ctx context.Context) ([]string, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT DISTINCT tenant_id::text FROM subscribers WHERE status = 'enabled'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (s *DateTriggerScanner) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
}

func (s *DateTriggerScanner) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}
