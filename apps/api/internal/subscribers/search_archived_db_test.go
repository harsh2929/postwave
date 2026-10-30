// SPDX-License-Identifier: AGPL-3.0-only
//
// search_archived_db_test.go — pg-backed test for SUB-009: the /search
// path honours include_archived the same way ListWithOptions does.
// Skips cleanly without DATABASE_URL, matching the project-wide
// pg-backed test convention (merge/apply_db_test.go).

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

func newSearchTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed search test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedSearchTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
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
VALUES ($1::uuid, 'search-archived-test', 'search-archived-test-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed tenant: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// seedSearchSubscriber inserts a subscriber; when archived is true the row
// is created already soft-deleted (archived_at = now()).
func seedSearchSubscriber(t *testing.T, pool *pgxpool.Pool, tenantID, email string, archived bool) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	archivedExpr := "NULL"
	if archived {
		archivedExpr = "now()"
	}
	if err := tx.QueryRow(ctx, fmt.Sprintf(`
INSERT INTO subscribers (tenant_id, email, status, consent_source, archived_at)
VALUES ($1::uuid, $2, 'enabled', 'api', %s)
RETURNING id::text`, archivedExpr), tenantID, email).Scan(&id); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

// TestSearch_IncludeArchived pins SUB-009 on the /search path: with the
// default (includeArchived=false) an archived row is hidden; flipping the
// flag surfaces it, while the active row is always visible.
func TestSearch_IncludeArchived(t *testing.T) {
	pool := newSearchTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c4109d"
	seedSearchTenant(t, pool, tenantID)

	r := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	// A shared, unique token so the ILIKE query targets exactly these two
	// rows regardless of other data in the test DB.
	token := fmt.Sprintf("sub009arch%d", suffix)
	activeEmail := fmt.Sprintf("%s-active@example.test", token)
	archivedEmail := fmt.Sprintf("%s-archived@example.test", token)
	activeID := seedSearchSubscriber(t, pool, tenantID, activeEmail, false)
	archivedID := seedSearchSubscriber(t, pool, tenantID, archivedEmail, true)

	has := func(p *Page, id string) bool {
		for _, s := range p.Items {
			if s.ID == id {
				return true
			}
		}
		return false
	}

	// Default: archived row hidden, active row visible.
	def, err := r.Search(ctx, tenantID, token, 1, 50, false)
	if err != nil {
		t.Fatalf("search default: %v", err)
	}
	if !has(def, activeID) {
		t.Fatalf("default search must return the active row %s; got %d items", activeID, len(def.Items))
	}
	if has(def, archivedID) {
		t.Fatalf("default search must hide the archived row %s", archivedID)
	}

	// include_archived=true: archived row now surfaces alongside the active one.
	inc, err := r.Search(ctx, tenantID, token, 1, 50, true)
	if err != nil {
		t.Fatalf("search include_archived: %v", err)
	}
	if !has(inc, activeID) {
		t.Fatalf("include_archived search must still return the active row %s", activeID)
	}
	if !has(inc, archivedID) {
		t.Fatalf("include_archived search must return the archived row %s", archivedID)
	}
}
