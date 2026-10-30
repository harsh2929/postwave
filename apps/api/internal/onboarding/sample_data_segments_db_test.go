// SPDX-License-Identifier: AGPL-3.0-only
//
// sample_data_segments_db_test.go — removing sample data while the operator's
// own draft campaign targets the sample segment ("Use in a campaign").
//
// Migration 1876 refuses that segment's delete; Remove used to abort on it and
// answer 500, leaving every sample row in place.

package onboarding

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func TestRemoveSampleDataKeepsASegmentAUnsentCampaignUses_DB(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := seedOnboardingTenant(t, ctx, pool)
	seeder := NewSeeder(pool)
	if _, err := seeder.Seed(ctx, tenantID); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	// The operator turns the sample segment into a real draft campaign.
	var sampleSegmentID, sampleSegmentName string
	campaignID := uuid.NewString()
	{
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT id::text, name FROM segments WHERE tenant_id = $1::uuid AND description LIKE $2`,
			tenantID, sampleSegmentDescPrefix+"%").Scan(&sampleSegmentID, &sampleSegmentName); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("find sample segment: %v", err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, segment_id, status)
VALUES ($1::uuid, $2::uuid, 'Campaign for the sample audience', 'Hello', $3::uuid, 'draft')`,
			campaignID, tenantID, sampleSegmentID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("create draft campaign: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	deps := &Deps{Seeder: seeder}
	remove := func() (int, RemoveResult) {
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/onboarding/sample-data", nil)
		req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
		rec := httptest.NewRecorder()
		deps.Remove(rec, req)
		var out RemoveResult
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatalf("decode: %v; body=%s", err, rec.Body.String())
			}
		} else {
			t.Logf("remove body: %s", rec.Body.String())
		}
		return rec.Code, out
	}

	code, res := remove()
	if code != http.StatusOK {
		t.Fatalf("Remove = %d, want 200", code)
	}
	if res.Counts.Subscribers == 0 || res.Counts.Segments != 0 {
		t.Fatalf("counts = %+v, want sample subscribers removed and the used segment kept", res.Counts)
	}
	if len(res.KeptSegments) != 1 || res.KeptSegments[0].ID != sampleSegmentID ||
		res.KeptSegments[0].Name != sampleSegmentName ||
		len(res.KeptSegments[0].Campaigns) != 1 || res.KeptSegments[0].Campaigns[0] != "Campaign for the sample audience" {
		t.Fatalf("kept = %+v, want the sample segment held by the draft campaign", res.KeptSegments)
	}
	if status, err := seeder.Status(ctx, tenantID); err != nil || !status.Seeded {
		t.Fatalf("Status after a partial removal = %+v (err %v); sample data is still present", status, err)
	}

	// Once the campaign is gone, removing again finishes the job.
	{
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `DELETE FROM campaigns WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	code, res = remove()
	if code != http.StatusOK || res.Counts.Segments != 1 || len(res.KeptSegments) != 0 {
		t.Fatalf("second Remove = %d %+v, want the segment deleted and nothing kept", code, res)
	}
	if status, err := seeder.Status(ctx, tenantID); err != nil || status.Seeded {
		t.Fatalf("Status after complete removal = %+v (err %v)", status, err)
	}
}
