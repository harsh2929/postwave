// SPDX-License-Identifier: AGPL-3.0-only

package reporting

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A stored run must carry what it means and how fresh it was.
//
// `report_runs` recorded numbers and nothing else. Two surfaces could show
// different values for the same saved report — one computed before a metric was
// redefined, one after; or one over data that had landed and one over data that
// had not — and neither could say which, so the disagreement read as a bug in
// whichever you happened to be looking at.

func TestARunRecordsWhichDefinitionsProducedIt(t *testing.T) {
	pool := newReportingPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seedReportingTenant(t, pool)
	repo := &Repo{Pool: pool}

	def, err := repo.UpsertDefinition(ctx, tenantID, ReportRequest{
		Name:        "Sends by day",
		ProductArea: "campaign",
		Status:      "active",
		Metrics:     []MetricSpec{{Key: "campaign.sent"}},
		Dimensions:  []string{"day"},
	}, "")
	if err != nil {
		t.Fatalf("UpsertDefinition: %v", err)
	}

	run, err := repo.RunDefinition(ctx, tenantID, def.ID)
	if err != nil {
		t.Fatalf("RunDefinition: %v", err)
	}
	if run.MetricVersion == "" {
		t.Fatal("the run records no metric version, so a number computed before " +
			"a formula changed is indistinguishable from one computed after")
	}
	if run.MetricVersion != MetricRegistryVersion {
		t.Fatalf("metric_version=%q, want the version in force (%q)",
			run.MetricVersion, MetricRegistryVersion)
	}

	// And it survives a read — a stamp only the writer can see is no use to the
	// surface rendering the report.
	reread, err := repo.GetRun(ctx, tenantID, run.ID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if reread.MetricVersion != run.MetricVersion {
		t.Fatalf("re-read metric_version=%q, want %q", reread.MetricVersion, run.MetricVersion)
	}
}

// seedReportingCampaign creates one campaign owned by tenantID and returns its
// id, so an events fixture references a campaign that actually exists rather
// than relying on whatever the database happens to contain.
func seedReportingCampaign(t *testing.T, pool *db.Pool, tenantID string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("campaign tx: %v", err)
	}
	var campaignID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO campaigns (tenant_id, name, subject)
		VALUES ($1::uuid, 'reporting freshness fixture', 'fixture')
		RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	t.Cleanup(func() {
		c, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(context.Background()) }()
		for _, q := range []string{
			`DELETE FROM campaign_report_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM campaigns WHERE tenant_id = $1::uuid`,
		} {
			if _, err := c.Exec(context.Background(), q, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(context.Background())
	})
	return campaignID
}

func TestFreshnessComesFromTheDataNotTheClock(t *testing.T) {
	pool := newReportingPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := seedReportingTenant(t, pool)
	repo := &Repo{Pool: pool}

	// Source data that last landed well in the past. Stamping time.Now() would
	// claim this six-hour-old answer is current, which is the exact lie the
	// column exists to prevent.
	landed := time.Now().UTC().Add(-6 * time.Hour).Truncate(time.Second)
	// A real campaign to hang the event off. `campaign_report_events` is
	// RANGE-partitioned on `at` (migration 0339); the pre-partition table was
	// renamed to campaign_report_events_legacy and ATTACHed as the
	// `[-infinity, cutover)` partition, keeping its own
	// campaign_report_events_campaign_id_fkey → campaigns(id). The partitioned
	// parent has no such FK, so whether campaign_id is enforced depends on which
	// partition the row routes to. The cutover is "start of the month after the
	// migration ran", so on a freshly-replayed database recent timestamps land in
	// the legacy child and the FK bites; on a database migrated months ago they
	// land in a monthly partition that has no FK. A gen_random_uuid() campaign_id
	// was therefore never valid — it just went unchecked. Seed a campaign the
	// event can legitimately reference so this passes on either.
	campaignID := seedReportingCampaign(t, pool, tenantID)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, event_type, at)
VALUES ($1::uuid, $3::uuid, 'sent', $2)`, tenantID, landed, campaignID); err != nil {
		_ = tx.Rollback(ctx)
		// Deliberately NOT a Skip. The first version skipped on a NOT NULL
		// violation and reported PASS, so the assertion below — the one that
		// distinguishes a real stamp from time.Now() — never ran.
		t.Fatalf("seed campaign_report_events: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	def, err := repo.UpsertDefinition(ctx, tenantID, ReportRequest{
		Name:        "Sends by day",
		ProductArea: "campaign",
		Status:      "active",
		Metrics:     []MetricSpec{{Key: "campaign.sent"}},
		Dimensions:  []string{"day"},
	}, "")
	if err != nil {
		t.Fatalf("UpsertDefinition: %v", err)
	}
	run, err := repo.RunDefinition(ctx, tenantID, def.ID)
	if err != nil {
		t.Fatalf("RunDefinition: %v", err)
	}

	if run.ComputedAsOf == nil {
		t.Fatal("no freshness stamp, so the report cannot say how old its answer is")
	}
	if got := run.ComputedAsOf.UTC().Truncate(time.Second); !got.Equal(landed) {
		t.Fatalf("computed_as_of=%v, want the newest datum (%v). A stamp of "+
			"'now' would claim a six-hour-old answer is current", got, landed)
	}
}
