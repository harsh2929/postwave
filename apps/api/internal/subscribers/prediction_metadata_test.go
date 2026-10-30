// SPDX-License-Identifier: AGPL-3.0-only
//
// prediction_metadata_test.go — SUB-010: predictive-score versioning +
// explainability metadata (migration 0900). Pure-function validation of the
// score-type taxonomy plus a pg-backed round-trip that an upserted metadata
// snapshot survives GetPredictionMetadata and hydrates onto the detail GET
// (prediction_model_version + prediction_confidence). Skips cleanly without
// DATABASE_URL, matching the package convention.

package subscribers

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestValidPredictionScoreType pins the score-type allow-list to the
// migration-0900 CHECK constraint.
func TestValidPredictionScoreType(t *testing.T) {
	for _, v := range []string{PredictionScoreChurn, PredictionScoreEngagement} {
		if !ValidPredictionScoreType(v) {
			t.Errorf("ValidPredictionScoreType(%q) = false; want true", v)
		}
	}
	for _, v := range []string{"", "clv", "CHURN", "engagment", "ai"} {
		if ValidPredictionScoreType(v) {
			t.Errorf("ValidPredictionScoreType(%q) = true; want false", v)
		}
	}
}

func newPredictionMetaTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed prediction_metadata test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedPredictionMetaTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)`,
		tenantID).Scan(&exists); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read tenants: %v", err)
	}
	if !exists {
		if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'prediction-meta-test', 'prediction-meta-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// TestPredictionMetadata_RoundTrips pins SUB-010 end-to-end:
//  1. UpsertPredictionMetadata writes a churn snapshot (model_version +
//     confidence + features) and the list view reflects it.
//  2. A second upsert for the same score_type replaces in place (one current
//     row per (subscriber, score_type)), not a second row.
//  3. An engagement snapshot coexists as a separate item.
//  4. hydratePredictionLineage stamps the CHURN model_version + confidence
//     onto the subscriber (churn wins over engagement).
func TestPredictionMetadata_RoundTrips(t *testing.T) {
	pool := newPredictionMetaTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41010"
	seedPredictionMetaTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	email := fmt.Sprintf("pred-%d@example.test", time.Now().UnixNano())
	created, err := r.Upsert(ctx, tenantID, CreateInput{
		Email: email,
	})
	if err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	conf := 0.82
	churnV := "churn-xgb-v2"
	list, err := r.UpsertPredictionMetadata(ctx, tenantID, created.ID, UpsertPredictionMetadataInput{
		ScoreType:    PredictionScoreChurn,
		ModelVersion: &churnV,
		Confidence:   &conf,
		Features:     map[string]any{"recency_days": 3.0, "top_feature": "open_rate"},
	})
	if err != nil {
		t.Fatalf("UpsertPredictionMetadata churn: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("after first upsert items = %d; want 1", len(list.Items))
	}
	if list.Items[0].ModelVersion != churnV {
		t.Errorf("model_version = %q; want %q", list.Items[0].ModelVersion, churnV)
	}
	if list.Items[0].Confidence == nil || *list.Items[0].Confidence != conf {
		t.Errorf("confidence = %v; want %v", list.Items[0].Confidence, conf)
	}
	if list.Items[0].Features["top_feature"] != "open_rate" {
		t.Errorf("features snapshot lost: %#v", list.Items[0].Features)
	}

	// Re-upsert same score_type → replace in place, no second row.
	churnV2 := "churn-xgb-v3"
	list, err = r.UpsertPredictionMetadata(ctx, tenantID, created.ID, UpsertPredictionMetadataInput{
		ScoreType:    PredictionScoreChurn,
		ModelVersion: &churnV2,
	})
	if err != nil {
		t.Fatalf("UpsertPredictionMetadata churn re-upsert: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("after re-upsert items = %d; want 1 (replace in place)", len(list.Items))
	}
	if list.Items[0].ModelVersion != churnV2 {
		t.Errorf("re-upsert model_version = %q; want %q", list.Items[0].ModelVersion, churnV2)
	}
	// Features omitted on re-upsert → existing snapshot preserved.
	if list.Items[0].Features["top_feature"] != "open_rate" {
		t.Errorf("re-upsert wiped features: %#v", list.Items[0].Features)
	}

	// Engagement snapshot coexists.
	engV := "heuristic-v1"
	engConf := 0.5
	list, err = r.UpsertPredictionMetadata(ctx, tenantID, created.ID, UpsertPredictionMetadataInput{
		ScoreType:    PredictionScoreEngagement,
		ModelVersion: &engV,
		Confidence:   &engConf,
	})
	if err != nil {
		t.Fatalf("UpsertPredictionMetadata engagement: %v", err)
	}
	if len(list.Items) != 2 {
		t.Fatalf("after engagement upsert items = %d; want 2", len(list.Items))
	}

	// Lineage hydration: churn wins.
	sub := &Subscriber{ID: created.ID}
	if err := r.hydratePredictionLineage(ctx, tenantID, created.ID, sub); err != nil {
		t.Fatalf("hydratePredictionLineage: %v", err)
	}
	if sub.PredictionModelVersion == nil || *sub.PredictionModelVersion != churnV2 {
		t.Errorf("hydrated model_version = %v; want %q (churn wins)", sub.PredictionModelVersion, churnV2)
	}
	if sub.PredictionConfidence == nil || *sub.PredictionConfidence != conf {
		t.Errorf("hydrated confidence = %v; want %v", sub.PredictionConfidence, conf)
	}
}

// TestUpsertPredictionMetadata_Validation pins the input guards: a bad
// score_type and an out-of-range confidence are rejected with ErrInvalidInput
// (404 surfaces first only when the subscriber is missing). Pure validation
// path runs without a DB because the guards fire before the tenant tx.
func TestUpsertPredictionMetadata_Validation(t *testing.T) {
	r := &Repo{Pool: nil}
	ctx := context.Background()

	bad := "clv"
	mv := "x"
	if _, err := r.UpsertPredictionMetadata(ctx, "t", "s", UpsertPredictionMetadataInput{
		ScoreType: bad, ModelVersion: &mv,
	}); err == nil {
		t.Fatalf("invalid score_type accepted; want ErrInvalidInput")
	}

	over := 1.5
	if _, err := r.UpsertPredictionMetadata(ctx, "t", "s", UpsertPredictionMetadataInput{
		ScoreType: PredictionScoreChurn, Confidence: &over,
	}); err == nil {
		t.Fatalf("out-of-range confidence accepted; want ErrInvalidInput")
	}
}
