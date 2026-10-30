// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingLiveChatWebhookSecret = errors.New("livechat webhook secret is required")
	ErrInvalidLiveChatWebhookSecret = errors.New("invalid livechat webhook secret")
)

type LiveChatWebhookStore interface {
	FindLiveChatIntegrationByAccount(ctx context.Context, accountID, webhookID string) (*Integration, error)
}

// LiveChatWebhook receives LiveChat Chat Webhook deliveries scoped to a
// configured account/organization id. LiveChat sends a secret_key in the JSON
// envelope, so verification is a constant-time shared-secret check rather than
// HMAC over the body.
func (d *Deps) LiveChatWebhook(w http.ResponseWriter, r *http.Request) {
	accountID := strings.TrimSpace(chi.URLParam(r, "account_id"))
	if accountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "livechat account id is required")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "livechat payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read livechat webhook body")
		return
	}
	if !liveChatWebhookAccountMatches(accountID, body) {
		httperror.Write(w, http.StatusBadRequest, "account_mismatch", "livechat webhook account does not match route")
		return
	}
	store, ok := d.Repo.(LiveChatWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "livechat webhook lookup is not configured")
		return
	}
	webhookID := liveChatWebhookID(r, body)
	integration, err := store.FindLiveChatIntegrationByAccount(r.Context(), accountID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "livechat integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret, err := d.liveChatWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyLiveChatWebhookSecret(secret, liveChatWebhookSecretValue(r, body)); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_secret", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := liveChatWebhookTopic(body)
	deliveryID := liveChatWebhookDeliveryID(r, accountID, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderLiveChat, deliveryID, topic, body)
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
	req, ok := mapLiveChatWebhook(body, *integration, webhookID)
	if !ok {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderLiveChat, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true})
		return
	}
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderLiveChat, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "livechat webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderLiveChat, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderLiveChat, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) liveChatWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingLiveChatWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "livechat_webhook_secret_ref"),
		settingString(integration.Settings, "livechat_webhook_signature_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_auth_ref"),
	))
	if ref == "" {
		return "", ErrMissingLiveChatWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingLiveChatWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyLiveChatWebhookSecret(secret, got string) error {
	secret = strings.TrimSpace(secret)
	got = strings.TrimSpace(got)
	if secret == "" || got == "" {
		return ErrMissingLiveChatWebhookSecret
	}
	if subtle.ConstantTimeCompare([]byte(secret), []byte(got)) == 1 {
		return nil
	}
	return ErrInvalidLiveChatWebhookSecret
}

func mapLiveChatWebhook(body []byte, _ Integration, webhookID string) (SyncRequest, bool) {
	raw := liveChatWebhookRaw(body)
	if raw == nil {
		return SyncRequest{}, false
	}
	chat := liveChatWebhookChat(raw)
	chatID := liveChatWebhookChatID(raw, chat)
	email, name, customerID := liveChatWebhookCustomer(chat)
	if chatID == "" || email == "" {
		return SyncRequest{}, false
	}
	topic := liveChatWebhookTopicFromRaw(raw)
	threadID := liveChatWebhookString(chat, "thread", "id")
	ticket := TicketInput{
		SourceID:       "livechat://chat/" + chatID,
		ConversationID: chatID,
		Email:          email,
		RequesterName:  name,
		Status:         liveChatWebhookStatus(topic),
		Properties: map[string]any{
			"livechat_chat_id":       chatID,
			"livechat_thread_id":     threadID,
			"livechat_customer_id":   customerID,
			"livechat_webhook_id":    strings.TrimSpace(webhookID),
			"livechat_webhook_event": topic,
			"livechat_organization":  liveChatWebhookAccountFromRaw(raw),
			"livechat_raw":           liveChatWebhookScrubbedRaw(raw),
		},
	}
	if t := liveChatWebhookOccurredAt(raw, chat); t != nil {
		ticket.UpdatedAt = t
	}
	messages := liveChatWebhookMessages(raw, chat, chatID, email, name, webhookID, topic)
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "livechat-webhook-" + firstString(liveChatWebhookEventID(raw), chatID, liveChatWebhookLocalID(body))}
	return normalizeSyncRequest(req), true
}

func liveChatWebhookMessages(raw, chat map[string]any, chatID, email, requesterName, webhookID, topic string) []MessageInput {
	events := liveChatWebhookEvents(chat)
	if len(events) == 0 {
		return nil
	}
	authorTypes := liveChatWebhookAuthorTypes(chat)
	threadID := liveChatWebhookString(chat, "thread", "id")
	messages := make([]MessageInput, 0, len(events))
	for i, event := range events {
		eventMap, ok := event.(map[string]any)
		if !ok {
			continue
		}
		text := strings.TrimSpace(firstString(
			liveChatWebhookString(eventMap, "text"),
			liveChatWebhookString(eventMap, "message"),
			liveChatWebhookString(eventMap, "content"),
		))
		if text == "" {
			continue
		}
		eventType := strings.TrimSpace(liveChatWebhookString(eventMap, "type"))
		eventID := strings.TrimSpace(firstString(liveChatWebhookString(eventMap, "id"), liveChatWebhookString(eventMap, "event_id")))
		authorID := strings.TrimSpace(liveChatWebhookString(eventMap, "author_id"))
		direction := "inbound"
		senderType := "customer"
		if authorType := strings.ToLower(strings.TrimSpace(authorTypes[authorID])); authorType == "agent" || authorType == "bot" {
			direction = "outbound"
			senderType = authorType
		}
		message := MessageInput{
			SourceID:       "livechat://event/" + firstString(eventID, chatID+"-"+strconv.Itoa(i+1)),
			ConversationID: chatID,
			Email:          email,
			RequesterName:  requesterName,
			Direction:      direction,
			SenderType:     senderType,
			Sender:         requesterName,
			BodyText:       text,
			Properties: map[string]any{
				"livechat_event_id":      eventID,
				"livechat_event_type":    eventType,
				"livechat_thread_id":     threadID,
				"livechat_author_id":     authorID,
				"livechat_webhook_id":    strings.TrimSpace(webhookID),
				"livechat_webhook_event": topic,
			},
		}
		if t := liveChatWebhookEventTime(eventMap); t != nil {
			message.OccurredAt = t
		} else if t := liveChatWebhookOccurredAt(raw, chat); t != nil {
			message.OccurredAt = t
		}
		messages = append(messages, message)
	}
	return messages
}

func liveChatWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	return raw
}

func liveChatWebhookScrubbedRaw(raw map[string]any) map[string]any {
	if raw == nil {
		return nil
	}
	out := make(map[string]any, len(raw))
	for k, v := range raw {
		if strings.EqualFold(k, "secret_key") || strings.EqualFold(k, "secret") {
			continue
		}
		out[k] = v
	}
	if payload, ok := out["payload"].(map[string]any); ok {
		payloadCopy := make(map[string]any, len(payload))
		for k, v := range payload {
			if strings.EqualFold(k, "secret_key") || strings.EqualFold(k, "secret") {
				continue
			}
			payloadCopy[k] = v
		}
		out["payload"] = payloadCopy
	}
	return out
}

func liveChatWebhookChat(raw map[string]any) map[string]any {
	if chat := liveChatWebhookMap(raw, "payload", "chat"); chat != nil {
		return chat
	}
	if chat := liveChatWebhookMap(raw, "chat"); chat != nil {
		return chat
	}
	return map[string]any{}
}

func liveChatWebhookChatID(raw, chat map[string]any) string {
	return firstString(
		liveChatWebhookString(chat, "id"),
		liveChatWebhookString(raw, "payload", "chat_id"),
		liveChatWebhookString(raw, "chat_id"),
		liveChatWebhookString(raw, "id"),
	)
}

func liveChatWebhookCustomer(chat map[string]any) (email, name, id string) {
	for _, user := range liveChatWebhookArray(chat, "users") {
		userMap, ok := user.(map[string]any)
		if !ok {
			continue
		}
		userType := strings.ToLower(strings.TrimSpace(liveChatWebhookString(userMap, "type")))
		if userType != "customer" && userType != "visitor" {
			continue
		}
		email = strings.ToLower(strings.TrimSpace(liveChatWebhookString(userMap, "email")))
		if email == "" {
			continue
		}
		name = strings.TrimSpace(liveChatWebhookString(userMap, "name"))
		id = strings.TrimSpace(liveChatWebhookString(userMap, "id"))
		return email, name, id
	}
	return "", "", ""
}

func liveChatWebhookAuthorTypes(chat map[string]any) map[string]string {
	out := map[string]string{}
	for _, user := range liveChatWebhookArray(chat, "users") {
		userMap, ok := user.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(liveChatWebhookString(userMap, "id"))
		if id == "" {
			continue
		}
		out[id] = strings.TrimSpace(liveChatWebhookString(userMap, "type"))
	}
	return out
}

func liveChatWebhookEvents(chat map[string]any) []any {
	if events := liveChatWebhookArray(chat, "thread", "events"); len(events) > 0 {
		return events
	}
	return liveChatWebhookArray(chat, "events")
}

func liveChatWebhookTopic(body []byte) string {
	return liveChatWebhookTopicFromRaw(liveChatWebhookRaw(body))
}

func liveChatWebhookTopicFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return firstString(
		liveChatWebhookString(raw, "action"),
		liveChatWebhookString(raw, "type"),
		liveChatWebhookString(raw, "event"),
	)
}

func liveChatWebhookStatus(topic string) string {
	switch strings.ToLower(strings.TrimSpace(topic)) {
	case "chat_ended", "chat_archived":
		return "archived"
	case "incoming_chat", "chat_started":
		return "open"
	default:
		return strings.TrimSpace(topic)
	}
}

func liveChatWebhookEventID(raw map[string]any) string {
	return firstString(
		liveChatWebhookString(raw, "event_id"),
		liveChatWebhookString(raw, "delivery_id"),
		liveChatWebhookString(raw, "id"),
	)
}

func liveChatWebhookOccurredAt(raw, chat map[string]any) *time.Time {
	value := firstString(
		liveChatWebhookString(raw, "created_at"),
		liveChatWebhookString(raw, "timestamp"),
		liveChatWebhookString(chat, "created_at"),
		liveChatWebhookString(chat, "thread", "created_at"),
	)
	return liveChatWebhookParseTime(value)
}

func liveChatWebhookEventTime(event map[string]any) *time.Time {
	return liveChatWebhookParseTime(firstString(
		liveChatWebhookString(event, "created_at"),
		liveChatWebhookString(event, "timestamp"),
		liveChatWebhookString(event, "date"),
	))
}

func liveChatWebhookParseTime(value string) *time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		t := parsed.UTC()
		return &t
	}
	return nil
}

func liveChatWebhookAccountMatches(accountID string, body []byte) bool {
	raw := liveChatWebhookRaw(body)
	if raw == nil {
		return true
	}
	payloadAccount := liveChatWebhookAccountFromRaw(raw)
	return payloadAccount == "" || payloadAccount == strings.TrimSpace(accountID)
}

func liveChatWebhookAccountFromRaw(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		liveChatWebhookString(raw, "organization_id"),
		liveChatWebhookString(raw, "account_id"),
		liveChatWebhookString(raw, "license_id"),
		liveChatWebhookString(raw, "payload", "organization_id"),
	))
}

func liveChatWebhookID(r *http.Request, body []byte) string {
	raw := liveChatWebhookRaw(body)
	return strings.TrimSpace(firstString(
		r.Header.Get("X-LiveChat-Webhook-Id"),
		r.Header.Get("X-LiveChat-Webhook-ID"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("livechat_webhook_id"),
		liveChatWebhookString(raw, "webhook_id"),
	))
}

func liveChatWebhookSecretValue(r *http.Request, body []byte) string {
	raw := liveChatWebhookRaw(body)
	return strings.TrimSpace(firstString(
		r.Header.Get("X-LiveChat-Webhook-Secret"),
		r.Header.Get("X-Webhook-Secret"),
		liveChatWebhookString(raw, "secret_key"),
		liveChatWebhookString(raw, "secret"),
		liveChatWebhookString(raw, "payload", "secret_key"),
	))
}

func liveChatWebhookDeliveryID(r *http.Request, accountID, webhookID string, body []byte) string {
	raw := liveChatWebhookRaw(body)
	chat := liveChatWebhookChat(raw)
	return firstString(
		strings.TrimSpace(r.Header.Get("X-LiveChat-Event-Id")),
		strings.TrimSpace(r.Header.Get("X-LiveChat-Delivery-Id")),
		strings.TrimSpace(r.Header.Get("X-Request-Id")),
		liveChatWebhookEventID(raw),
		liveChatWebhookScopedDeliveryKey(webhookID, liveChatWebhookTopicFromRaw(raw), liveChatWebhookChatID(raw, chat)),
		"livechat:"+strings.TrimSpace(accountID)+":webhook:"+strings.TrimSpace(webhookID)+":"+liveChatWebhookLocalID(body),
	)
}

func liveChatWebhookScopedDeliveryKey(webhookID, topic, chatID string) string {
	webhookID = strings.TrimSpace(webhookID)
	topic = strings.TrimSpace(topic)
	chatID = strings.TrimSpace(chatID)
	if webhookID == "" && topic == "" && chatID == "" {
		return ""
	}
	return webhookID + ":" + topic + ":" + chatID
}

func liveChatWebhookString(node map[string]any, path ...string) string {
	return supportWebhookString(node, path...)
}

func liveChatWebhookMap(node map[string]any, path ...string) map[string]any {
	cur := any(node)
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[key]
	}
	out, _ := cur.(map[string]any)
	return out
}

func liveChatWebhookArray(node map[string]any, path ...string) []any {
	cur := any(node)
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[key]
	}
	out, _ := cur.([]any)
	return out
}

func liveChatWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
