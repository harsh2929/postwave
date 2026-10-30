// SPDX-License-Identifier: AGPL-3.0-only
package settings

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

// notificationsJSONMaxBodyBytes caps the (optional) test-send body.
const notificationsJSONMaxBodyBytes int64 = 4 << 10 // 4 KiB

// NotificationPrefs is the per-user projection. The wire shape mirrors the
// schema 1:1 — frontend sends/receives exactly the same JSON for GET and
// PATCH.
type NotificationPrefs struct {
	UserID                 string `json:"user_id"`
	TenantID               string `json:"tenant_id"`
	EmailOnSendComplete    bool   `json:"email_on_send_complete"`
	EmailOnApprovalRequest bool   `json:"email_on_approval_request"`
	EmailOnBounceAlert     bool   `json:"email_on_bounce_alert"`
	// EmailOnDeliverabilityAlert gates blocklist-hit / reputation-drop alerts
	// (INBOX-036).
	EmailOnDeliverabilityAlert bool   `json:"email_on_deliverability_alert"`
	DigestFrequency            string `json:"digest_frequency"`
	// Usage/spend alert threshold (BILL-038). Nil = not enabled.
	UsageAlertThresholdPct *int `json:"usage_alert_threshold_pct,omitempty"`
	EmailOnUsageAlert      bool `json:"email_on_usage_alert"`
	// SETC-037 — the In-app channel (bell feed + web/mobile push + SSE) per
	// category. Distinct from Email; on existing rows these were backfilled from
	// the email_on_* values so the channel split preserved delivery.
	InAppOnSendComplete        bool `json:"inapp_on_send_complete"`
	InAppOnApprovalRequest     bool `json:"inapp_on_approval_request"`
	InAppOnBounceAlert         bool `json:"inapp_on_bounce_alert"`
	InAppOnDeliverabilityAlert bool `json:"inapp_on_deliverability_alert"`
	InAppOnUsageAlert          bool `json:"inapp_on_usage_alert"`
	// SETC-037 — the Slack/generic outbound-webhook channel per category. Fires
	// only when the category toggle is on AND a NotificationWebhookURL is set.
	WebhookOnSendComplete        bool `json:"webhook_on_send_complete"`
	WebhookOnApprovalRequest     bool `json:"webhook_on_approval_request"`
	WebhookOnBounceAlert         bool `json:"webhook_on_bounce_alert"`
	WebhookOnDeliverabilityAlert bool `json:"webhook_on_deliverability_alert"`
	WebhookOnUsageAlert          bool `json:"webhook_on_usage_alert"`
	// NotificationWebhookURL is the per-user destination for the webhook channel
	// (empty = channel disabled). Kind is slack | generic.
	NotificationWebhookURL  string    `json:"notification_webhook_url"`
	NotificationWebhookKind string    `json:"notification_webhook_kind"`
	UpdatedAt               time.Time `json:"updated_at"`
}

// NotificationsRepo wraps the notification_preferences table.
type NotificationsRepo struct{ Pool *db.Pool }

// ErrNotificationsNotFound is returned when the user has no row yet.
var ErrNotificationsNotFound = errors.New("settings: notifications not found")

var validDigestFrequencies = map[string]struct{}{
	"daily":  {},
	"weekly": {},
	"never":  {},
}

func defaultPrefs(userID, tenantID string) NotificationPrefs {
	return NotificationPrefs{
		UserID:                       userID,
		TenantID:                     tenantID,
		EmailOnSendComplete:          true,
		EmailOnApprovalRequest:       true,
		EmailOnBounceAlert:           true,
		EmailOnDeliverabilityAlert:   true,
		DigestFrequency:              "weekly",
		EmailOnUsageAlert:            true,
		InAppOnSendComplete:          true,
		InAppOnApprovalRequest:       true,
		InAppOnBounceAlert:           true,
		InAppOnDeliverabilityAlert:   true,
		InAppOnUsageAlert:            true,
		WebhookOnSendComplete:        false,
		WebhookOnApprovalRequest:     false,
		WebhookOnBounceAlert:         false,
		WebhookOnDeliverabilityAlert: false,
		WebhookOnUsageAlert:          false,
		NotificationWebhookKind:      "slack",
	}
}

// scanCols is the shared column list for Get + Upsert RETURNING, so a new
// column is added in exactly one place.
const notificationScanCols = `user_id::text, tenant_id::text,
       email_on_send_complete, email_on_approval_request, email_on_bounce_alert,
       email_on_deliverability_alert,
       digest_frequency, usage_alert_threshold_pct, email_on_usage_alert,
       inapp_on_send_complete, inapp_on_approval_request, inapp_on_bounce_alert,
       inapp_on_deliverability_alert, inapp_on_usage_alert,
       webhook_on_send_complete, webhook_on_approval_request, webhook_on_bounce_alert,
       webhook_on_deliverability_alert, webhook_on_usage_alert,
       COALESCE(notification_webhook_url, ''), notification_webhook_kind, updated_at`

// scanNotificationPrefs binds notificationScanCols into p in column order.
func scanNotificationPrefs(row pgx.Row, p *NotificationPrefs) error {
	return row.Scan(
		&p.UserID, &p.TenantID,
		&p.EmailOnSendComplete, &p.EmailOnApprovalRequest, &p.EmailOnBounceAlert,
		&p.EmailOnDeliverabilityAlert,
		&p.DigestFrequency, &p.UsageAlertThresholdPct, &p.EmailOnUsageAlert,
		&p.InAppOnSendComplete, &p.InAppOnApprovalRequest, &p.InAppOnBounceAlert,
		&p.InAppOnDeliverabilityAlert, &p.InAppOnUsageAlert,
		&p.WebhookOnSendComplete, &p.WebhookOnApprovalRequest, &p.WebhookOnBounceAlert,
		&p.WebhookOnDeliverabilityAlert, &p.WebhookOnUsageAlert,
		&p.NotificationWebhookURL, &p.NotificationWebhookKind, &p.UpdatedAt,
	)
}

// Get loads prefs for the user. ErrNotificationsNotFound when no row.
func (r *NotificationsRepo) Get(ctx context.Context, tenantID, userID string) (*NotificationPrefs, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `SELECT ` + notificationScanCols + `
FROM notification_preferences
WHERE user_id = $1::uuid AND tenant_id = $2::uuid`
	var p NotificationPrefs
	err = scanNotificationPrefs(tx.QueryRow(ctx, q, userID, tenantID), &p)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotificationsNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

// NotificationsPatch is the wire-shape for PATCH. Pointers so missing
// fields are left alone; explicit values overwrite.
type NotificationsPatch struct {
	EmailOnSendComplete        *bool   `json:"email_on_send_complete,omitempty"`
	EmailOnApprovalRequest     *bool   `json:"email_on_approval_request,omitempty"`
	EmailOnBounceAlert         *bool   `json:"email_on_bounce_alert,omitempty"`
	EmailOnDeliverabilityAlert *bool   `json:"email_on_deliverability_alert,omitempty"`
	DigestFrequency            *string `json:"digest_frequency,omitempty"`
	// UsageAlertThresholdPct: 0 clears (disables), 1..100 sets, nil leaves
	// as-is (BILL-038). EmailOnUsageAlert toggles the email channel.
	UsageAlertThresholdPct *int  `json:"usage_alert_threshold_pct,omitempty"`
	EmailOnUsageAlert      *bool `json:"email_on_usage_alert,omitempty"`
	// SETC-037 per-channel toggles (nil = leave as-is).
	InAppOnSendComplete          *bool `json:"inapp_on_send_complete,omitempty"`
	InAppOnApprovalRequest       *bool `json:"inapp_on_approval_request,omitempty"`
	InAppOnBounceAlert           *bool `json:"inapp_on_bounce_alert,omitempty"`
	InAppOnDeliverabilityAlert   *bool `json:"inapp_on_deliverability_alert,omitempty"`
	InAppOnUsageAlert            *bool `json:"inapp_on_usage_alert,omitempty"`
	WebhookOnSendComplete        *bool `json:"webhook_on_send_complete,omitempty"`
	WebhookOnApprovalRequest     *bool `json:"webhook_on_approval_request,omitempty"`
	WebhookOnBounceAlert         *bool `json:"webhook_on_bounce_alert,omitempty"`
	WebhookOnDeliverabilityAlert *bool `json:"webhook_on_deliverability_alert,omitempty"`
	WebhookOnUsageAlert          *bool `json:"webhook_on_usage_alert,omitempty"`
	// NotificationWebhookURL: nil = leave as-is; "" clears the webhook; a value
	// sets it (validated in the handler). Kind is slack | generic.
	NotificationWebhookURL  *string `json:"notification_webhook_url,omitempty"`
	NotificationWebhookKind *string `json:"notification_webhook_kind,omitempty"`
}

// Upsert applies the patch atomically. Missing fields fall back to defaults
// on first insert; on UPDATE missing fields are kept as-is via COALESCE.
func (r *NotificationsRepo) Upsert(ctx context.Context, tenantID, userID string, patch NotificationsPatch) (*NotificationPrefs, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Defaults map onto INSERT; UPDATE uses COALESCE(EXCLUDED, current).
	// $7 (usage threshold): -1 = leave as-is, 0 = clear (disable), 1..100 =
	// set. Handled directly (not via EXCLUDED) because it must support NULL.
	// New per-channel booleans ($10-$19) and the webhook url/kind ($20/$21) all
	// use the raw-$n-preserve pattern (NOT EXCLUDED) so a partial PATCH that
	// omits a field keeps the user's choice instead of resetting it.
	q := `
INSERT INTO notification_preferences
    (user_id, tenant_id,
     email_on_send_complete, email_on_approval_request, email_on_bounce_alert,
     email_on_deliverability_alert,
     digest_frequency, usage_alert_threshold_pct, email_on_usage_alert,
     inapp_on_send_complete, inapp_on_approval_request, inapp_on_bounce_alert,
     inapp_on_deliverability_alert, inapp_on_usage_alert,
     webhook_on_send_complete, webhook_on_approval_request, webhook_on_bounce_alert,
     webhook_on_deliverability_alert, webhook_on_usage_alert,
     notification_webhook_url, notification_webhook_kind, updated_at)
VALUES
    ($1::uuid, $2::uuid,
     COALESCE($3, true), COALESCE($4, true), COALESCE($5, true),
     COALESCE($9, true),
     COALESCE($6, 'weekly'),
     CASE WHEN $7 <= 0 THEN NULL ELSE $7 END, COALESCE($8, true),
     COALESCE($10, true), COALESCE($11, true), COALESCE($12, true),
     COALESCE($13, true), COALESCE($14, true),
     COALESCE($15, false), COALESCE($16, false), COALESCE($17, false),
     COALESCE($18, false), COALESCE($19, false),
     NULLIF($20, ''), COALESCE($21, 'slack'),
     now())
ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    -- Every preserved field references its RAW $n bind, NOT EXCLUDED. EXCLUDED's
    -- value is the INSERT expression COALESCE($n, <default>), which is never
    -- NULL — so COALESCE(EXCLUDED, current) would resolve to the default and a
    -- partial PATCH that OMITS a field would silently RESET it (re-enabling an
    -- opt-out, resetting a non-weekly digest). Raw $n is NULL when omitted, so
    -- COALESCE($n, current) preserves the stored choice. (INBOX-036 fixed only
    -- deliverability_alert this way; SETC-037 extends the fix to every field.)
    email_on_send_complete    = COALESCE($3, notification_preferences.email_on_send_complete),
    email_on_approval_request = COALESCE($4, notification_preferences.email_on_approval_request),
    email_on_bounce_alert     = COALESCE($5, notification_preferences.email_on_bounce_alert),
    email_on_deliverability_alert = COALESCE($9, notification_preferences.email_on_deliverability_alert),
    digest_frequency          = COALESCE($6, notification_preferences.digest_frequency),
    usage_alert_threshold_pct = CASE WHEN $7 = -1 THEN notification_preferences.usage_alert_threshold_pct
                                     WHEN $7 = 0 THEN NULL ELSE $7 END,
    email_on_usage_alert      = COALESCE($8, notification_preferences.email_on_usage_alert),
    inapp_on_send_complete        = COALESCE($10, notification_preferences.inapp_on_send_complete),
    inapp_on_approval_request     = COALESCE($11, notification_preferences.inapp_on_approval_request),
    inapp_on_bounce_alert         = COALESCE($12, notification_preferences.inapp_on_bounce_alert),
    inapp_on_deliverability_alert = COALESCE($13, notification_preferences.inapp_on_deliverability_alert),
    inapp_on_usage_alert          = COALESCE($14, notification_preferences.inapp_on_usage_alert),
    webhook_on_send_complete        = COALESCE($15, notification_preferences.webhook_on_send_complete),
    webhook_on_approval_request     = COALESCE($16, notification_preferences.webhook_on_approval_request),
    webhook_on_bounce_alert         = COALESCE($17, notification_preferences.webhook_on_bounce_alert),
    webhook_on_deliverability_alert = COALESCE($18, notification_preferences.webhook_on_deliverability_alert),
    webhook_on_usage_alert          = COALESCE($19, notification_preferences.webhook_on_usage_alert),
    -- $20 NULL (field omitted) preserves; '' clears the webhook; a value sets it.
    notification_webhook_url  = CASE WHEN $20 IS NULL THEN notification_preferences.notification_webhook_url
                                     ELSE NULLIF($20, '') END,
    notification_webhook_kind = COALESCE($21, notification_preferences.notification_webhook_kind),
    updated_at                = now()
RETURNING ` + notificationScanCols
	var (
		out    NotificationPrefs
		digest *string
	)
	if patch.DigestFrequency != nil {
		v := *patch.DigestFrequency
		digest = &v
	}
	threshold := -1
	if patch.UsageAlertThresholdPct != nil {
		threshold = *patch.UsageAlertThresholdPct
	}
	err = scanNotificationPrefs(tx.QueryRow(ctx, q,
		userID, tenantID,
		patch.EmailOnSendComplete, patch.EmailOnApprovalRequest, patch.EmailOnBounceAlert,
		digest, threshold, patch.EmailOnUsageAlert,
		patch.EmailOnDeliverabilityAlert,
		patch.InAppOnSendComplete, patch.InAppOnApprovalRequest, patch.InAppOnBounceAlert,
		patch.InAppOnDeliverabilityAlert, patch.InAppOnUsageAlert,
		patch.WebhookOnSendComplete, patch.WebhookOnApprovalRequest, patch.WebhookOnBounceAlert,
		patch.WebhookOnDeliverabilityAlert, patch.WebhookOnUsageAlert,
		patch.NotificationWebhookURL, patch.NotificationWebhookKind,
	), &out)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// NotificationsDeps mounts the user-prefs HTTP surface.
type NotificationsDeps struct {
	Repo   *NotificationsRepo
	Logger *slog.Logger
	// Mailer + FromAddress power the "send test notification" action
	// (SETC-053). Both are optional — when Mailer is nil the endpoint
	// returns 503 rather than pretending to send.
	Mailer      mailer.Mailer
	FromAddress string
}

// MountRoutes wires GET/PATCH /api/v1/settings/notifications and the
// test-send action.
func (d *NotificationsDeps) MountRoutes(r chi.Router) {
	r.Get("/api/v1/settings/notifications", d.Get)
	r.Patch("/api/v1/settings/notifications", d.Patch)
	r.Post("/api/v1/settings/notifications/test", d.SendTest)
}

// SendTestInput is the optional body for the test-notification endpoint. An
// empty body is accepted and treated as kind="category".
type SendTestInput struct {
	Kind string `json:"kind"`
}

// SendTest POST /api/v1/settings/notifications/test — dispatches a sample
// notification email to the signed-in user so they can confirm their address
// receives Moosewave mail (SETC-053). Reuses the auth mailer; no new subsystem.
func (d *NotificationsDeps) SendTest(w http.ResponseWriter, r *http.Request) {
	if _, ok := middleware.TenantFromContext(r.Context()); !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	u, _ := middleware.UserFromContext(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", "user required"))
		return
	}
	if d.Mailer == nil {
		writeJSON(w, http.StatusServiceUnavailable,
			errEnv("mailer_unavailable", "email delivery is not configured"))
		return
	}
	if u.Email == "" {
		writeJSON(w, http.StatusUnprocessableEntity,
			errEnv("no_email", "your account has no email address to send to"))
		return
	}
	var in SendTestInput
	if err := httpbody.DecodeJSONWith(w, r, notificationsJSONMaxBodyBytes, &in,
		httpbody.Options{AllowEmptyBody: true, AllowMissingContentType: true}); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}

	from := d.FromAddress
	if from == "" {
		from = "Moosewave <noreply@moosewave.com>"
	}
	subject, body, htmlBody := testNotificationContent(in.Kind)
	if err := d.Mailer.Send(r.Context(), mailer.Message{
		From:     from,
		To:       u.Email,
		Subject:  subject,
		Body:     body,
		HTMLBody: htmlBody,
		Tags:     map[string]string{"purpose": "settings_test_notification"},
	}); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent": true, "to": u.Email})
}

// testNotificationContent builds the subject/plain/HTML for a test send. The
// digest variant only differs in copy — it deliberately does NOT invoke the
// real digest renderer, keeping this action free of analytics coupling.
func testNotificationContent(kind string) (subject, body, htmlBody string) {
	if kind == "digest" {
		subject = "Moosewave — test digest notification"
		body = "This is a sample of the Moosewave activity digest. " +
			"If you received it, your notification address is working. " +
			"Your real digest will summarize sends, opens, clicks, and alerts."
	} else {
		subject = "Moosewave — test notification"
		body = "This is a test notification from Moosewave. " +
			"If you received it, your notification address is working."
	}
	htmlBody = "<p>" + body + "</p>"
	return subject, body, htmlBody
}

// Get GET /api/v1/settings/notifications.
func (d *NotificationsDeps) Get(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	u, _ := middleware.UserFromContext(r.Context())
	if u == nil {
		// Without a user we have nothing to key on; return 401 so the
		// frontend can prompt re-auth instead of silently rendering a
		// foreign user's prefs.
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", "user required"))
		return
	}
	p, err := d.Repo.Get(r.Context(), t.ID, u.ID)
	if err != nil {
		if errors.Is(err, ErrNotificationsNotFound) {
			writeJSON(w, http.StatusOK, defaultPrefs(u.ID, t.ID))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, p)
}

// Patch PATCH /api/v1/settings/notifications.
func (d *NotificationsDeps) Patch(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	u, _ := middleware.UserFromContext(r.Context())
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_user", "user required"))
		return
	}
	var in NotificationsPatch
	if err := httpbody.DecodeJSON(w, r, settingsJSONMaxBodyBytes, &in); err != nil {
		// httpbody.DecodeJSON returns operator-safe text and codes that are
		// in httperror.IsValidationCode allowlist (operator-authored text).
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.DigestFrequency != nil {
		if _, ok := validDigestFrequencies[*in.DigestFrequency]; !ok {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_digest_frequency",
				"digest_frequency must be one of daily, weekly, never"))
			return
		}
	}
	if in.UsageAlertThresholdPct != nil {
		// 0 disables; 1..100 is a valid threshold (BILL-038).
		if v := *in.UsageAlertThresholdPct; v < 0 || v > 100 {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_usage_threshold",
				"usage_alert_threshold_pct must be between 0 and 100"))
			return
		}
	}
	if in.NotificationWebhookKind != nil {
		if k := *in.NotificationWebhookKind; k != "slack" && k != "generic" {
			writeJSON(w, http.StatusBadRequest, errEnv("bad_webhook_kind",
				"notification_webhook_kind must be slack or generic"))
			return
		}
	}
	// A non-empty webhook URL must pass the SSRF guard (public https host, no
	// private/reserved IPs) before it is ever stored — an empty string clears it.
	if in.NotificationWebhookURL != nil {
		trimmed := strings.TrimSpace(*in.NotificationWebhookURL)
		if trimmed != "" {
			if err := outbound_webhooks.ValidateURL(trimmed, true); err != nil {
				writeJSON(w, http.StatusBadRequest, errEnv("bad_webhook_url",
					"notification_webhook_url must be a valid public https URL"))
				return
			}
		}
		in.NotificationWebhookURL = &trimmed
	}
	out, err := d.Repo.Upsert(r.Context(), t.ID, u.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
