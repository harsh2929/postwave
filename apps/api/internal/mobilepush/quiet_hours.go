// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-device quiet hours (SHELL#12).
//
// A remote push is delivered by APNs/FCM from THIS server, so quiet hours
// cannot be implemented on the client: by the time the app could decide, the
// phone has already buzzed. The window therefore lives on the device record
// (migration 1814) and is enforced here, at dispatch.
//
// The vocabulary deliberately mirrors apps/api/internal/sms/quiet_hours.go —
// start_minute/end_minute as minutes-of-day in an IANA timezone, with
// start > end meaning the window crosses midnight — so the platform has one
// quiet-hours concept rather than two. The one difference is that a device
// window has no per-weekday list: sleep is nightly, and an unused `days`
// column would be a second thing to keep in sync.
//
// Suppression, not deferral. Inside the window a routine push is dropped and a
// terminal `suppressed` delivery row records why. The notification_feed row is
// written by notifyfanout BEFORE any channel fans out, so the operator still
// sees the notification in-app the moment they open the phone. The sole
// exception is auth.new_device_sign_in: delaying notice of possible account
// takeover until morning defeats the security control, so it bypasses this
// app-level window (while the OS remains the final presentation authority).
package mobilepush

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	minutesPerDay = 24 * 60
	// Matches the sms_quiet_hours defaults and migration 1814's column
	// defaults: 21:00 -> 09:00 local.
	defaultQuietStartMinute = 21 * 60
	defaultQuietEndMinute   = 9 * 60
	maxTimezoneLength       = 64
)

// quietHoursSettings is the wire shape of one device's window. start_local /
// end_local are derived "HH:MM" projections of the minute fields, matching the
// SMS rule shape so a client can render either form.
type quietHoursSettings struct {
	Enabled     bool   `json:"enabled"`
	StartMinute int    `json:"start_minute"`
	EndMinute   int    `json:"end_minute"`
	StartLocal  string `json:"start_local"`
	EndLocal    string `json:"end_local"`
	Timezone    string `json:"timezone"`
}

func (q quietHoursSettings) withProjections() quietHoursSettings {
	q.StartLocal = minuteLabel(q.StartMinute)
	q.EndLocal = minuteLabel(q.EndMinute)
	return q
}

func minuteLabel(minute int) string {
	if minute < 0 || minute >= minutesPerDay {
		return ""
	}
	return fmt.Sprintf("%02d:%02d", minute/60, minute%60)
}

// minuteOfDay parses "HH:MM" 24-hour local time.
func minuteOfDay(raw string) (int, bool) {
	hh, mm, found := strings.Cut(strings.TrimSpace(raw), ":")
	if !found || len(hh) != 2 || len(mm) != 2 {
		return 0, false
	}
	hour, err := strconv.Atoi(hh)
	if err != nil || hour < 0 || hour > 23 {
		return 0, false
	}
	minute, err := strconv.Atoi(mm)
	if err != nil || minute < 0 || minute > 59 {
		return 0, false
	}
	return hour*60 + minute, true
}

// quietHoursActive reports whether now falls inside the device's window.
//
// It FAILS OPEN — a disabled, malformed, or unparseable window is "not quiet"
// — for the same reason the SMS gate does: a setup mistake must degrade to a
// delivered notification, never to a device that silently stops receiving
// approval requests forever.
func quietHoursActive(now time.Time, q quietHoursSettings) bool {
	if !q.Enabled {
		return false
	}
	if q.StartMinute < 0 || q.StartMinute >= minutesPerDay ||
		q.EndMinute < 0 || q.EndMinute >= minutesPerDay {
		return false
	}
	zone := strings.TrimSpace(q.Timezone)
	if zone == "" {
		return false
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return false
	}
	local := now.In(loc)
	minute := local.Hour()*60 + local.Minute()
	switch {
	case q.StartMinute == q.EndMinute:
		// Whole-day window (mirrors the SMS rule semantics).
		return true
	case q.StartMinute < q.EndMinute:
		return minute >= q.StartMinute && minute < q.EndMinute
	default:
		// Crosses midnight, e.g. 21:00 -> 09:00.
		return minute >= q.StartMinute || minute < q.EndMinute
	}
}

// bypassesQuietHours is intentionally an exact, one-event allowlist. Quiet
// hours are a user promise; adding another bypass must be a deliberate policy
// change with its own test, never an inference from category or priority.
func bypassesQuietHours(eventType string) bool {
	return eventType == "auth.new_device_sign_in"
}

// ---------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------

// quietHoursRequest is a PATCH-shaped body: a nil field is "not supplied" and
// leaves the stored value alone, so a client can flip `enabled` without having
// to re-send a window it never rendered.
type quietHoursRequest struct {
	DeviceKey   string  `json:"device_key"`
	Enabled     *bool   `json:"enabled"`
	StartMinute *int    `json:"start_minute"`
	EndMinute   *int    `json:"end_minute"`
	StartLocal  *string `json:"start_local"`
	EndLocal    *string `json:"end_local"`
	Timezone    *string `json:"timezone"`
}

// applyQuietHoursInput overlays in onto current and validates the result.
// The returned message is operator-safe and rendered as a 422.
func applyQuietHoursInput(current quietHoursSettings, in quietHoursRequest) (quietHoursSettings, string) {
	out := current
	if in.Enabled != nil {
		out.Enabled = *in.Enabled
	}
	switch {
	case in.StartMinute != nil:
		out.StartMinute = *in.StartMinute
	case in.StartLocal != nil:
		m, ok := minuteOfDay(*in.StartLocal)
		if !ok {
			return quietHoursSettings{}, "start_local must use HH:MM 24-hour time"
		}
		out.StartMinute = m
	}
	switch {
	case in.EndMinute != nil:
		out.EndMinute = *in.EndMinute
	case in.EndLocal != nil:
		m, ok := minuteOfDay(*in.EndLocal)
		if !ok {
			return quietHoursSettings{}, "end_local must use HH:MM 24-hour time"
		}
		out.EndMinute = m
	}
	if in.Timezone != nil {
		out.Timezone = strings.TrimSpace(*in.Timezone)
	}
	if out.StartMinute < 0 || out.StartMinute >= minutesPerDay {
		return quietHoursSettings{}, "start_minute must be between 0 and 1439"
	}
	if out.EndMinute < 0 || out.EndMinute >= minutesPerDay {
		return quietHoursSettings{}, "end_minute must be between 0 and 1439"
	}
	if out.Timezone == "" {
		out.Timezone = "UTC"
	}
	if len(out.Timezone) > maxTimezoneLength || hasControl(out.Timezone) {
		return quietHoursSettings{}, "timezone must be a valid IANA zone name"
	}
	if _, err := time.LoadLocation(out.Timezone); err != nil {
		return quietHoursSettings{}, "timezone must be a valid IANA zone name"
	}
	return out.withProjections(), ""
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

// SetQuietHours updates the acting user's quiet-hours window for the physical
// installation identified by device_key. It never creates a device row: a
// window without a registration would be a setting the server can never apply.
func (d *Deps) SetQuietHours(w http.ResponseWriter, r *http.Request) {
	tenantID, userID, ok := currentTenantUser(r)
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "no_session", "sign in with a user session first")
		return
	}
	if d == nil || d.Pool == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "mobile_push_disabled", "mobile push is unavailable")
		return
	}
	var in quietHoursRequest
	if err := httpbody.DecodeJSON(w, r, deviceRequestMaxBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return
	}
	keyDigest, ok := parseDeviceKey(in.DeviceKey)
	if !ok {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_device_key", "invalid device_key")
		return
	}
	current, err := d.readQuietHours(r.Context(), tenantID, userID, keyDigest)
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSONError(w, http.StatusNotFound, "device_not_registered",
			"register this installation before setting quiet hours")
		return
	}
	if err != nil {
		d.logError("quiet_hours_read", tenantID, userID, "", err)
		writeJSONError(w, http.StatusInternalServerError, "quiet_hours_read_failed", "could not read quiet hours")
		return
	}
	next, invalid := applyQuietHoursInput(current, in)
	if invalid != "" {
		writeJSONError(w, http.StatusUnprocessableEntity, "invalid_quiet_hours", invalid)
		return
	}
	err = d.writeQuietHours(r.Context(), tenantID, userID, keyDigest, next)
	if errors.Is(err, pgx.ErrNoRows) {
		// The installation was revoked between the read and the write (a
		// logout racing a settings toggle). Answering 404 rather than 500 lets
		// the client re-register instead of retrying a doomed save.
		writeJSONError(w, http.StatusNotFound, "device_not_registered",
			"register this installation before setting quiet hours")
		return
	}
	if err != nil {
		d.logError("quiet_hours_write", tenantID, userID, "", err)
		writeJSONError(w, http.StatusInternalServerError, "quiet_hours_write_failed", "could not save quiet hours")
		return
	}
	stored := next
	writeDeviceJSON(w, http.StatusOK, deviceResponse{
		Registered:      true,
		DeliveryEnabled: d.deliveryEnabled(),
		QuietHours:      &stored,
	})
}

// ---------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------

func (d *Deps) readQuietHours(ctx context.Context, tenantID, userID string, keyDigest [32]byte) (quietHoursSettings, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return quietHoursSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out quietHoursSettings
	if err := tx.QueryRow(ctx, `
SELECT quiet_hours_enabled, quiet_hours_start_minute, quiet_hours_end_minute, quiet_hours_timezone
  FROM mobile_push_devices
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND device_key_digest = $3 AND status = 'active'`,
		tenantID, userID, keyDigest[:]).Scan(
		&out.Enabled, &out.StartMinute, &out.EndMinute, &out.Timezone); err != nil {
		return quietHoursSettings{}, err
	}
	return out.withProjections(), tx.Commit(ctx)
}

func (d *Deps) writeQuietHours(ctx context.Context, tenantID, userID string, keyDigest [32]byte, q quietHoursSettings) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE mobile_push_devices
   SET quiet_hours_enabled = $4,
       quiet_hours_start_minute = $5,
       quiet_hours_end_minute = $6,
       quiet_hours_timezone = $7
 WHERE tenant_id = $1::uuid AND user_id = $2::uuid
   AND device_key_digest = $3 AND status = 'active'`,
		tenantID, userID, keyDigest[:], q.Enabled, q.StartMinute, q.EndMinute, q.Timezone)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

// recordSuppressedDelivery is the durable evidence that a push was withheld by
// the window. It is idempotent on (device_id, idempotency_key) and deliberately
// terminal: the receipt worker claims only 'queued'/'failed', so a suppressed
// row is never retried into the middle of the night.
func (d *Deps) recordSuppressedDelivery(ctx context.Context, tenantID, userID, deviceID string, n Notification) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO mobile_push_deliveries (
    tenant_id, user_id, device_id, event_type, entity_id, idempotency_key,
    title, body, category_id, notification_id, status, error_code, attempts,
    next_retry_at, terminal_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, NULLIF($5, ''), $6,
    $7, $8, $9, NULLIF($10, '')::uuid,
    'suppressed', 'quiet_hours', 1, NULL, now()
)
ON CONFLICT (device_id, idempotency_key) DO NOTHING`,
		tenantID, userID, deviceID, n.EventType, n.EntityID, n.IdempotencyKey,
		n.Title, n.Body, n.CategoryID, n.NotificationID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
