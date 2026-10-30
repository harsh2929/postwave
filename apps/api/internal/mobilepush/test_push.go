// SPDX-License-Identifier: AGPL-3.0-only
//
// "Send a test notification" for a physical installation (SHELL#13).
//
// /api/v1/notifications/web-push/test already existed for BROWSER
// subscriptions; mobile had devices but no way to prove the round trip. A
// truncated token ("Token ending …abc12345") tells an operator nothing:
// mobile push has strictly more failure modes than the browser (APNs/FCM
// registration, per-app notification settings, Focus modes, a revoked token
// the server has not reconciled yet). The only honest probe is a real push
// that traverses the real path — this server -> Expo -> APNs/FCM -> handset.
//
// Deliberate design choices:
//
//   - It targets ONE installation (the caller's device_key), not every device
//     the user owns, so the answer is about the handset in their hand.
//   - It IGNORES the device's enabled_events topic list. A test is not an
//     event subscription; requiring the operator to first enable a topic to
//     test delivery would defeat the diagnostic.
//   - It IGNORES quiet hours, for the same reason: the person is holding the
//     phone and just asked for it.
//   - It reuses the ordinary delivery lifecycle (claim -> Expo ticket ->
//     receipt reconciliation), so a test send is visible in
//     mobile_push_deliveries exactly like a real one, and the per-minute
//     idempotency key makes repeated taps a no-op rather than a way to spam a
//     device.
package mobilepush

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/entitlement"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	// pushTestEventType is intentionally NOT a member of allowedDeviceEvents:
	// it is not subscribable, has no preference, and must never be produced by
	// the fanout. It travels on the legacy Android channel, which every client
	// build has registered since the first release, so the notification cannot
	// be silently dropped by an unknown-channel id.
	pushTestEventType = "push.test"
	pushTestTitle     = "Moosewave test notification"
	pushTestBody      = "Push notifications are working on this device."
)

// SendTestPush delivers one real push to the acting user's installation.
func (d *Deps) SendTestPush(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := currentTenantUser(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_session", "sign in with a user session first")
		return
	}
	if !d.deliveryEnabled() {
		writeJSONError(w, http.StatusServiceUnavailable, "mobile_push_disabled", "mobile push delivery is not configured")
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
	accepted, err := d.SendTestToDevice(r.Context(), tenantID, userID, keyDigest)
	switch {
	case errors.Is(err, ErrDeviceNotRegistered):
		writeJSONError(w, http.StatusNotFound, "device_not_registered",
			"this installation is not registered for push; enable notifications and try again")
		return
	case errors.Is(err, ErrTestPushThrottled):
		writeTestPushThrottledDenial(w)
		return
	case errors.Is(err, ErrPushRejected):
		// The device really is unreachable. This is the answer the operator
		// came for, so it is a specific code — never a bare 500.
		writeJSONError(w, http.StatusBadGateway, "test_push_rejected",
			"the push service rejected this device; re-register notifications on the handset")
		return
	case err != nil:
		d.logError("test_push", tenantID, userID, "", err)
		writeJSONError(w, http.StatusBadGateway, "test_push_failed",
			"the push service could not be reached; try again shortly")
		return
	}
	writeDeviceJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"accepted": accepted,
		// Expo accepting a ticket is not proof of handset delivery; the
		// receipt worker reconciles that later. Say so rather than letting the
		// client claim success it cannot know.
		"note": "accepted by the push service; final delivery is confirmed asynchronously",
	})
}

func writeTestPushThrottledDenial(w http.ResponseWriter) {
	entitlement.Write(w, entitlement.Denial{
		Subject:           "mobile_push_test",
		Reason:            entitlement.ReasonQuota,
		Code:              "test_push_throttled",
		Message:           "a test notification was already sent to this device in the last minute",
		Resource:          "device_test_pushes",
		RetryAfterSeconds: 60,
	})
}

// Sentinel errors let the handler answer with a specific code instead of the
// generic 500 this audit keeps finding.
var (
	ErrDeviceNotRegistered = errors.New("mobile push: installation is not registered")
	ErrTestPushThrottled   = errors.New("mobile push: a test was already sent this minute")
	ErrPushRejected        = errors.New("mobile push: the push service rejected this device")
)

// SendTestToDevice sends one test push to the installation identified by
// keyDigest and owned by (tenantID, userID). Exported so an operator tool can
// reuse exactly the path the HTTP route takes.
func (d *Deps) SendTestToDevice(ctx context.Context, tenantID, userID string, keyDigest [32]byte) (int, error) {
	if !d.deliveryEnabled() {
		return 0, ErrPushDeliveryDisabled
	}
	if tenantID == "" || userID == "" {
		return 0, errors.New("mobile push: tenant and user are required")
	}
	device, err := d.testTargetDevice(ctx, tenantID, userID, keyDigest)
	if err != nil {
		return 0, err
	}
	notice := Notification{
		EventType: pushTestEventType,
		// One test per device per minute. The unique (device_id,
		// idempotency_key) constraint is the throttle, so it holds across API
		// replicas without a shared rate limiter.
		IdempotencyKey: pushTestEventType + ":" + device.ID + ":" +
			strconv.FormatInt(d.clock().UTC().Unix()/60, 10),
		Title:      pushTestTitle,
		Body:       pushTestBody,
		CategoryID: pushCategoryEntity,
	}
	if err := normalizeNotification(&notice); err != nil {
		return 0, err
	}
	deliveryID, attempts, claimed, err := d.claimDelivery(ctx, tenantID, userID, device.ID, notice)
	if err != nil {
		return 0, err
	}
	if !claimed {
		return 0, ErrTestPushThrottled
	}
	ticket, err := d.sendOne(ctx, device, notice)
	if err != nil {
		terminal := attempts >= maxSendAttempts || !retryableExpoFailure(err)
		next := time.Time{}
		if !terminal {
			next = d.clock().UTC().Add(sendRetryBackoff(attempts))
		}
		if finishErr := d.markDeliveryFailed(ctx, tenantID, deliveryID, "upstream_unavailable", next, terminal); finishErr != nil {
			return 0, errors.Join(err, finishErr)
		}
		return 0, err
	}
	if ticket.Status != "ok" {
		code := normalizeExpoErrorCode(ticket.Details.Error, "expo_rejected")
		if code == "DeviceNotRegistered" {
			// The handset really is gone. Revoking here is the same
			// reconciliation the normal path performs, and it turns a
			// confusing silent failure into an actionable "re-register".
			if revokeErr := d.revokeDeviceForDelivery(ctx, tenantID, userID, device.ID, deliveryID, code); revokeErr != nil {
				return 0, errors.Join(ErrPushRejected, revokeErr)
			}
			return 0, ErrPushRejected
		}
		terminal := attempts >= maxSendAttempts || !retryableExpoCode(code)
		next := time.Time{}
		if !terminal {
			next = d.clock().UTC().Add(sendRetryBackoff(attempts))
		}
		if finishErr := d.markDeliveryFailed(ctx, tenantID, deliveryID, code, next, terminal); finishErr != nil {
			return 0, errors.Join(ErrPushRejected, finishErr)
		}
		return 0, ErrPushRejected
	}
	if err := d.markDeliveryAccepted(ctx, tenantID, deliveryID, ticket.ID, d.clock().UTC().Add(initialReceiptDelay)); err != nil {
		return 1, err
	}
	return 1, nil
}

// testTargetDevice resolves the one installation the caller proved possession
// of. It deliberately does NOT filter on enabled_events: a topic list gates
// which events are worth a buzz, not whether the transport works.
func (d *Deps) testTargetDevice(ctx context.Context, tenantID, userID string, keyDigest [32]byte) (storedDevice, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return storedDevice{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var device storedDevice
	err = tx.QueryRow(ctx, `
SELECT id::text, token_envelope
  FROM mobile_push_devices
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND device_key_digest = $3 AND status = 'active'
   AND token_envelope IS NOT NULL`, tenantID, userID, keyDigest[:]).Scan(&device.ID, &device.Envelope)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedDevice{}, ErrDeviceNotRegistered
	}
	if err != nil {
		return storedDevice{}, err
	}
	return device, tx.Commit(ctx)
}
