// SPDX-License-Identifier: AGPL-3.0-only

// domains.go — the coverage denominator.
//
// This file answers one question: what surfaces of Moosewave MUST be watched
// before the team can treat this console as a source of truth? It is
// deliberately written independently of what is actually watched today. A
// domain here with no check renders in the board's UNWATCHED lane, which is
// the point — the gap becomes a row somebody owns instead of a silence
// everybody mistakes for health.
//
// Adding a domain is how you say "we now care about this". Deleting one is how
// you say "we never will", and that should be as hard to justify in review as
// deleting a check.
//
// Owners are roles, not names, so the file does not rot when people change
// seats. The role must map to exactly one person at any given time.
package checks

import "github.com/postwave/postwave/apps/api/internal/ops"

func init() {
	for _, d := range []ops.Domain{
		// ---- The pipeline that earns the money -------------------------
		{
			ID: "sending", Label: "Send pipeline", Owner: "platform",
			Why: "Campaigns stop leaving the building. Every hour unobserved is a customer's send window missed, and the backlog compounds silently.",
		},
		{
			ID: "deliverability", Label: "Deliverability & reputation", Owner: "platform",
			Why: "Mail is accepted and then discarded. Nothing errors, the dashboards stay green, and the domain reputation damage is irreversible by the time a human notices.",
		},
		{
			ID: "inbox-placement", Label: "Inbox placement", Owner: "platform",
			Why: "Delivered is not the same as seen. Without seed measurement we cannot distinguish a healthy send from one landing entirely in spam.",
		},
		{
			ID: "campaign-assurance", Label: "Pre-send assurance", Owner: "platform",
			Why: "The gate that stops a bad send is itself a single point of failure: if it stalls, sends queue forever; if it fails open, unchecked mail ships.",
		},
		{
			ID: "flows", Label: "Automation & flows", Owner: "platform",
			Why: "A stalled flow engine is invisible to the customer until a welcome series never arrives. Silent non-sending looks identical to nobody qualifying.",
		},

		// ---- The machinery underneath ----------------------------------
		{
			ID: "queues", Label: "Background workers & schedulers", Owner: "platform",
			Why: "Most of the product is a background job. A dead worker produces no errors — only an absence — which is the hardest failure to notice and the easiest to prevent.",
		},
		{
			ID: "database", Label: "Database, backups & partitions", Owner: "platform",
			Why: "Backup freshness and WAL integrity are only ever discovered to be broken at the moment they are needed, when it is too late to fix.",
		},
		{
			ID: "api", Label: "Public API & SDKs", Owner: "platform",
			Why: "The API is a contract other people's code depends on. A regression here breaks integrations we cannot see and cannot roll back for them.",
		},
		{
			ID: "webhooks", Label: "Outbound webhooks & eventing", Owner: "platform",
			Why: "A dead-lettered event is a customer system silently out of sync with ours, and the divergence grows until someone reconciles by hand.",
		},
		{
			ID: "integrations", Label: "Integrations & write-back", Owner: "platform",
			Why: "A broken connector keeps returning stale data rather than failing, so segments target the wrong people with full confidence.",
		},
		{
			ID: "data-platform", Label: "Warehouse & exports", Owner: "platform",
			Why: "Exports and warehouse syncs feed customer reporting. Stale data there is worse than absent data, because it is trusted.",
		},

		// ---- Who can get in, and what runs where -----------------------
		{
			ID: "identity", Label: "Auth, sessions & access", Owner: "security",
			Why: "Authentication failures lock out every customer at once; authorization failures expose one customer to another. Both are total.",
		},
		{
			ID: "security", Label: "Security posture", Owner: "security",
			Why: "Dependency vulnerabilities, secret exposure and access review are time-decaying: they are fine until an unbounded period of neglect makes them catastrophic.",
		},
		{
			ID: "clients", Label: "Web, desktop & mobile clients", Owner: "platform",
			Why: "A broken release reaches users through stores and CDNs we cannot instantly roll back. Crash-rate regressions are only visible if something watches them.",
		},

		{
			ID: "ai", Label: "AI, models & recommendations", Owner: "platform",
			Why: "A model that stops retraining does not error — it keeps answering, with steadily worse answers, and the product presents them with the same confidence as good ones.",
		},
		{
			ID: "console", Label: "The ops console itself", Owner: "platform",
			Why: "Every other row on this board assumes the board works. An unwatched console is a monitoring system whose own failure mode is a reassuring silence.",
		},

		// ---- Money -----------------------------------------------------
		{
			ID: "billing", Label: "Billing & payments", Owner: "founder",
			Why: "A failed webhook means a customer paid and got nothing, or churned and kept access. Both are silent and both cost money every day they persist.",
		},
		{
			ID: "revenue", Label: "Revenue & metering truth", Owner: "founder",
			Why: "If metered usage and invoiced usage diverge, we are either overcharging customers or giving the product away, and neither shows up as an error.",
		},
		{
			ID: "cost", Label: "Infrastructure & vendor spend", Owner: "founder",
			Why: "Unit economics fail quietly. A runaway job or a mispriced vendor tier is only ever discovered on an invoice a month later.",
		},

		// ---- Legal and trust -------------------------------------------
		{
			ID: "privacy", Label: "Privacy & data subject rights", Owner: "legal",
			Why: "A DSAR or erasure that silently does nothing is a regulatory breach we have already told the data subject was fulfilled.",
		},
		{
			ID: "compliance", Label: "Regulatory obligations", Owner: "legal",
			Why: "Thirteen regimes with recurring obligations. A missed review date is not visible in any code path, so only a clock can catch it.",
		},
		{
			ID: "trust", Label: "Status page & incident comms", Owner: "platform",
			Why: "During an incident, the status page is the product. If it is stale or wrong, we compound an outage with a credibility loss that outlasts it.",
		},

		// ---- Running the company ---------------------------------------
		{
			ID: "launch", Label: "Go-live readiness", Owner: "founder",
			Why: "Launch gates are configuration, not code: live keys, approvals, quotas, legal sign-off. Nothing in the test suite can tell you they are set.",
		},
		{
			ID: "growth", Label: "Signups, activation & retention", Owner: "growth",
			Why: "A broken signup or activation path presents as a quiet week rather than an error, and a quiet week is indistinguishable from a slow market.",
		},
		{
			ID: "support", Label: "Customer support load", Owner: "support",
			Why: "Support backlog is the earliest human signal that something is wrong that no probe has caught yet. Unwatched, it is discovered as churn.",
		},
	} {
		ops.RegisterDomain(d)
	}
}
