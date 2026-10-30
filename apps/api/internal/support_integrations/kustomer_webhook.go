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
	ErrMissingKustomerWebhookSecret    = errors.New("kustomer webhook secret is required")
	ErrMissingKustomerWebhookSignature = errors.New("kustomer webhook signature is required")
	ErrInvalidKustomerWebhookSignature = errors.New("invalid kustomer webhook signature")
)

type KustomerWebhookStore interface {
	FindKustomerIntegrationByOrganization(ctx context.Context, organizationID, webhookID string) (*Integration, error)
}

// KustomerWebhook receives signed Kustomer outbound webhooks scoped to an
// organization/workspace id.
func (d *Deps) KustomerWebhook(w http.ResponseWriter, r *http.Request) {
	organizationID := strings.TrimSpace(chi.URLParam(r, "organization_id"))
	if organizationID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_organization_id", "kustomer organization id is required")
		return
	}
	store, ok := d.Repo.(KustomerWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "kustomer webhook lookup is not configured")
		return
	}
	webhookID := kustomerWebhookID(r)
	integration, err := store.FindKustomerIntegrationByOrganization(r.Context(), organizationID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "kustomer integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "kustomer payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read kustomer webhook body")
		return
	}
	secret, err := d.kustomerWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyKustomerWebhookSignature(secret, body, kustomerWebhookSignature(r)); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := kustomerWebhookTopic(body)
	deliveryID := kustomerWebhookDeliveryID(r, organizationID, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderKustomer, deliveryID, topic, body)
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
	req, ok := mapKustomerWebhook(body, *integration, webhookID)
	if !ok {
		conversationID := kustomerConversationIDFromWebhook(body)
		if conversationID != "" {
			refreshed, refreshedOK, err := d.refreshKustomerWebhookConversation(r.Context(), integration, conversationID, body, webhookID, topic)
			if err != nil {
				if kustomerRefreshConversationMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderKustomer, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "conversation_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderKustomer, deliveryID, err)
				writeKustomerRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderKustomer, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderKustomer, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "kustomer webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderKustomer, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderKustomer, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshKustomerWebhookConversation(ctx context.Context, integration *Integration, conversationID string, body []byte, webhookID, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.KustomerBackfiller.(KustomerConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("kustomer conversation refresh is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = kustomerWebhookRefreshRequest(req, body, webhookID, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func kustomerWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	raw := kustomerWebhookRaw(body)
	conversationID := kustomerConversationIDFromRaw(raw)
	in.RunMode = "webhook"
	in.Cursor = "kustomer-webhook-" + firstString(conversationID, kustomerWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["kustomer_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["kustomer_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["kustomer_refresh_source"] = "webhook_sparse_conversation"
		in.Tickets[i].Properties["kustomer_raw"] = raw
	}
	return normalizeSyncRequest(in)
}

func kustomerRefreshConversationMissing(err error) bool {
	var restErr KustomerRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeKustomerRefreshError(w http.ResponseWriter, err error) {
	var restErr KustomerRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "kustomer_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) kustomerWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingKustomerWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "kustomer_webhook_secret_ref"),
		settingString(integration.Settings, "kustomer_webhook_signature_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingKustomerWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingKustomerWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyKustomerWebhookSignature(secret string, body []byte, signatureHeader string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingKustomerWebhookSecret
	}
	signatureHeader = strings.TrimSpace(signatureHeader)
	if signatureHeader == "" {
		return ErrMissingKustomerWebhookSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	if kustomerSignatureMatches(signatureHeader, mac.Sum(nil)) {
		return nil
	}
	return ErrInvalidKustomerWebhookSignature
}

func kustomerSignatureMatches(raw string, expected []byte) bool {
	raw = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "sha256="))
	if decoded, err := hex.DecodeString(raw); err == nil && hmac.Equal(decoded, expected) {
		return true
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && hmac.Equal(decoded, expected) {
		return true
	}
	return hmac.Equal([]byte(raw), []byte(hex.EncodeToString(expected)))
}

func mapKustomerWebhook(body []byte, _ Integration, webhookID string) (SyncRequest, bool) {
	raw := kustomerWebhookRaw(body)
	if raw == nil {
		return SyncRequest{}, false
	}
	conversationID := kustomerConversationIDFromRaw(raw)
	email := strings.ToLower(strings.TrimSpace(kustomerWebhookEmail(raw)))
	if conversationID == "" || email == "" {
		return SyncRequest{}, false
	}
	topic := kustomerWebhookTopicFromRaw(raw)
	ticket := TicketInput{
		SourceID:       "kustomer://conversation/" + conversationID,
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  kustomerWebhookRequesterName(raw),
		Subject:        kustomerWebhookSubject(raw),
		Status:         kustomerWebhookStatus(raw),
		Properties: map[string]any{
			"kustomer_conversation_id": conversationID,
			"kustomer_webhook_id":      strings.TrimSpace(webhookID),
			"kustomer_webhook_event":   topic,
			"kustomer_event_id":        kustomerWebhookEventID(raw),
			"kustomer_raw":             raw,
		},
	}
	if t := kustomerWebhookOccurredAt(raw); t != nil {
		ticket.UpdatedAt = t
	}
	messages := kustomerWebhookMessages(raw, conversationID, email, topic, webhookID)
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "kustomer-webhook-" + firstString(kustomerWebhookEventID(raw), conversationID, kustomerWebhookLocalID(body))}
	return normalizeSyncRequest(req), true
}

func kustomerWebhookMessages(raw map[string]any, conversationID, email, topic, webhookID string) []MessageInput {
	bodyText := strings.TrimSpace(firstString(
		kustomerWebhookString(raw, "message", "body"),
		kustomerWebhookString(raw, "message", "text"),
		kustomerWebhookString(raw, "data", "attributes", "body"),
		kustomerWebhookString(raw, "data", "attributes", "text"),
		kustomerWebhookString(raw, "data", "attributes", "message"),
		kustomerWebhookString(raw, "body"),
		kustomerWebhookString(raw, "text"),
	))
	if bodyText == "" {
		return nil
	}
	messageID := firstString(
		kustomerWebhookString(raw, "message", "id"),
		kustomerWebhookString(raw, "data", "id"),
		kustomerWebhookEventID(raw),
	)
	direction := "inbound"
	senderType := "customer"
	actorType := strings.ToLower(strings.TrimSpace(firstString(
		kustomerWebhookString(raw, "actor", "type"),
		kustomerWebhookString(raw, "data", "attributes", "direction"),
		kustomerWebhookString(raw, "direction"),
	)))
	if actorType == "agent" || actorType == "out" || actorType == "outbound" {
		direction = "outbound"
		senderType = "agent"
	}
	message := MessageInput{
		SourceID:       "kustomer://message/" + firstString(messageID, conversationID),
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  kustomerWebhookRequesterName(raw),
		Direction:      direction,
		SenderType:     senderType,
		Sender:         kustomerWebhookRequesterName(raw),
		BodyText:       bodyText,
		Properties: map[string]any{
			"kustomer_message_id":    messageID,
			"kustomer_webhook_id":    strings.TrimSpace(webhookID),
			"kustomer_webhook_event": topic,
		},
	}
	if t := kustomerWebhookOccurredAt(raw); t != nil {
		message.OccurredAt = t
	}
	return []MessageInput{message}
}

func kustomerWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	return raw
}

func kustomerConversationIDFromWebhook(body []byte) string {
	return kustomerConversationIDFromRaw(kustomerWebhookRaw(body))
}

func kustomerConversationIDFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return firstString(
		kustomerWebhookString(raw, "conversation", "id"),
		kustomerWebhookString(raw, "conversation_id"),
		kustomerWebhookString(raw, "data", "relationships", "conversation", "data", "id"),
		kustomerWebhookString(raw, "data", "id"),
		kustomerWebhookString(raw, "id"),
	)
}

func kustomerWebhookEmail(raw map[string]any) string {
	return firstString(
		kustomerWebhookString(raw, "customer", "email"),
		kustomerWebhookString(raw, "conversation", "customer", "email"),
		kustomerWebhookString(raw, "data", "attributes", "customer", "email"),
		kustomerWebhookString(raw, "data", "attributes", "email"),
		kustomerWebhookString(raw, "email"),
	)
}

func kustomerWebhookRequesterName(raw map[string]any) string {
	return firstString(
		kustomerWebhookString(raw, "customer", "name"),
		kustomerWebhookString(raw, "conversation", "customer", "name"),
		kustomerWebhookString(raw, "data", "attributes", "customer", "name"),
		kustomerWebhookString(raw, "data", "attributes", "customerName"),
		kustomerWebhookString(raw, "name"),
	)
}

func kustomerWebhookSubject(raw map[string]any) string {
	return firstString(
		kustomerWebhookString(raw, "conversation", "name"),
		kustomerWebhookString(raw, "data", "attributes", "name"),
		kustomerWebhookString(raw, "subject"),
		kustomerWebhookString(raw, "name"),
	)
}

func kustomerWebhookStatus(raw map[string]any) string {
	return firstString(
		kustomerWebhookString(raw, "conversation", "status"),
		kustomerWebhookString(raw, "data", "attributes", "status"),
		kustomerWebhookString(raw, "status"),
	)
}

func kustomerWebhookEventID(raw map[string]any) string {
	return firstString(
		kustomerWebhookString(raw, "event_id"),
		kustomerWebhookString(raw, "delivery_id"),
		kustomerWebhookString(raw, "id"),
	)
}

func kustomerWebhookTopic(body []byte) string {
	return kustomerWebhookTopicFromRaw(kustomerWebhookRaw(body))
}

func kustomerWebhookTopicFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return firstString(
		kustomerWebhookString(raw, "event"),
		kustomerWebhookString(raw, "topic"),
		kustomerWebhookString(raw, "type"),
		kustomerWebhookString(raw, "data", "type"),
	)
}

func kustomerWebhookOccurredAt(raw map[string]any) *time.Time {
	value := firstString(
		kustomerWebhookString(raw, "createdAt"),
		kustomerWebhookString(raw, "created_at"),
		kustomerWebhookString(raw, "timestamp"),
		kustomerWebhookString(raw, "data", "attributes", "updatedAt"),
		kustomerWebhookString(raw, "data", "attributes", "createdAt"),
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

func kustomerWebhookString(node map[string]any, path ...string) string {
	return supportWebhookString(node, path...)
}

func kustomerWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Kustomer-Webhook-Id"),
		r.Header.Get("X-Kustomer-Webhook-ID"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("kustomer_webhook_id"),
	))
}

func kustomerWebhookSignature(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Kustomer-Webhook-Signature"),
		r.Header.Get("X-Kustomer-Signature"),
		r.Header.Get("X-Hub-Signature-256"),
	))
}

func kustomerWebhookDeliveryID(r *http.Request, organizationID, webhookID string, body []byte) string {
	raw := kustomerWebhookRaw(body)
	return firstString(
		strings.TrimSpace(r.Header.Get("X-Kustomer-Event-Id")),
		strings.TrimSpace(r.Header.Get("X-Kustomer-Delivery-Id")),
		strings.TrimSpace(r.Header.Get("X-Request-Id")),
		kustomerWebhookEventID(raw),
		"kustomer:"+strings.TrimSpace(organizationID)+":webhook:"+strings.TrimSpace(webhookID)+":"+kustomerWebhookLocalID(body),
	)
}

func kustomerWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
