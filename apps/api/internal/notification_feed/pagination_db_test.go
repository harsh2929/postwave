// SPDX-License-Identifier: AGPL-3.0-only

package notification_feed

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestListPagesTheWholeFeed walks the feed with a page size well below the row
// count and asserts the three properties the mobile inbox needs: every row is
// visited exactly once, the walk terminates, and the unread filter composes
// with the cursor rather than resetting it.
func TestListPagesTheWholeFeed(t *testing.T) {
	pool := feedTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	otherUserID := uuid.NewString()
	const total = 17
	const unreadCount = 6
	insertFeedFixture(t, pool, tenantID, userID, otherUserID, total, unreadCount)
	defer deleteFeedFixture(t, pool, tenantID)

	repo := &Repo{Pool: pool}

	seen := map[string]int{}
	order := []time.Time{}
	cursor := ""
	pages := 0
	for {
		page, err := repo.List(ctx, tenantID, userID, ListOptions{Limit: 5, Cursor: cursor})
		if err != nil {
			t.Fatalf("List page %d: %v", pages, err)
		}
		pages++
		if pages > 10 {
			t.Fatal("pagination did not terminate within 10 pages")
		}
		if page.UnreadCount != unreadCount {
			t.Fatalf("unread_count on page %d = %d, want %d", pages, page.UnreadCount, unreadCount)
		}
		for _, item := range page.Items {
			seen[item.ID]++
			order = append(order, item.CreatedAt)
		}
		if page.NextCursor == "" {
			if len(page.Items) > 5 {
				t.Fatalf("last page returned %d items, want <= 5", len(page.Items))
			}
			break
		}
		if len(page.Items) != 5 {
			t.Fatalf("page %d returned %d items with a next_cursor, want a full page of 5", pages, len(page.Items))
		}
		cursor = page.NextCursor
	}
	if len(seen) != total {
		t.Fatalf("paged over %d distinct notifications, want %d", len(seen), total)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("notification %s was returned %d times across pages", id, count)
		}
	}
	for i := 1; i < len(order); i++ {
		if order[i].After(order[i-1]) {
			t.Fatalf("feed is not newest-first at index %d: %s came after %s", i, order[i], order[i-1])
		}
	}
	if pages < 4 {
		t.Fatalf("walked %d pages for %d rows at page size 5; pagination is not actually paging", pages, total)
	}

	// unread=true + cursor must compose: the same walk over the unread subset.
	unreadSeen := map[string]int{}
	cursor = ""
	for {
		page, err := repo.List(ctx, tenantID, userID, ListOptions{UnreadOnly: true, Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatalf("unread List: %v", err)
		}
		for _, item := range page.Items {
			if item.ReadAt != nil {
				t.Fatalf("unread page returned a read notification %s", item.ID)
			}
			unreadSeen[item.ID]++
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	if len(unreadSeen) != unreadCount {
		t.Fatalf("unread walk saw %d rows, want %d", len(unreadSeen), unreadCount)
	}
}

// TestListClampsLimitToTheCeiling pins the behaviour NATIVE#33 called out: an
// over-large limit must clamp to the ceiling, not silently collapse to 50.
func TestListClampsLimitToTheCeiling(t *testing.T) {
	pool := feedTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	insertFeedFixture(t, pool, tenantID, userID, uuid.NewString(), 60, 0)
	defer deleteFeedFixture(t, pool, tenantID)

	repo := &Repo{Pool: pool}
	page, err := repo.List(ctx, tenantID, userID, ListOptions{Limit: 100000})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 60 {
		t.Fatalf("limit=100000 returned %d of 60 rows; a clamped limit must not fall back to the 50 default", len(page.Items))
	}
	if page.NextCursor != "" {
		t.Fatalf("next_cursor = %q on an exhausted feed, want empty", page.NextCursor)
	}
}

// TestListCursorIsTenantScoped proves the cursor cannot be used to read across
// the tenant boundary: RLS still applies, and a cursor minted in one tenant is
// simply a position, not a capability.
func TestListCursorIsTenantScoped(t *testing.T) {
	pool := feedTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantA := uuid.NewString()
	userA := uuid.NewString()
	tenantB := uuid.NewString()
	userB := uuid.NewString()
	insertFeedFixture(t, pool, tenantA, userA, uuid.NewString(), 6, 0)
	defer deleteFeedFixture(t, pool, tenantA)
	insertFeedFixture(t, pool, tenantB, userB, uuid.NewString(), 6, 0)
	defer deleteFeedFixture(t, pool, tenantB)

	repo := &Repo{Pool: pool}
	first, err := repo.List(ctx, tenantA, userA, ListOptions{Limit: 2})
	if err != nil {
		t.Fatalf("tenant A page: %v", err)
	}
	if first.NextCursor == "" {
		t.Fatal("expected a next_cursor for tenant A")
	}
	crossed, err := repo.List(ctx, tenantB, userB, ListOptions{Limit: 50, Cursor: first.NextCursor})
	if err != nil {
		t.Fatalf("tenant B page with tenant A cursor: %v", err)
	}
	for _, item := range crossed.Items {
		for _, own := range first.Items {
			if item.ID == own.ID {
				t.Fatalf("tenant B read tenant A notification %s", item.ID)
			}
		}
	}
}

func feedTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed notification feed pagination test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	var present bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'notification_feed'
       AND column_name = 'event_type'
)`).Scan(&present); err != nil || !present {
		pool.Close()
		t.Fatalf("migration 1776_notification_identity is required before notification feed DB tests (present=%v err=%v)", present, err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// insertFeedFixture seeds `total` notifications for userID (the newest
// `unread` of them left unread) plus one row for otherUserID that must never
// appear in userID's feed.
func insertFeedFixture(t *testing.T, pool *pgxpool.Pool, tenantID, userID, otherUserID string, total, unread int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Feed pagination test', 'studio')`,
		tenantID, "feed-test-"+tenantID); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	for _, u := range []string{userID, otherUserID} {
		if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`,
			u, tenantID, "feed-user-"+u, u+"@example.test"); err != nil {
			t.Fatalf("insert user: %v", err)
		}
	}
	for i := 0; i < total; i++ {
		// created_at descends with i so index 0 is the newest row; several rows
		// deliberately share a timestamp so the id tiebreak in the keyset is
		// exercised rather than assumed.
		readAt := "now()"
		if i < unread {
			readAt = "NULL"
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, payload, event_type, created_at, read_at)
VALUES ($1::uuid, $2::uuid, 'campaign.sent', $3, '', '/app', '{}'::jsonb, 'campaign.sent',
        now() - make_interval(secs => $4::int), `+readAt+`)`,
			tenantID, userID, "notification", i/3); err != nil {
			t.Fatalf("insert notification %d: %v", i, err)
		}
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, payload, event_type)
VALUES ($1::uuid, $2::uuid, 'campaign.sent', 'other user', '', '/app', '{}'::jsonb, 'campaign.sent')`,
		tenantID, otherUserID); err != nil {
		t.Fatalf("insert other-user notification: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
}

func deleteFeedFixture(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID)
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	_ = tx.Commit(ctx)
}
