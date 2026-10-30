// SPDX-License-Identifier: AGPL-3.0-only
//
// engagement_churn.go — commerce-free churn signal.
//
// The order-recency churn model (ComputePrediction →
// profile_predictions.churn_risk) only scores subscribers who appear in
// commerce_orders, so a publication / newsletter tenant with no commerce
// integration gets churn_risk for nobody and the win-back worker no-ops.
//
// This file adds a SECOND, commerce-free churn signal derived purely
// from e-mail engagement recency: how long since the subscriber last
// opened or clicked a campaign (campaign_report_events). It lets the
// win-back worker fire for EVERY tenant — it falls back to this signal
// when commerce churn data is absent.
//
// ── Model ───────────────────────────────────────────────────────────
// Let d = days since the subscriber's most recent 'opened' or 'clicked'
// campaign_report_event. Engagement churn risk is a banded step
// function of d:
//
//	d ≤ 30 days        → 0.10   (recently engaged — low risk)
//	30 < d ≤ 60        → 0.40   (cooling off)
//	60 < d ≤ 90        → 0.70   (at risk)
//	90 < d ≤ 120       → 0.85   (high risk)
//	d > 120 days       → 0.95   (very high risk)
//	no activity ever   → 0.95   (treated as max — never engaged)
//
// Bands (not a smooth exp(-d/30) curve) are deliberate: they're trivial
// to reason about against the win-back threshold (default 0.70 → fires
// at "no activity in 60+ days", since the at-risk band == 0.70), they're
// stable under the daily tick
// (a subscriber doesn't oscillate across the threshold day-to-day), and
// they map cleanly onto the "no activity in 60/90/120 days" language ops
// already use. The continuous exp(-d/30) form is provided as
// EngagementChurnContinuous for callers who want a monotone score (e.g.
// ranking), but the banded form is what gates sends.
//
// "Activity" = opens + clicks only. We intentionally exclude 'sent' and
// 'delivered' (those measure OUR behaviour, not the subscriber's) and
// 'bounced'/'complained'/'unsubscribed' (those are suppression signals
// handled on the send path, not churn-recency).

package predictive

import "math"

// Engagement-churn risk bands. Exported so the win-back worker and tests
// share the exact constants instead of re-deriving the thresholds.
const (
	EngagementChurnRecent   = 0.10 // ≤ 30 days since last open/click
	EngagementChurnCooling  = 0.40 // 31..60 days
	EngagementChurnAtRisk   = 0.70 // 61..90 days (== default win-back gate)
	EngagementChurnHigh     = 0.85 // 91..120 days
	EngagementChurnVeryHigh = 0.95 // > 120 days, or never engaged
)

// Band edges, in days. Kept next to the constants above so a future
// tuning change touches one place.
const (
	engagementBandRecentDays  = 30
	engagementBandCoolingDays = 60
	engagementBandAtRiskDays  = 90
	engagementBandHighDays    = 120
)

// EngagementChurnRisk maps days-since-last-open/click to a banded churn
// risk in [0,1]. daysSinceActivity < 0 (the "no recorded open/click ever"
// sentinel the repo passes) is treated as maximum risk: a subscriber the
// tenant has never engaged is exactly who a win-back is for.
//
// Pure + deterministic — the unit of test coverage for the model.
func EngagementChurnRisk(daysSinceActivity int) float64 {
	if daysSinceActivity < 0 {
		return EngagementChurnVeryHigh
	}
	switch {
	case daysSinceActivity <= engagementBandRecentDays:
		return EngagementChurnRecent
	case daysSinceActivity <= engagementBandCoolingDays:
		return EngagementChurnCooling
	case daysSinceActivity <= engagementBandAtRiskDays:
		return EngagementChurnAtRisk
	case daysSinceActivity <= engagementBandHighDays:
		return EngagementChurnHigh
	default:
		return EngagementChurnVeryHigh
	}
}

// EngagementChurnContinuous is the smooth companion to the banded model:
// 1 - exp(-d/30), clamped to [0,1]. A subscriber who engaged today scores
// ~0; recency of 30 days ≈ 0.63; 90 days ≈ 0.95. Provided for ranking
// (ORDER BY risk DESC) where a monotone score beats five plateaus. A
// negative d (never engaged) is max risk. Not used to gate sends — the
// banded form is, for the stability reasons in the file header.
func EngagementChurnContinuous(daysSinceActivity int) float64 {
	if daysSinceActivity < 0 {
		return 1
	}
	v := 1 - math.Exp(-float64(daysSinceActivity)/30.0)
	return clamp01(v)
}
