// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type transactionalListFanoutFixture struct {
	tenantID     string
	globalHookID string
	listHookID   string
	otherHookID  string
	lateHookID   string
	listID       string
}

func newTransactionalListFanoutDBPool(t *testing.T) *db.Pool {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	pool, err := db.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedTransactionalListFanoutFixture(
	t *testing.T,
	pool *db.Pool,
	occurredAt time.Time,
) transactionalListFanoutFixture {
	t.Helper()
	fixture := transactionalListFanoutFixture{
		tenantID: uuid.NewString(),
		listID:   uuid.NewString(),
	}
	otherListID := uuid.NewString()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open fixture tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'transactional list fanout test',
        'transactional-list-fanout-' || $1::text, 'studio')`,
		fixture.tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	// `outbound_webhooks.list_id` is a composite FK to
	// list_id_map(tenant_id, postwave_uuid) — the table that maps a Moosewave
	// list uuid onto the engine's bigint id. The fixture generated bare uuids
	// and seeded no mapping, so every webhook insert was rejected and the
	// Skipf reported it as a PASS. (The FK does NOT point at the engine-owned
	// `lists` table, which is absent here; this test can and does run.)
	for i, listID := range []string{fixture.listID, otherListID} {
		if _, err := tx.Exec(ctx, `
INSERT INTO list_id_map (tenant_id, postwave_uuid, listmonk_bigint_id)
VALUES ($1::uuid, $2::uuid, $3)`, fixture.tenantID, listID, 700000+i); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed list_id_map: %v", err)
		}
	}
	insertHook := func(listID *string, createdAt time.Time) string {
		t.Helper()
		var id string
		if err := tx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_state, list_id, created_at
)
VALUES (
    $1::uuid, 'https://example.invalid/…', '\x01'::bytea, 'ready',
    ARRAY['list.subscriber.added']::text[], '\x00'::bytea, true,
    'ready', $2::uuid, $3
)
RETURNING id::text`,
			fixture.tenantID, listID, createdAt).Scan(&id); err != nil {
			t.Fatalf("seed webhook: %v", err)
		}
		return id
	}
	before := occurredAt.Add(-time.Hour)
	fixture.globalHookID = insertHook(nil, before)
	fixture.listHookID = insertHook(&fixture.listID, before)
	fixture.otherHookID = insertHook(&otherListID, before)
	fixture.lateHookID = insertHook(nil, occurredAt.Add(time.Hour))
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}

	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, fixture.tenantID)
		if cleanupErr != nil {
			t.Errorf("open fixture cleanup: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanup.Rollback(cleanupCtx) }()
		if _, cleanupErr := cleanup.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, fixture.tenantID); cleanupErr != nil {
			t.Errorf("delete fixture tenant: %v", cleanupErr)
			return
		}
		if cleanupErr := cleanup.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit fixture cleanup: %v", cleanupErr)
		}
	})
	return fixture
}

func TestTransactionalListFanoutPersistsSetBasedDeliveryContract(t *testing.T) {
	pool := newTransactionalListFanoutDBPool(t)
	occurredAt := time.Date(2026, 7, 23, 9, 10, 11, 123456789, time.UTC)
	fixture := seedTransactionalListFanoutFixture(t, pool, occurredAt)
	events := []ListSubscriberAddedEvent{
		{
			SubscriberID: uuid.NewString(),
			Email:        "first@example.test",
			ListID:       fixture.listID,
			Source:       "api",
			AddedAt:      occurredAt,
		},
		{
			SubscriberID: uuid.NewString(),
			Email:        "second@example.test",
			ListID:       fixture.listID,
			Source:       "integration",
			AddedAt:      occurredAt.Add(time.Nanosecond),
		},
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open fanout tx: %v", err)
	}
	count, err := (&TransactionalFanout{}).FireListSubscriberAddedBatch(
		ctx, tx, fixture.tenantID, events,
	)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("fire set-based fanout: %v", err)
	}
	if count != 4 {
		_ = tx.Rollback(ctx)
		t.Fatalf("inserted deliveries = %d, want 4", count)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fanout: %v", err)
	}

	verify, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open verification tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var (
		receipts       int
		deliveries     int
		globalCount    int
		listCount      int
		otherListCount int
		lateCount      int
	)
	if err := verify.QueryRow(ctx, `
SELECT
    (SELECT count(*)::int
       FROM outbound_webhook_event_receipts
      WHERE tenant_id = $1::uuid),
    (SELECT count(*)::int
       FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid),
    (SELECT count(*)::int FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid AND webhook_id = $2::uuid),
    (SELECT count(*)::int FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid AND webhook_id = $3::uuid),
    (SELECT count(*)::int FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid AND webhook_id = $4::uuid),
    (SELECT count(*)::int FROM outbound_webhook_deliveries
      WHERE tenant_id = $1::uuid AND webhook_id = $5::uuid)`,
		fixture.tenantID,
		fixture.globalHookID,
		fixture.listHookID,
		fixture.otherHookID,
		fixture.lateHookID,
	).Scan(
		&receipts,
		&deliveries,
		&globalCount,
		&listCount,
		&otherListCount,
		&lateCount,
	); err != nil {
		t.Fatalf("load fanout counts: %v", err)
	}
	if receipts != 2 || deliveries != 4 ||
		globalCount != 2 || listCount != 2 ||
		otherListCount != 0 || lateCount != 0 {
		t.Fatalf(
			"counts receipts=%d deliveries=%d global=%d list=%d other=%d late=%d",
			receipts, deliveries, globalCount, listCount, otherListCount, lateCount,
		)
	}
	var (
		eventID        string
		eventType      string
		wireOccurred   string
		wireListID     string
		wireSubscriber string
		wireEmail      string
		wireSource     string
	)
	if err := verify.QueryRow(ctx, `
SELECT payload->'event'->>'id',
       payload->'event'->>'type',
       payload->'event'->>'occurred_at',
       payload->'event'->'data'->>'list_id',
       payload->'event'->'data'->>'subscriber_id',
       payload->'event'->'data'->>'email',
       payload->'event'->'data'->>'source'
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid
   AND webhook_id = $2::uuid
   AND payload->'event'->'data'->>'subscriber_id' = $3
 LIMIT 1`,
		fixture.tenantID,
		fixture.globalHookID,
		events[0].SubscriberID,
	).Scan(
		&eventID,
		&eventType,
		&wireOccurred,
		&wireListID,
		&wireSubscriber,
		&wireEmail,
		&wireSource,
	); err != nil {
		t.Fatalf("load canonical envelope: %v", err)
	}
	if _, err := uuid.Parse(eventID); err != nil {
		t.Fatalf("wire event id is not UUID-shaped: %q", eventID)
	}
	if eventType != EventListSubscriberAdded ||
		wireOccurred != occurredAt.Format(time.RFC3339Nano) ||
		wireListID != fixture.listID ||
		wireSubscriber != events[0].SubscriberID ||
		wireEmail != events[0].Email ||
		wireSource != events[0].Source {
		t.Fatalf(
			"unexpected envelope id=%q type=%q at=%q list=%q subscriber=%q email=%q source=%q",
			eventID, eventType, wireOccurred, wireListID, wireSubscriber, wireEmail, wireSource,
		)
	}
	if err := verify.Commit(ctx); err != nil {
		t.Fatalf("commit verification: %v", err)
	}

	retry, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open retry tx: %v", err)
	}
	retryCount, err := (&TransactionalFanout{}).FireListSubscriberAddedBatch(
		ctx, retry, fixture.tenantID, events,
	)
	if err != nil {
		_ = retry.Rollback(ctx)
		t.Fatalf("retry fanout: %v", err)
	}
	if retryCount != 0 {
		_ = retry.Rollback(ctx)
		t.Fatalf("retry inserted %d duplicate deliveries", retryCount)
	}
	if err := retry.Commit(ctx); err != nil {
		t.Fatalf("commit retry: %v", err)
	}

	collisionEvents := append([]ListSubscriberAddedEvent(nil), events...)
	collisionEvents[0].Email = "collision@example.test"
	collision, err := db.WithTenant(ctx, pool, fixture.tenantID)
	if err != nil {
		t.Fatalf("open collision tx: %v", err)
	}
	if _, err := (&TransactionalFanout{}).FireListSubscriberAddedBatch(
		ctx, collision, fixture.tenantID, collisionEvents,
	); err == nil || !strings.Contains(err.Error(), "collision") {
		_ = collision.Rollback(ctx)
		t.Fatalf("collision error = %v, want fail-closed collision", err)
	}
	if err := collision.Rollback(ctx); err != nil {
		t.Fatalf("rollback collision: %v", err)
	}
}
