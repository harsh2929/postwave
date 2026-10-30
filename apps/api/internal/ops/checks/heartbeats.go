// SPDX-License-Identifier: AGPL-3.0-only

// heartbeats.go -- the checks a worker reports for ITSELF.
//
// The AUTOMATIONS lane summarises KindHeartbeat checks, and before this file
// it had none. With an empty set it rendered "0 stale — all alive", which is
// true only in the sense that an empty room has no arguments in it. That is
// the board lying by arithmetic, and it is the exact failure mode the console
// was built to prevent.
//
// A heartbeat claims MORE than the fleet census does. queues.worker-fleet says
// a goroutine is alive; a heartbeat says an iteration of its loop completed. A
// worker deadlocked on a lock satisfies the first and fails the second, which
// is why both exist.
//
// ADDING ONE. Two lines: register the check here, and call hb.Beat(ctx) at the
// end of the loop's iteration. Interval is the expected beat frequency; the
// staleness budget is 2*Interval, and ops.Heartbeat writes every Interval/2, so
// four beats fit inside the budget and one failed write cannot fake a death.
// Only instrument loops you can actually reach — a heartbeat check with nothing
// beating it is a permanent red row, and a permanent red row gets snoozed.
package checks

import (
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// HeartbeatOutboxWorker is the transactional outbox drain: the loop that turns
// committed rows into actually-sent mail and actually-delivered events.
const HeartbeatOutboxWorker = "queues.outbox-worker-beat"

// HeartbeatReconciler is the ops reconciler itself.
const HeartbeatReconciler = "console.reconciler-beat"

const (
	outboxBeatInterval     = 2 * time.Minute
	reconcilerBeatInterval = 2 * time.Minute
)

func init() {
	ops.Register(ops.Check{
		ID:       HeartbeatOutboxWorker,
		Group:    "Data",
		Domain:   "queues",
		Owner:    "platform",
		Title:    "Outbox drain is doing work",
		Severity: ops.SevCritical,
		Why: "The transactional outbox is how a committed row becomes a sent email or a delivered event. " +
			"queues.worker-fleet only proves the goroutine is alive; a drain blocked on a lock or a wedged connection stays alive forever while every queued send sits in the database, and nothing errors.",
		Kind:     ops.KindHeartbeat,
		Interval: outboxBeatInterval,
		Remediation: "Check the outbox backlog on the Send page and the logs for `outbox: tick failed`. A live goroutine that has stopped beating is blocked, not crashed, " +
			"so look for a held advisory lock, an exhausted connection pool, or a handler with no timeout before restarting — a restart clears the symptom and loses the evidence.",
		Runbook: "docs/runbooks/common-failures.md",
	})

	ops.Register(ops.Check{
		ID:       HeartbeatReconciler,
		Group:    "Ops",
		Domain:   "console",
		Owner:    "platform",
		Title:    "Check reconciler is running",
		Severity: ops.SevHigh,
		Why: "If the reconciler stops, every evaluated check ages past its budget and the whole board turns red — correctly, but with no way to tell one broken subsystem from one broken reconciler. " +
			"This row is what distinguishes them.",
		Kind:     ops.KindHeartbeat,
		Interval: reconcilerBeatInterval,
		Remediation: "A board that is entirely red WITH this row stale means the reconciler died, not the platform: restart the API and check for a panic under `safego: goroutine panic` with worker ops-reconciler. " +
			"A board that is entirely red with this row beating means the platform really is having a bad day.",
		Runbook: "docs/runbooks/incident-response.md",
	})
}
