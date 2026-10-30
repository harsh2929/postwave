// SPDX-License-Identifier: AGPL-3.0-only
package commerce

// SUB-061 / SUB-062 — replenishment-cadence listener.
//
// BackfillReplenishmentCadence (replenishment_cadence_analyzer.go) recomputes
// the average_days_between_orders / last_order_at / expected_next_order_at
// traits for a tenant's subscribers from commerce_orders. This file is the
// seam that makes it live: the order-ingest paths (Repo.Sync, Repo.UpsertOrder)
// fire the listener AFTER the ingesting transaction has committed, so the
// freshly-written commerce_orders rows are visible to the backfill query.
//
// Design mirrors catalog_backfill_listener.go:
//   - Tenant-scoped: runs under db.WithTenant for the ingesting tenant only.
//   - Non-blocking: the trigger spawns a goroutine with a fresh, bounded
//     context (NOT the request context, which is cancelled once the HTTP
//     response flushes). The ingest handler returns immediately.
//   - Safe: failures are logged best-effort and never propagate back into the
//     ingest path. The backfill is idempotent, so a missed run self-heals on
//     the next order ingest.

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// cadenceBackfillTimeout bounds a single listener run so a slow cadence
// recompute can't leak a goroutine indefinitely.
const cadenceBackfillTimeout = 2 * time.Minute

// CadenceBackfillListener invokes Repo.BackfillReplenishmentCadence for a
// tenant when orders are ingested. Build one with NewCadenceBackfillListener
// so the *Repo and logger are wired.
type CadenceBackfillListener struct {
	repo   *Repo
	logger *slog.Logger

	// async controls whether Trigger spawns a goroutine (production) or runs
	// the backfill inline (tests, for a deterministic result). Defaults true.
	async bool

	// wg lets tests wait for in-flight async runs before asserting.
	wg sync.WaitGroup
}

// NewCadenceBackfillListener returns a production listener that fires the
// backfill on a background goroutine. logger may be nil.
func NewCadenceBackfillListener(repo *Repo, logger *slog.Logger) *CadenceBackfillListener {
	return &CadenceBackfillListener{repo: repo, logger: logger, async: true}
}

// NewSyncCadenceBackfillListener returns a listener that runs the backfill
// inline (synchronously) on Trigger. For tests that assert the traits were
// written without racing a goroutine.
func NewSyncCadenceBackfillListener(repo *Repo, logger *slog.Logger) *CadenceBackfillListener {
	return &CadenceBackfillListener{repo: repo, logger: logger, async: false}
}

// Trigger recomputes the cadence traits for every attributable subscriber in
// the tenant. Safe to call with a nil receiver (no-op). since=zero means "all
// time" (idempotent full recompute).
func (l *CadenceBackfillListener) Trigger(tenantID string, since time.Time) {
	if l == nil || l.repo == nil || tenantID == "" {
		return
	}
	if !l.async {
		l.run(context.Background(), tenantID, since)
		return
	}
	l.wg.Add(1)
	go func() {
		defer l.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), cadenceBackfillTimeout)
		defer cancel()
		l.run(ctx, tenantID, since)
	}()
}

// run executes the backfill and logs the outcome best-effort.
func (l *CadenceBackfillListener) run(ctx context.Context, tenantID string, since time.Time) {
	results, err := l.repo.BackfillReplenishmentCadence(ctx, tenantID, since)
	if err != nil {
		if l.logger != nil {
			l.logger.Warn("replenishment cadence backfill failed", "tenant", tenantID, "err", err.Error())
		}
		return
	}
	if l.logger != nil && len(results) > 0 {
		l.logger.Info("replenishment cadence backfill complete", "tenant", tenantID, "subscribers_updated", len(results))
	}
}

// Wait blocks until all in-flight async runs complete. Test-only helper.
func (l *CadenceBackfillListener) Wait() {
	if l == nil {
		return
	}
	l.wg.Wait()
}

// triggerCadenceBackfill is the internal hook the order-ingest paths call
// after a successful commit. nil-listener-safe.
func (r *Repo) triggerCadenceBackfill(tenantID string) {
	if r == nil || r.CadenceBackfill == nil {
		return
	}
	// since=zero → recompute over all of the tenant's commerce_orders. The
	// backfill is idempotent, so re-running on every ingest is correct.
	r.CadenceBackfill.Trigger(tenantID, time.Time{})
}
