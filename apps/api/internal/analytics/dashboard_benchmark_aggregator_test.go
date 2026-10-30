// SPDX-License-Identifier: AGPL-3.0-only
package analytics

import (
	"context"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDashboardBenchmarkCountsAggregateBeforeRateDivision(t *testing.T) {
	total := dashboardBenchmarkCounts{}
	total.add(dashboardBenchmarkCounts{
		sent:      2,
		campaigns: 1,
		opens:     1,
		clicks:    1,
	})
	total.add(dashboardBenchmarkCounts{
		sent:      8,
		campaigns: 2,
		opens:     3,
		bounces:   2,
		unsubs:    1,
	})

	if total.sent != 10 || total.campaigns != 3 {
		t.Fatalf("aggregate totals = %+v", total)
	}
	got := make(map[string]float64)
	for _, metric := range total.metrics() {
		got[metric.key] = float64(metric.events) / float64(total.sent)
	}
	want := map[string]float64{
		"opens":   0.4,
		"clicks":  0.1,
		"bounces": 0.2,
		"unsubs":  0.1,
	}
	for key, expected := range want {
		if math.Abs(got[key]-expected) > 1e-12 {
			t.Fatalf("%s rate = %v, want %v", key, got[key], expected)
		}
	}
}

func TestBenchmarkWorkerEnumeratesAndCountsFORCERLSTenantsDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	firstTenantID := followupTenant(t, pool, ctx)
	secondTenantID := followupTenant(t, pool, ctx)
	firstCampaignID := followupCampaign(t, pool, ctx, firstTenantID, "benchmark first", "first")
	secondCampaignID := followupCampaign(t, pool, ctx, secondTenantID, "benchmark second", "second")

	followupEvent(t, pool, ctx, firstTenantID, firstCampaignID, "one@example.test", "sent", 5)
	followupEvent(t, pool, ctx, firstTenantID, firstCampaignID, "two@example.test", "sent", 4)
	followupEvent(t, pool, ctx, firstTenantID, firstCampaignID, "one@example.test", "opened", 3)
	followupEvent(t, pool, ctx, firstTenantID, firstCampaignID, "one@example.test", "clicked", 2)
	followupEvent(t, pool, ctx, secondTenantID, secondCampaignID, "three@example.test", "sent", 5)
	followupEvent(t, pool, ctx, secondTenantID, secondCampaignID, "three@example.test", "bounced", 2)
	followupEvent(t, pool, ctx, secondTenantID, secondCampaignID, "three@example.test", "unsubscribed", 1)

	var rawVisible int
	if err := pool.QueryRow(ctx, `
SELECT count(*) FROM campaign_report_events
 WHERE tenant_id IN ($1::uuid, $2::uuid)`,
		firstTenantID, secondTenantID,
	).Scan(&rawVisible); err != nil {
		t.Fatalf("raw RLS count: %v", err)
	}
	if rawVisible != 0 {
		t.Fatalf("raw unscoped event read exposed %d rows, want 0", rawVisible)
	}

	tenantIDs, err := dashboardWorkerTenantIDs(ctx, pool)
	if err != nil {
		t.Fatalf("dashboardWorkerTenantIDs: %v", err)
	}
	seen := make(map[string]bool, len(tenantIDs))
	for _, tenantID := range tenantIDs {
		seen[tenantID] = true
	}
	if !seen[firstTenantID] || !seen[secondTenantID] {
		t.Fatalf("worker tenant enumeration omitted fixtures: %v", tenantIDs)
	}

	aggregator := &BenchmarkAggregator{Pool: pool}
	from := time.Now().UTC().Add(-time.Hour)
	asOf := time.Now().UTC().Add(time.Minute)
	first, err := aggregator.countTenant(ctx, firstTenantID, from, asOf)
	if err != nil {
		t.Fatalf("count first tenant: %v", err)
	}
	if first != (dashboardBenchmarkCounts{
		sent: 2, campaigns: 1, opens: 1, clicks: 1,
	}) {
		t.Fatalf("first tenant counts = %+v", first)
	}
	second, err := aggregator.countTenant(ctx, secondTenantID, from, asOf)
	if err != nil {
		t.Fatalf("count second tenant: %v", err)
	}
	if second != (dashboardBenchmarkCounts{
		sent: 1, campaigns: 1, bounces: 1, unsubs: 1,
	}) {
		t.Fatalf("second tenant counts = %+v", second)
	}

	const window = 27183
	if _, err := pool.Exec(ctx, `
DELETE FROM dashboard_benchmark_cache WHERE window_days = $1`, window); err != nil {
		t.Fatalf("clear benchmark cache: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx,
			`DELETE FROM dashboard_benchmark_cache WHERE window_days = $1`, window)
	})

	startedAt := time.Now().UTC()
	aggregator.Window = window
	if err := aggregator.compute(ctx); err != nil {
		t.Fatalf("compute: %v", err)
	}
	rows, err := pool.Query(ctx, `
SELECT metric, average, sample_size, computed_at
  FROM dashboard_benchmark_cache
 WHERE window_days = $1
 ORDER BY metric`, window)
	if err != nil {
		t.Fatalf("read benchmark cache: %v", err)
	}
	defer rows.Close()
	computedAt := make(map[time.Time]bool)
	metrics := make(map[string]float64)
	for rows.Next() {
		var metric string
		var average float64
		var sampleSize int
		var at time.Time
		if err := rows.Scan(&metric, &average, &sampleSize, &at); err != nil {
			t.Fatalf("scan benchmark cache: %v", err)
		}
		if sampleSize < 2 {
			t.Fatalf("%s sample size = %d, want at least two fixture campaigns", metric, sampleSize)
		}
		if at.Before(startedAt.Add(-time.Second)) {
			t.Fatalf("%s computed_at = %s, predates compute", metric, at)
		}
		computedAt[at] = true
		metrics[metric] = average
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate benchmark cache: %v", err)
	}
	if len(metrics) != 4 {
		t.Fatalf("cached metrics = %v, want four-row snapshot", metrics)
	}
	if len(computedAt) != 1 {
		t.Fatalf("computed_at values = %v, want one atomic transaction timestamp", computedAt)
	}
	for _, metric := range []string{"opens", "clicks", "bounces", "unsubs"} {
		if metrics[metric] <= 0 {
			t.Fatalf("%s average = %v, want fixture contribution", metric, metrics[metric])
		}
	}
}

func TestDashboardWorkerSourcesKeepTenantTablesOutOfRawPoolReads(t *testing.T) {
	files := map[string][]string{
		"dashboard_worker_tenants.go": {
			"db.WithWorkerScope",
			"SELECT id::text FROM tenants",
		},
		"dashboard_digest_sender.go": {
			"db.WithTenant(ctx, s.Pool, tenantID)",
			"s.dueRecipientsForTenant",
		},
		"dashboard_benchmark_aggregator.go": {
			"db.WithTenantOptions(ctx, a.Pool, tenantID",
			"tx.Exec(ctx",
		},
	}
	for file, required := range files {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		for _, fragment := range required {
			if !strings.Contains(string(source), fragment) {
				t.Errorf("%s missing source contract %q", file, fragment)
			}
		}
	}

	benchmarkSource, err := os.ReadFile("dashboard_benchmark_aggregator.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(benchmarkSource), "a.Pool.QueryRow(ctx") ||
		strings.Contains(string(benchmarkSource), "a.Pool.Exec(ctx") {
		t.Fatal("benchmark tenant reads or multi-row cache writes regressed to raw pool calls")
	}
	digestSource, err := os.ReadFile("dashboard_digest_sender.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(digestSource), "s.Pool.Query(ctx") {
		t.Fatal("digest tenant reads regressed to raw pool calls")
	}
}
