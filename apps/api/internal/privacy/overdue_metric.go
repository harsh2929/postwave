// SPDX-License-Identifier: AGPL-3.0-only
//
// overdue_metric.go — exposes a Prometheus gauge for the count of
// privacy_requests rows whose due_at has passed without being
// fulfilled. Closes the GDPR audit HIGH #3 gap: previously the
// 30-day deadline was tracked in the DB column but nothing
// surfaced overdue requests to the operator, so the platform could
// silently breach the legal deadline.
//
// The gauge is scraped by the standard /metrics endpoint and feeds
// the day-1 dashboard panel "Overdue privacy requests" + a
// CloudWatch alarm (defined separately in
// infra/aws/cloudwatch-alarms.yaml) that pages the on-call when
// the count goes non-zero.

package privacy

import (
	"context"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var overdueRequests = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "postwave_privacy_overdue_requests",
	Help: "Count of privacy_requests rows past their due_at without being fulfilled. Labeled by request_type (export | deletion). Non-zero means we are breaching the legal SLA — page the on-call.",
}, []string{"request_type"})

// OverdueWorker periodically queries the privacy_requests table for
// rows past due_at + not fulfilled, and exposes the count via the
// overdueRequests gauge. Cross-tenant: uses the audit-trimmer-style
// app.outbox_worker GUC bypass since the gauge is operator-facing
// (not per-tenant).
type OverdueWorker struct {
	Pool     *db.Pool
	Interval time.Duration
	Logger   *slog.Logger
}

// Run blocks until ctx is cancelled. Ticks every Interval (default
// 5 min — long enough to be cheap, short enough that an overdue
// flag is visible to the alerter within one alarm window).
func (w *OverdueWorker) Run(ctx context.Context) {
	if w == nil || w.Pool == nil {
		return
	}
	if w.Interval <= 0 {
		w.Interval = 5 * time.Minute
	}
	// Initial tick so the gauge has a value before the first alarm
	// evaluation cycle.
	w.tick(ctx)
	t := time.NewTicker(w.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			w.tick(ctx)
		}
	}
}

func (w *OverdueWorker) tick(ctx context.Context) {
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		w.warn("begin", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.outbox_worker', 'true', true)`); err != nil {
		w.warn("set_config", err)
		return
	}
	rows, err := tx.Query(ctx, `
SELECT request_type, COUNT(*)::int
  FROM privacy_requests
 WHERE due_at IS NOT NULL
   AND due_at < now()
   AND status NOT IN ('fulfilled', 'cancelled', 'rejected')
 GROUP BY request_type`)
	if err != nil {
		w.warn("query", err)
		return
	}
	defer rows.Close()
	// Reset known labels to 0 first so a previously-overdue type
	// that's now caught up drops back to zero (Prometheus doesn't
	// automatically zero out absent label values).
	overdueRequests.WithLabelValues("export").Set(0)
	overdueRequests.WithLabelValues("deletion").Set(0)
	for rows.Next() {
		var typ string
		var n int
		if err := rows.Scan(&typ, &n); err != nil {
			w.warn("scan", err)
			return
		}
		overdueRequests.WithLabelValues(typ).Set(float64(n))
	}
	if err := rows.Err(); err != nil {
		w.warn("rows", err)
		return
	}
	_ = tx.Commit(ctx)
}

func (w *OverdueWorker) warn(stage string, err error) {
	if w.Logger != nil {
		w.Logger.Warn("privacy overdue worker", "stage", stage, "err", err.Error())
	}
}
