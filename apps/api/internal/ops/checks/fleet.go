// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// workerFleetInterval is deliberately short. A worker that dies takes its work
// with it immediately, and the 2*Interval staleness budget means a dead
// reconciler still surfaces this row as stale within four minutes.
const workerFleetInterval = 2 * time.Minute

// WorkerFleetCheckID is declared at compile time and its probe bound at
// wiring time, so it counts toward the coverage number CI prints.
const WorkerFleetCheckID = "queues.worker-fleet"

var bindFleetOnce sync.Once

// ONE check for 117 workers, not 117 checks. A per-worker row would bury the
// board on the day a single worker dies and would make the fleet's own health
// unreadable; the detail line names exactly which workers are missing, which
// is what an operator needs, and the Fleet is the thing being monitored.
func init() {
	{
		ops.Register(ops.Check{
			ID:       WorkerFleetCheckID,
			Group:    "Data",
			Domain:   "queues",
			Owner:    "platform",
			Title:    "Background worker fleet",
			Severity: ops.SevCritical,
			Why: "Most of the product is a background job, and safego swallows a worker panic so the process survives — which is correct, and is also exactly how a worker dies with no error, no alert and no traffic change. " +
				"A stopped scheduler produces only an absence, and an absence is the one failure a dashboard cannot show you unless something is counting.",
			Kind:         ops.KindEvaluated,
			Interval:     workerFleetInterval,
			Damping:      2,
			RuntimeProbe: true,
			Remediation: "The detail line names the stopped workers. A panicked worker has a stack in the logs under safego: search `safego: goroutine panic` with that worker name. " +
				"Workers are spawned once at boot and are not restarted in place, so recovery is a process restart — confirm the panic is fixed first, or the restart just buys another few minutes. " +
				"An undeclared worker is a bookkeeping gap, not an outage: add it to internal/ops/checks/workers.go.",
			Runbook: "docs/runbooks/incident-response.md",
		})
	}
}

// BindWorkerFleetProbe attaches the probe to the live Fleet that main.go
// installs as safego's observer. sync.Once keeps a second call (a test, a
// re-wired main.go) a no-op rather than a boot panic on a double bind.
func BindWorkerFleetProbe(fleet *ops.Fleet) {
	bindFleetOnce.Do(func() {
		ops.BindProbe(WorkerFleetCheckID, func(context.Context, *ops.Env) (ops.Status, string, error) {
			status, detail := fleet.Evaluate()
			return status, detail, nil
		})
	})
}
