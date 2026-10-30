// SPDX-License-Identifier: AGPL-3.0-only
//
// STO Compute() worker. Periodically scans the subscribers table for rows
// whose best_send_hour_at is NULL or older than the staleness cutoff and
// runs Repo.Compute() against each one. Without this loop the entire
// send-time-optimization surface is dead: subscribers.best_send_hour stays
// permanently NULL, per-subscriber lookups 404, the segment endpoint
// reports `insufficient_data`, and the schedule-by-best-time preview
// fabricates UTC=9 from the tenant fallback.
//
// Klaviyo, Mailchimp, Iterable, Braze, and MoEngage all run continuous
// STO scoring as the foundational primitive — this worker is the
// minimum-viable equivalent.
//
// The worker honours the tenant-RLS contract: each Compute() call wraps
// its DB writes in db.WithTenant(tenantID, ...) so the
// `app.tenant_id` GUC is set before any UPDATE touches the row. The
// outer StaleSubscribers() scan is intentionally cross-tenant (the worker
// is a system actor) and uses the pool directly without setting the GUC.
package send_time_opt

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Default cadence + batch knobs. Override via Worker fields before Run().
const (
	defaultInterval   = 6 * time.Hour
	defaultBatchSize  = 1000
	defaultStaleAfter = 7 * 24 * time.Hour
)

// stoComputeRunsTotal increments once per worker tick (after StaleSubscribers
// completes), labelled by outcome so a run that produced zero recomputes is
// still observable.
//
//	sto_compute_worker_runs_total{outcome="ok|error|empty"}
var stoComputeRunsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "sto_compute_worker_runs_total",
	Help: "STO compute-worker ticks by outcome.",
}, []string{"outcome"})

// stoComputeSubscribersProcessed counts subscribers passed through Compute()
// — both writes and below-MinOpens noops. Labelled by result so we can
// distinguish productive vs. cold-subscriber work.
//
//	sto_compute_subscribers_processed{result="updated|cold"}
var stoComputeSubscribersProcessed = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "sto_compute_subscribers_processed",
	Help: "Subscribers processed by the STO compute worker.",
}, []string{"result"})

// stoComputeErrorsTotal counts per-subscriber Compute() failures. Tick-level
// errors (the StaleSubscribers scan itself) are folded into runs_total
// under outcome=error.
//
//	sto_compute_errors_total
var stoComputeErrorsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "sto_compute_errors_total",
	Help: "STO compute-worker per-subscriber errors.",
}, []string{}).WithLabelValues()

// stoFallbackAggregateRunsTotal counts cold-start fallback aggregate
// recomputes (sto-cold-start-fallback-hierarchy, P1). The aggregate
// runs after every successful tick and on demand; labelled by outcome
// so a sweep with zero warm subscribers is still observable.
//
//	sto_fallback_aggregate_runs_total{outcome="ok|error|empty"}
var stoFallbackAggregateRunsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "sto_fallback_aggregate_runs_total",
	Help: "STO tenant-modal-hour aggregate refresh runs by outcome.",
}, []string{"outcome"})

// Worker drains the stale-subscriber queue on a fixed interval.
type Worker struct {
	Repo *Repo
	// Interval defaults to 6h. Set lower for tests / backfills.
	Interval time.Duration
	// BatchSize is the max subscribers pulled per tick.
	BatchSize int
	// StaleAfter is the threshold past which a subscriber is treated as
	// stale and re-computed. Rows with a NULL best_send_hour_at are
	// always stale.
	StaleAfter time.Duration
	Logger     *slog.Logger
}

// NewWorker constructs a Worker with sensible defaults. Repo must be
// non-nil at Run-time.
func NewWorker(repo *Repo) *Worker {
	return &Worker{
		Repo:       repo,
		Interval:   defaultInterval,
		BatchSize:  defaultBatchSize,
		StaleAfter: defaultStaleAfter,
	}
}

func (w *Worker) interval() time.Duration {
	if w.Interval > 0 {
		return w.Interval
	}
	return defaultInterval
}

func (w *Worker) batchSize() int {
	if w.BatchSize > 0 {
		return w.BatchSize
	}
	return defaultBatchSize
}

func (w *Worker) staleAfter() time.Duration {
	if w.StaleAfter > 0 {
		return w.StaleAfter
	}
	return defaultStaleAfter
}

func (w *Worker) log() *slog.Logger {
	if w.Logger != nil {
		return w.Logger
	}
	return slog.Default()
}

// Run blocks until ctx is cancelled. Fires RunOnce immediately, then every
// w.interval(). Cancellation is checked between ticks AND between
// subscribers within a tick so shutdown is bounded.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.Repo == nil {
		return
	}
	// Kick off immediately so a freshly-deployed gateway populates the
	// first batch without waiting 6h. Subsequent ticks honour the
	// interval.
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

// RunOnce pulls one batch of stale subscribers and runs Compute on each.
// Returns (processed, errors). Always emits the run-level metric.
func (w *Worker) RunOnce(ctx context.Context) (int, int) {
	if w == nil || w.Repo == nil {
		return 0, 0
	}
	rows, err := w.Repo.StaleSubscribers(ctx, w.staleAfter(), w.batchSize())
	if err != nil {
		stoComputeRunsTotal.WithLabelValues("error").Inc()
		w.log().Error("sto-worker: stale-scan failed", "err", err)
		return 0, 1
	}
	if len(rows) == 0 {
		stoComputeRunsTotal.WithLabelValues("empty").Inc()
		return 0, 0
	}
	processed, errs := 0, 0
	for _, row := range rows {
		if ctx.Err() != nil {
			break
		}
		bh, cErr := w.Repo.Compute(ctx, row.TenantID, row.Email)
		if cErr != nil {
			// Don't let a single subscriber failure poison the whole
			// batch. Log + count, continue.
			errs++
			stoComputeErrorsTotal.Inc()
			// pgx context-cancellation errors will surface here on
			// shutdown — log at info to avoid noise.
			if errors.Is(cErr, context.Canceled) || errors.Is(cErr, context.DeadlineExceeded) {
				w.log().Info("sto-worker: compute cancelled", "tenant_id", row.TenantID)
				break
			}
			w.log().Warn("sto-worker: compute failed",
				"tenant_id", row.TenantID, "err", cErr)
			continue
		}
		processed++
		if bh != nil {
			stoComputeSubscribersProcessed.WithLabelValues("updated").Inc()
		} else {
			// Below MinOpens — Compute() returned (nil, nil). The row's
			// best_send_hour_at stays NULL so it'll re-surface in the
			// next tick. That's intentional: an opener trickle of a few
			// events shouldn't pin us to a low-confidence hour.
			stoComputeSubscribersProcessed.WithLabelValues("cold").Inc()
		}
	}
	if errs > 0 {
		stoComputeRunsTotal.WithLabelValues("error").Inc()
	} else {
		stoComputeRunsTotal.WithLabelValues("ok").Inc()
	}
	w.log().Info("sto-worker: tick complete",
		"processed", processed, "errors", errs, "batch", len(rows))
	// sto-cold-start-fallback-hierarchy (P1): refresh the per-tenant
	// modal-hour cache so the cold-subscriber GET surface sees a
	// recent aggregate. Doing this after the compute pass means each
	// tenant whose subscribers were just updated also gets a fresh
	// aggregate on the same tick — operators don't have to wait for
	// the next interval to see the fallback recommendation reflect
	// new opens/clicks.
	//
	// Aggregate failure is non-fatal — the Compute pass already
	// succeeded. We log + count and return the compute counts so the
	// caller's contract is unchanged.
	w.AggregateFallbacks(ctx)
	return processed, errs
}

// AggregateFallbacks refreshes tenant_modal_hour_cache for every tenant
// that owns at least one enabled subscriber. Called from RunOnce after
// the Compute pass and from a backfill CLI. Cross-tenant — the inner
// AggregateTenantModalHour call sets the RLS GUC per tenant.
//
// Returns (tenantsProcessed, errors). A nil Repo is a no-op.
func (w *Worker) AggregateFallbacks(ctx context.Context) (int, int) {
	if w == nil || w.Repo == nil {
		return 0, 0
	}
	tenants, err := w.Repo.TenantsWithSubscribers(ctx, 10000)
	if err != nil {
		stoFallbackAggregateRunsTotal.WithLabelValues("error").Inc()
		w.log().Warn("sto-worker: fallback tenants scan failed", "err", err)
		return 0, 1
	}
	if len(tenants) == 0 {
		stoFallbackAggregateRunsTotal.WithLabelValues("empty").Inc()
		return 0, 0
	}
	processed, errs := 0, 0
	for _, tid := range tenants {
		if ctx.Err() != nil {
			break
		}
		if _, _, aerr := w.Repo.AggregateTenantModalHour(ctx, tid); aerr != nil {
			errs++
			if errors.Is(aerr, context.Canceled) || errors.Is(aerr, context.DeadlineExceeded) {
				break
			}
			w.log().Warn("sto-worker: fallback aggregate failed",
				"tenant_id", tid, "err", aerr)
			continue
		}
		processed++
	}
	if errs > 0 {
		stoFallbackAggregateRunsTotal.WithLabelValues("error").Inc()
	} else {
		stoFallbackAggregateRunsTotal.WithLabelValues("ok").Inc()
	}
	w.log().Info("sto-worker: fallback aggregate complete",
		"tenants", processed, "errors", errs)
	return processed, errs
}

// Backfill runs the worker tick repeatedly until StaleSubscribers returns
// an empty slice (or ctx is cancelled, or maxBatches is exhausted). Use
// from a one-shot CLI flag to populate best_send_hour for every existing
// subscriber on first deploy. With staleAfter=0 every row is treated as
// stale, so the first call paints every subscriber that has >=MinOpens
// opens.
//
// maxBatches=0 means unbounded. Returns total processed + total errors.
func (w *Worker) Backfill(ctx context.Context, maxBatches int) (int, int) {
	if w == nil || w.Repo == nil {
		return 0, 0
	}
	// For a backfill, force every row to look stale: passing 0 makes the
	// cutoff = now, so any best_send_hour_at <= now (i.e. every row that
	// has ever been computed) is re-evaluated alongside the never-touched
	// NULL rows. Callers that want a gentler backfill can set
	// w.StaleAfter explicitly before invoking.
	prev := w.StaleAfter
	if prev <= 0 {
		w.StaleAfter = time.Nanosecond
	}
	defer func() { w.StaleAfter = prev }()
	totalProcessed, totalErrs, batches := 0, 0, 0
	for {
		if ctx.Err() != nil {
			break
		}
		rows, err := w.Repo.StaleSubscribers(ctx, w.staleAfter(), w.batchSize())
		if err != nil {
			stoComputeRunsTotal.WithLabelValues("error").Inc()
			w.log().Error("sto-worker: backfill scan failed", "err", err)
			totalErrs++
			break
		}
		if len(rows) == 0 {
			stoComputeRunsTotal.WithLabelValues("empty").Inc()
			break
		}
		p, e := 0, 0
		for _, row := range rows {
			if ctx.Err() != nil {
				break
			}
			bh, cErr := w.Repo.Compute(ctx, row.TenantID, row.Email)
			if cErr != nil {
				e++
				stoComputeErrorsTotal.Inc()
				if errors.Is(cErr, context.Canceled) || errors.Is(cErr, context.DeadlineExceeded) {
					break
				}
				w.log().Warn("sto-worker: backfill compute failed",
					"tenant_id", row.TenantID, "err", cErr)
				continue
			}
			p++
			if bh != nil {
				stoComputeSubscribersProcessed.WithLabelValues("updated").Inc()
			} else {
				stoComputeSubscribersProcessed.WithLabelValues("cold").Inc()
			}
		}
		if e > 0 {
			stoComputeRunsTotal.WithLabelValues("error").Inc()
		} else {
			stoComputeRunsTotal.WithLabelValues("ok").Inc()
		}
		totalProcessed += p
		totalErrs += e
		batches++
		if maxBatches > 0 && batches >= maxBatches {
			break
		}
		// If the batch returned only cold/null rows we'd loop forever
		// (Compute leaves best_send_hour_at NULL when below MinOpens,
		// so the same rows would resurface). Break when nothing was
		// productively updated.
		if p == 0 {
			break
		}
	}
	w.log().Info("sto-worker: backfill complete",
		"batches", batches, "processed", totalProcessed, "errors", totalErrs)
	return totalProcessed, totalErrs
}

// TenantsWithSubscribers returns up to `limit` distinct tenant ids that
// own at least one enabled subscriber. Cross-tenant scan — used by
// AggregateFallbacks to walk every tenant whose modal-hour aggregate
// should be refreshed. Bypasses the RLS GUC because the caller is a
// system actor (the worker); the inner AggregateTenantModalHour call
// re-enters tenant scope per row.
func (r *Repo) TenantsWithSubscribers(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 10000
	}
	rows, err := r.Pool.Query(ctx, `
SELECT DISTINCT tenant_id::text
FROM subscribers
WHERE status = 'enabled'
LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AggregateTenantModalHour computes the modal hour-of-day for a single
// tenant and upserts it into tenant_modal_hour_cache. Returns the
// computed hour, ok=true when we had enough samples to write a row, and
// err on a hard DB failure.
//
// "Enough samples" means at least MinSegmentSamples warm subscribers
// (matching the floor used by the segment-aggregate surface) — below
// that we leave the cache row alone so the cold-start fallback path
// doesn't latch onto a noisy aggregate. On a brand-new tenant or one
// whose cache migration hasn't run yet, an upsert failure is logged at
// the caller (worker.AggregateFallbacks) and counted as an error
// without crashing the tick.
//
// Uses db.WithTenant so the RLS policy on tenant_modal_hour_cache fires
// correctly when present; if the cache table doesn't yet exist on this
// deployment, the INSERT silently fails and we return (hour, false,
// nil) so the worker's tick still completes cleanly.
func (r *Repo) AggregateTenantModalHour(ctx context.Context, tenantID string) (int, bool, error) {
	if tenantID == "" {
		return 0, false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT best_send_hour FROM subscribers
WHERE tenant_id = $1::uuid
  AND status = 'enabled'
  AND best_send_hour IS NOT NULL`, tenantID)
	if err != nil {
		return 0, false, err
	}
	hours := make([]int, 0, 256)
	for rows.Next() {
		var h *int
		if scanErr := rows.Scan(&h); scanErr != nil {
			rows.Close()
			return 0, false, scanErr
		}
		if h != nil {
			hours = append(hours, *h%24)
		}
	}
	rows.Close()
	if rerr := rows.Err(); rerr != nil {
		return 0, false, rerr
	}
	if len(hours) < MinSegmentSamples {
		// Not enough confident samples — don't touch the cache so
		// the cold-start fallback keeps using whatever it had (an
		// explicit operator override, or the global default).
		if cerr := tx.Commit(ctx); cerr != nil {
			return 0, false, cerr
		}
		return GlobalDefaultHour, false, nil
	}
	hour, _ := Mode(hours)
	sampleSize := len(hours)
	// Best-effort upsert. The table is installed by migration 0306; if
	// the deployment is mid-migration the INSERT will error and we
	// return (hour, false, err) so the caller logs without aborting
	// the tick.
	if _, uerr := tx.Exec(ctx, `
INSERT INTO tenant_modal_hour_cache (tenant_id, modal_hour, sample_size, computed_at)
VALUES ($1::uuid, $2::int2, $3, now())
ON CONFLICT (tenant_id) DO UPDATE
SET modal_hour = EXCLUDED.modal_hour,
    sample_size = EXCLUDED.sample_size,
    computed_at = EXCLUDED.computed_at`, tenantID, hour, sampleSize); uerr != nil {
		return hour, false, uerr
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return hour, false, cerr
	}
	return hour, true, nil
}
