// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"testing"
	"time"
)

func mustLoad(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	return loc
}

// fullWeek is the only day set that can satisfy the floor. Spelled out rather
// than generated so a test reading 0..6 cannot quietly become 0..5.
var fullWeek = []int{0, 1, 2, 3, 4, 5, 6}

func conformingRule() QuietHoursRule {
	return QuietHoursRule{
		Enabled:     true,
		StartMinute: 21 * 60,
		EndMinute:   8 * 60,
		Days:        fullWeek,
		Timezone:    "America/New_York",
	}
}

// --- Tier 1: the recipient's own local time -------------------------------

func TestStatutoryWindowBoundariesAreTheStatutesBoundaries(t *testing.T) {
	ny := mustLoad(t, "America/New_York")
	// A Wednesday in June: EDT throughout, so these are unambiguous wall times.
	day := func(hour, min int) time.Time {
		return time.Date(2026, time.June, 10, hour, min, 0, 0, ny)
	}
	cases := []struct {
		name       string
		now        time.Time
		wantActive bool
	}{
		{"08:00 is the first permitted minute", day(8, 0), false},
		{"07:59 is still inside the window", day(7, 59), true},
		{"midday is permitted", day(12, 0), false},
		{"20:59 is the last permitted minute", day(20, 59), false},
		{"21:00 is the first prohibited minute", day(21, 0), true},
		{"23:30 is prohibited", day(23, 30), true},
		{"00:30 is prohibited", day(0, 30), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			active, _ := StatutoryWindowActive(tc.now, ny)
			if active != tc.wantActive {
				t.Fatalf("at %s: active=%v, want %v", tc.now.Format("15:04"), active, tc.wantActive)
			}
		})
	}
}

func TestWindowEndsAtTheNextEightAMLocal(t *testing.T) {
	ny := mustLoad(t, "America/New_York")
	// 22:00 Wednesday → releases 08:00 Thursday.
	active, until := StatutoryWindowActive(time.Date(2026, time.June, 10, 22, 0, 0, 0, ny), ny)
	if !active {
		t.Fatal("22:00 must be inside the window")
	}
	got := until.In(ny)
	if got.Day() != 11 || got.Hour() != 8 || got.Minute() != 0 {
		t.Fatalf("release at %s, want 2026-06-11 08:00 local", got.Format(time.RFC3339))
	}

	// 03:00 Thursday → releases 08:00 the SAME day, not the next one. Getting
	// this wrong holds every overnight-queued message an extra 24 hours, which
	// looks like a delivery outage rather than a compliance bug.
	active, until = StatutoryWindowActive(time.Date(2026, time.June, 11, 3, 0, 0, 0, ny), ny)
	if !active {
		t.Fatal("03:00 must be inside the window")
	}
	got = until.In(ny)
	if got.Day() != 11 || got.Hour() != 8 {
		t.Fatalf("release at %s, want 2026-06-11 08:00 local", got.Format(time.RFC3339))
	}
}

func TestWindowEndSurvivesASpringForward(t *testing.T) {
	// The bug this pins: computing the release as now+9h. On the night the
	// clocks go forward the window is only eight absolute hours long, so
	// arithmetic releases the send at 09:00 local; on the night they go back it
	// is ten, and arithmetic releases at 07:00 local — an hour inside the
	// prohibited window, which is the violation itself.
	ny := mustLoad(t, "America/New_York")

	// US DST begins 2026-03-08: 02:00 EST becomes 03:00 EDT.
	active, until := StatutoryWindowActive(time.Date(2026, time.March, 7, 23, 0, 0, 0, ny), ny)
	if !active {
		t.Fatal("23:00 must be inside the window")
	}
	local := until.In(ny)
	if local.Hour() != 8 || local.Day() != 8 {
		t.Fatalf("spring-forward release at %s local, want 08:00 on the 8th", local.Format(time.RFC3339))
	}
	if elapsed := until.Sub(time.Date(2026, time.March, 7, 23, 0, 0, 0, ny)); elapsed != 8*time.Hour {
		t.Fatalf("spring-forward window lasted %v of absolute time, want 8h", elapsed)
	}

	// US DST ends 2026-11-01: 02:00 EDT becomes 01:00 EST, so the same wall
	// window is ten absolute hours.
	_, until = StatutoryWindowActive(time.Date(2026, time.October, 31, 23, 0, 0, 0, ny), ny)
	local = until.In(ny)
	if local.Hour() != 8 || local.Day() != 1 {
		t.Fatalf("fall-back release at %s local, want 08:00 on the 1st", local.Format(time.RFC3339))
	}
	if elapsed := until.Sub(time.Date(2026, time.October, 31, 23, 0, 0, 0, ny)); elapsed != 10*time.Hour {
		t.Fatalf("fall-back window lasted %v of absolute time, want 10h", elapsed)
	}
}

func TestTheFloorUsesTheRecipientsZoneNotTheServersOrTheTenants(t *testing.T) {
	// 2026-06-10 23:30 in New York is 20:30 in Los Angeles. The same instant is
	// prohibited for one recipient and permitted for the other, which is the
	// entire content of "local time at the called party's location".
	instant := time.Date(2026, time.June, 10, 23, 30, 0, 0, mustLoad(t, "America/New_York"))

	blocked := EvaluateStatutoryFloor(instant, "America/New_York", nil)
	if !blocked.Blocked || blocked.Reason != FloorReasonQuietHours {
		t.Fatalf("New York recipient: %+v, want blocked on quiet hours", blocked)
	}
	if blocked.Tier != "recipient_timezone" {
		t.Fatalf("tier = %q, want recipient_timezone", blocked.Tier)
	}

	allowed := EvaluateStatutoryFloor(instant, "America/Los_Angeles", nil)
	if allowed.Blocked {
		t.Fatalf("Los Angeles recipient at 20:30 local: %+v, want allowed", allowed)
	}
}

func TestKnownRecipientZoneIsNotSecondGuessedByTenantConfiguration(t *testing.T) {
	// A tenant with no window at all must not make a permitted send fail, and a
	// tenant with a window must not make a prohibited one pass. Tier 1 is the
	// evidence; the tenant's settings page is not.
	ny := mustLoad(t, "America/New_York")
	noon := time.Date(2026, time.June, 10, 12, 0, 0, 0, ny)
	if got := EvaluateStatutoryFloor(noon, "America/New_York", nil); got.Blocked {
		t.Fatalf("noon with no tenant rules: %+v, want allowed", got)
	}
	night := time.Date(2026, time.June, 10, 23, 0, 0, 0, ny)
	if got := EvaluateStatutoryFloor(night, "America/New_York", []QuietHoursRule{conformingRule()}); !got.Blocked {
		t.Fatalf("23:00 with a conforming tenant rule: %+v, want blocked", got)
	}
}

// --- Tier 2: no recipient evidence ----------------------------------------

func TestUnknownRecipientZoneWithNoTenantWindowBlocks(t *testing.T) {
	// This is the hole the floor exists to close. Before it, a tenant that
	// never opened the quiet-hours settings page had no quiet hours at all.
	got := EvaluateStatutoryFloor(time.Now(), "", nil)
	if !got.Blocked {
		t.Fatal("no recipient timezone and no tenant window must block")
	}
	if got.Reason != FloorReasonUnprovable {
		t.Fatalf("reason = %q, want %q", got.Reason, FloorReasonUnprovable)
	}
	if !got.Until.IsZero() {
		t.Fatalf("Until = %v; an unprovable block is a configuration state, not "+
			"a time of day, and the queue must not defer on it", got.Until)
	}
}

func TestUnknownRecipientZoneAcceptsAConformingTenantWindow(t *testing.T) {
	got := EvaluateStatutoryFloor(time.Now(), "", []QuietHoursRule{conformingRule()})
	if got.Blocked {
		t.Fatalf("a window covering 21:00-08:00 every day satisfies the floor: %+v", got)
	}
	if got.Tier != "tenant_window" {
		t.Fatalf("tier = %q, want tenant_window", got.Tier)
	}
}

func TestOnlyAWindowAtLeastAsRestrictiveAsTheStatuteCounts(t *testing.T) {
	narrower := conformingRule()
	narrower.StartMinute = 20 * 60 // opens earlier
	narrower.EndMinute = 9 * 60    // closes later

	allDay := conformingRule()
	allDay.StartMinute = 0
	allDay.EndMinute = 0 // start == end means the whole day, per migration 0369

	weekdaysOnly := conformingRule()
	weekdaysOnly.Days = []int{1, 2, 3, 4, 5}

	tooLate := conformingRule()
	tooLate.StartMinute = 22 * 60 // 21:00-22:00 would still send

	tooEarly := conformingRule()
	tooEarly.EndMinute = 7 * 60 // 07:00-08:00 would still send

	sameDay := conformingRule()
	sameDay.StartMinute = 9 * 60
	sameDay.EndMinute = 17 * 60 // a daytime window cannot contain an overnight one

	disabled := conformingRule()
	disabled.Enabled = false

	badZone := conformingRule()
	badZone.Timezone = "Mars/Olympus_Mons"

	countryScoped := conformingRule()
	countryScoped.CountryCode = "US"

	duplicateDays := conformingRule()
	duplicateDays.Days = []int{0, 0, 1, 2, 3, 4, 5} // seven entries, six distinct

	redundantFullWeek := conformingRule()
	redundantFullWeek.Days = []int{0, 1, 2, 3, 4, 5, 6, 6} // eight entries, all seven days

	cases := []struct {
		name string
		rule QuietHoursRule
		want bool
	}{
		{"exactly the statutory window", conformingRule(), true},
		{"strictly narrower is fine", narrower, true},
		{"an all-day window covers it", allDay, true},
		{"weekdays only leaves the weekend open", weekdaysOnly, false},
		{"opening at 22:00 leaves an hour open", tooLate, false},
		{"closing at 07:00 leaves an hour open", tooEarly, false},
		{"a daytime window is not an overnight one", sameDay, false},
		{"a disabled rule protects nobody", disabled, false},
		{"an unloadable timezone cannot be evaluated", badZone, false},
		{"country scoping is unsupported, so it cannot satisfy the floor", countryScoped, false},
		{"seven entries with a duplicate is not seven days", duplicateDays, false},
		{"all seven days plus a duplicate still covers the week", redundantFullWeek, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RuleCoversStatutoryFloor(tc.rule); got != tc.want {
				t.Fatalf("RuleCoversStatutoryFloor = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestOneConformingRuleAmongNonConformingOnesSatisfiesTheFloor(t *testing.T) {
	weekdays := conformingRule()
	weekdays.Days = []int{1, 2, 3, 4, 5}
	rules := []QuietHoursRule{weekdays, conformingRule()}
	if got := EvaluateStatutoryFloor(time.Now(), "", rules); got.Blocked {
		t.Fatalf("%+v: a conforming rule anywhere in the set satisfies the floor", got)
	}
}

// --- Resolver -------------------------------------------------------------

func TestRecipientLocationNeverFallsBackToUTC(t *testing.T) {
	// A UTC fallback would make an unknown recipient look like a London one and
	// let Tier 1 answer confidently with no evidence, which is the exact
	// mistake the two-tier design exists to prevent.
	for _, in := range []string{"", "   ", "Mars/Olympus_Mons", "EST5EDT-nonsense"} {
		if loc, ok := RecipientLocation(in); ok {
			t.Fatalf("RecipientLocation(%q) = %v, true; want not-ok", in, loc)
		}
	}
	if _, ok := RecipientLocation("  America/Chicago  "); !ok {
		t.Fatal("a padded but valid zone must resolve")
	}
}

// --- Gate integration -----------------------------------------------------

func TestGateReportsTheStatuteRatherThanTheSettingsPage(t *testing.T) {
	// When both the statutory floor and the tenant's own window apply, the
	// recorded reason must be the statute. A blocked send audited as
	// "quiet_hours" reads as a tenant preference somebody could have turned
	// off, and that is the wrong story to tell a regulator.
	until := time.Now().Add(2 * time.Hour)
	decision := EvaluateGate(GateSnapshot{
		RegistrationStatus: RegistrationApproved,
		SubscriptionStatus: SubscriptionOptedIn,
		QuietHours:         true,
		StatutoryFloor: StatutoryFloor{
			Blocked: true,
			Reason:  FloorReasonQuietHours,
			Until:   until,
		},
		TenantLimitRemaining: 10,
		Body:                 "hello",
	})
	if decision.Allowed {
		t.Fatal("must be blocked")
	}
	if decision.Reason != string(FloorReasonQuietHours) {
		t.Fatalf("reason = %q, want %q", decision.Reason, FloorReasonQuietHours)
	}
	if decision.HoldUntil == nil || !decision.HoldUntil.Equal(until) {
		t.Fatalf("HoldUntil = %v, want %v so the queue defers rather than drops", decision.HoldUntil, until)
	}
}

func TestGateDoesNotDeferOnAnUnprovableFloor(t *testing.T) {
	// Deferring would park the message forever behind a condition no clock
	// changes. It has to surface to the operator as a configuration failure.
	decision := EvaluateGate(GateSnapshot{
		RegistrationStatus:   RegistrationApproved,
		SubscriptionStatus:   SubscriptionOptedIn,
		StatutoryFloor:       StatutoryFloor{Blocked: true, Reason: FloorReasonUnprovable},
		TenantLimitRemaining: 10,
		Body:                 "hello",
	})
	if decision.Allowed {
		t.Fatal("must be blocked")
	}
	if decision.Reason != string(FloorReasonUnprovable) {
		t.Fatalf("reason = %q, want %q", decision.Reason, FloorReasonUnprovable)
	}
	if decision.HoldUntil != nil {
		t.Fatalf("HoldUntil = %v, want nil", decision.HoldUntil)
	}
}

func TestSuppressionAuthorityPrecedesAnUnprovableStatutoryDiagnostic(t *testing.T) {
	decision := EvaluateGate(GateSnapshot{
		RegistrationStatus:   RegistrationApproved,
		SubscriptionStatus:   SubscriptionOptedIn,
		Suppressed:           true,
		StatutoryFloor:       StatutoryFloor{Blocked: true, Reason: FloorReasonUnprovable},
		TenantLimitRemaining: 10,
		Body:                 "hello",
	})
	if decision.Allowed || decision.Reason != "recipient_suppressed" {
		t.Fatalf("decision = %+v, want immutable recipient suppression authority", decision)
	}
	if decision.HoldUntil != nil {
		t.Fatalf("HoldUntil = %v, want terminal suppression", decision.HoldUntil)
	}
}

func TestAPermittedFloorDoesNotUnblockTheOtherGates(t *testing.T) {
	// The floor only ever adds a reason to block. A green floor must not make a
	// suppressed or unconsented recipient sendable.
	for _, tc := range []struct {
		name string
		snap GateSnapshot
		want string
	}{
		{
			"suppressed",
			GateSnapshot{RegistrationStatus: RegistrationApproved, SubscriptionStatus: SubscriptionOptedIn, Suppressed: true, TenantLimitRemaining: 5, Body: "hi"},
			"recipient_suppressed",
		},
		{
			"no consent",
			GateSnapshot{RegistrationStatus: RegistrationApproved, SubscriptionStatus: SubscriptionPending, TenantLimitRemaining: 5, Body: "hi"},
			"sms_consent_required",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.snap.StatutoryFloor = StatutoryFloor{Tier: "recipient_timezone"}
			got := EvaluateGate(tc.snap)
			if got.Allowed || got.Reason != tc.want {
				t.Fatalf("decision = %+v, want blocked on %q", got, tc.want)
			}
		})
	}
}
