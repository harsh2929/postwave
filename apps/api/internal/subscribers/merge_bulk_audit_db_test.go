// SPDX-License-Identifier: AGPL-3.0-only
//
// merge_bulk_audit_db_test.go — pg-backed test for SUB-020: the bulk-merge
// handler writes one audit row per successful pair, and that row carries the
// signals_recorded signal breakdown (matching the single-merge audit shape).
// Skips cleanly without DATABASE_URL, matching the project-wide pg-backed
// test convention.

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func newBulkAuditTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed bulk-merge audit test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedBulkAuditTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
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
VALUES ($1::uuid, 'bulk-audit-test', 'bulk-audit-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func seedBulkAuditSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

// TestBulkMerge_AuditCarriesSignalsRecorded pins SUB-020: a successful bulk
// merge writes a subscriber.merged audit row whose metadata carries the
// signals_recorded key (the signal breakdown), matching the single-merge
// audit shape, alongside the bulk marker.
func TestBulkMerge_AuditCarriesSignalsRecorded(t *testing.T) {
	pool := newBulkAuditTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41200"
	seedBulkAuditTenant(t, pool, tenantID)

	suffix := time.Now().UnixNano()
	primaryEmail := fmt.Sprintf("bulk-primary-%d@example.test", suffix)
	dupeEmail := fmt.Sprintf("bulk-dupe-%d@example.test", suffix)
	primaryID := seedBulkAuditSubscriber(t, pool, tenantID, primaryEmail)
	dupeID := seedBulkAuditSubscriber(t, pool, tenantID, dupeEmail)

	d := &Deps{Repo: &Repo{Pool: pool}}
	primary, err := d.Repo.Get(ctx, tenantID, primaryID)
	if err != nil {
		t.Fatalf("load primary revision: %v", err)
	}
	duplicate, err := d.Repo.Get(ctx, tenantID, dupeID)
	if err != nil {
		t.Fatalf("load duplicate revision: %v", err)
	}
	body := fmt.Sprintf(`{"pairs":[{"primary_id":%q,"duplicate_id":%q,"primary_version":%q,"duplicate_version":%q}]}`,
		primaryID, dupeID, primary.Version, duplicate.Version)
	r := httptest.NewRequest("POST", "/api/v1/subscribers/merge/bulk", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: tenantID}))
	w := httptest.NewRecorder()
	d.BulkMergeHandler(w, r)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var out BulkMergeResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.Merged != 1 || out.Failed != 0 {
		t.Fatalf("merged=%d failed=%d, want 1/0 (body=%s)", out.Merged, out.Failed, w.Body.String())
	}

	// Read back the audit row and assert the signal breakdown is present and
	// equals the merge result's SignalsRecorded count, alongside bulk=true.
	atx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("audit read tx: %v", err)
	}
	defer func() { _ = atx.Rollback(ctx) }()
	var metaRaw []byte
	if err := atx.QueryRow(ctx, `
SELECT metadata
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action = 'subscriber.merged'
   AND resource_id = $2
 ORDER BY created_at DESC
 LIMIT 1`, tenantID, primaryID).Scan(&metaRaw); err != nil {
		t.Fatalf("read audit_log: %v", err)
	}
	var meta map[string]any
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("decode audit metadata: %v", err)
	}
	if _, ok := meta["signals_recorded"]; !ok {
		t.Fatalf("bulk audit metadata missing signals_recorded: %v", meta)
	}
	if meta["bulk"] != true {
		t.Fatalf("bulk audit metadata bulk = %v, want true", meta["bulk"])
	}
	// JSON numbers decode to float64; cross-check against the response.
	if got, want := meta["signals_recorded"].(float64), float64(out.Items[0].Result.SignalsRecorded); got != want {
		t.Fatalf("signals_recorded = %v, want %v", got, want)
	}
}
