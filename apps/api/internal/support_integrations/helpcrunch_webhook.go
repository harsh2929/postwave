// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingHelpCrunchWebhookSignature = errors.New("helpcrunch webhook signature is required")
	ErrInvalidHelpCrunchWebhookSignature = errors.New("helpcrunch webhook signature mismatch")
	ErrMissingHelpCrunchWebhookSecret    = errors.New("helpcrunch webhook signing key is required")
)

type HelpCrunchWebhookStore interface {
	FindHelpCrunchIntegrationByOrganization(ctx context.Context, organizationID, webhookID string) (*Integration, error)
}

func (d *Deps) HelpCrunchWebhook(w http.ResponseWriter, r *http.Request) {
	organizationID := strings.TrimSpace(chi.URLParam(r, "organization_id"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	store, ok := d.Repo.(HelpCrunchWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "helpcrunch webhook lookup is not configured")
		return
	}
	integration, err := store.FindHelpCrunchIntegrationByOrganization(r.Context(), organizationID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "helpcrunch integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "helpcrunch webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read helpcrunch webhook body")
		return
	}
	signingKey, err := d.helpCrunchWebhookSigningKey(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyHelpCrunchWebhookSignature(signingKey, body, r.Header.Get("X-HelpCrunch-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "helpcrunch webhook payload must be a JSON object")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "helpcrunch webhook idempotency is not configured")
		return
	}
	topic := helpCrunchWebhookTopic(raw)
	deliveryID := helpCrunchWebhookDeliveryID(organizationID, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderHelpCrunch, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.helpCrunchWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if helpCrunchRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderHelpCrunch, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderHelpCrunch, deliveryID, err)
		writeHelpCrunchRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderHelpCrunch, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderHelpCrunch, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "helpcrunch webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderHelpCrunch, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderHelpCrunch, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) helpCrunchWebhookSigningKey(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingHelpCrunchWebhookSecret
	}
	if secret := strings.TrimSpace(firstString(
		settingString(integration.Settings, "helpcrunch_webhook_signing_key"),
		settingString(integration.Settings, "helpcrunch_webhook_secret"),
		settingString(integration.Settings, "webhook_secret"),
	)); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "helpcrunch_webhook_signing_key_ref"),
		settingString(integration.Settings, "helpcrunch_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
	))
	if ref == "" {
		return "", ErrMissingHelpCrunchWebhookSecret
	}
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingHelpCrunchWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingHelpCrunchWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyHelpCrunchWebhookSignature(secret string, body []byte, signature string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingHelpCrunchWebhookSecret
	}
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return ErrMissingHelpCrunchWebhookSignature
	}
	signature = strings.TrimPrefix(strings.ToLower(signature), "sha1=")
	mac := hmac.New(sha1.New, []byte(secret))
	if _, err := mac.Write(body); err != nil {
		return err
	}
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return ErrInvalidHelpCrunchWebhookSignature
	}
	return nil
}

func (d *Deps) helpCrunchWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.HelpCrunchBackfiller.(HelpCrunchChatRefresher)
	if refresher != nil {
		if chatID := helpCrunchWebhookChatID(raw); chatID != "" {
			req, err := refresher.RefreshChat(ctx, integration.TenantID, *integration, chatID)
			if err != nil {
				return SyncRequest{}, err
			}
			return helpCrunchWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := helpCrunchDirectWebhookRequest(raw, body, webhookID, topic); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func helpCrunchDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, bool) {
	chatRaw := firstMap(helpCrunchWebhookMap(raw, "chat"), helpCrunchWebhookMap(raw, "eventData", "chat"), helpCrunchWebhookMap(raw, "data", "chat"), helpCrunchWebhookMap(raw, "eventData"))
	if chatRaw == nil {
		return SyncRequest{}, false
	}
	chat := helpCrunchChatFromMap(chatRaw)
	ticket, ok := mapHelpCrunchChat(chat)
	if !ok {
		return SyncRequest{}, false
	}
	return helpCrunchWebhookAnnotateRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Cursor: "helpcrunch-webhook-" + firstString(ticket.ConversationID, helpCrunchWebhookLocalHash(body))}, raw, body, webhookID, topic), true
}

func helpCrunchWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "helpcrunch-webhook-" + firstString(helpCrunchWebhookChatID(raw), helpCrunchWebhookLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["helpcrunch_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["helpcrunch_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["helpcrunch_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["helpcrunch_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["helpcrunch_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["helpcrunch_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func helpCrunchWebhookTopic(raw map[string]any) string {
	return firstString(
		helpCrunchWebhookString(raw, "event"),
		helpCrunchWebhookString(raw, "eventName"),
		helpCrunchWebhookString(raw, "event_name"),
		helpCrunchWebhookString(raw, "type"),
		helpCrunchWebhookString(raw, "action"),
	)
}

func helpCrunchWebhookChatID(raw map[string]any) string {
	return firstString(
		helpCrunchWebhookString(raw, "chat_id"),
		helpCrunchWebhookString(raw, "chatId"),
		helpCrunchWebhookString(raw, "chat", "id"),
		helpCrunchWebhookString(raw, "eventData", "chat_id"),
		helpCrunchWebhookString(raw, "eventData", "chatId"),
		helpCrunchWebhookString(raw, "eventData", "chat", "id"),
		helpCrunchWebhookString(raw, "eventData", "id"),
		helpCrunchWebhookString(raw, "data", "chat_id"),
		helpCrunchWebhookString(raw, "data", "chat", "id"),
	)
}

func helpCrunchWebhookDeliveryID(organizationID, webhookID string, raw map[string]any, body []byte) string {
	return "helpcrunch:" + strings.Join(cleanStrings([]string{
		strings.TrimSpace(organizationID),
		strings.TrimSpace(webhookID),
		firstString(helpCrunchWebhookString(raw, "id"), helpCrunchWebhookString(raw, "event_id"), helpCrunchWebhookString(raw, "message_id")),
		helpCrunchWebhookTopic(raw),
		helpCrunchWebhookChatID(raw),
		helpCrunchWebhookLocalHash(body),
	}), ":")
}

func helpCrunchWebhookLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func helpCrunchRefreshMissing(err error) bool {
	var restErr HelpCrunchRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeHelpCrunchRefreshError(w http.ResponseWriter, err error) {
	var restErr HelpCrunchRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "helpcrunch_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "helpcrunch_refresh_failed", httperror.MessageInternal)
}

func helpCrunchChatFromMap(raw map[string]any) helpCrunchChat {
	return helpCrunchChat{
		ID:              helpCrunchWebhookInt(raw, "id"),
		Status:          helpCrunchWebhookString(raw, "status"),
		LastMessageText: helpCrunchWebhookString(raw, "lastMessageText"),
		CreatedAt:       helpCrunchWebhookString(raw, "createdAt"),
		LastMessageAt:   helpCrunchWebhookString(raw, "lastMessageAt"),
		ApplicationID:   helpCrunchWebhookInt(raw, "applicationId"),
		Customer: helpCrunchCustomer{
			ID:     helpCrunchWebhookInt(raw, "customer", "id"),
			Name:   helpCrunchWebhookString(raw, "customer", "name"),
			Email:  helpCrunchWebhookString(raw, "customer", "email"),
			UserID: helpCrunchWebhookString(raw, "customer", "userId"),
		},
	}
}

func helpCrunchWebhookInt(raw map[string]any, path ...string) int {
	value := helpCrunchWebhookString(raw, path...)
	n, _ := strconv.Atoi(value)
	return n
}

func helpCrunchWebhookString(raw map[string]any, path ...string) string {
	if raw == nil {
		return ""
	}
	var cur any = raw
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		var found any
		for k, v := range m {
			if strings.EqualFold(k, key) {
				found = v
				break
			}
		}
		if found == nil {
			return ""
		}
		cur = found
	}
	switch typed := cur.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
	case bool:
		if typed {
			return "true"
		}
		return "false"
	}
	return strings.TrimSpace(fmt.Sprint(cur))
}

func helpCrunchWebhookMap(raw map[string]any, path ...string) map[string]any {
	if raw == nil {
		return nil
	}
	var cur any = raw
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		var found any
		for k, v := range m {
			if strings.EqualFold(k, key) {
				found = v
				break
			}
		}
		cur = found
	}
	out, _ := cur.(map[string]any)
	return out
}
