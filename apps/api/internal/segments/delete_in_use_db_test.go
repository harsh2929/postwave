// SPDX-License-Identifier: AGPL-3.0-only
//
// delete_in_use_db_test.go — DELETE /api/v1/segments/{id} while campaigns
// that have not sent use the segment. Before the fix the 1876 trigger's 23503
// reached the handler as a generic 500 ("an internal error occurred"), which
// the web client then retried twice more.

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestDeleteSegmentInUseByUnsentCampaigns_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	router := segmentsRouter(&Deps{Repo: repo})
	rec := installSegRecorder(t)

	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Spring audience " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create segment: %v", err)
	}
	// Three campaigns that can still send, and three that cannot: one sending,
	// one sent, and one paused after dispatch began (started_at set).
	draft := addCampaign(t, pool, tenantID, seg.ID, "Spring launch", "draft", false)
	scheduled := addCampaign(t, pool, tenantID, seg.ID, "April reminder", "scheduled", false)
	paused := addCampaign(t, pool, tenantID, seg.ID, "Walkthrough check campaign", "paused", false)
	addCampaign(t, pool, tenantID, seg.ID, "Mid-send", "sending", true)
	sent := addCampaign(t, pool, tenantID, seg.ID, "Last winter", "sent", true)
	addCampaign(t, pool, tenantID, seg.ID, "Paused mid-send", "paused", true)

	resp := serveSegments(t, router, tenantID, http.MethodDelete, "/api/v1/segments/"+seg.ID, nil)
	if resp.Code != http.StatusConflict {
		t.Fatalf("DELETE status = %d, want 409; body=%s", resp.Code, resp.Body.String())
	}
	refusal := decodeBody[errorEnvelope](t, resp)
	if refusal.Error.Code != "segment_in_use" {
		t.Fatalf("code = %q, want segment_in_use", refusal.Error.Code)
	}
	for _, name := range []string{`"April reminder"`, `"Spring launch"`, `"Walkthrough check campaign"`} {
		if !strings.Contains(refusal.Error.Message, name) {
			t.Errorf("message does not name %s: %q", name, refusal.Error.Message)
		}
	}
	for _, name := range []string{"Mid-send", "Last winter", "Paused mid-send"} {
		if strings.Contains(refusal.Error.Message, name) {
			t.Errorf("message names %q, which can no longer send: %q", name, refusal.Error.Message)
		}
	}
	if !strings.Contains(refusal.Error.Message, "3 campaigns that haven't sent yet") {
		t.Errorf("message does not count the blocking campaigns: %q", refusal.Error.Message)
	}
	if !readSegmentRow(t, pool, tenantID, seg.ID).Exists {
		t.Fatal("segment was deleted despite the refusal")
	}
	for _, call := range rec.calls {
		if call.action == "segment.delete" {
			t.Fatalf("a refused delete was audited as segment.delete: %+v", call)
		}
	}

	// Move the unsent campaigns elsewhere; the delete now goes through, and the
	// already-dispatched campaigns keep only their history (segment_id NULL).
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`UPDATE campaigns SET segment_id = NULL WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
			tenantID, []string{draft, scheduled, paused})
	})
	resp = serveSegments(t, router, tenantID, http.MethodDelete, "/api/v1/segments/"+seg.ID, nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("DELETE after moving campaigns = %d; body=%s", resp.Code, resp.Body.String())
	}
	if readSegmentRow(t, pool, tenantID, seg.ID).Exists {
		t.Fatal("segment still exists after a successful delete")
	}
	if got := campaignSegmentID(t, pool, tenantID, sent); got != nil {
		t.Fatalf("sent campaign still points at the deleted segment: %v", *got)
	}
	deletes := 0
	for _, call := range rec.calls {
		if call.action == "segment.delete" && call.resourceID == seg.ID {
			deletes++
		}
	}
	if deletes != 1 {
		t.Fatalf("segment.delete audited %d times, want 1", deletes)
	}
}

// The refusal names at most five campaigns but counts all of them.
func TestDeleteSegmentInUseNamesFiveOfMany_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Many " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create segment: %v", err)
	}
	for _, name := range []string{"G", "F", "E", "D", "C", "B", "A"} {
		addCampaign(t, pool, tenantID, seg.ID, "Campaign "+name, "draft", false)
	}
	err = repo.Delete(context.Background(), tenantID, seg.ID)
	var inUse *SegmentInUseError
	if !errors.As(err, &inUse) {
		t.Fatalf("Delete err = %v, want *SegmentInUseError", err)
	}
	if inUse.Total != 7 || len(inUse.Campaigns) != 5 {
		t.Fatalf("refusal total=%d named=%d, want 7 and 5", inUse.Total, len(inUse.Campaigns))
	}
	msg := inUse.Message()
	if !strings.Contains(msg, "7 campaigns that haven't sent yet, including") ||
		!strings.Contains(msg, `"Campaign A", "Campaign B", "Campaign C", "Campaign D" and "Campaign E"`) ||
		strings.Contains(msg, "Campaign F") {
		t.Fatalf("message = %q", msg)
	}
	// Nothing else about the tenant was touched by the refused delete.
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var pointing int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM campaigns WHERE tenant_id = $1::uuid AND segment_id = $2::uuid`,
		tenantID, seg.ID).Scan(&pointing); err != nil {
		t.Fatal(err)
	}
	if pointing != 7 {
		t.Fatalf("%d campaigns still target the segment, want 7", pointing)
	}
}

// The usage list tells the delete confirmation which campaigns will refuse the
// delete, by the trigger's own rule: a paused campaign that already began
// sending does not block it, whatever its status says.
func TestSegmentUsageSaysWhichCampaignsBlockTheDelete_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	tenantID, marker := seedPreviewAggregateFixture(t, pool)
	repo := &Repo{Pool: pool}
	seg, err := repo.Create(context.Background(), tenantID, CreateInput{Name: "Usage " + marker, QueryAST: markerAST(marker)})
	if err != nil {
		t.Fatalf("create segment: %v", err)
	}
	draft := addCampaign(t, pool, tenantID, seg.ID, "Draft launch", "draft", false)
	pausedMidSend := addCampaign(t, pool, tenantID, seg.ID, "Paused mid-send", "paused", true)
	sent := addCampaign(t, pool, tenantID, seg.ID, "Last spring", "sent", true)

	resp := serveSegments(t, segmentsRouter(&Deps{Repo: repo}), tenantID, http.MethodGet, "/api/v1/segments/"+seg.ID+"/usage", nil)
	if resp.Code != http.StatusOK {
		t.Fatalf("usage = %d %s", resp.Code, resp.Body.String())
	}
	var body struct {
		Items []struct {
			ID           string `json:"id"`
			BlocksDelete *bool  `json:"blocks_delete"`
		} `json:"items"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	want := map[string]bool{draft: true, pausedMidSend: false, sent: false}
	if len(body.Items) != len(want) {
		t.Fatalf("usage lists %d items, want %d: %s", len(body.Items), len(want), resp.Body.String())
	}
	for _, item := range body.Items {
		if item.BlocksDelete == nil || *item.BlocksDelete != want[item.ID] {
			t.Fatalf("campaign %s blocks_delete = %v, want %v (%s)", item.ID, item.BlocksDelete, want[item.ID], resp.Body.String())
		}
	}

	// The trigger agrees: with the draft moved away, the delete goes through
	// although the paused campaign still points at the segment.
	withTenantTx(t, pool, tenantID, func(_ context.Context, exec func(string, ...any)) {
		exec(`UPDATE campaigns SET segment_id = NULL WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, draft)
	})
	if err := repo.Delete(context.Background(), tenantID, seg.ID); err != nil {
		t.Fatalf("delete with only started campaigns left: %v", err)
	}
}
