// SPDX-License-Identifier: AGPL-3.0-only

package sms

// The TCPA calling-time floor.
//
// 47 CFR 64.1200(c)(1) forbids a telephone solicitation "before the hour of
// 8 a.m. or after 9 p.m. (local time at the called party's location)".
// 47 U.S.C. 227(c)(5) gives the called party a private right of action with
// statutory damages of $500 per violation, trebled for a wilful one. A single
// mis-timed broadcast to a modest list is therefore a six-figure exposure, and
// it is the largest per-incident financial risk the platform carries.
//
// WHAT WAS WRONG. sms_quiet_hours is a set of tenant-authored labelled windows
// in a tenant-chosen timezone. Everything about it works — the gate consults
// it, the decision carries HoldUntil so the queue defers rather than drops —
// but it is entirely OPTIONAL. A tenant that never opens the settings page has
// no quiet hours at all, and the statutory floor is only as high as the least
// careful customer sets it. A floor a tenant can decline is not a floor.
//
// WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT CLAIM.
//
// The honest difficulty is that "local time at the called party's location" is
// a fact about a person, and a phone number is weak evidence of it: number
// portability means a 212 number can sit in California indefinitely.
// quiet_hours.go already records that the codebase refuses to scope by country
// "without authoritative recipient-country evidence", and that refusal is
// right. This file does not overturn it by inferring location from an area
// code and calling the result compliance.
//
// Instead the floor has two tiers, and BOTH of them are unconditional:
//
//	Tier 1 — the recipient's IANA timezone is known (subscribers carry it in
//	         custom_fields.timezone; see internal/recipient_tz_send). Enforce
//	         21:00-08:00 in exactly that zone. This is the real obligation,
//	         evaluated against real evidence.
//
//	Tier 2 — the recipient's timezone is unknown. We cannot evaluate the
//	         statute, so we require the tenant to have declared a quiet-hours
//	         window that is at least as restrictive as the statutory one. No
//	         declaration, or a cosmetic declaration that does not cover
//	         21:00-08:00 every day, blocks the send.
//
// Tier 2 is the part that closes the hole. It does not pretend to know where
// the recipient is; it refuses to send into an unknown local time unless the
// operator has accepted a window that would satisfy the statute wherever they
// are. A tenant may still narrow the window further — narrowing is always
// permitted, widening never is.

import (
	"fmt"
	"strings"
	"time"
)

const (
	// statutoryQuietStartMinute is 9 p.m. — the first minute of the
	// prohibited window.
	statutoryQuietStartMinute = 21 * 60
	// statutoryQuietEndMinute is 8 a.m. — the first minute solicitation may
	// resume. The window wraps midnight, which is why every comparison below
	// is "at or after start OR before end" rather than a range test.
	statutoryQuietEndMinute = 8 * 60
)

// StatutoryFloorReason is the blocking reason a floor evaluation produced, or
// the empty string when the floor permits the send.
type StatutoryFloorReason string

const (
	// FloorReasonQuietHours: the recipient's own local time is inside
	// 21:00-08:00. Temporal, so the decision carries a HoldUntil.
	FloorReasonQuietHours StatutoryFloorReason = "tcpa_quiet_hours"
	// FloorReasonUnprovable: the recipient's local time is unknown and the
	// tenant has declared no window that would satisfy the statute wherever
	// the recipient is. NOT temporal — waiting does not fix it; configuring
	// quiet hours does.
	FloorReasonUnprovable StatutoryFloorReason = "tcpa_quiet_hours_unprovable"
)

// StatutoryFloor is the outcome of evaluating the calling-time floor.
type StatutoryFloor struct {
	// Blocked reports whether the floor forbids sending now.
	Blocked bool
	Reason  StatutoryFloorReason
	// Until is the instant the block lifts, set only for FloorReasonQuietHours.
	// Zero for FloorReasonUnprovable, because that block is a configuration
	// state rather than a time of day and the queue must not defer on it.
	Until time.Time
	// Tier records which evidence the decision rests on, for the audit trail.
	// "recipient_timezone" or "tenant_window".
	Tier string
}

// RecipientLocation resolves a recipient's IANA timezone string.
//
// Returns ok=false for an empty or unloadable zone rather than falling back to
// UTC. A silent UTC fallback would make an unknown recipient look like a London
// one and would let Tier 1 report a confident answer it has no basis for —
// which is precisely the failure mode this file exists to avoid.
func RecipientLocation(ianaTimezone string) (*time.Location, bool) {
	trimmed := strings.TrimSpace(ianaTimezone)
	if trimmed == "" {
		return nil, false
	}
	loc, err := time.LoadLocation(trimmed)
	if err != nil || loc == nil {
		return nil, false
	}
	return loc, true
}

// StatutoryWindowActive reports whether now falls inside 21:00-08:00 in loc,
// and when the window ends.
//
// The returned instant is the next 08:00 in loc, computed by walking the wall
// clock rather than by adding a fixed duration: a DST transition inside the
// window changes its length in absolute time, and adding hours to "now" would
// release the send at 07:00 or 09:00 local on those two nights a year.
func StatutoryWindowActive(now time.Time, loc *time.Location) (bool, time.Time) {
	if loc == nil {
		return false, time.Time{}
	}
	local := now.In(loc)
	minute := local.Hour()*60 + local.Minute()
	if minute < statutoryQuietEndMinute {
		// Between midnight and 08:00: the window began yesterday at 21:00 and
		// ends at 08:00 today.
		return true, wallClock(local, 0, statutoryQuietEndMinute, loc)
	}
	if minute >= statutoryQuietStartMinute {
		// Between 21:00 and midnight: the window ends at 08:00 tomorrow.
		return true, wallClock(local, 1, statutoryQuietEndMinute, loc)
	}
	return false, time.Time{}
}

// wallClock returns the instant at `minuteOfDay` on the local calendar day
// `dayOffset` days after local. Constructing through time.Date in loc means the
// result is the correct absolute instant across DST rather than an arithmetic
// offset from now.
func wallClock(local time.Time, dayOffset, minuteOfDay int, loc *time.Location) time.Time {
	day := local.AddDate(0, 0, dayOffset)
	return time.Date(
		day.Year(), day.Month(), day.Day(),
		minuteOfDay/60, minuteOfDay%60, 0, 0, loc,
	).UTC()
}

// RuleCoversStatutoryFloor reports whether one tenant window is at least as
// restrictive as 21:00-08:00 on every day of the week.
//
// "At least as restrictive" is the whole test. A tenant may block 20:00-09:00
// and that is fine; a tenant may not block 22:00-07:00 and call it compliance,
// because the hours between 21:00 and 22:00 would still send. Days matter too:
// a weekday-only window leaves Saturday and Sunday open, and the statute does
// not take weekends off.
func RuleCoversStatutoryFloor(rule QuietHoursRule) bool {
	if !rule.Enabled {
		return false
	}
	if strings.TrimSpace(rule.CountryCode) != "" {
		// Country-scoped rules are rejected by EvaluateQuietHoursChecked as
		// unsupported. One cannot satisfy a floor it is not allowed to be.
		return false
	}
	if _, ok := RecipientLocation(rule.Timezone); !ok {
		return false
	}
	// All seven weekdays must be covered. Test the SET, not the slice length:
	// a length check rejects a rule listing all seven days plus a harmless
	// duplicate (which is compliant) while accepting seven entries covering six
	// distinct days (which is not). Mutation testing found the length check was
	// both redundant against this one and wrong in the one case they disagree.
	seen := map[int]bool{}
	for _, d := range rule.Days {
		if d < 0 || d > 6 {
			return false
		}
		seen[d] = true
	}
	if len(seen) != 7 {
		return false
	}
	if rule.StartMinute == rule.EndMinute {
		// Shared semantics with migration 0369 and gate.go: start == end means
		// the whole day is quiet, which trivially covers the statutory window.
		return true
	}
	// The rule must be an overnight window (wrapping midnight) that opens no
	// later than 21:00 and closes no earlier than 08:00. A same-day window
	// (start < end, e.g. 09:00-17:00) cannot contain a window that wraps
	// midnight, whatever its bounds.
	if rule.StartMinute < rule.EndMinute {
		return false
	}
	return rule.StartMinute <= statutoryQuietStartMinute &&
		rule.EndMinute >= statutoryQuietEndMinute
}

// EvaluateStatutoryFloor applies the calling-time floor.
//
// recipientTimezone is the recipient's IANA zone where known, empty otherwise.
// rules are the tenant's configured windows, as loaded for the gate.
//
// The tiers are tried in order of evidence quality, and the weaker tier is a
// stricter test rather than a lenient fallback — that ordering is what stops a
// missing timezone from becoming permission to send.
func EvaluateStatutoryFloor(
	now time.Time,
	recipientTimezone string,
	rules []QuietHoursRule,
) StatutoryFloor {
	if loc, ok := RecipientLocation(recipientTimezone); ok {
		active, until := StatutoryWindowActive(now, loc)
		if active {
			return StatutoryFloor{
				Blocked: true,
				Reason:  FloorReasonQuietHours,
				Until:   until,
				Tier:    "recipient_timezone",
			}
		}
		return StatutoryFloor{Tier: "recipient_timezone"}
	}

	for _, rule := range rules {
		if RuleCoversStatutoryFloor(rule) {
			// A conforming window exists. Whether it is ACTIVE right now is
			// EvaluateQuietHoursChecked's job — this tier only establishes
			// that the operator has accepted a window the statute would be
			// satisfied by. Returning unblocked here and letting the tenant
			// evaluation run is deliberate: two evaluators, one obligation
			// each, rather than one that does both jobs half-well.
			return StatutoryFloor{Tier: "tenant_window"}
		}
	}

	return StatutoryFloor{
		Blocked: true,
		Reason:  FloorReasonUnprovable,
		Tier:    "tenant_window",
	}
}

// StatutoryFloorGuidance is the operator-facing explanation for an unprovable
// block. It is a sentence rather than an error code because the fix is a
// configuration decision, and the person reading the failed send is the person
// who has to make it.
func StatutoryFloorGuidance() string {
	return fmt.Sprintf(
		"This recipient has no known timezone, so Moosewave cannot evaluate the "+
			"TCPA calling-time restriction (47 CFR 64.1200(c)(1): no solicitation "+
			"before %02d:00 or after %02d:00 local time at the called party's "+
			"location). Either record the recipient's timezone, or configure a "+
			"quiet-hours window covering %02d:00-%02d:00 on all seven days.",
		statutoryQuietEndMinute/60, statutoryQuietStartMinute/60,
		statutoryQuietStartMinute/60, statutoryQuietEndMinute/60,
	)
}
