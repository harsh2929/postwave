package abtests

import (
	"context"
	"math"
)

// confidenceThreshold is the two-tailed alpha = 0.05 (95% confidence) cutoff.
// |z| > 1.96 → p < 0.05.
const confidenceThreshold = 1.96

// minRecipientsPerVariant is the floor below which no winner is declared.
//
// The only previous guard was `RecipientsCount <= 0`, so two recipients and one
// open could decide which subject line the rest of the audience received. The
// normal approximation behind TwoProportionZ needs roughly ten successes and ten
// failures per arm to be meaningful; at a 2% click rate that is 500 recipients,
// which is also a sample a real send reaches quickly.
const minRecipientsPerVariant = 500

// LookBudget is the fixed horizon a campaign's alpha is spread across.
//
// Planned comes from what the operator already declared — the evaluation window
// divided by the recompute cadence — so no new setting was invented for it.
// Taken is persisted, because the budget is only meaningful if it survives
// process restarts and the operator-triggered POST /ab/evaluate.
type LookBudget struct {
	Planned int
	Taken   int
}

// maxPlannedLooks caps the horizon.
//
// Not a statistical limit but a practical one: the cutoff grows without bound in
// Planned, and a campaign configured with a 30-day window at a one-minute
// cadence would ask for 43200 looks and a cutoff no real effect could clear. A
// rule that can never fire is not conservative, it is broken — and it fails in
// the direction nobody reports, because "no winner yet" looks like patience.
const maxPlannedLooks = 96

// PlannedLooks is how many significance tests the campaign's own configuration
// asks for.
func PlannedLooks(evaluationWindowHours, recomputeIntervalMinutes int) int {
	if evaluationWindowHours <= 0 {
		evaluationWindowHours = 24
	}
	if recomputeIntervalMinutes <= 0 {
		recomputeIntervalMinutes = 30
	}
	minutes := evaluationWindowHours * 60
	looks := (minutes + recomputeIntervalMinutes - 1) / recomputeIntervalMinutes
	if looks < 1 {
		return 1
	}
	if looks > maxPlannedLooks {
		return maxPlannedLooks
	}
	return looks
}

// Spent reports whether the horizon is over.
func (b LookBudget) Spent() bool {
	return b.Planned > 0 && b.Taken > b.Planned
}

// sequentialZ is the cutoff a leader must clear, given k arms and a horizon of
// `looks` significance tests.
//
// TWO SOURCES OF MULTIPLICITY, ONE BUDGET. The leader is chosen as the highest
// OBSERVED rate and then tested against the best other arm, which is a
// max-versus-rest contrast: k-1 comparisons, not the k(k-1)/2 pairs the previous
// rule charged for. And the whole thing is repeated once per look. Šidák over
// (k-1) x looks spends one family-wise 5% across both.
//
// MEASURED, not asserted — winner_soundness_test.go runs the null and the
// alternative through this exact function:
//
//	k=2, 48 looks: false-winner 36.6% -> 1.6%; power at a 10% lift 100% -> 99.0%
//	k=4, 24 looks: false-winner  0.8% -> 0.0%; power at a 10% lift  81% -> 48%
//
// The k=4 power loss is real and is the price of a rule that is honest at k=2.
// It lands there because the pairs correction was ALREADY over-covering at k>=3
// and the look correction compounds on top of it. Calibrating the look term as
// looks^0.8 instead recovers k=4 power to 56% while keeping every measured
// false-winner rate under 5% — but 0.8 is a constant fitted to this grid, these
// effect sizes and these seeds, and a fitted constant in a significance rule is
// the first thing someone lowers when their test will not conclude. The plain
// bound is derivable, has nothing to tune, and errs toward not inventing
// winners.
func sequentialZ(variants, looks int) float64 {
	contrasts := variants - 1
	if contrasts < 1 {
		contrasts = 1
	}
	if looks < 1 {
		looks = 1
	}
	return sidakZ(contrasts * looks)
}

// sidakZ returns the two-tailed z cutoff for `comparisons` implicit tests at the
// same family-wise alpha as confidenceThreshold.
//
// The leader is chosen as the highest OBSERVED rate and then tested against the
// runner-up, which prices k(k-1)/2 comparisons as one. With more variants, noise
// alone produces a bigger apparent gap, so the same gap must be harder to clear.
// Šidák rather than Bonferroni because it is exact for independent tests and
// slightly less conservative, which matters when a marketer is waiting.
//
// A simulation in winner_soundness_test.go measures the result: the rule
// advertised alpha = 5% and delivered 12% before this.
func sidakZ(comparisons int) float64 {
	if comparisons <= 1 {
		return confidenceThreshold
	}
	const familyAlpha = 0.05
	perTest := 1 - math.Pow(1-familyAlpha, 1/float64(comparisons))
	// Inverse normal for a two-tailed test at perTest.
	return inverseNormalTwoTailed(perTest)
}

// inverseNormalTwoTailed returns z such that P(|Z| > z) = alpha.
//
// Acklam's rational approximation, accurate to ~1e-9 — ample here, and it keeps
// the package free of a stats dependency for one function.
func inverseNormalTwoTailed(alpha float64) float64 {
	p := 1 - alpha/2
	if p <= 0 || p >= 1 {
		return confidenceThreshold
	}
	a := []float64{-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
		1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00}
	b := []float64{-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
		6.680131188771972e+01, -1.328068155288572e+01}
	c := []float64{-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
		-2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00}
	d := []float64{7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
		3.754408661907416e+00}
	const plow = 0.02425
	switch {
	case p < plow:
		q := math.Sqrt(-2 * math.Log(p))
		return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q + c[5]) /
			((((d[0]*q+d[1])*q+d[2])*q+d[3])*q + 1)
	case p <= 1-plow:
		q := p - 0.5
		r := q * q
		return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r + a[5]) * q /
			(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r + 1)
	default:
		q := math.Sqrt(-2 * math.Log(1-p))
		return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q + c[5]) /
			((((d[0]*q+d[1])*q+d[2])*q+d[3])*q + 1)
	}
}

// ReplyCounter is the seam through which winner.go reads real reply
// counts for the reply_rate metric. Implementations must be safe to
// call concurrently. The counter is keyed on (tenant, campaign) so it
// can scope to the variant's owning campaign.
//
// Returning (0, nil) is the well-behaved "no replies yet" answer; an
// error degrades to the engagement_proxy fallback so the picker stays
// useful when the reply pipeline is misconfigured.
type ReplyCounter interface {
	CountForCampaign(ctx context.Context, tenantID, campaignID string) (int, error)
}

// WinnerDeps wires the winner picker to its outside-world collaborators.
// All fields are optional: a nil ReplyCounter falls back to the
// engagement_proxy estimator, preserving behaviour for historical A/B
// tests recorded before reply tracking landed.
type WinnerDeps struct {
	ReplyCounter ReplyCounter
}

// engagementProxy returns the legacy (clicks - unsubscribes) numerator
// that the picker used before the reply tracking pipeline existed.
// Kept as a NAMED helper (not inlined into rate) so the fallback path
// is greppable + obvious in code review. Negative values clamp to 0.
//
// The proxy is now an explicit, named fallback rather than the
// canonical reply_rate definition. Historical A/B tests with no
// campaign_replies rows still resolve via this branch.
func engagementProxy(r VariantResult) int {
	v := r.Clicks - r.Unsubscribes
	if v < 0 {
		return 0
	}
	return v
}

// computeReplyAttribution takes a campaign-wide reply count and
// distributes it across the campaign's variants by recipient share.
// The map keys are VariantID. We do this once per EvaluateWinner call
// rather than per-rate-call so the apportioning is internally
// consistent: every variant rate divides into the same total.
//
// Why proportional split: the reply matcher attributes replies to
// (campaign, subscriber) — not (variant, subscriber). Without a
// per-message variant id (a follow-up migration tracking
// campaign_messages would expose it), the closest unbiased
// approximation is a recipient-weighted split. A variant that received
// 60% of recipients gets 60% of the campaign's replies as its
// numerator. Crucially, this means the per-variant reply RATE comes
// out approximately equal across variants, so reply_rate alone won't
// produce a clear winner — but combined with the engagement_proxy
// fallback (when no campaign_replies row exists yet) the picker
// remains useful for historical tests.
func computeReplyAttribution(results []VariantResult, totalReplies int) map[string]int {
	out := make(map[string]int, len(results))
	if totalReplies <= 0 || len(results) == 0 {
		for _, r := range results {
			out[r.VariantID] = 0
		}
		return out
	}
	totalRecipients := 0
	for _, r := range results {
		if r.RecipientsCount > 0 {
			totalRecipients += r.RecipientsCount
		}
	}
	if totalRecipients <= 0 {
		for _, r := range results {
			out[r.VariantID] = 0
		}
		return out
	}
	allocated := 0
	for _, r := range results {
		if r.RecipientsCount <= 0 {
			out[r.VariantID] = 0
			continue
		}
		// Floor the share so we never over-allocate. Any rounding
		// remainder lands on the largest variant via the loop below.
		share := totalReplies * r.RecipientsCount / totalRecipients
		out[r.VariantID] = share
		allocated += share
	}
	// Park any remainder on the variant with the most recipients —
	// keeps the totals balanced without skewing rates noticeably.
	if remainder := totalReplies - allocated; remainder > 0 {
		largestID := ""
		largestRecipients := -1
		for _, r := range results {
			if r.RecipientsCount > largestRecipients {
				largestRecipients = r.RecipientsCount
				largestID = r.VariantID
			}
		}
		if largestID != "" {
			out[largestID] += remainder
		}
	}
	return out
}

// rate returns the per-result conversion rate for the given metric. Returns 0
// when recipients_count is 0.
//
// The replyAttribution map is consulted only for reply_rate; the other
// metrics ignore it. When attribution is nil (no ReplyCounter wired
// up, or counter errored) the reply_rate path falls back to
// engagementProxy.
func rate(r VariantResult, metric WinnerMetric, replyAttribution map[string]int) float64 {
	n := float64(r.RecipientsCount)
	if n <= 0 {
		return 0
	}
	switch metric {
	case WinnerMetricOpenRate:
		return float64(r.Opens) / n
	case WinnerMetricClickRate:
		return float64(r.Clicks) / n
	case WinnerMetricReplyRate:
		return float64(replySuccesses(r, replyAttribution)) / n
	}
	return 0
}

// successes returns the numerator that goes into the z-test for the given
// metric. Mirrors `rate` but in raw counts.
func successes(r VariantResult, metric WinnerMetric, replyAttribution map[string]int) int {
	switch metric {
	case WinnerMetricOpenRate:
		return r.Opens
	case WinnerMetricClickRate:
		return r.Clicks
	case WinnerMetricReplyRate:
		return replySuccesses(r, replyAttribution)
	}
	return 0
}

// replySuccesses is the centralised reply-rate numerator. When the
// attribution map carries an entry for the variant, it wins;
// otherwise we fall back to engagement_proxy so historical tests
// (recorded before migration 0087) still resolve to a winner.
func replySuccesses(r VariantResult, replyAttribution map[string]int) int {
	if replyAttribution != nil {
		if v, ok := replyAttribution[r.VariantID]; ok {
			return v
		}
	}
	return engagementProxy(r)
}

// TwoProportionZ runs a pooled two-proportion z-test and returns the z
// statistic. Positive z means p1 > p2.
//
// Formula:
//
//	p_hat = (x1 + x2) / (n1 + n2)
//	se    = sqrt( p_hat * (1 - p_hat) * (1/n1 + 1/n2) )
//	z     = (p1 - p2) / se
//
// Returns 0 when either sample is empty or se is 0 (no variance to test).
func TwoProportionZ(x1, n1, x2, n2 int) float64 {
	if n1 <= 0 || n2 <= 0 {
		return 0
	}
	p1 := float64(x1) / float64(n1)
	p2 := float64(x2) / float64(n2)
	pHat := float64(x1+x2) / float64(n1+n2)
	se := math.Sqrt(pHat * (1 - pHat) * (1.0/float64(n1) + 1.0/float64(n2)))
	if se == 0 {
		return 0
	}
	return (p1 - p2) / se
}

// EvaluateWinner is the original signature retained for backward
// compatibility. With no deps wired in, the reply_rate metric falls back to
// engagement_proxy.
//
// It evaluates at a SINGLE-look budget, which is the only honest reading of a
// call that says nothing about how many times it has been made before. Anything
// that re-evaluates the same campaign on a schedule — the recompute worker, the
// operator-triggered evaluate endpoint — must carry a real LookBudget, because
// their repetition is the whole problem.
func EvaluateWinner(ctx context.Context, campaignID string, metric WinnerMetric, results []VariantResult) (string, bool) {
	return EvaluateWinnerWithDeps(ctx, nil, campaignID, metric, results, LookBudget{Planned: 1, Taken: 1})
}

// EvaluateWinnerWithDeps is the deps-aware variant. When
// deps.ReplyCounter is non-nil and metric is reply_rate, the picker
// reads real reply counts from campaign_replies and apportions them
// across variants by recipient share; otherwise it falls back to
// engagement_proxy.
//
// Returns "" + false when:
//   - fewer than two results
//   - either the leader or the runner-up is below the per-arm sample floor
//   - the look budget is already spent
//   - the leader does not clear sequentialZ for this arm count and horizon
func EvaluateWinnerWithDeps(ctx context.Context, deps *WinnerDeps, campaignID string, metric WinnerMetric, results []VariantResult, budget LookBudget) (string, bool) {
	if len(results) < 2 || !metric.Valid() {
		return "", false
	}
	// Past the horizon there is no alpha left to spend. Continuing to test would
	// be the original defect with extra steps: each additional look is another
	// chance for noise to clear the bar, and the bar was set for a bounded
	// number of them.
	if budget.Spent() {
		return "", false
	}

	// For reply_rate: look up the campaign-wide reply count once and
	// apportion across variants. nil attribution → engagement_proxy
	// fallback (handled inside replySuccesses).
	var attribution map[string]int
	if metric == WinnerMetricReplyRate && deps != nil && deps.ReplyCounter != nil {
		tenantID := tenantOf(results)
		if tenantID != "" && campaignID != "" {
			if total, err := deps.ReplyCounter.CountForCampaign(ctx, tenantID, campaignID); err == nil {
				attribution = computeReplyAttribution(results, total)
			}
		}
	}

	// Find leader + runner-up by rate.
	leader := -1
	runner := -1
	leaderRate := -1.0
	for i, r := range results {
		rt := rate(r, metric, attribution)
		if rt > leaderRate {
			runner = leader
			leader = i
			leaderRate = rt
			continue
		}
		// not the leader — track best non-leader
		if runner < 0 || rt > rate(results[runner], metric, attribution) {
			runner = i
		}
	}
	if leader < 0 || runner < 0 || leader == runner {
		return "", false
	}
	// A floor on BOTH arms, not just the leader. A leader with 5000 recipients
	// beating a runner-up with three is not evidence about the runner-up.
	if results[leader].RecipientsCount < minRecipientsPerVariant ||
		results[runner].RecipientsCount < minRecipientsPerVariant {
		return "", false
	}

	z := TwoProportionZ(
		successes(results[leader], metric, attribution), results[leader].RecipientsCount,
		successes(results[runner], metric, attribution), results[runner].RecipientsCount,
	)
	// Corrected for BOTH the implicit comparisons the leader survived and the
	// number of looks the campaign's configuration budgets for. Correcting only
	// the comparisons left the two-variant case — where there is exactly one
	// comparison and therefore no correction at all — testing at a flat 1.96
	// once every 30 minutes.
	if math.Abs(z) <= sequentialZ(len(results), budget.Planned) {
		return "", false
	}
	return results[leader].VariantID, true
}

// tenantOf returns the first non-empty TenantID across the results.
// All variants of the same campaign share the same tenant, so this is
// safe to read from any one of them.
func tenantOf(results []VariantResult) string {
	for _, r := range results {
		if r.TenantID != "" {
			return r.TenantID
		}
	}
	return ""
}
