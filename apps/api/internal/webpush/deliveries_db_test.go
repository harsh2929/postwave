// SPDX-License-Identifier: AGPL-3.0-only

package webpush

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	webpushlib "github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A web push that fails must leave a trace.
//
// Before this, `SendToUser` logged and moved on: a browser vendor returning 429
// dropped that notification permanently, and nothing anywhere recorded that it
// had ever been attempted. The same notification to the same person's phone is
// in `mobile_push_deliveries` with attempts, an error code, and a retry time.

func deliveriesPool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping web push delivery test")
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

// seedPushUser creates a tenant with one browser subscription pointed at srv.
func seedPushUser(t *testing.T, pool *db.Pool, endpoint string) (tenantID, userID string) {
	t.Helper()
	ctx := context.Background()
	// Real ECDH keys, from the helper sender_test.go already has. Fabricated
	// base64 that merely LOOKS like a key makes the library fail to encrypt, so
	// every send dies before the HTTP call — and the rejection test still
	// passed, because a transport failure produces the same "failed, not
	// terminal" row a 429 does.
	p256dh, auth := testSubscriptionKeys(t)
	tenantID, userID = uuid.NewString(), uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'wp', 'studio')`,
		tenantID, "wp-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO web_push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth)
VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
		tenantID, userID, endpoint, p256dh, auth); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscription: %v", err)
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
		_, _ = c.Exec(bg, `DELETE FROM web_push_deliveries WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM web_push_subscriptions WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return tenantID, userID
}

type deliveryRow struct {
	Status    string
	ErrorCode string
	Attempts  int
	Accepted  bool
	Terminal  bool
}

func readDeliveries(t *testing.T, pool *db.Pool, tenantID string) []deliveryRow {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT status, error_code, attempts, accepted_at IS NOT NULL, terminal_at IS NOT NULL
  FROM web_push_deliveries WHERE tenant_id = $1::uuid ORDER BY created_at`, tenantID)
	if err != nil {
		t.Fatalf("read deliveries: %v", err)
	}
	defer rows.Close()
	var out []deliveryRow
	for rows.Next() {
		var r deliveryRow
		if err := rows.Scan(&r.Status, &r.ErrorCode, &r.Attempts, &r.Accepted, &r.Terminal); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, r)
	}
	return out
}

// pushDeps builds a sender whose delivery client reaches a loopback mock.
func pushDeps(t *testing.T, pool *db.Pool, srv *httptest.Server) *Deps {
	t.Helper()
	// Generated per run rather than pasted in: a key checked into a test file
	// is a key someone eventually reuses somewhere it matters.
	priv, pub, err := webpushlib.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}
	return &Deps{
		Pool:       pool,
		PublicKey:  pub,
		PrivateKey: priv,
		Subject:    "mailto:ops@example.test",
		httpClient: srv.Client(),
	}
}

// The case the ledger exists for: a transient rejection that used to vanish.
func TestARejectedPushIsRecordedAndNotTerminal(t *testing.T) {
	pool := deliveriesPool(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-a")

	sent, err := pushDeps(t, pool, srv).SendToUser(context.Background(), tenantID, userID,
		Notification{Title: "Approval needed", NotificationID: "feed-row-1", Event: "approval.requested"})
	if err != nil {
		t.Fatalf("SendToUser: %v", err)
	}
	if sent != 0 {
		t.Fatalf("sent = %d, want 0 — a 429 is not a delivery", sent)
	}

	rows := readDeliveries(t, pool, tenantID)
	if len(rows) != 1 {
		t.Fatalf("delivery rows = %d, want 1; a rejected push left no trace and is "+
			"indistinguishable from one never attempted", len(rows))
	}
	if rows[0].Status != statusFailed {
		t.Errorf("status = %q, want %q", rows[0].Status, statusFailed)
	}
	if rows[0].Terminal {
		t.Error("a 429 was recorded as terminal. It is transient — marking it " +
			"final is how a rate limit becomes a permanently lost notification, " +
			"and a retry worker would skip this row.")
	}
	if rows[0].Accepted {
		t.Error("accepted_at is set on a rejected push")
	}
	// The error code must name the REJECTION, not a transport failure. Without
	// this the test passes when the push never reaches the service at all —
	// which is exactly how it first passed, on invalid VAPID keys.
	if rows[0].ErrorCode != http.StatusText(http.StatusTooManyRequests) {
		t.Fatalf("error_code = %q, want %q — the push did not reach the service, "+
			"so this test was measuring a transport failure and not a 429",
			rows[0].ErrorCode, http.StatusText(http.StatusTooManyRequests))
	}
}

func TestAnAcceptedPushIsRecordedAsSent(t *testing.T) {
	pool := deliveriesPool(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-b")

	sent, err := pushDeps(t, pool, srv).SendToUser(context.Background(), tenantID, userID,
		Notification{Title: "Done", NotificationID: "feed-row-2"})
	if err != nil {
		t.Fatalf("SendToUser: %v", err)
	}
	if sent != 1 {
		t.Fatalf("sent = %d, want 1", sent)
	}
	rows := readDeliveries(t, pool, tenantID)
	if len(rows) != 1 || rows[0].Status != statusSent {
		t.Fatalf("rows = %+v, want one sent row", rows)
	}
	if !rows[0].Accepted || !rows[0].Terminal {
		t.Errorf("a sent push must be accepted and terminal: %+v", rows[0])
	}
}

// The behavioural half. Without it the table is a log; with it, a worker that
// retries an enclosing job does not double-notify.
func TestTheSameNotificationIsNotSentTwiceToOneEndpoint(t *testing.T) {
	pool := deliveriesPool(t)
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-c")

	deps := pushDeps(t, pool, srv)
	n := Notification{Title: "Approval needed", NotificationID: "feed-row-3"}
	for i := 0; i < 3; i++ {
		if _, err := deps.SendToUser(context.Background(), tenantID, userID, n); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if hits != 1 {
		t.Fatalf("the push service was called %d times for one notification; a "+
			"worker retrying its enclosing job notifies the person again every time", hits)
	}
	if rows := readDeliveries(t, pool, tenantID); len(rows) != 1 {
		t.Fatalf("delivery rows = %d, want 1", len(rows))
	}
}

// A previous FAILURE must not be treated as done — that is how a transient
// error becomes permanent.
func TestAPreviouslyFailedPushIsAttemptedAgain(t *testing.T) {
	pool := deliveriesPool(t)
	var hits int
	fail := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if fail {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-d")

	deps := pushDeps(t, pool, srv)
	n := Notification{Title: "Approval needed", NotificationID: "feed-row-4"}
	if _, err := deps.SendToUser(context.Background(), tenantID, userID, n); err != nil {
		t.Fatalf("first send: %v", err)
	}
	fail = false
	if _, err := deps.SendToUser(context.Background(), tenantID, userID, n); err != nil {
		t.Fatalf("second send: %v", err)
	}
	if hits != 2 {
		t.Fatalf("the push service was called %d times; a failed attempt was "+
			"treated as complete, so the notification is lost for good", hits)
	}
	rows := readDeliveries(t, pool, tenantID)
	if len(rows) != 1 {
		t.Fatalf("delivery rows = %d, want 1 (same key, same endpoint)", len(rows))
	}
	if rows[0].Status != statusSent {
		t.Errorf("status = %q after a successful retry, want sent", rows[0].Status)
	}
	if rows[0].Attempts != 2 {
		t.Errorf("attempts = %d, want 2 — the count is what tells an operator "+
			"this took more than one try", rows[0].Attempts)
	}
}

// The claim the ledger has been making, finally tested.
//
// Migration 1883 said a failed delivery is "visible and re-sendable" while the
// worker was "separate work". Separate work that never arrives is the failure
// this codebase keeps recording — a table of failures nobody acts on is a more
// detailed way of losing the notification.
func TestARejectedPushIsRecoveredOnRetry(t *testing.T) {
	pool := deliveriesPool(t)
	ctx := context.Background()
	var reject atomic.Bool
	reject.Store(true)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		if reject.Load() {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-retry")

	// The feed row the retry rebuilds its payload from. Without it there is
	// nothing to re-send — which the worker treats as "do not invent content",
	// so this fixture is load-bearing rather than decoration.
	notificationID := seedFeedRow(t, pool, tenantID, userID, "Approval needed")

	deps := pushDeps(t, pool, srv)
	n := Notification{Title: "Approval needed", NotificationID: notificationID, Event: "approval.requested"}
	if sent, err := deps.SendToUser(ctx, tenantID, userID, n); err != nil || sent != 0 {
		t.Fatalf("first send: sent=%d err=%v; want a rejection", sent, err)
	}
	if rows := readDeliveries(t, pool, tenantID); len(rows) != 1 || rows[0].Status != statusFailed {
		t.Fatalf("rows = %+v, want one failed row", rows)
	}

	// Nothing is due yet — the backoff is a minute out. A worker that ignored
	// it would hammer a push service that is already rate-limiting us.
	if retried, _, err := deps.RetryDue(ctx, time.Now().UTC(), 10); err != nil || retried != 0 {
		t.Fatalf("RetryDue before the backoff elapsed: retried=%d err=%v", retried, err)
	}

	// Now the service accepts, and the backoff has passed.
	reject.Store(false)
	before := hits.Load()
	retried, retired, err := deps.RetryDue(ctx, time.Now().UTC().Add(2*time.Minute), 10)
	if err != nil {
		t.Fatalf("RetryDue: %v", err)
	}
	if retired != 0 {
		t.Errorf("retired = %d on the first retry; the attempt budget is being "+
			"spent far too early", retired)
	}
	if retried != 1 {
		t.Fatalf("retried = %d, want 1 — the notification the user never received "+
			"is still not being re-sent, which is what the ledger promised", retried)
	}
	if hits.Load() <= before {
		t.Fatal("the push service was not called again")
	}
	rows := readDeliveries(t, pool, tenantID)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1 (same endpoint, same key)", len(rows))
	}
	if rows[0].Status != statusSent || !rows[0].Accepted || !rows[0].Terminal {
		t.Fatalf("after a successful retry the row is %+v; want sent, accepted, terminal", rows[0])
	}
	if rows[0].Attempts != 2 {
		t.Errorf("attempts = %d, want 2", rows[0].Attempts)
	}
}

// A permanently broken endpoint must stop, and say so. Retrying forever hides a
// dead subscription behind a growing attempt count.
func TestARepeatedlyFailingPushIsRetired(t *testing.T) {
	pool := deliveriesPool(t)
	ctx := context.Background()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-dead")
	notificationID := seedFeedRow(t, pool, tenantID, userID, "Approval needed")

	deps := pushDeps(t, pool, srv)
	n := Notification{Title: "Approval needed", NotificationID: notificationID}
	if _, err := deps.SendToUser(ctx, tenantID, userID, n); err != nil {
		t.Fatalf("send: %v", err)
	}
	// Sweep well past every backoff until the budget is spent.
	at := time.Now().UTC()
	for i := 0; i < maxSendAttempts+2; i++ {
		at = at.Add(2 * time.Hour)
		if _, _, err := deps.RetryDue(ctx, at, 10); err != nil {
			t.Fatalf("RetryDue %d: %v", i, err)
		}
	}
	rows := readDeliveries(t, pool, tenantID)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if !rows[0].Terminal {
		t.Fatalf("after %d sweeps the row is still not terminal (%+v); the worker "+
			"will keep offering a dead endpoint forever", maxSendAttempts+2, rows[0])
	}
	if rows[0].Attempts > maxSendAttempts+1 {
		t.Errorf("attempts = %d, past the %d budget", rows[0].Attempts, maxSendAttempts)
	}
}

// No feed row means no content. Inventing a title would deliver a notification
// whose text the person may no longer be entitled to see.
func TestARetryWithNoFeedRowSendsNothing(t *testing.T) {
	pool := deliveriesPool(t)
	ctx := context.Background()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	tenantID, userID := seedPushUser(t, pool, srv.URL+"/push/endpoint-orphan")

	deps := pushDeps(t, pool, srv)
	// A notification id that points at no feed row.
	n := Notification{Title: "Gone", NotificationID: uuid.NewString()}
	if _, err := deps.SendToUser(ctx, tenantID, userID, n); err != nil {
		t.Fatalf("send: %v", err)
	}
	before := hits.Load()
	retried, _, err := deps.RetryDue(ctx, time.Now().UTC().Add(2*time.Minute), 10)
	if err != nil {
		t.Fatalf("RetryDue: %v", err)
	}
	if retried != 0 || hits.Load() != before {
		t.Fatalf("a delivery whose feed row is gone was re-sent (retried=%d); the "+
			"worker fabricated content it no longer has", retried)
	}
}

// seedFeedRow creates the notification the retry worker rebuilds from.
func seedFeedRow(t *testing.T, pool *db.Pool, tenantID, userID, title string) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO notification_feed (tenant_id, user_id, kind, title, body, deep_link, event_type)
VALUES ($1::uuid, $2::uuid, 'approval', $3, 'body', '/app/x', 'approval.requested')
RETURNING id::text`, tenantID, userID, title).Scan(&id); err != nil {
		t.Fatalf("seed feed row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit feed row: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM notification_feed WHERE tenant_id = $1::uuid`, tenantID)
		_ = c.Commit(bg)
	})
	return id
}
