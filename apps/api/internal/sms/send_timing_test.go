// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"testing"
	"time"
)

func TestParseScheduleModeDefaultsAndParsing(t *testing.T) {
	t.Parallel()

	// nil / empty metadata → fixed with sane defaults.
	def := parseScheduleMode(nil)
	if def.Mode != scheduleModeFixed || def.scheduled() {
		t.Fatalf("nil metadata should be fixed/unscheduled, got %+v", def)
	}
	if def.LocalTime != defaultLocalSendTime || def.FallbackTZ != defaultFallbackTZ || def.WithinDays != defaultWithinDays {
		t.Fatalf("unexpected defaults: %+v", def)
	}

	// A fully specified recipient_tz mode.
	tz := parseScheduleMode(map[string]any{
		"schedule_mode": "recipient_tz",
		"local_time":    "10:30",
		"fallback_tz":   "America/New_York",
	})
	if tz.Mode != scheduleModeRecipientTZ || tz.LocalTime != "10:30" || tz.FallbackTZ != "America/New_York" {
		t.Fatalf("recipient_tz parse mismatch: %+v", tz)
	}
	if !tz.scheduled() {
		t.Fatal("recipient_tz should be scheduled")
	}

	// STO with within_days as a JSON number.
	sto := parseScheduleMode(map[string]any{"schedule_mode": "sto", "within_days": float64(14)})
	if sto.Mode != scheduleModeSTO || sto.WithinDays != 14 {
		t.Fatalf("sto parse mismatch: %+v", sto)
	}

	// Malformed values fall back to defaults, never error.
	bad := parseScheduleMode(map[string]any{
		"schedule_mode": "nonsense",
		"local_time":    "99:99",
		"fallback_tz":   "Not/AZone",
		"within_days":   "abc",
	})
	if bad.Mode != scheduleModeFixed || bad.LocalTime != defaultLocalSendTime ||
		bad.FallbackTZ != defaultFallbackTZ || bad.WithinDays != defaultWithinDays {
		t.Fatalf("malformed metadata should default, got %+v", bad)
	}
}

func TestComputeSendAtRecipientTZ(t *testing.T) {
	t.Parallel()

	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	mode := scheduleMode{Mode: scheduleModeRecipientTZ, LocalTime: "09:00", FallbackTZ: defaultFallbackTZ}

	// A moment where 09:00 local is still ahead today (03:00 local) →
	// releases today at 09:00 local.
	now := time.Date(2026, 3, 10, 3, 0, 0, 0, loc).UTC()
	when := computeSendAt(now, mode, "America/Los_Angeles", nil)
	if !when.After(now) {
		t.Fatalf("send time %s should be after now %s", when, now)
	}
	local := when.In(loc)
	if local.Hour() != 9 || local.Minute() != 0 {
		t.Fatalf("expected 09:00 local, got %02d:%02d", local.Hour(), local.Minute())
	}
	if local.Day() != 10 {
		t.Fatalf("expected same-day release (10th), got day %d", local.Day())
	}

	// A moment past 09:00 local (14:00 local) → releases tomorrow 09:00.
	now2 := time.Date(2026, 3, 10, 14, 0, 0, 0, loc).UTC()
	when2 := computeSendAt(now2, mode, "America/Los_Angeles", nil)
	local2 := when2.In(loc)
	if local2.Hour() != 9 || local2.Day() != 11 {
		t.Fatalf("expected next-day 09:00 local, got day %d %02d:00", local2.Day(), local2.Hour())
	}

	// Unknown tz → falls back to FallbackTZ (UTC here), never returns now
	// unless resolution fails.
	whenFallback := computeSendAt(now, mode, "", nil)
	if !whenFallback.After(now) {
		t.Fatalf("fallback tz send time %s should be after now %s", whenFallback, now)
	}
	if whenFallback.Hour() != 9 {
		t.Fatalf("UTC fallback should release at 09:00 UTC, got hour %d", whenFallback.Hour())
	}
}

func TestComputeSendAtSTOAndFixed(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)

	// Fixed mode always returns now (immediate).
	fixed := computeSendAt(now, scheduleMode{Mode: scheduleModeFixed}, "America/New_York", nil)
	if !fixed.Equal(now) {
		t.Fatalf("fixed mode must return now, got %s", fixed)
	}

	// STO with a concrete best hour-of-week releases within the search
	// window and never before now.
	best := 100
	sto := computeSendAt(now, scheduleMode{Mode: scheduleModeSTO, WithinDays: defaultWithinDays}, "", &best)
	if sto.Before(now) {
		t.Fatalf("STO send time %s must not be before now %s", sto, now)
	}
	if sto.After(now.Add(31 * 24 * time.Hour)) {
		t.Fatalf("STO send time %s escaped the search window", sto)
	}

	// STO without a best hour falls back to the tenant mean and still
	// yields a valid future/near instant (not a drop).
	stoFallback := computeSendAt(now, scheduleMode{Mode: scheduleModeSTO, WithinDays: defaultWithinDays}, "", nil)
	if stoFallback.Before(now) {
		t.Fatalf("STO fallback %s must not be before now %s", stoFallback, now)
	}
}
