// SPDX-License-Identifier: AGPL-3.0-only
package canonical

import (
	"fmt"
	"time"
)

// TriggerDateField is the date-based trigger discriminator.
// Spec: {kind: "date_field", field_key: "birthday", offset_days: N,
// time_of_day: "HH:MM", tz: "IANA"}.
const TriggerDateField = "date_field"

// DateFieldTrigger is the typed view of a date-field trigger. The wire
// shape uses AutomationTrigger so SDK passthrough stays additive; this
// helper carries the validated form to the matcher.
type DateFieldTrigger struct {
	FieldKey   string
	OffsetDays int
	TimeOfDay  string // HH:MM
	TZ         string // IANA, defaults to UTC
}

// ValidateDateField returns nil if the trigger is a well-formed date_field
// spec, else an error describing the problem.
func ValidateDateField(t AutomationTrigger) error {
	if t.Type != TriggerDateField {
		return fmt.Errorf("expected type %q, got %q", TriggerDateField, t.Type)
	}
	if t.Field == "" {
		return fmt.Errorf("field is required for date_field trigger")
	}
	if t.TimeOfDay != "" {
		if _, _, err := parseTimeOfDay(t.TimeOfDay); err != nil {
			return fmt.Errorf("time_of_day: %w", err)
		}
	}
	if t.TZ != "" {
		if _, err := time.LoadLocation(t.TZ); err != nil {
			return fmt.Errorf("tz: %w", err)
		}
	}
	return nil
}

// MatchDateField reports whether the trigger fires at `now` for a
// subscriber whose custom_field value is `fieldVal` (a date string in
// YYYY-MM-DD or RFC3339 form). The match condition: today (in tz)
// shifted forward by OffsetDays equals (month, day) of fieldVal.
//
// This is the central matcher used by the date_trigger worker; it does
// not check time-of-day — the worker schedules itself hourly and only
// fires when the local hour matches.
func MatchDateField(t AutomationTrigger, fieldVal string, now time.Time) bool {
	if t.Type != TriggerDateField || fieldVal == "" {
		return false
	}
	loc := time.UTC
	if t.TZ != "" {
		if l, err := time.LoadLocation(t.TZ); err == nil {
			loc = l
		}
	}
	// Parse the stored date. Accept YYYY-MM-DD or any RFC3339-ish form.
	parsed, err := parseFlexibleDate(fieldVal)
	if err != nil {
		return false
	}
	target := now.In(loc).AddDate(0, 0, t.OffsetDays)
	return target.Month() == parsed.Month() && target.Day() == parsed.Day()
}

// parseFlexibleDate accepts a small set of date encodings. We deliberately
// only consider month + day downstream, so the year is ignored.
func parseFlexibleDate(s string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02", time.RFC3339, "01/02/2006", "2006/01/02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unparseable date: %q", s)
}
