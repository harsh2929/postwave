package sending

// Pure-time tests for the quiet-hours decision function. The DB-loading
// path is exercised by sendloop_test.go's integration cases.

import (
	"testing"
	"time"
)

func TestDecideAllowed_NoConfig(t *testing.T) {
	// Empty config = always allowed.
	now := time.Date(2026, 5, 8, 14, 0, 0, 0, time.UTC)
	if !decideAllowed(quietConfig{}, false, now) {
		t.Fatal("empty config should be allowed")
	}
}

func TestDecideAllowed_SameDayWindow(t *testing.T) {
	cfg := quietConfig{start: "09:00", end: "17:00", tz: "UTC"}
	cases := []struct {
		hour    int
		minute  int
		allowed bool
		label   string
	}{
		{8, 59, true, "1m before window starts"},
		{9, 0, false, "exactly at start"},
		{12, 30, false, "mid-window"},
		{16, 59, false, "1m before end"},
		{17, 0, true, "exactly at end (exclusive)"},
		{20, 0, true, "well after end"},
	}
	for _, c := range cases {
		now := time.Date(2026, 5, 8, c.hour, c.minute, 0, 0, time.UTC)
		got := decideAllowed(cfg, false, now)
		if got != c.allowed {
			t.Errorf("%s @ %02d:%02d: allowed=%v, want %v", c.label, c.hour, c.minute, got, c.allowed)
		}
	}
}

func TestDecideAllowed_WrapAroundWindow(t *testing.T) {
	// Classic overnight quiet: 22:00 → 08:00 means quiet from 22:00
	// today through 08:00 tomorrow.
	cfg := quietConfig{start: "22:00", end: "08:00", tz: "UTC"}
	cases := []struct {
		hour    int
		minute  int
		allowed bool
		label   string
	}{
		{21, 59, true, "1m before quiet starts"},
		{22, 0, false, "exactly at start"},
		{23, 30, false, "late evening, in quiet"},
		{0, 0, false, "midnight"},
		{4, 0, false, "deep night"},
		{7, 59, false, "1m before quiet ends"},
		{8, 0, true, "exactly at end"},
		{12, 0, true, "midday, well outside"},
	}
	for _, c := range cases {
		now := time.Date(2026, 5, 8, c.hour, c.minute, 0, 0, time.UTC)
		got := decideAllowed(cfg, false, now)
		if got != c.allowed {
			t.Errorf("%s @ %02d:%02d: allowed=%v, want %v", c.label, c.hour, c.minute, got, c.allowed)
		}
	}
}

func TestDecideAllowed_TZHonored(t *testing.T) {
	// Tenant in America/Los_Angeles with a 22:00→08:00 local window.
	// Pacific is UTC-7 in May (PDT).
	cfg := quietConfig{start: "22:00", end: "08:00", tz: "America/Los_Angeles"}

	// 06:00 UTC on 2026-05-08 = 23:00 PDT on 2026-05-07 → INSIDE.
	utcInside := time.Date(2026, 5, 8, 6, 0, 0, 0, time.UTC)
	if decideAllowed(cfg, false, utcInside) {
		t.Errorf("06:00 UTC = 23:00 PDT should be quiet, got allowed")
	}

	// 18:00 UTC = 11:00 PDT → OUTSIDE.
	utcOutside := time.Date(2026, 5, 8, 18, 0, 0, 0, time.UTC)
	if !decideAllowed(cfg, false, utcOutside) {
		t.Errorf("18:00 UTC = 11:00 PDT should be allowed, got quiet")
	}
}

func TestDecideAllowed_DSTSpringForward(t *testing.T) {
	// US DST spring-forward 2026-03-08: 02:00 PST → 03:00 PDT (no 2:30 exists).
	// With a 02:00 → 04:00 quiet window, 03:30 PDT = 02:30 wall-clock-skipped
	// territory; 03:30 PDT IS inside [02:00, 04:00) so quiet.
	cfg := quietConfig{start: "02:00", end: "04:00", tz: "America/Los_Angeles"}

	// 10:30 UTC on 2026-03-08 = 03:30 PDT (post-jump) → inside [02:00, 04:00).
	postJump := time.Date(2026, 3, 8, 10, 30, 0, 0, time.UTC)
	if decideAllowed(cfg, false, postJump) {
		t.Errorf("10:30 UTC on DST start = 03:30 PDT should be quiet")
	}

	// 12:30 UTC on 2026-03-08 = 05:30 PDT → outside.
	afterWindow := time.Date(2026, 3, 8, 12, 30, 0, 0, time.UTC)
	if !decideAllowed(cfg, false, afterWindow) {
		t.Errorf("12:30 UTC = 05:30 PDT should be allowed")
	}
}

func TestDecideAllowed_DSTFallBack(t *testing.T) {
	// US DST fall-back 2026-11-01: 02:00 PDT → 01:00 PST (01:30 happens twice).
	// Window 23:00 → 02:00 means quiet from 23:00 through (the second) 02:00.
	cfg := quietConfig{start: "23:00", end: "02:00", tz: "America/Los_Angeles"}

	// 09:30 UTC = 01:30 PST (after fall-back) → inside 23:00→02:00.
	afterFallback := time.Date(2026, 11, 1, 9, 30, 0, 0, time.UTC)
	if decideAllowed(cfg, false, afterFallback) {
		t.Errorf("09:30 UTC = 01:30 PST (post-fallback) should be quiet")
	}

	// 18:00 UTC = 10:00 PST → outside.
	day := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	if !decideAllowed(cfg, false, day) {
		t.Errorf("18:00 UTC on fall-back day = 10:00 PST should be allowed")
	}
}

func TestDecideAllowed_WeekendQuiet(t *testing.T) {
	// No hourly window, but weekend_quiet=true.
	cfg := quietConfig{tz: "UTC"}

	// 2026-05-08 is a Friday → weekday → allowed.
	fri := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	if !decideAllowed(cfg, true, fri) {
		t.Errorf("Friday should be allowed even with weekend_quiet")
	}

	// 2026-05-09 is Saturday → blocked.
	sat := time.Date(2026, 5, 9, 12, 0, 0, 0, time.UTC)
	if decideAllowed(cfg, true, sat) {
		t.Errorf("Saturday with weekend_quiet should be blocked")
	}

	// 2026-05-10 is Sunday → blocked.
	sun := time.Date(2026, 5, 10, 12, 0, 0, 0, time.UTC)
	if decideAllowed(cfg, true, sun) {
		t.Errorf("Sunday with weekend_quiet should be blocked")
	}

	// Sunday with weekend_quiet=false → allowed (no hourly window).
	if !decideAllowed(cfg, false, sun) {
		t.Errorf("Sunday without weekend_quiet should be allowed when no hourly window")
	}
}

func TestDecideAllowed_BadTZDefaultsUTC(t *testing.T) {
	// Bad TZ string → fallback to UTC, window still applies.
	cfg := quietConfig{start: "09:00", end: "17:00", tz: "Not/A/Real/Zone"}

	noon := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	if decideAllowed(cfg, false, noon) {
		t.Errorf("noon UTC inside 09:00-17:00 UTC should be quiet")
	}
	earlyMorning := time.Date(2026, 5, 8, 5, 0, 0, 0, time.UTC)
	if !decideAllowed(cfg, false, earlyMorning) {
		t.Errorf("05:00 UTC outside 09:00-17:00 UTC should be allowed")
	}
}

func TestParseHHMM(t *testing.T) {
	good := map[string]int{
		"00:00":   0,
		"09:00":   540,
		"23:59":   23*60 + 59,
		" 12:30 ": 12*60 + 30, // tolerates whitespace
	}
	for in, want := range good {
		got, ok := parseHHMM(in)
		if !ok || got != want {
			t.Errorf("parseHHMM(%q) = %d, %v; want %d, true", in, got, ok, want)
		}
	}
	// Sscanf is intentionally lenient about leading zeros (matches the
	// existing validateHHMM in sendingsettings); "9:0" is treated as
	// 09:00 and is acceptable.
	bad := []string{"", "9", "24:00", "12:60", "abc", "12:xx"}
	for _, in := range bad {
		if _, ok := parseHHMM(in); ok {
			t.Errorf("parseHHMM(%q) unexpectedly ok", in)
		}
	}
}
