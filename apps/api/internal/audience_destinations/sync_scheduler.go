// SPDX-License-Identifier: AGPL-3.0-only
//
// sync_scheduler.go — minute tick that executes due hourly/daily
// audience syncs.
//
// Enumeration runs cross-tenant under db.WithWorkerScope (the
// audience_syncs_worker_select policy from migration 0376); each due
// sync then executes under its own tenant scope via SyncRunner.Run,
// so all subscriber reads + ledger writes stay behind tenant RLS.
//
// Due definitions are claimed atomically with FOR UPDATE SKIP LOCKED and a
// bounded lease. The claim carries a stable operation key across lease
// recovery, so a crashed worker is reconciled rather than re-delivered.
package audience_destinations

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// schedulerTick is how often the due-scan runs.
const schedulerTick = time.Minute

// schedulerMaxPerTick bounds one tick so a backlog (e.g. after
// downtime) drains gradually instead of stampeding receivers.
const schedulerMaxPerTick = 20

// SyncScheduler runs due hourly/daily syncs in the background.
type SyncScheduler struct {
	Pool   *db.Pool
	Runner *SyncRunner
	Logger *slog.Logger
	// WorkerID is stable for this scheduler process and injectable in tests.
	WorkerID string
}

// Run blocks until ctx is cancelled, scanning for due syncs every
// schedulerTick.
func (s *SyncScheduler) Run(ctx context.Context) error {
	if s == nil || s.Pool == nil || s.Runner == nil {
		return nil
	}
	t := time.NewTicker(schedulerTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// tick finds + executes due syncs. Failures are logged and recorded on
// the per-run ledger; the loop never aborts on one bad sync.
func (s *SyncScheduler) tick(ctx context.Context) {
	owner := s.WorkerID
	if owner == "" {
		owner = uuid.NewString()
		s.WorkerID = owner
	}
	due, err := s.claimDue(ctx, owner, "")
	if err != nil {
		if s.Logger != nil {
			s.Logger.Warn("audience_syncs: scheduler scan failed", "err", err.Error())
		}
		return
	}
	for _, d := range due {
		if ctx.Err() != nil {
			return
		}
		if _, err := s.Runner.RunScheduled(ctx, d.tenantID, d.syncID, d.operationKey, owner, d.recovered); err != nil {
			// Safe only before beginSyncOperation inserted a run. The guarded
			// release keeps a claim that already has durable operation evidence;
			// that claim expires into needs_reconciliation instead of replaying.
			_ = s.Runner.Repo.releaseSyncClaim(ctx, d.tenantID, d.syncID, owner, d.operationKey)
			// Run() only errors on infrastructure failures (ledger
			// unwritable, sync deleted mid-tick) — delivery failures are
			// recorded on the run row itself.
			if s.Logger != nil {
				s.Logger.Warn("audience_syncs: scheduled run failed",
					"sync_id", d.syncID, "err", err.Error())
			}
		}
	}
}

type dueSync struct {
	syncID       string
	tenantID     string
	operationKey string
	recovered    bool
}

// claimDue atomically leases enabled scheduled syncs whose last terminal run
// is older than their interval. SKIP LOCKED makes simultaneous replicas
// disjoint; an expired claim retains its operation key for crash recovery.
func (s *SyncScheduler) claimDue(ctx context.Context, owner, tenantFilter string) ([]dueSync, error) {
	tx, err := db.WithWorkerScope(ctx, s.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH candidates AS MATERIALIZED (
    SELECT id, tenant_id,
           run_lease_operation_key IS NOT NULL AS recovered
      FROM audience_syncs
     WHERE enabled
       AND ($4 = '' OR tenant_id = $4::uuid)
       AND schedule <> 'manual'
       AND (run_lease_expires_at IS NULL OR run_lease_expires_at <= now())
       AND (
             last_run_at IS NULL
          OR (schedule = 'hourly' AND last_run_at < now() - interval '1 hour')
          OR (schedule = 'daily'  AND last_run_at < now() - interval '24 hours')
       )
     ORDER BY last_run_at ASC NULLS FIRST
     FOR UPDATE SKIP LOCKED
     LIMIT $1
), claimed AS (
    UPDATE audience_syncs s
       SET run_lease_owner = $2::uuid,
           run_lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
           run_lease_operation_key = COALESCE(
               s.run_lease_operation_key,
               'scheduled:' || gen_random_uuid()::text
           ),
           updated_at = now()
      FROM candidates c
     WHERE s.id = c.id AND s.tenant_id = c.tenant_id
     RETURNING s.id::text, s.tenant_id::text,
               s.run_lease_operation_key, c.recovered
)
SELECT id, tenant_id, run_lease_operation_key, recovered
  FROM claimed`, schedulerMaxPerTick, owner, operationLeaseDuration.Milliseconds(), tenantFilter)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []dueSync{}
	for rows.Next() {
		var d dueSync
		if err := rows.Scan(&d.syncID, &d.tenantID, &d.operationKey, &d.recovered); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
