// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	gravityFormsBackfillWorkerDefaultInterval       = 15 * time.Minute
	gravityFormsBackfillWorkerDefaultDueAfter       = time.Hour
	gravityFormsBackfillWorkerDefaultLimit          = 10
	gravityFormsBackfillWorkerDefaultMaxPagesPerRun = 10
)

type GravityFormsBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type GravityFormsBackfillWorkerStore interface {
	Store
	ListGravityFormsBackfillTargets(context.Context, int, time.Time) ([]GravityFormsBackfillTarget, error)
}

type GravityFormsBackfillWorker struct {
	Deps           *Deps
	Store          GravityFormsBackfillWorkerStore
	Backfiller     GravityFormsBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type GravityFormsBackfillWorkerSummary struct {
	Targets             int
	Failed              int
	Pages               int
	SubmissionsSeen     int
	SubscribersUpserted int
	EventsTracked       int
}

func (w *GravityFormsBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = gravityFormsBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("gravity forms backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("gravity forms backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("gravity forms backfill tick complete",
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

func (w *GravityFormsBackfillWorker) tick(ctx context.Context) (GravityFormsBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return GravityFormsBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = gravityFormsBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = gravityFormsBackfillWorkerDefaultLimit
	}
	targets, err := store.ListGravityFormsBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return GravityFormsBackfillWorkerSummary{}, err
	}
	summary := GravityFormsBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.gravityFormsBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("gravity forms backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := GravityFormsBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("gravity forms scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
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

func (w *GravityFormsBackfillWorker) storeAndDeps() (GravityFormsBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("gravity forms backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(GravityFormsBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("gravity forms backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *GravityFormsBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *GravityFormsBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return gravityFormsBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
