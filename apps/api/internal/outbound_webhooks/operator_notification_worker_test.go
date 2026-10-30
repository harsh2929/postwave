// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type recordingAutoDisableNotifier struct {
	mu    sync.Mutex
	calls [][2]string
	err   error
}

func (n *recordingAutoDisableNotifier) NotifyWebhookAutoDisabled(
	_ context.Context,
	tenantID,
	webhookID string,
) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, [2]string{tenantID, webhookID})
	return n.err
}

func (n *recordingAutoDisableNotifier) callCount() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.calls)
}

func cleanupOperatorNotificationTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenantWorker(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Errorf("open operator-notification cleanup transaction: %v", err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, query := range []string{
		`DELETE FROM outbound_webhook_operator_notifications WHERE tenant_id = $1::uuid`,
		`DELETE FROM outbound_webhooks WHERE tenant_id = $1::uuid`,
		`DELETE FROM tenants WHERE id = $1::uuid`,
	} {
		if _, err := tx.Exec(ctx, query, tenantID); err != nil {
			t.Errorf("clean operator-notification fixture: %v", err)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Errorf("commit operator-notification cleanup: %v", err)
	}
}

func TestAutoDisableTransitionQueuesAndDrainsDurableNotification(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000001798"

	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"operator-notification-test",
		"operator-notification-test"+tenantID[len(tenantID)-12:],
	)
	t.Cleanup(func() { cleanupOperatorNotificationTenant(t, pool, tenantID) })

	seedTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("tenant seed tx: %v", err)
	}
	var webhookID, deliveryID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhooks (
    tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config, auth_config_state, consecutive_failures
)
VALUES (
    $1::uuid, 'https://receiver.example.test/…', '\x01'::bytea, 'ready',
    ARRAY['campaign.sent']::text[], '\x01'::bytea,
    true, '{}'::jsonb, 'ready', $2
)
RETURNING id::text`,
		tenantID, AutoDisableThreshold-1,
	).Scan(&webhookID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed webhook (latest migrations may be absent): %v", err)
	}
	if err := seedTx.QueryRow(ctx, `
INSERT INTO outbound_webhook_deliveries (
    tenant_id, webhook_id, event_type, payload, status, next_attempt_at
)
VALUES (
    $1::uuid, $2::uuid, 'campaign.sent', '{"event":{}}'::jsonb,
    'pending', now()
)
RETURNING id::text`,
		tenantID, webhookID,
	).Scan(&deliveryID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed delivery: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	store := &Store{Pool: (*db.Pool)(pool)}
	_, autoDisabled, err := store.MarkFailure(ctx, PendingDelivery{
		ID:           deliveryID,
		TenantID:     tenantID,
		WebhookID:    webhookID,
		EventType:    "campaign.sent",
		AttemptCount: 0,
	}, 503, "", errors.New("receiver unavailable"), false)
	if err != nil {
		t.Fatalf("mark failure (migration 1798 may be absent): %v", err)
	}
	if !autoDisabled {
		t.Fatal("threshold transition did not auto-disable")
	}

	notifier := &recordingAutoDisableNotifier{}
	worker := &AutoDisableNotificationWorker{
		Pool:          (*db.Pool)(pool),
		Notifier:      notifier,
		Owner:         "notification-worker-test",
		BatchSize:     10,
		LeaseDuration: time.Minute,
	}
	count, err := worker.runOnce(ctx)
	if err != nil {
		t.Fatalf("drain notification: %v", err)
	}
	if count != 1 || notifier.callCount() != 1 {
		t.Fatalf("drain count/calls = %d/%d, want 1/1", count, notifier.callCount())
	}

	checkTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = checkTx.Rollback(ctx) }()
	var status string
	var sentAt *time.Time
	if err := checkTx.QueryRow(ctx, `
SELECT status, sent_at
  FROM outbound_webhook_operator_notifications
 WHERE tenant_id = $1::uuid AND webhook_id = $2::uuid`,
		tenantID, webhookID,
	).Scan(&status, &sentAt); err != nil {
		t.Fatal(err)
	}
	if status != "sent" || sentAt == nil {
		t.Fatalf("notification status/sent_at = %q/%v, want sent/non-nil", status, sentAt)
	}
}

func TestOperatorNotificationFailureIsRescheduledWithoutSensitiveContext(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000011798"
	webhookID := "00000000-0000-4000-8000-000000021798"

	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"operator-notification-retry-test",
		"operator-notification-retry-test"+tenantID[len(tenantID)-12:],
	)
	fixtureTx, err := db.WithTenantWorker(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatalf("open operator-notification fixture transaction: %v", err)
	}
	defer func() { _ = fixtureTx.Rollback(ctx) }()
	if _, err := fixtureTx.Exec(ctx, `
INSERT INTO outbound_webhooks (
    id, tenant_id, url, url_envelope, url_state, events, secret_envelope,
    active, auth_config, auth_config_state
)
VALUES (
    $1::uuid, $2::uuid, 'https://receiver.example.test/…',
    '\x01'::bytea, 'ready', ARRAY['campaign.sent']::text[], '\x01'::bytea,
    true, '{}'::jsonb, 'ready'
)`,
		webhookID, tenantID,
	); err != nil {
		t.Fatalf("seed webhook (latest migrations may be absent): %v", err)
	}
	if _, err := fixtureTx.Exec(ctx, `
INSERT INTO outbound_webhook_operator_notifications (
    tenant_id, webhook_id, kind, status, next_attempt_at
)
VALUES ($1::uuid, $2::uuid, 'auto_disabled', 'pending', now())`,
		tenantID, webhookID,
	); err != nil {
		t.Fatalf("seed notification (migration 1798 may be absent): %v", err)
	}
	if err := fixtureTx.Commit(ctx); err != nil {
		t.Fatalf("commit operator-notification fixture: %v", err)
	}
	t.Cleanup(func() { cleanupOperatorNotificationTenant(t, pool, tenantID) })

	secretLikeError := "mailer failed with token=must-not-be-logged-verbatim"
	notifier := &recordingAutoDisableNotifier{err: errors.New(secretLikeError)}
	worker := &AutoDisableNotificationWorker{
		Pool: (*db.Pool)(pool), Notifier: notifier, Owner: "retry-worker",
	}
	if count, err := worker.runOnce(ctx); err != nil || count != 1 {
		t.Fatalf("runOnce count/error = %d/%v", count, err)
	}

	tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status, lastError string
	var attempts int
	var nextAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT status, attempts, next_attempt_at, COALESCE(last_error, '')
  FROM outbound_webhook_operator_notifications
 WHERE tenant_id = $1::uuid AND webhook_id = $2::uuid`,
		tenantID, webhookID,
	).Scan(&status, &attempts, &nextAt, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 1 || nextAt == nil || !nextAt.After(time.Now()) {
		t.Fatalf("retry state = %q attempts=%d next=%v", status, attempts, nextAt)
	}
	if lastError == secretLikeError ||
		strings.Contains(lastError, "must-not-be-logged-verbatim") ||
		!strings.Contains(lastError, playgroundRedactedValue) {
		t.Fatalf("last error was not safely redacted: %q", lastError)
	}
}

func TestReEnableFinalizesStalePendingOperatorNotification(t *testing.T) {
	pool := newStoreTestPool(t)
	ctx := context.Background()
	tenantID := "00000000-0000-4000-8000-000000031798"

	seedStoreTestTenant(
		t,
		pool,
		tenantID,
		"operator-notification-reenable-test",
		"operator-notification-reenable-test"+tenantID[len(tenantID)-12:],
	)
	t.Cleanup(func() { cleanupOperatorNotificationTenant(t, pool, tenantID) })

	store := &Store{
		Pool:         (*db.Pool)(pool),
		Cipher:       xorAuthCipher{},
		RequireHTTPS: true,
	}
	created, err := store.Create(ctx, tenantID, "", CreateInput{
		URL:    "https://receiver.example.test/hooks/operator",
		Events: []string{"campaign.sent"},
	}, true)
	if err != nil {
		t.Fatalf("create endpoint (latest migrations may be absent): %v", err)
	}
	tx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE outbound_webhooks
   SET active = false,
       disabled_reason = 'auto_failures',
       disabled_at = now(),
       config_version = config_version + 1
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, created.Webhook.ID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbound_webhook_operator_notifications (
    tenant_id, webhook_id, kind, status, next_attempt_at
)
VALUES ($1::uuid, $2::uuid, 'auto_disabled', 'pending', now())`,
		tenantID, created.Webhook.ID,
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed notification (migration 1798 may be absent): %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if err := store.ReEnable(ctx, tenantID, created.Webhook.ID); err != nil {
		t.Fatalf("re-enable: %v", err)
	}
	checkTx, err := db.WithTenant(ctx, (*db.Pool)(pool), tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = checkTx.Rollback(ctx) }()
	var status, lastError string
	var exhaustedAt *time.Time
	if err := checkTx.QueryRow(ctx, `
SELECT status, COALESCE(last_error, ''), exhausted_at
  FROM outbound_webhook_operator_notifications
 WHERE tenant_id = $1::uuid AND webhook_id = $2::uuid`,
		tenantID, created.Webhook.ID,
	).Scan(&status, &lastError, &exhaustedAt); err != nil {
		t.Fatal(err)
	}
	if status != "exhausted" ||
		exhaustedAt == nil ||
		!strings.Contains(lastError, "re-enabled") {
		t.Fatalf(
			"re-enabled notification = status:%q exhausted:%v error:%q",
			status,
			exhaustedAt,
			lastError,
		)
	}
}
