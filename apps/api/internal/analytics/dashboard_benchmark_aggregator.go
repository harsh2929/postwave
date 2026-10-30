// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// BenchmarkAggregator computes platform-wide average rates (opens /
// clicks / bounces / unsubs) by aggregating campaign_report_events
// across all tenants. Refined Dashboard PR 4 follow-up.
//
// Strictly anonymous: only integer counts leave each tenant-scoped
// transaction. The cache table is global (no tenant_id, no RLS).
//
// Runs daily. The first tick happens on boot so a fresh deploy
// quickly transitions from illustrative to real benchmarks.
type BenchmarkAggregator struct {
	Pool     *db.Pool
	Interval time.Duration // default 24h
	Window   int           // default 30 (days)
	Logger   *slog.Logger
}

// Run blocks until ctx is cancelled.
func (a *BenchmarkAggregator) Run(ctx context.Context) {
	if a.Interval == 0 {
		a.Interval = 24 * time.Hour
	}
	if a.Window == 0 {
		a.Window = 30
	}
	ticker := time.NewTicker(a.Interval)
	defer ticker.Stop()
	a.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.tick(ctx)
		}
	}
}

func (a *BenchmarkAggregator) tick(ctx context.Context) {
	if a.Pool == nil {
		return
	}
	if err := a.compute(ctx); err != nil && a.Logger != nil {
		a.Logger.Warn("benchmark aggregator: compute", "err", err)
	}
}

type dashboardBenchmarkCounts struct {
	sent      int64
	campaigns int64
	opens     int64
	clicks    int64
	bounces   int64
	unsubs    int64
}

type dashboardBenchmarkMetric struct {
	key    string
	events int64
}

// compute runs a single platform-wide aggregation pass. It enumerates tenant
// IDs under the narrow worker policy, reads each FORCE-RLS event partition
// under db.WithTenant, sums only anonymous counts in memory, and commits all
// cache rows atomically.
func (a *BenchmarkAggregator) compute(ctx context.Context) error {
	window := a.Window
	if window <= 0 {
		window = 30
	}

	tenantIDs, err := dashboardWorkerTenantIDs(ctx, a.Pool)
	if err != nil {
		return err
	}

	asOf := time.Now().UTC()
	from := asOf.AddDate(0, 0, -window)
	total := dashboardBenchmarkCounts{}
	for _, tenantID := range tenantIDs {
		counts, err := a.countTenant(ctx, tenantID, from, asOf)
		if err != nil {
			return err
		}
		total.add(counts)
	}
	if total.sent == 0 || total.campaigns == 0 {
		// No reportable platform data yet: retain the previous complete cache
		// set rather than replacing it with an all-zero partial snapshot.
		return nil
	}
	return a.store(ctx, window, total)
}

func (a *BenchmarkAggregator) countTenant(
	ctx context.Context,
	tenantID string,
	from time.Time,
	asOf time.Time,
) (dashboardBenchmarkCounts, error) {
	tx, err := db.WithTenantOptions(ctx, a.Pool, tenantID, pgx.TxOptions{
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return dashboardBenchmarkCounts{}, fmt.Errorf(
			"scope benchmark tenant %s: %w", tenantID, err,
		)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var counts dashboardBenchmarkCounts
	err = tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE event_type = 'sent')::bigint,
       count(DISTINCT campaign_id) FILTER (WHERE event_type = 'sent')::bigint,
       count(*) FILTER (WHERE event_type = 'opened')::bigint,
       count(*) FILTER (WHERE event_type = 'clicked')::bigint,
       count(*) FILTER (WHERE event_type = 'bounced')::bigint,
       count(*) FILTER (WHERE event_type = 'unsubscribed')::bigint
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= $2
   AND at < $3
   AND event_type IN ('sent', 'opened', 'clicked', 'bounced', 'unsubscribed')`,
		tenantID, from, asOf,
	).Scan(
		&counts.sent,
		&counts.campaigns,
		&counts.opens,
		&counts.clicks,
		&counts.bounces,
		&counts.unsubs,
	)
	if err != nil {
		return dashboardBenchmarkCounts{}, fmt.Errorf(
			"count benchmark events for tenant %s: %w", tenantID, err,
		)
	}
	return counts, nil
}

func (c *dashboardBenchmarkCounts) add(other dashboardBenchmarkCounts) {
	c.sent += other.sent
	c.campaigns += other.campaigns
	c.opens += other.opens
	c.clicks += other.clicks
	c.bounces += other.bounces
	c.unsubs += other.unsubs
}

func (c dashboardBenchmarkCounts) metrics() []dashboardBenchmarkMetric {
	return []dashboardBenchmarkMetric{
		{key: "opens", events: c.opens},
		{key: "clicks", events: c.clicks},
		{key: "bounces", events: c.bounces},
		{key: "unsubs", events: c.unsubs},
	}
}

func (a *BenchmarkAggregator) store(
	ctx context.Context,
	window int,
	total dashboardBenchmarkCounts,
) error {
	tx, err := a.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin benchmark cache transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, metric := range total.metrics() {
		average := float64(metric.events) / float64(total.sent)
		if _, err := tx.Exec(ctx, `
INSERT INTO dashboard_benchmark_cache (metric, window_days, average, sample_size)
VALUES ($1, $2, $3, $4)
ON CONFLICT (metric, window_days)
DO UPDATE SET average = EXCLUDED.average,
              sample_size = EXCLUDED.sample_size,
              computed_at = now()`,
			metric.key, window, average, total.campaigns,
		); err != nil {
			return fmt.Errorf("store %s benchmark: %w", metric.key, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit benchmark cache: %w", err)
	}
	return nil
}
