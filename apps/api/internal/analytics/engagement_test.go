// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement_test.go — pure-function table tests for the Surfacing
// Analytics engagement panel. No live database: the AI-surfacing formula
// and the panel assembler are exercised directly, and the SQL-shape guard
// pins the open-decoupled anti-join so a refactor can't silently drop the
// decoupling.
package analytics

import (
	"math"
	"strings"
	"testing"
)

func almostEqual(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-9
}

func TestAISurfacingScore(t *testing.T) {
	tests := []struct {
		name             string
		humanOpenRate    float64
		replyRate        float64
		hardBounceRate   float64
		clickToOpenRate  float64
		humanUniqueOpens int
		wantScore        float64
		wantConfidence   string
		wantBasis        []string
	}{
		{
			// All signals present, reply weight 0.5 (D1):
			// 0.2*0.5 + 0.5*0.2 + 0.3*(1-0.01) = 0.1+0.1+0.297 = 0.497;
			// CTOR 0.30 > 0.05 → +0.1 = 0.597.
			name:             "all signals present",
			humanOpenRate:    0.5,
			replyRate:        0.2,
			hardBounceRate:   0.01,
			clickToOpenRate:  0.30,
			humanUniqueOpens: 200,
			wantScore:        0.597,
			wantConfidence:   aiConfidenceOK,
			wantBasis:        []string{"human_open_rate", "reply_rate", "hard_bounce_rate", "click_to_open_rate"},
		},
		{
			// Reply rate missing → reply term drops out, and zero replies
			// always force low confidence (D2). CTOR 0 → no bonus.
			// 0.2*0.4 + 0.5*0 + 0.3*(1-0.0) = 0.08 + 0.3 = 0.38.
			name:             "reply rate missing forces low confidence",
			humanOpenRate:    0.4,
			replyRate:        0,
			hardBounceRate:   0,
			clickToOpenRate:  0,
			humanUniqueOpens: 500,
			wantScore:        0.38,
			wantConfidence:   aiConfidenceLow,
			wantBasis:        []string{"human_open_rate"},
		},
		{
			// Zero opens → empty basis → score forced to 0, low confidence,
			// regardless of the (1-hardBounce) baseline.
			name:             "zero opens yields empty basis and zero score",
			humanOpenRate:    0,
			replyRate:        0,
			hardBounceRate:   0,
			clickToOpenRate:  0,
			humanUniqueOpens: 0,
			wantScore:        0,
			wantConfidence:   aiConfidenceLow,
			wantBasis:        []string{},
		},
		{
			// Below the 50-open threshold → low confidence even with replies.
			name:             "small sample under 50 opens is low confidence",
			humanOpenRate:    0.6,
			replyRate:        0.1,
			hardBounceRate:   0,
			clickToOpenRate:  0,
			humanUniqueOpens: 40,
			// 0.2*0.6 + 0.5*0.1 + 0.3*1 = 0.12+0.05+0.3 = 0.47.
			wantScore:      0.47,
			wantConfidence: aiConfidenceLow,
			wantBasis:      []string{"human_open_rate", "reply_rate"},
		},
		{
			// Score clamps to 1 when the weighted sum + bonus overflows;
			// data-integrity glitch (hardBounceRate > 1) clamps to 0 health.
			name:             "score clamps to 1 and bounce rate over 1 clamps",
			humanOpenRate:    1,
			replyRate:        1,
			hardBounceRate:   2, // clamps to 1 → (1-1)=0 health
			clickToOpenRate:  1,
			humanUniqueOpens: 1000,
			// 0.2*1 + 0.5*1 + 0.3*0 = 0.7; +0.1 CTOR = 0.8. A non-zero
			// (clamped) hard-bounce rate still lists as a present signal.
			wantScore:      0.8,
			wantConfidence: aiConfidenceOK,
			wantBasis:      []string{"human_open_rate", "reply_rate", "hard_bounce_rate", "click_to_open_rate"},
		},
		{
			// CTOR exactly at the threshold (0.05) does NOT earn the bonus
			// (strictly-greater-than).
			name:             "CTOR at threshold earns no bonus",
			humanOpenRate:    0.5,
			replyRate:        0.2,
			hardBounceRate:   0,
			clickToOpenRate:  0.05,
			humanUniqueOpens: 100,
			// 0.2*0.5 + 0.5*0.2 + 0.3*1 = 0.1+0.1+0.3 = 0.5; no bonus.
			wantScore:      0.5,
			wantConfidence: aiConfidenceOK,
			wantBasis:      []string{"human_open_rate", "reply_rate"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			score, confidence, basis := aiSurfacingScore(
				tc.humanOpenRate, tc.replyRate, tc.hardBounceRate,
				tc.clickToOpenRate, tc.humanUniqueOpens,
			)
			if !almostEqual(score, tc.wantScore) {
				t.Errorf("score = %v, want %v", score, tc.wantScore)
			}
			if confidence != tc.wantConfidence {
				t.Errorf("confidence = %q, want %q", confidence, tc.wantConfidence)
			}
			if score < 0 || score > 1 {
				t.Errorf("score %v out of [0,1]", score)
			}
			if len(basis) != len(tc.wantBasis) {
				t.Fatalf("basis = %v, want %v", basis, tc.wantBasis)
			}
			for i := range basis {
				if basis[i] != tc.wantBasis[i] {
					t.Errorf("basis[%d] = %q, want %q", i, basis[i], tc.wantBasis[i])
				}
			}
		})
	}
}

func TestClamp01(t *testing.T) {
	cases := map[float64]float64{
		-1:  0,
		0:   0,
		0.5: 0.5,
		1:   1,
		2:   1,
	}
	for in, want := range cases {
		if got := clamp01(in); !almostEqual(got, want) {
			t.Errorf("clamp01(%v) = %v, want %v", in, got, want)
		}
	}
	// NaN / Inf collapse to 0.
	if got := clamp01(math.NaN()); got != 0 {
		t.Errorf("clamp01(NaN) = %v, want 0", got)
	}
	if got := clamp01(math.Inf(1)); got != 0 {
		t.Errorf("clamp01(+Inf) = %v, want 0", got)
	}
}

func TestComputeEngagementPanel_HumanEnabled(t *testing.T) {
	in := engagementInputs{
		CampaignID:                 "c-1",
		Delivered:                  1000,
		RawUniqueOpens:             500,
		HumanUniqueOpens:           300,
		HumanEngagementEnabled:     true,
		UniqueRecipients:           1000,
		ReplyCount:                 25,
		DistinctReplyers:           20,
		OpenDecoupledConversions:   3,
		TotalAttributedConversions: 10,
		HardBounces:                10,
		UniqueClicks:               90,
		BotSignaturesApplied:       []string{"Apple MPP"},
	}
	p := computeEngagementPanel(in)

	if !almostEqual(p.RawOpenRate, 0.5) {
		t.Errorf("RawOpenRate = %v, want 0.5", p.RawOpenRate)
	}
	if !almostEqual(p.HumanOpenRate, 0.3) {
		t.Errorf("HumanOpenRate = %v, want 0.3", p.HumanOpenRate)
	}
	if p.HumanUniqueOpens != 300 {
		t.Errorf("HumanUniqueOpens = %d, want 300", p.HumanUniqueOpens)
	}
	if !almostEqual(p.ReplyRate, 0.02) {
		t.Errorf("ReplyRate = %v, want 0.02", p.ReplyRate)
	}
	if p.OpenDecoupledConversions != 3 || p.TotalAttributedConversions != 10 {
		t.Errorf("conversions = (%d,%d), want (3,10)", p.OpenDecoupledConversions, p.TotalAttributedConversions)
	}
	// Sample = human opens (300) since flag is on.
	if p.AISurfacingSampleOpens != 300 {
		t.Errorf("AISurfacingSampleOpens = %d, want 300", p.AISurfacingSampleOpens)
	}
	if p.AISurfacingConfidenceLevel != aiConfidenceOK {
		t.Errorf("confidence = %q, want ok", p.AISurfacingConfidenceLevel)
	}
	if p.AISurfacingScore < 0 || p.AISurfacingScore > 1 {
		t.Errorf("score %v out of range", p.AISurfacingScore)
	}
}

func TestComputeEngagementPanel_HumanDisabledZeroesHumanFields(t *testing.T) {
	in := engagementInputs{
		CampaignID:             "c-2",
		Delivered:              1000,
		RawUniqueOpens:         500,
		HumanUniqueOpens:       300, // stale value must be ignored when flag off
		HumanEngagementEnabled: false,
		UniqueRecipients:       1000,
		ReplyCount:             0,
		DistinctReplyers:       0,
		UniqueClicks:           50,
	}
	p := computeEngagementPanel(in)

	if p.HumanUniqueOpens != 0 {
		t.Errorf("HumanUniqueOpens = %d, want 0 when flag off", p.HumanUniqueOpens)
	}
	if !almostEqual(p.HumanOpenRate, 0) {
		t.Errorf("HumanOpenRate = %v, want 0 when flag off", p.HumanOpenRate)
	}
	// Falls back to raw uniques (500) for the AI sample + open rate.
	if p.AISurfacingSampleOpens != 500 {
		t.Errorf("AISurfacingSampleOpens = %d, want 500 (raw fallback)", p.AISurfacingSampleOpens)
	}
	// Zero replies → low confidence regardless of sample size.
	if p.AISurfacingConfidenceLevel != aiConfidenceLow {
		t.Errorf("confidence = %q, want low (zero replies)", p.AISurfacingConfidenceLevel)
	}
}

func TestComputeEngagementPanel_ZeroDelivered(t *testing.T) {
	p := computeEngagementPanel(engagementInputs{CampaignID: "c-3", HumanEngagementEnabled: true})
	if p.RawOpenRate != 0 || p.HumanOpenRate != 0 || p.ReplyRate != 0 {
		t.Errorf("rates must be 0 for empty campaign, got raw=%v human=%v reply=%v",
			p.RawOpenRate, p.HumanOpenRate, p.ReplyRate)
	}
	if p.AISurfacingScore != 0 {
		t.Errorf("AISurfacingScore = %v, want 0 for empty campaign", p.AISurfacingScore)
	}
	if p.AISurfacingConfidenceLevel != aiConfidenceLow {
		t.Errorf("confidence = %q, want low for empty campaign", p.AISurfacingConfidenceLevel)
	}
	if p.AISurfacingSampleOpens != 0 {
		t.Errorf("AISurfacingSampleOpens = %d, want 0", p.AISurfacingSampleOpens)
	}
}

func TestComputeEngagementPanel_ConversionWithoutOpenCount(t *testing.T) {
	// Open-decoupled count is a pure pass-through of the (decoupled, total)
	// the store returns — never estimated. Showing 0 is honest.
	in := engagementInputs{
		CampaignID:                 "c-4",
		Delivered:                  100,
		OpenDecoupledConversions:   0,
		TotalAttributedConversions: 7,
		HumanEngagementEnabled:     true,
	}
	p := computeEngagementPanel(in)
	if p.OpenDecoupledConversions != 0 {
		t.Errorf("OpenDecoupledConversions = %d, want 0", p.OpenDecoupledConversions)
	}
	if p.TotalAttributedConversions != 7 {
		t.Errorf("TotalAttributedConversions = %d, want 7", p.TotalAttributedConversions)
	}
}

// TestOpenDecoupledSQLShape pins the decoupling predicate so a future
// refactor cannot silently drop the anti-join or the attributed_via
// filter — either change would corrupt the metric's meaning.
func TestOpenDecoupledSQLShape(t *testing.T) {
	q := openDecoupledSQL
	for _, frag := range []string{
		"NOT EXISTS",
		"event_type = 'opened'",
		"attributed_via IN ('explicit','last_touch')",
		"FROM conversions c",
		"FROM campaign_report_events oe",
	} {
		if !strings.Contains(q, frag) {
			t.Errorf("openDecoupledSQL missing required fragment %q", frag)
		}
	}
}
