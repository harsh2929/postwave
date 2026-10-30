// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	pipedriveBackfillWorkerDefaultInterval       = 15 * time.Minute
	pipedriveBackfillWorkerDefaultDueAfter       = time.Hour
	pipedriveBackfillWorkerDefaultLimit          = 10
	pipedriveBackfillWorkerMaxCandidateScan      = 1000
	pipedriveBackfillWorkerDefaultMaxPagesPerRun = 10
)

type PipedriveBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type PipedriveBackfillWorkerStore interface {
	Store
	ListPipedriveBackfillTargets(context.Context, int, time.Time) ([]PipedriveBackfillTarget, error)
}

type PipedriveBackfillWorker struct {
	Deps           *Deps
	Store          PipedriveBackfillWorkerStore
	Backfiller     PipedriveBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type PipedriveBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ContactsSeen     int
	ContactsUpserted int
	EventsSeen       int
	EventsTracked    int
}

func (w *PipedriveBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = pipedriveBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("pipedrive backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("pipedrive backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("pipedrive backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"contacts_seen", summary.ContactsSeen,
				"contacts_upserted", summary.ContactsUpserted,
				"events_seen", summary.EventsSeen,
				"events_tracked", summary.EventsTracked)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *PipedriveBackfillWorker) tick(ctx context.Context) (PipedriveBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return PipedriveBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = pipedriveBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = pipedriveBackfillWorkerDefaultLimit
	}
	targets, err := store.ListPipedriveBackfillTargets(ctx, pipedriveBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return PipedriveBackfillWorkerSummary{}, err
	}
	summary := PipedriveBackfillWorkerSummary{}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.pipedriveBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("pipedrive backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if pipedriveBackfillTargetRetryNotDue(target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := PipedriveBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("pipedrive scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ContactsSeen += out.ContactsSeen
		summary.ContactsUpserted += out.ContactsUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *PipedriveBackfillWorker) storeAndDeps() (PipedriveBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("pipedrive backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(PipedriveBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("pipedrive backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *PipedriveBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *PipedriveBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return pipedriveBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func pipedriveBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = pipedriveBackfillWorkerDefaultLimit
	}
	if limit >= pipedriveBackfillWorkerMaxCandidateScan {
		return limit
	}
	return pipedriveBackfillWorkerMaxCandidateScan
}
