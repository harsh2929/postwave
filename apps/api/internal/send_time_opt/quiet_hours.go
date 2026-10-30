// SPDX-License-Identifier: AGPL-3.0-only
//
// quiet_hours.go — sto-quiet-hours-edge-snap (P1, surface=send-time).
//
// When a recipient's best_send_hour falls inside the tenant's
// "quiet" window (e.g. 22:00-06:00), Moosewave previously had no
// policy at all: the send went out at the modal hour regardless,
// even if that was 03:00. Marketers reported the resulting
// inbox-at-3am sends as the #2 spam-complaint driver.
//
// 2026 SOTA, by ESP:
//
//   - Braze "Intelligent Timing" snaps the in-window optimal hour to the
//     NEAREST EDGE of the quiet window. 05:30 → 06:00; 01:00 → 22:00
//     (yesterday's edge). Equidistant ties break toward the END edge
//     (so the send is the same calendar day rather than the prior).
//   - Iterable defers any in-window send to the WINDOW END (strictly
//     conservative — never moves the send earlier).
//   - Klaviyo skips altogether outside SMS-allowed hours (8am-9pm
//     recipient local, TCPA-driven). For email it falls back to the
//     "smart sending" cooldown.
//
// This file implements all three policies with a single resolver:
// `ApplyQuietHours(when, qhStart, qhEnd, policy)`. The signature
// returns `(time.Time, bool)` — the second value is `keep`, which is
// false when the policy is `skip` and `when` is in-window (the caller
// then drops the recipient from the schedule entirely).
//
// Window arithmetic: quiet windows are expressed as hour-of-day pairs
// in UTC. Wrap-around windows (start > end, e.g. 22 → 6) are the
// common case and explicitly supported. A window with start == end is
// treated as "no quiet hours" (a 0-length window means nothing).
//
// Policy vocabulary:
//
//	QuietHoursPolicySnap         — Braze-style nearest-edge snap.
//	QuietHoursPolicyDeferToEnd   — Iterable-style defer to window end.
//	QuietHoursPolicySkip         — Klaviyo-style skip the recipient.
//	QuietHoursPolicyNone         — no enforcement (legacy posture).
//
// The resolver is pure — it takes the input time + the tenant's
// window + the policy and returns the adjusted time. The DB lookup
// for `(qhStart, qhEnd, policy)` lives in the campaigns package
// alongside the rest of the tenant_send_settings readers (mirroring
// the cold_start_fallback.go split).
package send_time_opt

import "time"

// QuietHoursPolicy values match the CHECK constraint installed by
// migration 0311_sto_quiet_hours_edge_snap.sql. Keep these in sync if
// the schema vocabulary grows.
const (
	// QuietHoursPolicyNone — no quiet-hours enforcement. Used when
	// the tenant has neither start nor end set. ApplyQuietHours
	// returns the input time unchanged with keep=true.
	QuietHoursPolicyNone = "none"

	// QuietHoursPolicySnap — Braze posture. In-window times shift to
	// the NEAREST edge of the window. Default policy installed by
	// migration 0311.
	QuietHoursPolicySnap = "snap"

	// QuietHoursPolicyDeferToEnd — Iterable posture. In-window times
	// shift forward to the END edge of the window. Never moves a send
	// earlier than the optimal time.
	QuietHoursPolicyDeferToEnd = "defer_to_end"

	// QuietHoursPolicySkip — Klaviyo posture. In-window recipients
	// are dropped from the schedule. ApplyQuietHours returns
	// keep=false and the caller is expected to remove the recipient
	// from the send entirely.
	QuietHoursPolicySkip = "skip"
)

// DefaultQuietHoursPolicy is the policy assumed when the tenant has a
// window configured but no explicit policy override. Matches the
// migration default ('snap') — the least disruptive option (send
// still goes out, just shifted to a polite hour).
const DefaultQuietHoursPolicy = QuietHoursPolicySnap

// QuietHoursWindow is the tenant's configured quiet-hours window.
// Both fields are hour-of-day in UTC, 0..23. When `Enabled` is false,
// `ApplyQuietHours` short-circuits to the identity transform.
//
// Wrap-around windows (StartHour > EndHour) are supported and are the
// common case — a 22:00 → 06:00 window crosses midnight.
type QuietHoursWindow struct {
	Enabled   bool
	StartHour int
	EndHour   int
	Policy    string
}

// inQuietWindow reports whether the given hour-of-day falls inside the
// window [start, end). The window is half-open at the end edge: a
// send AT the end hour is considered OUTSIDE the window (so a 22-6
// window blocks 22:xx through 05:xx but allows 06:00).
//
// For wrap-around windows (start > end), the in-window set is
// [start, 24) ∪ [0, end).
func inQuietWindow(hourOfDay, start, end int) bool {
	if start == end {
		// Degenerate: zero-length window is treated as "no quiet
		// hours". (A 24h window would be expressed as start=0,
		// end=24 but our hour-of-day domain is 0..23 so that's not
		// representable — and a tenant who wants to block all sends
		// should just disable sending, not configure a 24h quiet
		// window.)
		return false
	}
	if start < end {
		// Non-wrapping window, e.g. 13 → 14 (an oddball "lunch
		// quiet" hour). In-window iff hour ∈ [start, end).
		return hourOfDay >= start && hourOfDay < end
	}
	// Wrap-around: hour is in-window iff hour >= start OR hour < end.
	return hourOfDay >= start || hourOfDay < end
}

// ApplyQuietHours shifts `when` out of the tenant's quiet-hours window
// according to the configured policy and returns (adjusted, keep).
//
//   - When the window is disabled (qh.Enabled == false) or the policy
//     is QuietHoursPolicyNone, the input time is returned unchanged
//     with keep=true.
//   - When `when` is OUTSIDE the window, the input time is returned
//     unchanged with keep=true regardless of policy.
//   - When `when` is INSIDE the window:
//   - policy=Snap         → shift to the nearest edge of the
//     window. Equidistant ties break to
//     the END edge (later in the day).
//   - policy=DeferToEnd   → shift forward to the END edge.
//   - policy=Skip         → return keep=false. The caller drops
//     this recipient from the schedule.
//   - policy=anything else → treated as no-op (legacy posture; an
//     unknown policy value should not break
//     existing schedules). The CHECK constraint
//     in migration 0311 prevents this in
//     practice but the resolver tolerates it.
//
// All snap/defer adjustments preserve the minute and second
// components of the input time (so a 05:30:45 input snapping forward
// to 06:00 becomes 06:00:45, not 06:00:00). This matches Braze's
// observed behaviour and avoids creating a thundering-herd at the
// edge minute.
//
// Returned time is in the same Location as `when`.
func ApplyQuietHours(when time.Time, qh QuietHoursWindow) (time.Time, bool) {
	if !qh.Enabled || qh.Policy == QuietHoursPolicyNone || qh.Policy == "" {
		return when, true
	}
	if qh.StartHour < 0 || qh.StartHour > 23 || qh.EndHour < 0 || qh.EndHour > 23 {
		// Malformed window — fail open (don't shift). The migration
		// CHECK constraint blocks this at the DB layer; this branch
		// guards against a hand-constructed QuietHoursWindow in tests
		// or future call sites.
		return when, true
	}
	hod := when.Hour()
	if !inQuietWindow(hod, qh.StartHour, qh.EndHour) {
		return when, true
	}
	switch qh.Policy {
	case QuietHoursPolicySkip:
		return when, false
	case QuietHoursPolicyDeferToEnd:
		return shiftToHourOfDay(when, qh.EndHour, true), true
	case QuietHoursPolicySnap:
		return snapToNearestEdge(when, qh.StartHour, qh.EndHour), true
	default:
		// Unknown policy — no-op (legacy posture).
		return when, true
	}
}

// shiftToHourOfDay returns `when` with the hour replaced by
// `targetHour`, keeping the minute/second/nanosecond components.
// `forward` controls how the date rolls: when true and targetHour is
// at or before the current hour, the day advances by one (this is
// what "defer to end" wants — the end edge is always in the future).
func shiftToHourOfDay(when time.Time, targetHour int, forward bool) time.Time {
	shifted := time.Date(
		when.Year(), when.Month(), when.Day(),
		targetHour, when.Minute(), when.Second(), when.Nanosecond(),
		when.Location(),
	)
	if forward && !shifted.After(when) {
		shifted = shifted.Add(24 * time.Hour)
	}
	return shifted
}

// snapToNearestEdge returns the nearest in-future-or-past edge of the
// quiet-hours window for `when`. Equidistant ties break to the END
// edge (later in the day, matching observed Braze behaviour). The
// returned time keeps the minute/second of `when`.
//
// Distance is measured in hours within the day, wrapping the
// 24-hour clock. For a wrap-around window 22-6 and a 05:30 input:
//   - end edge (06:00) is 0.5h away forward
//   - start edge (22:00) is 7.5h away backward
//
// → end edge wins, send moves to 06:30.
//
// For a 23:30 input under the same window:
//   - end edge (06:00) is 6.5h away forward
//   - start edge (22:00) is 1.5h away backward
//
// → start edge wins, send moves to 22:30 (yesterday's edge if 23:30
// is today; the date math below resolves that).
func snapToNearestEdge(when time.Time, startHour, endHour int) time.Time {
	hod := when.Hour()
	min := when.Minute()
	// Distance from `when` forward to the end edge, in minutes. Using
	// minutes (not hours) so a 05:31 input still rounds to the
	// nearest edge by absolute clock distance, not by hour bucket.
	fwdMin := minutesUntilHour(hod, min, endHour)
	// Distance backward to the start edge, in minutes.
	bwdMin := minutesSinceHour(hod, min, startHour)
	// Tie-break to the end edge (forward).
	if fwdMin <= bwdMin {
		return shiftToHourOfDay(when, endHour, true)
	}
	// Snap backward to the start edge. Date rolls back if the start
	// hour is later in the day than `when` (wrap-around case where
	// `when` is e.g. 01:00 and startHour is 22 — that 22:00 was
	// YESTERDAY).
	shifted := time.Date(
		when.Year(), when.Month(), when.Day(),
		startHour, when.Minute(), when.Second(), when.Nanosecond(),
		when.Location(),
	)
	if shifted.After(when) {
		shifted = shifted.Add(-24 * time.Hour)
	}
	return shifted
}

// minutesUntilHour returns the minute-distance from (curHour, curMin)
// forward to (targetHour, 0) within a 24-hour cycle. Returns a value
// in [0, 1440).
func minutesUntilHour(curHour, curMin, targetHour int) int {
	cur := curHour*60 + curMin
	tgt := targetHour * 60
	delta := tgt - cur
	if delta < 0 {
		delta += 24 * 60
	}
	return delta
}

// minutesSinceHour returns the minute-distance from (targetHour, 0)
// backward to (curHour, curMin) within a 24-hour cycle. Returns a
// value in [0, 1440).
func minutesSinceHour(curHour, curMin, targetHour int) int {
	cur := curHour*60 + curMin
	tgt := targetHour * 60
	delta := cur - tgt
	if delta < 0 {
		delta += 24 * 60
	}
	return delta
}
