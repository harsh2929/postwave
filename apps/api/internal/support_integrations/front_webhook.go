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
	ErrMissingFrontWebhookSecret    = errors.New("front webhook secret is required")
	ErrMissingFrontWebhookSignature = errors.New("front webhook signature is required")
	ErrInvalidFrontWebhookSignature = errors.New("invalid front webhook signature")
	ErrStaleFrontWebhookSignature   = errors.New("stale front webhook signature timestamp")
)

type FrontWebhookStore interface {
	FindFrontIntegrationByInbox(ctx context.Context, inboxID, webhookID string) (*Integration, error)
}

// FrontWebhook receives Front application/rule webhook deliveries scoped to a
// configured inbox. It verifies Front's HMAC signature before claiming the
// delivery and writing support rows.
func (d *Deps) FrontWebhook(w http.ResponseWriter, r *http.Request) {
	inboxID := strings.TrimSpace(chi.URLParam(r, "inbox_id"))
	if inboxID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_inbox_id", "front inbox id is required")
		return
	}
	store, ok := d.Repo.(FrontWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "front webhook lookup is not configured")
		return
	}
	webhookID := frontWebhookID(r)
	integration, err := store.FindFrontIntegrationByInbox(r.Context(), inboxID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "front integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "front payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read front webhook body")
		return
	}
	secret, err := d.frontWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyFrontWebhookSignature(secret, body, frontWebhookTimestamp(r), frontWebhookSignature(r), d.now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	if challenge := frontWebhookChallenge(r, body); challenge != "" {
		writeJSON(w, http.StatusOK, map[string]any{"challenge": challenge})
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := frontWebhookTopic(body)
	deliveryID := frontWebhookDeliveryID(r, inboxID, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderFront, deliveryID, topic, body)
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
	req, ok := mapFrontWebhook(body, *integration, webhookID)
	if !ok {
		conversationID := frontConversationIDFromWebhook(body)
		if conversationID != "" {
			refreshed, refreshedOK, err := d.refreshFrontWebhookConversation(r.Context(), integration, conversationID, body, webhookID, topic)
			if err != nil {
				if frontRefreshConversationMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFront, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "conversation_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFront, deliveryID, err)
				writeFrontRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFront, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFront, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "front webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFront, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFront, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshFrontWebhookConversation(ctx context.Context, integration *Integration, conversationID string, body []byte, webhookID, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.FrontBackfiller.(FrontConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("front conversation refresh is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = frontWebhookRefreshRequest(req, body, webhookID, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func frontWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	raw := frontWebhookRaw(body)
	conversationID := frontConversationIDFromRaw(raw)
	in.RunMode = "webhook"
	in.Cursor = "front-webhook-" + firstString(conversationID, frontWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["front_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["front_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["front_refresh_source"] = "webhook_sparse_conversation"
		in.Tickets[i].Properties["front_raw"] = raw
	}
	return normalizeSyncRequest(in)
}

func frontRefreshConversationMissing(err error) bool {
	var restErr FrontRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeFrontRefreshError(w http.ResponseWriter, err error) {
	var restErr FrontRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "front_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) frontWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingFrontWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "front_webhook_secret_ref"),
		settingString(integration.Settings, "front_webhook_signature_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingFrontWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingFrontWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyFrontWebhookSignature(secret string, body []byte, timestampHeader, signatureHeader string, now time.Time) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingFrontWebhookSecret
	}
	timestampHeader = strings.TrimSpace(timestampHeader)
	signatureHeader = strings.TrimSpace(signatureHeader)
	if timestampHeader == "" || signatureHeader == "" {
		return ErrMissingFrontWebhookSignature
	}
	if err := frontValidateSignatureTimestamp(timestampHeader, now); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestampHeader))
	mac.Write([]byte(":"))
	mac.Write(body)
	if frontSignatureMatches(signatureHeader, mac.Sum(nil)) {
		return nil
	}
	return ErrInvalidFrontWebhookSignature
}

func frontValidateSignatureTimestamp(raw string, now time.Time) error {
	if now.IsZero() {
		return nil
	}
	var ts time.Time
	raw = strings.TrimSpace(raw)
	if unix, err := strconv.ParseInt(raw, 10, 64); err == nil {
		ts = time.Unix(unix, 0).UTC()
	} else if unixFloat, err := strconv.ParseFloat(raw, 64); err == nil {
		secs := int64(unixFloat)
		nanos := int64((unixFloat - float64(secs)) * float64(time.Second))
		ts = time.Unix(secs, nanos).UTC()
	} else if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		ts = parsed.UTC()
	} else {
		return ErrStaleFrontWebhookSignature
	}
	delta := now.UTC().Sub(ts)
	if delta < 0 {
		delta = -delta
	}
	if delta > zendeskWebhookSignatureTolerance {
		return ErrStaleFrontWebhookSignature
	}
	return nil
}

func frontSignatureMatches(raw string, expected []byte) bool {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "sha256="))
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && hmac.Equal(decoded, expected) {
		return true
	}
	if decoded, err := hex.DecodeString(raw); err == nil && hmac.Equal(decoded, expected) {
		return true
	}
	return hmac.Equal([]byte(raw), []byte(base64.StdEncoding.EncodeToString(expected)))
}

func mapFrontWebhook(body []byte, _ Integration, webhookID string) (SyncRequest, bool) {
	raw := frontWebhookRaw(body)
	if raw == nil {
		return SyncRequest{}, false
	}
	conversationID := frontConversationIDFromRaw(raw)
	email := strings.ToLower(strings.TrimSpace(frontWebhookEmail(raw)))
	if conversationID == "" || email == "" {
		return SyncRequest{}, false
	}
	topic := frontWebhookTopicFromRaw(raw)
	ticket := TicketInput{
		SourceID:       "front://conversation/" + conversationID,
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  frontWebhookRequesterName(raw),
		Subject:        frontWebhookSubject(raw),
		Status:         frontWebhookStatus(raw),
		Properties: map[string]any{
			"front_conversation_id": conversationID,
			"front_webhook_id":      strings.TrimSpace(webhookID),
			"front_webhook_event":   topic,
			"front_event_id":        frontWebhookEventID(raw),
			"front_raw":             raw,
		},
	}
	if t := frontWebhookOccurredAt(raw); t != nil {
		ticket.UpdatedAt = t
	}
	messages := frontWebhookMessages(raw, conversationID, email, topic, webhookID)
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "front-webhook-" + firstString(frontWebhookEventID(raw), conversationID, frontWebhookLocalID(body))}
	return normalizeSyncRequest(req), true
}

func frontWebhookMessages(raw map[string]any, conversationID, email, topic, webhookID string) []MessageInput {
	bodyText := strings.TrimSpace(firstString(
		frontWebhookString(raw, "message", "text"),
		frontWebhookString(raw, "message", "body"),
		frontWebhookString(raw, "message", "body_text"),
		frontWebhookString(raw, "target", "data", "text"),
		frontWebhookString(raw, "target", "data", "body"),
		frontWebhookString(raw, "payload", "message", "text"),
		frontWebhookString(raw, "payload", "message", "body"),
		frontWebhookString(raw, "body"),
		frontWebhookString(raw, "text"),
	))
	if bodyText == "" {
		return nil
	}
	messageID := firstString(
		frontWebhookString(raw, "message", "id"),
		frontWebhookString(raw, "target", "data", "id"),
		frontWebhookString(raw, "payload", "message", "id"),
		frontWebhookEventID(raw),
	)
	direction := "inbound"
	senderType := "customer"
	if strings.Contains(strings.ToLower(topic), "outbound") || strings.Contains(strings.ToLower(topic), "comment") {
		direction = "outbound"
		senderType = "agent"
	}
	message := MessageInput{
		SourceID:       "front://message/" + messageID,
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  frontWebhookRequesterName(raw),
		Direction:      direction,
		SenderType:     senderType,
		Sender:         frontWebhookRequesterName(raw),
		BodyText:       bodyText,
		Properties: map[string]any{
			"front_message_id":    messageID,
			"front_webhook_id":    strings.TrimSpace(webhookID),
			"front_webhook_event": topic,
		},
	}
	if t := frontWebhookOccurredAt(raw); t != nil {
		message.OccurredAt = t
	}
	return []MessageInput{message}
}

func frontWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	return raw
}

func frontConversationIDFromWebhook(body []byte) string {
	return frontConversationIDFromRaw(frontWebhookRaw(body))
}

func frontConversationIDFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	id := firstString(
		frontWebhookString(raw, "conversation", "id"),
		frontWebhookString(raw, "conversation_id"),
		frontWebhookString(raw, "payload", "conversation", "id"),
		frontWebhookString(raw, "target", "data", "conversation", "id"),
		frontWebhookString(raw, "data", "conversation", "id"),
		frontWebhookString(raw, "object", "id"),
	)
	if id != "" {
		return id
	}
	return frontIDFromURL(firstString(
		frontWebhookString(raw, "_links", "related", "conversation"),
		frontWebhookString(raw, "links", "related", "conversation"),
		frontWebhookString(raw, "conversation", "url"),
	))
}

func frontIDFromURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	raw = strings.TrimRight(raw, "/")
	if i := strings.LastIndex(raw, "/"); i >= 0 && i < len(raw)-1 {
		return strings.TrimSpace(raw[i+1:])
	}
	return raw
}

func frontWebhookEmail(raw map[string]any) string {
	return firstString(
		frontWebhookString(raw, "conversation", "recipient", "handle"),
		frontWebhookString(raw, "recipient", "handle"),
		frontWebhookString(raw, "recipient", "email"),
		frontWebhookString(raw, "source", "data", "email"),
		frontWebhookString(raw, "source", "email"),
		frontWebhookString(raw, "target", "data", "email"),
		frontWebhookString(raw, "target", "email"),
		frontWebhookString(raw, "author", "email"),
		frontWebhookString(raw, "user", "email"),
		frontWebhookString(raw, "contact", "email"),
		frontWebhookString(raw, "data", "email"),
		frontWebhookString(raw, "payload", "conversation", "recipient", "handle"),
		frontWebhookString(raw, "payload", "message", "author", "email"),
	)
}

func frontWebhookRequesterName(raw map[string]any) string {
	return firstString(
		frontWebhookString(raw, "conversation", "recipient", "name"),
		frontWebhookString(raw, "recipient", "name"),
		frontWebhookString(raw, "source", "data", "name"),
		frontWebhookString(raw, "source", "name"),
		frontWebhookString(raw, "target", "data", "name"),
		frontWebhookString(raw, "author", "name"),
		frontWebhookString(raw, "user", "name"),
		frontWebhookString(raw, "contact", "name"),
	)
}

func frontWebhookSubject(raw map[string]any) string {
	return firstString(
		frontWebhookString(raw, "conversation", "subject"),
		frontWebhookString(raw, "payload", "conversation", "subject"),
		frontWebhookString(raw, "subject"),
		frontWebhookString(raw, "data", "subject"),
	)
}

func frontWebhookStatus(raw map[string]any) string {
	return firstString(
		frontWebhookString(raw, "conversation", "status"),
		frontWebhookString(raw, "payload", "conversation", "status"),
		frontWebhookString(raw, "status"),
		frontWebhookString(raw, "data", "status"),
	)
}

func frontWebhookEventID(raw map[string]any) string {
	return firstString(
		frontWebhookString(raw, "id"),
		frontWebhookString(raw, "event_id"),
		frontWebhookString(raw, "delivery_id"),
	)
}

func frontWebhookTopic(body []byte) string {
	return frontWebhookTopicFromRaw(frontWebhookRaw(body))
}

func frontWebhookTopicFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return firstString(
		frontWebhookString(raw, "type"),
		frontWebhookString(raw, "event"),
		frontWebhookString(raw, "topic"),
		frontWebhookString(raw, "payload", "type"),
	)
}

func frontWebhookOccurredAt(raw map[string]any) *time.Time {
	value := firstString(
		frontWebhookString(raw, "emitted_at"),
		frontWebhookString(raw, "created_at"),
		frontWebhookString(raw, "timestamp"),
		frontWebhookString(raw, "payload", "emitted_at"),
	)
	if value == "" {
		return nil
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		t := parsed.UTC()
		return &t
	}
	if unixFloat, err := strconv.ParseFloat(value, 64); err == nil {
		secs := int64(unixFloat)
		nanos := int64((unixFloat - float64(secs)) * float64(time.Second))
		t := time.Unix(secs, nanos).UTC()
		return &t
	}
	return nil
}

func frontWebhookString(node map[string]any, path ...string) string {
	return supportWebhookString(node, path...)
}

func frontWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Front-Webhook-Id"),
		r.Header.Get("X-Front-Webhook-ID"),
		r.Header.Get("X-Front-Webhook"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("front_webhook_id"),
	))
}

func frontWebhookTimestamp(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Front-Request-Timestamp"),
		r.Header.Get("X-Front-Timestamp"),
		r.Header.Get("X-Request-Timestamp"),
	))
}

func frontWebhookSignature(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Front-Signature"),
		r.Header.Get("X-Front-Webhook-Signature"),
		r.Header.Get("X-Hub-Signature-256"),
	))
}

func frontWebhookChallenge(r *http.Request, body []byte) string {
	if r != nil {
		if v := strings.TrimSpace(firstString(r.Header.Get("X-Front-Challenge"), r.URL.Query().Get("challenge"))); v != "" {
			return v
		}
	}
	raw := frontWebhookRaw(body)
	if raw == nil {
		return ""
	}
	return firstString(
		frontWebhookString(raw, "challenge"),
		frontWebhookString(raw, "data", "challenge"),
	)
}

func frontWebhookDeliveryID(r *http.Request, inboxID, webhookID string, body []byte) string {
	raw := frontWebhookRaw(body)
	return firstString(
		strings.TrimSpace(r.Header.Get("X-Front-Event-Id")),
		strings.TrimSpace(r.Header.Get("X-Front-Delivery-Id")),
		strings.TrimSpace(r.Header.Get("X-Request-Id")),
		frontWebhookEventID(raw),
		"front:"+strings.TrimSpace(inboxID)+":webhook:"+strings.TrimSpace(webhookID)+":"+frontWebhookLocalID(body),
	)
}

func frontWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
