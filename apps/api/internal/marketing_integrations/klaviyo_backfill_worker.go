// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	klaviyoBackfillWorkerDefaultInterval       = 15 * time.Minute
	klaviyoBackfillWorkerDefaultDueAfter       = time.Hour
	klaviyoBackfillWorkerDefaultLimit          = 10
	klaviyoBackfillWorkerDefaultMaxPagesPerRun = 10
)

type KlaviyoBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type KlaviyoBackfillWorkerStore interface {
	Store
	ListKlaviyoBackfillTargets(context.Context, int, time.Time) ([]KlaviyoBackfillTarget, error)
}

type KlaviyoBackfillWorker struct {
	Deps           *Deps
	Store          KlaviyoBackfillWorkerStore
	Puller         KlaviyoProviderPuller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type KlaviyoBackfillWorkerSummary struct {
	Targets      int
	Completed    int
	Failed       int
	Skipped      int
	Pages        int
	ProfilesSeen int
	EventsSeen   int
	ListsSeen    int
}

func (w *KlaviyoBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = klaviyoBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("klaviyo backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("klaviyo backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("klaviyo backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"skipped", summary.Skipped,
				"pages", summary.Pages,
				"profiles_seen", summary.ProfilesSeen,
				"events_seen", summary.EventsSeen,
				"lists_seen", summary.ListsSeen)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *KlaviyoBackfillWorker) tick(ctx context.Context) (KlaviyoBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return KlaviyoBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = klaviyoBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = klaviyoBackfillWorkerDefaultLimit
	}
	targets, err := store.ListKlaviyoBackfillTargets(ctx, limit, now.Add(-dueAfter))
	if err != nil {
		return KlaviyoBackfillWorkerSummary{}, err
	}
	summary := KlaviyoBackfillWorkerSummary{Targets: len(targets)}
	if deps.klaviyoProviderPuller() == nil {
		return summary, errors.New("klaviyo backfill worker: missing puller")
	}
	for _, target := range targets {
		integration, err := deps.Repo.GetIntegration(ctx, target.TenantID, target.IntegrationID)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("klaviyo scheduled lookup failed", "tenant", target.TenantID, "integration", target.IntegrationID, "err", err.Error())
			}
			continue
		}
		if marketingIntegrationDisconnected(integration) {
			summary.Skipped++
			continue
		}
		cursor := firstString(target.Cursor, integration.SyncCursor)
		targetFailed := false
		for page := 0; page < w.maxPagesPerRun(); page++ {
			req := normalizeSyncRequest(SyncRequest{RunMode: "scheduled", Cursor: cursor})
			out, err := deps.executeAndRecordSync(ctx, target.TenantID, target.IntegrationID, integration, req)
			if err != nil {
				summary.Failed++
				targetFailed = true
				if w.Logger != nil {
					w.Logger.Warn("klaviyo scheduled pull failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", cursor, "err", err.Error())
				}
				break
			}
			summary.Pages++
			summary.ProfilesSeen += out.ProfilesSeen
			summary.EventsSeen += out.EventsSeen
			summary.ListsSeen += out.ListsSeen
			cursor = out.Cursor
			if out.Status == "failed" {
				summary.Failed++
				targetFailed = true
				break
			}
			if !klaviyoNativeCursorHasMore(cursor) {
				break
			}
			integration.SyncCursor = cursor
		}
		if !targetFailed {
			summary.Completed++
		}
	}
	return summary, nil
}

func (w *KlaviyoBackfillWorker) storeAndDeps() (KlaviyoBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("klaviyo backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(KlaviyoBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("klaviyo backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, KlaviyoPuller: w.Puller, Now: w.Now}
	} else if deps.KlaviyoPuller == nil && w.Puller != nil {
		copy := *deps
		copy.KlaviyoPuller = w.Puller
		deps = &copy
	}
	return store, deps, nil
}

func (w *KlaviyoBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *KlaviyoBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return klaviyoBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}
