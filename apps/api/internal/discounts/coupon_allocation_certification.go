// SPDX-License-Identifier: AGPL-3.0-only
//
// coupon_allocation_certification.go — what a human still has to establish
// before CouponAllocationAvailable may be set to true, and why each item is not
// something a test in this repository can settle.
//
// READ THIS BEFORE FLIPPING THE GATE.
//
// The gate's original comment named five prerequisites. Four of them were
// machinery nobody had written; they are written now, and they are tested:
//
//   - reservation expiry / release — Repo.ExpireCouponReservations,
//     Repo.ReleaseCouponAssignment, Repo.ConfirmCouponReservation
//   - durable entitlement auditing — coupon_entitlement_events, written by
//     database triggers on every coupon_codes / coupon_assignments transition
//     (migration 1970), append-only against the application role, the table
//     owner, and a superuser alike
//   - abuse controls — coupon_pools.max_codes_per_subscriber and
//     max_codes_per_campaign, enforced by coupon_assignment_quota_guard
//   - reconciliation — Repo.ReconcileCouponPool, which runs in a READ ONLY
//     transaction so that "silently fix it" is not expressible
//
// The fifth — provider authority — is not machinery. It is a fact about the
// world, and so are the six other things below. They are listed because the
// difference between "we built the safety rails" and "it is safe to hand out
// money" is precisely this list, and a list that lives in someone's head is a
// list that gets skipped at 4pm on a Friday.
//
// THIS FILE IS DOCUMENTATION, NOT A GUARD. Nothing here can prevent the gate
// from being flipped; a constant is a constant. What it does is make the person
// who flips it answer seven specific questions instead of a vague one.

package discounts

// CouponCertificationItem is one thing a human must establish, with the reason
// it cannot be established by running code.
type CouponCertificationItem struct {
	// ID is a stable handle for referring to the item in a sign-off record.
	ID string
	// Claim is what somebody must be willing to assert.
	Claim string
	// WhyNotTestable is the reason a test cannot assert it in their place.
	// Every entry here is a fact about the world outside this database.
	WhyNotTestable string
	// Evidence is what a reasonable sign-off would be based on.
	Evidence string
}

// CouponAllocationCertificationItems is the complete list of open questions
// standing between the machinery in this package and CouponAllocationAvailable
// being true. It is deliberately exhaustive rather than aspirational: an item
// that is not on it is not being tracked anywhere else.
var CouponAllocationCertificationItems = []CouponCertificationItem{
	{
		ID:    "provider-authority",
		Claim: "We are permitted to mint and void discount codes in this merchant's commerce system, and codes we hand out will be honoured at their checkout.",
		WhyNotTestable: "This is contractual and credential state held outside this repository. A test can observe that our database contains a code; " +
			"it cannot observe that the merchant agreed we may create codes, that the stored provider credential still carries the scope that lets us, " +
			"or that the code resolves to a real discount at their checkout. Every assertion available to a test is an assertion about our own bookkeeping. " +
			"A pool whose provider is 'manual' or 'postwave' hides this even further: nothing in the row records who authorised the codes it contains.",
		Evidence: "Signed merchant authorisation naming who may mint codes; the live provider credential's scope list; one end-to-end redemption performed at the merchant's real checkout with the resulting order.",
	},
	{
		ID:    "repeat-allocation-policy",
		Claim: "One code per subscriber per pool, forever, is the intended product behaviour — or the default has been changed deliberately.",
		WhyNotTestable: "max_codes_per_subscriber defaults to 1 and counts 'redeemed' assignments alongside live ones, so a subscriber who redeems a code from a pool " +
			"can never draw another from that pool. Migration 1970 applied that default to every pre-existing pool. That is correct for a one-per-customer welcome offer " +
			"and WRONG for a monthly-offer or repeat-coupon flow, which would be refused with ErrCouponQuotaExceeded after the first redemption — a refusal that reads as " +
			"an abuse control working rather than as a product rule nobody chose. No test can settle it: both behaviours are correctly implemented, and which one is right " +
			"is a statement about what the offer is for, which lives in the campaign's intent and not in any row this package can read.",
		Evidence: "A named owner's decision on the default, and on whether redeemed assignments should keep counting against the bound; the per-pool overrides set for any pool " +
			"that intends repeat allocation.",
	},
	{
		ID:    "financial-exposure-ceiling",
		Claim: "The maximum money each pool can give away is known, bounded, and owned by someone.",
		WhyNotTestable: "max_codes_per_campaign bounds a COUNT. Money is count times value, and for a provider-backed pool the value lives in the merchant's system, not here — " +
			"coupon_pools carries provider and provider_ref, not a percent or an amount. Nothing this code can read knows whether one code is worth 5% or a free order, " +
			"so nothing this code can compute is an exposure figure. A test asserting 'exposure is acceptable' would be asserting a number it made up.",
		Evidence: "Per-pool exposure written down as count x value in the pool's currency, with a named owner who accepts the loss if the bound is wrong.",
	},
	{
		ID:    "sweeper-is-actually-running",
		Claim: "Reservation expiry runs in production on a known cadence, and someone is paged when it stops.",
		WhyNotTestable: "Repo.ExpireCouponReservations is tested and correct when called. Nothing in this package calls it: scheduling needs a cross-tenant worker scope this package does not own, " +
			"and a cadence is an operational choice. A test proves the sweep works; it cannot prove anyone invokes it, and a sweeper that is never invoked is indistinguishable — from inside the code — " +
			"from one that has nothing to do. That is the failure mode: silent, slow, and visible only as a pool that mysteriously has no codes left.",
		Evidence: "The scheduled job, its cadence, and an alert on sweep lag (oldest reserved_until still held) rather than on job failure alone.",
	},
	{
		ID:    "reconciliation-reaches-a-human",
		Claim: "Reconciliation drift is delivered to a person on a cadence, and there is a defined response to each drift kind.",
		WhyNotTestable: "Repo.ReconcileCouponPool reports drift and deliberately never repairs it, because silent correction destroys the evidence that something went wrong. " +
			"That design only pays off if the report is read. Who reads it, how often, and what they do about CouponDriftAssignmentWithoutHeldCode versus " +
			"CouponDriftSubscriberQuotaBreached are organisational facts. A test can prove the report is accurate and cannot prove it is delivered or acted on.",
		Evidence: "A routed report with an owner, plus a written response per CouponDriftKind — in particular, who is allowed to void a code that was issued twice.",
	},
	{
		ID:    "merchant-side-double-spend",
		Claim: "A code cannot be redeemed more times at the merchant than we intended, including by paths that never touch this system.",
		WhyNotTestable: "Reconciliation compares our inventory to our assignments to our receipts. All three are ours. If a recipient redeems a code directly at the merchant, " +
			"or the merchant's staff issue the same code by hand, nothing in this database changes and every check here still reports Healthy. " +
			"Closing this needs a redemption feed from the provider, which does not exist in this codebase — so the honest statement is that our books are internally consistent, not that they are complete.",
		Evidence: "Either a provider redemption/usage feed reconciled against coupon_entitlement_events, or an accepted, written limitation that per-code usage limits are enforced merchant-side.",
	},
	{
		ID:    "ledger-retention-is-lawful",
		Claim: "Retaining subscriber email and issued code in coupon_entitlement_events indefinitely is lawful for every tenant this is enabled for.",
		WhyNotTestable: "The ledger keeps identity next to a monetary entitlement on purpose: an answer to a chargeback that omits who received the code is not an answer. " +
			"Whether that retention is permitted, for how long, and how it interacts with an erasure request under a given tenant's DPA is a legal determination about documents, " +
			"not a property of a schema. A test can assert the rows exist. Only a lawyer can say they may.",
		Evidence: "A retention period agreed with counsel, the erasure-request carve-out written into the DPA, and — if the period is finite — a reviewed retention migration, since this table refuses DELETE by design.",
	},
	{
		ID:    "pre-ledger-assignments",
		Claim: "Coupon assignments that predate migration 1970 have been dispositioned.",
		WhyNotTestable: "The entitlement ledger starts when its triggers were installed. Rows written before that have no receipts and never will, which reconciliation reports honestly as " +
			"CouponDriftMissingReceipt. Whether those codes should be voided, honoured, or accepted as an evidence gap is a business decision about codes that may already be in recipients' hands. " +
			"A test that back-filled receipts for them would be manufacturing evidence, which is worse than the gap.",
		Evidence: "A reconciliation report per pool taken before enabling allocation, with a recorded decision for each pre-1970 assignment it names.",
	},
}
