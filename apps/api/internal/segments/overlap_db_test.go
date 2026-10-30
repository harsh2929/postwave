// SPDX-License-Identifier: AGPL-3.0-only
//
// overlap_db_test.go — pg-backed tests for segment overlap counting
// and the snapshot → growth pipeline. Skips cleanly without
// DATABASE_URL, matching the project-wide pg-backed test convention.

package segments

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newSegmentsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed segments test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedSegmentsTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	// A TENANT transaction, not worker scope.
	//
	// `tenant_isolation_insert` requires id = current_setting('app.tenant_id'),
	// and worker scope sets no tenant GUC — so `id = NULL`, every seed was
	// rejected, and the Skipf below reported it as a PASS. The message blamed
	// the role ("lacks tenants INSERT"); the role is fine, the scope was wrong.
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
VALUES ($1::uuid, 'segments-overlap-test', 'segments-overlap-test', 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedOverlapSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')`, tenantID, email); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
}

func containsAST(substr string) string {
	return fmt.Sprintf(
		`{"op":"condition","field":"email","comparator":"contains","value":%q}`, substr)
}

// TestSegmentOverlapAndGrowth_DB seeds three subscribers split across
// two contains-segments and pins:
//  1. /segments/overlap counts (2, 2, 1) with jaccard 1/3;
//  2. SnapshotWorker.snapshotOne writes today's history row;
//  3. /segments/{id}/growth returns that point.
func TestSegmentOverlapAndGrowth_DB(t *testing.T) {
	pool := newSegmentsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-005e63e2ab1e"
	seedSegmentsTenant(t, pool, tenantID)

	sfx := time.Now().UnixNano()
	aKey := fmt.Sprintf("seg-a-%d", sfx)
	bKey := fmt.Sprintf("seg-b-%d", sfx)
	seedOverlapSubscriber(t, pool, tenantID, fmt.Sprintf("%s-only@example.test", aKey))
	seedOverlapSubscriber(t, pool, tenantID, fmt.Sprintf("%s-only@example.test", bKey))
	seedOverlapSubscriber(t, pool, tenantID, fmt.Sprintf("%s-%s-both@example.test", aKey, bKey))

	repo := &Repo{Pool: pool}
	d := &Deps{Repo: repo}
	segA, err := repo.Create(ctx, tenantID, CreateInput{
		Name: aKey, QueryAST: json.RawMessage(containsAST(aKey))})
	if err != nil {
		t.Fatalf("create segment a: %v", err)
	}
	segB, err := repo.Create(ctx, tenantID, CreateInput{
		Name: bKey, QueryAST: json.RawMessage(containsAST(bKey))})
	if err != nil {
		t.Fatalf("create segment b: %v", err)
	}

	// 1. Overlap.
	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/segments/overlap?a="+segA.ID+"&b="+segB.ID, nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	d.SegmentOverlap(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("overlap status = %d body=%s", rec.Code, rec.Body.String())
	}
	var overlap OverlapResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &overlap); err != nil {
		t.Fatalf("decode overlap: %v", err)
	}
	if overlap.ACount != 2 || overlap.BCount != 2 || overlap.Intersection != 1 {
		t.Fatalf("overlap = %+v, want a=2 b=2 inter=1", overlap)
	}
	if want := 1.0 / 3.0; overlap.Jaccard != want {
		t.Fatalf("jaccard = %v, want %v", overlap.Jaccard, want)
	}

	// 2. Snapshot today's counts through the worker's own tenant pass.
	w := &SnapshotWorker{Pool: pool, Repo: repo}
	if err := w.snapshotTenant(ctx, tenantID); err != nil {
		t.Fatalf("snapshotTenant: %v", err)
	}

	// 3. Growth series surfaces the snapshot.
	greq := httptest.NewRequest(http.MethodGet,
		"/api/v1/segments/"+segA.ID+"/growth?days=30", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", segA.ID)
	greq = greq.WithContext(context.WithValue(
		middleware.WithTenant(greq.Context(), &middleware.Tenant{ID: tenantID}),
		chi.RouteCtxKey, rctx))
	grec := httptest.NewRecorder()
	d.SegmentGrowth(grec, greq)
	if grec.Code != http.StatusOK {
		t.Fatalf("growth status = %d body=%s", grec.Code, grec.Body.String())
	}
	var growth GrowthResponse
	if err := json.Unmarshal(grec.Body.Bytes(), &growth); err != nil {
		t.Fatalf("decode growth: %v", err)
	}
	if len(growth.Series) != 1 || growth.Series[0].Count != 2 {
		t.Fatalf("growth series = %+v, want one point with count 2", growth.Series)
	}
}
