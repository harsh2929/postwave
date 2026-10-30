// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingCrispWebhookSecret    = errors.New("crisp webhook secret is required")
	ErrMissingCrispWebhookSignature = errors.New("crisp webhook signature is required")
	ErrInvalidCrispWebhookSignature = errors.New("invalid crisp webhook signature")
	ErrStaleCrispWebhookSignature   = errors.New("stale crisp webhook signature timestamp")
)

type CrispWebhookStore interface {
	FindCrispIntegrationByWebsite(ctx context.Context, websiteID, webhookID string) (*Integration, error)
}

// CrispWebhook receives signed Crisp plugin hook deliveries scoped to a website.
func (d *Deps) CrispWebhook(w http.ResponseWriter, r *http.Request) {
	websiteID := strings.TrimSpace(chi.URLParam(r, "website_id"))
	if websiteID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_website_id", "crisp website id is required")
		return
	}
	store, ok := d.Repo.(CrispWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "crisp webhook lookup is not configured")
		return
	}
	webhookID := crispWebhookID(r)
	integration, err := store.FindCrispIntegrationByWebsite(r.Context(), websiteID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "crisp integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "crisp payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read crisp webhook body")
		return
	}
	secret, err := d.crispWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyCrispWebhookSignature(secret, body, crispWebhookTimestamp(r), crispWebhookSignature(r), d.now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := crispWebhookTopic(body)
	deliveryID := crispWebhookDeliveryID(r, websiteID, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderCrisp, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		w.WriteHeader(http.StatusOK)
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	req, ok := mapCrispWebhook(body, *integration, webhookID)
	if !ok {
		sessionID := crispSessionIDFromWebhook(body)
		if sessionID != "" {
			refreshed, refreshedOK, err := d.refreshCrispWebhookConversation(r.Context(), integration, sessionID, body, webhookID, topic)
			if err != nil {
				if crispRefreshConversationMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderCrisp, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "conversation_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderCrisp, deliveryID, err)
				writeCrispRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderCrisp, deliveryID); err != nil {
				httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true})
			return
		}
	}
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderCrisp, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "crisp webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderCrisp, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderCrisp, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshCrispWebhookConversation(ctx context.Context, integration *Integration, sessionID string, body []byte, webhookID, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.CrispBackfiller.(CrispConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("crisp conversation refresh is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, sessionID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = crispWebhookRefreshRequest(req, body, webhookID, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func crispWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	raw := crispWebhookRaw(body)
	sessionID := crispSessionIDFromRaw(raw)
	in.RunMode = "webhook"
	in.Cursor = "crisp-webhook-" + firstString(sessionID, crispWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["crisp_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["crisp_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["crisp_refresh_source"] = "webhook_sparse_session"
		in.Tickets[i].Properties["crisp_raw"] = raw
	}
	return normalizeSyncRequest(in)
}

func crispRefreshConversationMissing(err error) bool {
	var restErr CrispRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeCrispRefreshError(w http.ResponseWriter, err error) {
	var restErr CrispRESTError
	if errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		seconds := int(restErr.RetryAfter / time.Second)
		if restErr.RetryAfter%time.Second != 0 {
			seconds++
		}
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}
	httperror.Write(w, http.StatusServiceUnavailable, "crisp_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) crispWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingCrispWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "crisp_webhook_secret_ref"),
		settingString(integration.Settings, "crisp_webhook_signature_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingCrispWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingCrispWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyCrispWebhookSignature(secret string, body []byte, timestampHeader, signatureHeader string, now time.Time) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingCrispWebhookSecret
	}
	timestampHeader = strings.TrimSpace(timestampHeader)
	signatureHeader = strings.TrimSpace(signatureHeader)
	if timestampHeader == "" || signatureHeader == "" {
		return ErrMissingCrispWebhookSignature
	}
	if err := crispValidateSignatureTimestamp(timestampHeader, now); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("["))
	mac.Write([]byte(timestampHeader))
	mac.Write([]byte(";"))
	mac.Write(body)
	mac.Write([]byte("]"))
	if crispSignatureMatches(signatureHeader, mac.Sum(nil)) {
		return nil
	}
	return ErrInvalidCrispWebhookSignature
}

func crispValidateSignatureTimestamp(raw string, now time.Time) error {
	if now.IsZero() {
		return nil
	}
	ts, ok := crispParseTimestamp(raw)
	if !ok {
		return ErrStaleCrispWebhookSignature
	}
	delta := now.UTC().Sub(ts)
	if delta < 0 {
		delta = -delta
	}
	if delta > zendeskWebhookSignatureTolerance {
		return ErrStaleCrispWebhookSignature
	}
	return nil
}

func crispSignatureMatches(raw string, expected []byte) bool {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "sha256="))
	if decoded, err := hex.DecodeString(raw); err == nil && hmac.Equal(decoded, expected) {
		return true
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && hmac.Equal(decoded, expected) {
		return true
	}
	return hmac.Equal([]byte(raw), []byte(hex.EncodeToString(expected)))
}

func mapCrispWebhook(body []byte, _ Integration, webhookID string) (SyncRequest, bool) {
	raw := crispWebhookRaw(body)
	if raw == nil {
		return SyncRequest{}, false
	}
	sessionID := crispSessionIDFromRaw(raw)
	email := strings.ToLower(strings.TrimSpace(crispWebhookEmail(raw)))
	if sessionID == "" || email == "" {
		return SyncRequest{}, false
	}
	topic := crispWebhookTopicFromRaw(raw)
	ticket := TicketInput{
		SourceID:       "crisp://conversation/" + sessionID,
		ConversationID: sessionID,
		Email:          email,
		RequesterName:  crispWebhookRequesterName(raw),
		Subject:        crispWebhookSubject(raw),
		Status:         crispWebhookStatus(raw),
		Tags:           crispWebhookSegments(raw),
		Properties: map[string]any{
			"crisp_session_id":    sessionID,
			"crisp_webhook_id":    strings.TrimSpace(webhookID),
			"crisp_webhook_event": topic,
			"crisp_event_id":      crispWebhookEventID(raw),
			"crisp_raw":           raw,
		},
	}
	if t := crispWebhookOccurredAt(raw); t != nil {
		ticket.UpdatedAt = t
	}
	messages := crispWebhookMessages(raw, sessionID, email, topic, webhookID)
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "crisp-webhook-" + firstString(crispWebhookEventID(raw), sessionID, crispWebhookLocalID(body))}
	return normalizeSyncRequest(req), true
}

func crispWebhookMessages(raw map[string]any, sessionID, email, topic, webhookID string) []MessageInput {
	bodyText := strings.TrimSpace(firstString(
		crispWebhookString(raw, "data", "content"),
		crispWebhookString(raw, "data", "text"),
		crispWebhookString(raw, "content"),
		crispWebhookString(raw, "text"),
		crispWebhookString(raw, "message", "text"),
		crispWebhookString(raw, "message", "content"),
	))
	if bodyText == "" {
		return nil
	}
	messageID := firstString(
		crispWebhookString(raw, "data", "fingerprint"),
		crispWebhookString(raw, "data", "message_id"),
		crispWebhookString(raw, "message", "id"),
		crispWebhookEventID(raw),
	)
	direction := "inbound"
	senderType := "customer"
	from := strings.ToLower(strings.TrimSpace(firstString(crispWebhookString(raw, "data", "from"), crispWebhookString(raw, "from"))))
	if from == "operator" || from == "agent" || strings.Contains(strings.ToLower(topic), "operator") {
		direction = "outbound"
		senderType = "agent"
	}
	message := MessageInput{
		SourceID:       "crisp://message/" + firstString(messageID, sessionID),
		ConversationID: sessionID,
		Email:          email,
		RequesterName:  crispWebhookRequesterName(raw),
		Direction:      direction,
		SenderType:     senderType,
		Sender:         crispWebhookRequesterName(raw),
		BodyText:       bodyText,
		Properties: map[string]any{
			"crisp_message_id":    messageID,
			"crisp_webhook_id":    strings.TrimSpace(webhookID),
			"crisp_webhook_event": topic,
		},
	}
	if t := crispWebhookOccurredAt(raw); t != nil {
		message.OccurredAt = t
	}
	return []MessageInput{message}
}

func crispWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	return raw
}

func crispSessionIDFromWebhook(body []byte) string {
	return crispSessionIDFromRaw(crispWebhookRaw(body))
}

func crispSessionIDFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return firstString(
		crispWebhookString(raw, "session_id"),
		crispWebhookString(raw, "data", "session_id"),
		crispWebhookString(raw, "conversation", "session_id"),
		crispWebhookString(raw, "message", "session_id"),
	)
}

func crispWebhookEmail(raw map[string]any) string {
	return firstString(
		crispWebhookString(raw, "email"),
		crispWebhookString(raw, "data", "email"),
		crispWebhookString(raw, "data", "user", "email"),
		crispWebhookString(raw, "data", "meta", "email"),
		crispWebhookString(raw, "user", "email"),
		crispWebhookString(raw, "meta", "email"),
	)
}

func crispWebhookRequesterName(raw map[string]any) string {
	return firstString(
		crispWebhookString(raw, "data", "nickname"),
		crispWebhookString(raw, "data", "user", "nickname"),
		crispWebhookString(raw, "data", "user", "name"),
		crispWebhookString(raw, "data", "meta", "nickname"),
		crispWebhookString(raw, "nickname"),
		crispWebhookString(raw, "user", "nickname"),
	)
}

func crispWebhookSubject(raw map[string]any) string {
	return firstString(
		crispWebhookString(raw, "data", "subject"),
		crispWebhookString(raw, "data", "meta", "subject"),
		crispWebhookString(raw, "subject"),
		crispWebhookString(raw, "meta", "subject"),
	)
}

func crispWebhookStatus(raw map[string]any) string {
	return firstString(
		crispWebhookString(raw, "data", "state"),
		crispWebhookString(raw, "data", "status"),
		crispWebhookString(raw, "state"),
		crispWebhookString(raw, "status"),
	)
}

func crispWebhookSegments(raw map[string]any) []string {
	return webhookStringSlice(raw, "data", "segments")
}

func crispWebhookEventID(raw map[string]any) string {
	return firstString(
		crispWebhookString(raw, "id"),
		crispWebhookString(raw, "event_id"),
		crispWebhookString(raw, "delivery_id"),
		crispWebhookString(raw, "data", "fingerprint"),
	)
}

func crispWebhookTopic(body []byte) string {
	return crispWebhookTopicFromRaw(crispWebhookRaw(body))
}

func crispWebhookTopicFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return firstString(
		crispWebhookString(raw, "event"),
		crispWebhookString(raw, "type"),
		crispWebhookString(raw, "topic"),
	)
}

func crispWebhookOccurredAt(raw map[string]any) *time.Time {
	value := firstString(
		crispWebhookString(raw, "timestamp"),
		crispWebhookString(raw, "data", "timestamp"),
		crispWebhookString(raw, "created_at"),
	)
	if value == "" {
		return nil
	}
	if t, ok := crispParseTimestamp(value); ok {
		return &t
	}
	return nil
}

func crispParseTimestamp(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return parsed.UTC(), true
	}
	if unixFloat, err := strconv.ParseFloat(raw, 64); err == nil {
		if unixFloat > 1_000_000_000_000 {
			secs := int64(unixFloat / 1000)
			nanos := int64((unixFloat - float64(secs*1000)) * float64(time.Millisecond))
			return time.Unix(secs, nanos).UTC(), true
		}
		secs := int64(unixFloat)
		nanos := int64((unixFloat - float64(secs)) * float64(time.Second))
		return time.Unix(secs, nanos).UTC(), true
	}
	return time.Time{}, false
}

func crispWebhookString(node map[string]any, path ...string) string {
	return supportWebhookString(node, path...)
}

func crispWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Crisp-Webhook-Id"),
		r.Header.Get("X-Crisp-Webhook-ID"),
		r.Header.Get("X-Crisp-Hook-Id"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("crisp_webhook_id"),
	))
}

func crispWebhookTimestamp(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Crisp-Request-Timestamp"),
		r.Header.Get("X-Crisp-Timestamp"),
		r.Header.Get("X-Request-Timestamp"),
	))
}

func crispWebhookSignature(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Crisp-Signature"),
		r.Header.Get("X-Crisp-Hook-Signature"),
		r.Header.Get("X-Hub-Signature-256"),
	))
}

func crispWebhookDeliveryID(r *http.Request, websiteID, webhookID string, body []byte) string {
	raw := crispWebhookRaw(body)
	return firstString(
		strings.TrimSpace(r.Header.Get("X-Crisp-Event-Id")),
		strings.TrimSpace(r.Header.Get("X-Crisp-Delivery-Id")),
		strings.TrimSpace(r.Header.Get("X-Request-Id")),
		crispWebhookEventID(raw),
		"crisp:"+strings.TrimSpace(websiteID)+":webhook:"+strings.TrimSpace(webhookID)+":"+crispWebhookLocalID(body),
	)
}

func crispWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func webhookStringSlice(node map[string]any, path ...string) []string {
	cur := any(node)
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[key]
	}
	switch typed := cur.(type) {
	case []string:
		return typed
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			if v := strings.TrimSpace(fmt.Sprint(item)); v != "" {
				out = append(out, v)
			}
		}
		return out
	default:
		return nil
	}
}
