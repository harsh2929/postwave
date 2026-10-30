// SPDX-License-Identifier: AGPL-3.0-only
package conversions

import (
	"testing"
	"time"
)

func TestParseDays(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"", 90, true},
		{"1", 1, true},
		{"30", 30, true},
		{"365", 365, true},
		{"0", 0, false},
		{"366", 0, false},
		{"-7", 0, false},
		{"abc", 0, false},
		{"7.5", 0, false},
	}
	for _, c := range cases {
		got, ok := parseDays(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseDays(%q) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestWindowStartUTC(t *testing.T) {
	now := time.Date(2026, 6, 11, 15, 4, 5, 0, time.UTC)
	if got := windowStartUTC(now, 1); !got.Equal(time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("days=1: got %v, want today's UTC floor", got)
	}
	if got := windowStartUTC(now, 90); !got.Equal(time.Date(2026, 3, 14, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("days=90: got %v, want 2026-03-14", got)
	}
	// Non-UTC input must floor on the UTC date, not the local one.
	tokyo := time.FixedZone("JST", 9*3600)
	lateLocal := time.Date(2026, 6, 12, 3, 0, 0, 0, tokyo) // = 2026-06-11 18:00 UTC
	if got := windowStartUTC(lateLocal, 1); !got.Equal(time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("JST input: got %v, want UTC date floor 2026-06-11", got)
	}
}

func TestDominantCurrency(t *testing.T) {
	if got := dominantCurrency(nil); got != "" {
		t.Errorf("empty: got %q, want \"\"", got)
	}
	totals := []CurrencyTotal{
		{Currency: "EUR", Conversions: 10, RevenueCents: 500},
		{Currency: "USD", Conversions: 2, RevenueCents: 9000},
	}
	if got := dominantCurrency(totals); got != "USD" {
		t.Errorf("revenue winner: got %q, want USD", got)
	}
	// Revenue tie → more conversions wins.
	totals = []CurrencyTotal{
		{Currency: "USD", Conversions: 1, RevenueCents: 1000},
		{Currency: "EUR", Conversions: 5, RevenueCents: 1000},
	}
	if got := dominantCurrency(totals); got != "EUR" {
		t.Errorf("conversion tiebreak: got %q, want EUR", got)
	}
	// Full tie → alphabetical for determinism.
	totals = []CurrencyTotal{
		{Currency: "GBP", Conversions: 1, RevenueCents: 1000},
		{Currency: "CHF", Conversions: 1, RevenueCents: 1000},
	}
	if got := dominantCurrency(totals); got != "CHF" {
		t.Errorf("alpha tiebreak: got %q, want CHF", got)
	}
}

func TestRollupTopCampaigns(t *testing.T) {
	mk := func(n int) []AttributionItem {
		out := make([]AttributionItem, n)
		for i := range out {
			out[i] = AttributionItem{
				CampaignID:   string(rune('a' + i)),
				Conversions:  1,
				RevenueCents: 100,
				EmailsSent:   10,
			}
		}
		return out
	}

	// At or under the cap: unchanged, no "(other)" item.
	if got := rollupTopCampaigns(mk(3), 3); len(got) != 3 {
		t.Fatalf("under cap: len = %d, want 3", len(got))
	}

	got := rollupTopCampaigns(mk(5), 3)
	if len(got) != 4 {
		t.Fatalf("over cap: len = %d, want 4 (3 kept + other)", len(got))
	}
	other := got[3]
	if other.CampaignID != "" || other.CampaignName != "(other campaigns)" {
		t.Errorf("other item = %+v, want empty id + (other campaigns) name", other)
	}
	// Remainder sums stay exact: 2 rolled items.
	if other.Conversions != 2 || other.RevenueCents != 200 || other.EmailsSent != 20 {
		t.Errorf("other sums = conv:%d rev:%d sent:%d, want 2/200/20",
			other.Conversions, other.RevenueCents, other.EmailsSent)
	}
}

func TestRevenuePerSendCents(t *testing.T) {
	if got := revenuePerSendCents(1000, 0); got != nil {
		t.Errorf("0 sends: got %v, want nil", *got)
	}
	got := revenuePerSendCents(3000, 4)
	if got == nil || *got != 750 {
		t.Errorf("3000/4: got %v, want 750", got)
	}
}

func TestZeroFillTimeseries(t *testing.T) {
	start := time.Date(2026, 6, 9, 0, 0, 0, 0, time.UTC)
	byDate := map[string]TimeseriesPoint{
		"2026-06-10": {Conversions: 2, RevenueCents: 500},
	}
	got := zeroFillTimeseries(start, 3, byDate)
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	wantDates := []string{"2026-06-09", "2026-06-10", "2026-06-11"}
	for i, w := range wantDates {
		if got[i].Date != w {
			t.Errorf("point[%d].Date = %q, want %q", i, got[i].Date, w)
		}
	}
	if got[0].Conversions != 0 || got[0].RevenueCents != 0 {
		t.Errorf("point[0] not zero-filled: %+v", got[0])
	}
	if got[1].Conversions != 2 || got[1].RevenueCents != 500 {
		t.Errorf("point[1] = %+v, want conv:2 rev:500", got[1])
	}
	if got[2].Conversions != 0 {
		t.Errorf("point[2] not zero-filled: %+v", got[2])
	}
}

func TestIsUUID(t *testing.T) {
	if !isUUID("00000000-0000-0000-0000-000000000001") {
		t.Error("valid uuid rejected")
	}
	for _, bad := range []string{"", "not-a-uuid", "00000000-0000-0000-0000-00000000000g", "1; DROP TABLE conversions"} {
		if isUUID(bad) {
			t.Errorf("isUUID(%q) = true, want false", bad)
		}
	}
}
