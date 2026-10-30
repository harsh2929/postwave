package canonical

import (
	"fmt"
	"time"
)

// ValidateEveryNDays returns nil if the trigger is a well-formed
// every_n_days spec, else an error describing what is wrong. The
// automation create endpoint should call this before persisting.
func ValidateEveryNDays(t AutomationTrigger) error {
	if t.Type != TriggerKindEveryNDays {
		return fmt.Errorf("expected type %q, got %q", TriggerKindEveryNDays, t.Type)
	}
	if t.EveryNDays < 1 {
		return fmt.Errorf("every_n_days must be >= 1, got %d", t.EveryNDays)
	}
	if t.TimeOfDay == "" {
		return fmt.Errorf("time_of_day is required (HH:MM)")
	}
	if _, _, err := parseTimeOfDay(t.TimeOfDay); err != nil {
		return fmt.Errorf("time_of_day: %w", err)
	}
	if t.TZ != "" {
		if _, err := time.LoadLocation(t.TZ); err != nil {
			return fmt.Errorf("tz: %w", err)
		}
	}
	return nil
}

// NextEveryNDaysFire returns the next time-of-day fire moment strictly
// after `now` (or after `lastFired` if non-zero) given the cadence and
// timezone. Anchored to TimeOfDay in TZ; falls back to UTC when TZ is
// blank.
func NextEveryNDaysFire(t AutomationTrigger, lastFired, now time.Time) (time.Time, error) {
	if err := ValidateEveryNDays(t); err != nil {
		return time.Time{}, err
	}
	loc := time.UTC
	if t.TZ != "" {
		l, err := time.LoadLocation(t.TZ)
		if err != nil {
			return time.Time{}, err
		}
		loc = l
	}
	hour, min, _ := parseTimeOfDay(t.TimeOfDay)

	// Anchor: midnight (in tz) of the day of lastFired (or now if no last).
	anchorDay := now.In(loc)
	if !lastFired.IsZero() {
		anchorDay = lastFired.In(loc)
	}
	anchor := time.Date(anchorDay.Year(), anchorDay.Month(), anchorDay.Day(),
		hour, min, 0, 0, loc)

	// If we have not fired yet and anchor is still in the future, that is
	// the next fire time.
	if lastFired.IsZero() {
		if anchor.After(now) {
			return anchor, nil
		}
		return anchor.AddDate(0, 0, t.EveryNDays), nil
	}

	// Otherwise step in N-day increments until strictly after now.
	next := anchor.AddDate(0, 0, t.EveryNDays)
	for !next.After(now) {
		next = next.AddDate(0, 0, t.EveryNDays)
	}
	return next, nil
}

// IsDueEveryNDays reports whether the trigger should fire at `now`,
// given its last fire time. A trigger is due when we are at or past the
// next computed fire moment.
func IsDueEveryNDays(t AutomationTrigger, lastFired, now time.Time) bool {
	if err := ValidateEveryNDays(t); err != nil {
		return false
	}
	if lastFired.IsZero() {
		// Never fired: due iff today's anchor (in tz) is at-or-before now.
		loc := time.UTC
		if t.TZ != "" {
			if l, err := time.LoadLocation(t.TZ); err == nil {
				loc = l
			}
		}
		hour, min, _ := parseTimeOfDay(t.TimeOfDay)
		local := now.In(loc)
		anchor := time.Date(local.Year(), local.Month(), local.Day(),
			hour, min, 0, 0, loc)
		return !anchor.After(now)
	}
	// Already fired: due iff at-or-past last + N days.
	due := lastFired.AddDate(0, 0, t.EveryNDays)
	return !due.After(now)
}

func parseTimeOfDay(s string) (int, int, error) {
	var h, m int
	n, err := fmt.Sscanf(s, "%d:%d", &h, &m)
	if err != nil || n != 2 {
		return 0, 0, fmt.Errorf("expected HH:MM, got %q", s)
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, fmt.Errorf("HH:MM out of range: %q", s)
	}
	return h, m, nil
}
