// SPDX-License-Identifier: AGPL-3.0-only
//
// scheduler.go — minute tick that executes due daily/weekly/monthly
// agent routines.
//
//   - ClaimDue uses a tenant-scoped compare-and-set update and creates the
//     running receipt in that same transaction, so replicas cannot draft the
//     same due occurrence twice without widening cross-tenant worker writes.
//   - Each claimed routine executes under its own tenant scope through the
//     receipt's pre-created run id, so all draft writes + approvals remain
//     behind tenant RLS.
//   - Stale receipts become failed after a conservative timeout; they are
//     never auto-replayed because a crash may have happened after an inert
//     draft was persisted but before the receipt reached its terminal write.
package agent_routines

import (
	"context"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// schedulerTick is how often the due-scan runs.
const schedulerTick = time.Minute

// schedulerMaxPerTick bounds one tick so a backlog (e.g. after
// downtime) drains gradually instead of stampeding the voice service.
const schedulerMaxPerTick = 10

const (
	// Execute is bounded at three minutes and the HTTP model call at 90
	// seconds. Ten minutes leaves ample finalization headroom while ensuring a
	// dead process cannot leave "running" in the UI indefinitely.
	schedulerStaleRunAfter = 10 * time.Minute
	schedulerStaleMaxBatch = 100
)

// routineClaimer is the durable scheduler surface; *Repo implements it and
// tests pass a fake.
type routineClaimer interface {
	ClaimDue(ctx context.Context, limit int) ([]DueRoutine, error)
	FailStaleRuns(ctx context.Context, startedBefore time.Time, limit int) (int, error)
}

// Scheduler runs due routines in the background.
type Scheduler struct {
	Pool   *db.Pool
	Repo   routineClaimer
	Runner *Runner
	Logger *slog.Logger
}

// Run blocks until ctx is cancelled, scanning every schedulerTick.
func (s *Scheduler) Run(ctx context.Context) error {
	if s == nil || s.Repo == nil || s.Runner == nil {
		return nil
	}
	t := time.NewTicker(schedulerTick)
	defer t.Stop()
	// Reconcile stale receipts and claim already-due work at startup instead of
	// leaving both invisible until the first minute boundary.
	s.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// tick finds + executes due routines. Failures are logged and recorded
// on the per-run ledger; the loop never aborts on one bad routine.
func (s *Scheduler) tick(ctx context.Context) {
	if _, err := s.Repo.FailStaleRuns(
		ctx,
		time.Now().UTC().Add(-schedulerStaleRunAfter),
		schedulerStaleMaxBatch,
	); err != nil && s.Logger != nil {
		s.Logger.Warn("agent_routines: stale run finalization failed", "err", err.Error())
	}
	// Claim immediately before execution. Claiming a batch and then executing
	// it serially would make the last receipts look stale while they merely sat
	// behind earlier model calls. One-at-a-time claims preserve the ten-minute
	// stale threshold without a heartbeat and still cap each tick at ten runs.
	for attempts := 0; attempts < schedulerMaxPerTick; attempts++ {
		if ctx.Err() != nil {
			return
		}
		due, claimErr := s.Repo.ClaimDue(ctx, 1)
		// Process any committed partial result before reporting its later error;
		// otherwise a future batched implementation could strand a receipt that
		// was durably claimed before another candidate failed.
		for _, claimed := range due {
			s.runOne(ctx, claimed)
		}
		if claimErr != nil {
			if s.Logger != nil {
				s.Logger.Warn("agent_routines: scheduler claim failed", "err", claimErr.Error())
			}
			return
		}
		if len(due) == 0 {
			return
		}
	}
}

// runOne executes a pre-claimed routine run, bounded by ExecuteTimeout so one
// stuck model call cannot stall the tick indefinitely.
func (s *Scheduler) runOne(ctx context.Context, d DueRoutine) {
	if d.RunID == "" {
		if s.Logger != nil {
			s.Logger.Error("agent_routines: claimed run missing receipt id",
				"routine_id", d.RoutineID)
		}
		return
	}
	execCtx, cancel := context.WithTimeout(ctx, ExecuteTimeout)
	defer cancel()
	if err := s.Runner.ExecuteSafely(execCtx, d.TenantID, d.RoutineID, d.RunID); err != nil {
		// Execute already recorded the failure on the run row.
		if s.Logger != nil {
			s.Logger.Warn("agent_routines: scheduled run failed",
				"routine_id", d.RoutineID, "run_id", d.RunID, "err", err.Error())
		}
	}
}
