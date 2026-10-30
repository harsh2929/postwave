package mobilepush

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestMobilePushWorkerCapabilityFencesSecurityDelivery(t *testing.T) {
	pool := mobilePushTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	insertMobilePushRecoveryFixture(t, pool, tenantID, userID, deviceID)
	defer deleteMobilePushFixture(t, pool, tenantID)

	deps := &Deps{Pool: pool}
	security := Notification{
		EventType:      "auth.new_device_sign_in",
		EntityID:       "MDEyMzQ1Njc4OWFiY2RlZg",
		IdempotencyKey: "security-capability:" + userID,
		NotificationID: uuid.NewString(),
	}
	routine := Notification{
		EventType:      "campaign.sent",
		EntityID:       uuid.NewString(),
		IdempotencyKey: "routine-capability:" + userID,
		NotificationID: uuid.NewString(),
	}
	for _, notice := range []*Notification{&security, &routine} {
		if err := normalizeNotification(notice); err != nil {
			t.Fatalf("normalizeNotification(%s): %v", notice.EventType, err)
		}
	}
	securityID, _, claimed, err := deps.claimDelivery(ctx, tenantID, userID, deviceID, security)
	if err != nil || !claimed {
		t.Fatalf("claim security delivery: id=%q claimed=%v err=%v", securityID, claimed, err)
	}
	routineID, _, claimed, err := deps.claimDelivery(ctx, tenantID, userID, deviceID, routine)
	if err != nil || !claimed {
		t.Fatalf("claim routine delivery: id=%q claimed=%v err=%v", routineID, claimed, err)
	}

	legacyTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("legacy worker scope: %v", err)
	}
	var legacySecurity, legacyRoutine bool
	if err := legacyTx.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM mobile_push_deliveries WHERE id = $1::uuid),
       EXISTS (SELECT 1 FROM mobile_push_deliveries WHERE id = $2::uuid)`,
		securityID, routineID).Scan(&legacySecurity, &legacyRoutine); err != nil {
		_ = legacyTx.Rollback(ctx)
		t.Fatalf("legacy worker visibility: %v", err)
	}
	if err := legacyTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback legacy worker: %v", err)
	}
	if legacySecurity || !legacyRoutine {
		t.Fatalf("legacy visibility = security:%v routine:%v; want false/true", legacySecurity, legacyRoutine)
	}

	compatibleTx, err := withMobilePushWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("compatible worker scope: %v", err)
	}
	var compatibleSecurity, compatibleRoutine bool
	if err := compatibleTx.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM mobile_push_deliveries WHERE id = $1::uuid),
       EXISTS (SELECT 1 FROM mobile_push_deliveries WHERE id = $2::uuid)`,
		securityID, routineID).Scan(&compatibleSecurity, &compatibleRoutine); err != nil {
		_ = compatibleTx.Rollback(ctx)
		t.Fatalf("compatible worker visibility: %v", err)
	}
	if err := compatibleTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback compatible worker: %v", err)
	}
	if !compatibleSecurity || !compatibleRoutine {
		t.Fatalf("compatible visibility = security:%v routine:%v; want true/true", compatibleSecurity, compatibleRoutine)
	}
}

func TestPostgresSendRetryPreservesNotificationIdentityAfterClaimCrash(t *testing.T) {
	pool := mobilePushTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	insertMobilePushRecoveryFixture(t, pool, tenantID, userID, deviceID)
	defer deleteMobilePushFixture(t, pool, tenantID)

	var sent expoDeliveryMessage
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Errorf("decode Expo request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-recovered"}}`))
	}))
	defer server.Close()

	deps := &Deps{
		Pool:       pool,
		Cipher:     testCipher{plaintext: []byte("ExpoPushToken[recovery-device]")},
		HTTPClient: server.Client(),
		ExpoURL:    server.URL,
	}
	notificationID := uuid.NewString()
	notice := Notification{
		EventType:      "auth.new_device_sign_in",
		EntityID:       "MDEyMzQ1Njc4OWFiY2RlZg",
		IdempotencyKey: "auth.new_device_sign_in:MDEyMzQ1Njc4OWFiY2RlZg:" + userID,
		NotificationID: notificationID,
	}
	if err := normalizeNotification(&notice); err != nil {
		t.Fatalf("normalizeNotification: %v", err)
	}
	deliveryID, attempts, claimed, err := deps.claimDelivery(ctx, tenantID, userID, deviceID, notice)
	if err != nil {
		t.Fatalf("claimDelivery: %v", err)
	}
	if !claimed || deliveryID == "" || attempts != 1 {
		t.Fatalf("initial claim = id=%q attempts=%d claimed=%v", deliveryID, attempts, claimed)
	}

	// Model a process crash immediately after the durable claim commits: no
	// first send occurs. Once its lease expires, the real PostgreSQL retry
	// projection must reconstruct the same cross-channel identity.
	retryAt := time.Now().UTC().Add(2 * deliveryAttemptLease)
	worker := &ReceiptWorker{Deps: deps, BatchSize: 1, Now: func() time.Time { return retryAt }}
	if err := worker.Tick(ctx); err != nil {
		t.Fatalf("retry Tick: %v", err)
	}
	if requests != 1 {
		t.Fatalf("Expo requests = %d, want 1", requests)
	}
	if sent.Data["notification_id"] != notificationID {
		t.Fatalf("retried notification_id = %q, want original %q", sent.Data["notification_id"], notificationID)
	}
	if sent.Data["event_type"] != notice.EventType || sent.Data["entity_id"] != notice.EntityID || len(sent.Data) != 3 {
		t.Fatalf("retried Expo data = %#v", sent.Data)
	}
	assertDeliveryState(t, pool, tenantID, deliveryID, "accepted", "", false)
}

func TestPostgresReceiptLifecycleClaimsLeasesAndTerminalState(t *testing.T) {
	pool := mobilePushTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	otherDeviceID := uuid.NewString()
	acceptedID := uuid.NewString()
	retryID := uuid.NewString()
	receiptExhaustedID := uuid.NewString()
	sendExhaustedID := uuid.NewString()
	insertMobilePushFixture(t, pool, tenantID, userID, deviceID, otherDeviceID, acceptedID, retryID, receiptExhaustedID, sendExhaustedID)
	defer deleteMobilePushFixture(t, pool, tenantID)

	store := &postgresDeliveryLifecycleStore{pool: pool}
	now := time.Now().UTC()
	receipts, receiptsErr := store.ClaimReceipts(ctx, now, now.Add(receiptClaimLease), 10)
	if receiptsErr != nil {
		t.Fatalf("ClaimReceipts: %v", receiptsErr)
	}
	if len(receipts) != 1 || receipts[0].ID != acceptedID || receipts[0].ReceiptAttempts != 1 {
		t.Fatalf("receipt claims = %#v", receipts)
	}
	if again, err := store.ClaimReceipts(ctx, now, now.Add(receiptClaimLease), 10); err != nil || len(again) != 0 {
		t.Fatalf("leased receipt was reclaimed: claims=%#v err=%v", again, err)
	}
	assertDeliveryState(t, pool, tenantID, receiptExhaustedID, "failed", "receipt_attempts_exhausted", false)
	if err := store.MarkDelivered(ctx, receipts[0]); err != nil {
		t.Fatalf("MarkDelivered: %v", err)
	}
	assertDeliveryState(t, pool, tenantID, acceptedID, "delivered", "", true)

	retries, receiptsErr := store.ClaimSendRetries(ctx, now, now.Add(deliveryAttemptLease), 10)
	if receiptsErr != nil {
		t.Fatalf("ClaimSendRetries: %v", receiptsErr)
	}
	if len(retries) != 1 || retries[0].ID != retryID || retries[0].Attempts != 2 {
		t.Fatalf("send retry claims = %#v", retries)
	}
	if retries[0].Device.ID != deviceID || string(retries[0].Device.Envelope) != "retry-envelope" || retries[0].Notice.IdempotencyKey != "campaign.sent:db-retry" || retries[0].Notice.NotificationID != "" {
		t.Fatalf("send retry payload = %#v", retries[0])
	}
	if again, err := store.ClaimSendRetries(ctx, now, now.Add(deliveryAttemptLease), 10); err != nil || len(again) != 0 {
		t.Fatalf("leased send was reclaimed: claims=%#v err=%v", again, err)
	}
	assertDeliveryState(t, pool, tenantID, sendExhaustedID, "failed", "send_attempts_exhausted", false)
	if err := store.MarkAccepted(ctx, retries[0], "ticket-retried", now.Add(initialReceiptDelay)); err != nil {
		t.Fatalf("MarkAccepted: %v", err)
	}
	assertDeliveryState(t, pool, tenantID, retryID, "accepted", "", false)

	if err := store.RevokeDevice(ctx, tenantID, userID, deviceID, retryID, "DeviceNotRegistered"); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	assertDeliveryState(t, pool, tenantID, retryID, "revoked", "DeviceNotRegistered", false)
	tx, receiptsErr := pool.Begin(ctx)
	if receiptsErr != nil {
		t.Fatalf("begin verify: %v", receiptsErr)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope verify: %v", err)
	}
	var status string
	var envelope []byte
	if err := tx.QueryRow(ctx, `SELECT status, token_envelope FROM mobile_push_devices WHERE id = $1::uuid`, deviceID).Scan(&status, &envelope); err != nil {
		t.Fatalf("read revoked device: %v", err)
	}
	if status != "revoked" || envelope != nil {
		t.Fatalf("revoked device status/envelope = %q %x", status, envelope)
	}
	var otherStatus string
	if err := tx.QueryRow(ctx, `SELECT status FROM mobile_push_devices WHERE id = $1::uuid`, otherDeviceID).Scan(&otherStatus); err != nil {
		t.Fatalf("read other device: %v", err)
	}
	if otherStatus != "active" {
		t.Fatalf("other device was affected: %q", otherStatus)
	}
}

func mobilePushTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed mobile push receipt test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping: %v", err)
	}
	var present bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'mobile_push_deliveries'
       AND column_name = 'notification_id'
)`).Scan(&present); err != nil || !present {
		pool.Close()
		t.Fatalf("migration 1858 is required before mobile push DB tests (present=%v err=%v)", present, err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func insertMobilePushRecoveryFixture(t *testing.T, pool *pgxpool.Pool, tenantID, userID, deviceID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin recovery fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope recovery fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Push recovery test', 'studio')`, tenantID, "push-recovery-"+tenantID); err != nil {
		t.Fatalf("insert recovery tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`, userID, tenantID, "push-recovery-user-"+userID, userID+"@example.test"); err != nil {
		t.Fatalf("insert recovery user: %v", err)
	}
	keyDigest := sha256.Sum256([]byte("recovery-device-key-" + deviceID))
	tokenDigest := sha256.Sum256([]byte("recovery-token-" + deviceID))
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_devices (
    id, tenant_id, user_id, device_key_digest, token_digest, token_envelope,
    platform, enabled_events, status
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
    'ios', ARRAY['auth.new_device_sign_in'], 'active'
)`, deviceID, tenantID, userID, keyDigest[:], tokenDigest[:], []byte("recovery-envelope")); err != nil {
		t.Fatalf("insert recovery device: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit recovery fixture: %v", err)
	}
}

func insertMobilePushFixture(t *testing.T, pool *pgxpool.Pool, tenantID, userID, deviceID, otherDeviceID, acceptedID, retryID, receiptExhaustedID, sendExhaustedID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Push receipt test', 'studio')`, tenantID, "push-test-"+tenantID); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`, userID, tenantID, "push-user-"+userID, userID+"@example.test"); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	for i, fixture := range []struct {
		id       string
		envelope string
	}{
		{deviceID, "retry-envelope"},
		{otherDeviceID, "other-envelope"},
	} {
		keyDigest := sha256.Sum256([]byte("device-key-" + fixture.id))
		tokenDigest := sha256.Sum256([]byte("token-" + fixture.id))
		if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_devices (
    id, tenant_id, user_id, device_key_digest, token_digest, token_envelope,
    platform, enabled_events, status
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, ARRAY['campaign.sent'], 'active')`, fixture.id, tenantID, userID, keyDigest[:], tokenDigest[:], []byte(fixture.envelope), []string{"ios", "android"}[i]); err != nil {
			t.Fatalf("insert device %d: %v", i, err)
		}
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_deliveries (
    id, tenant_id, user_id, device_id, event_type, idempotency_key,
    title, body, category_id, status, expo_ticket_id, attempts,
    receipt_attempts, next_retry_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'campaign.sent',
    'campaign.sent:db-accepted', 'Campaign sent', 'A campaign finished sending.',
    'entity', 'accepted', 'ticket-db-accepted', 1, 0, now() - interval '1 minute'
)`, acceptedID, tenantID, userID, otherDeviceID); err != nil {
		t.Fatalf("insert accepted delivery: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_deliveries (
    id, tenant_id, user_id, device_id, event_type, idempotency_key,
    title, body, category_id, status, error_code, attempts, next_retry_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'campaign.sent',
    'campaign.sent:db-retry', 'Campaign sent', 'A campaign finished sending.',
    'entity', 'failed', 'upstream_unavailable', 1, now() - interval '1 minute'
)`, retryID, tenantID, userID, deviceID); err != nil {
		t.Fatalf("insert retry delivery: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_deliveries (
    id, tenant_id, user_id, device_id, event_type, idempotency_key,
    title, body, category_id, status, expo_ticket_id, attempts,
    receipt_attempts, next_retry_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'campaign.sent',
    'campaign.sent:db-receipt-exhausted', 'Campaign sent', 'A campaign finished sending.',
    'entity', 'accepted', 'ticket-db-exhausted', 1, $5, now() - interval '1 minute'
)`, receiptExhaustedID, tenantID, userID, otherDeviceID, maxReceiptAttempts); err != nil {
		t.Fatalf("insert receipt-exhausted delivery: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_deliveries (
    id, tenant_id, user_id, device_id, event_type, idempotency_key,
    title, body, category_id, status, error_code, attempts, next_retry_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'campaign.sent',
    'campaign.sent:db-send-exhausted', 'Campaign sent', 'A campaign finished sending.',
    'entity', 'failed', NULL, $5, now() - interval '1 minute'
)`, sendExhaustedID, tenantID, userID, deviceID, maxSendAttempts); err != nil {
		t.Fatalf("insert send-exhausted delivery: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
}

func assertDeliveryState(t *testing.T, pool *pgxpool.Pool, tenantID, deliveryID, wantStatus, wantCode string, wantDelivered bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin delivery assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope delivery assertion: %v", err)
	}
	var status string
	var code *string
	var deliveredAt *time.Time
	var terminalAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT status, error_code, delivered_at, terminal_at FROM mobile_push_deliveries WHERE id = $1::uuid`, deliveryID).Scan(&status, &code, &deliveredAt, &terminalAt); err != nil {
		t.Fatalf("read delivery: %v", err)
	}
	gotCode := ""
	if code != nil {
		gotCode = *code
	}
	wantTerminal := wantStatus == "delivered" || wantStatus == "revoked" || wantCode == "receipt_attempts_exhausted" || wantCode == "send_attempts_exhausted"
	if status != wantStatus || gotCode != wantCode || (deliveredAt != nil) != wantDelivered || (terminalAt != nil) != wantTerminal {
		t.Fatalf("delivery state = status=%q code=%q delivered=%v terminal=%v; want %q %q %v %v", status, gotCode, deliveredAt != nil, terminalAt != nil, wantStatus, wantCode, wantDelivered, wantTerminal)
	}
}

func deleteMobilePushFixture(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, _ = tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID)
	_, _ = tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	_ = tx.Commit(ctx)
}
