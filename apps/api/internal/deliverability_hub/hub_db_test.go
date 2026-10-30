// SPDX-License-Identifier: AGPL-3.0-only
package deliverability_hub

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestComputeHubUsesExactCampaignSendCohortDB(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping Hub cohort integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, 'Deliverability cohort test', 'studio')`,
		tenantID, "deliverability-cohort-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant (role lacks tenant INSERT): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = cleanup.Commit(cleanupCtx)
	})

	now := time.Now().UTC()
	campaignA := uuid.NewString()
	campaignB := uuid.NewString()
	oldCampaign := uuid.NewString()
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, status)
VALUES ($2::uuid, $1::uuid, 'A', 'A', 'sent'),
       ($3::uuid, $1::uuid, 'B', 'B', 'sent'),
	   ($4::uuid, $1::uuid, 'Old', 'Old', 'sent')`,
		tenantID, campaignA, campaignB, oldCampaign); err != nil {
		t.Fatalf("seed campaigns: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_recipients
       (tenant_id, campaign_id, subscriber_email, status, sent_at)
VALUES ($1::uuid, $2::uuid, 'same@example.test', 'sent', $5),
       ($1::uuid, $3::uuid, 'same@example.test', 'sent', $5),
	   ($1::uuid, $4::uuid, 'old@example.test', 'sent', $6)`,
		tenantID, campaignA, campaignB, oldCampaign,
		now.Add(-24*time.Hour), now.Add(-40*24*time.Hour)); err != nil {
		t.Fatalf("seed recipients: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_events
       (tenant_id, campaign_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2::uuid, 'same@example.test', 'opened', $5),
       ($1::uuid, $3::uuid, 'same@example.test', 'clicked', $5),
	   ($1::uuid, $4::uuid, 'old@example.test', 'clicked', $5)`,
		tenantID, campaignA, campaignB, oldCampaign,
		now.Add(-24*time.Hour)); err != nil {
		t.Fatalf("seed events: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	hub, err := (&Deps{Pool: pool, Clock: func() time.Time { return now }}).computeHub(ctx, tenantID)
	if err != nil {
		t.Fatalf("computeHub: %v", err)
	}
	if hub.Totals.Sends30d != 2 || hub.Totals.Sends7d != 2 {
		t.Fatalf("send cohort totals = %+v, want 2/2", hub.Totals)
	}
	if hub.EngagementRate != 1 {
		t.Fatalf("engagement rate = %v, want 1 from two engaged campaign sends", hub.EngagementRate)
	}
	if hub.EventRateScope != "campaigns" {
		t.Fatalf("event rate scope = %q", hub.EventRateScope)
	}
	if hub.SampleQualified || hub.Status != "Insufficient data" {
		t.Fatalf("two-send cohort must remain unqualified: qualified=%v status=%q", hub.SampleQualified, hub.Status)
	}
	if hub.ModelVersion != DeliverabilityScoreModelVersion {
		t.Fatalf("model version = %q", hub.ModelVersion)
	}
}
