// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	tallyBackfillWorkerDefaultInterval       = 15 * time.Minute
	tallyBackfillWorkerDefaultDueAfter       = time.Hour
	tallyBackfillWorkerDefaultLimit          = 10
	tallyBackfillWorkerDefaultMaxPagesPerRun = 10
)

type TallyBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type TallyBackfillWorkerStore interface {
	Store
	ListTallyBackfillTargets(context.Context, int, time.Time) ([]TallyBackfillTarget, error)
}

type TallyBackfillWorker struct {
	Deps           *Deps
	Store          TallyBackfillWorkerStore
	Backfiller     TallyBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type TallyBackfillWorkerSummary struct {
	Targets             int
	Completed           int
	Failed              int
	Pages               int
	SubmissionsSeen     int
	SubscribersUpserted int
	EventsTracked       int
}

func (w *TallyBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = tallyBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("tally backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("tally backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("tally backfill tick complete",
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

func (w *TallyBackfillWorker) tick(ctx context.Context) (TallyBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return TallyBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = tallyBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = tallyBackfillWorkerDefaultLimit
	}
	targets, err := store.ListTallyBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return TallyBackfillWorkerSummary{}, err
	}
	summary := TallyBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.tallyBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("tally backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := TallyBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("tally scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
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

func (w *TallyBackfillWorker) storeAndDeps() (TallyBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("tally backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(TallyBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("tally backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *TallyBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *TallyBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return tallyBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
