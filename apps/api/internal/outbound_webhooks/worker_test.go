// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// passthroughCipher is a no-op EnvelopeEncryptor used only by lease
// tests so seeded webhooks have a "decryptable" signing secret without
// pulling AES-GCM into the test path. Encrypt prepends a tag byte so
// Decrypt can sanity-check shape; both operations are deterministic.
type passthroughCipher struct{}

func (passthroughCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	out := make([]byte, 0, len(plaintext)+1)
	out = append(out, 0xFF)
	out = append(out, plaintext...)
	return out, nil
}

func (passthroughCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	if blob[0] == 0xFF {
		return blob[1:], nil
	}
	// Unknown blob (e.g. seeded directly without going through
	// Encrypt). Treat as empty plaintext — the worker uses the result
	// as an HMAC key, which doesn't care about emptiness for tests.
	return []byte("test-secret"), nil
}

type panicRoundTripper struct{}

func (panicRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	panic("boom")
}

// newWorkerTestPool / setup helpers mirror store_test.go.
func newWorkerTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed outbound_webhooks worker test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedDeliveriesAt inserts n pending delivery rows whose next_attempt_at
// is `at`. All n share one parent webhook, pointed at hookURL. Returns
// the created webhook id, a slice of delivery ids, and a cleanup func.
func seedDeliveriesAt(t *testing.T, pool *pgxpool.Pool, tenantID, hookURL string, n int, at time.Time) (string, []string, func()) {
	t.Helper()
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
	if _, err := conn.Exec(ctx,
		`INSERT INTO tenants (id, name, slug, tier) VALUES ($1::uuid, 'lease-worker-test', 'lease-worker-test' || right($1::text, 12), 'studio')
		   ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	// Encrypt a real secret so DecryptSecret returns something usable
	// in the HMAC step.
	cipher := passthroughCipher{}
	envBlob, err := cipher.Encrypt(ctx, []byte("test-secret"))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	destinationEnvelope, err := cipher.Encrypt(ctx, []byte(hookURL))
	if err != nil {
		t.Fatalf("encrypt destination: %v", err)
	}
	var webhookID string
	if err := conn.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config_state
) VALUES (
    $1::uuid, $2, $3, 'ready', ARRAY['campaign.sent']::text[], $4, true, 'ready'
)
RETURNING id::text`,
		tenantID, destinationDisplay(hookURL), destinationEnvelope, envBlob,
	).Scan(&webhookID); err != nil {
		t.Fatalf("seed webhook: %v", err)
	}
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		var rowID string
		if err := conn.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, payload, next_attempt_at, status
) VALUES (
    $1::uuid, $2::uuid, 'campaign.sent', '{"event":{"type":"campaign.sent"}}'::jsonb, $3, 'pending'
)
RETURNING id::text`, tenantID, webhookID, at).Scan(&rowID); err != nil {
			t.Fatalf("seed delivery %d: %v", i, err)
		}
		ids = append(ids, rowID)
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
	return webhookID, ids, cleanup
}

// TestWorker_OwnerIDFormat verifies NewWorker derives a non-empty owner
// from hostname + pid so leases attribute to the correct process.
func TestWorker_OwnerIDFormat(t *testing.T) {
	w := NewWorker(&Store{}, slog.Default())
	if w.Owner == "" {
		t.Fatal("NewWorker should set Owner; got empty string")
	}
	// pid is appended after a dash; check that it ends in a digit so
	// two workers in the same hostname (sibling replicas via Docker)
	// don't collide on the host portion alone.
	last := w.Owner[len(w.Owner)-1]
	if last < '0' || last > '9' {
		t.Fatalf("Owner = %q; expected trailing pid digit", w.Owner)
	}
	if w.LeaseDuration != DefaultLeaseDuration {
		t.Fatalf("LeaseDuration = %v; want %v", w.LeaseDuration, DefaultLeaseDuration)
	}
	if w.Concurrency != DefaultConcurrency {
		t.Fatalf("Concurrency = %d; want %d", w.Concurrency, DefaultConcurrency)
	}
}

// TestWorker_TickDeliversExactlyOnceAcrossWorkers boots three workers
// against the same pool with a shared HTTP target and 10 pending rows.
// We expect exactly 10 hits at the upstream (no double-fires, no drops)
// even though every worker is racing AcquireLease on the same set.
func TestWorker_TickDeliversExactlyOnceAcrossWorkers(t *testing.T) {
	pool := newWorkerTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000cc0001"

	// HTTP target that just counts hits and 200s.
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, ids, cleanup := seedDeliveriesAt(t, pool, tenantID, srv.URL, 10, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	store := &Store{Pool: (*db.Pool)(pool), Cipher: passthroughCipher{}}
	makeWorker := func(name string) *Worker {
		w := &Worker{
			Store:         store,
			HTTPClient:    &http.Client{Timeout: 3 * time.Second},
			Logger:        slog.Default(),
			Owner:         name,
			LeaseDuration: 30 * time.Second,
			ClaimBatch:    4, // small batch so each worker grabs <10 rows per tick
			Concurrency:   2,
		}
		return w
	}
	workers := []*Worker{makeWorker("w-A"), makeWorker("w-B"), makeWorker("w-C")}

	// Each worker runs tick repeatedly until it sees an empty batch
	// twice in a row (so we don't terminate while another worker has
	// rows in-flight that may still be released).
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	wg.Add(len(workers))
	for _, w := range workers {
		w := w
		go func() {
			defer wg.Done()
			emptySweeps := 0
			for ctx.Err() == nil && emptySweeps < 3 {
				n, err := w.tick(ctx)
				if err != nil {
					t.Logf("%s tick err: %v", w.Owner, err)
				}
				if n == 0 {
					emptySweeps++
					time.Sleep(50 * time.Millisecond)
				} else {
					emptySweeps = 0
				}
			}
		}()
	}
	wg.Wait()

	got := atomic.LoadInt64(&hits)
	if got != int64(len(ids)) {
		t.Fatalf("hits = %d; want %d (no double-fires, no drops)", got, len(ids))
	}
	// Verify every row finalised to 'delivered'.
	conn, _ := pool.Acquire(ctx)
	defer conn.Release()
	_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
	for _, id := range ids {
		var status string
		if err := conn.QueryRow(ctx,
			`SELECT status FROM outbound_webhook_deliveries WHERE id::text = $1`,
			id).Scan(&status); err != nil {
			t.Fatalf("verify status: %v", err)
		}
		if status != "delivered" {
			t.Fatalf("row %s status = %q; want delivered", id, status)
		}
	}
}

// TestWorker_StaleLeaseRecovery seeds a row with lease_expires_at in
// the past (simulating an OOM-killed worker that never marked the row)
// and confirms a fresh worker's tick takes it over.
func TestWorker_StaleLeaseRecovery(t *testing.T) {
	pool := newWorkerTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000cc0002"
	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	_, ids, cleanup := seedDeliveriesAt(t, pool, tenantID, srv.URL, 1, time.Now().UTC().Add(-time.Second))
	defer cleanup()
	rowID := ids[0]

	ctx := context.Background()
	conn, _ := pool.Acquire(ctx)
	_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
	if _, err := conn.Exec(ctx,
		`UPDATE outbound_webhook_deliveries
		    SET lease_owner = 'dead-worker',
		        lease_expires_at = now() - interval '1 minute'
		  WHERE id::text = $1`, rowID); err != nil {
		conn.Release()
		t.Fatalf("seed stale lease: %v", err)
	}
	conn.Release()

	store := &Store{Pool: (*db.Pool)(pool), Cipher: passthroughCipher{}}
	w := &Worker{
		Store:         store,
		HTTPClient:    &http.Client{Timeout: 3 * time.Second},
		Logger:        slog.Default(),
		Owner:         "recovery-worker",
		LeaseDuration: 30 * time.Second,
		ClaimBatch:    5,
		Concurrency:   1,
	}
	if _, err := w.tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if got := atomic.LoadInt64(&hits); got < 1 {
		t.Fatalf("stale-lease row was not picked up (hits = %d)", got)
	}
}

// TestWorker_ReleaseLeaseOnCancel verifies that when ctx cancels
// mid-batch, the in-flight rows have their leases released so a
// sibling worker can pick them up immediately (rather than waiting
// the full lease TTL).
func TestWorker_ReleaseLeaseOnCancel(t *testing.T) {
	pool := newWorkerTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000cc0003"

	// Slow upstream: every request blocks for 2s. With ctx cancelled
	// after 100ms, the worker pool's individual delivery goroutines
	// are mid-HTTP when cancel fires; only rows still in the channel
	// (not yet picked up by a goroutine) get the release path. To
	// exercise that path reliably, we use Concurrency=1 + batch=5 so
	// 4 rows sit in the channel while the goroutine is mid-HTTP.
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
			w.WriteHeader(http.StatusOK)
		case <-r.Context().Done():
			return
		}
	}))
	defer slow.Close()

	_, ids, cleanup := seedDeliveriesAt(t, pool, tenantID, slow.URL, 5, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	store := &Store{Pool: (*db.Pool)(pool), Cipher: passthroughCipher{}}
	w := &Worker{
		Store:         store,
		HTTPClient:    &http.Client{Timeout: 5 * time.Second},
		Logger:        slog.Default(),
		Owner:         "cancel-worker",
		LeaseDuration: 30 * time.Second,
		ClaimBatch:    5,
		Concurrency:   1, // serial so most rows sit in the chan during cancel
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	_, _ = w.tick(ctx)

	// Inspect: at least one row should have lease cleared via the
	// ctx-cancel release path (the rest of the rows still in the chan
	// when cancel fired). Use a fresh context — the worker context is
	// already cancelled.
	checkCtx := context.Background()
	conn, _ := pool.Acquire(checkCtx)
	defer conn.Release()
	_, _ = conn.Exec(checkCtx, "SELECT set_config('app.outbox_worker', 'true', false)")
	cleared := 0
	for _, id := range ids {
		var owner *string
		if err := conn.QueryRow(checkCtx,
			`SELECT lease_owner FROM outbound_webhook_deliveries WHERE id::text = $1`,
			id).Scan(&owner); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if owner == nil {
			cleared++
		}
	}
	if cleared == 0 {
		t.Fatal("expected at least one row's lease cleared via cancel-path ReleaseLease")
	}
}

func TestWorker_DeliveryPanicMarksFailureAndClearsLease(t *testing.T) {
	pool := newWorkerTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000cc0004"

	_, ids, cleanup := seedDeliveriesAt(t, pool, tenantID, "https://example.test/webhook", 1, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	store := &Store{Pool: (*db.Pool)(pool), Cipher: passthroughCipher{}}
	w := &Worker{
		Store:         store,
		HTTPClient:    &http.Client{Transport: panicRoundTripper{}},
		Logger:        slog.Default(),
		Owner:         "panic-worker",
		LeaseDuration: 30 * time.Second,
		ClaimBatch:    1,
		Concurrency:   1,
	}
	if _, err := w.tick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}

	checkCtx := context.Background()
	conn, err := pool.Acquire(checkCtx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	_, _ = conn.Exec(checkCtx, "SELECT set_config('app.outbox_worker', 'true', false)")
	var (
		status      string
		attempts    int
		lastError   string
		owner       *string
		nextAttempt *time.Time
	)
	if err := conn.QueryRow(checkCtx, `
SELECT status, attempt_count, COALESCE(last_error, ''), lease_owner, next_attempt_at
  FROM outbound_webhook_deliveries
 WHERE id::text = $1`, ids[0]).Scan(&status, &attempts, &lastError, &owner, &nextAttempt); err != nil {
		t.Fatalf("scan delivery: %v", err)
	}
	if status != "pending" {
		t.Fatalf("status = %q; want pending retry", status)
	}
	if attempts != 1 {
		t.Fatalf("attempt_count = %d; want 1", attempts)
	}
	if lastError != "worker panic" || strings.Contains(lastError, "boom") {
		t.Fatalf("last_error = %q; want non-sensitive panic classification", lastError)
	}
	if owner != nil {
		t.Fatalf("lease_owner = %q; want cleared", *owner)
	}
	if nextAttempt == nil {
		t.Fatal("next_attempt_at is nil; want retry scheduled")
	}
}

func TestWorker_DeliveryConfigFailureDoesNotSendRawPayload(t *testing.T) {
	pool := newWorkerTestPool(t)
	tenantID := "00000000-0000-0000-0000-000000cc0005"

	var hits int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	webhookID, ids, cleanup := seedDeliveriesAt(t, pool, tenantID, srv.URL, 1, time.Now().UTC().Add(-time.Second))
	defer cleanup()

	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	// The tenants INSERT policy is `id = current_setting('app.tenant_id')`;
	// worker scope alone leaves that unset, so every seed was rejected and the
	// Skipf reported it as a PASS.
	if _, err := conn.Exec(ctx, "SELECT set_config('app.tenant_id', $1, false)", tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant scope: %v", err)
	}
	if _, err := conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)"); err != nil {
		conn.Release()
		t.Fatalf("set worker scope: %v", err)
	}
	if _, err := conn.Exec(ctx, `
UPDATE outbound_webhooks
   SET filter_expression = 'not a valid filter',
       config_version = config_version + 1
 WHERE id::text = $1`, webhookID); err != nil {
		conn.Release()
		t.Fatalf("corrupt delivery config: %v", err)
	}
	conn.Release()

	store := &Store{Pool: (*db.Pool)(pool), Cipher: passthroughCipher{}}
	worker := &Worker{
		Store:      store,
		HTTPClient: srv.Client(),
		Logger:     slog.Default(),
	}
	worker.deliver(ctx, PendingDelivery{
		ID:           ids[0],
		TenantID:     tenantID,
		WebhookID:    webhookID,
		URL:          srv.URL,
		EventType:    "campaign.sent",
		Payload:      []byte(`{"event":{"type":"campaign.sent"}}`),
		AttemptCount: 0,
	})

	if got := atomic.LoadInt64(&hits); got != 0 {
		t.Fatalf("receiver hits = %d; want 0 when delivery config cannot load", got)
	}
	conn, err = pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("reacquire: %v", err)
	}
	defer conn.Release()
	_, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', false)")
	var (
		status    string
		attempts  int
		lastError string
	)
	if err := conn.QueryRow(ctx, `
SELECT status, attempt_count, COALESCE(last_error, '')
  FROM outbound_webhook_deliveries
 WHERE id::text = $1`, ids[0]).Scan(&status, &attempts, &lastError); err != nil {
		t.Fatalf("load failed delivery: %v", err)
	}
	if status != "exhausted" || attempts != 1 {
		t.Fatalf("terminal state = (%q, %d); want (exhausted, 1)", status, attempts)
	}
	if lastError != "delivery configuration unavailable" {
		t.Fatalf("last_error = %q; want stable redacted configuration error", lastError)
	}
}
