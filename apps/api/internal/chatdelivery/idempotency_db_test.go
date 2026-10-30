// SPDX-License-Identifier: AGPL-3.0-only

package chatdelivery

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// One outbox event must produce at most one chat message.
//
// The outbox is at-least-once by design: the handler posts, then the worker
// marks the event complete. A crash, a lease expiry, or a slow ack between
// those two steps redelivers the event and the handler posts again. Before
// this, `chat_delivery_log` was written AFTER the post and carried no event id,
// so it could record the duplicate and never prevent it — two success rows with
// nothing to say they were one notification.

func idemPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping chat delivery idempotency test")
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

// seedChatTenant creates a fresh tenant for one test. It must be a real row:
// chat_delivery_log.tenant_id references tenants(id) (migration 2045), so a
// made-up tenant id is refused with SQLSTATE 23503.
//
// The package's tests share one database with every other package's tests, so
// each test owns a fresh tenant and a fresh integration id. Every statement
// runs as the unprivileged app role under db.WithTenant, so FORCE RLS confines
// both the writes and the cleanup to this tenant's rows.
func seedChatTenant(t *testing.T, pool *db.Pool) (tenantID, integrationID string) {
	t.Helper()
	tenantID, integrationID = uuid.NewString(), uuid.NewString()
	if _, err := execChatFixture(t, pool, tenantID, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'chat', 'studio')`,
		tenantID, "chat-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() { removeChatTenant(t, pool, tenantID) })
	return tenantID, integrationID
}

// removeChatTenant deletes one test's chat_delivery_log rows and then its
// tenant, and fails the test when either is left behind.
//
// The log rows go in a transaction of their own, and a failure fails the test.
// They once shared a transaction with the tenant delete and every error was
// discarded, so a failed tenant delete silently rolled back this delete as
// well. The tenant delete would take any remaining rows with it
// (chat_delivery_log_tenant_id_fkey is ON DELETE CASCADE). Both steps run
// through execChatFixture, so lock pressure from a parallel run is retried
// rather than mistaken for a leak. What remains is a real failure: an error
// that outlasts the retries, or a tenant delete that did not remove exactly
// this test's one row.
func removeChatTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	if _, err := execChatFixture(t, pool, tenantID,
		`DELETE FROM chat_delivery_log WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		t.Errorf("cleanup chat_delivery_log for tenant %s: %v", tenantID, err)
	}
	removed, err := execChatFixture(t, pool, tenantID, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		t.Errorf("cleanup: tenant %s and its rows leaked: %v", tenantID, err)
		return
	}
	if removed != 1 {
		t.Errorf("cleanup deleted %d tenant rows for %s, want 1", removed, tenantID)
	}
}

// execChatFixture runs one fixture statement (the tenant seed or a teardown
// step) in its own transaction bound to tenantID, commits it, and returns the
// rows it affected. It uses its own bounded context, so it also works from
// t.Cleanup, and a lock wait cannot hold the package until the go test
// timeout.
//
// It replays the transaction while Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). About 735
// foreign keys reference tenants(id), so one tenant delete holds about 3,300
// locks until commit. The shared lock table holds roughly
// max_locks_per_transaction × max_connections entries for the whole server,
// every database on it included. At the image default of 64, which a shared
// local server may still run, two tenant deletes from other packages at the
// same moment can fill it. CI raises the setting to 512 (the service
// container in .github/workflows/test.yml and
// infra/aws/codebuild/ci-group.sh), so there the retry is a backstop rather
// than the usual path. A tenant delete can also deadlock with another
// package's DDL on a table it cascades through. Both are contention on the
// shared test database, not a defect in chat delivery, and both clear on
// their own. Only fixture steps retry; the calls under test run once.
func execChatFixture(t *testing.T, pool *db.Pool, tenantID, sql string, args ...any) (int64, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		affected, err := execInTenant(ctx, pool, tenantID, sql, args...)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || (pgErr.Code != "53200" && pgErr.Code != "40P01") {
			return affected, err
		}
		t.Logf("tenant %s: transient SQLSTATE %s, retrying in %v: %v", tenantID, pgErr.Code, wait, err)
		select {
		case <-ctx.Done():
			return 0, fmt.Errorf("still failing after retrying: %w", err)
		case <-time.After(wait):
		}
	}
}

// execInTenant runs one statement in its own transaction bound to tenantID,
// commits it, and returns the rows it affected.
func execInTenant(ctx context.Context, pool *db.Pool, tenantID, sql string, args ...any) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

func countDeliveries(t *testing.T, pool *db.Pool, tenantID string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM chat_delivery_log WHERE tenant_id = $1::uuid`, tenantID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestARedeliveredOutboxEventIsNotPostedTwice(t *testing.T) {
	pool := idemPool(t)
	ctx := context.Background()
	tenantID, integrationID := seedChatTenant(t, pool)
	eventID := uuid.NewString()

	// Nothing delivered yet — the handler must post.
	if AlreadyDelivered(ctx, pool, tenantID, integrationID, eventID) {
		t.Fatal("an unseen event reported as already delivered; the notification " +
			"would be dropped entirely")
	}
	if err := LogEvent(ctx, pool, tenantID, "slack", integrationID, "approval.requested", eventID, nil); err != nil {
		t.Fatalf("LogEvent: %v", err)
	}

	// The outbox redelivers the same event.
	if !AlreadyDelivered(ctx, pool, tenantID, integrationID, eventID) {
		t.Fatal("a redelivered outbox event was not recognised; the person is " +
			"notified again every time the worker retries")
	}

	// And a second record for it does not create a second row.
	if err := LogEvent(ctx, pool, tenantID, "slack", integrationID, "approval.requested", eventID, nil); err != nil {
		t.Fatalf("second LogEvent: %v", err)
	}
	if n := countDeliveries(t, pool, tenantID); n != 1 {
		t.Fatalf("chat_delivery_log rows = %d, want 1; the history shows one "+
			"notification as two events", n)
	}
}

// A FAILED delivery must be retried, not treated as done. Scoping the unique
// index to successes is what allows that; a broader index would make the first
// failure permanent.
func TestAFailedChatDeliveryIsRetried(t *testing.T) {
	pool := idemPool(t)
	ctx := context.Background()
	tenantID, integrationID := seedChatTenant(t, pool)
	eventID := uuid.NewString()

	if err := LogEvent(ctx, pool, tenantID, "slack", integrationID, "approval.requested",
		eventID, errors.New("slack 503")); err != nil {
		t.Fatalf("LogEvent: %v", err)
	}
	if AlreadyDelivered(ctx, pool, tenantID, integrationID, eventID) {
		t.Fatal("a FAILED delivery was treated as complete. The outbox will retry " +
			"the event, this guard will skip the post, and the notification is " +
			"lost permanently — a transient 503 turned into a dropped message.")
	}
	// The retry succeeds and is recorded alongside the failure.
	if err := LogEvent(ctx, pool, tenantID, "slack", integrationID, "approval.requested", eventID, nil); err != nil {
		t.Fatalf("retry LogEvent: %v", err)
	}
	if !AlreadyDelivered(ctx, pool, tenantID, integrationID, eventID) {
		t.Fatal("the successful retry was not recorded as delivered")
	}
	if n := countDeliveries(t, pool, tenantID); n != 2 {
		t.Fatalf("rows = %d, want 2 (the failure and the success); an operator "+
			"reading the history cannot see it took two attempts", n)
	}
}

// The operator-triggered "Send test" path has no outbox event, and a second
// click is MEANT to send a second message. An idempotency scheme that swallowed
// it would make the test button appear broken.
func TestTheTestPostPathIsNotDeduplicated(t *testing.T) {
	pool := idemPool(t)
	ctx := context.Background()
	tenantID, integrationID := seedChatTenant(t, pool)

	if AlreadyDelivered(ctx, pool, tenantID, integrationID, "") {
		t.Fatal("an empty event id reported as already delivered; the Send test " +
			"button would silently do nothing")
	}
	for i := 0; i < 2; i++ {
		if err := Log(ctx, pool, tenantID, "slack", integrationID, "test", nil); err != nil {
			t.Fatalf("test log %d: %v", i, err)
		}
	}
	if n := countDeliveries(t, pool, tenantID); n != 2 {
		t.Fatalf("rows = %d, want 2; two deliberate test posts were collapsed "+
			"into one", n)
	}
}

// Two workers racing the same redelivered event must not both write a success.
func TestConcurrentRecordsOfOneEventCollapseToOneRow(t *testing.T) {
	pool := idemPool(t)
	ctx := context.Background()
	tenantID, integrationID := seedChatTenant(t, pool)
	eventID := uuid.NewString()

	done := make(chan error, 4)
	for i := 0; i < 4; i++ {
		go func() {
			done <- LogEvent(ctx, pool, tenantID, "slack", integrationID, "approval.requested", eventID, nil)
		}()
	}
	for i := 0; i < 4; i++ {
		if err := <-done; err != nil {
			t.Fatalf("concurrent LogEvent: %v", err)
		}
	}
	if n := countDeliveries(t, pool, tenantID); n != 1 {
		t.Fatalf("rows = %d, want 1; the unique index is not collapsing a race, "+
			"so the history double-counts one notification", n)
	}
}
