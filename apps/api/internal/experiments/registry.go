// SPDX-License-Identifier: AGPL-3.0-only

// Package experiments names every system in this codebase that runs a
// controlled test, and records what each one can and cannot say about it.
//
// There is no shared experiment identity here. Nine systems each grew their own
// store, their own vocabulary for a variant, and their own idea of what
// finishing means — campaign A/B, flow A/B, onsite forms, form variants,
// landing pages, next-best-product, referral programs, and two kinds of
// holdout. They share no table, no interface, and no package.
//
// WHAT THE SCHEMA ACTUALLY SAYS, measured rather than asserted:
//
//	hypothesis   0 of 9
//	owner        0 of 9
//	metric       2 of 9
//	decision     5 of 9
//	versioning   0 of 9
//
// Not one of them records who owns a test or what it was meant to prove. That
// is the finding, and it is worse than "the stores are disjoint": a disjoint
// store can be unified later, but a test whose hypothesis was never written
// down cannot be interpreted afterwards by anyone, in any schema. Six months on,
// `winner_decided_at` is a fact about which arm won and no fact at all about
// what question was being asked.
//
// THIS PACKAGE DOES NOT UNIFY THEM. Migrating nine live systems onto one
// identity is multi-week work with a schema change per system. What it does is
// make the set KNOWN and CLOSED: the registry below is the list, and the
// DB-backed discovery test fails when a tenth store appears in the schema
// without an entry here. That is the whole consumer, and it is enough to be
// worth having — the reason there are nine is that each was added without
// anything noticing the previous eight.
package experiments

// Capability is one fact a shared experiment identity would need.
type Capability string

const (
	// CapHypothesis — what this test was meant to prove. Without it a result is
	// uninterpretable later: the winning arm is known and the question is not.
	CapHypothesis Capability = "hypothesis"
	// CapOwner — who is accountable for stopping it. Without it, an experiment
	// that should have been called weeks ago has nobody to call it.
	CapOwner Capability = "owner"
	// CapMetric — which measure decides, identified and versioned. A metric
	// whose formula changed mid-test silently redefines the result.
	CapMetric Capability = "metric"
	// CapDecision — whether the test concluded, and how. Distinct from "a
	// winner was promoted": an auto-promotion on a timeout is not a decision,
	// which is exactly the distinction campaign A/B had to add separately.
	CapDecision Capability = "decision"
	// CapStoppingPolicy — the rule that says when to stop looking. Its absence
	// is what let campaign A/B peek every 30 minutes at a flat 1.96 and declare
	// a false winner 37% of the time on two variants.
	CapStoppingPolicy Capability = "stopping_policy"
	// CapObjectVersion — which version of the thing under test each arm was.
	// Without it, editing a variant mid-flight rewrites history: the result is
	// attributed to content that was never sent.
	CapObjectVersion Capability = "object_version"
)

// AllCapabilities is the checklist a unified identity would satisfy.
var AllCapabilities = []Capability{
	CapHypothesis, CapOwner, CapMetric, CapDecision, CapStoppingPolicy, CapObjectVersion,
}

// System is one experiment mechanism.
type System struct {
	// Key is this package's name for the system.
	Key string
	// Table is the store the DB-backed discovery test matches against, and the
	// key it reads columns from.
	Table string
	// Surface is what a user would call it.
	Surface string
	// Has lists the capabilities this system genuinely records TODAY. Verified
	// against the live schema by the discovery test — a claim here that the
	// columns do not support is a failure, because an inventory that overstates
	// coverage is worse than none.
	Has []Capability
	// Note is why this system is separate, or what its gap costs.
	Note string
}

// Systems is the closed set. Adding a tenth store to the schema without adding
// it here fails TestEveryExperimentStoreIsRegistered.
var Systems = []System{
	{
		Key: "campaign_ab", Table: "campaign_ab_settings", Surface: "Campaign A/B test",
		Has: []Capability{CapMetric, CapDecision, CapStoppingPolicy},
		Note: "The most developed of the nine, and the only one with a stopping " +
			"policy — a fixed-horizon alpha budget added in 2026-08 after the " +
			"unbounded-peeking rule was measured declaring a false winner 37% of " +
			"the time on two variants. It still records no hypothesis and no owner.",
	},
	{
		Key: "flow_ab", Table: "automation_flow_ab_tests", Surface: "Flow A/B test",
		Has: nil,
		Note: "Records none of the six. Its assignments and results live in two " +
			"further tables with no shared identity, and its runtime is gated off " +
			"behind flowRuntimeQualified, so nothing it would record is produced.",
	},
	{
		Key: "onsite_form", Table: "onsite_form_experiments", Surface: "Onsite form experiment",
		Has: []Capability{CapMetric, CapDecision},
		Note: "Separate from `form_variants` despite both testing forms: onsite " +
			"is the popup/embed surface with its own event stream.",
	},
	{
		Key: "form_variant", Table: "form_variants", Surface: "Form variant",
		Has: nil,
		Note: "Impressions and promotions are tracked in two sibling tables; the " +
			"variant row itself carries no test identity at all.",
	},
	{
		Key: "landing_page", Table: "landing_page_variants", Surface: "Landing page variant",
		Has: nil,
		Note: "A variant list with no experiment wrapper — there is no row " +
			"anywhere that represents 'the landing page test', only the arms.",
	},
	{
		Key: "nbp_strategy", Table: "nbp_strategy_experiments", Surface: "Next-best-product strategy",
		Has: []Capability{CapDecision},
		Note: "Records a decision without a metric, so the stored outcome cannot " +
			"be re-derived from anything.",
	},
	{
		Key: "referral_program", Table: "referral_program_variants", Surface: "Referral program variant",
		Has:  nil,
		Note: "Same shape as landing pages: arms without a test.",
	},
	{
		Key: "campaign_holdout", Table: "campaign_holdouts", Surface: "Campaign holdout",
		Has: []Capability{CapDecision},
		Note: "A holdout IS an experiment — the control arm is the whole point — " +
			"but it is modelled as a property of a campaign rather than as a test.",
	},
	{
		Key: "segment_holdout", Table: "segment_holdouts", Surface: "Segment holdout",
		Has: []Capability{CapDecision},
		Note: "The second holdout mechanism, disjoint from the first. Two answers " +
			"to 'who was held back' that cannot be queried together.",
	},
}

// Missing returns the capabilities a system does not record.
func (s System) Missing() []Capability {
	has := map[Capability]bool{}
	for _, c := range s.Has {
		has[c] = true
	}
	var out []Capability
	for _, c := range AllCapabilities {
		if !has[c] {
			out = append(out, c)
		}
	}
	return out
}

// Coverage counts how many systems record each capability.
//
// Exported because the number is the argument: "nine disjoint stores" invites a
// shrug, and "zero of nine record who owns the test" does not.
func Coverage() map[Capability]int {
	out := map[Capability]int{}
	for _, c := range AllCapabilities {
		out[c] = 0
	}
	for _, s := range Systems {
		for _, c := range s.Has {
			out[c]++
		}
	}
	return out
}
