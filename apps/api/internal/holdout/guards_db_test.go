// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"context"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Once a holdout has been applied to a send, its percentage is frozen.
//
// `percent` IS the bucket cutoff: IsHeldOut compares a subscriber's hash bucket
// against it. Editing it after the send has already partitioned the audience
// therefore re-randomises which people count as the control arm, and the lift
// report starts measuring a cohort that was never withheld — while the campaign
// still shows a holdout and a number. The upsert had no decided_at guard, so a
// single PATCH silently invalidated the experiment.
func TestADecidedHoldoutCannotBeRepercentaged(t *testing.T) {
	pool := holdoutDB(t)
	ctx := context.Background()
	tenantID := createHoldoutTenant(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, campaign_type, status)
VALUES ($1::uuid, 'holdout-guard', 'subject', 'regular', 'draft')
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_holdouts (campaign_id, tenant_id, percent, seed, decided_at,
                               held_out_count, sent_count)
VALUES ($1::uuid, $2::uuid, 10, 'seed-v1', now(), 100, 900)`,
		campaignID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed decided holdout: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	// The same statement the Create handler issues.
	write, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = write.Rollback(ctx) }()
	tag, err := write.Exec(ctx, `
INSERT INTO campaign_holdouts (campaign_id, tenant_id, percent, seed)
VALUES ($1::uuid, $2::uuid, $3, $4)
ON CONFLICT (campaign_id) DO UPDATE
   SET percent = EXCLUDED.percent,
       updated_at = now()
 WHERE campaign_holdouts.decided_at IS NULL`, campaignID, tenantID, 40.0, "seed-v2")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if tag.RowsAffected() != 0 {
		t.Fatal("a decided holdout accepted a new percentage; the control arm has " +
			"been silently re-randomised and the lift now measures a cohort that " +
			"was never withheld")
	}

	var percent float64
	if err := write.QueryRow(ctx, `
SELECT percent::float8 FROM campaign_holdouts WHERE campaign_id = $1::uuid`,
		campaignID).Scan(&percent); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if percent != 10 {
		t.Fatalf("percent = %v, want the original 10", percent)
	}
}

// An undecided holdout is still editable — the guard must not freeze it early.
func TestAnUndecidedHoldoutIsStillEditable(t *testing.T) {
	pool := holdoutDB(t)
	ctx := context.Background()
	tenantID := createHoldoutTenant(t, pool, ctx)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var campaignID string
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, campaign_type, status)
VALUES ($1::uuid, 'holdout-editable', 'subject', 'regular', 'draft')
RETURNING id::text`, tenantID).Scan(&campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_holdouts (campaign_id, tenant_id, percent, seed)
VALUES ($1::uuid, $2::uuid, 10, 'seed-v1')`, campaignID, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed holdout: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	write, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = write.Rollback(ctx) }()
	tag, err := write.Exec(ctx, `
INSERT INTO campaign_holdouts (campaign_id, tenant_id, percent, seed)
VALUES ($1::uuid, $2::uuid, $3, $4)
ON CONFLICT (campaign_id) DO UPDATE
   SET percent = EXCLUDED.percent, updated_at = now()
 WHERE campaign_holdouts.decided_at IS NULL`, campaignID, tenantID, 25.0, "seed-v2")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if tag.RowsAffected() == 0 {
		t.Fatal("an undecided holdout refused an edit; the guard froze it before " +
			"the number meant anything")
	}
}

// Transactional and automated messages can never carry a holdout.
func TestTransactionalMessagesAreBlockedFromHoldouts(t *testing.T) {
	for _, blocked := range []string{"transactional", "automated"} {
		if !blockedHoldoutCampaignTypes[blocked] {
			t.Errorf("%q is not blocked: a holdout suppresses its control arm, so a "+
				"recipient waiting for this message would simply not receive it", blocked)
		}
	}
	for _, allowed := range []string{"regular", "plain_text", "ab_test", "rss"} {
		if blockedHoldoutCampaignTypes[allowed] {
			t.Errorf("%q is blocked, but a marketing send is exactly what a holdout "+
				"is for", allowed)
		}
	}
}

// The small-list floor is the PRD's 2,000.
func TestTheSmallListFloorIsTwoThousand(t *testing.T) {
	if minimumHoldoutAudience != 2000 {
		t.Fatalf("minimumHoldoutAudience = %d, want 2000", minimumHoldoutAudience)
	}
}
