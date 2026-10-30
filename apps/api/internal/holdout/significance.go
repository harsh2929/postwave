// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"fmt"
	"math"

	"github.com/postwave/postwave/apps/api/internal/abtests"
)

// Whether a lift number is allowed to be shown at all.
//
// The rule this implements is the PRD's, and it is a product rule with teeth:
// "A lift figure from an underpowered test is worse than no figure." A holdout
// on a small list will happily produce a 40% relative lift that is entirely
// sampling noise, and a reader has no way to tell that from a real result — the
// number looks identical. So an underpowered comparison reports that it is
// underpowered, and does not report a lift.
//
// Nothing here invents a new statistic. `abtests.TwoProportionTest` already
// implements the two-proportion z-test used by the A/B surface, including the
// detail that matters most (p-value 1 rather than 0 on empty data, so a
// `p < alpha` caller cannot spuriously fire on no data). It was simply never
// imported by any holdout, control-group or segment code.

const (
	// zAlphaTwoSided is the two-sided critical value at alpha = 0.05.
	zAlphaTwoSided = 1.959963985
	// zBeta is the one-sided critical value for 80% power.
	zBeta = 0.8416212336
	// defaultMinimumRelativeEffect is the smallest relative change worth
	// detecting, as a fraction of the control rate.
	//
	// Expressed relative to the baseline rather than as an absolute rate
	// because "detect a 2-point change" means something very different at a 3%
	// click rate than at a 40% one, and holdouts run across both.
	defaultMinimumRelativeEffect = 0.10
)

// LiftSignificance is the honest form of a lift result.
//
// AbsoluteLift and RelativeLift are pointers so an underpowered comparison
// serialises them as null rather than as 0 — a zero lift and an unmeasurable
// lift are different claims, and JSON has exactly one way to say the second.
type LiftSignificance struct {
	ControlRate   float64  `json:"control_rate"`
	TreatmentRate float64  `json:"treatment_rate"`
	AbsoluteLift  *float64 `json:"absolute_lift"`
	RelativeLift  *float64 `json:"relative_lift"`
	// IncrementalConversions is absolute lift × treatment size — the number a
	// customer actually cares about, and the one most worth suppressing when
	// the comparison cannot support it.
	IncrementalConversions *float64 `json:"incremental_conversions"`
	PValue                 float64  `json:"p_value"`
	CILow                  *float64 `json:"ci_low"`
	CIHigh                 *float64 `json:"ci_high"`
	Powered                bool     `json:"powered"`
	// MinimumDetectableEffect is the smallest absolute difference these sample
	// sizes could distinguish from noise at 80% power. Reported even when
	// powered, because it tells a reader how much precision they bought.
	MinimumDetectableEffect float64 `json:"minimum_detectable_effect"`
	// Reason explains a false Powered, in the words a person needs.
	Reason string `json:"underpowered_reason,omitempty"`
}

// ComputeLiftSignificance runs the two-proportion test and the power check.
//
// control = the held-out arm, treatment = the arm that was sent to.
func ComputeLiftSignificance(controlHits, controlN, treatmentHits, treatmentN int64) LiftSignificance {
	return ComputeLiftSignificanceForEffect(
		controlHits, controlN, treatmentHits, treatmentN,
		defaultMinimumRelativeEffect,
	)
}

// ComputeLiftSignificanceForEffect applies the same two-proportion test while
// using the minimum relative effect frozen on the campaign holdout. Keeping
// this input explicit is load-bearing: a result cannot honestly claim power
// against a convenient package default when the sender configured a different
// effect before assignment.
func ComputeLiftSignificanceForEffect(
	controlHits, controlN, treatmentHits, treatmentN int64,
	minimumRelativeEffect float64,
) LiftSignificance {
	test := abtests.TwoProportionTest(
		abtests.VariantCounts{Sent: int(controlN), Hits: int(controlHits)},
		abtests.VariantCounts{Sent: int(treatmentN), Hits: int(treatmentHits)},
	)
	out := LiftSignificance{
		ControlRate:   test.PA,
		TreatmentRate: test.PB,
		PValue:        test.PValue,
	}
	if minimumRelativeEffect <= 0 || minimumRelativeEffect > 1 ||
		math.IsNaN(minimumRelativeEffect) || math.IsInf(minimumRelativeEffect, 0) {
		out.Reason = "the configured minimum relative effect is invalid"
		return out
	}

	if controlN <= 0 || treatmentN <= 0 {
		out.Reason = "no data on one side of the comparison"
		return out
	}

	// Minimum detectable effect at alpha=0.05, power=0.80, using the pooled
	// proportion — the standard design calculation, run after the fact against
	// the sample sizes actually achieved.
	pooled := float64(controlHits+treatmentHits) / float64(controlN+treatmentN)
	variance := pooled * (1 - pooled) * (1/float64(controlN) + 1/float64(treatmentN))
	out.MinimumDetectableEffect = (zAlphaTwoSided + zBeta) * math.Sqrt(variance)

	// "Powered" means the comparison can support a conclusion — which happens
	// two different ways, and an earlier version of this only allowed one.
	//
	//  1. The data SETTLED it: the observed difference is significant. A 2% vs
	//     4% result over 50k per arm is decisive whatever the design
	//     calculation says about a hypothetical 10% relative change, and
	//     suppressing it would hide a real finding behind a rule written to
	//     hide noise.
	//  2. The design was CAPABLE: the sample could have detected the minimum
	//     effect of interest. Then a null result is a genuine null — the test
	//     looked and found nothing.
	//
	// Only when NEITHER holds is the comparison uninformative, and that is
	// precisely "absence of evidence, not evidence of absence".
	minimumEffectOfInterest := out.ControlRate * minimumRelativeEffect
	significant := out.PValue < (1 - 0.95)
	capable := minimumEffectOfInterest > 0 && out.MinimumDetectableEffect <= minimumEffectOfInterest

	switch {
	case pooled <= 0:
		out.Reason = "no conversions in either arm"
		return out
	case !significant && minimumEffectOfInterest <= 0:
		out.Reason = "control arm produced no conversions, so there is no baseline to lift"
		return out
	case !significant && !capable:
		out.Reason = fmt.Sprintf(
			"this sample cannot detect a %.0f%% relative change and the observed "+
				"difference is not significant (p=%.3f) — absence of evidence, not "+
				"evidence of no effect",
			minimumRelativeEffect*100, out.PValue)
		return out
	}

	out.Powered = true
	absolute := test.Difference
	out.AbsoluteLift = &absolute
	if out.ControlRate > 0 {
		relative := test.LiftPercent
		out.RelativeLift = &relative
	}
	incremental := absolute * float64(treatmentN)
	out.IncrementalConversions = &incremental

	// Confidence interval on the DIFFERENCE, using the unpooled standard error.
	//
	// Unpooled deliberately: the pooled estimate assumes the null hypothesis
	// (both arms share one rate), which is the right assumption for the test
	// and the wrong one for an interval around an observed difference.
	seUnpooled := math.Sqrt(
		out.ControlRate*(1-out.ControlRate)/float64(controlN) +
			out.TreatmentRate*(1-out.TreatmentRate)/float64(treatmentN),
	)
	low := absolute - zAlphaTwoSided*seUnpooled
	high := absolute + zAlphaTwoSided*seUnpooled
	out.CILow, out.CIHigh = &low, &high
	return out
}
