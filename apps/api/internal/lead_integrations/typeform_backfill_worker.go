// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	typeformBackfillWorkerDefaultInterval       = 15 * time.Minute
	typeformBackfillWorkerDefaultDueAfter       = time.Hour
	typeformBackfillWorkerDefaultLimit          = 10
	typeformBackfillWorkerDefaultMaxPagesPerRun = 10
)

type TypeformBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type TypeformBackfillWorkerStore interface {
	Store
	ListTypeformBackfillTargets(context.Context, int, time.Time) ([]TypeformBackfillTarget, error)
}

type TypeformBackfillWorker struct {
	Deps           *Deps
	Store          TypeformBackfillWorkerStore
	Backfiller     TypeformBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type TypeformBackfillWorkerSummary struct {
	Targets             int
	Completed           int
	Failed              int
	Pages               int
	SubmissionsSeen     int
	SubscribersUpserted int
	EventsTracked       int
}

func (w *TypeformBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = typeformBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("typeform backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("typeform backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("typeform backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"submissions_seen", summary.SubmissionsSeen,
				"subscribers_upserted", summary.SubscribersUpserted,
				"events_tracked", summary.EventsTracked)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *TypeformBackfillWorker) tick(ctx context.Context) (TypeformBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return TypeformBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = typeformBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = typeformBackfillWorkerDefaultLimit
	}
	targets, err := store.ListTypeformBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return TypeformBackfillWorkerSummary{}, err
	}
	summary := TypeformBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.typeformBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("typeform backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := TypeformBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("typeform scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.SubmissionsSeen += out.SubmissionsSeen
		summary.SubscribersUpserted += out.SubscribersUpserted
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *TypeformBackfillWorker) storeAndDeps() (TypeformBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("typeform backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(TypeformBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("typeform backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *TypeformBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *TypeformBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return typeformBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
