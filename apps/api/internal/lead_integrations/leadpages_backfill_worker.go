// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	leadpagesBackfillWorkerDefaultInterval       = 15 * time.Minute
	leadpagesBackfillWorkerDefaultDueAfter       = time.Hour
	leadpagesBackfillWorkerDefaultLimit          = 10
	leadpagesBackfillWorkerDefaultMaxPagesPerRun = 10
)

type LeadpagesBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type LeadpagesBackfillWorkerStore interface {
	Store
	ListLeadpagesBackfillTargets(context.Context, int, time.Time) ([]LeadpagesBackfillTarget, error)
}

type LeadpagesBackfillWorker struct {
	Deps           *Deps
	Store          LeadpagesBackfillWorkerStore
	Backfiller     LeadpagesBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type LeadpagesBackfillWorkerSummary struct {
	Targets             int
	Failed              int
	Pages               int
	SubmissionsSeen     int
	SubscribersUpserted int
	EventsTracked       int
}

func (w *LeadpagesBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = leadpagesBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("leadpages backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("leadpages backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("leadpages backfill tick complete",
				"targets", summary.Targets,
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

func (w *LeadpagesBackfillWorker) tick(ctx context.Context) (LeadpagesBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return LeadpagesBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = leadpagesBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = leadpagesBackfillWorkerDefaultLimit
	}
	targets, err := store.ListLeadpagesBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return LeadpagesBackfillWorkerSummary{}, err
	}
	summary := LeadpagesBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.leadpagesBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("leadpages backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := LeadpagesBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("leadpages scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		summary.Pages += out.Pages
		summary.SubmissionsSeen += out.SubmissionsSeen
		summary.SubscribersUpserted += out.SubscribersUpserted
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *LeadpagesBackfillWorker) storeAndDeps() (LeadpagesBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("leadpages backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(LeadpagesBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("leadpages backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *LeadpagesBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *LeadpagesBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return leadpagesBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
