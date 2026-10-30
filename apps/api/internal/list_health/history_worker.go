// SPDX-License-Identifier: AGPL-3.0-only
//
// HistoryWorker walks every tenant's active lists on a daily tick and
// writes a list_health_history snapshot via SaveHistorySnapshot. This
// fills the data sink that GET /api/v1/lists/{id}/health-history reads
// from (GAP-LS-119).
//
// Why a worker and not lazy-on-read: the read endpoint serves the
// per-list trend chart on every slideover open; computing 90 days of
// snapshots inline would multiply the deliverability compute cost by
// the chart depth. A daily tick keeps the chart cheap.
//
// Idempotency: SaveHistorySnapshot has an ON CONFLICT (tenant, list,
// day, window) upsert, so re-running the worker after a partial crash
// collapses to the same row count without duplicates.

package list_health

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// HistoryWorker periodically writes per-list health snapshots. Tick
// interval defaults to 24h; override Interval for tests.
//
// Tenants is the same TenantLister interface assets.Refresher uses so
// the bootstrap site can share its existing adapter. ListsForTenant is
// a tiny function callback so we don't take an import cycle on the
// lists package — the bootstrap supplies a closure that does the
// list_subscribers-keyed lookup.
type HistoryWorker struct {
	Pool           *db.Pool
	Tenants        TenantLister
	ListsForTenant func(ctx context.Context, tenantID string) ([]string, error)
	Interval       time.Duration
	Logger         *slog.Logger
	WindowDays     int // default 90
}

// TenantLister returns the tenant ids the worker should iterate.
// Matches assets.TenantLister so callers can pass the same adapter.
type TenantLister interface {
	ActiveTenantIDs(ctx context.Context) ([]string, error)
}

// Run blocks until ctx is cancelled, ticking every Interval. The first
// tick fires immediately so a redeploy doesn't lose the day's
// snapshot.
func (h *HistoryWorker) Run(ctx context.Context) {
	if h == nil {
		return
	}
	if h.Interval == 0 {
		h.Interval = 24 * time.Hour
	}
	if h.WindowDays == 0 {
		h.WindowDays = 90
	}
	ticker := time.NewTicker(h.Interval)
	defer ticker.Stop()
	h.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.tick(ctx)
		}
	}
}

func (h *HistoryWorker) tick(ctx context.Context) {
	if h.Pool == nil || h.Tenants == nil || h.ListsForTenant == nil {
		return
	}
	tenantIDs, err := h.Tenants.ActiveTenantIDs(ctx)
	if err != nil {
		h.warn("list-health history: list tenants", "err", err)
		return
	}
	since := time.Now().UTC().Add(-time.Duration(h.WindowDays) * 24 * time.Hour)
	for _, tenantID := range tenantIDs {
		if ctx.Err() != nil {
			return
		}
		tenantID = strings.TrimSpace(tenantID)
		if tenantID == "" {
			continue
		}
		listIDs, err := h.ListsForTenant(ctx, tenantID)
		if err != nil {
			h.warn("list-health history: list lists", "tenant", tenantID, "err", err)
			continue
		}
		for _, listID := range listIDs {
			if ctx.Err() != nil {
				return
			}
			if err := h.snapshotOne(ctx, tenantID, listID, since); err != nil {
				h.warn("list-health history: snapshot",
					"tenant", tenantID, "list", listID, "err", err)
			}
		}
	}
}

// snapshotOne computes a Score for one (tenant, list) and writes it
// via SaveHistorySnapshot. Uses the same compute() the public Get
// handler uses — the tag-scoped legacy behaviour is preserved by
// passing an empty tag (no tag predicate) and substituting the
// per-list JOIN at the SQL layer. For the per-list path we run a
// dedicated query that JOINs list_subscribers directly so the score
// reflects the actual list rather than tag approximation.
func (h *HistoryWorker) snapshotOne(ctx context.Context, tenantID, listID string, since time.Time) error {
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	s := Score{WindowDays: h.WindowDays, Notes: []string{}}

	// Subscriber-level counts via list_subscribers JOIN.
	if err := tx.QueryRow(ctx, `
SELECT count(*)::bigint AS total,
       count(*) FILTER (WHERE s.status = 'enabled')     ::bigint AS active,
       count(*) FILTER (WHERE s.status = 'blocklisted') ::bigint AS blocklisted
  FROM list_subscribers ls
  JOIN subscribers s ON s.id = ls.subscriber_id
 WHERE ls.tenant_id = $1::uuid
   AND ls.list_id   = $2::uuid
   AND ls.removed_at IS NULL`,
		tenantID, listID).Scan(&s.TotalSubscribers, &s.ActiveSubscribers, &s.BlocklistedCount); err != nil {
		return err
	}

	// Window-scoped event counts.
	if err := tx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE se.event_type = 'bounced')      ::bigint AS bounces,
  count(*) FILTER (WHERE se.event_type = 'complained')   ::bigint AS complaints,
  count(*) FILTER (WHERE se.event_type = 'unsubscribed') ::bigint AS unsubs,
  count(DISTINCT se.subscriber_email) FILTER (
      WHERE se.event_type IN ('opened','clicked')
  )::bigint AS engaged
FROM subscriber_events se
WHERE se.tenant_id = $1::uuid
  AND se.at >= $2
  AND se.subscriber_email IN (
      SELECT email FROM list_subscribers
       WHERE tenant_id = $1::uuid
         AND list_id   = $3::uuid
         AND removed_at IS NULL
         AND email IS NOT NULL
  )`, tenantID, since, listID).Scan(&s.Bounces, &s.Complaints, &s.Unsubscribes, &s.EngagedSubscribers); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	denomActive := float64(s.ActiveSubscribers)
	if denomActive < 1 {
		denomActive = 1
	}
	denomTotal := float64(s.TotalSubscribers)
	if denomTotal < 1 {
		denomTotal = 1
	}
	s.BounceRate = float64(s.Bounces) / denomActive
	s.ComplaintRate = float64(s.Complaints) / denomActive
	s.UnsubscribeRate = float64(s.Unsubscribes) / denomActive
	s.EngagementRate = float64(s.EngagedSubscribers) / denomActive
	s.SuppressionRate = float64(s.BlocklistedCount) / denomTotal
	s.Score, s.Grade, s.Notes = scoreAndGrade(s)

	return SaveHistorySnapshot(ctx, h.Pool, tenantID, listID, s)
}

func (h *HistoryWorker) warn(msg string, args ...any) {
	if h.Logger == nil {
		return
	}
	h.Logger.Warn(msg, args...)
}
