package canonical

import (
	"testing"
	"time"
)

func newEveryNDays(n int, tod, tz string) AutomationTrigger {
	return AutomationTrigger{
		Type: TriggerKindEveryNDays, EveryNDays: n, TimeOfDay: tod, TZ: tz,
	}
}

func TestValidateEveryNDays(t *testing.T) {
	if err := ValidateEveryNDays(newEveryNDays(1, "09:00", "UTC")); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	if err := ValidateEveryNDays(newEveryNDays(0, "09:00", "")); err == nil {
		t.Errorf("n=0 should fail")
	}
	if err := ValidateEveryNDays(newEveryNDays(3, "", "")); err == nil {
		t.Errorf("missing time_of_day should fail")
	}
	if err := ValidateEveryNDays(newEveryNDays(3, "25:99", "")); err == nil {
		t.Errorf("bad time_of_day should fail")
	}
	if err := ValidateEveryNDays(newEveryNDays(3, "09:00", "Not/A/Real/TZ")); err == nil {
		t.Errorf("bad tz should fail")
	}
	bad := newEveryNDays(1, "09:00", "")
	bad.Type = "wrong"
	if err := ValidateEveryNDays(bad); err == nil {
		t.Errorf("wrong type should fail")
	}
}

func TestIsDueEveryNDays_NeverFired(t *testing.T) {
	trig := newEveryNDays(7, "09:00", "UTC")
	// Before 9am: not due.
	now := time.Date(2026, 5, 3, 8, 0, 0, 0, time.UTC)
	if IsDueEveryNDays(trig, time.Time{}, now) {
		t.Errorf("should not be due at 8am for never-fired 9am trigger")
	}
	// After 9am: due.
	now = time.Date(2026, 5, 3, 9, 30, 0, 0, time.UTC)
	if !IsDueEveryNDays(trig, time.Time{}, now) {
		t.Errorf("should be due at 9:30am for never-fired 9am trigger")
	}
}

func TestIsDueEveryNDays_AlreadyFired(t *testing.T) {
	trig := newEveryNDays(3, "09:00", "UTC")
	last := time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)
	// 2 days later: not due.
	if IsDueEveryNDays(trig, last, last.Add(48*time.Hour)) {
		t.Errorf("should not be due 2 days after last for cadence=3")
	}
	// 3 days + 1 minute later: due.
	if !IsDueEveryNDays(trig, last, last.Add(72*time.Hour+time.Minute)) {
		t.Errorf("should be due >3 days after last for cadence=3")
	}
}

func TestNextEveryNDaysFire(t *testing.T) {
	trig := newEveryNDays(2, "09:00", "UTC")
	last := time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)
	now := last.Add(time.Hour)
	next, err := NextEveryNDaysFire(trig, last, now)
	if err != nil {
		t.Fatal(err)
	}
	// Should be 2 days later at 9am.
	want := time.Date(2026, 5, 5, 9, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("want %v got %v", want, next)
	}
}

func TestNextEveryNDaysFire_TZAware(t *testing.T) {
	trig := newEveryNDays(1, "09:00", "America/New_York")
	now := time.Date(2026, 5, 3, 5, 0, 0, 0, time.UTC) // 1am NY
	next, err := NextEveryNDaysFire(trig, time.Time{}, now)
	if err != nil {
		t.Fatal(err)
	}
	// Next fire: 9am NY = 13:00 UTC same day.
	want := time.Date(2026, 5, 3, 13, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("want %v got %v", want, next)
	}
}
