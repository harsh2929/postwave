// SPDX-License-Identifier: AGPL-3.0-only
package feedback

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/emailidentity"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// SignatureHeader is the HMAC header Postmark+SendGrid senders include
// when our shared secret is configured. We follow the same pattern as
// listmonk_events: signed string is `timestamp.body`, hex-encoded
// SHA-256 in the SignatureHeader, unix-second timestamp in
// TimestampHeader.
const (
	PostmarkSignatureHeader = "X-Postmark-Signature"
	PostmarkTimestampHeader = "X-Postmark-Timestamp"
	SendGridSignatureHeader = "X-Postwave-Signature"
	SendGridTimestampHeader = "X-Postwave-Timestamp"
	ARFSignatureHeader      = "X-Postwave-Signature"
	ARFTimestampHeader      = "X-Postwave-Timestamp"

	// TenantHeader is the fallback tenant id header for ESP webhooks
	// that we cannot resolve to a tenant via esp_message_id lookup.
	// Operators set this on the edge proxy when the webhook URL is
	// dedicated to a single tenant.
	TenantHeader = "X-Postwave-Tenant"
)

var errInvalidHistoryEmail = errors.New("invalid feedback history email")

// ReplayTolerance matches listmonk_events.ReplayTolerance.
const ReplayTolerance = 5 * time.Minute

const (
	postmarkFeedbackMaxBodyBytes int64 = 1 << 20 // 1 MiB
	batchFeedbackMaxBodyBytes    int64 = 4 << 20 // 4 MiB
	feedbackHistoryMaxBodyBytes  int64 = 4 << 10 // 4 KiB
)

// Deps bundles handler dependencies.
type Deps struct {
	Pool *db.Pool
	Repo *Repo
	// PostmarkSecret is the shared HMAC secret for the Postmark webhook.
	// Required unless AllowUnsignedDevBypass is set.
	PostmarkSecret string
	// SendGridSecret is the shared HMAC secret for the SendGrid webhook.
	SendGridSecret string
	// ARFSecret is the shared HMAC secret for the ARF report endpoint.
	ARFSecret string
	// AllowUnsignedDevBypass disables HMAC verification for local dev.
	AllowUnsignedDevBypass bool
	Logger                 *slog.Logger
	// Now overrides time.Now for deterministic replay-window tests.
	Now func() time.Time
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d *Deps) log() *slog.Logger {
	if d.Logger != nil {
		return d.Logger
	}
	return slog.Default()
}

// Mount registers the feedback routes on r. Internal HMAC-signed routes
// are mounted directly (no tenant middleware); the POST admin route is
// expected to be wired by the caller behind the tenant + scope
// middleware (see the package README in the parent module).
func Mount(r chi.Router, d *Deps) {
	r.Post("/api/internal/feedback/postmark", d.HandlePostmark)
	r.Post("/api/internal/feedback/sendgrid", d.HandleSendGrid)
	r.Post("/api/internal/feedback/arf", d.HandleARF)
}

// HandlePostmark ingests a single Postmark bounce/complaint webhook.
func (d *Deps) HandlePostmark(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, postmarkFeedbackMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeJSONErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Postmark feedback payload exceeds 1 MiB")
			return
		}
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	if !d.verifyHMAC(w, r, body, d.PostmarkSecret, PostmarkSignatureHeader, PostmarkTimestampHeader) {
		return
	}

	// Discriminate first: SpamComplaint goes to the complaint branch.
	var probe struct {
		Type      string `json:"Type"`
		MessageID string `json:"MessageID"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		httperror.WriteValidation(w, "bad_json", "request payload is invalid")
		return
	}

	tenantID := d.resolveTenant(r.Context(), r, probe.MessageID)
	if tenantID == "" {
		writeJSONErr(w, http.StatusBadRequest, "tenant_unresolved",
			"could not resolve tenant from MessageID or "+TenantHeader)
		return
	}

	if probe.Type == "SpamComplaint" {
		ev, err := ParsePostmarkComplaint(body)
		if err != nil {
			httperror.WriteInternal(w, d.log(), err, r.Context())
			return
		}
		if err := d.Repo.RecordComplaint(r.Context(), tenantID, *ev); err != nil {
			httperror.WriteInternal(w, d.log(), err, r.Context())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"recorded": "complaint"})
		return
	}

	ev, err := ParsePostmarkBounce(body)
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	if err := d.Repo.RecordBounce(r.Context(), tenantID, *ev); err != nil {
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recorded": "bounce"})
}

// HandleSendGrid ingests a SendGrid event-webhook batch. SendGrid POSTs
// an array; we may record many bounces + complaints from one request.
func (d *Deps) HandleSendGrid(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, batchFeedbackMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeJSONErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "SendGrid feedback payload exceeds 4 MiB")
			return
		}
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	if !d.verifyHMAC(w, r, body, d.SendGridSecret, SendGridSignatureHeader, SendGridTimestampHeader) {
		return
	}

	bounces, complaints, err := ParseSendGridBatch(body)
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}

	bouncesRecorded := 0
	complaintsRecorded := 0
	for _, b := range bounces {
		tenantID := d.resolveTenant(r.Context(), r, b.ESPMessageID)
		if tenantID == "" {
			d.log().Warn("feedback: drop sendgrid bounce w/o tenant",
				"esp_message_id", b.ESPMessageID, "email_redacted", observability.RedactEmail(b.SubscriberEmail))
			continue
		}
		if err := d.Repo.RecordBounce(r.Context(), tenantID, b); err != nil {
			d.log().Error("feedback: record sendgrid bounce", "err", err.Error())
			continue
		}
		bouncesRecorded++
	}
	for _, c := range complaints {
		tenantID := d.resolveTenant(r.Context(), r, c.ESPMessageID)
		if tenantID == "" {
			d.log().Warn("feedback: drop sendgrid complaint w/o tenant",
				"esp_message_id", c.ESPMessageID, "email_redacted", observability.RedactEmail(c.SubscriberEmail))
			continue
		}
		if err := d.Repo.RecordComplaint(r.Context(), tenantID, c); err != nil {
			d.log().Error("feedback: record sendgrid complaint", "err", err.Error())
			continue
		}
		complaintsRecorded++
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"bounces":    bouncesRecorded,
		"complaints": complaintsRecorded,
	})
}

// HandleARF ingests a multipart/report ARF (RFC 5965) abuse report.
func (d *Deps) HandleARF(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, batchFeedbackMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeJSONErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "ARF feedback payload exceeds 4 MiB")
			return
		}
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	if !d.verifyHMAC(w, r, body, d.ARFSecret, ARFSignatureHeader, ARFTimestampHeader) {
		return
	}
	ev, err := ParseARFReport(body, r.Header.Get("Content-Type"))
	if err != nil {
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	tenantID := d.resolveTenant(r.Context(), r, ev.ESPMessageID)
	if tenantID == "" {
		writeJSONErr(w, http.StatusBadRequest, "tenant_unresolved",
			"ARF report has no esp_message_id; "+TenantHeader+" header required")
		return
	}
	if err := d.Repo.RecordComplaint(r.Context(), tenantID, *ev); err != nil {
		httperror.WriteInternal(w, d.log(), err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recorded": "complaint"})
}

// HandleHistory returns bounce + complaint history for one canonical mailbox.
// The address is accepted only in a bounded JSON body so it never enters URLs,
// request-target logs, browser history, or intermediary cache keys. The caller
// mounts this handler behind tenant resolution and the admin scope.
func (d *Deps) HandleHistory(w http.ResponseWriter, r *http.Request) {
	setSensitiveNoStoreHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSONErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	email, err := decodeHistoryRequest(w, r)
	if err != nil {
		if errors.Is(err, errInvalidHistoryEmail) {
			writeJSONErr(w, http.StatusBadRequest, "invalid_email", "A valid subscriber email is required")
			return
		}
		writeJSONErr(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	bounces, complaints, err := d.Repo.ListByEmail(r.Context(), t.ID, email)
	if err != nil {
		// Database errors are intentionally replaced before logging: no driver or
		// wrapper error may accidentally echo the bound mailbox identity.
		httperror.WriteInternal(w, d.log(), errors.New("feedback history datastore lookup failed"), r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"bounces":    projectHistoryBounces(bounces),
		"complaints": projectHistoryComplaints(complaints),
	})
}

type historyBounceRow struct {
	ID           int64     `json:"id,omitempty"`
	BounceType   string    `json:"bounce_type"`
	ESP          string    `json:"esp"`
	ESPMessageID string    `json:"esp_message_id,omitempty"`
	ReceivedAt   time.Time `json:"received_at"`
}

type historyComplaintRow struct {
	ID            int64     `json:"id,omitempty"`
	ComplaintType string    `json:"complaint_type"`
	ESP           string    `json:"esp,omitempty"`
	ESPMessageID  string    `json:"esp_message_id,omitempty"`
	ReceivedAt    time.Time `json:"received_at"`
}

func projectHistoryBounces(events []BounceEvent) []historyBounceRow {
	rows := make([]historyBounceRow, 0, len(events))
	for _, event := range events {
		rows = append(rows, historyBounceRow{
			ID: event.ID, BounceType: event.BounceType, ESP: event.ESP,
			ESPMessageID: event.ESPMessageID, ReceivedAt: event.ReceivedAt,
		})
	}
	return rows
}

func projectHistoryComplaints(events []ComplaintEvent) []historyComplaintRow {
	rows := make([]historyComplaintRow, 0, len(events))
	for _, event := range events {
		rows = append(rows, historyComplaintRow{
			ID: event.ID, ComplaintType: event.ComplaintType, ESP: event.ESP,
			ESPMessageID: event.ESPMessageID, ReceivedAt: event.ReceivedAt,
		})
	}
	return rows
}

func decodeHistoryRequest(w http.ResponseWriter, r *http.Request) (string, error) {
	var in struct {
		Email string `json:"email"`
	}
	if err := httpbody.DecodeJSON(w, r, feedbackHistoryMaxBodyBytes, &in); err != nil {
		return "", err
	}
	canonical, err := emailidentity.Normalize(in.Email)
	if err != nil {
		return "", errInvalidHistoryEmail
	}
	return canonical, nil
}

func setSensitiveNoStoreHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}

// resolveTenant tries esp_message_id → tenant lookup first, then falls
// back to TenantHeader. Returns "" when neither path produces a tenant.
func (d *Deps) resolveTenant(ctx context.Context, r *http.Request, espMessageID string) string {
	if espMessageID != "" {
		if id, err := d.Repo.LookupTenantByESPMessageID(ctx, espMessageID); err == nil && id != "" {
			return id
		} else if err != nil {
			d.log().Warn("feedback: tenant lookup by esp_message_id failed", "err", err.Error())
		}
	}
	return strings.TrimSpace(r.Header.Get(TenantHeader))
}

// verifyHMAC applies the same HMAC contract as listmonk_events: signed
// string is `timestamp.body`, hex-encoded SHA-256 in sigHeader, unix-
// second timestamp in tsHeader. Empty secret + AllowUnsignedDevBypass
// skips verification entirely (dev only).
//
// Writes the failure response itself; returns false when the request
// should NOT proceed.
func (d *Deps) verifyHMAC(w http.ResponseWriter, r *http.Request, body []byte, secret, sigHeader, tsHeader string) bool {
	if secret == "" {
		if d.AllowUnsignedDevBypass {
			return true
		}
		writeJSONErr(w, http.StatusUnauthorized, "webhook_secret_required", sigHeader+" verification not configured")
		return false
	}
	sig := strings.TrimSpace(r.Header.Get(sigHeader))
	if sig == "" {
		writeJSONErr(w, http.StatusUnauthorized, "missing_signature", sigHeader+" required")
		return false
	}
	ts := strings.TrimSpace(r.Header.Get(tsHeader))
	if ts == "" {
		writeJSONErr(w, http.StatusUnauthorized, "missing_timestamp", tsHeader+" required")
		return false
	}
	tsUnix, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		writeJSONErr(w, http.StatusUnauthorized, "bad_timestamp", "must be unix seconds")
		return false
	}
	drift := d.now().Sub(time.Unix(tsUnix, 0).UTC())
	if drift < 0 {
		drift = -drift
	}
	if drift > ReplayTolerance {
		writeJSONErr(w, http.StatusUnauthorized, "stale_timestamp", "outside replay window")
		return false
	}
	if !verifyHMACSig(secret, body, sig, ts) {
		writeJSONErr(w, http.StatusUnauthorized, "bad_signature", "")
		return false
	}
	return true
}

// verifyHMACSig is the constant-time check. Same shape as
// listmonk_events.verifyHMAC: signed string is "<timestamp>.<body>".
func verifyHMACSig(secret string, body []byte, sigHex, timestamp string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	want := mac.Sum(nil)
	got, err := hex.DecodeString(strings.TrimSpace(sigHex))
	if err != nil {
		return false
	}
	return hmac.Equal(want, got)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeJSONErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

// Ensure the errors import stays referenced (kept for symmetry with
// other internal handlers that surface ErrNotFound style values).
var _ = errors.New
