// SPDX-License-Identifier: AGPL-3.0-only
package send_window

import (
	"testing"
	"time"
)

// The window is evaluated in the TENANT's timezone.
//
// "Nine to five" means nine to five where the audience is. Evaluating in UTC
// would move every window by the offset — invisibly, and differently across a
// daylight-saving change, which is the kind of bug that only appears twice a
// year and is never reproduced on the day it is reported.

func weekdays(days ...time.Weekday) int {
	b := 0
	for _, d := range days {
		b |= 1 << uint(d)
	}
	return b
}

func businessHours(tz string) *Policy {
	return &Policy{
		StartLocal: "09:00", EndLocal: "17:00", Timezone: tz,
		WeekdayBitmap: weekdays(time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday),
		Enforcement:   "block",
	}
}

func TestTheWindowIsJudgedInTheTenantsTimezone(t *testing.T) {
	p := businessHours("America/New_York")
	// 14:00 UTC is 09:00 in New York (EST) — inside.
	inside := time.Date(2026, 1, 6, 14, 0, 0, 0, time.UTC) // a Tuesday
	if ok, why := p.Contains(inside); !ok {
		t.Errorf("09:00 New York was judged outside: %s", why)
	}
	// 03:00 UTC the same day is 22:00 the previous evening in New York.
	outside := time.Date(2026, 1, 6, 3, 0, 0, 0, time.UTC)
	if ok, _ := p.Contains(outside); ok {
		t.Error("22:00 New York was judged inside a 09:00-17:00 window; the " +
			"evaluation is happening in UTC and every window is off by the offset")
	}
}

// The bug that appears twice a year and is never reproduced on the day.
func TestTheWindowSurvivesADaylightSavingChange(t *testing.T) {
	p := businessHours("America/New_York")
	// 14:00 UTC: 09:00 EST in January, but 10:00 EDT in July. Both inside.
	for _, at := range []time.Time{
		time.Date(2026, 1, 6, 14, 0, 0, 0, time.UTC),
		time.Date(2026, 7, 7, 14, 0, 0, 0, time.UTC),
	} {
		if ok, why := p.Contains(at); !ok {
			t.Errorf("%s was judged outside: %s", at, why)
		}
	}
	// 13:00 UTC is 08:00 EST (outside) in January and 09:00 EDT (inside) in
	// July. A UTC evaluation cannot tell these apart.
	if ok, _ := p.Contains(time.Date(2026, 1, 6, 13, 0, 0, 0, time.UTC)); ok {
		t.Error("08:00 EST was judged inside a 09:00 window")
	}
	if ok, why := p.Contains(time.Date(2026, 7, 7, 13, 0, 0, 0, time.UTC)); !ok {
		t.Errorf("09:00 EDT was judged outside: %s", why)
	}
}

// A window that crosses midnight is legitimate for a global audience. Treating
// it as an empty range would refuse everything, and the operator would watch a
// window they configured reject every instant.
func TestAWindowCrossingMidnightIsNotEmpty(t *testing.T) {
	p := &Policy{
		StartLocal: "22:00", EndLocal: "06:00", Timezone: "UTC",
		WeekdayBitmap: 127, Enforcement: "block",
	}
	for _, tc := range []struct {
		hour int
		want bool
	}{
		{23, true}, {2, true}, {5, true},
		{6, false}, {12, false}, {21, false},
	} {
		at := time.Date(2026, 3, 10, tc.hour, 0, 0, 0, time.UTC)
		if ok, _ := p.Contains(at); ok != tc.want {
			t.Errorf("%02d:00 inside = %v, want %v", tc.hour, ok, tc.want)
		}
	}
}

func TestTheSendingDaysAreHonoured(t *testing.T) {
	p := businessHours("UTC")
	saturday := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	if ok, why := p.Contains(saturday); ok {
		t.Errorf("Saturday was judged inside a weekdays-only window (%s)", why)
	}
	if _, why := p.Contains(saturday); why == "" {
		t.Error("no reason given; the operator learns it was refused and not why")
	}
}

// A misconfigured timezone must not silently become UTC — that applies a window
// nobody chose.
func TestAnUnresolvableTimezoneIsNotTreatedAsUTC(t *testing.T) {
	p := businessHours("Not/AZone")
	at := time.Date(2026, 1, 6, 12, 0, 0, 0, time.UTC) // inside if judged as UTC
	if ok, _ := p.Contains(at); ok {
		t.Fatal("an unresolvable timezone was treated as UTC, applying a window " +
			"the operator never configured")
	}
}

// `off` and an absent policy both allow. A tenant with no window has not asked
// for one, and inventing business hours would refuse a 3am send somebody
// deliberately scheduled.
func TestNoPolicyAndOffBothAllow(t *testing.T) {
	if !Allow.Allowed || Allow.Warn {
		t.Fatal("the no-policy decision is not a plain allow")
	}
}
