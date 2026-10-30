// SPDX-License-Identifier: AGPL-3.0-only

package notification_feed

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// The feed row must carry what a person can DO about the notification.
//
// Mobile push already put Approve/Reject on a lock screen via its category; the
// feed row had a deep link and nothing else, so the same notification was
// actionable on a phone and merely readable in the bell.

func actionsPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping feed actions test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedActionsTenant(t *testing.T, pool *db.Pool) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	tenantID, userID = uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'act', 'studio')`,
		tenantID, "act-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM notification_feed WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, userID
}

func TestAnApprovalNotificationCarriesItsActions(t *testing.T) {
	pool := actionsPool(t)
	ctx := context.Background()
	tenantID, userID := seedActionsTenant(t, pool)
	repo := &Repo{Pool: pool}

	if _, _, err := repo.NotifyDeduped(ctx, tenantID, userID, NewNotification{
		Kind: "approval", Title: "Approval needed", Body: "Spring Sale", DeepLink: "/app/approvals",
	}, "approval.requested", ""); err != nil {
		t.Fatalf("NotifyDeduped: %v", err)
	}

	page, err := repo.List(ctx, tenantID, userID, ListOptions{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	got := page.Items[0]
	if len(got.Actions) != 2 {
		t.Fatalf("the feed row carries %d actions; an approval is actionable on a "+
			"phone and merely readable here: %+v", len(got.Actions), got.Actions)
	}
	// And they are the SAME actions the shared catalog gives every other
	// surface — not a second list that happens to look similar.
	want := notifications.ActionsForEvent("approval.requested")
	for i := range want {
		if got.Actions[i].ID != want[i].ID || got.Actions[i].Path != want[i].Path {
			t.Errorf("action %d = %+v, want %+v", i, got.Actions[i], want[i])
		}
	}
}

// An event with nothing to do returns an empty list, not null: a client must
// not have to handle two shapes of "no actions".
func TestANotificationWithNoActionsReturnsAnEmptyList(t *testing.T) {
	pool := actionsPool(t)
	ctx := context.Background()
	tenantID, userID := seedActionsTenant(t, pool)
	repo := &Repo{Pool: pool}

	if _, _, err := repo.NotifyDeduped(ctx, tenantID, userID, NewNotification{
		Kind: "bounce", Title: "High bounce rate", DeepLink: "/app/deliverability",
	}, "subscriber.bounced", ""); err != nil {
		t.Fatalf("NotifyDeduped: %v", err)
	}
	page, err := repo.List(ctx, tenantID, userID, ListOptions{Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(page.Items))
	}
	if page.Items[0].Actions == nil {
		t.Fatal("actions is nil, which serialises as null; clients would need a " +
			"second branch for a case that is just 'none'")
	}
	if len(page.Items[0].Actions) != 0 {
		t.Fatalf("got %+v, want no actions", page.Items[0].Actions)
	}
}

// The actions are stored, not resolved at read time. An approval that has since
// been decided must not retroactively grow or lose buttons in somebody's
// history, and editing the catalog must not rewrite what a person was shown.
func TestActionsAreStoredOnTheRowNotDerivedOnRead(t *testing.T) {
	pool := actionsPool(t)
	ctx := context.Background()
	tenantID, userID := seedActionsTenant(t, pool)
	repo := &Repo{Pool: pool}

	if _, _, err := repo.NotifyDeduped(ctx, tenantID, userID, NewNotification{
		Kind: "approval", Title: "Approval needed",
	}, "approval.requested", ""); err != nil {
		t.Fatalf("NotifyDeduped: %v", err)
	}
	// Read the column directly: if the read path were deriving from event_type,
	// the stored value would be empty and this would catch it.
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var stored string
	if err := tx.QueryRow(ctx,
		`SELECT actions::text FROM notification_feed WHERE tenant_id = $1::uuid`,
		tenantID).Scan(&stored); err != nil {
		t.Fatalf("read actions column: %v", err)
	}
	if stored == "[]" || stored == "" {
		t.Fatalf("actions column = %q; the row does not record what it offered, so "+
			"a catalog change would rewrite somebody's history", stored)
	}
}
