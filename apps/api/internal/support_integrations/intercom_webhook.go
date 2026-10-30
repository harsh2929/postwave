// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
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
	ErrMissingIntercomWebhookSecret    = errors.New("intercom webhook secret is required")
	ErrMissingIntercomWebhookSignature = errors.New("intercom webhook signature is required")
	ErrInvalidIntercomWebhookSignature = errors.New("invalid intercom webhook signature")
)

type IntercomWebhookStore interface {
	FindIntercomIntegrationByWorkspace(ctx context.Context, workspaceID string) (*Integration, error)
}

// IntercomWebhook receives Intercom app webhook deliveries for a workspace.
// Intercom signs the raw JSON body with X-Hub-Signature: sha1=<hex-hmac>.
func (d *Deps) IntercomWebhook(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(chi.URLParam(r, "workspace_id"))
	if workspaceID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_workspace_id", "intercom workspace_id is required")
		return
	}
	store, ok := d.Repo.(IntercomWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "intercom webhook lookup is not configured")
		return
	}
	integration, err := store.FindIntercomIntegrationByWorkspace(r.Context(), workspaceID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "intercom integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "intercom payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read intercom webhook body")
		return
	}
	secret, err := d.intercomWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyIntercomWebhookSignature(secret, body, r.Header.Get("X-Hub-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := intercomWebhookTopic(body)
	deliveryID := intercomWebhookDeliveryID(r, workspaceID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderIntercom, deliveryID, topic, body)
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
	req, ok := mapIntercomWebhook(body, *integration)
	if !ok {
		conversationID := intercomConversationIDFromWebhook(body)
		if conversationID != "" {
			refreshed, refreshedOK, err := d.refreshIntercomWebhookConversation(r.Context(), integration, conversationID, body, topic)
			if err != nil {
				if intercomRefreshConversationMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderIntercom, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "conversation_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderIntercom, deliveryID, err)
				writeIntercomRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderIntercom, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderIntercom, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "intercom webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderIntercom, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderIntercom, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshIntercomWebhookConversation(ctx context.Context, integration *Integration, conversationID string, body []byte, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.IntercomBackfiller.(IntercomConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("intercom conversation refresh is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = intercomWebhookRefreshRequest(req, body, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func intercomWebhookRefreshRequest(in SyncRequest, body []byte, topic string) SyncRequest {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	conversationID := intercomConversationIDFromRaw(raw)
	in.RunMode = "webhook"
	in.Cursor = "intercom-webhook-" + firstString(conversationID, intercomWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["intercom_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["intercom_notification_id"] = intercomNotificationID(raw)
		in.Tickets[i].Properties["intercom_refresh_source"] = "webhook_sparse_conversation"
		in.Tickets[i].Properties["intercom_raw"] = raw
	}
	in.Messages = intercomWebhookMessagesWithMetadata(in.Messages, raw, topic, "webhook_sparse_conversation")
	return normalizeSyncRequest(in)
}

func intercomRefreshConversationMissing(err error) bool {
	var restErr IntercomRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeIntercomRefreshError(w http.ResponseWriter, err error) {
	var restErr IntercomRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "intercom_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) intercomWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingIntercomWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "intercom_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingIntercomWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingIntercomWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyIntercomWebhookSignature(secret string, body []byte, signatureHeader string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingIntercomWebhookSecret
	}
	signatureHeader = strings.TrimSpace(signatureHeader)
	if signatureHeader == "" {
		return ErrMissingIntercomWebhookSignature
	}
	signatureHeader = strings.TrimPrefix(signatureHeader, "sha1=")
	got, err := hex.DecodeString(signatureHeader)
	if err != nil {
		return ErrInvalidIntercomWebhookSignature
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	if !hmac.Equal(got, mac.Sum(nil)) {
		return ErrInvalidIntercomWebhookSignature
	}
	return nil
}

func mapIntercomWebhook(body []byte, _ Integration) (SyncRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	c, ok := intercomWebhookConversation(raw)
	if !ok {
		return SyncRequest{}, false
	}
	ticket, ok := mapIntercomConversation(c, intercomConversationPrimaryContact(c))
	if !ok {
		return SyncRequest{}, false
	}
	if ticket.Properties == nil {
		ticket.Properties = map[string]any{}
	}
	topic := intercomWebhookTopicFromRaw(raw)
	ticket.Properties["intercom_webhook_event"] = topic
	ticket.Properties["intercom_notification_id"] = intercomNotificationID(raw)
	ticket.Properties["intercom_raw"] = raw
	messages := intercomWebhookMessagesWithMetadata(mapIntercomConversationMessages(c, ticket), raw, topic, "webhook_full_conversation")
	cursor := "intercom-webhook-" + firstString(intercomNotificationID(raw), strings.TrimSpace(c.ID), intercomWebhookLocalID(body))
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: cursor}), true
}

func intercomWebhookMessagesWithMetadata(messages []MessageInput, raw map[string]any, topic, source string) []MessageInput {
	for i := range messages {
		if messages[i].Properties == nil {
			messages[i].Properties = map[string]any{}
		}
		messages[i].Properties["intercom_webhook_event"] = strings.TrimSpace(topic)
		messages[i].Properties["intercom_notification_id"] = intercomNotificationID(raw)
		messages[i].Properties["intercom_refresh_source"] = strings.TrimSpace(source)
	}
	return messages
}

func intercomWebhookConversation(raw map[string]any) (intercomConversation, bool) {
	candidates := []any{raw}
	if data, ok := raw["data"].(map[string]any); ok {
		if item, ok := data["item"]; ok {
			candidates = append(candidates, item)
		}
	}
	if conversation, ok := raw["conversation"]; ok {
		candidates = append(candidates, conversation)
	}
	for _, candidate := range candidates {
		body, err := json.Marshal(candidate)
		if err != nil {
			continue
		}
		var c intercomConversation
		if err := json.Unmarshal(body, &c); err != nil {
			continue
		}
		if strings.TrimSpace(c.ID) != "" && (strings.TrimSpace(c.Source.Author.Email) != "" || len(c.Contacts.Contacts) > 0) {
			return c, true
		}
	}
	return intercomConversation{}, false
}

func intercomConversationIDFromWebhook(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return intercomConversationIDFromRaw(raw)
}

func intercomConversationIDFromRaw(raw map[string]any) string {
	return firstString(
		intercomWebhookString(raw, "data", "item", "id"),
		intercomWebhookString(raw, "conversation", "id"),
		intercomWebhookString(raw, "conversation_id"),
		intercomWebhookString(raw, "item", "id"),
	)
}

func intercomWebhookDeliveryID(r *http.Request, workspaceID string, body []byte) string {
	requestID := ""
	if r != nil {
		requestID = firstString(
			r.Header.Get("X-Intercom-Request-Id"),
			r.Header.Get("X-Intercom-Request-ID"),
			r.Header.Get("X-Request-Id"),
		)
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	return "workspace:" + strings.TrimSpace(workspaceID) +
		":delivery:" + firstString(requestID, intercomNotificationID(raw), "body:"+intercomWebhookLocalID(body))
}

func intercomWebhookTopic(body []byte) string {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	return intercomWebhookTopicFromRaw(raw)
}

func intercomWebhookTopicFromRaw(raw map[string]any) string {
	return firstString(
		intercomWebhookString(raw, "topic"),
		intercomWebhookString(raw, "type"),
		"conversation.updated",
	)
}

func intercomNotificationID(raw map[string]any) string {
	return firstString(
		intercomWebhookString(raw, "id"),
		intercomWebhookString(raw, "notification_id"),
		intercomWebhookString(raw, "delivery_id"),
	)
}

func intercomWebhookString(node map[string]any, path ...string) string {
	cur := any(node)
	for i, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		v, ok := m[key]
		if !ok || v == nil {
			return ""
		}
		if i == len(path)-1 {
			switch typed := v.(type) {
			case string:
				return strings.TrimSpace(typed)
			case json.Number:
				return strings.TrimSpace(typed.String())
			case float64:
				return strings.TrimSpace(strconv.FormatFloat(typed, 'f', -1, 64))
			default:
				return strings.TrimSpace(fmt.Sprint(typed))
			}
		}
		cur = v
	}
	return ""
}

func intercomWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}
