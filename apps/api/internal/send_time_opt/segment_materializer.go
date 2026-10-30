// SPDX-License-Identifier: AGPL-3.0-only
//
// segment_materializer.go — background worker that refreshes the
// segment_subscribers cache by recompiling each segment's query_ast
// → SQL and writing the matched subscriber ids in.
//
// Cadence: every MaterializerInterval (default 5 min), rewrite up to
// MaterializerBatch segments, never-baselined ones first and then those
// whose membership_baseline_at is oldest — bounded so a tenant with 1000s
// of segments can't starve the worker. The rewrite itself is
// segments.RefreshAndForwardEntrants, shared with SegmentEventWorker, so the
// subscribers a rewrite finds newly matching fire "Entered segment" whichever
// worker got there first.
//
// The materialiser does NOT block reads: segment endpoints fall back
// to compiling the AST inline (via resolveSegmentMembership) when the
// cache is stale or empty, so a worker outage degrades latency but
// never functionality.

package send_time_opt

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

const (
	defaultMaterializerInterval = 5 * time.Minute
	defaultMaterializerBatch    = 50
)

// stoSegmentMaterializeTotal counts refresh attempts by outcome.
//
//	sto_segment_materialize_total{outcome="ok|error|empty"}
var stoSegmentMaterializeTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "sto_segment_materialize_total",
	Help: "Segment materialiser ticks by outcome.",
}, []string{"outcome"})

// stoSegmentMaterializeRows is the number of segment_subscribers
// rows written per refresh of one segment. Useful for detecting a
// segment AST that suddenly resolved to zero (a likely red-flag for
// a bad edit).
var stoSegmentMaterializeRows = promauto.NewHistogram(prometheus.HistogramOpts{
	Name:    "sto_segment_materialize_rows",
	Help:    "Number of subscriber rows written per segment refresh.",
	Buckets: prometheus.ExponentialBuckets(1, 4, 10),
})

// SegmentMaterializer drains the (tenant, segment) staleness queue
// and rewrites the segment_subscribers cache.
type SegmentMaterializer struct {
	Repo     *Repo
	Interval time.Duration // default 5m
	Batch    int           // default 50
	Logger   *slog.Logger
	// FreshFor is the staleness cutoff: a segment whose membership
	// baseline is older than this is eligible for a rewrite. Defaults to
	// segmentCacheFreshFor.
	FreshFor time.Duration
	// Forwarder receives a segment_joined event per subscriber a rewrite finds
	// newly matching: the same forwarder SegmentEventWorker uses. Subscribers
	// can enter a segment without an event reaching that worker (a profile
	// edit, an import, a list or tag change, a date rule coming true), and a
	// rewrite that folded them into the baseline silently would mean their
	// entry flows never start. nil, or a forwarder reporting Enabled() ==
	// false, skips detection.
	Forwarder segments.SegmentJoinForwarder
}

// NewSegmentMaterializer constructs a materialiser with sensible
// defaults.
func NewSegmentMaterializer(repo *Repo) *SegmentMaterializer {
	return &SegmentMaterializer{
		Repo:     repo,
		Interval: defaultMaterializerInterval,
		Batch:    defaultMaterializerBatch,
		FreshFor: segmentCacheFreshFor,
	}
}

func (m *SegmentMaterializer) interval() time.Duration {
	if m.Interval > 0 {
		return m.Interval
	}
	return defaultMaterializerInterval
}

func (m *SegmentMaterializer) batch() int {
	if m.Batch > 0 {
		return m.Batch
	}
	return defaultMaterializerBatch
}

func (m *SegmentMaterializer) freshFor() time.Duration {
	if m.FreshFor > 0 {
		return m.FreshFor
	}
	return segmentCacheFreshFor
}

func (m *SegmentMaterializer) log() *slog.Logger {
	if m.Logger != nil {
		return m.Logger
	}
	return slog.Default()
}

// Run blocks until ctx is cancelled. Fires RunOnce immediately, then
// every Interval. Each tick refreshes up to Batch segments.
func (m *SegmentMaterializer) Run(ctx context.Context) {
	if m == nil || m.Repo == nil {
		return
	}
	m.RunOnce(ctx)
	t := time.NewTicker(m.interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.RunOnce(ctx)
		}
	}
}

// staleSegment names a (tenant, segment) pair due for refresh.
type staleSegment struct {
	TenantID  string
	SegmentID string
	// BaselineAt is the segment's membership_baseline_at: nil when its cache
	// holds no baseline for the current definition.
	BaselineAt *time.Time
}

// RunOnce refreshes one batch. Returns (processed, errors).
func (m *SegmentMaterializer) RunOnce(ctx context.Context) (int, int) {
	if m == nil || m.Repo == nil {
		return 0, 0
	}
	stale, err := m.listStale(ctx)
	if err != nil {
		stoSegmentMaterializeTotal.WithLabelValues("error").Inc()
		m.log().Error("sto-segment-materializer: list-stale failed", "err", err)
		return 0, 1
	}
	if len(stale) == 0 {
		stoSegmentMaterializeTotal.WithLabelValues("empty").Inc()
		return 0, 0
	}
	processed, errs := 0, 0
	for _, s := range stale {
		if ctx.Err() != nil {
			break
		}
		n, refreshErr := m.refresh(ctx, s.TenantID, s.SegmentID)
		if refreshErr != nil {
			errs++
			if errors.Is(refreshErr, context.Canceled) || errors.Is(refreshErr, context.DeadlineExceeded) {
				m.log().Info("sto-segment-materializer: cancelled", "tenant_id", s.TenantID)
				break
			}
			m.log().Warn("sto-segment-materializer: refresh failed",
				"tenant_id", s.TenantID, "segment_id", s.SegmentID, "err", refreshErr)
			continue
		}
		processed++
		stoSegmentMaterializeRows.Observe(float64(n))
	}
	if errs > 0 {
		stoSegmentMaterializeTotal.WithLabelValues("error").Inc()
	} else {
		stoSegmentMaterializeTotal.WithLabelValues("ok").Inc()
	}
	m.log().Info("sto-segment-materializer: tick complete",
		"processed", processed, "errors", errs, "batch", len(stale))
	return processed, errs
}

// listStale returns up to Batch (tenant, segment) pairs due for a rewrite:
// segments with no membership baseline for their current definition (new, or
// redefined since the last rewrite) first, then those rewritten longest ago,
// across every tenant.
//
// segments is FORCE RLS keyed on app.tenant_id and the API role does not bypass
// RLS, so the old single cross-tenant query, run with no tenant bound, saw zero
// rows on every tick and this worker never refreshed anything. Tenants are now
// enumerated under worker scope and each tenant's segments are read inside that
// tenant's own scope, the pattern every segment worker follows. Each tenant
// contributes at most Batch candidates and the merged list is ordered by
// staleness, so one tenant with many segments cannot starve the rest.
func (m *SegmentMaterializer) listStale(ctx context.Context) ([]staleSegment, error) {
	tenants, err := m.listTenants(ctx)
	if err != nil {
		return nil, err
	}
	cutoff := time.Now().UTC().Add(-m.freshFor())
	out := []staleSegment{}
	for _, tenantID := range tenants {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		due, err := m.listTenantStale(ctx, tenantID, cutoff, m.batch())
		if err != nil {
			return nil, err
		}
		out = append(out, due...)
	}
	sort.SliceStable(out, func(i, j int) bool { return staler(out[i], out[j]) })
	if len(out) > m.batch() {
		out = out[:m.batch()]
	}
	return out, nil
}

// staler orders never-baselined segments first, then the oldest baseline.
func staler(a, b staleSegment) bool {
	switch {
	case a.BaselineAt == nil && b.BaselineAt == nil:
		return false
	case a.BaselineAt == nil:
		return true
	case b.BaselineAt == nil:
		return false
	default:
		return a.BaselineAt.Before(*b.BaselineAt)
	}
}

// listTenants enumerates tenants under worker scope (tenants worker_select
// policy, migration 1708), oldest first so the batch drains in a stable order.
func (m *SegmentMaterializer) listTenants(ctx context.Context) ([]string, error) {
	tx, err := db.WithWorkerScope(ctx, m.Repo.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT id::text FROM tenants ORDER BY created_at ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// listTenantStale reads one tenant's due segments inside its tenant scope.
// membership_baseline_at is stamped by every cache rewrite, including one that
// cached nobody, so it is the freshness signal for empty segments too; the
// newest computed_at of the cache rows is not.
func (m *SegmentMaterializer) listTenantStale(ctx context.Context, tenantID string, cutoff time.Time, limit int) ([]staleSegment, error) {
	tx, err := db.WithTenant(ctx, m.Repo.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, membership_baseline_at
  FROM segments
 WHERE tenant_id = $1::uuid
   AND (membership_baseline_at IS NULL OR membership_baseline_at < $2)
 ORDER BY membership_baseline_at ASC NULLS FIRST, id ASC
 LIMIT $3`, tenantID, cutoff, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []staleSegment{}
	for rows.Next() {
		s := staleSegment{TenantID: tenantID}
		if err := rows.Scan(&s.SegmentID, &s.BaselineAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// refresh rewrites one segment's membership cache through the shared
// segments.RefreshAndForwardEntrants, the same path SegmentEventWorker takes, so
// the two cannot drift. Returns the number of subscribers cached.
func (m *SegmentMaterializer) refresh(ctx context.Context, tenantID, segmentID string) (int, error) {
	result, err := segments.RefreshAndForwardEntrants(ctx, m.Repo.Pool, tenantID, segmentID, m.Forwarder, m.log(), "sto-segment-materializer")
	if err != nil {
		return 0, err
	}
	return result.Members, nil
}
