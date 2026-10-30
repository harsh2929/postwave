// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	defaultExpoSendURL       = "https://exp.host/--/api/v2/push/send"
	maxExpoResponseBytes     = 256 << 10
	maxPushTitleBytes        = 120
	maxPushBodyBytes         = 240
	expoRequestTimeout       = 10 * time.Second
	initialReceiptDelay      = 15 * time.Minute
	deliveryAttemptLease     = 45 * time.Second
	maxSendAttempts          = 8
	failedDeliveryRetryDelay = 30 * time.Second
	maxDeliveryRetryDelay    = 30 * time.Minute
)

// Notification is intentionally a minimal, server-authored projection. It
// cannot carry an arbitrary customer record: only the event type and opaque
// entity id reach Expo/device data.
type Notification struct {
	EventType      string
	EntityID       string
	IdempotencyKey string
	Title          string
	Body           string
	CategoryID     string
	// NotificationID is the cross-channel identity (the notification_feed row
	// id). Carried as opaque data so the client can dedup/read-sync this
	// delivery against the same notification arriving on other channels; it
	// is an id, never customer content.
	NotificationID string
}

type storedDevice struct {
	ID       string
	Envelope []byte
	// Quiet is the installation's do-not-disturb window. It is carried on the
	// device row (not looked up per send) so the dispatch decision is made
	// from the same snapshot the delivery is claimed against.
	Quiet quietHoursSettings
}

type expoDeliveryMessage struct {
	To         string            `json:"to"`
	Title      string            `json:"title"`
	Body       string            `json:"body"`
	Data       map[string]string `json:"data"`
	CategoryID string            `json:"categoryId,omitempty"`
	Priority   string            `json:"priority"`
	Sound      string            `json:"sound"`
	ChannelID  string            `json:"channelId,omitempty"`
	TTL        int               `json:"ttl"`
	// InterruptionLevel is the iOS Focus/DND classification (NATIVE-V#1).
	// It is set by the SENDER — there is no client-side equivalent for a
	// REMOTE notification — and omitting it left every push at the system
	// default, so an approval that blocks another human was silenced by a
	// Focus mode exactly as reliably as a campaign-open ping. Android
	// ignores the field; importance there comes from the channel.
	InterruptionLevel string `json:"interruptionLevel,omitempty"`
}

type expoTicket struct {
	Status  string `json:"status"`
	ID      string `json:"id"`
	Message string `json:"message"`
	Details struct {
		Error string `json:"error"`
	} `json:"details"`
}

// expoUpstreamError classifies transport/protocol failures without ever
// including an upstream response body (which might echo token material).
type expoUpstreamError struct {
	reason    string
	status    int
	retryable bool
}

func (e *expoUpstreamError) Error() string {
	if e.status > 0 {
		return fmt.Sprintf("mobile push: Expo %s (HTTP %d)", e.reason, e.status)
	}
	return "mobile push: Expo " + e.reason
}

var ErrPushDeliveryDisabled = errors.New("mobile push delivery is not configured")

// SendToUser delivers to every active installation registered by one user.
// A durable per-device idempotency claim prevents duplicate notifications
// across retries/API replicas. It returns the number accepted by Expo. An
// accepted ticket is intentionally not treated as delivered: ReceiptWorker
// later reconciles it against Expo's receipts endpoint.
func (d *Deps) SendToUser(ctx context.Context, tenantID, userID string, n Notification) (int, error) {
	if !d.deliveryEnabled() {
		return 0, ErrPushDeliveryDisabled
	}
	if tenantID == "" || userID == "" || !validEventType(strings.TrimSpace(n.EventType)) {
		return 0, errors.New("mobile push: tenant, user, and valid event type are required")
	}
	if !SupportsEvent(n.EventType) {
		return 0, errors.New("mobile push: unsupported notification event")
	}
	if err := normalizeNotification(&n); err != nil {
		return 0, err
	}

	devices, err := d.listDevicesForUser(ctx, tenantID, userID, n.EventType)
	if err != nil {
		return 0, err
	}
	accepted := 0
	var errs []error
	now := d.clock()
	for _, device := range devices {
		// SHELL#12 — quiet hours are enforced HERE because APNs/FCM delivers
		// from the server: the app cannot decline a push it has already been
		// buzzed for. The notification_feed row was written before this fanout,
		// so the user still sees suppressed routine events in-app. A new-device
		// security alert is the single deliberate exception.
		if !bypassesQuietHours(n.EventType) && quietHoursActive(now, device.Quiet) {
			if err := d.recordSuppressedDelivery(ctx, tenantID, userID, device.ID, n); err != nil {
				errs = append(errs, err)
			}
			continue
		}
		deliveryID, attempts, claimed, err := d.claimDelivery(ctx, tenantID, userID, device.ID, n)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !claimed {
			continue
		}
		ticket, err := d.sendOne(ctx, device, n)
		if err != nil {
			d.logError("deliver", tenantID, userID, device.ID, err)
			terminal := attempts >= maxSendAttempts || !retryableExpoFailure(err)
			next := time.Time{}
			if !terminal {
				next = time.Now().UTC().Add(sendRetryBackoff(attempts))
			}
			if finishErr := d.markDeliveryFailed(ctx, tenantID, deliveryID, "upstream_unavailable", next, terminal); finishErr != nil {
				errs = append(errs, finishErr)
			}
			errs = append(errs, err)
			continue
		}
		if ticket.Status != "ok" {
			code := normalizeExpoErrorCode(ticket.Details.Error, "expo_rejected")
			rejectedErr := fmt.Errorf("mobile push: Expo rejected message (%s)", code)
			if code == "DeviceNotRegistered" {
				if revokeErr := d.revokeDeviceForDelivery(ctx, tenantID, userID, device.ID, deliveryID, code); revokeErr != nil {
					errs = append(errs, revokeErr)
				}
			} else {
				terminal := attempts >= maxSendAttempts || !retryableExpoCode(code)
				next := time.Time{}
				if !terminal {
					next = time.Now().UTC().Add(sendRetryBackoff(attempts))
				}
				if finishErr := d.markDeliveryFailed(ctx, tenantID, deliveryID, code, next, terminal); finishErr != nil {
					errs = append(errs, finishErr)
				}
			}
			errs = append(errs, rejectedErr)
			continue
		}
		accepted++
		if err := d.markDeliveryAccepted(ctx, tenantID, deliveryID, ticket.ID, time.Now().UTC().Add(initialReceiptDelay)); err != nil {
			errs = append(errs, err)
		}
	}
	return accepted, errors.Join(errs...)
}

func normalizeNotification(n *Notification) error {
	n.EntityID = strings.TrimSpace(n.EntityID)
	if len(n.EntityID) > 256 || hasControl(n.EntityID) {
		return errors.New("mobile push: invalid entity id")
	}
	n.IdempotencyKey = strings.TrimSpace(n.IdempotencyKey)
	if n.IdempotencyKey == "" || len(n.IdempotencyKey) > 256 || hasControl(n.IdempotencyKey) {
		return errors.New("mobile push: invalid idempotency key")
	}
	if strings.TrimSpace(n.Title) == "" {
		n.Title = titleForEvent(n.EventType)
	}
	if strings.TrimSpace(n.Body) == "" {
		n.Body = bodyForEvent(n.EventType)
	}
	if len([]byte(n.Title)) > maxPushTitleBytes || len([]byte(n.Body)) > maxPushBodyBytes || hasControl(n.Title) || hasControl(n.Body) {
		return errors.New("mobile push: notification copy is invalid")
	}
	if n.CategoryID == "" {
		n.CategoryID = categoryForEvent(n.EventType)
	}
	if n.CategoryID != pushCategoryApproval && n.CategoryID != pushCategorySecurity && n.CategoryID != pushCategoryEntity {
		return errors.New("mobile push: invalid category")
	}
	return nil
}

func (d *Deps) listDevicesForUser(ctx context.Context, tenantID, userID, eventType string) ([]storedDevice, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, token_envelope,
       quiet_hours_enabled, quiet_hours_start_minute,
       quiet_hours_end_minute, quiet_hours_timezone
  FROM mobile_push_devices
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND status = 'active'
   AND token_envelope IS NOT NULL
   AND $3 = ANY(enabled_events)
 ORDER BY created_at ASC`, tenantID, userID, eventType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []storedDevice
	for rows.Next() {
		var device storedDevice
		if err := rows.Scan(&device.ID, &device.Envelope,
			&device.Quiet.Enabled, &device.Quiet.StartMinute,
			&device.Quiet.EndMinute, &device.Quiet.Timezone); err != nil {
			return nil, err
		}
		out = append(out, device)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (d *Deps) claimDelivery(ctx context.Context, tenantID, userID, deviceID string, n Notification) (string, int, bool, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return "", 0, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	var attempts int
	err = tx.QueryRow(ctx, `
INSERT INTO mobile_push_deliveries (
    tenant_id, user_id, device_id, event_type, entity_id, idempotency_key,
    title, body, category_id, notification_id, status, attempts, next_retry_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, NULLIF($5, ''), $6,
    $7, $8, $9, NULLIF($10, '')::uuid, 'queued', 1, now() + $11::interval
)
ON CONFLICT (device_id, idempotency_key) DO UPDATE
   SET status = 'queued', error_code = NULL, expo_ticket_id = NULL,
       title = EXCLUDED.title, body = EXCLUDED.body,
       category_id = EXCLUDED.category_id,
       notification_id = COALESCE(mobile_push_deliveries.notification_id, EXCLUDED.notification_id),
       attempts = mobile_push_deliveries.attempts + 1,
       receipt_attempts = 0, next_retry_at = now() + $11::interval,
       terminal_at = NULL, delivered_at = NULL
 WHERE mobile_push_deliveries.status = 'failed'
   AND mobile_push_deliveries.next_retry_at <= now()
   AND mobile_push_deliveries.attempts < $12
RETURNING id::text, attempts`, tenantID, userID, deviceID, n.EventType, n.EntityID,
		n.IdempotencyKey, n.Title, n.Body, n.CategoryID, n.NotificationID,
		deliveryAttemptLease.String(), maxSendAttempts).Scan(&id, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", 0, false, tx.Commit(ctx)
	}
	if err != nil {
		return "", 0, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", 0, false, err
	}
	return id, attempts, true, nil
}

func (d *Deps) sendOne(ctx context.Context, device storedDevice, n Notification) (expoTicket, error) {
	token, err := d.Cipher.Decrypt(ctx, device.Envelope, nil)
	if err != nil {
		return expoTicket{}, errors.New("mobile push: token decryption failed")
	}
	defer func() {
		for i := range token {
			token[i] = 0
		}
	}()
	if !validExpoToken(string(token)) {
		return expoTicket{}, errors.New("mobile push: stored token is invalid")
	}
	data := map[string]string{"event_type": n.EventType}
	if n.EntityID != "" {
		data["entity_id"] = n.EntityID
	}
	if n.NotificationID != "" {
		data["notification_id"] = n.NotificationID
	}
	payload, err := json.Marshal(expoDeliveryMessage{
		To: string(token), Title: n.Title, Body: n.Body, Data: data,
		CategoryID: n.CategoryID, Priority: "high", Sound: "default",
		ChannelID:         androidChannelForEvent(n.EventType),
		InterruptionLevel: interruptionLevelForEvent(n.EventType),
		TTL:               86400,
	})
	if err != nil {
		return expoTicket{}, err
	}
	endpoint := strings.TrimSpace(d.ExpoURL)
	if endpoint == "" {
		endpoint = defaultExpoSendURL
	}
	raw, err := d.postExpoJSON(ctx, endpoint, payload)
	if err != nil {
		return expoTicket{}, err
	}
	ticket, err := parseExpoTicket(raw)
	if err != nil {
		return expoTicket{}, &expoUpstreamError{reason: "returned an invalid ticket", retryable: true}
	}
	return ticket, nil
}

func (d *Deps) postExpoJSON(ctx context.Context, endpoint string, payload []byte) ([]byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, expoRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if accessToken := strings.TrimSpace(d.ExpoAccessToken); accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	client := d.HTTPClient
	if client == nil {
		client = &http.Client{
			Timeout: expoRequestTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxExpoResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxExpoResponseBytes {
		return nil, &expoUpstreamError{reason: "response exceeded the size limit", retryable: true}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		retryable := resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		return nil, &expoUpstreamError{reason: "request failed", status: resp.StatusCode, retryable: retryable}
	}
	return raw, nil
}

func parseExpoTicket(raw []byte) (expoTicket, error) {
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || len(envelope.Data) == 0 {
		return expoTicket{}, errors.New("mobile push: invalid Expo ticket response")
	}
	var ticket expoTicket
	if envelope.Data[0] == '[' {
		var tickets []expoTicket
		if err := json.Unmarshal(envelope.Data, &tickets); err != nil || len(tickets) != 1 {
			return expoTicket{}, errors.New("mobile push: invalid Expo ticket list")
		}
		ticket = tickets[0]
	} else if err := json.Unmarshal(envelope.Data, &ticket); err != nil {
		return expoTicket{}, errors.New("mobile push: invalid Expo ticket")
	}
	if ticket.Status != "ok" && ticket.Status != "error" {
		return expoTicket{}, errors.New("mobile push: invalid Expo ticket status")
	}
	if ticket.Status == "ok" && (strings.TrimSpace(ticket.ID) == "" || len(ticket.ID) > 256 || hasControl(ticket.ID)) {
		return expoTicket{}, errors.New("mobile push: invalid Expo ticket id")
	}
	return ticket, nil
}

func (d *Deps) markDeliveryAccepted(ctx context.Context, tenantID, deliveryID, ticketID string, nextCheck time.Time) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_deliveries
   SET status = 'accepted', error_code = NULL, expo_ticket_id = $3,
       receipt_attempts = 0, next_retry_at = $4, terminal_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'queued'`, tenantID, deliveryID, ticketID, nextCheck); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *Deps) markDeliveryFailed(ctx context.Context, tenantID, deliveryID, errorCode string, nextRetry time.Time, terminal bool) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var retry any
	if !nextRetry.IsZero() {
		retry = nextRetry
	}
	var terminalAt any
	if terminal {
		terminalAt = time.Now().UTC()
	}
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_deliveries
   SET status = 'failed', error_code = $3, next_retry_at = $4,
       terminal_at = $5
 WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'queued'`, tenantID, deliveryID,
		normalizeExpoErrorCode(errorCode, "unknown"), retry, terminalAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// revokeDeviceForDelivery atomically records the terminal receipt/ticket and
// disables exactly the referenced installation. The encrypted token is
// erased, while the digest and revoked row remain so reconciliation evidence
// survives and a later same-installation registration can safely rotate it.
func (d *Deps) revokeDeviceForDelivery(ctx context.Context, tenantID, userID, deviceID, deliveryID, errorCode string) error {
	tx, txErr := withMobilePushTenantScope(ctx, d.Pool, tenantID)
	if txErr != nil {
		return txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	code := normalizeExpoErrorCode(errorCode, "DeviceNotRegistered")
	if _, err := tx.Exec(ctx, `
UPDATE mobile_push_deliveries
   SET status = 'revoked', error_code = $5, next_retry_at = NULL,
       terminal_at = now()
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND device_id = $3::uuid
   AND (id = $4::uuid OR status IN ('queued', 'accepted') OR next_retry_at IS NOT NULL)`,
		tenantID, userID, deviceID, deliveryID, code); err != nil {
		return err
	}
	command, txErr := tx.Exec(ctx, `
UPDATE mobile_push_devices
   SET status = 'revoked', revoked_at = now(), token_envelope = NULL,
       enabled_events = '{}'
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id = $3::uuid`, tenantID, userID, deviceID)
	if txErr != nil {
		return txErr
	}
	if command.RowsAffected() != 1 {
		return errors.New("mobile push: device disappeared during revocation")
	}
	return tx.Commit(ctx)
}

func retryableExpoFailure(err error) bool {
	var upstream *expoUpstreamError
	if errors.As(err, &upstream) {
		return upstream.retryable
	}
	// Network, timeout, and cipher-provider availability failures are retried;
	// validation failures never reach this function for newly claimed rows.
	return !errors.Is(err, context.Canceled)
}

func retryableExpoCode(code string) bool {
	switch code {
	case "MessageRateExceeded", "ExpoServerError", "ServiceUnavailable":
		return true
	default:
		return false
	}
}

func sendRetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := failedDeliveryRetryDelay
	for i := 1; i < attempt && delay < maxDeliveryRetryDelay; i++ {
		delay *= 2
		if delay > maxDeliveryRetryDelay {
			delay = maxDeliveryRetryDelay
		}
	}
	return delay
}

func normalizeExpoErrorCode(code, fallback string) string {
	code = strings.TrimSpace(code)
	if code == "" || len(code) > 128 || hasControl(code) {
		return fallback
	}
	for _, r := range code {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_', r == '-', r == '.':
		default:
			return fallback
		}
	}
	return code
}

func hasControl(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
