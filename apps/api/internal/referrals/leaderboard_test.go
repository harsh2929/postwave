// SPDX-License-Identifier: AGPL-3.0-only
//
// leaderboard_test.go — pure tests for the masking, window parsing
// and milestone-tier helpers. The grouped SQL path follows the same
// fraud/credit filters TopReferrers already exercises in the DB-skip
// suite.

package referrals

import "testing"

func TestMaskEmail(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"alice@example.com":  "a***@example.com",
		"b@x.io":             "b***@x.io",
		"Carol.D@corp.co.uk": "C***@corp.co.uk",
		"":                   "***",
		"no-at-sign":         "***",
		"@example.com":       "***",
		"trailing@":          "***",
		"  spaced@x.com  ":   "s***@x.com",
	}
	for in, want := range cases {
		if got := maskEmail(in); got != want {
			t.Errorf("maskEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseLeaderboardWindowDays(t *testing.T) {
	t.Parallel()
	cases := map[string]int{
		"":     90,
		"90d":  90,
		"30":   30,
		"12w":  84,
		"abc":  90,
		"-1":   90,
		"400d": 365,
	}
	for in, want := range cases {
		if got := parseLeaderboardWindowDays(in); got != want {
			t.Errorf("parseLeaderboardWindowDays(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestHighestUnlockedMilestone(t *testing.T) {
	t.Parallel()
	ms := []Milestone{
		{Count: 5, RewardLabel: "sticker"},
		{Count: 10, RewardLabel: "mug"},
		{Count: 25, RewardLabel: "hoodie"},
	}
	cases := []struct {
		conversions int
		want        int
	}{
		{0, 0}, {4, 0}, {5, 5}, {9, 5}, {10, 10}, {24, 10}, {25, 25}, {100, 25},
	}
	for _, tc := range cases {
		if got := highestUnlockedMilestone(ms, tc.conversions); got != tc.want {
			t.Errorf("highestUnlockedMilestone(%d) = %d, want %d", tc.conversions, got, tc.want)
		}
	}
	if got := highestUnlockedMilestone(nil, 50); got != 0 {
		t.Errorf("no program: got %d, want 0", got)
	}
}
