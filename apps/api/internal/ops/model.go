// SPDX-License-Identifier: AGPL-3.0-only

// Package ops is the platform-operator console: a compiled registry of checks,
// a reconciler that runs them, and a board that renders them.
//
// The single invariant the whole package rests on: STALENESS IS COMPUTED AT
// READ TIME. See Result.Effective. A check whose reporter dies renders RED
// rather than freezing at its last written value. Nothing about that
// derivation depends on any worker being alive, which is precisely why it can
// be trusted.
package ops

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Kind string

const (
	// KindEvaluated: the reconciler runs Probe on a ticker.
	KindEvaluated Kind = "evaluated"
	// KindHeartbeat: the thing itself reports in. Silence means stale.
	KindHeartbeat Kind = "heartbeat"
	// KindManual: a human ticks it; Cadence re-arms it.
	KindManual Kind = "manual"
)

type Severity string

const (
	SevCritical Severity = "critical" // money, data loss, legal, suspension
	SevHigh     Severity = "high"
	SevRoutine  Severity = "routine"
)

// Danger is an action's blast-radius tier. It decides how the UI asks — one
// click, a modal, or type-the-slug — never whether the server audits (it
// always does).
type Danger string

const (
	DangerSafe          Danger = "safe"            // one click
	DangerConfirm       Danger = "confirm"         // modal
	DangerTypeToConfirm Danger = "type_to_confirm" // type the tenant slug
)

// BlockedMeta declares that a check cannot currently report because of
// something outside engineering's control -- an unopened vendor account, a
// denied quota increase, an unsigned contract.
//
// It is declared on the CHECK, in code, so unblocking is a reviewed PR rather
// than a console click. That is deliberate: a runtime "mark unblocked" button
// is a mute button with extra steps, and mute buttons are how boards die.
//
// A blocked check is never probed (the reconciler skips it), never red, and
// never green. It sits in its own lane addressed to Owner, and it subtracts
// from coverage -- see unwatchedDomains in domains.go.
type BlockedMeta struct {
	// Reason is the external blocker in one line, e.g.
	// "SES production access denied in eu-north-1".
	Reason string `json:"reason"`
	// Owner is who can actually clear it. Rarely the same person who can fix
	// a red check, which is the entire point of the distinction.
	Owner string `json:"owner"`
	// Tracking is an optional link to the ticket, case, or thread.
	Tracking string `json:"tracking,omitempty"`
}

// ActionMeta declares that a check has a button. The metadata lives on the
// Check (compiled, PR-reviewed); the RUNNER is bound separately at wiring time
// via BindAction, because runners need main.go's dependencies and the registry
// must stay importable without them.
type ActionMeta struct {
	ID        string `json:"id"`    // stable slug: "billing.replay-dlq"
	Label     string `json:"label"` // button text: "Replay dead events"
	Danger    Danger `json:"danger"`
	InputHint string `json:"input_hint,omitempty"` // what to type, if anything
}

type Status string

const (
	StatusOK   Status = "ok"
	StatusWarn Status = "warn"
	StatusRed  Status = "red"

	// StatusStale and StatusDue are DERIVED at read time and are never
	// persisted. The CHECK constraint on ops_check_results.status enforces
	// this at the database level.
	StatusStale Status = "stale"
	StatusDue   Status = "due"

	// StatusBlocked is derived from the check's declared Blocked field, not
	// from any observation. It exists because "we cannot buy the thing yet"
	// and "the thing is broken" demand different responses from different
	// people, and collapsing them into RED trains the team to snooze the
	// fire lane. Also never persisted.
	StatusBlocked Status = "blocked"
)

// IsRed reports whether a status belongs in the ON FIRE / red lanes.
//
// Stale is red. A silent machine is a broken machine.
// Due is NOT red. A late human is not a broken machine.
// Blocked is NOT red. A machine nobody is allowed to build yet is not broken,
// and paging an engineer about a purchase order teaches them to ignore pages.
func (s Status) IsRed() bool {
	return s == StatusRed || s == StatusStale
}

// Env is a probe's read-only handle on the world. Probes get the postwave_ops
// pool — which has EXECUTE on aggregate functions and no base-table access —
// and nothing else. In particular, no tenant-scoped pool.
type Env struct {
	Pool *pgxpool.Pool
	HTTP *http.Client
}

// ProbeFunc returns a status and a human-readable detail line, e.g.
// "3 dead-lettered, oldest 7d ago". An error return is RED, never "unknown".
type ProbeFunc func(context.Context, *Env) (Status, string, error)

type Check struct {
	ID    string // stable slug: "billing.dlq-depth"
	Group string // Sending | Billing | Legal | Data | Releases | Vendors
	Title string

	// Domain is the coverage surface this check watches (see domains.go). It
	// is REQUIRED, because coverage arithmetic is only honest if every check
	// counts toward exactly one declared surface. A check with no domain
	// would monitor something real while leaving its surface reading as
	// unwatched.
	Domain string

	// Owner is the team or person who holds this check when it goes red. It
	// is REQUIRED for the same reason Remediation is: a red row addressed to
	// everyone is addressed to no one.
	Owner string

	// Why is one line explaining what breaks if this is red. It is rendered on
	// the card and it is REQUIRED — a check whose consequence nobody can state
	// is a check nobody will action.
	Why string

	Kind     Kind
	Severity Severity

	// Interval applies to KindEvaluated and KindHeartbeat only.
	//   evaluated: both the run cadence AND the freshness budget.
	//   heartbeat: the expected beat frequency.
	// The staleness budget is 2*Interval in both cases, which allows exactly
	// one missed run of slack before the check cries wolf.
	Interval time.Duration

	// Cadence applies to KindManual only: how often the chore re-arms after a
	// human ticks it. Interval is unused for manual checks.
	Cadence time.Duration

	// Damping is the number of consecutive same-class observations before a
	// push transition is real; 0 means the default of 2; use 3 for probes
	// that cross a network.
	Damping int

	Probe ProbeFunc // KindEvaluated only

	// RuntimeProbe declares that this check's probe is attached at wiring
	// time via BindProbe rather than compiled in.
	//
	// Some probes need handles no compile-time closure can hold: the live
	// worker Fleet, the loaded config, the constructed alert channels. Those
	// checks used to be Register()ed wholesale from main.go, which kept them
	// out of the COMPILED registry -- so `pnpm audit:ops` printed a coverage
	// number the running board disagreed with, and a metric that disagrees
	// with the thing it measures is worse than no metric.
	//
	// This is the same split ActionMeta already uses: the metadata is
	// compiled and PR-reviewed, only the executable part is bound late.
	// ValidateRegistry fails the boot if a declared runtime probe is never
	// bound, so the escape hatch cannot become a silent dead row.
	RuntimeProbe bool

	// Remediation is what a human actually does. REQUIRED. A red row with no
	// remediation is a nag, not a control.
	Remediation string

	Runbook string // optional link

	// Action is the check's one button, if it has one. No action without a
	// check (spec rule 5): actions hang off checks, so the console cannot
	// degenerate into an admin junk drawer.
	Action *ActionMeta

	// Blocked, when set, declares that this check cannot run yet for a reason
	// no engineer can fix. See BlockedMeta.
	Blocked *BlockedMeta
}

type Result struct {
	CheckID        string
	Status         Status
	Detail         string
	LastReportedAt time.Time
	LastOKAt       *time.Time
	FirstRedAt     *time.Time
	AckedUntil     *time.Time
	AckReason      string
}

// Effective derives the status a human should actually see.
//
// This is a pure function of now, a timestamp, and the check's own declared
// budget. It has no moving parts, no cron behind it, and no worker that can
// die — which is the entire reason the board cannot lie. If staleness were
// WRITTEN by a sweeper, then a dead sweeper would freeze every check at its
// last known status and the board would show a confident green forever.
func (r Result) Effective(now time.Time, c Check) Status {
	// Blocked is a property of the CHECK, not of any observation, so it wins
	// over every derivation below. A blocked check is not probed, so its row
	// is always stale; deriving that to RED would page an engineer nightly
	// about a contract they cannot sign.
	if c.Blocked != nil {
		return StatusBlocked
	}

	age := now.Sub(r.LastReportedAt)

	if c.Kind == KindManual {
		if age > c.Cadence {
			return StatusDue
		}
		return StatusOK
	}

	// evaluated + heartbeat
	if age > 2*c.Interval {
		return StatusStale
	}
	return r.Status
}
