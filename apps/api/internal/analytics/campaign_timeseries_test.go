// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"testing"
	"time"
)

func hr(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t.UTC()
}

func TestZeroFillHourly(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		if got := zeroFillHourly(nil); len(got) != 0 {
			t.Fatalf("expected empty, got %d", len(got))
		}
	})

	t.Run("fills gaps between first and last", func(t *testing.T) {
		observed := []HourBucket{
			{Hour: hr("2026-06-01T00:00:00Z"), Opens: 5, Clicks: 1},
			// 01:00 and 02:00 missing
			{Hour: hr("2026-06-01T03:00:00Z"), Opens: 2, Unsubs: 1},
		}
		got := zeroFillHourly(observed)
		if len(got) != 4 {
			t.Fatalf("expected 4 contiguous hours, got %d", len(got))
		}
		if got[0].Opens != 5 || got[0].Clicks != 1 {
			t.Errorf("first hour wrong: %+v", got[0])
		}
		if got[1].Opens != 0 || got[1].Clicks != 0 || got[1].Unsubs != 0 {
			t.Errorf("gap hour should be zero: %+v", got[1])
		}
		if !got[1].Hour.Equal(hr("2026-06-01T01:00:00Z")) {
			t.Errorf("gap hour timestamp wrong: %v", got[1].Hour)
		}
		if got[3].Opens != 2 || got[3].Unsubs != 1 {
			t.Errorf("last hour wrong: %+v", got[3])
		}
	})

	t.Run("single bucket", func(t *testing.T) {
		got := zeroFillHourly([]HourBucket{{Hour: hr("2026-06-01T05:00:00Z"), Opens: 9}})
		if len(got) != 1 || got[0].Opens != 9 {
			t.Fatalf("single bucket wrong: %+v", got)
		}
	})

	t.Run("caps runaway range", func(t *testing.T) {
		observed := []HourBucket{
			{Hour: hr("2026-01-01T00:00:00Z"), Opens: 1},
			{Hour: hr("2027-01-01T00:00:00Z"), Opens: 1}, // ~1 year apart
		}
		got := zeroFillHourly(observed)
		if len(got) != campaignTimeseriesMaxHours {
			t.Fatalf("expected cap at %d, got %d", campaignTimeseriesMaxHours, len(got))
		}
		wantStart := hr("2027-01-01T00:00:00Z").
			Add(-time.Duration(campaignTimeseriesMaxHours-1) * time.Hour)
		if !got[0].Hour.Equal(wantStart) {
			t.Fatalf("bounded series started at %v, want newest-window start %v", got[0].Hour, wantStart)
		}
		if !got[len(got)-1].Hour.Equal(hr("2027-01-01T00:00:00Z")) ||
			got[len(got)-1].Opens != 1 {
			t.Fatalf("newest observed fact was lost: %+v", got[len(got)-1])
		}
	})
}

func TestZeroFillHourlyBetweenUsesExplicitUTCWindow(t *testing.T) {
	start := hr("2026-07-24T00:00:00Z")
	end := start.Add(2 * time.Hour)
	got := zeroFillHourlyBetween([]HourBucket{{
		Hour:   end,
		Clicks: 7,
	}}, start, end)
	if len(got) != 3 {
		t.Fatalf("len=%d, want 3", len(got))
	}
	if got[0].Hour.Location() != time.UTC || got[1].Clicks != 0 || got[2].Clicks != 7 {
		t.Fatalf("unexpected gap fill: %+v", got)
	}
}
