// SPDX-License-Identifier: AGPL-3.0-only
//
// health_notify.go — telling the operators when account sender health breaks
// (DELIVERABILITY#15).
//
// The hub worker has done the hard half for a long time. Every tick it scores
// the account, records a snapshot, fires the `list_health.degraded` OUTBOUND
// WEBHOOK on a downward crossing of DegradedScoreThreshold, and — after the
// score stays under AutoThrottleScoreThreshold for a full sustain window —
// halves `max_sends_per_hour` and records the override row.
//
// None of that ever reached a person. An outbound webhook only arrives if the
// tenant built an integration to receive one, and the throttle was discoverable
// exactly as often as somebody opened the Deliverability Hub screen and read
// `auto_throttled`. So the common way to learn that Moosewave had cut your send
// rate was a customer asking why the campaign was crawling.
//
// WHY THIS IS AN INTERFACE AND NOT A *notifyfanout.Fanout. Same reason as
// auditsink's CircuitNotifier: this package is a scoring worker, and taking a
// dependency on the notification stack would invert the layering. main.go owns
// the wiring; nil is a no-op so every existing construction of Deps — and every
// test — keeps working untouched.
//
// EDGE-TRIGGERED, BOTH OF THEM. `NotifyDegraded` rides the SAME down-crossing
// the webhook already uses (this tick below the threshold, the previous
// snapshot at or above it), and `NotifyAutoThrottled` fires only on the tick
// that actually wrote the override row — `applyAutoThrottle` refuses to write a
// second one while an uncleared row exists. A recompute-triggered alert would
// be an hourly ping about a fact the operator already knows, which is how a
// notification channel gets turned off.

package deliverability_hub

import (
	"context"
	"errors"
	"fmt"
)

var errHealthNotifierUnavailable = errors.New("deliverability health notifier is unavailable")

// HealthNotifier raises the operator alert for account-level sender health.
//
// Declared in primitives so the package stays free of the notification stack.
// Both methods return nothing on purpose: the state change they announce has
// already been committed (a snapshot written, a send cap reduced), and failing
// to announce it must never look like a failure to make it.
type HealthNotifier interface {
	// NotifyDeliverabilityDegraded announces a downward crossing of the
	// degraded score threshold.
	NotifyDeliverabilityDegraded(ctx context.Context, in HealthAlert) error
	// NotifyDeliverabilityAutoThrottled announces that the reputation-repair
	// worker has reduced the workspace's send rate.
	NotifyDeliverabilityAutoThrottled(ctx context.Context, in ThrottleAlert)
}

// HealthAlert is what the degraded notification needs.
//
// Note what is absent: the breach LIST. `ThresholdBreach.Detail` and `FixCTA`
// are remediation prose meant for a screen with room for it, and the observed
// rates are a business metric that has no business on a lock screen. The single
// worst breach's stable `Code` is enough for the notification to say what
// tripped, and the hub screen the notification opens renders the rest.
type HealthAlert struct {
	TenantID string
	// IncidentID is the immutable degradation claim identity. Retries reuse it;
	// a later crossing gets a new one even when both scores are identical.
	IncidentID string
	// Score is the account score on the tick that crossed downward.
	Score int
	// PreviousScore is the snapshot it crossed from, so the copy can be
	// specific about the direction rather than restating a bare number.
	PreviousScore int
	// Grade is the letter band ("A".."F") for the current score.
	Grade string
	// TopBreachCode is the stable code of the most severe breach that tripped
	// ("bounce_rate_high", "complaint_rate_high", ...), or empty when the score
	// fell without any single threshold being crossed.
	TopBreachCode string
	// TopBreachTitle is that breach's short human title, or empty.
	TopBreachTitle string
	// BreachCount is how many thresholds are currently tripped.
	BreachCount int
}

// ThrottleAlert is what the auto-throttle notification needs.
type ThrottleAlert struct {
	TenantID string
	// IncidentID is the immutable repair-override row identity.
	IncidentID string
	// Score at the moment the throttle was applied.
	Score int
	// PriorSendsPerHour is the cap that was in force, or 0 when the workspace
	// had no explicit cap and the worker substituted its conservative default.
	PriorSendsPerHour int
	// ThrottledSendsPerHour is the reduced cap now in force.
	ThrottledSendsPerHour int
}

// notifyDegraded announces the down-crossing. Mirrors emitDegraded's guard so
// the notification and the webhook can never disagree about whether the edge
// happened.
func (w *Worker) notifyDegraded(ctx context.Context, alert HealthAlert) error {
	if w == nil || w.Deps == nil || w.Deps.HealthNotifier == nil {
		return errHealthNotifierUnavailable
	}
	if alert.TenantID == "" || alert.IncidentID == "" {
		return fmt.Errorf("deliverability health notifier: tenant and incident are required")
	}
	return w.Deps.HealthNotifier.NotifyDeliverabilityDegraded(ctx, alert)
}

// notifyAutoThrottled announces an applied throttle. Called only after the
// override row and the reduced cap have COMMITTED — announcing a cut that then
// rolled back would be worse than not announcing it at all.
func (w *Worker) notifyAutoThrottled(ctx context.Context, tenantID, incidentID string, score, prior, next int) {
	if w == nil || w.Deps == nil || w.Deps.HealthNotifier == nil || tenantID == "" {
		return
	}
	w.Deps.HealthNotifier.NotifyDeliverabilityAutoThrottled(ctx, ThrottleAlert{
		TenantID:              tenantID,
		IncidentID:            incidentID,
		Score:                 score,
		PriorSendsPerHour:     prior,
		ThrottledSendsPerHour: next,
	})
}

// worstBreach picks the breach the notification should name: critical over
// warn over info, and — within a severity — the first one scoreHub appended,
// which is already ordered most-actionable first (bounce, then complaint, then
// engagement, then the rest). Returns nil for an empty list, which is a real
// case: a score can drift below the threshold on engagement decay without any
// single threshold tripping.
func worstBreach(breaches []ThresholdBreach) *ThresholdBreach {
	rank := map[string]int{"critical": 3, "warn": 2, "info": 1}
	best := -1
	bestRank := 0
	for i := range breaches {
		r := rank[breaches[i].Severity]
		if r > bestRank {
			bestRank = r
			best = i
		}
	}
	if best < 0 {
		return nil
	}
	return &breaches[best]
}
