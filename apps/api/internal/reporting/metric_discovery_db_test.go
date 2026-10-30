// SPDX-License-Identifier: AGPL-3.0-only
//
// A tenant's own events must be reportable.
//
// Before this, metric_definitions was a complete table — unique key, RLS,
// grants, four CHECK constraints — with zero rows and zero Go references, and
// the reporting registry only knew metrics hardcoded in Go. A tenant sending
// `checkout_completed` could watch it arrive in the event stream and could not
// build a single report on it.

package reporting

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/track"
)

func discoveryPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping metric discovery test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func discoveryTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'metric-discovery-test', $2, 'studio')`,
		tenantID, "metricdisc-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	return tenantID
}

// An observed event appears in the registry AND can be computed.
//
// Both halves in one test on purpose. A registry entry that cannot execute is a
// worse phantom than the empty table it replaced, because the caller only finds
// out at preview time — so listing it and running it are one claim.
func TestAnObservedEventBecomesAReportableMetric(t *testing.T) {
	pool := discoveryPool(t)
	ctx := context.Background()
	tenantID := discoveryTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if err := track.RecordMetricDiscovery(ctx, tx, tenantID, "checkout_completed"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("RecordMetricDiscovery: %v", err)
	}
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		tenantID, "disc-"+tenantID[:8]+"@example.test").Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	// Two events of that name, inside the window.
	for i := 0; i < 2; i++ {
		if _, err := tx.Exec(ctx, `
INSERT INTO product_events (tenant_id, subscriber_id, event_name, properties, occurred_at)
VALUES ($1::uuid, $2::uuid, 'checkout_completed', '{}'::jsonb, now())`, tenantID, subscriberID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed event: %v", err)
		}
	}
	// And one of a DIFFERENT name, which must not be counted.
	if _, err := tx.Exec(ctx, `
INSERT INTO product_events (tenant_id, subscriber_id, event_name, properties, occurred_at)
VALUES ($1::uuid, $2::uuid, 'page_viewed', '{}'::jsonb, now())`, tenantID, subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed other event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	repo := &Repo{Pool: pool}
	items, err := repo.MetricRegistry(ctx, tenantID)
	if err != nil {
		t.Fatalf("MetricRegistry: %v", err)
	}
	var found *MetricDefinition
	for i := range items {
		if items[i].Key == "track.checkout_completed" {
			found = &items[i]
		}
	}
	if found == nil {
		t.Fatal("the tenant's own event is not a reportable metric — every custom " +
			"event stays a second-class citizen of the analytics product")
	}
	if found.RuntimeStatus != "supported" {
		t.Errorf("runtime_status = %q, want supported", found.RuntimeStatus)
	}

	// And it computes, counting only its own event.
	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	since := time.Now().UTC().Add(-time.Hour)
	until := time.Now().UTC().Add(time.Hour)
	n, err := previewMetricTotal(ctx, read, tenantID, *found, since, until)
	if err != nil {
		t.Fatalf("the metric is listed but has no executor: %v", err)
	}
	if n != 2 {
		t.Fatalf("count = %d, want 2 — a discovered metric must count only its "+
			"own event, not every event the tenant sends", n)
	}
}

// Re-observing an event keeps the date it was first seen.
//
// first_seen_at is the only column here that cannot be recomputed: "we have
// been receiving this since March" is not derivable from an event stream that
// has been partially pruned.
func TestRediscoveryPreservesFirstSeen(t *testing.T) {
	pool := discoveryPool(t)
	ctx := context.Background()
	tenantID := discoveryTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if err := track.RecordMetricDiscovery(ctx, tx, tenantID, "signup"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("first: %v", err)
	}
	// Backdate it, standing in for a metric first seen months ago.
	if _, err := tx.Exec(ctx, `
UPDATE metric_definitions SET first_seen_at = now() - interval '90 days',
                              last_seen_at  = now() - interval '90 days'
 WHERE tenant_id = $1::uuid AND key = 'track.signup'`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("backdate: %v", err)
	}
	if err := track.RecordMetricDiscovery(ctx, tx, tenantID, "signup"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("second: %v", err)
	}

	var firstAgeDays, lastAgeDays float64
	if err := tx.QueryRow(ctx, `
SELECT EXTRACT(EPOCH FROM (now() - first_seen_at)) / 86400,
       EXTRACT(EPOCH FROM (now() - last_seen_at)) / 86400
  FROM metric_definitions WHERE tenant_id = $1::uuid AND key = 'track.signup'`,
		tenantID).Scan(&firstAgeDays, &lastAgeDays); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read: %v", err)
	}
	_ = tx.Rollback(ctx)

	if firstAgeDays < 89 {
		t.Errorf("first_seen_at was reset to %.1f days ago; the date a metric "+
			"started arriving cannot be recovered once overwritten", firstAgeDays)
	}
	if lastAgeDays > 1 {
		t.Errorf("last_seen_at = %.1f days ago, want refreshed to now — a metric "+
			"that stopped arriving must be distinguishable from a live one", lastAgeDays)
	}
}

// A tenant's event cannot redefine a built-in metric.
func TestADiscoveredMetricCannotCollideWithABuiltin(t *testing.T) {
	pool := discoveryPool(t)
	ctx := context.Background()
	tenantID := discoveryTenant(t, pool)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	// An event named exactly like a built-in metric key.
	if err := track.RecordMetricDiscovery(ctx, tx, tenantID, "campaign.opened"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("discover: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	items, err := (&Repo{Pool: pool}).MetricRegistry(ctx, tenantID)
	if err != nil {
		t.Fatalf("MetricRegistry: %v", err)
	}
	seen := map[string]int{}
	for _, item := range items {
		seen[item.Key]++
	}
	if seen["campaign.opened"] != 1 {
		t.Fatalf("campaign.opened appears %d times — a tenant event silently "+
			"redefined a built-in metric", seen["campaign.opened"])
	}
	if seen["track.campaign.opened"] != 1 {
		t.Fatal("the tenant's own event is missing; it must be namespaced, not dropped")
	}
	// And the built-in must still be the built-in.
	for _, item := range items {
		if item.Key == "campaign.opened" && item.Source != "campaign_report_events" {
			t.Fatalf("built-in campaign.opened now reads from %q", item.Source)
		}
	}
}
