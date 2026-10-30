package send_time_opt

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestHourOfWeek(t *testing.T) {
	// 2026-05-03 is a Sunday.
	sunday := time.Date(2026, 5, 3, 0, 0, 0, 0, time.UTC)
	if got := HourOfWeek(sunday); got != 0 {
		t.Fatalf("Sunday 00:00 want 0, got %d", got)
	}
	if got := HourOfWeek(sunday.Add(9 * time.Hour)); got != 9 {
		t.Fatalf("Sunday 09:00 want 9, got %d", got)
	}
	// Monday 00:00 = 24
	if got := HourOfWeek(sunday.Add(24 * time.Hour)); got != 24 {
		t.Fatalf("Monday 00:00 want 24, got %d", got)
	}
	// Saturday 23:00 = 167
	sat := time.Date(2026, 5, 9, 23, 0, 0, 0, time.UTC)
	if got := HourOfWeek(sat); got != 167 {
		t.Fatalf("Saturday 23:00 want 167, got %d", got)
	}
}

func TestMode(t *testing.T) {
	hours := []int{9, 9, 14, 9, 14, 21}
	best, count := Mode(hours)
	if best != 9 || count != 3 {
		t.Fatalf("want (9,3), got (%d,%d)", best, count)
	}
	if h, _ := Mode(nil); h != 0 {
		t.Fatalf("empty input should return 0, got %d", h)
	}
	// Tie should resolve to smaller index.
	tie := []int{14, 14, 9, 9}
	if h, _ := Mode(tie); h != 9 {
		t.Fatalf("tie want 9, got %d", h)
	}
}

func TestNextHourOfWeek_CurrentBucketNeverReturnsPastTime(t *testing.T) {
	now := time.Date(2026, 5, 3, 9, 37, 12, 0, time.UTC)
	got := nextHourOfWeek(now, HourOfWeek(now))
	if !got.Equal(now) {
		t.Fatalf("current bucket = %s, want exact reference %s", got, now)
	}
}

func TestScheduleByBestTime_ExpandsShortWindowInsteadOfSendingImmediately(t *testing.T) {
	now := time.Date(2026, 5, 3, 10, 30, 0, 0, time.UTC)
	nextSundayNine := 9
	result := ScheduleByBestTime(
		now,
		1,
		[]Recipient{{Email: "reader@example.com", BestHour: &nextSundayNine}},
		9,
	)
	if len(result) != 1 {
		t.Fatalf("schedule length = %d, want 1", len(result))
	}
	if !result[0].SendAt.After(now.Add(6 * 24 * time.Hour)) {
		t.Fatalf("short window sent early at %s", result[0].SendAt)
	}
}

func TestScheduleCommitResponseConfirmsPersistenceWithoutRecipientPII(t *testing.T) {
	payload, err := json.Marshal(ScheduleCommitResponse{
		CampaignID:  "00000000-0000-0000-0000-000000000001",
		Scheduled:   42,
		WithinDays:  7,
		TenantMean:  33,
		HardCap:     CampaignRecipientLoadHardCap,
		Strategy:    "per_recipient",
		ReferenceAt: "2026-07-26T10:00:00Z",
		Persisted:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	body := string(payload)
	if !strings.Contains(body, `"persisted":true`) {
		t.Fatalf("response did not confirm persistence: %s", body)
	}
	for _, forbidden := range []string{"email", "first_5", "first_50"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("response leaked %q: %s", forbidden, body)
		}
	}
}

// TestHourOfWeek_DifferentTzSameLocalHour pins the documented
// tz-storage convention from HourOfWeek's doc comment: stored
// hour-of-week values are UTC-bucketed (NOT local-of-recipient), so
// two recipients with the same LOCAL hour-of-week in different
// timezones MUST resolve to different UTC hour-of-week buckets and
// therefore distinct UTC send times when the scheduler fires.
//
// This is the regression-prevention test referenced by
// p0-sto-schedule-strategy. If a refactor ever changes HourOfWeek to
// silently project into a tenant or recipient location, this test
// fails — forcing the author to update callers explicitly via the
// per_recipient_tz.go opt-in path rather than altering the global
// convention.
func TestHourOfWeek_DifferentTzSameLocalHour(t *testing.T) {
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("LoadLocation LA: %v", err)
	}
	berlin, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("LoadLocation Berlin: %v", err)
	}
	// 2026-06-08 is a Monday — outside DST transition weeks for both
	// zones so the offsets are stable.
	laLocal := time.Date(2026, 6, 8, 9, 0, 0, 0, la)         // 09:00 PT  → 16:00 UTC
	berlinLocal := time.Date(2026, 6, 8, 9, 0, 0, 0, berlin) // 09:00 CEST → 07:00 UTC

	laHoW := HourOfWeek(laLocal)
	berlinHoW := HourOfWeek(berlinLocal)
	if laHoW == berlinHoW {
		t.Fatalf("expected distinct UTC hour-of-week buckets for LA-9am "+
			"vs Berlin-9am; both got %d (UTC convention regressed?)", laHoW)
	}
	// Sanity: the actual UTC hours match the expected offsets so the
	// failure mode is obvious in CI output.
	if laHoW%24 != 16 {
		t.Fatalf("LA 09:00 PT should bucket as UTC hour 16; got %d", laHoW%24)
	}
	if berlinHoW%24 != 7 {
		t.Fatalf("Berlin 09:00 CEST should bucket as UTC hour 7; got %d", berlinHoW%24)
	}

	// Project both through nextHourOfWeek using a fixed `now` so the
	// schedule math returns concrete UTC instants and we can assert
	// they differ. now = Sunday 2026-06-07 00:00 UTC = HoW 0.
	now := time.Date(2026, 6, 7, 0, 0, 0, 0, time.UTC)
	laSend := nextHourOfWeek(now, laHoW)
	berlinSend := nextHourOfWeek(now, berlinHoW)
	if laSend.Equal(berlinSend) {
		t.Fatalf("two recipients at same LOCAL hour different tz "+
			"must receive at distinct UTC send times; both got %s",
			laSend.Format(time.RFC3339))
	}
}

func TestScheduleByBestTime_FallsBackToMean(t *testing.T) {
	now := time.Date(2026, 5, 3, 6, 0, 0, 0, time.UTC) // Sunday 06:00 = HoW 6
	hot := 14                                          // Sunday 14:00 = HoW 14
	rs := []Recipient{
		{Email: "warm@x", BestHour: &hot},
		{Email: "cold@x", BestHour: nil},
	}
	out := ScheduleByBestTime(now, 7, rs, 9)
	if len(out) != 2 {
		t.Fatalf("want 2 schedules, got %d", len(out))
	}
	if out[0].BestHourUTC != 14 || out[0].SendAt.Hour() != 14 {
		t.Fatalf("warm row: %+v", out[0])
	}
	// Cold falls back to mean=9 (Sunday 09:00 today, which is after now=06:00).
	if out[1].BestHourUTC != 9 || out[1].SendAt.Hour() != 9 {
		t.Fatalf("cold row: %+v", out[1])
	}
}
