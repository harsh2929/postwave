// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
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

var ErrMissingAdaWebhookSecret = errors.New("ada webhook secret is required")

type AdaWebhookStore interface {
	FindAdaIntegrationByAgent(ctx context.Context, aiAgentDomain, webhookID string) (*Integration, error)
}

func (d *Deps) AdaWebhook(w http.ResponseWriter, r *http.Request) {
	routeAgentDomain := normalizeAdaAgentDomain(chi.URLParam(r, "ai_agent_domain"))
	routeWebhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "ada webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ada webhook body")
		return
	}
	raw := adaWebhookRaw(body)
	if raw == nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "ada webhook payload must be a JSON object")
		return
	}
	bodyAgentDomain := adaWebhookAgentDomain(raw)
	if routeAgentDomain != "" && bodyAgentDomain != "" && routeAgentDomain != bodyAgentDomain {
		httperror.Write(w, http.StatusBadRequest, "agent_domain_mismatch", "ada webhook ai_agent_domain does not match route")
		return
	}
	agentDomain := normalizeAdaAgentDomain(firstString(routeAgentDomain, bodyAgentDomain))
	if agentDomain == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_ai_agent_domain", "ada ai_agent_domain is required")
		return
	}
	store, ok := d.Repo.(AdaWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "ada webhook lookup is not configured")
		return
	}
	integration, err := store.FindAdaIntegrationByAgent(r.Context(), agentDomain, firstString(routeWebhookID, adaWebhookConfiguredID(raw)))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "ada integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret, err := d.adaWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyAdaWebhookSignature(body, r.Header, secret); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := adaWebhookTopic(raw)
	deliveryID := adaWebhookDeliveryID(agentDomain, r.Header, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderAda, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.adaWebhookSyncRequest(r.Context(), integration, raw, body, routeWebhookID, topic)
	if err != nil {
		if adaRefreshMissing(err) {
			if fallback, ok := adaDirectWebhookRequest(raw, body, routeWebhookID, topic); ok {
				req = fallback
			} else {
				if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderAda, deliveryID); markErr != nil {
					httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
					return
				}
				writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
				return
			}
		} else {
			_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderAda, deliveryID, err)
			writeAdaRefreshError(w, err)
			return
		}
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderAda, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderAda, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "ada webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderAda, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderAda, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) adaWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.AdaBackfiller.(AdaConversationRefresher)
	if refresher != nil {
		if conversationID := adaWebhookConversationID(raw); conversationID != "" {
			req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
			if err != nil {
				return SyncRequest{}, err
			}
			return adaWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := adaDirectWebhookRequest(raw, body, webhookID, topic); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func adaDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, bool) {
	data := adaWebhookData(raw)
	if data == nil {
		data = raw
	}
	ticket, ok := mapAdaConversation(data, nil)
	if !ok {
		return SyncRequest{}, false
	}
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Cursor: "ada-webhook-" + ticket.ConversationID}
	if msg, ok := mapAdaMessage(data, ticket, 0); ok {
		req.Messages = []MessageInput{msg}
	}
	return adaWebhookAnnotateRequest(req, raw, body, webhookID, topic), true
}

func adaWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "ada-webhook-" + firstString(adaWebhookConversationID(raw), adaWebhookLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["ada_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["ada_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["ada_ai_agent_domain"] = adaWebhookAgentDomain(raw)
		in.Tickets[i].Properties["ada_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["ada_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["ada_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["ada_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func (d *Deps) adaWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingAdaWebhookSecret
	}
	if secret := strings.TrimSpace(firstString(
		settingString(integration.Settings, "ada_webhook_secret"),
		settingString(integration.Settings, "webhook_secret"),
	)); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "ada_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
	))
	if ref == "" {
		return "", ErrMissingAdaWebhookSecret
	}
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingAdaWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingAdaWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyAdaWebhookSignature(body []byte, headers http.Header, secret string) error {
	messageID := strings.TrimSpace(firstString(headers.Get("webhook-id"), headers.Get("svix-id")))
	timestamp := strings.TrimSpace(firstString(headers.Get("webhook-timestamp"), headers.Get("svix-timestamp")))
	signatureHeader := strings.TrimSpace(firstString(headers.Get("webhook-signature"), headers.Get("svix-signature")))
	if messageID == "" {
		return fmt.Errorf("ada webhook-id is required")
	}
	if timestamp == "" {
		return fmt.Errorf("ada webhook-timestamp is required")
	}
	if signatureHeader == "" {
		return fmt.Errorf("ada webhook-signature is required")
	}
	key := adaWebhookSigningKey(secret)
	payload := []byte(messageID + "." + timestamp + ".")
	payload = append(payload, body...)
	mac := hmac.New(sha256.New, key)
	if _, err := mac.Write(payload); err != nil {
		return err
	}
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	for _, sig := range adaWebhookSignatures(signatureHeader) {
		if subtle.ConstantTimeCompare([]byte(expected), []byte(sig)) == 1 {
			return nil
		}
	}
	return fmt.Errorf("ada webhook signature mismatch")
}

func adaWebhookSigningKey(secret string) []byte {
	secret = strings.TrimSpace(secret)
	encoded := strings.TrimPrefix(secret, "whsec_")
	if decoded, err := base64.StdEncoding.DecodeString(encoded); err == nil && len(decoded) > 0 {
		return decoded
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(encoded); err == nil && len(decoded) > 0 {
		return decoded
	}
	return []byte(secret)
}

func adaWebhookSignatures(header string) []string {
	out := []string{}
	for _, field := range strings.Fields(header) {
		for _, item := range strings.Split(field, ",") {
			item = strings.TrimSpace(item)
			if item == "" || strings.EqualFold(item, "v1") {
				continue
			}
			if strings.HasPrefix(item, "v1=") {
				item = strings.TrimPrefix(item, "v1=")
			}
			out = append(out, item)
		}
	}
	return out
}

func adaRefreshMissing(err error) bool {
	var restErr AdaRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeAdaRefreshError(w http.ResponseWriter, err error) {
	var restErr AdaRESTError
	if errors.As(err, &restErr) && restErr.RetryAfter > 0 {
		seconds := int(restErr.RetryAfter.Seconds())
		if restErr.RetryAfter%1_000_000_000 != 0 {
			seconds++
		}
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
	}
	httperror.Write(w, http.StatusServiceUnavailable, "ada_refresh_failed", httperror.MessageInternal)
}

func adaWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	return raw
}

func adaWebhookData(raw map[string]any) map[string]any {
	if data, ok := adaValue(raw, "data").(map[string]any); ok {
		return data
	}
	if payload, ok := adaValue(raw, "payload").(map[string]any); ok {
		return payload
	}
	return nil
}

func adaWebhookAgentDomain(raw map[string]any) string {
	data := adaWebhookData(raw)
	return normalizeAdaAgentDomain(firstString(
		adaString(raw, "ai_agent_domain"),
		adaString(raw, "agent_domain"),
		adaString(data, "ai_agent_domain"),
		adaString(data, "agent_domain"),
	))
}

func adaWebhookConfiguredID(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		adaString(raw, "webhook_endpoint_id"),
		adaString(raw, "webhook_id"),
		adaString(raw, "endpoint_id"),
	))
}

func adaWebhookTopic(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		adaString(raw, "type"),
		adaString(raw, "event_type"),
		adaString(raw, "event"),
	))
}

func adaWebhookConversationID(raw map[string]any) string {
	data := adaWebhookData(raw)
	return strings.TrimSpace(firstString(
		adaString(raw, "conversation_id"),
		adaString(raw, "conversation", "id"),
		adaString(data, "conversation_id"),
		adaString(data, "conversation", "id"),
	))
}

func adaWebhookDeliveryID(agentDomain string, headers http.Header, raw map[string]any, body []byte) string {
	return strings.Join([]string{
		normalizeAdaAgentDomain(agentDomain),
		firstString(headers.Get("webhook-id"), headers.Get("svix-id"), adaString(raw, "id"), adaString(raw, "event_id")),
		adaWebhookTopic(raw),
		adaWebhookConversationID(raw),
		adaWebhookLocalHash(body),
	}, ":")
}

func adaWebhookLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}
