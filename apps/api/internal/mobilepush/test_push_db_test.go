// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestSendTestToDevice covers SHELL#13 end to end against a real device row: a
// registered installation gets a real push, a repeat within the minute is
// throttled by the existing (device_id, idempotency_key) constraint, and an
// unknown installation is a typed "not registered" rather than a 500.
func TestSendTestToDevice(t *testing.T) {
	pool := mobilePushTestPool(t)
	requireQuietHoursColumns(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var payloads []map[string]any
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		payloads = append(payloads, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","id":"ticket-test"}}`))
	}))
	defer server.Close()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	deviceKey := "test-push-" + deviceID
	// The device is quiet-hours-enabled AND subscribed only to campaign.sent.
	// A test must ignore both: the person is holding the handset and asked.
	insertQuietHoursDevice(t, pool, tenantID, userID, deviceID, deviceKey, quietHoursSettings{
		Enabled: true, StartMinute: 0, EndMinute: 0, Timezone: "UTC",
	})
	defer deleteMobilePushFixture(t, pool, tenantID)

	minute := time.Date(2026, 7, 27, 3, 15, 30, 0, time.UTC)
	deps := &Deps{
		Pool:       pool,
		Cipher:     testCipher{plaintext: []byte("ExpoPushToken[test-device]")},
		HTTPClient: server.Client(),
		ExpoURL:    server.URL + "/--/api/v2/push/send",
		Now:        func() time.Time { return minute },
	}
	digest := sha256.Sum256([]byte(deviceKey))

	accepted, err := deps.SendTestToDevice(ctx, tenantID, userID, digest)
	if err != nil {
		t.Fatalf("SendTestToDevice: %v", err)
	}
	if accepted != 1 {
		t.Fatalf("accepted = %d, want 1", accepted)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("Expo calls = %d, want 1 (a test must actually leave the server)", got)
	}
	if len(payloads) != 1 {
		t.Fatalf("captured %d payloads", len(payloads))
	}
	data, _ := payloads[0]["data"].(map[string]any)
	if data["event_type"] != pushTestEventType {
		t.Fatalf("push data = %#v, want event_type %q", data, pushTestEventType)
	}
	if payloads[0]["channelId"] != legacyAndroidChannel {
		t.Fatalf("channelId = %v, want the always-registered %q channel", payloads[0]["channelId"], legacyAndroidChannel)
	}
	if payloads[0]["to"] != "ExpoPushToken[test-device]" {
		t.Fatalf("token was not sent in the body: %#v", payloads[0]["to"])
	}

	// Same minute -> throttled by the durable idempotency claim, no second push.
	if _, err := deps.SendTestToDevice(ctx, tenantID, userID, digest); !errors.Is(err, ErrTestPushThrottled) {
		t.Fatalf("second test in the same minute err = %v, want ErrTestPushThrottled", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("Expo calls after a throttled retry = %d, want 1", got)
	}

	// A later minute is a new logical test and goes through.
	deps.Now = func() time.Time { return minute.Add(2 * time.Minute) }
	if _, err := deps.SendTestToDevice(ctx, tenantID, userID, digest); err != nil {
		t.Fatalf("test push in a later minute: %v", err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("Expo calls = %d, want 2", got)
	}

	unknown := sha256.Sum256([]byte("never-registered-key"))
	if _, err := deps.SendTestToDevice(ctx, tenantID, userID, unknown); !errors.Is(err, ErrDeviceNotRegistered) {
		t.Fatalf("unknown installation err = %v, want ErrDeviceNotRegistered", err)
	}
}

// A handset Expo no longer knows must produce the actionable answer — and must
// revoke the dead registration, exactly as the ordinary delivery path does.
func TestSendTestToDeviceRevokesAnUnregisteredHandset(t *testing.T) {
	pool := mobilePushTestPool(t)
	requireQuietHoursColumns(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"error","details":{"error":"DeviceNotRegistered"}}}`))
	}))
	defer server.Close()

	tenantID := uuid.NewString()
	userID := uuid.NewString()
	deviceID := uuid.NewString()
	deviceKey := "dead-device-" + deviceID
	insertQuietHoursDevice(t, pool, tenantID, userID, deviceID, deviceKey, quietHoursSettings{Timezone: "UTC"})
	defer deleteMobilePushFixture(t, pool, tenantID)

	deps := &Deps{
		Pool:       pool,
		Cipher:     testCipher{plaintext: []byte("ExpoPushToken[dead-device]")},
		HTTPClient: server.Client(),
		ExpoURL:    server.URL + "/--/api/v2/push/send",
	}
	digest := sha256.Sum256([]byte(deviceKey))
	if _, err := deps.SendTestToDevice(ctx, tenantID, userID, digest); !errors.Is(err, ErrPushRejected) {
		t.Fatalf("err = %v, want ErrPushRejected", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin verify: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		t.Fatalf("scope verify: %v", err)
	}
	var status string
	var envelope []byte
	if err := tx.QueryRow(ctx, `SELECT status, token_envelope FROM mobile_push_devices WHERE id = $1::uuid`, deviceID).
		Scan(&status, &envelope); err != nil {
		t.Fatalf("read device: %v", err)
	}
	if status != "revoked" || envelope != nil {
		t.Fatalf("device after a rejected test = status %q envelope %x; want revoked with the token erased", status, envelope)
	}
}

func TestSendTestPushHandlerRejectsUnauthenticatedAndUnconfigured(t *testing.T) {
	// No session at all.
	rec := httptest.NewRecorder()
	(&Deps{}).SendTestPush(rec, httptest.NewRequest(http.MethodPost, "/api/v1/mobile/push/devices/test", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status without a session = %d, want 401", rec.Code)
	}
}

func TestSendTestToDeviceRefusesWhenDeliveryIsDisabled(t *testing.T) {
	deps := &Deps{} // no pool, no cipher
	if _, err := deps.SendTestToDevice(context.Background(), "t", "u", [32]byte{}); !errors.Is(err, ErrPushDeliveryDisabled) {
		t.Fatalf("err = %v, want ErrPushDeliveryDisabled", err)
	}
}
