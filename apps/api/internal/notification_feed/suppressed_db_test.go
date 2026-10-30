// SPDX-License-Identifier: AGPL-3.0-only
package notification_feed

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SETC-037: a suppressed notification_feed row is a DEDUP/IDENTITY anchor only —
// it must be hidden from the bell (List) and the unread count, yet still block a
// replay of the same dedupe_key (so a webhook-only notification whose user has
// the in-app channel off never appears in the bell and never double-fires).
func TestNotifyDeduped_SuppressedRowHiddenButStillDedups_DB(t *testing.T) {
	pool := feedTestPool(t)
	ctx := context.Background()

	tenantID := "00000000-0000-4000-8000-00b0f6600001"
	userID := "00000000-0000-4000-8000-00b0f660000a"
	seedFeedTenantUser(t, pool, tenantID, userID)
	t.Cleanup(func() { deleteFeedFixture(t, pool, tenantID) })

	repo := &Repo{Pool: pool}

	// A normal (visible) notification.
	if _, created, err := repo.NotifyDeduped(ctx, tenantID, userID,
		NewNotification{Kind: "campaign.sent", Title: "visible", DeepLink: "/app"},
		"campaign.sent", "vis:1"); err != nil || !created {
		t.Fatalf("visible notify: created=%v err=%v", created, err)
	}
	// A suppressed notification (in-app off, webhook on).
	if _, created, err := repo.NotifyDeduped(ctx, tenantID, userID,
		NewNotification{Kind: "subscriber.bounced", Title: "hidden", DeepLink: "/app", Suppressed: true},
		"subscriber.bounced", "sup:1"); err != nil || !created {
		t.Fatalf("suppressed notify: created=%v err=%v", created, err)
	}

	// The bell shows ONLY the visible row, and the unread count is 1.
	page, err := repo.List(ctx, tenantID, userID, ListOptions{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 1 || page.Items[0].Title != "visible" {
		t.Fatalf("List must return only the visible row, got %+v", page.Items)
	}
	if page.UnreadCount != 1 {
		t.Fatalf("unread count must exclude the suppressed row, got %d", page.UnreadCount)
	}

	// The suppressed row still anchors dedup: replaying its key is a dedup hit
	// (created=false), and it still does not surface in the bell.
	_, created, err := repo.NotifyDeduped(ctx, tenantID, userID,
		NewNotification{Kind: "subscriber.bounced", Title: "hidden-replay", DeepLink: "/app", Suppressed: true},
		"subscriber.bounced", "sup:1")
	if err != nil {
		t.Fatalf("suppressed replay: %v", err)
	}
	if created {
		t.Fatalf("suppressed row must still dedup a replay (created must be false)")
	}
	page2, err := repo.List(ctx, tenantID, userID, ListOptions{})
	if err != nil {
		t.Fatalf("List after replay: %v", err)
	}
	if len(page2.Items) != 1 {
		t.Fatalf("a suppressed replay must not surface in the bell, got %d items", len(page2.Items))
	}
}

func seedFeedTenantUser(t *testing.T, pool *pgxpool.Pool, tenantID, userID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope seed: %v", err)
	}
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Feed suppressed test', 'studio')`,
		tenantID, "feed-sup-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant (needs pre-seeded DB): %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`,
		userID, tenantID, "feed-sup-user-"+userID[:8], userID+"@example.test"); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
}
