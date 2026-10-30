package commerce

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	razorpayBackfillWorkerDefaultInterval       = 15 * time.Minute
	razorpayBackfillWorkerDefaultDueAfter       = time.Hour
	razorpayBackfillWorkerDefaultLimit          = 10
	razorpayBackfillWorkerDefaultMaxPagesPerRun = 10
)

type RazorpayBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type RazorpayBackfillWorkerStore interface {
	RazorpayBackfillStore
	ListRazorpayBackfillTargets(context.Context, int, time.Time) ([]RazorpayBackfillTarget, error)
}

type RazorpayBackfillWorker struct {
	Store          RazorpayBackfillWorkerStore
	Backfiller     RazorpayBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type RazorpayBackfillWorkerSummary struct {
	Targets           int
	Completed         int
	Failed            int
	Pages             int
	CustomersUpserted int
	ProductsUpserted  int
	OrdersUpserted    int
	EventsRecorded    int
}

func (w *RazorpayBackfillWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return errors.New("razorpay backfill worker: missing store")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = razorpayBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("razorpay backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("razorpay backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("razorpay backfill tick complete",
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

func (w *RazorpayBackfillWorker) tick(ctx context.Context) (RazorpayBackfillWorkerSummary, error) {
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = razorpayBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = razorpayBackfillWorkerDefaultLimit
	}
	targets, err := w.Store.ListRazorpayBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return RazorpayBackfillWorkerSummary{}, err
	}
	summary := RazorpayBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		return summary, errors.New("razorpay backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := RazorpayBulkBackfillRunner{
			Store:      w.Store,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("razorpay scheduled backfill failed",
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

func (w *RazorpayBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *RazorpayBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return razorpayBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
