// SPDX-License-Identifier: AGPL-3.0-only
package send_window

import (
	"context"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Evaluating an instant against the tenant's send window.
//
// The policy has had an `enforcement` column accepting 'block' | 'warn' | 'off'
// since it shipped, and nothing outside this package ever read it. An operator
// could set "block", see it saved, see it rendered back — and every send would
// ignore it. That is worse than having no send window: the setting reads as a
// guarantee and is decoration.
//
// This is the evaluator. It is deliberately the ONLY one: a second copy in the
// scheduler would disagree with this on daylight-saving boundaries within a
// year, and the disagreement would surface as a campaign refused by one path
// and accepted by another.

// Decision is what the policy says about one instant.
type Decision struct {
	// Allowed is false only when the policy BLOCKS. A warn policy is allowed
	// and carries a reason.
	Allowed bool
	// Warn is true when the instant is outside the window but the policy only
	// warns. The caller proceeds and tells the person.
	Warn bool
	// Reason is empty when the instant is inside the window.
	Reason string
	// Policy is the window that was applied, or nil when none is configured.
	Policy *Policy
}

// Allow is the answer when no policy applies.
//
// A tenant with no window has not asked for one, and inventing business hours
// would silently refuse a send somebody deliberately scheduled for 3am.
var Allow = Decision{Allowed: true}

// Evaluate reports whether `at` falls inside the tenant's send window.
//
// A policy-store failure returns an ERROR rather than Allow. Failing open here
// would mean a database hiccup silently disables a control the operator set,
// and the caller can decide whether to refuse the request or proceed — a
// decision this function has no business making for it.
func Evaluate(ctx context.Context, pool *db.Pool, tenantID string, at time.Time) (Decision, error) {
	policy, err := loadPolicy(ctx, pool, tenantID)
	if err != nil {
		return Decision{}, err
	}
	if policy == nil || policy.Enforcement == "off" {
		return Allow, nil
	}
	inside, reason := policy.Contains(at)
	if inside {
		return Decision{Allowed: true, Policy: policy}, nil
	}
	if policy.Enforcement == "warn" {
		return Decision{Allowed: true, Warn: true, Reason: reason, Policy: policy}, nil
	}
	return Decision{Allowed: false, Reason: reason, Policy: policy}, nil
}

// Contains reports whether an instant falls inside the window, in the POLICY's
// timezone.
//
// The tenant's timezone, never the server's and never the caller's. "Nine to
// five" means nine to five where the audience is, and evaluating in UTC would
// move every window by the offset — invisibly, and differently across a
// daylight-saving change.
func (p *Policy) Contains(at time.Time) (bool, string) {
	if p == nil {
		return true, ""
	}
	loc, err := time.LoadLocation(p.Timezone)
	if err != nil {
		// An unloadable timezone is a misconfiguration, and treating it as UTC
		// would apply a window nobody chose. Refusing to claim the instant is
		// inside is the safe reading.
		return false, "the send window's timezone (" + p.Timezone + ") could not be resolved"
	}
	local := at.In(loc)

	if p.WeekdayBitmap != 0 && p.WeekdayBitmap&(1<<uint(local.Weekday())) == 0 {
		return false, local.Format("Mon") + " is outside the sending days"
	}

	start, okStart := parseHHMM(p.StartLocal)
	end, okEnd := parseHHMM(p.EndLocal)
	if !okStart || !okEnd {
		return false, "the send window's hours could not be read"
	}
	minutes := local.Hour()*60 + local.Minute()

	// An end BEFORE the start is a window that crosses midnight (22:00–06:00),
	// which is a legitimate thing to configure for a global audience. Treating
	// it as an empty range would refuse every instant, and the operator would
	// see a window they set rejecting everything.
	if end < start {
		if minutes >= start || minutes < end {
			return true, ""
		}
		return false, local.Format("15:04") + " is outside " + p.StartLocal + "–" + p.EndLocal + " " + p.Timezone
	}
	if minutes >= start && minutes < end {
		return true, ""
	}
	return false, local.Format("15:04") + " is outside " + p.StartLocal + "–" + p.EndLocal + " " + p.Timezone
}

func parseHHMM(v string) (int, bool) {
	t, err := time.Parse("15:04", v)
	if err != nil {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}
