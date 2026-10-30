// SPDX-License-Identifier: AGPL-3.0-only

// The push engine: a flap-damped state machine that turns board transitions
// into at-most-one alert per incident.
//
// Design invariants, in order of importance:
//
//   - It alerts on the EFFECTIVE status (Result.Effective), not the written
//     one. A reporter that dies while its row says 'ok' goes stale, stale is
//     red, and red pushes. The dead reporter is the incident this engine
//     exists for.
//   - A transition is only real after Damping consecutive same-class
//     observations (default 2). One flapping probe must not page anyone.
//   - State commits ONLY after a successful send (when channels exist), so a
//     down Slack retries the alert next tick instead of losing it.
//   - Manual checks never push; a late human is the digest's business.

package ops

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

const (
	defaultDamping      = 2
	criticalRepushEvery = 24 * time.Hour

	classOK  = "ok"
	classRed = "red"
)

// notified is the class the operator last heard about. The zero state ("")
// behaves as "ok": a check nobody was ever told about has nothing to resolve.
func (st PushState) notified() string {
	if st.LastNotifiedClass == "" {
		return classOK
	}
	return st.LastNotifiedClass
}

type Pusher struct {
	Store    *Store
	State    *PushStateStore
	Channels []Channel // tried in order; put slack first
	Logger   *slog.Logger
	Now      func() time.Time // injectable for tests

	// checks overrides the registry for tests; nil means All().
	checks []Check
}

func (p *Pusher) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now().UTC()
}

func (p *Pusher) logger() *slog.Logger {
	if p.Logger != nil {
		return p.Logger
	}
	return slog.Default()
}

func (p *Pusher) allChecks() []Check {
	if p.checks != nil {
		return p.checks
	}
	return All()
}

// Tick runs one damping pass and sends whatever transitions survived it.
//
// It opens by taking the cluster-wide advisory lock (another replica holding
// it means this tick is simply not ours) and closes by heartbeating the
// '__push_loop__' row, so a wedged loop is detectable from the outside.
func (p *Pusher) Tick(ctx context.Context) {
	now := p.now()

	got, release, err := p.State.TryTickLock(ctx)
	if err != nil {
		p.logger().Error("ops: push tick lock", "err", err)
		return
	}
	if !got {
		return // another replica owns this tick, heartbeat included
	}
	defer release()

	results, err := p.Store.LoadAll(ctx)
	if err != nil {
		p.logger().Error("ops: push tick could not load results", "err", err)
		return
	}
	states, err := p.State.LoadAll(ctx)
	if err != nil {
		p.logger().Error("ops: push tick could not load push state", "err", err)
		return
	}

	for _, c := range p.allChecks() {
		if c.Kind == KindManual {
			continue // manual checks are digest-only; a late human is not a page
		}

		// Zero Result if absent: its Effective derives stale, which is red.
		// A check that has never reported is not a check that is fine.
		r := results[c.ID]

		// Snoozed: the alert path skips ENTIRELY, before any state mutation,
		// so the damping streak resumes from where it was once the ack ends.
		if r.AckedUntil != nil && now.Before(*r.AckedUntil) {
			continue
		}

		eff := r.Effective(now, c)
		class := classOK // warn counts as ok for alerting; the board shows it
		if eff.IsRed() {
			class = classRed
		}

		st := states[c.ID] // zero PushState if absent
		st.CheckID = c.ID

		if class == st.notified() {
			// Steady state: any half-built streak toward the other class dies.
			st.CandidateClass, st.CandidateStreak = "", 0

			// A critical check that stays red re-pages daily. Anything an
			// operator can leave red for 24h unhandled is either not
			// critical or not handled — both deserve the nudge.
			if class == classRed && c.Severity == SevCritical && repushDue(st, now) {
				p.send(ctx, p.message(PushRepush, c, r, now))
				st.LastCriticalRepushAt = &now
			}
		} else {
			if st.CandidateClass == class {
				st.CandidateStreak++
			} else {
				st.CandidateClass, st.CandidateStreak = class, 1
			}

			damp := c.Damping
			if damp == 0 {
				damp = defaultDamping
			}
			if st.CandidateStreak >= damp {
				if class == classRed {
					if c.Severity != SevRoutine {
						sent := p.send(ctx, p.message(PushAlert, c, r, now))
						if !sent && len(p.Channels) > 0 {
							// Every channel failed: do NOT commit the
							// transition. The persisted streak stays at the
							// threshold, so the next tick retries the send.
							continue
						}
						st.LastAlertAt = &now
						st.LastCriticalRepushAt = &now
					}
					// Routine reds advance state silently: the daily digest
					// owns telling a human about them.
				} else if st.LastAlertAt != nil {
					// Only close loops we opened: no alert, no "resolved".
					p.send(ctx, p.message(PushResolved, c, r, now))
				}
				st.LastNotifiedClass = class
				st.CandidateClass, st.CandidateStreak = "", 0
			}
		}

		st.UpdatedAt = now
		if err := p.State.Upsert(ctx, st); err != nil {
			p.logger().Error("ops: push tick could not persist state", "check", c.ID, "err", err)
		}
	}

	if err := p.State.HeartbeatLoop(ctx, now); err != nil {
		p.logger().Error("ops: push tick could not heartbeat", "err", err)
	}
}

func repushDue(st PushState, now time.Time) bool {
	// A nil repush clock on a notified-red critical check should not exist,
	// but if it does (e.g. a check promoted to critical mid-incident), fail
	// loud: repush now rather than never.
	return st.LastCriticalRepushAt == nil || now.Sub(*st.LastCriticalRepushAt) >= criticalRepushEvery
}

// send tries channels in order; success is the first channel that returns
// nil (failures log and fall through to the next). It reports whether ANY
// channel got the message out. Zero channels configured returns true — state
// still advances, and the push canary owns detecting an unwired pipeline.
func (p *Pusher) send(ctx context.Context, m PushMessage) bool {
	if len(p.Channels) == 0 {
		return true
	}
	for _, ch := range p.Channels {
		if err := ch.Send(ctx, m); err != nil {
			p.logger().Error("ops: push channel failed",
				"channel", ch.Name(), "kind", string(m.Kind), "check", m.CheckID, "err", err)
			continue
		}
		return true
	}
	return false
}

// message renders one push. The alert carries the same three things the
// board card does — what broke, why it matters, what to do — because the
// person reading it at 03:00 does not have the board open.
func (p *Pusher) message(kind PushKind, c Check, r Result, now time.Time) PushMessage {
	detail := r.Detail
	switch {
	case r.LastReportedAt.IsZero():
		detail = "never reported"
	case r.Effective(now, c) == StatusStale:
		detail = fmt.Sprintf("no report for %s (budget %s); last observed %q",
			now.Sub(r.LastReportedAt).Round(time.Second), 2*c.Interval, r.Status)
	}

	var title, body string
	switch kind {
	case PushAlert:
		title = c.Title + " is RED"
		body = detail + "\nWhy it matters: " + c.Why + "\nFix: " + c.Remediation
		if c.Runbook != "" {
			body += "\nRunbook: " + c.Runbook
		}
	case PushRepush:
		title = c.Title + " is STILL RED"
		body = detail
		if r.FirstRedAt != nil {
			body += fmt.Sprintf("\nRed for %s.", now.Sub(*r.FirstRedAt).Round(time.Minute))
		}
		body += "\nFix: " + c.Remediation
	case PushResolved:
		title = c.Title + " recovered"
		body = "Back to ok."
	}

	return PushMessage{Kind: kind, CheckID: c.ID, Severity: c.Severity, Title: title, Body: body}
}
