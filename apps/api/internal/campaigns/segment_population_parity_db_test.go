// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

func TestComposedSegmentCountLiveAndFrozenAudienceParity_DB(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := setupTenantQ(t, pool, ctx, "segment-population-parity")
	marker := fmt.Sprintf("population-%d", time.Now().UnixNano())

	eligible := marker + "-eligible@example.test"
	archived := marker + "-archived@example.test"
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: eligible, status: "enabled"},
		{email: marker + "-unconsented@example.test", status: "enabled", noEmailConsent: true},
		{email: marker + "-disabled@example.test", status: "disabled"},
		{email: archived, status: "enabled"},
		{email: "outside@example.test", status: "enabled"},
	})
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE subscribers SET archived_at = now() WHERE tenant_id = $1::uuid AND email = $2`, tenantID, archived); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	baseAST, _ := json.Marshal(map[string]any{
		"op": "condition", "field": "email", "comparator": "contains", "value": marker,
	})
	baseID := insertSegmentQ(t, pool, ctx, tenantID, marker+"-base", string(baseAST))
	composedAST, _ := json.Marshal(map[string]any{
		"op": "condition", "field": "segment_id", "comparator": "in_segment", "value": baseID,
	})
	composedID := insertSegmentQ(t, pool, ctx, tenantID, marker+"-composed", string(composedAST))

	segmentRepo := &segments.Repo{Pool: pool}
	count, err := segmentRepo.CountSegmentAudience(ctx, tenantID, composedID)
	if err != nil {
		t.Fatalf("CountSegmentAudience: %v", err)
	}
	if count != 1 {
		t.Fatalf("activation count=%d want=1", count)
	}

	campaignRepo := &Repo{Pool: pool}
	live, err := campaignRepo.AudienceEmails(ctx, tenantID, composedID)
	if err != nil {
		t.Fatalf("AudienceEmails: %v", err)
	}
	if len(live) != int(count) || live[0] != eligible {
		t.Fatalf("live audience=%v count=%d want [%s]", live, count, eligible)
	}

	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, marker+"-campaign")
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE campaigns SET segment_id = $2::uuid WHERE tenant_id = $1::uuid AND id = $3::uuid`, tenantID, composedID, campaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	frozenCount, err := campaignRepo.FreezeCampaignAudience(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("FreezeCampaignAudience: %v", err)
	}
	if frozenCount != int(count) {
		t.Fatalf("frozen count=%d activation count=%d", frozenCount, count)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var freezeID string
	if err := tx.QueryRow(ctx, `SELECT frozen_freeze_id::text FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID).Scan(&freezeID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	frozen, err := campaignRepo.FrozenAudienceEmails(ctx, tenantID, freezeID)
	if err != nil {
		t.Fatalf("FrozenAudienceEmails: %v", err)
	}
	frozenCampaign, err := campaignRepo.Get(ctx, tenantID, campaignID)
	if err != nil {
		t.Fatalf("Get frozen campaign: %v", err)
	}
	resolved, err := campaignRepo.ResolveCampaignAudience(ctx, tenantID, frozenCampaign)
	if err != nil {
		t.Fatalf("ResolveCampaignAudience frozen: %v", err)
	}
	if !resolved.Frozen || resolved.Kind != CampaignAudienceSegment {
		t.Fatalf("resolved frozen metadata = %+v, want frozen segment", resolved)
	}
	sort.Strings(live)
	sort.Strings(frozen)
	sort.Strings(resolved.Emails)
	if fmt.Sprint(frozen) != fmt.Sprint(live) {
		t.Fatalf("frozen audience=%v live audience=%v", frozen, live)
	}
	if fmt.Sprint(resolved.Emails) != fmt.Sprint(frozen) {
		t.Fatalf("resolved audience=%v frozen audience=%v", resolved.Emails, frozen)
	}
}
