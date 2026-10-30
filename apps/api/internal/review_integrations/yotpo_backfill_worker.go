// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	yotpoBackfillWorkerDefaultInterval       = 15 * time.Minute
	yotpoBackfillWorkerDefaultDueAfter       = time.Hour
	yotpoBackfillWorkerDefaultLimit          = 10
	yotpoBackfillWorkerMaxCandidateScan      = 1000
	yotpoBackfillWorkerDefaultMaxPagesPerRun = 10
)

type YotpoBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type YotpoBackfillWorkerStore interface {
	Store
	ListYotpoBackfillTargets(context.Context, int, time.Time) ([]YotpoBackfillTarget, error)
}

type YotpoBackfillWorker struct {
	Deps           *Deps
	Store          YotpoBackfillWorkerStore
	Backfiller     ReviewBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type YotpoBackfillWorkerSummary struct {
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	ReviewsSeen      int
	ReviewsImported  int
	ProfilesUpserted int
	EventsTracked    int
}

func (w *YotpoBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = yotpoBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("yotpo backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("yotpo backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("yotpo backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"reviews_seen", summary.ReviewsSeen,
				"reviews_imported", summary.ReviewsImported,
				"profiles_upserted", summary.ProfilesUpserted,
				"events_tracked", summary.EventsTracked)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (w *YotpoBackfillWorker) tick(ctx context.Context) (YotpoBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return YotpoBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = yotpoBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = yotpoBackfillWorkerDefaultLimit
	}
	targets, err := store.ListYotpoBackfillTargets(ctx, yotpoBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return YotpoBackfillWorkerSummary{}, err
	}
	summary := YotpoBackfillWorkerSummary{}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.YotpoBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("yotpo backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if yotpoBackfillTargetRetryNotDue(target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := YotpoBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("yotpo scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.ReviewsSeen += out.ReviewsSeen
		summary.ReviewsImported += out.ReviewsImported
		summary.ProfilesUpserted += out.ProfilesUpserted
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *YotpoBackfillWorker) storeAndDeps() (YotpoBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("yotpo backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(YotpoBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("yotpo backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *YotpoBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *YotpoBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return yotpoBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func yotpoBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = yotpoBackfillWorkerDefaultLimit
	}
	if limit >= yotpoBackfillWorkerMaxCandidateScan {
		return limit
	}
	return yotpoBackfillWorkerMaxCandidateScan
}

func yotpoBackfillTargetRetryNotDue(cursor string, now time.Time) bool {
	if !strings.HasPrefix(strings.TrimSpace(cursor), yotpoRetryCursorPrefix) {
		return false
	}
	retry, ok, err := decodeYotpoRetryCursor(cursor)
	if err != nil || !ok {
		return false
	}
	return !yotpoRetryCursorDue(retry, now)
}
