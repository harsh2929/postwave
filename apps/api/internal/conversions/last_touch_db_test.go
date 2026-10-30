// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed tests for AUTOMATIC last-touch attribution + the backfill
// pass. Skip without DATABASE_URL (the test DB must already have
// migration 0397 applied — attributed_via column +
// campaign_report_events_last_touch_idx).
//
// These reuse the fixtures helpers in attribution_db_test.go
// (attributionDB, createAttributionTenant, createAttributionCampaign,
// seedConversion, i64) under the same throwaway-tenant cleanup model.
package conversions

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// seedClickEvent inserts a single 'clicked' campaign_report_event for a
// subscriber at a controlled time, so last-touch lookups are
// deterministic.
func seedClickEvent(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID, email string, at time.Time) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_report_events (tenant_id, campaign_id, subscriber_email, event_type, link_url, at)
VALUES ($1::uuid, $2::uuid, $3, 'clicked', 'https://example.test', $4)`,
		tenantID, campaignID, email, at); err != nil {
		t.Fatalf("insert click event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit click event: %v", err)
	}
}

// seedConversionEmail inserts a legacy-shape conversion fact with a
// controlled subscriber_email and NO attributed_via (NULL) — the
// historical rows the backfill targets. campaignID "" → unattributed;
// amountCents nil → non-monetary.
func seedConversionEmail(t *testing.T, pool *db.Pool, ctx context.Context, tenantID, campaignID, email string, amountCents *int64, currency string, occurredAt time.Time) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions (tenant_id, event_name, subscriber_email, amount_cents, currency, campaign_id, occurred_at)
VALUES ($1::uuid, 'purchase', NULLIF($2, ''), $3, NULLIF($4, ''), NULLIF($5, '')::uuid, $6)`,
		tenantID, email, amountCents, currency, campaignID, occurredAt); err != nil {
		t.Fatalf("insert conversion: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit conversion: %v", err)
	}
}

// TestInsert_LastTouchPicksMostRecentInWindowClick: a conversion with
// no explicit campaign_id is attributed to the subscriber's MOST RECENT
// in-window click, and stamped attributed_via='last_touch'.
func TestInsert_LastTouchPicksMostRecentInWindowClick(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	campOld := createAttributionCampaign(t, pool, ctx, tenantID, "Old")
	campNew := createAttributionCampaign(t, pool, ctx, tenantID, "New")
	email := "buyer@example.test"

	now := time.Now().UTC()
	// Two in-window clicks; the more recent (campNew) must win.
	seedClickEvent(t, pool, ctx, tenantID, campOld, email, now.Add(-72*time.Hour))
	seedClickEvent(t, pool, ctx, tenantID, campNew, email, now.Add(-2*time.Hour))
	// A different subscriber's click must NOT leak in.
	seedClickEvent(t, pool, ctx, tenantID, campOld, "other@example.test", now.Add(-1*time.Hour))

	repo := &Repo{Pool: pool}
	c, err := repo.Insert(ctx, tenantID, IngestInput{
		Email:     email,
		EventName: "purchase_lasttouch",
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if c.CampaignID != campNew {
		t.Errorf("campaign_id = %q, want most-recent click campaign %q", c.CampaignID, campNew)
	}
	if c.AttributedVia != AttributedViaLastTouch {
		t.Errorf("attributed_via = %q, want %q", c.AttributedVia, AttributedViaLastTouch)
	}
}

// TestInsert_OutOfWindowClickIsUnattributed: a click older than the
// 7-day window must NOT attribute; the conversion stays unattributed
// and is stamped attributed_via='none'.
func TestInsert_OutOfWindowClickIsUnattributed(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	camp := createAttributionCampaign(t, pool, ctx, tenantID, "Stale")
	email := "lurker@example.test"

	now := time.Now().UTC()
	// Click is just outside the window (8 days back > 7d).
	seedClickEvent(t, pool, ctx, tenantID, camp, email, now.Add(-8*24*time.Hour))

	repo := &Repo{Pool: pool}
	c, err := repo.Insert(ctx, tenantID, IngestInput{
		Email:     email,
		EventName: "purchase_outofwindow",
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if c.CampaignID != "" {
		t.Errorf("campaign_id = %q, want \"\" (out-of-window click must not attribute)", c.CampaignID)
	}
	if c.AttributedVia != AttributedViaNone {
		t.Errorf("attributed_via = %q, want %q", c.AttributedVia, AttributedViaNone)
	}
}

// TestInsert_ExplicitCampaignIDNotOverridden: when the caller supplies
// campaign_id, last-touch must NOT override it even if a more recent
// click points elsewhere; provenance is 'explicit'.
func TestInsert_ExplicitCampaignIDNotOverridden(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	campExplicit := createAttributionCampaign(t, pool, ctx, tenantID, "Explicit")
	campClick := createAttributionCampaign(t, pool, ctx, tenantID, "Clicked")
	email := "vip@example.test"

	now := time.Now().UTC()
	// A very recent click to a DIFFERENT campaign — must be ignored.
	seedClickEvent(t, pool, ctx, tenantID, campClick, email, now.Add(-1*time.Hour))

	repo := &Repo{Pool: pool}
	c, err := repo.Insert(ctx, tenantID, IngestInput{
		Email:      email,
		EventName:  "purchase_explicit",
		CampaignID: campExplicit,
	})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if c.CampaignID != campExplicit {
		t.Errorf("campaign_id = %q, want explicit %q (last-touch must not override)", c.CampaignID, campExplicit)
	}
	if c.AttributedVia != AttributedViaExplicit {
		t.Errorf("attributed_via = %q, want %q", c.AttributedVia, AttributedViaExplicit)
	}
}

// TestInsert_NoEmailNoClickIsNone: a conversion without an email can't
// be last-touch attributed → 'none'.
func TestInsert_NoEmailIsNone(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	repo := &Repo{Pool: pool}
	c, err := repo.Insert(ctx, tenantID, IngestInput{EventName: "anon_purchase"})
	if err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if c.CampaignID != "" || c.AttributedVia != AttributedViaNone {
		t.Errorf("got campaign=%q via=%q, want \"\"/%q", c.CampaignID, c.AttributedVia, AttributedViaNone)
	}
}

// TestBackfill_ClassifiesAndIsIdempotent: historical NULL-attributed_via
// rows are classified by one backfill pass; a second pass is a no-op
// (Scanned==0, Done==true) and does NOT re-attribute or double-count.
func TestBackfill_ClassifiesAndIsIdempotent(t *testing.T) {
	pool := attributionDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := createAttributionTenant(t, pool, ctx)
	campExplicit := createAttributionCampaign(t, pool, ctx, tenantID, "Explicit")
	campClick := createAttributionCampaign(t, pool, ctx, tenantID, "Clicked")
	email := "hist@example.test"

	now := time.Now().UTC()
	// Seed an in-window click 2h before the conversion's occurred_at.
	convAt := now.Add(-1 * time.Hour)
	seedClickEvent(t, pool, ctx, tenantID, campClick, email, convAt.Add(-2*time.Hour))

	// seedConversion inserts WITHOUT attributed_via (NULL) — the legacy
	// shape this backfill targets.
	//   row1: NULL campaign, in-window click present  → last_touch
	//   row2: explicit campaign already set            → explicit
	//   row3: NULL campaign, no click for this email   → none
	seedConversionEmail(t, pool, ctx, tenantID, "", email, i64(1000), "USD", convAt)
	seedConversionEmail(t, pool, ctx, tenantID, campExplicit, "tagged@example.test", i64(2000), "USD", convAt)
	seedConversionEmail(t, pool, ctx, tenantID, "", "noclick@example.test", nil, "", convAt)

	repo := &Repo{Pool: pool}
	res, err := repo.BackfillLastTouch(ctx, tenantID)
	if err != nil {
		t.Fatalf("BackfillLastTouch: %v", err)
	}
	if res.Scanned != 3 {
		t.Fatalf("scanned = %d, want 3", res.Scanned)
	}
	if res.LastTouch != 1 || res.Explicit != 1 || res.None != 1 {
		t.Errorf("classified = lastTouch:%d explicit:%d none:%d, want 1/1/1",
			res.LastTouch, res.Explicit, res.None)
	}
	if !res.Done {
		t.Errorf("done = false, want true (only 3 rows < batch)")
	}

	// Second pass must be a no-op — idempotent.
	res2, err := repo.BackfillLastTouch(ctx, tenantID)
	if err != nil {
		t.Fatalf("BackfillLastTouch (2nd): %v", err)
	}
	if res2.Scanned != 0 || !res2.Done {
		t.Errorf("2nd pass = scanned:%d done:%v, want 0/true", res2.Scanned, res2.Done)
	}

	// Aggregate provenance must reflect 1 explicit + 1 last_touch + 1 none,
	// 0 unclassified — and the last-touch row must have its campaign_id
	// filled (it now appears as an attributed item, not unattributed).
	out, err := repo.CampaignAttribution(ctx, tenantID, 90, now)
	if err != nil {
		t.Fatalf("CampaignAttribution: %v", err)
	}
	p := out.Provenance
	if p.Explicit != 1 || p.LastTouch != 1 || p.None != 1 || p.Unclassified != 0 {
		t.Errorf("provenance = %+v, want explicit:1 last_touch:1 none:1 unclassified:0", p)
	}
	// The backfilled last-touch row must now be attributed (campaign_id
	// filled), so the Clicked campaign appears among items and only the
	// genuinely-none row remains unattributed.
	if out.UnattributedConversions != 1 {
		t.Errorf("unattributed_conversions = %d, want 1 (only the none row)", out.UnattributedConversions)
	}
	foundClick := false
	for _, it := range out.Items {
		if it.CampaignID == campClick {
			foundClick = true
		}
	}
	if !foundClick {
		t.Errorf("Clicked campaign %q missing from items after backfill", campClick)
	}
}
