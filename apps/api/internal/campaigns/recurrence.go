package campaigns

// 5-field cron parser used by the recurrence API + the automation
// service's RecurrenceScanner. Mirror of the parser in
// services/automation/internal/worker/recurrence.go (intentional
// duplicate so the api gateway does not need to import the automation
// service). Only supports "*" and comma-separated lists; ranges, steps,
// and macros are out of scope — the recurrence feature is for
// "every Monday at 9am" style use cases which lists already cover.

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// CronSpec is a parsed 5-field cron expression: minute, hour,
// day-of-month, month, day-of-week.
type CronSpec struct {
	Minutes    []int
	Hours      []int
	DayOfMonth []int
	Month      []int
	DayOfWeek  []int
}

// ParseCron parses a 5-field cron expression. Returns an error on any
// malformed field.
func ParseCron(expr string) (*CronSpec, error) {
	parts := strings.Fields(strings.TrimSpace(expr))
	if len(parts) != 5 {
		return nil, fmt.Errorf("cron: expected 5 fields, got %d", len(parts))
	}
	mins, err := parseCronField(parts[0], 0, 59)
	if err != nil {
		return nil, fmt.Errorf("cron minute: %w", err)
	}
	hours, err := parseCronField(parts[1], 0, 23)
	if err != nil {
		return nil, fmt.Errorf("cron hour: %w", err)
	}
	dom, err := parseCronField(parts[2], 1, 31)
	if err != nil {
		return nil, fmt.Errorf("cron day-of-month: %w", err)
	}
	mon, err := parseCronField(parts[3], 1, 12)
	if err != nil {
		return nil, fmt.Errorf("cron month: %w", err)
	}
	dow, err := parseCronField(parts[4], 0, 6)
	if err != nil {
		return nil, fmt.Errorf("cron day-of-week: %w", err)
	}
	return &CronSpec{Minutes: mins, Hours: hours, DayOfMonth: dom, Month: mon, DayOfWeek: dow}, nil
}

func parseCronField(field string, lo, hi int) ([]int, error) {
	if field == "*" {
		return nil, nil
	}
	out := []int{}
	for _, raw := range strings.Split(field, ",") {
		v, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("not an integer: %q", raw)
		}
		if v < lo || v > hi {
			return nil, fmt.Errorf("value %d out of range [%d,%d]", v, lo, hi)
		}
		out = append(out, v)
	}
	return out, nil
}

// Matches reports whether the spec matches the given moment.
func (c *CronSpec) Matches(t time.Time) bool {
	return inSet(c.Minutes, t.Minute()) &&
		inSet(c.Hours, t.Hour()) &&
		inSet(c.DayOfMonth, t.Day()) &&
		inSet(c.Month, int(t.Month())) &&
		inSet(c.DayOfWeek, int(t.Weekday()))
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

// DueWithin returns the list of fire times in [from, until) for the spec,
// stepping minute-by-minute. Intended for the nightly recurrence scanner.
func (c *CronSpec) DueWithin(from, until time.Time) []time.Time {
	if !until.After(from) {
		return nil
	}
	out := []time.Time{}
	t := from.Truncate(time.Minute)
	if t.Before(from) {
		t = t.Add(time.Minute)
	}
	for t.Before(until) {
		if c.Matches(t) {
			out = append(out, t)
		}
		t = t.Add(time.Minute)
	}
	return out
}
