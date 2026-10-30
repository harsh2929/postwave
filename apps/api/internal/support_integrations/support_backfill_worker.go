// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
)

const (
	supportBackfillWorkerDefaultInterval       = 15 * time.Minute
	supportBackfillWorkerDefaultDueAfter       = time.Hour
	supportBackfillWorkerDefaultLimit          = 10
	supportBackfillWorkerDefaultMaxPagesPerRun = 10
	supportBackfillWorkerMaxCandidateScan      = 1000
)

type SupportBackfillTarget struct {
	TenantID      string     `json:"tenant_id"`
	IntegrationID string     `json:"integration_id"`
	Cursor        string     `json:"cursor,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	ErrorMessage  string     `json:"error_message,omitempty"`
}

type SupportBackfillWorkerStore interface {
	Store
	ListSupportBackfillTargets(context.Context, string, int, time.Time) ([]SupportBackfillTarget, error)
}

type SupportBackfillWorker struct {
	Provider       string
	Deps           *Deps
	Store          SupportBackfillWorkerStore
	Backfiller     SupportProviderBackfiller
	Logger         *slog.Logger
	Interval       time.Duration
	DueAfter       time.Duration
	Limit          int
	MaxPagesPerRun int
	Now            func() time.Time
}

type SupportBackfillWorkerSummary struct {
	Provider         string
	Targets          int
	Completed        int
	Failed           int
	Pages            int
	TicketsSeen      int
	TicketsUpserted  int
	MessagesSeen     int
	MessagesUpserted int
	ProfilesUpserted int
	EventsSeen       int
	EventsTracked    int
}

func (w *SupportBackfillWorker) Run(ctx context.Context) error {
	_ = ctx
	if w.Logger != nil {
		w.Logger.Warn("support provider backfill worker release-held", "provider", w.provider(), "code", "support_provider_runtime_held")
	}
	return nil
}

func (w *SupportBackfillWorker) tick(ctx context.Context) (SupportBackfillWorkerSummary, error) {
	_ = ctx
	// Defense in depth: even a future accidental registration cannot list a
	// tenant, resolve credentials, contact a provider, or write Helpdesk data.
	return SupportBackfillWorkerSummary{Provider: w.provider()}, nil
}

// archivedBackfillTickFixture retains pre-hold algorithm unit coverage without
// being reachable from Run or the production tick. It is called only by the
// same-package historical source-fixture tests below the Route41 hold.
func (w *SupportBackfillWorker) archivedBackfillTickFixture(ctx context.Context) (SupportBackfillWorkerSummary, error) {
	store, deps, err := w.storeAndDeps()
	if err != nil {
		return SupportBackfillWorkerSummary{}, err
	}
	provider := w.provider()
	cfg, err := supportBackfillConfig(provider)
	if err != nil {
		return SupportBackfillWorkerSummary{}, err
	}
	now := w.now()
	dueAfter := w.DueAfter
	if dueAfter <= 0 {
		dueAfter = supportBackfillWorkerDefaultDueAfter
	}
	limit := w.Limit
	if limit <= 0 {
		limit = supportBackfillWorkerDefaultLimit
	}
	targets, err := w.listTargets(ctx, store, supportBackfillWorkerCandidateLimit(limit), now.Add(-dueAfter))
	if err != nil {
		return SupportBackfillWorkerSummary{}, err
	}
	summary := SupportBackfillWorkerSummary{Provider: provider}
	backfiller := w.Backfiller
	if backfiller == nil {
		backfiller = supportBackfillerForProvider(deps, provider)
	}
	if backfiller == nil {
		return summary, errors.New(cfg.DisplayName + " support backfill worker: missing backfiller")
	}
	for _, target := range targets {
		if summary.Targets >= limit {
			break
		}
		if supportBackfillTargetRetryNotDue(cfg, target.Cursor, now) {
			continue
		}
		summary.Targets++
		runner := SupportBulkBackfillRunner{
			Deps:       deps,
			Provider:   provider,
			Backfiller: backfiller,
			MaxPages:   w.maxPagesPerRun(),
			Now:        w.now,
		}
		out, err := runner.Run(ctx, target.TenantID, target.IntegrationID, target.Cursor)
		if err != nil {
			summary.Failed++
			if w.Logger != nil {
				w.Logger.Warn(cfg.DisplayName+" scheduled support backfill failed", "tenant", target.TenantID, "integration", target.IntegrationID, "cursor", target.Cursor, "err", err.Error())
			}
			continue
		}
		if out.Complete {
			summary.Completed++
		}
		summary.Pages += out.Pages
		summary.TicketsSeen += out.TicketsSeen
		summary.TicketsUpserted += out.TicketsUpserted
		summary.MessagesSeen += out.MessagesSeen
		summary.MessagesUpserted += out.MessagesUpserted
		summary.ProfilesUpserted += out.ProfilesUpserted
		summary.EventsSeen += out.EventsSeen
		summary.EventsTracked += out.EventsTracked
	}
	return summary, nil
}

func (w *SupportBackfillWorker) storeAndDeps() (SupportBackfillWorkerStore, *Deps, error) {
	if w == nil {
		return nil, nil, errors.New("support backfill worker: nil worker")
	}
	store := w.Store
	if store == nil && w.Deps != nil {
		if typed, ok := w.Deps.Repo.(SupportBackfillWorkerStore); ok {
			store = typed
		}
	}
	if store == nil {
		return nil, nil, errors.New("support backfill worker: missing store")
	}
	deps := w.Deps
	if deps == nil {
		deps = &Deps{Repo: store, Now: w.Now}
	}
	return store, deps, nil
}

func (w *SupportBackfillWorker) listTargets(ctx context.Context, store SupportBackfillWorkerStore, limit int, staleBefore time.Time) ([]SupportBackfillTarget, error) {
	return store.ListSupportBackfillTargets(ctx, w.provider(), limit, staleBefore)
}

func (w *SupportBackfillWorker) provider() string {
	if w == nil {
		return ""
	}
	return w.Provider
}

func (w *SupportBackfillWorker) now() time.Time {
	if w.Now != nil {
		return w.Now().UTC()
	}
	if w.Deps != nil && w.Deps.Now != nil {
		return w.Deps.Now().UTC()
	}
	return time.Now().UTC()
}

func (w *SupportBackfillWorker) maxPagesPerRun() int {
	if w.MaxPagesPerRun <= 0 {
		return supportBackfillWorkerDefaultMaxPagesPerRun
	}
	return w.MaxPagesPerRun
}

func supportBackfillWorkerCandidateLimit(limit int) int {
	if limit <= 0 {
		limit = supportBackfillWorkerDefaultLimit
	}
	if limit >= supportBackfillWorkerMaxCandidateScan {
		return limit
	}
	return supportBackfillWorkerMaxCandidateScan
}

func supportBackfillTargetRetryNotDue(cfg supportBackfillProviderConfig, cursor string, now time.Time) bool {
	retry, ok, err := decodeSupportRetryCursor(cfg, strings.TrimSpace(cursor))
	return err == nil && ok && !supportRetryCursorDue(retry, now)
}
