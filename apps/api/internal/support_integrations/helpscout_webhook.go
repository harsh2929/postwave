// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
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
	ErrMissingHelpScoutWebhookSecret    = errors.New("help scout webhook secret is required")
	ErrMissingHelpScoutWebhookSignature = errors.New("help scout webhook signature is required")
	ErrInvalidHelpScoutWebhookSignature = errors.New("invalid help scout webhook signature")
)

type HelpScoutWebhookStore interface {
	FindHelpScoutIntegrationByMailbox(ctx context.Context, mailboxID, webhookID string) (*Integration, error)
}

// HelpScoutWebhook receives Help Scout app webhook deliveries for a mailbox.
// Help Scout signs the raw request body with HMAC-SHA1/base64 in
// X-HelpScout-Signature and sends the event name in X-HelpScout-Event.
func (d *Deps) HelpScoutWebhook(w http.ResponseWriter, r *http.Request) {
	mailboxID := strings.TrimSpace(chi.URLParam(r, "mailbox_id"))
	if mailboxID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_mailbox_id", "help scout mailbox_id is required")
		return
	}
	store, ok := d.Repo.(HelpScoutWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "help scout webhook lookup is not configured")
		return
	}
	webhookID := helpScoutWebhookID(r)
	integration, err := store.FindHelpScoutIntegrationByMailbox(r.Context(), mailboxID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "help scout integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "help scout payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read help scout webhook body")
		return
	}
	secret, err := d.helpScoutWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyHelpScoutWebhookSignature(secret, body, r.Header.Get("X-HelpScout-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := helpScoutWebhookTopic(r, body)
	deliveryID := helpScoutWebhookDeliveryID(r, mailboxID, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderHelpScout, deliveryID, topic, body)
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
	req, ok := mapHelpScoutWebhook(body, *integration, webhookID, topic)
	if !ok {
		conversationID := helpScoutConversationIDFromWebhook(body)
		if conversationID != "" {
			refreshed, refreshedOK, err := d.refreshHelpScoutWebhookConversation(r.Context(), integration, conversationID, body, webhookID, topic)
			if err != nil {
				if helpScoutRefreshConversationMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderHelpScout, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "conversation_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderHelpScout, deliveryID, err)
				writeHelpScoutRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderHelpScout, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderHelpScout, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "help scout webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderHelpScout, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderHelpScout, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshHelpScoutWebhookConversation(ctx context.Context, integration *Integration, conversationID string, body []byte, webhookID, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.HelpScoutBackfiller.(HelpScoutConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("help scout conversation refresh is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = helpScoutWebhookRefreshRequest(req, body, webhookID, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func helpScoutWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	conversationID := helpScoutConversationIDFromRaw(raw)
	in.RunMode = "webhook"
	in.Cursor = "help-scout-webhook-" + firstString(strings.TrimSpace(webhookID), conversationID, helpScoutWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["help_scout_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["help_scout_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["help_scout_refresh_source"] = "webhook_sparse_conversation"
		in.Tickets[i].Properties["help_scout_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["help_scout_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["help_scout_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func helpScoutRefreshConversationMissing(err error) bool {
	var restErr HelpScoutRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeHelpScoutRefreshError(w http.ResponseWriter, err error) {
	var restErr HelpScoutRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "help_scout_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) helpScoutWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingHelpScoutWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "help_scout_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingHelpScoutWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingHelpScoutWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyHelpScoutWebhookSignature(secret string, body []byte, signatureHeader string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingHelpScoutWebhookSecret
	}
	signatureHeader = strings.TrimSpace(signatureHeader)
	if signatureHeader == "" {
		return ErrMissingHelpScoutWebhookSignature
	}
	got, err := base64.StdEncoding.DecodeString(signatureHeader)
	if err != nil {
		return ErrInvalidHelpScoutWebhookSignature
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write(body)
	if !hmac.Equal(got, mac.Sum(nil)) {
		return ErrInvalidHelpScoutWebhookSignature
	}
	return nil
}

func mapHelpScoutWebhook(body []byte, _ Integration, webhookID, topic string) (SyncRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	var c helpScoutConversation
	if err := json.Unmarshal(body, &c); err != nil {
		return SyncRequest{}, false
	}
	ticket, ok := mapHelpScoutConversation(c, helpScoutThreadCustomerIdentity(c.Embedded.Threads))
	if !ok {
		return SyncRequest{}, false
	}
	if ticket.Properties == nil {
		ticket.Properties = map[string]any{}
	}
	ticket.Properties["help_scout_webhook_id"] = strings.TrimSpace(webhookID)
	ticket.Properties["help_scout_webhook_event"] = strings.TrimSpace(topic)
	ticket.Properties["help_scout_raw"] = raw
	messages := make([]MessageInput, 0, len(c.Embedded.Threads))
	for _, thread := range c.Embedded.Threads {
		if message, ok := mapHelpScoutThread(thread, ticket); ok {
			if message.Properties == nil {
				message.Properties = map[string]any{}
			}
			message.Properties["help_scout_webhook_id"] = strings.TrimSpace(webhookID)
			message.Properties["help_scout_webhook_event"] = strings.TrimSpace(topic)
			messages = append(messages, message)
		}
	}
	cursor := "help-scout-webhook-" + firstString(strings.TrimSpace(webhookID), helpScoutConversationID(c), helpScoutWebhookLocalID(body))
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: cursor}), true
}

func helpScoutConversationIDFromWebhook(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return helpScoutConversationIDFromRaw(raw)
}

func helpScoutConversationIDFromRaw(raw map[string]any) string {
	return firstString(
		helpScoutWebhookString(raw, "conversation", "id"),
		helpScoutWebhookString(raw, "conversationId"),
		helpScoutWebhookString(raw, "conversation_id"),
		helpScoutWebhookString(raw, "convo", "id"),
		helpScoutWebhookString(raw, "data", "conversation", "id"),
		helpScoutWebhookString(raw, "data", "id"),
		helpScoutWebhookString(raw, "id"),
	)
}

func helpScoutWebhookID(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		r.Header.Get("X-HelpScout-Webhook-Id"),
		r.Header.Get("X-HelpScout-Webhook-ID"),
		r.URL.Query().Get("webhook_id"),
	))
}

func helpScoutWebhookDeliveryID(r *http.Request, mailboxID, webhookID string, body []byte) string {
	deliveryID := ""
	if r != nil {
		deliveryID = firstString(
			r.Header.Get("X-HelpScout-Delivery-Id"),
			r.Header.Get("X-HelpScout-Delivery-ID"),
			r.Header.Get("X-HelpScout-Request-Id"),
			r.Header.Get("X-Request-Id"),
		)
	}
	return "mailbox:" + strings.TrimSpace(mailboxID) +
		":webhook:" + firstString(strings.TrimSpace(webhookID), "unscoped") +
		":delivery:" + firstString(strings.TrimSpace(deliveryID), "body:"+helpScoutWebhookLocalID(body))
}

func helpScoutWebhookTopic(r *http.Request, body []byte) string {
	event := ""
	if r != nil {
		event = strings.TrimSpace(r.Header.Get("X-HelpScout-Event"))
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	return firstString(
		event,
		helpScoutWebhookString(raw, "event"),
		helpScoutWebhookString(raw, "type"),
		helpScoutWebhookString(raw, "topic"),
		"convo.updated",
	)
}

func helpScoutWebhookString(node map[string]any, path ...string) string {
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

func helpScoutWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}
