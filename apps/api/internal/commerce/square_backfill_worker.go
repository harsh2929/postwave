package commerce

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	squareBackfillWorkerDefaultInterval       = 15 * time.Minute
	squareBackfillWorkerDefaultDueAfter       = time.Hour
	squareBackfillWorkerDefaultLimit          = 10
	squareBackfillWorkerDefaultMaxPagesPerRun = 10
	squareBackfillWorkerMaxCandidateScan      = 250
)

type SquareBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type SquareBackfillWorkerStore interface {
	SquareBackfillStore
	ListSquareBackfillTargets(context.Context, int, time.Time) ([]SquareBackfillTarget, error)
}

type SquareBackfillWorker struct {
	Store          SquareBackfillWorkerStore
	Backfiller     SquareBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type SquareBackfillWorkerSummary struct {
	Targets           int
	Completed         int
	Failed            int
	Pages             int
	CustomersUpserted int
	ProductsUpserted  int
	OrdersUpserted    int
	EventsRecorded    int
}

func (w *SquareBackfillWorker) Run(ctx context.Context) error {
	if w == nil || w.Store == nil {
		return errors.New("square backfill worker: missing store")
	}
	interval := w.Interval
	if interval <= 0 {
		interval = squareBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("square backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("square backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("square backfill tick complete",
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

func (w *SquareBackfillWorker) tick(ctx context.Context) (SquareBackfillWorkerSummary, error) {
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = squareBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = squareBackfillWorkerDefaultLimit
	}
	targets, err := w.Store.ListSquareBackfillTargets(ctx, squareBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return SquareBackfillWorkerSummary{}, err
	}
	summary := SquareBackfillWorkerSummary{}
	backfiller := w.Backfiller
	if backfiller == nil {
		return summary, errors.New("square backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if squareBackfillTargetRetryNotDue(target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := SquareBulkBackfillRunner{
			Store:      w.Store,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("square scheduled backfill failed",
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

func (w *SquareBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *SquareBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return squareBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func squareBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = squareBackfillWorkerDefaultLimit
	}
	if limit >= squareBackfillWorkerMaxCandidateScan {
		return limit
	}
	return squareBackfillWorkerMaxCandidateScan
}

func squareBackfillTargetRetryNotDue(cursor string, now time.Time) bool {
	retry, ok, err := decodeSquareRetryCursor(strings.TrimSpace(cursor))
	return err == nil && ok && !squareRetryCursorDue(retry, now)
}
