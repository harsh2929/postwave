// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// The lease-pattern tests need a Postgres reachable via DATABASE_URL +
// the outbound_webhooks tables from migrations 0088 and 0091. Tests
// skip cleanly when DATABASE_URL is unset so `go test ./...` still
// passes in environments without a database (matching the project-wide
// pattern from notifications/dispatcher_test.go).

func newStoreTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed outbound_webhooks store test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedStoreTestTenant creates a tenant inside a transaction-local tenant worker
// scope. Keep shared test helpers on the same fail-closed path as production:
// returning a raw pooled connection with session-level capability GUCs can
// accidentally authorize the next operation in the same test.
func seedStoreTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID, name, slug string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenantWorker(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("open tenant worker seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, $2, $3, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID, name, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

// seedLeaseRow inserts a single pending delivery + parent webhook +
// tenant, ready for AcquireLease tests. Returns the row id and a
// cleanup func.
func seedLeaseRow(t *testing.T, pool *pgxpool.Pool, tenantID string, nextAttempt time.Time) (string, func()) {
	t.Helper()
	ctx := context.Background()
	// We bind app.outbox_worker so the permissive worker policies in
	// 0088 admit our INSERTs without needing a real tenant tx.
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	// The tenants INSERT policy is `id = current_setting('app.tenant_id')`;
	// worker scope alone leaves that unset, so every seed was rejected and the
	// Skipf reported it as a PASS.
	if _, err := conn.Exec(ctx, "SELECT set_config('app.tenant_id', $1, false)", tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant scope: %v", err)
	}
	if _, err := conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)"); err != nil {
		t.Fatalf("set worker scope: %v", err)
	}
	// Ensure tenant exists (RLS-bypass via outbox_worker doesn't help
	// the FK; tenants table is owned by the tenants migration and we
	// rely on it being seeded for tests). If not, skip.
	if _, err := conn.Exec(ctx,
		`INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'lease-test', 'lease-test' || right($1::text, 12), 'studio')
		   ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		t.Fatalf("seed tenant (likely missing tenants table or RLS): %v", err)
	}
	var webhookID string
	if err := conn.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_state
) VALUES (
    $1::uuid, 'https://example.invalid/…', '\x01'::bytea, 'ready',
    ARRAY['campaign.sent']::text[],
    '\x00'::bytea, true, 'ready'
)
RETURNING id::text`, tenantID).Scan(&webhookID); err != nil {
		t.Fatalf("seed webhook: %v", err)
	}
	var rowID string
	if err := conn.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, payload, next_attempt_at, status
) VALUES (
    $1::uuid, $2::uuid, 'campaign.sent', '{"event":{}}'::jsonb, $3, 'pending'
)
RETURNING id::text`, tenantID, webhookID, nextAttempt).Scan(&rowID); err != nil {
		t.Fatalf("seed delivery: %v", err)
	}
	cleanup := func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
		_, _ = conn.Exec(ctx, `DELETE FROM outbound_webhook_deliveries WHERE webhook_id::text = $1`, webhookID)
		_, _ = conn.Exec(ctx, `DELETE FROM outbound_webhooks WHERE id::text = $1`, webhookID)
	}
	return rowID, cleanup
}

func TestAcquireLease_RejectsEmptyOwner(t *testing.T) {
	// No DB needed for the early-return check.
	s := &Store{}
	_, err := s.AcquireLease(context.Background(), "", 5, time.Minute)
	if err == nil {
		t.Fatal("expected error for empty owner")
	}
}

func TestReleaseLease_RejectsEmptyArgs(t *testing.T) {
	s := &Store{}
	if err := s.ReleaseLease(context.Background(), "", "owner"); err == nil {
		t.Fatal("expected error for empty id")
	}
	if err := s.ReleaseLease(context.Background(), "id", ""); err == nil {
		t.Fatal("expected error for empty owner")
	}
}

func TestAcquireLease_PicksUpDueRow(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0001"
	rowID, cleanup := seedLeaseRow(t, pool, tenantID, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	s := &Store{Pool: (*db.Pool)(pool)}
	got, err := s.AcquireLease(context.Background(), "test-owner-a", 10, 30*time.Second)
	if err != nil {
		t.Fatalf("AcquireLease: %v", err)
	}
	// Look for our seeded row in the returned batch (the DB may have
	// other rows in flight; we only assert ours is in the result).
	found := false
	for _, p := range got {
		if p.ID == rowID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected leased row %s in %d results", rowID, len(got))
	}
	// The lease columns should now be populated. Verify directly.
	ctx := context.Background()
	conn, _ := pool.Acquire(ctx)
	defer conn.Release()
	_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
	var owner *string
	var expiry *time.Time
	if err := conn.QueryRow(ctx,
		`SELECT lease_owner, lease_expires_at FROM outbound_webhook_deliveries WHERE id::text = $1`,
		rowID).Scan(&owner, &expiry); err != nil {
		t.Fatalf("verify lease columns: %v", err)
	}
	if owner == nil || *owner != "test-owner-a" {
		t.Fatalf("lease_owner = %v, want test-owner-a", owner)
	}
	if expiry == nil || expiry.Before(time.Now()) {
		t.Fatalf("lease_expires_at = %v, want future", expiry)
	}
}

func TestAcquireLease_SkipsAlreadyLeasedRow(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0002"
	rowID, cleanup := seedLeaseRow(t, pool, tenantID, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	s := &Store{Pool: (*db.Pool)(pool)}
	ctx := context.Background()
	// First worker grabs it.
	if _, err := s.AcquireLease(ctx, "owner-first", 10, 30*time.Second); err != nil {
		t.Fatalf("first lease: %v", err)
	}
	// Second worker should NOT see our row in its result (still leased).
	got, err := s.AcquireLease(ctx, "owner-second", 10, 30*time.Second)
	if err != nil {
		t.Fatalf("second lease: %v", err)
	}
	for _, p := range got {
		if p.ID == rowID {
			t.Fatalf("second worker stole row %s while still leased", rowID)
		}
	}
}

func TestAcquireLease_PicksUpExpiredLease(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0003"
	rowID, cleanup := seedLeaseRow(t, pool, tenantID, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	ctx := context.Background()
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
	// Manually mark the row as leased-but-expired.
	if _, err := conn.Exec(ctx,
		`UPDATE outbound_webhook_deliveries
		    SET lease_owner = 'dead-worker',
		        lease_expires_at = now() - interval '5 minutes'
		  WHERE id::text = $1`, rowID); err != nil {
		conn.Release()
		t.Fatalf("seed expired lease: %v", err)
	}
	conn.Release()

	s := &Store{Pool: (*db.Pool)(pool)}
	got, err := s.AcquireLease(ctx, "recovery-worker", 10, 30*time.Second)
	if err != nil {
		t.Fatalf("AcquireLease: %v", err)
	}
	found := false
	for _, p := range got {
		if p.ID == rowID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected expired-lease row %s to be picked up", rowID)
	}
}

func TestReleaseLease_ClearsOwnerForFollowupAcquire(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0004"
	rowID, cleanup := seedLeaseRow(t, pool, tenantID, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	s := &Store{Pool: (*db.Pool)(pool)}
	ctx := context.Background()
	if _, err := s.AcquireLease(ctx, "owner-x", 10, 5*time.Minute); err != nil {
		t.Fatalf("first lease: %v", err)
	}
	if err := s.ReleaseLease(ctx, rowID, "owner-x"); err != nil {
		t.Fatalf("ReleaseLease: %v", err)
	}
	got, err := s.AcquireLease(ctx, "owner-y", 10, 5*time.Minute)
	if err != nil {
		t.Fatalf("re-lease: %v", err)
	}
	found := false
	for _, p := range got {
		if p.ID == rowID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected released row %s to be acquirable again", rowID)
	}
}

func TestReleaseLease_RefusesWrongOwner(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0005"
	rowID, cleanup := seedLeaseRow(t, pool, tenantID, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	s := &Store{Pool: (*db.Pool)(pool)}
	ctx := context.Background()
	if _, err := s.AcquireLease(ctx, "owner-real", 10, 5*time.Minute); err != nil {
		t.Fatalf("first lease: %v", err)
	}
	// Wrong-owner release is a no-op (the UPDATE matches zero rows).
	if err := s.ReleaseLease(ctx, rowID, "owner-spoof"); err != nil {
		t.Fatalf("ReleaseLease wrong owner: %v", err)
	}
	// Verify the lease is still held by owner-real.
	conn, _ := pool.Acquire(ctx)
	defer conn.Release()
	_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
	var owner *string
	if err := conn.QueryRow(ctx,
		`SELECT lease_owner FROM outbound_webhook_deliveries WHERE id::text = $1`,
		rowID).Scan(&owner); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if owner == nil || *owner != "owner-real" {
		t.Fatalf("lease_owner = %v, want owner-real (spoof should not have cleared it)", owner)
	}
}

func TestReplayDelivery_RejectsPendingAndCreatesAuditableChild(t *testing.T) {
	pool := newStoreTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000ab0006"
	rowID, cleanup := seedLeaseRow(t, pool, tenantID, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	store := &Store{Pool: (*db.Pool)(pool)}
	if _, err := store.ReplayDelivery(
		context.Background(),
		tenantID,
		rowID,
		"pending-source",
	); !errors.Is(err, ErrDeliveryInProgress) {
		t.Fatalf("pending replay error = %v; want ErrDeliveryInProgress", err)
	}

	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	// The tenants INSERT policy is `id = current_setting('app.tenant_id')`;
	// worker scope alone leaves that unset, so every seed was rejected and the
	// Skipf reported it as a PASS.
	if _, err := conn.Exec(ctx, "SELECT set_config('app.tenant_id', $1, false)", tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant scope: %v", err)
	}
	if _, err := conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)"); err != nil {
		t.Fatalf("set worker scope: %v", err)
	}
	if _, err := conn.Exec(ctx, `
UPDATE outbound_webhook_deliveries
   SET status = 'exhausted', next_attempt_at = NULL, attempt_count = 7,
       last_error = 'original failure',
       source_event_id = '33333333-3333-4333-8333-333333333333'::uuid
 WHERE id::text = $1`, rowID); err != nil {
		t.Fatalf("finalize source: %v", err)
	}

	replay, err := store.ReplayDelivery(ctx, tenantID, rowID, "operator-click-1")
	if err != nil {
		t.Fatalf("ReplayDelivery: %v", err)
	}
	childID := replay.DeliveryID
	if childID == "" || childID == rowID {
		t.Fatalf("child id = %q; want a fresh delivery id", childID)
	}
	if replay.ReplayedFrom != rowID || replay.Status != "pending" || replay.ReplayedAt.IsZero() {
		t.Fatalf("replay response = %#v; want frozen pending child lineage", replay)
	}
	retry, err := store.ReplayDelivery(ctx, tenantID, rowID, "operator-click-1")
	if err != nil {
		t.Fatalf("ReplayDelivery idempotent retry: %v", err)
	}
	if retry.DeliveryID != replay.DeliveryID ||
		retry.ReplayedFrom != replay.ReplayedFrom ||
		retry.Status != replay.Status ||
		!retry.ReplayedAt.Equal(replay.ReplayedAt) {
		t.Fatalf("idempotent retry changed response:\nfirst %#v\nretry %#v", replay, retry)
	}
	distinctReplay, err := store.ReplayDelivery(ctx, tenantID, rowID, "operator-click-2")
	if err != nil {
		t.Fatalf("ReplayDelivery distinct key: %v", err)
	}
	if distinctReplay.DeliveryID == replay.DeliveryID {
		t.Fatalf("different keys reused child %q", replay.DeliveryID)
	}

	type replayOutcome struct {
		result ReplayDeliveryResult
		err    error
	}
	const concurrentCallers = 8
	start := make(chan struct{})
	outcomes := make(chan replayOutcome, concurrentCallers)
	for range concurrentCallers {
		go func() {
			<-start
			result, replayErr := store.ReplayDelivery(
				ctx,
				tenantID,
				rowID,
				"operator-click-concurrent",
			)
			outcomes <- replayOutcome{result: result, err: replayErr}
		}()
	}
	close(start)
	var concurrentReplay ReplayDeliveryResult
	for range concurrentCallers {
		outcome := <-outcomes
		if outcome.err != nil {
			t.Fatalf("concurrent ReplayDelivery: %v", outcome.err)
		}
		if concurrentReplay.DeliveryID == "" {
			concurrentReplay = outcome.result
			continue
		}
		if outcome.result.DeliveryID != concurrentReplay.DeliveryID ||
			outcome.result.ReplayedFrom != concurrentReplay.ReplayedFrom ||
			outcome.result.Status != concurrentReplay.Status ||
			!outcome.result.ReplayedAt.Equal(concurrentReplay.ReplayedAt) {
			t.Fatalf(
				"concurrent idempotent response changed:\nfirst %#v\nother %#v",
				concurrentReplay,
				outcome.result,
			)
		}
	}
	var childCount int
	if err := conn.QueryRow(ctx, `
SELECT count(*)
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid
   AND parent_delivery_id = $2::uuid`,
		tenantID,
		rowID,
	).Scan(&childCount); err != nil {
		t.Fatalf("count replay children: %v", err)
	}
	if childCount != 3 {
		t.Fatalf("replay child count = %d, want 3 logical keys", childCount)
	}

	var otherSourceID string
	if err := conn.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, source_event_id, payload,
    status, attempt_count, next_attempt_at
)
SELECT tenant_id, webhook_id, event_type,
       '44444444-4444-4444-8444-444444444444'::uuid, payload,
       'exhausted', 7, NULL
  FROM outbound_webhook_deliveries
 WHERE tenant_id = $1::uuid
   AND id::text = $2
RETURNING id::text`,
		tenantID,
		rowID,
	).Scan(&otherSourceID); err != nil {
		t.Fatalf("seed second replay source: %v", err)
	}
	if _, err := store.ReplayDelivery(
		ctx,
		tenantID,
		otherSourceID,
		"operator-click-1",
	); !errors.Is(err, ErrReplayConflict) {
		t.Fatalf("semantic key reuse error = %v, want ErrReplayConflict", err)
	}
	var (
		parentID string
		status   string
		attempts int
		payload  string
		sourceID string
	)
	if err := conn.QueryRow(ctx, `
SELECT parent_delivery_id::text, status, attempt_count, payload::text,
       source_event_id::text
  FROM outbound_webhook_deliveries
 WHERE id::text = $1`, childID).Scan(&parentID, &status, &attempts, &payload, &sourceID); err != nil {
		t.Fatalf("load replay child (is migration 1786 applied?): %v", err)
	}
	if parentID != rowID || status != "pending" || attempts != 0 {
		t.Fatalf("child lineage/status = (%q, %q, %d); want (%q, pending, 0)", parentID, status, attempts, rowID)
	}
	if payload != `{"event": {}}` && payload != `{"event":{}}` {
		t.Fatalf("child payload = %q; want source payload", payload)
	}
	if sourceID != "33333333-3333-4333-8333-333333333333" {
		t.Fatalf("child source_event_id = %q; want original event identity", sourceID)
	}
	var sourceError string
	if err := conn.QueryRow(ctx, `
SELECT COALESCE(last_error, '')
  FROM outbound_webhook_deliveries
 WHERE id::text = $1`, rowID).Scan(&sourceError); err != nil {
		t.Fatalf("load replay source: %v", err)
	}
	if sourceError != "original failure" {
		t.Fatalf("source history mutated: last_error = %q", sourceError)
	}
}
