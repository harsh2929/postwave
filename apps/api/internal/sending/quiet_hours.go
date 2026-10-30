// Send-loop guard — quiet-hours checker.
//
// Quiet hours are a per-tenant window stored in tenant_sending_settings:
// quiet_hours_start, quiet_hours_end, quiet_hours_tz. Hours are HH:MM in
// the tenant's IANA timezone. Both fields nullable; either being NULL or
// empty means "no quiet hours configured" → always allowed.
//
// Schema reality check (migration 0068):
//
//   - The X1 spec mentioned a `weekend_quiet bool` and `_local`-suffixed
//     HH:MM columns; those columns DO NOT exist on tenant_sending_settings
//     and the spec is wrong. Per the "no new migrations" rule the checker
//     accepts a `WeekendQuiet` knob on the struct (used by tests + future
//     wiring) and treats it as false at the SQL boundary, since there's no
//     persistent column for it yet. Operators can still simulate weekend
//     quiet by setting a 24h window on Friday eve and rotating it weekly,
//     but the production wiring will need a new migration before
//     weekend_quiet becomes a real per-tenant setting.

package sending

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// QuietHoursChecker decides whether a tenant is currently inside its
// configured quiet window. Construction is just `&QuietHoursChecker{Pool: pool}`;
// the checker reads from tenant_sending_settings under RLS each call.
type QuietHoursChecker struct {
	Pool *db.Pool

	// WeekendQuiet, when true, silences ALL of Saturday + Sunday in the
	// tenant TZ regardless of the configured hourly window. The schema
	// has no column for it yet (see file header); the field exists so
	// tests can exercise the path and so a future migration can wire
	// it without a checker API change.
	WeekendQuiet bool
}

// quietConfig is the row shape we read out of tenant_sending_settings.
// All fields are optional: missing row OR all-empty values both mean
// "no quiet hours, always allowed".
type quietConfig struct {
	start        string // "HH:MM" or ""
	end          string // "HH:MM" or ""
	tz           string // IANA name; "" → UTC
	perRecipient bool   // true → subscriber timezone overrides tenant tz
}

// Allowed returns true when `at` is OUTSIDE the configured quiet window
// (i.e. the guard is free to send). Returns true when:
//
//   - The tenant has no row in tenant_sending_settings.
//   - The row has empty start/end (configured but cleared).
//   - The current time in the tenant TZ is OUTSIDE [start, end).
//
// Wrap-around windows (e.g. 22:00 → 08:00) are handled correctly: the
// "inside" predicate becomes (now >= start) OR (now < end) when end < start.
//
// Weekend-quiet, when wired, returns false on Sat/Sun regardless of the
// hourly window.
//
// TZ falls back to UTC when the configured tz is empty or unparseable —
// we never throw on a bad TZ since that would block sending entirely on a
// typo. Misconfigured TZ is logged by the caller, not raised here.
func (q *QuietHoursChecker) Allowed(ctx context.Context, tenantID string, at time.Time) (bool, error) {
	if q == nil || q.Pool == nil {
		// Defensive: an unconfigured checker is "always allowed" rather
		// than "always blocked". The send guard requires an explicit
		// QuietHoursChecker, so reaching here means the checker was
		// constructed without a pool, which is a wiring bug — fail open.
		return true, nil
	}
	cfg, err := q.load(ctx, tenantID)
	if err != nil {
		return false, err
	}
	return decideAllowed(cfg, q.WeekendQuiet, at), nil
}

// AllowedForSubscriber is the per-recipient TZ-aware variant.
// Resolves quiet-hours against `subscriberTZ` (an IANA name like
// "America/New_York" or "Asia/Tokyo") when non-empty, otherwise
// falls back to the tenant's configured tz. Loads the tenant
// config once and re-uses it for the comparison.
//
// Audit (send-pipeline HIGH): the single-tz-per-tenant model was
// correct only for subscribers in the tenant's configured TZ. A
// global-list tenant with US-Eastern quiet hours was happily
// sending to Tokyo subscribers at midnight local time.
func (q *QuietHoursChecker) AllowedForSubscriber(ctx context.Context, tenantID, subscriberTZ string, at time.Time) (bool, error) {
	if q == nil || q.Pool == nil {
		return true, nil
	}
	cfg, err := q.load(ctx, tenantID)
	if err != nil {
		return false, err
	}
	if cfg.perRecipient && strings.TrimSpace(subscriberTZ) != "" {
		cfg.tz = subscriberTZ
	}
	return decideAllowed(cfg, q.WeekendQuiet, at), nil
}

// AllowedWithConfig is the loadless variant for cases where the
// caller has already fetched the tenant config (e.g., the send
// loop's batch path that resolves config once per tick rather than
// per row). subscriberTZ overrides cfg.tz when non-empty.
func (q *QuietHoursChecker) AllowedWithConfig(cfg QuietConfig, subscriberTZ string, at time.Time) bool {
	if q == nil {
		return true
	}
	c := quietConfig(cfg)
	if c.perRecipient && strings.TrimSpace(subscriberTZ) != "" {
		c.tz = subscriberTZ
	}
	return decideAllowed(c, q.WeekendQuiet, at)
}

// LoadConfig exposes the loaded tenant quiet-hours config to
// callers that want to do per-row checks via AllowedWithConfig
// without paying for a DB round-trip per row.
func (q *QuietHoursChecker) LoadConfig(ctx context.Context, tenantID string) (QuietConfig, error) {
	if q == nil || q.Pool == nil {
		return QuietConfig{}, nil
	}
	c, err := q.load(ctx, tenantID)
	if err != nil {
		return QuietConfig{}, err
	}
	return QuietConfig(c), nil
}

// QuietConfig is the public alias of quietConfig — exposed for the
// send-loop's batch-cached path. Same layout, same semantics.
type QuietConfig struct {
	start        string
	end          string
	tz           string
	perRecipient bool
}

// load reads the quiet-hours config for tenantID. Missing row → zero-value
// config which decideAllowed treats as "no window".
func (q *QuietHoursChecker) load(ctx context.Context, tenantID string) (quietConfig, error) {
	tx, err := db.WithTenant(ctx, q.Pool, tenantID)
	if err != nil {
		return quietConfig{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const sel = `
SELECT COALESCE(quiet_hours_start, ''),
       COALESCE(quiet_hours_end,   ''),
       COALESCE(quiet_hours_tz,    ''),
       COALESCE(quiet_hours_per_recipient, true)
FROM   tenant_sending_settings
WHERE  tenant_id = $1::uuid`
	var c quietConfig
	err = tx.QueryRow(ctx, sel, tenantID).Scan(&c.start, &c.end, &c.tz, &c.perRecipient)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return quietConfig{perRecipient: true}, tx.Commit(ctx)
		}
		return quietConfig{}, fmt.Errorf("quiet hours read: %w", err)
	}
	return c, tx.Commit(ctx)
}

// decideAllowed is the pure decision function. Split out from Allowed so
// quiet_hours_test.go can exercise wrap-around / DST / weekend cases
// without a database.
func decideAllowed(cfg quietConfig, weekendQuiet bool, at time.Time) bool {
	loc := loadLocation(cfg.tz)
	local := at.In(loc)

	if weekendQuiet {
		switch local.Weekday() {
		case time.Saturday, time.Sunday:
			return false
		}
	}

	startMins, startOK := parseHHMM(cfg.start)
	endMins, endOK := parseHHMM(cfg.end)
	if !startOK || !endOK {
		// Either field empty / malformed → no hourly window configured.
		return true
	}
	if startMins == endMins {
		// Zero-length window = no quiet (a 24h-quiet config would set
		// start=00:00 end=00:00 and naturally fall out as "no quiet"
		// — that's a known cliff; we don't try to invent a 24h flag
		// here since the schema can't represent it).
		return true
	}
	nowMins := local.Hour()*60 + local.Minute()
	if startMins < endMins {
		// Same-day window, e.g. 09:00 → 17:00.
		inside := nowMins >= startMins && nowMins < endMins
		return !inside
	}
	// Wrap-around window, e.g. 22:00 → 08:00 (means: quiet from 22:00
	// today through 08:00 tomorrow). "inside" if now >= start OR now < end.
	inside := nowMins >= startMins || nowMins < endMins
	return !inside
}

// parseHHMM accepts "HH:MM" and returns minutes-since-midnight. Empty or
// malformed input returns ok=false.
func parseHHMM(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	var h, m int
	n, err := fmt.Sscanf(s, "%d:%d", &h, &m)
	if err != nil || n != 2 {
		return 0, false
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

// loadLocation returns the IANA location, defaulting to UTC for empty or
// unparseable names. The defensive fallback exists so a typo'd tz doesn't
// silently block sending forever.
func loadLocation(name string) *time.Location {
	if strings.TrimSpace(name) == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}
