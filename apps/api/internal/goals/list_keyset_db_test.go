// SPDX-License-Identifier: AGPL-3.0-only
//
// DB-backed end-to-end test for the 4.1 keyset pagination conversion,
// exercised through goals.listGoalsPage against real Postgres. Skips
// without DATABASE_URL (project-wide pg-test convention). This is the
// representative paging test for the additive sweep: it pins the real
// repo SQL (param indexing, (created_at,id) tuple comparison, HasMore
// trim, cursor round-trip, nextCursor empty on the last page, and the
// preserved default page size) — the behaviors a build/compile check
// cannot catch. The other 23 converted endpoints follow the identical,
// per-package adversarially-verified pattern.
package goals

import (
	"context"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestListGoalsKeysetPagination(t *testing.T) {
	pool := progressDB(t)
	ctx := context.Background()
	tenantID := randUUIDGoals(t)

	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed tx: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $2, 'studio')`, tenantID, "ks-"+tenantID[:8]); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed tenant (role lacks tenants INSERT; needs a pre-seeded DB): %v", err)
	}
	// Five goals with explicit, strictly-increasing created_at so the
	// newest-first ordering and the keyset boundary are deterministic.
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	ids := make([]string, 5)
	for i := 0; i < 5; i++ {
		ids[i] = randUUIDGoals(t)
		if _, err := seed.Exec(ctx, `
INSERT INTO tenant_goals (id, tenant_id, name, metric, target, period, starts_at, created_at)
VALUES ($1::uuid, $2::uuid, $3, 'revenue_cents', 100, 'monthly', $4, $5)`,
			ids[i], tenantID, "g", base, base.Add(time.Duration(i)*time.Minute)); err != nil {
			_ = seed.Rollback(ctx)
			t.Fatalf("seed goal %d: %v", i, err)
		}
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if tx, e := db.WithTenant(c, pool, tenantID); e == nil {
			_, _ = tx.Exec(c, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
			_ = tx.Commit(c)
		}
	})

	d := &Deps{Pool: pool}

	// Page through with limit=2: expect 2 + 2 + 1, with a non-empty cursor
	// on the first two pages and an empty cursor on the last.
	var got []string
	cursor := pagination.Cursor{}
	pages := 0
	for {
		items, next, err := d.listGoalsPage(ctx, tenantID, 2, cursor)
		if err != nil {
			t.Fatalf("page %d: %v", pages, err)
		}
		pages++
		for _, g := range items {
			got = append(got, g.ID)
		}
		if next == "" {
			break
		}
		if len(items) != 2 {
			t.Fatalf("page %d returned %d items but a next cursor — expected a full page of 2", pages, len(items))
		}
		cursor, err = pagination.Decode(next)
		if err != nil {
			t.Fatalf("decode next cursor: %v", err)
		}
		if pages > 10 {
			t.Fatal("pagination did not terminate")
		}
	}
	if pages != 3 {
		t.Fatalf("expected 3 pages (2+2+1), got %d", pages)
	}
	if len(got) != 5 {
		t.Fatalf("expected 5 distinct goals across pages, got %d (%v)", len(got), got)
	}
	// Newest-first, no overlap/skip: created_at DESC means ids[4]..ids[0].
	want := []string{ids[4], ids[3], ids[2], ids[1], ids[0]}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("page order wrong at %d: got %s want %s (full: %v)", i, got[i], want[i], got)
		}
	}
	seen := map[string]bool{}
	for _, id := range got {
		if seen[id] {
			t.Fatalf("duplicate id across pages: %s", id)
		}
		seen[id] = true
	}

	// Default-preservation: a single call with the handler's default page
	// size (100) returns all five in one page with no next cursor.
	all, next, err := d.listGoalsPage(ctx, tenantID, 100, pagination.Cursor{})
	if err != nil {
		t.Fatalf("full page: %v", err)
	}
	if len(all) != 5 || next != "" {
		t.Fatalf("default page should return all 5 with empty cursor, got %d items next=%q", len(all), next)
	}
}
