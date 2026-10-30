// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestSendToUserSuppressesInsideQuietHours is the end-to-end proof for
// SHELL#12: the same notification, the same device, two different instants —
// inside the window nothing reaches Expo and a terminal `suppressed` row
// records why; outside it the ordinary delivery happens.
func TestSendToUserSuppressesInsideQuietHours(t *testing.T) {
	pool := mobilePushTestPool(t)
	requireQuietHoursColumns(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var expoCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		expoCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-quiet"}}`))
	}))
	defer server.Close()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	deviceKey := "quiet-" + deviceID
	insertQuietHoursDevice(t, pool, tenantID, userID, deviceID, deviceKey, quietHoursSettings{
		Enabled: true, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: "Europe/Berlin",
	})
	defer deleteMobilePushFixture(t, pool, tenantID)

	inside := mustParseBerlin(t, "2026-07-27 02:30")
	deps := &Deps{
		Pool:       pool,
		Cipher:     testCipher{plaintext: []byte("ExpoPushToken[quiet-device]")},
		HTTPClient: server.Client(),
		ExpoURL:    server.URL + "/--/api/v2/push/send",
		Now:        func() time.Time { return inside },
	}
	notice := Notification{
		EventType: "campaign.sent", EntityID: "campaign-1",
		IdempotencyKey: "campaign.sent:quiet-window", Title: "Campaign sent",
		Body: "A campaign finished sending.",
	}
	accepted, err := deps.SendToUser(ctx, tenantID, userID, notice)
	if err != nil {
		t.Fatalf("SendToUser inside the window: %v", err)
	}
	if accepted != 0 {
		t.Fatalf("accepted = %d inside quiet hours, want 0", accepted)
	}
	if got := expoCalls.Load(); got != 0 {
		t.Fatalf("Expo was called %d times inside quiet hours; the push was not suppressed", got)
	}
	assertDeliveryStatus(t, pool, tenantID, "campaign.sent:quiet-window", "suppressed", "quiet_hours")

	// Same device, same event, outside the window: a different idempotency key
	// because this is a distinct logical notification.
	outside := mustParseBerlin(t, "2026-07-27 14:00")
	deps.Now = func() time.Time { return outside }
	notice.IdempotencyKey = "campaign.sent:open-window"
	accepted, err = deps.SendToUser(ctx, tenantID, userID, notice)
	if err != nil {
		t.Fatalf("SendToUser outside the window: %v", err)
	}
	if accepted != 1 {
		t.Fatalf("accepted = %d outside quiet hours, want 1", accepted)
	}
	if got := expoCalls.Load(); got != 1 {
		t.Fatalf("Expo call count = %d outside quiet hours, want 1", got)
	}
	assertDeliveryStatus(t, pool, tenantID, "campaign.sent:open-window", "accepted", "")
}

// A possible account takeover must be delivered immediately even when this
// installation silences routine traffic. The second send in the test pins the
// boundary: campaign traffic on the same device and instant remains suppressed.
func TestNewDeviceSignInBypassesQuietHoursWhileRoutineTrafficDoesNot(t *testing.T) {
	pool := mobilePushTestPool(t)
	requireQuietHoursColumns(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var expoCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		expoCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-security-quiet"}}`))
	}))
	defer server.Close()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	insertQuietHoursDevice(t, pool, tenantID, userID, deviceID, "security-quiet-"+deviceID, quietHoursSettings{
		Enabled: true, StartMinute: 0, EndMinute: 0, Timezone: "UTC",
	})
	defer deleteMobilePushFixture(t, pool, tenantID)
	addDeviceEvent(t, pool, tenantID, deviceID, "auth.new_device_sign_in")

	deps := &Deps{
		Pool:       pool,
		Cipher:     testCipher{plaintext: []byte("ExpoPushToken[security-quiet-device]")},
		HTTPClient: server.Client(),
		ExpoURL:    server.URL + "/--/api/v2/push/send",
		Now:        func() time.Time { return time.Date(2026, 8, 3, 2, 30, 0, 0, time.UTC) },
	}
	security := Notification{
		EventType: "auth.new_device_sign_in", EntityID: "MDEyMzQ1Njc4OWFiY2RlZg",
		IdempotencyKey: "auth.new_device_sign_in:quiet-bypass",
	}
	accepted, err := deps.SendToUser(ctx, tenantID, userID, security)
	if err != nil {
		t.Fatalf("SendToUser security alert: %v", err)
	}
	if accepted != 1 || expoCalls.Load() != 1 {
		t.Fatalf("security alert accepted/calls = %d/%d, want 1/1", accepted, expoCalls.Load())
	}
	assertDeliveryStatus(t, pool, tenantID, "auth.new_device_sign_in:quiet-bypass", "accepted", "")

	routine := Notification{
		EventType: "campaign.sent", EntityID: "campaign-quiet-control",
		IdempotencyKey: "campaign.sent:quiet-control",
	}
	accepted, err = deps.SendToUser(ctx, tenantID, userID, routine)
	if err != nil {
		t.Fatalf("SendToUser routine control: %v", err)
	}
	if accepted != 0 || expoCalls.Load() != 1 {
		t.Fatalf("routine alert accepted/calls = %d/%d, want 0/1", accepted, expoCalls.Load())
	}
	assertDeliveryStatus(t, pool, tenantID, "campaign.sent:quiet-control", "suppressed", "quiet_hours")
}

// A suppressed delivery must never be resurrected by the receipt worker: the
// whole point is that the handset is not buzzed, and a retry at 03:00 would
// undo the feature.
func TestSuppressedDeliveryIsNotClaimedByTheRetryWorker(t *testing.T) {
	pool := mobilePushTestPool(t)
	requireQuietHoursColumns(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	insertQuietHoursDevice(t, pool, tenantID, userID, deviceID, "quiet-worker-"+deviceID, quietHoursSettings{
		Enabled: true, StartMinute: 0, EndMinute: 0, Timezone: "UTC", // always quiet
	})
	defer deleteMobilePushFixture(t, pool, tenantID)

	deps := &Deps{Pool: pool, Cipher: testCipher{plaintext: []byte("ExpoPushToken[quiet-worker]")}}
	if err := deps.recordSuppressedDelivery(ctx, tenantID, userID, deviceID, Notification{
		EventType: "campaign.sent", IdempotencyKey: "campaign.sent:worker-probe",
		Title: "Campaign sent", Body: "A campaign finished sending.", CategoryID: pushCategoryEntity,
	}); err != nil {
		t.Fatalf("recordSuppressedDelivery: %v", err)
	}
	// Idempotent: a replayed dispatch must not create a second row.
	if err := deps.recordSuppressedDelivery(ctx, tenantID, userID, deviceID, Notification{
		EventType: "campaign.sent", IdempotencyKey: "campaign.sent:worker-probe",
		Title: "Campaign sent", Body: "A campaign finished sending.", CategoryID: pushCategoryEntity,
	}); err != nil {
		t.Fatalf("recordSuppressedDelivery replay: %v", err)
	}

	store := &postgresDeliveryLifecycleStore{pool: pool}
	now := time.Now().UTC().Add(time.Hour)
	claims, err := store.ClaimSendRetries(ctx, now, now.Add(deliveryAttemptLease), 50)
	if err != nil {
		t.Fatalf("ClaimSendRetries: %v", err)
	}
	for _, claim := range claims {
		if claim.TenantID == tenantID {
			t.Fatalf("the retry worker claimed a suppressed delivery: %#v", claim)
		}
	}
	assertDeliveryStatus(t, pool, tenantID, "campaign.sent:worker-probe", "suppressed", "quiet_hours")
}

// TestQuietHoursRoundTripsThroughTheStore covers the read/write pair the HTTP
// handler sits on, including the "installation is not registered" answer that
// must be a 404 rather than a silent no-op.
func TestQuietHoursRoundTripsThroughTheStore(t *testing.T) {
	pool := mobilePushTestPool(t)
	requireQuietHoursColumns(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	deviceKey := "quiet-store-" + deviceID
	insertQuietHoursDevice(t, pool, tenantID, userID, deviceID, deviceKey, quietHoursSettings{
		Enabled: false, StartMinute: 21 * 60, EndMinute: 9 * 60, Timezone: "UTC",
	})
	defer deleteMobilePushFixture(t, pool, tenantID)

	deps := &Deps{Pool: pool, Cipher: testCipher{}}
	digest := sha256.Sum256([]byte(deviceKey))

	current, err := deps.readQuietHours(ctx, tenantID, userID, digest)
	if err != nil {
		t.Fatalf("readQuietHours: %v", err)
	}
	if current.Enabled || current.StartLocal != "21:00" || current.EndLocal != "09:00" {
		t.Fatalf("stored default = %#v", current)
	}
	next := quietHoursSettings{Enabled: true, StartMinute: 22*60 + 30, EndMinute: 7 * 60, Timezone: "Asia/Tokyo"}
	if err := deps.writeQuietHours(ctx, tenantID, userID, digest, next); err != nil {
		t.Fatalf("writeQuietHours: %v", err)
	}
	reread, err := deps.readQuietHours(ctx, tenantID, userID, digest)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if !reread.Enabled || reread.StartMinute != 22*60+30 || reread.EndMinute != 7*60 || reread.Timezone != "Asia/Tokyo" {
		t.Fatalf("re-read = %#v, want the written window", reread)
	}

	unknown := sha256.Sum256([]byte("never-registered"))
	if _, err := deps.readQuietHours(ctx, tenantID, userID, unknown); err == nil {
		t.Fatal("reading an unregistered installation succeeded; the handler could not answer 404")
	}
	if err := deps.writeQuietHours(ctx, tenantID, userID, unknown, next); err == nil {
		t.Fatal("writing an unregistered installation succeeded; a window would exist with nothing to enforce it on")
	}
}

// ---------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------

func requireQuietHoursColumns(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var present bool
	if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'mobile_push_devices'
       AND column_name = 'quiet_hours_enabled'
)`).Scan(&present); err != nil || !present {
		t.Fatalf("migration 1814_mobile_push_quiet_hours is required for these tests (present=%v err=%v)", present, err)
	}
}

func mustParseBerlin(t *testing.T, stamp string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}
	parsed, err := time.ParseInLocation("2006-01-02 15:04", stamp, loc)
	if err != nil {
		t.Fatalf("ParseInLocation: %v", err)
	}
	return parsed.UTC()
}

func insertQuietHoursDevice(t *testing.T, pool *pgxpool.Pool, tenantID, userID, deviceID, deviceKey string, quiet quietHoursSettings) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'Quiet hours test', 'studio')`,
		tenantID, "quiet-test-"+tenantID); err != nil {
		t.Fatalf("insert tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO users (id, tenant_id, external_user_id, email, role) VALUES ($1::uuid, $2::uuid, $3, $4, 'owner')`,
		userID, tenantID, "quiet-user-"+userID, userID+"@example.test"); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	keyDigest := sha256.Sum256([]byte(deviceKey))
	tokenDigest := sha256.Sum256([]byte("token-" + deviceID))
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_devices (
    id, tenant_id, user_id, device_key_digest, token_digest, token_envelope,
    platform, enabled_events, status,
    quiet_hours_enabled, quiet_hours_start_minute, quiet_hours_end_minute, quiet_hours_timezone
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'ios', ARRAY['campaign.sent'], 'active',
          $7, $8, $9, $10)`,
		deviceID, tenantID, userID, keyDigest[:], tokenDigest[:], []byte("ciphertext"),
		quiet.Enabled, quiet.StartMinute, quiet.EndMinute, quiet.Timezone); err != nil {
		t.Fatalf("insert device: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
}

func addDeviceEvent(t *testing.T, pool *pgxpool.Pool, tenantID, deviceID, eventType string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin device-event update: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope device-event update: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_devices
   SET enabled_events = array_append(enabled_events, $3)
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND NOT ($3 = ANY(enabled_events))`, tenantID, deviceID, eventType); err != nil {
		t.Fatalf("subscribe device to %q: %v", eventType, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit device-event update: %v", err)
	}
}

func assertDeliveryStatus(t *testing.T, pool *pgxpool.Pool, tenantID, idempotencyKey, wantStatus, wantCode string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope assertion: %v", err)
	}
	var rows int
	var status string
	var code *string
	if err := tx.QueryRow(ctx, `
SELECT count(*) OVER (), status, error_code
  FROM mobile_push_deliveries
 WHERE tenant_id = $1::uuid AND idempotency_key = $2`, tenantID, idempotencyKey).Scan(&rows, &status, &code); err != nil {
		t.Fatalf("read delivery %q: %v", idempotencyKey, err)
	}
	if rows != 1 {
		t.Fatalf("delivery %q has %d rows, want exactly 1", idempotencyKey, rows)
	}
	got := ""
	if code != nil {
		got = *code
	}
	if status != wantStatus || got != wantCode {
		t.Fatalf("delivery %q = status %q code %q, want %q %q", idempotencyKey, status, got, wantStatus, wantCode)
	}
}
