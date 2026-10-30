package contact_ratings

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newHistoryTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping contact-history pagination proof")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestListHistoryCursorDoesNotSkipEqualTimestamps_DB(t *testing.T) {
	pool := newHistoryTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	subscriberID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'history-page-test', 'history-page-' || $1::text, 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $1::text || '@example.test', 'unconfirmed', 'unknown')`, subscriberID, tenantID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	sameAt := time.Date(2026, 7, 19, 10, 11, 12, 123456000, time.UTC)
	olderAt := sameAt.Add(-time.Second)
	ids := []string{
		"0199a4b5-8b67-7f10-9f11-000000000003",
		"0199a4b5-8b67-7f10-9f11-000000000002",
		"0199a4b5-8b67-7f10-9f11-000000000001",
		"0199a4b5-8b67-7f10-9f10-000000000999",
	}
	for index, id := range ids {
		at := sameAt
		if index == len(ids)-1 {
			at = olderAt
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO contact_history_events
       (id, tenant_id, subscriber_id, kind, at, payload)
VALUES ($1::uuid, $2::uuid, $3::uuid, 'rating.changed', $4, '{"rating": 4}')`,
			id, tenantID, subscriberID, at); err != nil {
			t.Fatalf("seed history %d: %v", index, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	t.Cleanup(func() {
		cleanup, cleanupErr := db.WithTenant(context.Background(), pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanup.Commit(context.Background())
	})

	repo := &Repo{Pool: pool}
	first, err := repo.ListHistory(ctx, tenantID, subscriberID, nil, nil, 2)
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(first) != 2 || first[0].ID != ids[0] || first[1].ID != ids[1] {
		t.Fatalf("first page ids = %+v, want %s then %s", first, ids[0], ids[1])
	}
	cursorAt, cursorID, err := decodeHistoryCursor(encodeHistoryCursor(first[1]))
	if err != nil {
		t.Fatalf("cursor: %v", err)
	}
	second, err := repo.ListHistory(ctx, tenantID, subscriberID, cursorAt, cursorID, 2)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(second) != 2 || second[0].ID != ids[2] || second[1].ID != ids[3] {
		t.Fatalf("second page ids = %+v, want %s then %s", second, ids[2], ids[3])
	}

	seen := map[string]bool{}
	for _, event := range append(first, second...) {
		if seen[event.ID] {
			t.Fatalf("duplicate event %s across pages", event.ID)
		}
		seen[event.ID] = true
	}
	if len(seen) != len(ids) {
		t.Fatalf("seen %d unique events, want %d", len(seen), len(ids))
	}
}
