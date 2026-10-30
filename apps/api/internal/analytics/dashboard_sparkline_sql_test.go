// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"strings"
	"testing"
)

// campaign_report_events is PARTITION BY RANGE (at) with monthly partitions
// plus a `-infinity` legacy partition. The sparklines used to express their
// only `at` bound as a LEFT JOIN condition against a runtime-generated series,
// with no WHERE on the table at all — which gives the planner nothing to prune
// on, so every partition (all history) was fed into the join, three times per
// dashboard load and per SSE tick.
//
// The fix is a property of the SQL text, so assert the text. A DB test would
// only catch this by reading EXPLAIN output, which is exactly the check that
// was never run when the old comment claimed the shape was "index-friendly".
// Text alone cannot say the SQL runs: this test once pinned a join that
// Postgres rejects as ambiguous, so dashboard_sparkline_db_test.go executes it.
func TestSparklineQueriesBoundTheWindowInAWhereNotAJoin(t *testing.T) {
	t.Parallel()

	for name, sql := range map[string]string{
		"events":      dashboardEventSparklineSQL,
		"subscribers": dashboardSubscriberSparklineSQL,
	} {
		t.Run(name, func(t *testing.T) {
			// The series is joined to a pre-aggregate, never to the base table.
			for _, forbidden := range []string{
				"LEFT JOIN campaign_report_events",
				"LEFT JOIN subscribers",
			} {
				if strings.Contains(sql, forbidden) {
					t.Fatalf("%q joins the base table to the generated series:\n%s", forbidden, sql)
				}
			}
			if !strings.Contains(sql, "LEFT JOIN bucket ON bucket.day = series.day") {
				t.Fatalf("series is not joined to the bounded pre-aggregate:\n%s", sql)
			}
			// And the aggregate is bounded by a WHERE on the source table.
			where := strings.Index(sql, "WHERE tenant_id = $1::uuid")
			if where < 0 {
				t.Fatalf("no tenant-scoped WHERE on the source table:\n%s", sql)
			}
			join := strings.Index(sql, "LEFT JOIN")
			if join >= 0 && where > join {
				t.Fatalf("the WHERE comes after the join — the CTE is not the bounded one:\n%s", sql)
			}
		})
	}

	// One query, not three. The three event series read the same table over the
	// same window and differed only in the bound event_type; running them
	// serially cost three scans and three round-trips inside the request tx.
	for _, filter := range []string{
		"count(*) FILTER (WHERE event_type = 'opened')",
		"count(*) FILTER (WHERE event_type = 'clicked')",
		"count(*) FILTER (WHERE event_type = 'bounced')",
	} {
		if !strings.Contains(dashboardEventSparklineSQL, filter) {
			t.Fatalf("event sparkline no longer folds %q into the single scan:\n%s",
				filter, dashboardEventSparklineSQL)
		}
	}
	if n := strings.Count(dashboardEventSparklineSQL, "FROM campaign_report_events"); n != 1 {
		t.Fatalf("event sparkline reads campaign_report_events %d times, want 1", n)
	}
}

// The cache TTL exists to collapse concurrent tabs onto one execution; it
// cannot reduce the cadence, because it expires exactly as fast as the ticker
// fires. Keeping the two equal is what makes the collapse work, and the poll
// interval is the knob that actually bounds database cost.
func TestDashboardLivePollIntervalIsNotTheCampaignStreamCadence(t *testing.T) {
	t.Parallel()
	if dashboardLivePollInterval < 10_000_000_000 { // 10s in ns
		t.Fatalf("dashboard SSE poll interval = %s: the full 30d+60d rollup is not a "+
			"per-second query", dashboardLivePollInterval)
	}
	if dashboardLiveCacheTTL != dashboardLivePollInterval {
		t.Fatalf("cache TTL %s != poll interval %s: ticks stop sharing one execution",
			dashboardLiveCacheTTL, dashboardLivePollInterval)
	}
}
