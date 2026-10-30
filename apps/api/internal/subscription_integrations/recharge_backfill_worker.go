// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	rechargeBackfillWorkerDefaultInterval       = 15 * time.Minute
	rechargeBackfillWorkerDefaultDueAfter       = time.Hour
	rechargeBackfillWorkerDefaultLimit          = 10
	rechargeBackfillWorkerDefaultMaxPagesPerRun = 10
	rechargeBackfillWorkerMaxCandidateScan      = 1000
)

type RechargeBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type RechargeBackfillWorkerStore interface {
	Store
	ListRechargeBackfillTargets(context.Context, int, time.Time) ([]RechargeBackfillTarget, error)
}

type RechargeBackfillWorker struct {
	Deps           *Deps
	Store          RechargeBackfillWorkerStore
	Backfiller     RechargeBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type RechargeBackfillWorkerSummary struct {
	Targets               int
	Completed             int
	Failed                int
	Pages                 int
	SubscriptionsSeen     int
	SubscriptionsUpserted int
	ShipmentsSeen         int
	ShipmentsUpserted     int
	EventsSeen            int
	EventsTracked         int
}

func (w *RechargeBackfillWorker) Run(ctx context.Context) error {
	if _, _, err := w.storeAndDeps(); err != nil {
		return err
	}
	interval := w.Interval
	if interval <= 0 {
		interval = rechargeBackfillWorkerDefaultInterval
	}
	if w.Logger != nil {
		w.Logger.Info("recharge backfill worker: starting", "interval", interval.String())
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if summary, err := w.tick(ctx); err != nil && w.Logger != nil {
			w.Logger.Warn("recharge backfill tick failed", "err", err.Error())
		} else if w.Logger != nil && (summary.Targets > 0 || summary.Failed > 0) {
			w.Logger.Info("recharge backfill tick complete",
				"targets", summary.Targets,
				"completed", summary.Completed,
				"failed", summary.Failed,
				"pages", summary.Pages,
				"subscriptions_seen", summary.SubscriptionsSeen,
				"subscriptions_upserted", summary.SubscriptionsUpserted,
				"shipments_seen", summary.ShipmentsSeen,
				"shipments_upserted", summary.ShipmentsUpserted,
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

func (w *RechargeBackfillWorker) tick(ctx context.Context) (RechargeBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return RechargeBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = rechargeBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = rechargeBackfillWorkerDefaultLimit
	}
	targets, err := store.ListRechargeBackfillTargets(ctx, rechargeBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return RechargeBackfillWorkerSummary{}, err
	}
	summary := RechargeBackfillWorkerSummary{}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = deps.RechargeBackfiller
	}
	if backfiller == nil {
		return summary, errors.New("recharge backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if rechargeBackfillTargetRetryNotDue(target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := RechargeBulkBackfillRunner{
			Deps:       deps,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn("recharge scheduled backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.SubscriptionsSeen += out.SubscriptionsSeen
		summary.SubscriptionsUpserted += out.SubscriptionsUpserted
		summary.ShipmentsSeen += out.ShipmentsSeen
		summary.ShipmentsUpserted += out.ShipmentsUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *RechargeBackfillWorker) storeAndDeps() (RechargeBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("recharge backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(RechargeBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("recharge backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *RechargeBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *RechargeBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return rechargeBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func rechargeBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = rechargeBackfillWorkerDefaultLimit
	}
	if limit >= rechargeBackfillWorkerMaxCandidateScan {
		return limit
	}
	return rechargeBackfillWorkerMaxCandidateScan
}

func rechargeBackfillTargetRetryNotDue(cursor string, now time.Time) bool {
	retry, ok, err := decodeRechargeRetryCursor(strings.TrimSpace(cursor))
	return err == nil && ok && !rechargeRetryCursorDue(retry, now)
}
