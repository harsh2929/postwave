// SPDX-License-Identifier: AGPL-3.0-only

package analytics

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The sparkline queries once failed on every database with SQLSTATE 42702
// ("day" is ambiguous) while the text-only shape test stayed green, because
// nothing executed them; /api/v1/dashboard/stats answered 500 for every tenant.
// This runs them against the migrated schema, inside the tenant transaction
// the handler uses, and checks what they count.
func TestDashboardSparklinesRunAgainstTheSchemaDB(t *testing.T) {
	pool := followupDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := followupTenant(t, pool, ctx)
	campaignID := followupCampaign(t, pool, ctx, tenantID, "sparkline", "sparkline")
	email := "spark-" + tenantID[:8] + "@example.test"
	followupSubscriber(t, pool, ctx, tenantID, email)
	followupEvent(t, pool, ctx, tenantID, campaignID, email, "opened", 1)
	followupEvent(t, pool, ctx, tenantID, campaignID, email, "clicked", 1)
	followupEvent(t, pool, ctx, tenantID, campaignID, email, "bounced", 1)
	followupEvent(t, pool, ctx, tenantID, campaignID, email, "opened", 3*24*60)

	// Another tenant's activity in the same window must not be counted.
	otherTenantID := followupTenant(t, pool, ctx)
	otherCampaignID := followupCampaign(t, pool, ctx, otherTenantID, "foreign", "foreign")
	followupSubscriber(t, pool, ctx, otherTenantID, "foreign-"+otherTenantID[:8]+"@example.test")
	followupEvent(t, pool, ctx, otherTenantID, otherCampaignID, "foreign@example.test", "opened", 1)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const days = 7
	got, err := dashboardSparklinesTx(ctx, tx, tenantID, days)
	if err != nil {
		t.Fatalf("dashboardSparklinesTx: %v", err)
	}

	// Sums and bucket counts rather than bucket positions: an event a minute
	// old lands in yesterday's bucket when the test runs just after midnight.
	for series, want := range map[string]int{"subscribers": 1, "opens": 2, "clicks": 1, "bounces": 1} {
		values := got[series]
		if len(values) != days {
			t.Fatalf("%s has %d buckets, want %d (one per day, zero-filled): %v", series, len(values), days, values)
		}
		sum := 0
		for _, v := range values {
			sum += v
		}
		if sum != want {
			t.Errorf("%s counts %d, want %d: %v", series, sum, want, values)
		}
	}
	nonZero := 0
	for _, v := range got["opens"] {
		if v > 0 {
			nonZero++
		}
	}
	if nonZero != 2 {
		t.Errorf("opens three days apart fill %d buckets, want 2: %v", nonZero, got["opens"])
	}
}
