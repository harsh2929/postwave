// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the pure-logic surface of the list_health package:
// the score/grade calculator and the window-days query clamp. These
// are the load-bearing pieces operators see — the SQL aggregation is
// covered by integration tests at the API edge.

package list_health

import (
	"strings"
	"testing"
)

// --- scoreAndGrade ---------------------------------------------------

func TestScoreAndGrade_HealthyListGetsA(t *testing.T) {
	s := Score{
		ActiveSubscribers: 10_000,
		TotalSubscribers:  10_000,
		BounceRate:        0.001,  // 0.1% — under 0.5%
		ComplaintRate:     0.0001, // 0.01% — under 0.05%
		UnsubscribeRate:   0.005,  // 0.5% — under 2%
		EngagementRate:    0.40,   // 40% — well above 15%
		SuppressionRate:   0.01,   // 1% — under 5%
	}
	score, grade, notes := scoreAndGrade(s)
	if score != 100 {
		t.Fatalf("healthy list score = %d, want 100", score)
	}
	if grade != "A" {
		t.Fatalf("healthy list grade = %q, want A", grade)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "safe thresholds") {
		t.Fatalf("healthy list notes = %v, want all-good note", notes)
	}
}

func TestScoreAndGrade_BouncePenalty(t *testing.T) {
	// 1.5% bounce rate — 1pp above the 0.5% threshold => 2.0 * 1pp = -2.
	s := Score{
		ActiveSubscribers: 5_000,
		TotalSubscribers:  5_000,
		BounceRate:        0.015,
		EngagementRate:    0.40,
	}
	score, grade, notes := scoreAndGrade(s)
	if score != 98 {
		t.Fatalf("bounce penalty score = %d, want 98", score)
	}
	if grade != "A" {
		t.Fatalf("bounce penalty grade = %q, want A", grade)
	}
	if !containsSubstring(notes, "bounce rate") {
		t.Fatalf("bounce penalty notes = %v, want bounce-rate note", notes)
	}
}

func TestScoreAndGrade_BounceRateExactlyAtThreshold_NoPenalty(t *testing.T) {
	// 0.5% bounce rate — exactly at the threshold should NOT penalise
	// (penalty triggers strictly above, per the > comparison).
	s := Score{
		ActiveSubscribers: 5_000,
		TotalSubscribers:  5_000,
		BounceRate:        0.005,
		EngagementRate:    0.40,
	}
	score, _, _ := scoreAndGrade(s)
	if score != 100 {
		t.Fatalf("threshold bounce score = %d, want 100", score)
	}
}

func TestScoreAndGrade_ComplaintPenalty(t *testing.T) {
	// 0.15% complaint rate — 0.1pp above the 0.05% threshold => 50 * 0.1 = -5.
	s := Score{
		ActiveSubscribers: 5_000,
		TotalSubscribers:  5_000,
		ComplaintRate:     0.0015,
		EngagementRate:    0.40,
	}
	score, grade, notes := scoreAndGrade(s)
	if score != 95 {
		t.Fatalf("complaint penalty score = %d, want 95", score)
	}
	if grade != "A" {
		t.Fatalf("complaint penalty grade = %q, want A", grade)
	}
	if !containsSubstring(notes, "complaint rate") {
		t.Fatalf("complaint penalty notes = %v, want complaint-rate note", notes)
	}
}

func TestScoreAndGrade_EngagementPenalty_OnlyWhenMoreThan100Active(t *testing.T) {
	// 5% engagement on 10k actives is a 10pp gap below 15% => -5.
	big := Score{
		ActiveSubscribers: 10_000,
		TotalSubscribers:  10_000,
		EngagementRate:    0.05,
	}
	score, _, notes := scoreAndGrade(big)
	if score != 95 {
		t.Fatalf("engagement penalty (big list) score = %d, want 95", score)
	}
	if !containsSubstring(notes, "engagement") {
		t.Fatalf("engagement penalty notes = %v, want engagement note", notes)
	}

	// Same engagement rate but only 50 actives — small lists are noisy
	// so no penalty applies (>100 active gate).
	small := Score{
		ActiveSubscribers: 50,
		TotalSubscribers:  50,
		EngagementRate:    0.05,
	}
	score2, _, _ := scoreAndGrade(small)
	if score2 != 100 {
		t.Fatalf("engagement penalty (small list) score = %d, want 100", score2)
	}
}

func TestScoreAndGrade_UnsubPenalty(t *testing.T) {
	// 4% unsub rate — 2pp above the 2% threshold => 1.5 * 2 = -3.
	s := Score{
		ActiveSubscribers: 5_000,
		TotalSubscribers:  5_000,
		UnsubscribeRate:   0.04,
		EngagementRate:    0.40,
	}
	score, _, notes := scoreAndGrade(s)
	if score != 97 {
		t.Fatalf("unsub penalty score = %d, want 97", score)
	}
	if !containsSubstring(notes, "unsub") {
		t.Fatalf("unsub penalty notes = %v, want unsub note", notes)
	}
}

func TestScoreAndGrade_SuppressionPenalty(t *testing.T) {
	// 25% suppression rate — 20pp above the 5% threshold => 0.5 * 20 = -10.
	s := Score{
		ActiveSubscribers: 5_000,
		TotalSubscribers:  5_000,
		SuppressionRate:   0.25,
		EngagementRate:    0.40,
	}
	score, _, notes := scoreAndGrade(s)
	if score != 90 {
		t.Fatalf("suppression penalty score = %d, want 90", score)
	}
	if !containsSubstring(notes, "blocklisted") {
		t.Fatalf("suppression penalty notes = %v, want blocklisted note", notes)
	}
}

func TestScoreAndGrade_MultiplePenaltiesStack(t *testing.T) {
	// Bounce -2, complaint -5, engagement penalty 0 (above 15%),
	// unsub -3, suppression -10. Total -20 => 80.
	s := Score{
		ActiveSubscribers: 5_000,
		TotalSubscribers:  5_000,
		BounceRate:        0.015,
		ComplaintRate:     0.0015,
		UnsubscribeRate:   0.04,
		EngagementRate:    0.40,
		SuppressionRate:   0.25,
	}
	score, grade, notes := scoreAndGrade(s)
	if score != 80 {
		t.Fatalf("stacked penalty score = %d, want 80", score)
	}
	if grade != "B" {
		t.Fatalf("stacked penalty grade = %q, want B", grade)
	}
	if len(notes) != 4 {
		t.Fatalf("stacked penalty notes = %d items, want 4 (%v)", len(notes), notes)
	}
}

func TestScoreAndGrade_FloorsAtZero(t *testing.T) {
	// Extreme everything: 50% bounce, 10% complaint, 0% engagement,
	// 50% unsub, 90% blocklisted. Penalties dwarf 100; expect 0/F.
	s := Score{
		ActiveSubscribers: 10_000,
		TotalSubscribers:  10_000,
		BounceRate:        0.50,
		ComplaintRate:     0.10,
		UnsubscribeRate:   0.50,
		EngagementRate:    0.0,
		SuppressionRate:   0.90,
	}
	score, grade, _ := scoreAndGrade(s)
	if score != 0 {
		t.Fatalf("catastrophic score = %d, want 0", score)
	}
	if grade != "F" {
		t.Fatalf("catastrophic grade = %q, want F", grade)
	}
}

// --- Grade bands -----------------------------------------------------

func TestScoreAndGrade_GradeBands(t *testing.T) {
	// Each case picks penalty inputs that land exactly on the band
	// boundary, then verifies the label. We use BounceRate as the
	// dial because its penalty is the most predictable (2.0 * extraPP).
	cases := []struct {
		name      string
		bouncePP  float64 // extra percentage points above 0.5%
		wantScore int
		wantGrade string
	}{
		{"A boundary 90", 5.0, 90, "A"},  // -10 => 90
		{"B boundary 89", 5.5, 89, "B"},  // -11 => 89
		{"B boundary 75", 12.5, 75, "B"}, // -25 => 75
		{"C boundary 74", 13.0, 74, "C"}, // -26 => 74
		{"C boundary 60", 20.0, 60, "C"}, // -40 => 60
		{"D boundary 59", 20.5, 59, "D"}, // -41 => 59
		{"D boundary 40", 30.0, 40, "D"}, // -60 => 40
		{"F boundary 39", 30.5, 39, "F"}, // -61 => 39
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 0.005 threshold + bouncePP percentage points -> rate
			rate := 0.005 + (tc.bouncePP / 100.0)
			s := Score{
				ActiveSubscribers: 5_000,
				TotalSubscribers:  5_000,
				BounceRate:        rate,
				EngagementRate:    0.40,
			}
			score, grade, _ := scoreAndGrade(s)
			if score != tc.wantScore {
				t.Fatalf("score = %d, want %d", score, tc.wantScore)
			}
			if grade != tc.wantGrade {
				t.Fatalf("grade = %q, want %q", grade, tc.wantGrade)
			}
		})
	}
}

// --- Edge cases ------------------------------------------------------

func TestScoreAndGrade_ZeroSubscribers(t *testing.T) {
	// All zeros — no penalties trigger because every rate is 0.
	s := Score{}
	score, grade, notes := scoreAndGrade(s)
	if score != 100 {
		t.Fatalf("zero-everything score = %d, want 100", score)
	}
	if grade != "A" {
		t.Fatalf("zero-everything grade = %q, want A", grade)
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "safe thresholds") {
		t.Fatalf("zero-everything notes = %v, want all-good note", notes)
	}
}

func TestScoreAndGrade_ZeroEngagementBelowGateNoPenalty(t *testing.T) {
	// 0% engagement on exactly 100 actives — the gate is strictly >100
	// so no penalty fires.
	s := Score{
		ActiveSubscribers: 100,
		TotalSubscribers:  100,
		EngagementRate:    0,
	}
	score, _, _ := scoreAndGrade(s)
	if score != 100 {
		t.Fatalf("engagement gate score = %d, want 100", score)
	}
}

func TestScoreAndGrade_AllBouncedMaxPenalty(t *testing.T) {
	// Every send bounced. Penalty is huge but score floors at 0.
	s := Score{
		ActiveSubscribers: 10_000,
		TotalSubscribers:  10_000,
		BounceRate:        1.0, // 100%
		EngagementRate:    0,
	}
	score, grade, notes := scoreAndGrade(s)
	if score != 0 {
		t.Fatalf("all-bounced score = %d, want 0", score)
	}
	if grade != "F" {
		t.Fatalf("all-bounced grade = %q, want F", grade)
	}
	if !containsSubstring(notes, "bounce rate") {
		t.Fatalf("all-bounced notes = %v, want bounce note", notes)
	}
}

// --- clampWindowDays -------------------------------------------------

func TestClampWindowDays(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"", 90},
		{"90", 90},
		{"30", 30},
		{"7", 7},
		{"6", 7},  // below floor
		{"1", 7},  // way below
		{"-5", 7}, // negative
		{"365", 365},
		{"366", 365}, // above ceiling
		{"99999", 365},
		{"abc", 90}, // unparseable -> default
		{"  60  ", 60},
	}
	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			if got := clampWindowDays(tc.raw); got != tc.want {
				t.Fatalf("clampWindowDays(%q) = %d, want %d", tc.raw, got, tc.want)
			}
		})
	}
}

// --- clampRate (history.go) ------------------------------------------

func TestClampRate(t *testing.T) {
	cases := []struct {
		in, want float64
	}{
		{0, 0},
		{0.5, 0.5},
		{1, 1},
		{9.9999, 9.9999},
		{10, 9.9999},
		{100, 9.9999},
		{-0.01, 0},
		{-100, 0},
	}
	for _, tc := range cases {
		if got := clampRate(tc.in); got != tc.want {
			t.Fatalf("clampRate(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// --- helpers ---------------------------------------------------------

func containsSubstring(haystack []string, needle string) bool {
	for _, s := range haystack {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}
