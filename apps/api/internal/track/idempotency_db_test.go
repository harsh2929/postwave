// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A retried tracked event must be recorded once.
//
// The insert had no `ON CONFLICT` and the table no unique key beyond its
// surrogate id, so a retry produced a second row. Client SDKs retry on timeout
// by design, and a timeout is exactly the case where the write may already have
// succeeded — so the events most likely to be duplicated are the ones on the
// worst connections.
//
// It is not cosmetic. `product_events` drives flow triggers (`fanoutEvent`
// fires per row), segment membership and the subscriber timeline: a
// double-counted `purchase` enrols someone in an abandoned-cart flow twice.

func newTrackPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTrackSubscriber(t *testing.T, pool *db.Pool) (tenantID, subID string) {
	t.Helper()
	ctx := context.Background()
	tenantID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'track', 'studio')`,
		tenantID, "track-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api') RETURNING id::text`,
		tenantID, "track-"+tenantID[:8]+"@example.test").Scan(&subID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// One tenant delete removes everything the test wrote through ON DELETE
	// CASCADE. The teardown used to delete product_events first and give up
	// silently on the first error, and the application role has no DELETE on
	// product_events, so the tenant delete never ran and every run leaked its
	// tenant.
	t.Cleanup(func() { deleteTrackTestTenant(t, pool, tenantID) })
	return tenantID, subID
}

func countEvents(t *testing.T, pool *db.Pool, tenantID string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM product_events WHERE tenant_id = $1::uuid`, tenantID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestARetriedEventWithTheSameKeyIsRecordedOnce(t *testing.T) {
	pool := newTrackPool(t)
	ctx := context.Background()
	tenantID, subID := seedTrackSubscriber(t, pool)
	repo := &Repo{Pool: pool}
	key := "evt-" + uuid.NewString()

	first, err := repo.Insert(ctx, tenantID, subID, "purchase", []byte(`{"amount":10}`), time.Now().UTC(), key)
	if err != nil {
		t.Fatalf("first insert: %v", err)
	}
	second, err := repo.Insert(ctx, tenantID, subID, "purchase", []byte(`{"amount":10}`), time.Now().UTC(), key)
	if err != nil {
		t.Fatalf("retry must not error — the event is safely recorded: %v", err)
	}

	if n := countEvents(t, pool, tenantID); n != 1 {
		t.Fatalf("a retried event produced %d rows. product_events drives flow "+
			"triggers, segment membership and the timeline, so a duplicate "+
			"`purchase` enrols someone in an abandoned-cart flow twice.", n)
	}
	if first != second {
		t.Errorf("retry returned id %d, first returned %d — a caller reconciling "+
			"ids would treat one event as two", second, first)
	}
}

func TestEventsWithoutAKeyAreUnaffected(t *testing.T) {
	// The compatibility case. Making the key mandatory would break every
	// existing integration, so a caller that sends none keeps today's behaviour
	// — including that two identical events really are two events.
	pool := newTrackPool(t)
	ctx := context.Background()
	tenantID, subID := seedTrackSubscriber(t, pool)
	repo := &Repo{Pool: pool}

	for i := 0; i < 2; i++ {
		if _, err := repo.Insert(ctx, tenantID, subID, "page_view", []byte(`{}`), time.Now().UTC(), ""); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}
	if n := countEvents(t, pool, tenantID); n != 2 {
		t.Fatalf("two un-keyed events collapsed to %d. Without a key the server "+
			"cannot know they are the same event, and silently dropping one would "+
			"lose real data.", n)
	}
}

func TestTheKeyIsScopedToTheTenant(t *testing.T) {
	// Two tenants using the same client-side id must not collide — one
	// workspace's event would silently suppress another's.
	pool := newTrackPool(t)
	ctx := context.Background()
	tenantA, subA := seedTrackSubscriber(t, pool)
	tenantB, subB := seedTrackSubscriber(t, pool)
	repo := &Repo{Pool: pool}
	key := "shared-" + uuid.NewString()

	if _, err := repo.Insert(ctx, tenantA, subA, "signup", []byte(`{}`), time.Now().UTC(), key); err != nil {
		t.Fatalf("tenant A: %v", err)
	}
	if _, err := repo.Insert(ctx, tenantB, subB, "signup", []byte(`{}`), time.Now().UTC(), key); err != nil {
		t.Fatalf("tenant B: %v", err)
	}
	if n := countEvents(t, pool, tenantB); n != 1 {
		t.Fatalf("tenant B recorded %d events; another tenant's identical key "+
			"suppressed or duplicated theirs", n)
	}
}
