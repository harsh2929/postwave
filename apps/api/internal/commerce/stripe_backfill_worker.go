package commerce

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	stripeBackfillWorkerDefaultInterval       = 15 * time.Minute
	stripeBackfillWorkerDefaultDueAfter       = time.Hour
	stripeBackfillWorkerDefaultLimit          = 10
	stripeBackfillWorkerDefaultMaxPagesPerRun = 10
)

type StripeBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type StripeBackfillWorkerStore interface {
	StripeBackfillStore
	ListStripeBackfillTargets(context.Context, int, time.Time) ([]StripeBackfillTarget, error)
}

type StripeBackfillWorker struct {
	Store          StripeBackfillWorkerStore
	Backfiller     StripeBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type StripeBackfillWorkerSummary struct {
	Targets           int
	Completed         int
	Failed            int
	Pages             int
	CustomersUpserted int
	ProductsUpserted  int
	OrdersUpserted    int
	EventsRecorded    int
}

func (w *StripeBackfillWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return errors.New("stripe backfill worker: missing store")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = stripeBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("stripe backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("stripe backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("stripe backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"customers_upserted", summary.CustomersUpserted,
				"products_upserted", summary.ProductsUpserted,
				"orders_upserted", summary.OrdersUpserted,
				"events_recorded", summary.EventsRecorded)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *StripeBackfillWorker) tick(ctx context.Context) (StripeBackfillWorkerSummary, error) {
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = stripeBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = stripeBackfillWorkerDefaultLimit
	}
	targets, err := w.Store.ListStripeBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return StripeBackfillWorkerSummary{}, err
	}
	summary := StripeBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		return summary, errors.New("stripe backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := StripeBulkBackfillRunner{
			Store:      w.Store,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("stripe scheduled backfill failed",
					"tenant", target.TenantID,
					"integration", target.IntegrationID,
					"cursor", target.Cursor,
					"err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.CustomersUpserted += out.CustomersUpserted
		summary.ProductsUpserted += out.ProductsUpserted
		summary.OrdersUpserted += out.OrdersUpserted
		summary.EventsRecorded += out.EventsRecorded
	}
	return summary, nil
}

func (w *StripeBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *StripeBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return stripeBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
