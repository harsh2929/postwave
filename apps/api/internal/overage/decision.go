// SPDX-License-Identifier: AGPL-3.0-only
//
// Package overage holds the pure decision logic for metered send overage
// (BILL-052). It has no DB or Stripe dependency so the "should this over-cap
// send be allowed, and how many units does it cost" question is fully unit
// testable and lives in exactly one place.
package overage

// Preference is a tenant's overage opt-in plus an optional ceiling on how many
// billable overage units they'll tolerate in a period.
type Preference struct {
	// Enabled is the user's opt-in. False (the default) means the included
	// allowance is a hard cap.
	Enabled bool
	// Cap, when non-nil, is the maximum billable overage UNITS allowed in a
	// period; a send that would exceed it is blocked. Nil means "no ceiling"
	// (uncapped overage) — deliberately distinct from a Cap of 0.
	Cap *int
}

// Decision is the outcome of evaluating a send batch that has already exceeded
// the tier's included allowance.
type Decision struct {
	// Allow is true when the batch may proceed past the included cap.
	Allow bool
	// OverageUnits is the projected cumulative overage for the period after this
	// batch (always >= 0). It is informational for the caller's 402 payload; the
	// authoritative billed quantity is reconciled separately from delivered
	// usage, never from this projection.
	OverageUnits int
}

// Decide answers whether a send that breaches the included allowance may
// proceed. It is invoked ONLY after the base plan check has already failed
// (i.e. current+requested > includedCap).
//
//   - current      usage already recorded this period
//   - requested    units in the batch being sent
//   - includedCap  the tier's included allowance
//
// Off  -> block (the included allowance is a hard cap; today's behavior).
// On, uncapped        -> allow (metered).
// On, within ceiling  -> allow (metered).
// On, beyond ceiling  -> block (the user's spend ceiling is a real limit).
func Decide(current, requested, includedCap int, p Preference) Decision {
	units := current + requested - includedCap
	if units < 0 {
		units = 0
	}
	if !p.Enabled {
		return Decision{Allow: false, OverageUnits: units}
	}
	if p.Cap != nil && units > *p.Cap {
		return Decision{Allow: false, OverageUnits: units}
	}
	return Decision{Allow: true, OverageUnits: units}
}
