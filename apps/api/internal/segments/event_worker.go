// SPDX-License-Identifier: AGPL-3.0-only
//
// event_worker.go — SUB-029: live segment recompute on every event.
//
// The historical refresh path for segment membership was time-based
// only: send_time_opt.SegmentMaterializer ticks every 5 minutes, and a
// manual POST /segments/{id}/recompute lets an operator force a single
// segment. Neither flips a subscriber into/out of a segment "within
// seconds of event arrival", which the send-time-opt + enter-segment
// flow surfaces need.
//
// This worker closes that gap. The subscriber event ingest path
// (subscribers.RecordSubscriberEvent) enqueues one segment_event_queue
// row per affected segment after the event commits. SegmentEventWorker
// polls the queue on a sub-second cadence, claims a batch per tenant,
// dedups the pending rows by segment, recompiles each segment's
// query_ast → SQL via the canonical definition evaluator, and rewrites the
// segment_subscribers cache for just those segments — so membership flips in ~1s rather than
// at the next 5-minute batch.
//
// RLS shape (worker pattern, mirrors snapshot_worker.go):
//   - tenant enumeration runs cross-tenant under db.WithWorkerScope
//     (tenants worker_select policy, migration 1708);
//   - everything per-tenant (queue claim, segment refresh, queue
//     delete) re-enters db.WithTenant so reads/writes stay behind the
//     segment_event_queue + segment_subscribers tenant RLS policies.
//
// Cost: the worker only materialises segments that actually had a
// pending event row — not the whole batch — so the steady-state cost is
// proportional to event volume × affected-segment fan-out, not to the
// total segment count. The 5-minute materialiser still covers segments
// no event touched (e.g. profile-only predicates).

package segments

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultEventWorkerInterval = 1 * time.Second
	// eventWorkerClaimBatch bounds how many queue rows one tenant tick
	// claims. Generous because rows dedup down to a much smaller set of
	// distinct segments.
	eventWorkerClaimBatch = 500
	// eventWorkerMaxSegments caps distinct segments refreshed per tenant
	// per tick so a tenant that fired events touching thousands of
	// segments drains gradually rather than monopolising the worker.
	eventWorkerMaxSegments = 100
	// entrantForwardCap bounds how many segment_joined events one refresh
	// forwards. A bulk import can flip thousands of subscribers into a
	// segment at once; we forward the first cap and log the overflow rather
	// than fan out unboundedly (no silent truncation — see refresh).
	entrantForwardCap = 1000
)

// SegmentEventWorker drains segment_event_queue and refreshes the
// affected segments' segment_subscribers rows.
type SegmentEventWorker struct {
	Pool   *db.Pool
	Repo   *Repo
	Logger *slog.Logger
	// Interval defaults to 1s.
	Interval time.Duration
	// Forwarder, when non-nil, receives a segment_joined event per subscriber
	// that newly entered a segment during a refresh (the "Entered segment"
	// flow trigger). nil, or a forwarder reporting Enabled() == false (an
	// HTTPSegmentJoinForwarder with no automation runtime URL), disables the
	// detection entirely.
	Forwarder SegmentJoinForwarder
}

func (w *SegmentEventWorker) interval() time.Duration {
	if w != nil && w.Interval > 0 {
		return w.Interval
	}
	return defaultEventWorkerInterval
}

func (w *SegmentEventWorker) log() *slog.Logger {
	if w != nil && w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// Run blocks until ctx is cancelled. Fires RunOnce immediately, then
// every Interval.
func (w *SegmentEventWorker) Run(ctx context.Context) {
	if w == nil || w.Pool == nil || w.Repo == nil {
		return
	}
	w.log().Info("segment-event-worker: starting", "interval", w.interval().String())
	w.RunOnce(ctx)
	t := time.NewTicker(w.interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.RunOnce(ctx)
		}
	}
}

// RunOnce drains one pass across all tenants with pending rows. Returns
// (segmentsRefreshed, errors).
func (w *SegmentEventWorker) RunOnce(ctx context.Context) (int, int) {
	if w == nil || w.Pool == nil || w.Repo == nil {
		return 0, 0
	}
	tenants, err := w.listTenants(ctx)
	if err != nil {
		w.log().Error("segment-event-worker: list-tenants failed", "err", err)
		return 0, 1
	}
	refreshed, errs := 0, 0
	for _, tenantID := range tenants {
		if ctx.Err() != nil {
			break
		}
		n, e := w.drainTenant(ctx, tenantID)
		refreshed += n
		if e != nil {
			errs++
			if errors.Is(e, context.Canceled) || errors.Is(e, context.DeadlineExceeded) {
				break
			}
			w.log().Warn("segment-event-worker: tenant drain failed",
				"tenant_id", tenantID, "err", e)
		}
	}
	return refreshed, errs
}

// listTenants enumerates every tenant under worker scope so the per-
// tenant drain can bind app.tenant_id. Tenants with no pending queue
// rows return an empty claim immediately, so the per-tenant overhead is
// one cheap indexed lookup.
func (w *SegmentEventWorker) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, w.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// drainTenant claims a batch of queue rows for one tenant, resolves the
// distinct affected segment ids, refreshes each, then deletes the
// claimed rows. Returns (segmentsRefreshed, error).
//
// Claim + delete bracket the refresh so a crash mid-refresh leaves the
// rows in the queue for the next tick (at-least-once). Re-refreshing a
// segment is idempotent (the cache is fully rewritten), so duplicate
// processing is harmless.
func (w *SegmentEventWorker) drainTenant(ctx context.Context, tenantID string) (int, error) {
	segmentIDs, claimedIDs, err := w.claim(ctx, tenantID)
	if err != nil {
		return 0, err
	}
	if len(claimedIDs) == 0 {
		return 0, nil
	}
	refreshed := 0
	for _, segID := range segmentIDs {
		if ctx.Err() != nil {
			return refreshed, ctx.Err()
		}
		if _, err := w.refresh(ctx, tenantID, segID); err != nil {
			// The claimed rows are still deleted below. Keeping them would
			// re-claim a segment with a broken definition on every tick, and
			// its rows sit at the head of the queue, so the batch would fill
			// with them and starve every other segment. The next event
			// re-enqueues, and the send-time materialiser rewrites any stale
			// cache on its own cadence.
			w.log().Warn("segment-event-worker: refresh failed",
				"tenant_id", tenantID, "segment_id", segID, "err", err)
			continue
		}
		refreshed++
	}
	if err := w.deleteClaimed(ctx, tenantID, claimedIDs); err != nil {
		return refreshed, err
	}
	return refreshed, nil
}

// claim reads up to eventWorkerClaimBatch pending rows for the tenant
// (oldest first) and returns the distinct affected segment ids (capped
// at eventWorkerMaxSegments) plus the claimed queue row ids. A row with
// a NULL segment_id expands to every segment the tenant owns.
func (w *SegmentEventWorker) claim(ctx context.Context, tenantID string) (segmentIDs []string, claimedIDs []int64, err error) {
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id, segment_id::text
  FROM segment_event_queue
 WHERE tenant_id = $1::uuid
 ORDER BY enqueued_at ASC, id ASC
 LIMIT $2`, tenantID, eventWorkerClaimBatch)
	if err != nil {
		return nil, nil, err
	}
	segSet := map[string]struct{}{}
	hasNull := false
	for rows.Next() {
		var id int64
		var segID *string
		if err := rows.Scan(&id, &segID); err != nil {
			rows.Close()
			return nil, nil, err
		}
		claimedIDs = append(claimedIDs, id)
		if segID == nil || *segID == "" {
			hasNull = true
			continue
		}
		segSet[*segID] = struct{}{}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	// Expand NULL segment_id rows ("recompute all segments") to the
	// tenant's full segment set.
	if hasNull {
		segRows, err := tx.Query(ctx, `
SELECT id::text FROM segments WHERE tenant_id = $1::uuid`, tenantID)
		if err != nil {
			return nil, nil, err
		}
		for segRows.Next() {
			var id string
			if err := segRows.Scan(&id); err != nil {
				segRows.Close()
				return nil, nil, err
			}
			segSet[id] = struct{}{}
		}
		segRows.Close()
		if err := segRows.Err(); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}

	segmentIDs = make([]string, 0, len(segSet))
	for id := range segSet {
		segmentIDs = append(segmentIDs, id)
		if len(segmentIDs) >= eventWorkerMaxSegments {
			break
		}
	}
	return segmentIDs, claimedIDs, nil
}

// deleteClaimed removes the claimed queue rows for the tenant.
func (w *SegmentEventWorker) deleteClaimed(ctx context.Context, tenantID string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, w.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM segment_event_queue
 WHERE tenant_id = $1::uuid AND id = ANY($2::bigint[])`, tenantID, ids); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// refresh rewrites one segment's membership cache and, once that commits,
// forwards the subscribers who entered. Returns the number of members cached.
func (w *SegmentEventWorker) refresh(ctx context.Context, tenantID, segmentID string) (int, error) {
	result, err := RefreshAndForwardEntrants(ctx, w.Pool, tenantID, segmentID, w.Forwarder, w.log(), "segment-event-worker")
	if err != nil {
		return 0, err
	}
	return result.Members, nil
}
