// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	smileBackfillWorkerDefaultInterval       = 15 * time.Minute
	smileBackfillWorkerDefaultDueAfter       = time.Hour
	smileBackfillWorkerDefaultLimit          = 10
	smileBackfillWorkerMaxCandidateScan      = 1000
	smileBackfillWorkerDefaultMaxPagesPerRun = 10
)

type SmileBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type SmileBackfillWorkerStore interface {
	Store
	ListSmileBackfillTargets(context.Context, int, time.Time) ([]SmileBackfillTarget, error)
}

type SmileBackfillWorker struct {
	Deps           *Deps
	Store          SmileBackfillWorkerStore
	Backfiller     LoyaltyBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type SmileBackfillWorkerSummary struct {
	Targets         int
	Completed       int
	Failed          int
	Pages           int
	MembersSeen     int
	MembersUpserted int
	EventsSeen      int
	EventsTracked   int
}

func (w *SmileBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = smileBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("smile backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("smile backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("smile backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"members_seen", summary.MembersSeen,
				"members_upserted", summary.MembersUpserted,
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

func (w *SmileBackfillWorker) tick(ctx context.Context) (SmileBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return SmileBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = smileBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = smileBackfillWorkerDefaultLimit
	}
	targets, err := store.ListSmileBackfillTargets(ctx, smileBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return SmileBackfillWorkerSummary{}, err
	}
	summary := SmileBackfillWorkerSummary{}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.SmileBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("smile backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if smileBackfillTargetRetryNotDue(target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := SmileBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("smile scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.MembersSeen += out.MembersSeen
		summary.MembersUpserted += out.MembersUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *SmileBackfillWorker) storeAndDeps() (SmileBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("smile backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(SmileBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("smile backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *SmileBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *SmileBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return smileBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func smileBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = smileBackfillWorkerDefaultLimit
	}
	if limit >= smileBackfillWorkerMaxCandidateScan {
		return limit
	}
	return smileBackfillWorkerMaxCandidateScan
}

func smileBackfillTargetRetryNotDue(cursor string, now time.Time) bool {
	if !strings.HasPrefix(strings.TrimSpace(cursor), smileRetryCursorPrefix) {
		return false
	}
	retry, ok, err := decodeSmileRetryCursor(cursor)
	if err != nil || !ok {
		return false
	}
	return !smileRetryCursorDue(retry, now)
}
