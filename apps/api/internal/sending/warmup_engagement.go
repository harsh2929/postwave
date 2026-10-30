// SPDX-License-Identifier: AGPL-3.0-only
//
// warmup_engagement.go — engagement-driven adjustment of the warmup
// daily cap. The base curve in warmup.go is static; production
// reality is that a tenant whose engagement crashes mid-ramp must
// SLOW DOWN before they pile on more bad signal. This file is the
// modifier the dispatcher consults right after CapForDay() returns
// the base value.
//
// Inputs the modifier reads:
//
//   • complaint_rate over the last 7d (the canonical Gmail/Yahoo
//     postmaster signal)
//   • bounce_rate over the last 7d
//   • open_rate over the last 7d (when engagement is THAT low, we
//     suspect the list quality is poor — slow down regardless)
//
// The output is a multiplier in [0, 1] applied to the base cap. We
// never INCREASE the cap from this signal — if engagement is great
// the customer is already free to ramp on schedule; the modifier
// only ever slows things down.
//
// Bands (calibrated to the public Google + Microsoft postmaster guidance).
// Note these are the *throttle* bands, deliberately more forgiving than the
// hard gate: campaigns.CheckEmailCompliance blocks outright at a 0.30%
// complaint rate, so the 0.50%+ bands below exist only to slow a ramp that
// is already heading for that wall.
//
//   • 1.00x — healthy:    complaint < 0.10%, bounce < 2%, open ≥ 5%
//   • 0.75x — warning:    complaint < 0.50%, bounce < 5%, open ≥ 2%
//   • 0.50x — degraded:   complaint < 1.00%, bounce < 7%
//   • 0.25x — critical:   complaint < 2.00%, bounce < 10%
//   • 0.00x — halt:       complaint ≥ 2.00% OR bounce ≥ 10%
//
// The 0.00x case is what hands the auto-rotation system its trigger:
// when EngagementMultiplier returns 0, the dispatcher should route
// all future sends for this IP to a different pool member while
// the operator investigates. The dispatcher wiring lives outside
// this file; this is the policy.

package sending

// EngagementSnapshot is the rolled-up 7-day signal the modifier
// reads. The dispatcher fetches this from the per-IP or per-pool
// reputation store (see pool_reputation.go for the per-pool roll-up).
type EngagementSnapshot struct {
	// Sent is the count of messages sent in the window. We require
	// MinSampleSize before the modifier applies — at low sample size
	// the rate estimates are too noisy to drive a cap change.
	Sent int64
	// Bounced + Complained + Opened are the raw event counts. All
	// rates are computed as event / Sent.
	Bounced    int64
	Complained int64
	Opened     int64
}

// MinSampleSize is the threshold below which the modifier returns 1.0
// (no slowdown): below it, a single unhappy recipient dominates the rate
// and would throttle a tenant on noise.
//
// (This previously said it mirrored "the free_pool_guardrails MinSampleSize
// so the two systems converge". There is no free_pool_guardrails — it was
// referenced by comment only and never built. The noise floor stands on its
// own; the enforcing gate is campaigns.CheckEmailCompliance.)
const MinSampleSize = 100

// EngagementMultiplier returns the [0, 1] scalar to apply to the
// base warmup cap. The dispatcher computes:
//
//	finalCap = int(float64(CapForDay(day, tier)) * EngagementMultiplier(snapshot))
//
// Calibration choices documented in the package doc above.
func EngagementMultiplier(s EngagementSnapshot) float64 {
	if s.Sent < MinSampleSize {
		// Not enough data — let the base curve run. Punishing a
		// brand-new ramp because of statistical noise would mean
		// nobody could ever warm up an IP.
		return 1.0
	}
	br := float64(s.Bounced) / float64(s.Sent)
	cr := float64(s.Complained) / float64(s.Sent)

	// Halt thresholds — the auto-rotation system reads these.
	if cr >= 0.020 || br >= 0.100 {
		return 0.0
	}
	if cr >= 0.010 || br >= 0.070 {
		return 0.25
	}
	if cr >= 0.005 || br >= 0.050 {
		return 0.50
	}
	if cr >= 0.0010 || br >= 0.020 {
		return 0.75
	}
	// All rates healthy. Apply a softer slowdown when open_rate is
	// extremely low — that signals list quality is poor even if no
	// bounce/complaint signal has surfaced yet.
	if s.Sent >= 1_000 {
		or := float64(s.Opened) / float64(s.Sent)
		if or < 0.02 { // <2% opens
			return 0.75
		}
		if or < 0.05 { // <5% opens
			return 0.90
		}
	}
	return 1.0
}

// CapForDayWithEngagement is the convenience composition the
// dispatcher actually calls. baseCap is the curve cap from
// CapForDay(); the modifier slows it down (never speeds it up).
//
//	finalCap := CapForDayWithEngagement(day, tierLimit, snapshot)
//
// We never return a value below 1 when the multiplier is positive
// (a cap of "1 message per day" is honest signal to the customer
// that we're throttling them, vs a cap of 0 which reads as "broken").
// When the multiplier is exactly 0 (halt), we return 0 — the
// dispatcher uses that as the route-elsewhere signal.
func CapForDayWithEngagement(day, tierLimit int, snapshot EngagementSnapshot) int {
	base := CapForDay(day, tierLimit)
	if base <= 0 {
		return 0
	}
	mul := EngagementMultiplier(snapshot)
	if mul <= 0 {
		return 0
	}
	cap := int(float64(base) * mul)
	if cap < 1 {
		cap = 1
	}
	return cap
}
