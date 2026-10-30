// SPDX-License-Identifier: AGPL-3.0-only

package abtests

import "fmt"

// What the auto-promote scheduler decides to send, and on what grounds.
//
// The scheduler used to throw the evaluator's verdict away:
//
//	winnerID, decided := EvaluateWinnerWithDeps(...)
//	if !decided {
//	    // Tie or no clear signal. Fall back to "first variant" ...
//	    if len(results) > 0 { winnerID = results[0].VariantID; decided = true }
//	}
//
// `ListResults` orders by `variant_label`, so `results[0]` is always variant A.
// Every test that failed its significance bar promoted A, mailed it to the whole
// held-back audience, and stamped `winner_decided_at` — so the report said "A
// won" about a comparison that had decided nothing.
//
// Two things were wrong, and they are separable:
//
//  1. The CHOICE was alphabetical. Label order is not a tie-break; it is a
//     standing bias toward whichever arm sorts first, and it can ship the
//     worse-performing variant to everyone remaining.
//  2. The RECORD was a lie. "B won" and "we shipped B because the window closed
//     and it was ahead" are different facts, and only one of them is evidence.
//
// Sending something is still right — the operator asked for auto-promotion, and
// a held-back audience that never receives anything is its own failure. So the
// send proceeds, on the best observed arm, and says so.
//
// This got worse, not better, when the statistical bar was raised: a 500-per-arm
// floor plus a Šidák correction means a 2,000-subscriber list sampled at 20%
// gives 200 per arm and can never decide legitimately — so every such test took
// the alphabetical path.

// AutoPromotion is the scheduler's decision about which variant to roll out.
type AutoPromotion struct {
	// VariantID to promote. Empty means promote nothing.
	VariantID string
	// Conclusive is true only when the statistical evaluator decided. When
	// false the send still happens, but nothing may present it as a result.
	Conclusive bool
	// Reason is operator-facing text explaining the basis of the choice.
	Reason string
}

// chooseAutoPromotion turns the evaluator's verdict into a decision.
//
// `winnerID`/`decided` are EvaluateWinnerWithDeps's output. When it decided,
// that verdict stands untouched. When it did not, this picks the best observed
// arm and marks the choice inconclusive.
func chooseAutoPromotion(results []VariantResult, winnerID string, decided bool) AutoPromotion {
	if decided && winnerID != "" {
		return AutoPromotion{
			VariantID:  winnerID,
			Conclusive: true,
			Reason:     "statistically significant winner",
		}
	}
	if len(results) == 0 {
		return AutoPromotion{}
	}

	best := results[0]
	bestRate := observedOpenRate(best)
	for _, candidate := range results[1:] {
		if rate := observedOpenRate(candidate); rate > bestRate {
			best, bestRate = candidate, rate
		}
	}
	return AutoPromotion{
		VariantID:  best.VariantID,
		Conclusive: false,
		Reason: fmt.Sprintf(
			"inconclusive: no variant cleared the significance bar; promoted the "+
				"best observed arm (%.1f%% open rate over %d recipients) because "+
				"the test window closed and auto-promotion is enabled",
			bestRate*100, best.RecipientsCount),
	}
}

// observedOpenRate is the tie-break signal: the raw rate, with no inference
// attached. Deliberately not the configured winner metric — that metric is the
// one the evaluator already failed to resolve, and re-running the same
// comparison at a lower standard would dress a coin flip as a measurement.
// Zero recipients rank last rather than dividing by zero.
func observedOpenRate(r VariantResult) float64 {
	if r.RecipientsCount <= 0 {
		return 0
	}
	return float64(r.Opens) / float64(r.RecipientsCount)
}
