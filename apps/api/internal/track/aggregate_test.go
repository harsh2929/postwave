// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestUTCDailyWindowStartUsesCalendarDays(t *testing.T) {
	t.Parallel()

	asOf := time.Date(2026, time.July, 24, 23, 59, 58, 0, time.UTC)
	got := utcDailyWindowStart(asOf, 7)
	want := time.Date(2026, time.July, 18, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("utcDailyWindowStart() = %s, want %s", got, want)
	}

	// The request clock is normalized to UTC before its calendar date is
	// selected. This keeps the wire contract independent of server locale.
	ist := time.FixedZone("IST", 5*60*60+30*60)
	asOf = time.Date(2026, time.July, 25, 2, 0, 0, 0, ist)
	got = utcDailyWindowStart(asOf, 1)
	want = time.Date(2026, time.July, 24, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("utcDailyWindowStart() across offset = %s, want %s", got, want)
	}
}

func TestDensifyUTCDailyBucketsEmitsExplicitZeroes(t *testing.T) {
	t.Parallel()

	start := time.Date(2026, time.July, 18, 16, 45, 0, 0, time.FixedZone("offset", 3*60*60))
	got, err := densifyUTCDailyBuckets(start, 7, []TrackDailyBucket{
		{Date: "2026-07-24", Count: 9},
		{Date: "2026-07-18", Count: 5},
		{Date: "2026-07-20", Count: 3},
	})
	if err != nil {
		t.Fatalf("densifyUTCDailyBuckets: %v", err)
	}
	want := []TrackDailyBucket{
		{Date: "2026-07-18", Count: 5},
		{Date: "2026-07-19", Count: 0},
		{Date: "2026-07-20", Count: 3},
		{Date: "2026-07-21", Count: 0},
		{Date: "2026-07-22", Count: 0},
		{Date: "2026-07-23", Count: 0},
		{Date: "2026-07-24", Count: 9},
	}
	if len(got) != len(want) {
		t.Fatalf("bucket count = %d, want %d: %#v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("bucket %d = %#v, want %#v", i, got[i], want[i])
		}
	}
}

func TestDensifyUTCDailyBucketsRejectsDishonestSeries(t *testing.T) {
	t.Parallel()

	start := time.Date(2026, time.July, 18, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		days   int
		sparse []TrackDailyBucket
		err    string
	}{
		{
			name: "zero-day window",
			days: 0,
			err:  "invalid UTC daily window length",
		},
		{
			name: "oversized window",
			days: 366,
			err:  "invalid UTC daily window length",
		},
		{
			name: "date before window",
			days: 7,
			sparse: []TrackDailyBucket{
				{Date: "2026-07-17", Count: 1},
			},
			err: "outside the requested UTC window",
		},
		{
			name: "date after window",
			days: 7,
			sparse: []TrackDailyBucket{
				{Date: "2026-07-25", Count: 1},
			},
			err: "outside the requested UTC window",
		},
		{
			name: "negative aggregate",
			days: 7,
			sparse: []TrackDailyBucket{
				{Date: "2026-07-20", Count: -1},
			},
			err: "negative count",
		},
		{
			name: "duplicate aggregate",
			days: 7,
			sparse: []TrackDailyBucket{
				{Date: "2026-07-20", Count: 1},
				{Date: "2026-07-20", Count: 2},
			},
			err: "duplicated",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := densifyUTCDailyBuckets(start, test.days, test.sparse)
			if err == nil || !strings.Contains(err.Error(), test.err) {
				t.Fatalf("error = %v, want substring %q", err, test.err)
			}
		})
	}
}

func TestEventCatalogResponseDisclosesIndependentSeriesScope(t *testing.T) {
	t.Parallel()

	asOf := time.Date(2026, time.July, 24, 12, 0, 0, 0, time.UTC)
	encoded, err := json.Marshal(EventCatalogResponse{
		Items:                   []CatalogRow{},
		TotalDistinctEventNames: 214,
		PeriodDays:              30,
		DailySeriesPeriodDays:   catalogDailySeriesPeriodDays,
		EventBoundsScope:        "period",
		TimeZone:                trackAggregateTimeZone,
		AsOf:                    asOf,
	})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if payload["periodDays"] != float64(30) {
		t.Fatalf("periodDays = %#v", payload["periodDays"])
	}
	if payload["dailySeriesPeriodDays"] != float64(7) {
		t.Fatalf("dailySeriesPeriodDays = %#v", payload["dailySeriesPeriodDays"])
	}
	if payload["totalDistinctEventNames"] != float64(214) {
		t.Fatalf("totalDistinctEventNames = %#v", payload["totalDistinctEventNames"])
	}
	if payload["eventBoundsScope"] != "period" || payload["timeZone"] != "UTC" {
		t.Fatalf("scope metadata = %#v", payload)
	}
	if payload["asOf"] != "2026-07-24T12:00:00Z" {
		t.Fatalf("asOf = %#v", payload["asOf"])
	}
}
