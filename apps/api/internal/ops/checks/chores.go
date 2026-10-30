// SPDX-License-Identifier: AGPL-3.0-only

// chores.go -- the CLOCKS lane: obligations that come due by the calendar
// rather than by anything a probe can observe.
//
// These are the controls that have no failure signal. Nothing errors when the
// access review is six months overdue; nothing errors when the backup has
// never actually been restored. The failure surfaces once, at the worst
// possible moment, and the only defence is a clock.
//
// Each carries a "Mark done" action bound to ops.Store.Tick, so ticking one
// records WHO, WHEN and WHAT THEY DID in ops_manual_log and re-arms the
// cadence. A tick with no note is refused: an unexplained tick is a click, and
// a click is not evidence.
package checks

import (
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

const (
	choreMonthly   = 30 * 24 * time.Hour
	choreQuarterly = 90 * 24 * time.Hour
	choreHalfYear  = 182 * 24 * time.Hour
)

// tickAction is the one button every chore carries. DangerConfirm rather than
// DangerSafe: ticking asserts on the record that a control was exercised, and
// a one-click "done" next to a chore nobody performed is how an evidence trail
// becomes a liability.
func tickAction() *ops.ActionMeta {
	return &ops.ActionMeta{
		ID:        "tick",
		Label:     "Mark done",
		Danger:    ops.DangerConfirm,
		InputHint: "what you actually did (recorded against your operator id)",
	}
}

// ManualChores is every KindManual check, so main.go can bind the tick runner
// to each without re-listing them and drifting.
var ManualChores []ops.Check

func init() {
	ManualChores = []ops.Check{
		{
			ID: "security.access-review", Group: "Legal",
			Domain: "security", Owner: "security",
			Title:    "Operator and key access review",
			Severity: ops.SevHigh,
			Why: "Access accumulates. Nobody removes an operator or an API key on the day they stop needing it, and no probe can tell a key that is still needed from one that is merely still working. " +
				"The gap between the two is the blast radius of the next credential leak.",
			Kind: ops.KindManual, Cadence: choreQuarterly,
			Remediation: "Review platform_operators (including ip_allowlist entries and disabled_at), tenant API keys and their scopes, and any standing third-party access. " +
				"Remove what is no longer needed and record the count you removed in the tick note.",
			Runbook: "docs/runbooks/incident-response.md",
			Action:  tickAction(),
		},
		{
			ID: "security.dependency-audit", Group: "Releases",
			Domain: "security", Owner: "security",
			Title:    "Dependency vulnerability sweep",
			Severity: ops.SevHigh,
			Why: "A dependency is safe until the day it is not, and that day is announced by a third party rather than by our build. " +
				"Between sweeps the posture only decays.",
			Kind: ops.KindManual, Cadence: choreMonthly,
			Remediation: "Run the npm/Go/Rust/Python/PHP scans (see docs/security/), triage anything new, and record what you upgraded or accepted, with the reason, in the tick note.",
			Action:      tickAction(),
		},
		{
			ID: "database.restore-drill", Group: "Releases",
			Domain: "database", Owner: "platform",
			Title:    "Backup restore drill",
			Severity: ops.SevCritical,
			Why: "A backup that has never been restored is a hypothesis. Backup jobs report success on writing bytes, not on those bytes being a database, " +
				"and the difference is only ever discovered at the exact moment it cannot be fixed.",
			Kind: ops.KindManual, Cadence: choreQuarterly,
			Remediation: "Restore the most recent base backup plus WAL into a scratch database, run the migration runner against it to confirm schema consistency, and check row counts on a few large tables. " +
				"Record the restore duration in the tick note -- that number is the recovery-time objective, and guessing it is how it turns out to be wrong.",
			Action: tickAction(),
		},
		{
			ID: "compliance.register-review", Group: "Vendors",
			Domain: "compliance", Owner: "legal",
			Title:    "Regulatory obligation register review",
			Severity: ops.SevHigh,
			Why: "The register's manual rows are asserted by a named owner, not proved by a probe, so they are exactly as current as the last time somebody looked. " +
				"An unreviewed legal obligation reads as a passing build.",
			Kind: ops.KindManual, Cadence: choreQuarterly,
			Remediation: "Run `node scripts/compliance/probe.mjs --gate`, then re-read every row with strength=manual and confirm its recorded status is still true. " +
				"Record which rows changed in the tick note.",
			Action: tickAction(),
		},
		{
			ID: "deliverability.dns-review", Group: "Vendors",
			Domain: "deliverability", Owner: "platform",
			Title:    "SPF, DKIM and DMARC review",
			Severity: ops.SevHigh,
			Why: "Authentication records drift as vendors are added and removed, and the SPF lookup limit is a cliff rather than a slope. " +
				"Mail keeps being accepted right up until a receiver decides it should not be.",
			Kind: ops.KindManual, Cadence: choreQuarterly,
			Remediation: "Check the SPF include chain against the 10-lookup limit, confirm DKIM selectors resolve for every active sending domain, and read the DMARC aggregate reports for alignment failures. " +
				"Record what you changed in the tick note.",
			Action: tickAction(),
		},
		{
			ID: "trust.incident-drill", Group: "Releases",
			Domain: "trust", Owner: "platform",
			Title:    "Incident response drill",
			Severity: ops.SevRoutine,
			Why: "The first time anyone declares an incident should not be during an incident. Untested runbooks are wrong in ways only running them reveals, " +
				"and the status page is the product during an outage.",
			Kind: ops.KindManual, Cadence: choreHalfYear,
			Remediation: "Declare a test incident in the console, post an update, publish to the status page, and resolve it. Note anything in the runbook that turned out to be wrong.",
			Runbook:     "docs/runbooks/incident-response.md",
			Action:      tickAction(),
		},
		{
			ID: "privacy.dsar-drill", Group: "Releases",
			Domain: "privacy", Owner: "legal",
			Title:    "Subject-request rehearsal",
			Severity: ops.SevHigh,
			Why: "Access and erasure requests carry statutory deadlines, and the machinery is only proven by running it end to end. " +
				"privacy.erasure-integrity catches an erasure that deleted nothing; only a rehearsal catches an export that omits a table.",
			Kind: ops.KindManual, Cadence: choreHalfYear,
			Remediation: "Run an export and an erasure against a seeded test subject. Confirm the export covers every store holding subject data and that the erasure actually removes rows. " +
				"Record the elapsed time against the statutory deadline.",
			Runbook: "docs/runbooks/customer-data-export.md",
			Action:  tickAction(),
		},
		{
			ID: "cost.spend-review", Group: "Vendors",
			Domain: "cost", Owner: "founder",
			Title:    "Infrastructure and vendor spend review",
			Severity: ops.SevRoutine,
			Why: "Unit economics fail quietly. A runaway job, a forgotten environment or a mispriced vendor tier produces no error and no alert -- " +
				"it produces an invoice, a month later, for a decision nobody remembers making.",
			Kind: ops.KindManual, Cadence: choreMonthly,
			Remediation: "Read the AWS and vendor invoices against last month's. Investigate any line that moved more than the customer base did, and record the largest delta and its cause in the tick note.",
			Action:      tickAction(),
		},
	}
	for _, c := range ManualChores {
		ops.Register(c)
	}
}
