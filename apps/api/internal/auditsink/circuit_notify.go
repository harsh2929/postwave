// SPDX-License-Identifier: AGPL-3.0-only
//
// circuit_notify.go — telling someone when a sink's breaker opens
// (GOVERNANCE#48).
//
// The breaker itself has always worked: FailureThresholdToOpen consecutive
// failures flips `audit_sinks.circuit_state` to `open`, deliveries
// short-circuit, and every audit record that would have gone out lands in
// `audit_sink_dlq` instead. What never happened is anyone finding out. The
// state was returned by GET /api/v1/audit-sinks and rendered on a screen, so
// "we stopped shipping your audit trail" was discoverable exactly as often as
// somebody opened that screen.
//
// For a compliance pipeline that is the whole problem. A SIEM that stops
// receiving events does not raise its own alarm — silence looks identical to
// "nothing happened" — and the gap is only noticed during the audit it was
// supposed to survive.

package auditsink

import "context"

// CircuitNotifier raises the operator alert when a sink's breaker opens.
//
// Declared in primitives rather than taking a *notifyfanout.Fanout so this
// package does not acquire a dependency on the notification stack: auditsink is
// a delivery pipeline, and main.go owns the wiring. nil is a no-op, which keeps
// every existing construction of Deps (and every test) working unchanged.
//
// It returns nothing on purpose. The caller is inside the delivery loop, where
// the breaker has ALREADY been committed; failing to announce a state change
// must never look like a failure to make it.
type CircuitNotifier interface {
	NotifyAuditSinkCircuitOpened(ctx context.Context, in AuditSinkCircuitAlert)
}

// AuditSinkCircuitAlert is what the notification needs.
//
// Note what is absent: the sink's ENDPOINT. A sink URL can carry a token in its
// path or query (that is exactly why the outbound-webhook notifier omits its
// receiver URL too), and a notification payload is the last place to put one.
// The name is operator-chosen and safe; the id addresses the row.
type AuditSinkCircuitAlert struct {
	TenantID string
	SinkID   string
	// SinkName is the operator's own label for the sink, or empty.
	SinkName string
	// ConsecutiveFailures at the moment the breaker opened.
	ConsecutiveFailures int
}

// notifyCircuitOpened announces a closed→open (or half_open→open) transition.
//
// Called from the two places breakerOnFailure reports `transitioned` — the live
// delivery loop and the replay drain — because a breaker that opens during a
// replay has the same consequence as one that opens during live delivery.
func (d *Deps) notifyCircuitOpened(ctx context.Context, s Sink, consecutiveFailures int) {
	if d == nil || d.CircuitNotifier == nil || s.TenantID == "" {
		return
	}
	d.CircuitNotifier.NotifyAuditSinkCircuitOpened(ctx, AuditSinkCircuitAlert{
		TenantID:            s.TenantID,
		SinkID:              s.ID,
		SinkName:            s.Name,
		ConsecutiveFailures: consecutiveFailures,
	})
}
