package commerce

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	wixStoresBackfillWorkerDefaultInterval       = 15 * time.Minute
	wixStoresBackfillWorkerDefaultDueAfter       = time.Hour
	wixStoresBackfillWorkerDefaultLimit          = 10
	wixStoresBackfillWorkerDefaultMaxPagesPerRun = 10
)

type WixStoresBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type WixStoresBackfillWorkerStore interface {
	WixStoresBackfillStore
	ListWixStoresBackfillTargets(context.Context, int, time.Time) ([]WixStoresBackfillTarget, error)
}

type WixStoresBackfillWorker struct {
	Store          WixStoresBackfillWorkerStore
	Backfiller     WixStoresBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type WixStoresBackfillWorkerSummary struct {
	Targets           int
	Completed         int
	Failed            int
	Pages             int
	CustomersUpserted int
	ProductsUpserted  int
	OrdersUpserted    int
}

func (w *WixStoresBackfillWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return errors.New("wix stores backfill worker: missing store")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = wixStoresBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("wix stores backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("wix stores backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("wix stores backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"customers_upserted", summary.CustomersUpserted,
				"products_upserted", summary.ProductsUpserted,
				"orders_upserted", summary.OrdersUpserted)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *WixStoresBackfillWorker) tick(ctx context.Context) (WixStoresBackfillWorkerSummary, error) {
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = wixStoresBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = wixStoresBackfillWorkerDefaultLimit
	}
	targets, err := w.Store.ListWixStoresBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return WixStoresBackfillWorkerSummary{}, err
	}
	summary := WixStoresBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		return summary, errors.New("wix stores backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := WixStoresBulkBackfillRunner{
			Store:      w.Store,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("wix stores scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
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
	}
	return summary, nil
}

func (w *WixStoresBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *WixStoresBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return wixStoresBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
