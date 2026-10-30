// SPDX-License-Identifier: AGPL-3.0-only
package overage

import "testing"

func ptr(n int) *int { return &n }

func TestDecide(t *testing.T) {
	cases := []struct {
		name                         string
		current, requested, included int
		pref                         Preference
		wantAllow                    bool
		wantUnits                    int
	}{
		{
			name:    "overage OFF blocks past the cap (hard cap)",
			current: 49_000, requested: 2_000, included: 50_000,
			pref:      Preference{Enabled: false},
			wantAllow: false, wantUnits: 1_000,
		},
		{
			name:    "overage ON, uncapped, allows and meters",
			current: 49_000, requested: 2_000, included: 50_000,
			pref:      Preference{Enabled: true, Cap: nil},
			wantAllow: true, wantUnits: 1_000,
		},
		{
			name:    "overage ON within the ceiling allows",
			current: 50_000, requested: 5_000, included: 50_000,
			pref:      Preference{Enabled: true, Cap: ptr(10_000)},
			wantAllow: true, wantUnits: 5_000,
		},
		{
			name:    "overage ON beyond the ceiling blocks",
			current: 50_000, requested: 15_000, included: 50_000,
			pref:      Preference{Enabled: true, Cap: ptr(10_000)},
			wantAllow: false, wantUnits: 15_000,
		},
		{
			name:    "ceiling of exactly the units allows (boundary)",
			current: 50_000, requested: 10_000, included: 50_000,
			pref:      Preference{Enabled: true, Cap: ptr(10_000)},
			wantAllow: true, wantUnits: 10_000,
		},
		{
			name:    "ceiling of 0 blocks any overage even when enabled",
			current: 50_000, requested: 1, included: 50_000,
			pref:      Preference{Enabled: true, Cap: ptr(0)},
			wantAllow: false, wantUnits: 1,
		},
		{
			name:    "already-over current, ON, counts cumulative units",
			current: 52_000, requested: 1_000, included: 50_000,
			pref:      Preference{Enabled: true, Cap: nil},
			wantAllow: true, wantUnits: 3_000,
		},
		{
			name:    "units never negative (batch straddles the cap)",
			current: 49_000, requested: 500, included: 50_000,
			pref:      Preference{Enabled: true},
			wantAllow: true, wantUnits: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Decide(tc.current, tc.requested, tc.included, tc.pref)
			if got.Allow != tc.wantAllow || got.OverageUnits != tc.wantUnits {
				t.Fatalf("Decide = {Allow:%v Units:%d}, want {Allow:%v Units:%d}",
					got.Allow, got.OverageUnits, tc.wantAllow, tc.wantUnits)
			}
		})
	}
}
