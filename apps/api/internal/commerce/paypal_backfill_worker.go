package commerce

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	payPalBackfillWorkerDefaultInterval       = 15 * time.Minute
	payPalBackfillWorkerDefaultDueAfter       = time.Hour
	payPalBackfillWorkerDefaultLimit          = 10
	payPalBackfillWorkerDefaultMaxPagesPerRun = 10
	payPalBackfillWorkerMaxCandidateScan      = 250
)

type PayPalBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type PayPalBackfillWorkerStore interface {
	PayPalBackfillStore
	ListPayPalBackfillTargets(context.Context, int, time.Time) ([]PayPalBackfillTarget, error)
}

type PayPalBackfillWorker struct {
	Store          PayPalBackfillWorkerStore
	Backfiller     PayPalBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type PayPalBackfillWorkerSummary struct {
	Targets           int
	Completed         int
	Failed            int
	Pages             int
	CustomersUpserted int
	ProductsUpserted  int
	OrdersUpserted    int
	EventsRecorded    int
}

func (w *PayPalBackfillWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return errors.New("paypal backfill worker: missing store")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = payPalBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("paypal backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("paypal backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("paypal backfill tick complete",
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

func (w *PayPalBackfillWorker) tick(ctx context.Context) (PayPalBackfillWorkerSummary, error) {
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = payPalBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = payPalBackfillWorkerDefaultLimit
	}
	targets, err := w.Store.ListPayPalBackfillTargets(ctx, payPalBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return PayPalBackfillWorkerSummary{}, err
	}
	summary := PayPalBackfillWorkerSummary{}
	backfiller := w.Backfiller
	if backfiller == nil {
		return summary, errors.New("paypal backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if payPalBackfillTargetRetryNotDue(target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := PayPalBulkBackfillRunner{
			Store:      w.Store,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("paypal scheduled backfill failed",
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

func (w *PayPalBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *PayPalBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return payPalBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func payPalBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = payPalBackfillWorkerDefaultLimit
	}
	if limit >= payPalBackfillWorkerMaxCandidateScan {
		return limit
	}
	return payPalBackfillWorkerMaxCandidateScan
}

func payPalBackfillTargetRetryNotDue(cursor string, now time.Time) bool {
	retry, ok, err := decodePayPalRetryCursor(strings.TrimSpace(cursor))
	return err == nil && ok && !payPalRetryCursorDue(retry, now)
}
