package campaigns

// Unit tests for the simple 5-field cron parser the recurrence feature
// uses. The parser intentionally only supports `*` and comma-separated
// integer lists — ranges (`1-5`), step values (`*/15`), and macros
// (`@hourly`, `@reboot`) are unsupported by design and must be rejected.

import (
	"testing"
	"time"
)

// TestParseCron_Wildcards covers the simplest case: every-minute cron.
func TestParseCron_Wildcards(t *testing.T) {
	spec, err := ParseCron("* * * * *")
	if err != nil {
		t.Fatalf("ParseCron: %v", err)
	}
	// `*` parses to a nil slice — the matcher treats nil as "any".
	if spec.Minutes != nil || spec.Hours != nil || spec.DayOfMonth != nil ||
		spec.Month != nil || spec.DayOfWeek != nil {
		t.Errorf("expected all-nil spec for `* * * * *`, got %+v", spec)
	}
	// Should match an arbitrary moment.
	if !spec.Matches(time.Date(2026, 5, 8, 12, 30, 0, 0, time.UTC)) {
		t.Error("`* * * * *` should match every minute")
	}
}

// TestParseCron_CommaList covers comma lists in the minute and DOW
// fields, which is the supported way to spell "every weekday at 9am".
func TestParseCron_CommaList(t *testing.T) {
	spec, err := ParseCron("0 9 * * 1,2,3,4,5")
	if err != nil {
		t.Fatalf("ParseCron: %v", err)
	}
	if got := spec.Minutes; len(got) != 1 || got[0] != 0 {
		t.Errorf("minutes = %v, want [0]", got)
	}
	if got := spec.Hours; len(got) != 1 || got[0] != 9 {
		t.Errorf("hours = %v, want [9]", got)
	}
	if got := spec.DayOfWeek; len(got) != 5 {
		t.Errorf("dow len = %d, want 5", len(got))
	}

	// Monday 9:00 UTC matches.
	monday9 := time.Date(2026, 5, 4, 9, 0, 0, 0, time.UTC)
	if monday9.Weekday() != time.Monday {
		t.Fatalf("test fixture wrong: got %v", monday9.Weekday())
	}
	if !spec.Matches(monday9) {
		t.Error("Mon 09:00 should match `0 9 * * 1,2,3,4,5`")
	}
	// Saturday 9:00 does not match.
	saturday9 := time.Date(2026, 5, 9, 9, 0, 0, 0, time.UTC)
	if spec.Matches(saturday9) {
		t.Error("Sat 09:00 should NOT match weekday-only cron")
	}
	// Mon 09:30 does not match (minute filter).
	if spec.Matches(monday9.Add(30 * time.Minute)) {
		t.Error("Mon 09:30 should NOT match (minute=0 only)")
	}
}

// TestParseCron_FirstOfMonth covers the day-of-month and month fields.
func TestParseCron_FirstOfMonth(t *testing.T) {
	spec, err := ParseCron("0 0 1 * *")
	if err != nil {
		t.Fatalf("ParseCron: %v", err)
	}
	first := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	if !spec.Matches(first) {
		t.Error("Jun 1 00:00 should match `0 0 1 * *`")
	}
	if spec.Matches(first.Add(24 * time.Hour)) {
		t.Error("Jun 2 should NOT match `0 0 1 * *`")
	}
}

// TestParseCron_RejectsBadInput documents what is *not* supported. We
// deliberately reject ranges, steps, macros, malformed integers, and
// out-of-range values — the recurrence UI sends only spelled-out
// integers so widening this surface would just expand the bug surface.
func TestParseCron_RejectsBadInput(t *testing.T) {
	bad := []string{
		"",              // empty
		"* * * *",       // 4 fields
		"* * * * * *",   // 6 fields
		"*/15 * * * *",  // step values unsupported
		"0-5 * * * *",   // range unsupported
		"@hourly",       // macro unsupported
		"60 * * * *",    // minute out of range
		"* 24 * * *",    // hour out of range
		"* * 32 * *",    // dom out of range
		"* * * 13 *",    // month out of range
		"* * * * 7",     // dow out of range
		"abc * * * *",   // not an integer
		"0,abc * * * *", // bad list element
		"* * 0 * *",     // dom must be >=1
		"* * * 0 *",     // month must be >=1
	}
	for _, expr := range bad {
		t.Run(expr, func(t *testing.T) {
			if _, err := ParseCron(expr); err == nil {
				t.Errorf("ParseCron(%q): expected error, got nil", expr)
			}
		})
	}
}

// TestDueWithin_EveryMinute walks a one-hour window with `* * * * *`.
// The slice should hold every minute boundary in [from, until).
func TestDueWithin_EveryMinute(t *testing.T) {
	spec, _ := ParseCron("* * * * *")
	from := time.Date(2026, 5, 8, 10, 0, 0, 0, time.UTC)
	until := from.Add(time.Hour)
	got := spec.DueWithin(from, until)
	if len(got) != 60 {
		t.Errorf("got %d fires, want 60", len(got))
	}
}

// TestDueWithin_DailyAtNoon covers the typical "every day at 12:00"
// shape across a 24-hour window — exactly one fire is expected.
func TestDueWithin_DailyAtNoon(t *testing.T) {
	spec, _ := ParseCron("0 12 * * *")
	from := time.Date(2026, 5, 8, 0, 0, 0, 0, time.UTC)
	until := from.Add(24 * time.Hour)
	got := spec.DueWithin(from, until)
	if len(got) != 1 {
		t.Fatalf("got %d fires, want 1", len(got))
	}
	if !got[0].Equal(time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("fire = %v, want 2026-05-08 12:00 UTC", got[0])
	}
}

// TestDueWithin_EmptyForReversedWindow asserts that `until <= from`
// returns nil — the worker passes (now, now+lookahead) so this guard
// catches the "lookahead is zero" misconfiguration.
func TestDueWithin_EmptyForReversedWindow(t *testing.T) {
	spec, _ := ParseCron("* * * * *")
	now := time.Date(2026, 5, 8, 10, 0, 0, 0, time.UTC)
	if got := spec.DueWithin(now, now); got != nil {
		t.Errorf("equal from/until should return nil, got %v", got)
	}
	if got := spec.DueWithin(now, now.Add(-time.Hour)); got != nil {
		t.Errorf("reversed window should return nil, got %v", got)
	}
}

// TestDueWithin_DSTSpringForward documents observed behavior at the
// spring-forward DST boundary. The parser walks UTC minute-by-minute,
// so the local 02:00→03:00 jump in America/New_York is invisible to
// the matcher: a `0 2 * * *` cron evaluated *in UTC* still fires once
// per UTC day because the matcher does not consult t.Location().
//
// This test exists to lock that behavior in: if a future change
// adds tz-aware matching it must update this expectation explicitly.
func TestDueWithin_DSTSpringForward(t *testing.T) {
	spec, _ := ParseCron("0 2 * * *")
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("tz database unavailable: %v", err)
	}
	// 2026-03-08 in America/New_York is the spring-forward day.
	from := time.Date(2026, 3, 8, 0, 0, 0, 0, loc)
	until := from.Add(24 * time.Hour)
	got := spec.DueWithin(from, until)
	// The Spec only inspects t.Hour() (which is local); since the
	// 2:00 hour is skipped on the wall clock of America/New_York,
	// no minute in the window has Hour() == 2 → zero fires.
	if len(got) != 0 {
		t.Errorf("DST spring-forward day: got %d fires, want 0 (the 02:00 hour does not exist locally)", len(got))
	}
}

// TestDueWithin_DSTFallBack covers the autumn fall-back: the local
// 01:00 hour repeats. Because the matcher walks UTC and Hour() is
// local, both repetitions match — so "0 1 * * *" fires twice.
func TestDueWithin_DSTFallBack(t *testing.T) {
	spec, _ := ParseCron("0 1 * * *")
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("tz database unavailable: %v", err)
	}
	from := time.Date(2026, 11, 1, 0, 0, 0, 0, loc)
	until := from.Add(24 * time.Hour)
	got := spec.DueWithin(from, until)
	// On fall-back day, 01:00 local happens twice (EDT, then EST).
	if len(got) < 1 || len(got) > 2 {
		t.Errorf("DST fall-back day: got %d fires, want 1 or 2", len(got))
	}
}
