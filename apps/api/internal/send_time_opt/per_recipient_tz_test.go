// SPDX-License-Identifier: AGPL-3.0-only
//
// per_recipient_tz_test.go — covers sto-per-recipient-timezone.
// Verifies that (a) HourOfWeekIn returns the LOCAL hour-of-week, not
// the UTC one (the regression the audit called out), (b) the
// localized scheduler emits send_at-UTC values that arrive at the
// recipient's local hour, (c) quiet-hours composition runs in the
// recipient's local tz, and (d) SummarizeByTimezone groups output
// deterministically.

package send_time_opt

import (
	"testing"
	"time"
)

func mustLoc(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("LoadLocation(%q): %v", name, err)
	}
	return loc
}

func TestHourOfWeekIn_LocalVsUTC(t *testing.T) {
	la := mustLoc(t, "America/Los_Angeles")
	berlin := mustLoc(t, "Europe/Berlin")

	// 2026-06-02 (Tuesday) 17:00 UTC. That's 10:00 in LA (DST: PDT,
	// UTC-7) and 19:00 in Berlin (CEST, UTC+2).
	moment := time.Date(2026, 6, 2, 17, 0, 0, 0, time.UTC)

	// UTC bucketing: Tuesday * 24 + 17 = 65.
	if got := HourOfWeek(moment); got != 2*24+17 {
		t.Fatalf("UTC HourOfWeek want %d, got %d", 2*24+17, got)
	}
	// LA: Tuesday 10:00 → 2*24 + 10 = 58.
	if got := HourOfWeekIn(moment, la); got != 2*24+10 {
		t.Fatalf("LA HourOfWeekIn want %d, got %d", 2*24+10, got)
	}
	// Berlin: Tuesday 19:00 → 2*24 + 19 = 67.
	if got := HourOfWeekIn(moment, berlin); got != 2*24+19 {
		t.Fatalf("Berlin HourOfWeekIn want %d, got %d", 2*24+19, got)
	}
	// Nil location falls through to HourOfWeek (UTC).
	if got := HourOfWeekIn(moment, nil); got != HourOfWeek(moment) {
		t.Fatalf("nil loc should match UTC: want %d, got %d", HourOfWeek(moment), got)
	}
}

func TestScheduleByBestTimeLocalized_TwoRecipientsSameLocalHour(t *testing.T) {
	// Audit regression: an LA subscriber and a Berlin subscriber who
	// both want "Tuesday 9am LOCAL" should be scheduled at DIFFERENT
	// UTC instants (LA is 7 hours behind Berlin in DST).
	la := mustLoc(t, "America/Los_Angeles")
	berlin := mustLoc(t, "Europe/Berlin")

	// best_hour in LOCAL terms: Tuesday 9am → 2*24 + 9 = 57.
	tueNine := 2*24 + 9

	// now: Sunday 00:00 UTC so both Tuesday-9am-local moments are in
	// the future regardless of tz.
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)

	rs := []LocalRecipient{
		{Email: "la@x", BestHour: &tueNine, Location: la},
		{Email: "berlin@x", BestHour: &tueNine, Location: berlin},
	}
	out := ScheduleByBestTimeLocalized(now, 7, rs, 9, time.UTC, QuietHoursWindow{})
	if len(out) != 2 {
		t.Fatalf("want 2 schedules, got %d", len(out))
	}

	// LA recipient: SendAtUTC should be 2026-06-02 16:00 UTC (9am
	// PT during DST). Verify hour-of-day in local tz is 9.
	if out[0].SendAtLocal.Hour() != 9 {
		t.Fatalf("LA recipient local hour want 9, got %d (%s)",
			out[0].SendAtLocal.Hour(), out[0].SendAtLocal)
	}
	if out[0].SendAtLocal.Weekday() != time.Tuesday {
		t.Fatalf("LA recipient weekday want Tuesday, got %s", out[0].SendAtLocal.Weekday())
	}
	if out[0].Timezone != "America/Los_Angeles" {
		t.Fatalf("LA recipient tz want America/Los_Angeles, got %s", out[0].Timezone)
	}

	// Berlin recipient: local hour 9 on Tuesday.
	if out[1].SendAtLocal.Hour() != 9 {
		t.Fatalf("Berlin recipient local hour want 9, got %d (%s)",
			out[1].SendAtLocal.Hour(), out[1].SendAtLocal)
	}
	if out[1].SendAtLocal.Weekday() != time.Tuesday {
		t.Fatalf("Berlin recipient weekday want Tuesday, got %s", out[1].SendAtLocal.Weekday())
	}

	// UTC instants MUST differ — LA is UTC-7 and Berlin is UTC+2
	// on this date, so 9am local differs by 9 hours.
	gap := out[0].SendAtUTC.Sub(out[1].SendAtUTC)
	if gap != 9*time.Hour {
		t.Fatalf("LA-vs-Berlin UTC gap want 9h, got %v (LA=%s Berlin=%s)",
			gap, out[0].SendAtUTC, out[1].SendAtUTC)
	}
}

func TestScheduleByBestTimeLocalized_ColdRecipientUsesTenantMeanInLocalTZ(t *testing.T) {
	la := mustLoc(t, "America/Los_Angeles")
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC) // Sun 00:00 UTC

	rs := []LocalRecipient{
		// Cold recipient — no BestHour. Tenant mean is 9 (Sun 09:00
		// LOCAL → Sun 09:00 LA = 16:00 UTC).
		{Email: "cold@la", BestHour: nil, Location: la},
	}
	out := ScheduleByBestTimeLocalized(now, 7, rs, 9, time.UTC, QuietHoursWindow{})
	if len(out) != 1 {
		t.Fatalf("want 1 schedule, got %d", len(out))
	}
	if out[0].SendAtLocal.Hour() != 9 {
		t.Fatalf("cold recipient local hour want 9, got %d", out[0].SendAtLocal.Hour())
	}
	if out[0].BestHour != 9 {
		t.Fatalf("cold recipient best-hour want 9 (tenant mean), got %d", out[0].BestHour)
	}
}

func TestScheduleByBestTimeLocalized_FallbackLocationForNilLoc(t *testing.T) {
	berlin := mustLoc(t, "Europe/Berlin")
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)

	nineMon := 1*24 + 9 // Monday 9am local.
	rs := []LocalRecipient{
		{Email: "no-tz@x", BestHour: &nineMon, Location: nil},
	}
	out := ScheduleByBestTimeLocalized(now, 7, rs, 12, berlin, QuietHoursWindow{})
	if out[0].Timezone != "Europe/Berlin" {
		t.Fatalf("nil loc should fall back to Berlin, got %s", out[0].Timezone)
	}
	if out[0].SendAtLocal.Hour() != 9 || out[0].SendAtLocal.Weekday() != time.Monday {
		t.Fatalf("nil-loc fallback want Mon 09:00 Berlin, got %s", out[0].SendAtLocal)
	}
}

func TestScheduleByBestTimeLocalized_QuietHoursInLocalTZ_SnapsForward(t *testing.T) {
	// Tenant configures a 22-6 quiet window with snap policy. An LA
	// recipient whose best hour is Tuesday 03:00 LOCAL should snap
	// forward to 06:00 LOCAL (Tuesday 06:00 LA = 13:00 UTC), NOT
	// snap relative to the UTC interpretation (where Tue 03:00 LA =
	// Tue 10:00 UTC, which would not be in a 22-6 UTC window).
	la := mustLoc(t, "America/Los_Angeles")
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)
	tueThree := 2*24 + 3 // Tuesday 03:00 local
	qh := QuietHoursWindow{
		Enabled:   true,
		StartHour: 22,
		EndHour:   6,
		Policy:    QuietHoursPolicySnap,
	}
	rs := []LocalRecipient{{Email: "early@la", BestHour: &tueThree, Location: la}}
	out := ScheduleByBestTimeLocalized(now, 7, rs, 9, time.UTC, qh)
	if len(out) != 1 {
		t.Fatalf("want 1 schedule, got %d", len(out))
	}
	if out[0].Skipped {
		t.Fatalf("snap policy should not skip")
	}
	// nearest edge to 03:00 is 06:00 forward (3h) vs 22:00 backward
	// (5h). Snap forward to 06:00 local.
	if out[0].SendAtLocal.Hour() != 6 {
		t.Fatalf("snap want local hour 6, got %d (%s)", out[0].SendAtLocal.Hour(), out[0].SendAtLocal)
	}
}

func TestScheduleByBestTimeLocalized_QuietHoursSkipDropsRecipient(t *testing.T) {
	berlin := mustLoc(t, "Europe/Berlin")
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)
	tueTwo := 2*24 + 2 // Tuesday 02:00 local — inside 22-6 quiet.
	qh := QuietHoursWindow{
		Enabled:   true,
		StartHour: 22,
		EndHour:   6,
		Policy:    QuietHoursPolicySkip,
	}
	rs := []LocalRecipient{{Email: "nightowl@berlin", BestHour: &tueTwo, Location: berlin}}
	out := ScheduleByBestTimeLocalized(now, 7, rs, 9, time.UTC, qh)
	if !out[0].Skipped {
		t.Fatalf("skip policy should mark recipient Skipped=true")
	}
}

func TestScheduleByBestTimeLocalized_PerRecipientQuietHoursOverride(t *testing.T) {
	// A recipient with their own QuietHours override should ignore
	// the tenant-level window.
	la := mustLoc(t, "America/Los_Angeles")
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)
	tueThree := 2*24 + 3 // would be quiet under tenant 22-6
	tenantQH := QuietHoursWindow{Enabled: true, StartHour: 22, EndHour: 6, Policy: QuietHoursPolicySnap}
	// Per-recipient override: NO quiet hours.
	perRecipQH := QuietHoursWindow{Enabled: false}
	rs := []LocalRecipient{
		{Email: "opted-in@la", BestHour: &tueThree, Location: la, QuietHours: &perRecipQH},
	}
	out := ScheduleByBestTimeLocalized(now, 7, rs, 9, time.UTC, tenantQH)
	if out[0].SendAtLocal.Hour() != 3 {
		t.Fatalf("per-recipient override should keep 03:00 local, got %d", out[0].SendAtLocal.Hour())
	}
}

func TestSummarizeByTimezone_SortsByCountThenName(t *testing.T) {
	sched := []LocalSchedule{
		{Email: "a", Timezone: "America/Los_Angeles"},
		{Email: "b", Timezone: "America/Los_Angeles"},
		{Email: "c", Timezone: "America/Los_Angeles"},
		{Email: "d", Timezone: "Europe/Berlin"},
		{Email: "e", Timezone: "Europe/Berlin", Skipped: true},
		{Email: "f", Timezone: "Asia/Tokyo"},
		{Email: "g", Timezone: "Asia/Tokyo"},
		{Email: "h", Timezone: "Asia/Tokyo"},
	}
	got := SummarizeByTimezone(sched)
	if len(got) != 3 {
		t.Fatalf("want 3 buckets, got %d", len(got))
	}
	// Top: Tokyo and LA both 3; alphabetical → Tokyo? "America/Los_Angeles" < "Asia/Tokyo"
	// so LA comes first on tie.
	if got[0].Timezone != "America/Los_Angeles" || got[0].Subscribers != 3 {
		t.Fatalf("top want LA/3, got %+v", got[0])
	}
	if got[1].Timezone != "Asia/Tokyo" || got[1].Subscribers != 3 {
		t.Fatalf("second want Tokyo/3, got %+v", got[1])
	}
	// Berlin has 1 not-skipped + 1 skipped.
	if got[2].Timezone != "Europe/Berlin" || got[2].Subscribers != 1 || got[2].Skipped != 1 {
		t.Fatalf("third want Berlin/1/skip=1, got %+v", got[2])
	}
}

func TestSummarizeByTimezone_Empty(t *testing.T) {
	if got := SummarizeByTimezone(nil); len(got) != 0 {
		t.Fatalf("nil input should return empty, got %d", len(got))
	}
}

func TestMustLoadLocation_FallbackOnError(t *testing.T) {
	if loc := MustLoadLocation(""); loc != time.UTC {
		t.Fatalf("empty string should fall back to UTC, got %s", loc)
	}
	if loc := MustLoadLocation("Not/A/Real/Zone"); loc != time.UTC {
		t.Fatalf("invalid tz should fall back to UTC, got %s", loc)
	}
	loc := MustLoadLocation("America/Los_Angeles")
	if loc == nil || loc.String() != "America/Los_Angeles" {
		t.Fatalf("valid tz should parse, got %v", loc)
	}
}

func TestScheduleByBestTimeLocalized_WithinDaysClamps(t *testing.T) {
	la := mustLoc(t, "America/Los_Angeles")
	now := time.Date(2026, 5, 31, 0, 0, 0, 0, time.UTC)
	// Saturday 23:00 local → very far in the future relative to
	// withinDays=1; should clamp back to `now` in LA.
	satLate := 6*24 + 23
	rs := []LocalRecipient{{Email: "x", BestHour: &satLate, Location: la}}
	out := ScheduleByBestTimeLocalized(now, 1, rs, 9, time.UTC, QuietHoursWindow{})
	// Either the natural moment is within the day (acceptable) or
	// the clamp fired (SendAtLocal close to now).
	delta := out[0].SendAtUTC.Sub(now)
	if delta < 0 || delta > 24*time.Hour {
		t.Fatalf("within-days clamp failed: delta=%v", delta)
	}
}
