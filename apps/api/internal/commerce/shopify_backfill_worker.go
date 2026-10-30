package commerce

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	shopifyBackfillWorkerDefaultInterval       = 15 * time.Minute
	shopifyBackfillWorkerDefaultDueAfter       = time.Hour
	shopifyBackfillWorkerDefaultLimit          = 10
	shopifyBackfillWorkerDefaultMaxPagesPerRun = 10
)

type ShopifyBackfillWorkerStore interface {
	ShopifyBackfillStore
	ListShopifyBackfillTargets(context.Context, int, time.Time) ([]ShopifyBackfillTarget, error)
	ListShopifyBulkOperationTargets(context.Context, int, time.Time) ([]ShopifyBackfillTarget, error)
}

type ShopifyBackfillWorker struct {
	Store          ShopifyBackfillWorkerStore
	Backfiller     ShopifyBackfiller
	BulkOperator   ShopifyBulkOperator
	BulkImporter   ShopifyBulkResultImporter
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type ShopifyBackfillWorkerSummary struct {
	Targets           int
	AsyncTargets      int
	Completed         int
	Failed            int
	Pages             int
	CustomersUpserted int
	ProductsUpserted  int
	OrdersUpserted    int
}

func (w *ShopifyBackfillWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return errors.New("shopify backfill worker: missing store")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = shopifyBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("shopify backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("shopify backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("shopify backfill tick complete",
				"targets", summary.Targets,
				"async_targets", summary.AsyncTargets,
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

func (w *ShopifyBackfillWorker) tick(ctx context.Context) (ShopifyBackfillWorkerSummary, error) {
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = shopifyBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = shopifyBackfillWorkerDefaultLimit
	}
	targets, err := w.Store.ListShopifyBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return ShopifyBackfillWorkerSummary{}, err
	}
	summary := ShopifyBackfillWorkerSummary{Targets: len(targets)}
	asyncTargets, err := w.Store.ListShopifyBulkOperationTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return ShopifyBackfillWorkerSummary{}, err
	}
	summary.Targets += len(asyncTargets)
	summary.AsyncTargets = len(asyncTargets)
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = ShopifyAdminGraphQLBackfiller{}
	}
	for _, target := range targets {
		runner := ShopifyBulkBackfillRunner{
			Store:      w.Store,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("shopify scheduled backfill failed",
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
	}
	for _, target := range asyncTargets {
		out, err := w.runAsyncBulkTarget(ctx, target)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("shopify async bulk retry failed",
					"tenant", target.TenantID,
					"integration", target.IntegrationID,
					"cursor", target.Cursor,
					"err", err.Error())
			}
			continue
		}
		if shopifyBulkOperationSyncError(out) != nil {
			summary.Failed++
			continue
		}
		if out.Status == "COMPLETED" && (out.Imported || !out.ResultURLPresent) {
			summary.Completed++
		}
		summary.CustomersUpserted += out.CustomersUpserted
		summary.ProductsUpserted += out.ProductsUpserted
		summary.OrdersUpserted += out.OrdersUpserted
	}
	return summary, nil
}

func (w *ShopifyBackfillWorker) runAsyncBulkTarget(ctx context.Context, target ShopifyBackfillTarget) (ShopifyAsyncBulkBackfillSummary, error) {
	integration, err := w.Store.GetIntegration(ctx, target.TenantID, target.IntegrationID)
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	if integration == nil {
		return ShopifyAsyncBulkBackfillSummary{}, ErrNotFound
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		return ShopifyAsyncBulkBackfillSummary{
			IntegrationID: target.IntegrationID,
			Cursor:        firstNonEmpty(target.Cursor, integration.SyncCursor),
		}, nil
	}
	state, ok, err := decodeShopifyBulkOperationCursor(firstNonEmpty(target.Cursor, integration.SyncCursor))
	if err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	if !ok {
		return ShopifyAsyncBulkBackfillSummary{}, nil
	}
	if !shopifyBulkOperationCursorDue(state, w.now()) {
		return ShopifyAsyncBulkBackfillSummary{
			IntegrationID: target.IntegrationID,
			OperationID:   state.OperationID,
			Object:        state.Object,
			Status:        "WAITING",
			Cursor:        firstNonEmpty(target.Cursor, integration.SyncCursor),
			Message:       "Shopify bulk retry backoff is active; waiting for next_attempt_at.",
		}, nil
	}
	operator := w.BulkOperator
	if operator == nil {
		operator = ShopifyAdminGraphQLBulkOperator{}
	}
	summary, err := operator.PollBulkBackfill(ctx, *integration, state.OperationID, state.Object)
	if err != nil {
		retryCursor := shopifyBulkOperationRetryCursor(state, "POLL_FAILED", err, w.now())
		_ = w.Store.SetIntegrationSync(ctx, target.TenantID, target.IntegrationID, retryCursor, w.now(), err)
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	if syncErr := shopifyBulkOperationSyncError(summary); syncErr != nil {
		summary.Cursor = shopifyBulkOperationRetryCursor(state, summary.Status, syncErr, w.now())
		_ = w.Store.SetIntegrationSync(ctx, target.TenantID, target.IntegrationID, summary.Cursor, w.now(), syncErr)
		return summary, nil
	}
	if strings.EqualFold(summary.Status, "COMPLETED") && strings.TrimSpace(summary.ResultURL) != "" {
		imported, err := w.importAsyncBulkResult(ctx, target, *integration, summary)
		if err != nil {
			return ShopifyAsyncBulkBackfillSummary{}, err
		}
		return imported, nil
	}
	if strings.EqualFold(summary.Status, "COMPLETED") {
		return w.completeAsyncBulkWithoutResult(ctx, target, summary)
	}
	if strings.TrimSpace(summary.Cursor) == "" && strings.TrimSpace(summary.OperationID) != "" {
		summary.Cursor = shopifyBulkOperationActiveCursor(state, summary.Status)
	}
	if err := w.Store.SetIntegrationSync(ctx, target.TenantID, target.IntegrationID, firstNonEmpty(summary.Cursor, target.Cursor), w.now(), nil); err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	return summary, nil
}

func (w *ShopifyBackfillWorker) completeAsyncBulkWithoutResult(ctx context.Context, target ShopifyBackfillTarget, summary ShopifyAsyncBulkBackfillSummary) (ShopifyAsyncBulkBackfillSummary, error) {
	object := normalizeShopifyBackfillObject(summary.Object)
	summary.Cursor = encodeShopifyBackfillCursor(shopifyBackfillState{Object: nextShopifyBackfillObject(object)})
	summary.ResultURLPresent = false
	summary.Message = "Shopify bulk operation completed with no result URL; treated as no records and advanced to the next resource."
	if err := w.Store.SetIntegrationSync(ctx, target.TenantID, target.IntegrationID, summary.Cursor, w.now(), nil); err != nil {
		return ShopifyAsyncBulkBackfillSummary{}, err
	}
	return summary, nil
}

func (w *ShopifyBackfillWorker) importAsyncBulkResult(ctx context.Context, target ShopifyBackfillTarget, integration Integration, summary ShopifyAsyncBulkBackfillSummary) (ShopifyAsyncBulkBackfillSummary, error) {
	importer := w.BulkImporter
	if importer == nil {
		importer = ShopifyJSONLBulkResultImporter{}
	}
	return shopifyAsyncBulkResultImportRunner{
		Store:    w.Store,
		Importer: importer,
		Now:      w.now,
	}.Import(ctx, target.TenantID, target.IntegrationID, integration, summary)
}

func (w *ShopifyBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *ShopifyBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return shopifyBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
