// SPDX-License-Identifier: AGPL-3.0-only
//
// Session-scoped mobile push device registration. Unlike the retired generic
// webhook relay, this API never places an Expo token in a URL or returns one
// to a caller. A 256-bit installation key proves that a physical installation
// is allowed to rotate/move its registration during an account switch.
package mobilepush

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	deviceRequestMaxBytes = 16 << 10
	maxDevicesPerUser     = 10
	deviceKeyHexLength    = 64
)

// SecretCipher is the envelope cipher used by the rest of the API for
// recoverable provider credentials. Production must provide it; registration
// fails closed when it is absent.
type SecretCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// Deps is shared by the authenticated device routes and server-side sender.
type Deps struct {
	Pool               *db.Pool
	Cipher             SecretCipher
	HTTPClient         *http.Client
	ExpoURL            string
	ExpoReceiptURL     string
	ExpoAccessToken    string
	RequireAccessToken bool
	Logger             *slog.Logger
	// Now overrides the wall clock used to evaluate a device's quiet-hours
	// window. Production leaves it nil (time.Now); tests pin an instant so the
	// window decision is deterministic rather than dependent on when CI runs.
	Now func() time.Time
}

func (d *Deps) clock() time.Time {
	if d != nil && d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// MountRoutes mounts only current-user resources. main.go additionally wraps
// this group with RequireAuthMethod(session), so API keys cannot register a
// human's physical device.
func (d *Deps) MountRoutes(r chi.Router) {
	r.Post("/api/v1/mobile/push/devices", d.RegisterDevice)
	r.Post("/api/v1/mobile/push/devices/status", d.DeviceStatus)
	r.Post("/api/v1/mobile/push/devices/revoke", d.RevokeDevice)
	// SHELL#12 — the do-not-disturb window must be server-side because APNs
	// delivers remote push from here, not from the app.
	r.Post("/api/v1/mobile/push/devices/quiet-hours", d.SetQuietHours)
	// SHELL#13 — prove the whole round trip (server -> Expo -> APNs/FCM ->
	// this handset) instead of showing the operator a truncated token.
	r.Post("/api/v1/mobile/push/devices/test", d.SendTestPush)
}

// MountPublicRoutes exposes only possession-bound revocation. It lets a
// signed-out/offline-first client retry cleanup after its session cookie has
// already disappeared. The endpoint is intentionally non-enumerating (204 for
// missing and present keys) and main.go applies the public abuse limiter.
func (d *Deps) MountPublicRoutes(r chi.Router) {
	r.Post("/api/public/mobile/push/revoke", d.RevokeDeviceByKey)
}

type deviceRequest struct {
	DeviceKey     string   `json:"device_key"`
	ExpoToken     string   `json:"expo_push_token,omitempty"`
	Platform      string   `json:"platform,omitempty"`
	EnabledEvents []string `json:"enabled_events,omitempty"`
}

type deviceResponse struct {
	DeviceID        string   `json:"device_id,omitempty"`
	Registered      bool     `json:"registered"`
	DeliveryEnabled bool     `json:"delivery_enabled"`
	EnabledEvents   []string `json:"enabled_events,omitempty"`
	RegisteredAt    string   `json:"registered_at,omitempty"`
	// QuietHours is the installation's server-enforced do-not-disturb window
	// (SHELL#12). Absent when the installation is not registered.
	QuietHours *quietHoursSettings `json:"quiet_hours,omitempty"`
}

var errDeviceTokenAlreadyBound = errors.New("mobile push token belongs to a different installation")

// RegisterDevice creates or rotates the acting user's physical-device row.
// If the same installation previously belonged to another account/workspace,
// possession of device_key moves it atomically and prevents stale delivery.
func (d *Deps) RegisterDevice(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := currentTenantUser(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_session", "sign in with a user session first")
		return
	}
	if !d.registrationEnabled() {
		writeJSONError(w, http.StatusServiceUnavailable, "mobile_push_disabled", "mobile push registration is unavailable")
		return
	}
	var in deviceRequest
	if err := httpbody.DecodeJSON(w, r, deviceRequestMaxBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	keyDigest, ok := parseDeviceKey(in.DeviceKey)
	if !ok {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_device_key", "device_key must be 32 random bytes encoded as lowercase hex")
		return
	}
	token := strings.TrimSpace(in.ExpoToken)
	if !validExpoToken(token) {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_push_token", "invalid Expo push token")
		return
	}
	platform := strings.ToLower(strings.TrimSpace(in.Platform))
	if platform != "ios" && platform != "android" {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_platform", "platform must be ios or android")
		return
	}
	events, ok := normalizeDeviceEvents(in.EnabledEvents)
	if !ok {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_push_event", "enabled_events contains an unsupported event")
		return
	}
	plaintext := []byte(token)
	envelope, err := d.Cipher.Encrypt(r.Context(), plaintext)
	for i := range plaintext {
		plaintext[i] = 0
	}
	if err != nil || len(envelope) == 0 {
		writeJSONError(w, http.StatusServiceUnavailable, "push_encryption_unavailable", "mobile push registration is unavailable")
		return
	}
	tokenDigest := sha256.Sum256([]byte(token))
	deviceID, registeredAt, err := d.claimDevice(r.Context(), tenantID, userID, keyDigest, tokenDigest, envelope, platform, events)
	if errors.Is(err, errDeviceTokenAlreadyBound) {
		writeJSONError(w, http.StatusConflict, "push_token_already_bound", "this push token is already bound to another installation")
		return
	}
	if err != nil {
		d.logError("register", tenantID, userID, "", err)
		writeJSONError(w, http.StatusInternalServerError, "push_registration_failed", "could not register this device")
		return
	}
	writeDeviceJSON(w, http.StatusOK, deviceResponse{
		DeviceID: deviceID, Registered: true, DeliveryEnabled: d.deliveryEnabled(),
		EnabledEvents: events, RegisteredAt: registeredAt.UTC().Format(time.RFC3339),
	})
}

// DeviceStatus reports only whether this installation is registered for the
// acting user. It never lists token material or other users' devices.
func (d *Deps) DeviceStatus(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := currentTenantUser(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_session", "sign in with a user session first")
		return
	}
	var in deviceRequest
	if err := httpbody.DecodeJSON(w, r, deviceRequestMaxBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	keyDigest, ok := parseDeviceKey(in.DeviceKey)
	if !ok {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_device_key", "invalid device_key")
		return
	}
	resp, err := d.deviceStatus(r.Context(), tenantID, userID, keyDigest)
	if err != nil {
		d.logError("status", tenantID, userID, "", err)
		writeJSONError(w, http.StatusInternalServerError, "push_status_failed", "could not read device status")
		return
	}
	resp.DeliveryEnabled = d.deliveryEnabled()
	writeDeviceJSON(w, http.StatusOK, resp)
}

// RevokeDevice durably removes this installation's current-user registration.
// Repeating it is a successful no-op, which makes logout retries safe.
func (d *Deps) RevokeDevice(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := currentTenantUser(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_session", "sign in with a user session first")
		return
	}
	var in deviceRequest
	if err := httpbody.DecodeJSON(w, r, deviceRequestMaxBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	keyDigest, ok := parseDeviceKey(in.DeviceKey)
	if !ok {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_device_key", "invalid device_key")
		return
	}
	if err := d.deleteDevice(r.Context(), tenantID, userID, keyDigest); err != nil {
		d.logError("revoke", tenantID, userID, "", err)
		writeJSONError(w, http.StatusInternalServerError, "push_revoke_failed", "could not revoke this device")
		return
	}
	writeDeviceJSON(w, http.StatusOK, deviceResponse{Registered: false, DeliveryEnabled: d.deliveryEnabled()})
}

// RevokeDeviceByKey removes the installation across every tenant only after
// the caller proves possession of its 256-bit local secret. It never returns
// whether a row existed and never accepts/returns an Expo token.
func (d *Deps) RevokeDeviceByKey(w http.ResponseWriter, r *http.Request) {
	var in deviceRequest
	if err := httpbody.DecodeJSON(w, r, deviceRequestMaxBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	keyDigest, ok := parseDeviceKey(in.DeviceKey)
	if !ok {
		// Keep malformed and unknown keys externally indistinguishable. The
		// bounded decoder + edge limiter contain abusive traffic.
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if d == nil || d.Pool == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "push_revoke_unavailable", "device revocation is temporarily unavailable")
		return
	}
	if err := d.deleteDeviceGlobally(r.Context(), keyDigest); err != nil {
		d.logError("public_revoke", "", "", "", err)
		writeJSONError(w, http.StatusServiceUnavailable, "push_revoke_unavailable", "device revocation is temporarily unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (d *Deps) registrationEnabled() bool {
	return d != nil && d.Pool != nil && d.Cipher != nil && (!d.RequireAccessToken || strings.TrimSpace(d.ExpoAccessToken) != "")
}

func (d *Deps) deliveryEnabled() bool {
	return d.registrationEnabled()
}

func currentTenantUser(r *http.Request) (string, string, bool) {
	t, tok := middleware.TenantFromContext(r.Context())
	u, uok := middleware.UserFromContext(r.Context())
	if !tok || !uok || u == nil || strings.TrimSpace(t.ID) == "" || strings.TrimSpace(u.ID) == "" {
		return "", "", false
	}
	return t.ID, u.ID, true
}

func parseDeviceKey(raw string) ([32]byte, bool) {
	var digest [32]byte
	raw = strings.TrimSpace(raw)
	if len(raw) != deviceKeyHexLength || strings.ToLower(raw) != raw {
		return digest, false
	}
	key, err := hex.DecodeString(raw)
	if err != nil || len(key) != 32 {
		return digest, false
	}
	digest = sha256.Sum256(key)
	for i := range key {
		key[i] = 0
	}
	return digest, true
}

// allowedDeviceEvents is a Go mirror of the push-eligible entries in
// packages/notifications. Registration accepts opt-in events too; defaults
// remain deliberately high-signal.
var allowedDeviceEvents = map[string]bool{
	// Security alerts are low-volume and actionable. Existing installations do
	// not receive a newly-added event until their enabled_events registration
	// explicitly contains it; listDevicesForUser enforces that rollout fence.
	"auth.new_device_sign_in": true,
	"approval.escalated":      true,
	"approval.requested":      true,
	"campaign.sent":           true,
	"campaign.opened":         false,
	"campaign.clicked":        false,
	"subscriber.created":      false,
	"subscriber.confirmed":    false,
	"subscriber.unsubscribed": false,
	"subscriber.bounced":      true,
	"subscriber.complained":   true,
	"automation.completed":    false,
	"automation.failed":       true,
	"sequence.generated":      true,
	"migration.completed":     true,
	"migration.failed":        true,
	"form.submitted":          false,
	"form.confirmed":          false,
	// COMMERCE#3 / COMMERCE#4 — workspace-degraded events. Both default ON for
	// the same reason automation.failed and migration.failed do: the value of
	// the notification is entirely in arriving before someone goes looking.
	"webhook.auto_disabled":    true,
	"auditsink.circuit_opened": true,
	"billing.payment_failed":   true,
	// AUTOMATION#41 — a journey that has stopped moving without failing. Same
	// default-ON reasoning as automation.failed: the whole value of the alert is
	// arriving before somebody goes looking, and the scanner sweeps once a day.
	"sequence.participants.stuck": true,
	// DELIVERABILITY#15 — workspace-level sender health. Both default ON: they
	// are edge-triggered (a downward threshold crossing; a throttle actually
	// applied), so "on" costs at most one notification per incident, and being
	// throttled without knowing it is the expensive state.
	"deliverability.degraded":       true,
	"deliverability.auto_throttled": true,
	// Campaign assurance. Both topics have been reachable by an outbound
	// webhook since P4.3 while no HUMAN notification type existed, so the one
	// system that can categorically refuse a send could tell a stranger's HTTP
	// endpoint and not the operator. Default ON for the two established
	// reasons: `blocked` is the edge-triggered "it is refusing" class
	// (automation.failed, webhook.auto_disabled), and `completed` is the
	// "the long job you started has finished" class (migration.completed) —
	// an assurance run takes about twenty minutes and can be started from a
	// phone. There is no "passed" event, matching the webhook topics: a run
	// without complete evidence is `incomplete`, never green.
	"assurance.run.blocked":   true,
	"assurance.run.completed": true,
}

// SupportsEvent reports whether an event type can be carried on the native
// push channel at all.
//
// The allowlist is a CROSS-LANGUAGE CONTRACT: packages/notifications
// (manifest.test.ts) asserts it matches the manifest's push-eligible entries
// event-for-event, and apps/mobile derives its Android channel ids from that
// same manifest. So a server-side producer of a NEW event type cannot simply
// start pushing — the event must be added to the shared manifest and shipped
// in a client build first, or Android drops the notification against a channel
// the handset never created. Exposing the predicate lets notifyfanout skip the
// mobile channel deliberately instead of failing a send per notification.
func SupportsEvent(eventType string) bool {
	_, supported := allowedDeviceEvents[eventType]
	return supported
}

// SupportsEvent (method form) implements notifyfanout.EventGate so the unified
// fanout can SKIP the native channel for an event this sender cannot carry,
// instead of calling SendToUser and taking a per-recipient error back on every
// single dispatch.
//
// The interface has existed since the fanout was written, but nothing
// implemented it: main.go assigns `Mobile: mobilePushDeps` directly, so
// channelAccepts fell through to "accepts everything" and every producer of an
// event outside allowedDeviceEvents — analytics.anomaly and audience.milestone
// today, sms.received next — logged a warning per operator per notification.
// That noise is exactly what the gate was introduced to prevent, and it is
// also what makes the documented staged rollout work: a server-side producer
// can ship BEFORE the shared @postwave/notifications manifest entry and the
// client build that registers the Android channel, then start pushing the
// moment the allowlist above gains the event.
func (d *Deps) SupportsEvent(eventType string) bool { return SupportsEvent(eventType) }

func normalizeDeviceEvents(input []string) ([]string, bool) {
	if len(input) == 0 {
		out := make([]string, 0, len(allowedDeviceEvents))
		for event, enabled := range allowedDeviceEvents {
			if enabled {
				out = append(out, event)
			}
		}
		sort.Strings(out)
		return out, true
	}
	seen := make(map[string]struct{}, len(input))
	out := make([]string, 0, len(input))
	for _, raw := range input {
		event := strings.TrimSpace(raw)
		if _, supported := allowedDeviceEvents[event]; !supported || !validEventType(event) {
			return nil, false
		}
		if _, duplicate := seen[event]; duplicate {
			continue
		}
		seen[event] = struct{}{}
		out = append(out, event)
	}
	sort.Strings(out)
	return out, true
}

func (d *Deps) claimDevice(ctx context.Context, tenantID, userID string, keyDigest, tokenDigest [32]byte, envelope []byte, platform string, events []string) (string, time.Time, error) {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return "", time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, device_key_digest, token_digest
  FROM mobile_push_devices
 WHERE device_key_digest = $1 OR token_digest = $2
 FOR UPDATE`, keyDigest[:], tokenDigest[:])
	if err != nil {
		return "", time.Time{}, err
	}
	var existingID string
	for rows.Next() {
		var id string
		var storedKey, storedToken []byte
		if err := rows.Scan(&id, &storedKey, &storedToken); err != nil {
			rows.Close()
			return "", time.Time{}, err
		}
		keyMatches := digestEqual(storedKey, keyDigest[:])
		tokenMatches := digestEqual(storedToken, tokenDigest[:])
		if tokenMatches && !keyMatches {
			rows.Close()
			return "", time.Time{}, errDeviceTokenAlreadyBound
		}
		if keyMatches {
			existingID = id
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", time.Time{}, err
	}

	registeredAt := time.Now().UTC()
	if existingID != "" {
		if err := tx.QueryRow(ctx, `
UPDATE mobile_push_devices
   SET tenant_id = $1::uuid,
       user_id = $2::uuid,
       token_digest = $3,
       token_envelope = $4,
       platform = $5,
       enabled_events = $6,
       status = 'active',
       revoked_at = NULL,
       last_registered_at = $7
 WHERE id = $8::uuid
 RETURNING id::text, last_registered_at`, tenantID, userID, tokenDigest[:], envelope, platform, events, registeredAt, existingID).Scan(&existingID, &registeredAt); err != nil {
			return "", time.Time{}, err
		}
	} else {
		// Bound storage/cost per user. The least-recently registered row is
		// removed before an eleventh device is inserted.
		if _, err := tx.Exec(ctx, `
DELETE FROM mobile_push_devices
 WHERE id = (
   SELECT id FROM mobile_push_devices
    WHERE tenant_id = $1::uuid AND user_id = $2::uuid
    ORDER BY last_registered_at DESC
    OFFSET $3 LIMIT 1
 )`, tenantID, userID, maxDevicesPerUser-1); err != nil {
			return "", time.Time{}, err
		}
		if err := tx.QueryRow(ctx, `
INSERT INTO mobile_push_devices (
    tenant_id, user_id, device_key_digest, token_digest, token_envelope,
    platform, enabled_events, status, last_registered_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'active', $8)
RETURNING id::text, last_registered_at`, tenantID, userID, keyDigest[:], tokenDigest[:], envelope, platform, events, registeredAt).Scan(&existingID, &registeredAt); err != nil {
			return "", time.Time{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", time.Time{}, err
	}
	return existingID, registeredAt, nil
}

func (d *Deps) deviceStatus(ctx context.Context, tenantID, userID string, keyDigest [32]byte) (deviceResponse, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return deviceResponse{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out deviceResponse
	var registeredAt time.Time
	var quiet quietHoursSettings
	err = tx.QueryRow(ctx, `
SELECT id::text, enabled_events, last_registered_at,
       quiet_hours_enabled, quiet_hours_start_minute,
       quiet_hours_end_minute, quiet_hours_timezone
  FROM mobile_push_devices
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND device_key_digest = $3 AND status = 'active'`, tenantID, userID, keyDigest[:]).Scan(
		&out.DeviceID, &out.EnabledEvents, &registeredAt,
		&quiet.Enabled, &quiet.StartMinute, &quiet.EndMinute, &quiet.Timezone)
	if errors.Is(err, pgx.ErrNoRows) {
		return deviceResponse{Registered: false}, tx.Commit(ctx)
	}
	if err != nil {
		return deviceResponse{}, err
	}
	out.Registered = true
	out.RegisteredAt = registeredAt.UTC().Format(time.RFC3339)
	quiet = quiet.withProjections()
	out.QuietHours = &quiet
	return out, tx.Commit(ctx)
}

func (d *Deps) deleteDevice(ctx context.Context, tenantID, userID string, keyDigest [32]byte) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
DELETE FROM mobile_push_devices
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND device_key_digest = $3`, tenantID, userID, keyDigest[:]); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *Deps) deleteDeviceGlobally(ctx context.Context, keyDigest [32]byte) error {
	tx, err := db.WithWorkerScope(ctx, d.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM mobile_push_devices WHERE device_key_digest = $1`, keyDigest[:]); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RevokeAllForUser is suitable for logout/account-deletion hooks. It is
// idempotent and pins both tenant and user.
func (d *Deps) RevokeAllForUser(ctx context.Context, tenantID, userID string) error {
	if d == nil || d.Pool == nil || tenantID == "" || userID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM mobile_push_devices WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenantID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func digestEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func writeDeviceJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (d *Deps) logError(stage, tenantID, userID, deviceID string, err error) {
	if d != nil && d.Logger != nil && err != nil {
		d.Logger.Warn("mobile push operation failed", "stage", stage, "tenant_id", tenantID, "user_id", userID, "device_id", deviceID, "err", err.Error())
	}
}
