// SPDX-License-Identifier: AGPL-3.0-only
package lead_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	cognitoFormsBackfillWorkerDefaultInterval       = 15 * time.Minute
	cognitoFormsBackfillWorkerDefaultDueAfter       = time.Hour
	cognitoFormsBackfillWorkerDefaultLimit          = 5
	cognitoFormsBackfillWorkerDefaultMaxPagesPerRun = 5
)

type CognitoFormsBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type CognitoFormsBackfillWorkerStore interface {
	Store
	ListCognitoFormsBackfillTargets(context.Context, int, time.Time) ([]CognitoFormsBackfillTarget, error)
}

type CognitoFormsBackfillWorker struct {
	Deps           *Deps
	Store          CognitoFormsBackfillWorkerStore
	Backfiller     CognitoFormsBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type CognitoFormsBackfillWorkerSummary struct {
	Targets             int
	Failed              int
	Pages               int
	SubmissionsSeen     int
	SubscribersUpserted int
	EventsTracked       int
}

func (w *CognitoFormsBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = cognitoFormsBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("Cognito Forms backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("Cognito Forms backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("Cognito Forms backfill tick complete",
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

func (w *CognitoFormsBackfillWorker) tick(ctx context.Context) (CognitoFormsBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return CognitoFormsBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = cognitoFormsBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = cognitoFormsBackfillWorkerDefaultLimit
	}
	targets, err := store.ListCognitoFormsBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return CognitoFormsBackfillWorkerSummary{}, err
	}
	summary := CognitoFormsBackfillWorkerSummary{Targets: len(targets)}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.cognitoFormsBackfiller()
	}
	if backfiller == nil {
		return summary, errors.New("Cognito Forms backfill worker: missing backfiller")
	}
	for _, target := range targets {
		runner := CognitoFormsBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("Cognito Forms scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
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

func (w *CognitoFormsBackfillWorker) storeAndDeps() (CognitoFormsBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("Cognito Forms backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(CognitoFormsBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("Cognito Forms backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *CognitoFormsBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *CognitoFormsBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return cognitoFormsBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
