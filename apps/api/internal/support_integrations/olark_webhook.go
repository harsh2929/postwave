// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var ErrMissingOlarkWebhookToken = errors.New("olark webhook route token is required")

type OlarkWebhookStore interface {
	FindOlarkIntegrationBySite(ctx context.Context, siteID, webhookID string) (*Integration, error)
}

// OlarkWebhook receives operator-configured Olark webhook transcript posts.
// Olark's public guide posts the transcript JSON in a form field named `data`
// and does not document an HMAC signature, so the configured olark_webhook_id
// is treated as the unguessable route token.
func (d *Deps) OlarkWebhook(w http.ResponseWriter, r *http.Request) {
	siteID := strings.TrimSpace(chi.URLParam(r, "site_id"))
	if siteID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_site_id", "olark site id is required")
		return
	}
	webhookID := olarkWebhookID(r)
	if webhookID == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "request authentication failed")
		return
	}
	store, ok := d.Repo.(OlarkWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "olark webhook lookup is not configured")
		return
	}
	integration, err := store.FindOlarkIntegrationBySite(r.Context(), siteID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "olark integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "olark payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read olark webhook body")
		return
	}
	payload, formMeta, err := olarkWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	topic := strings.TrimSpace(firstString(formMeta.Get("event"), formMeta.Get("type"), formMeta.Get("kind"), "transcript.created"))
	deliveryID := olarkWebhookDeliveryID(r, siteID, webhookID, topic, payload)
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderOlark, deliveryID, topic, body)
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
	req, ok := mapOlarkWebhook(payload, webhookID, topic)
	if !ok {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderOlark, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderOlark, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "olark webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderOlark, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderOlark, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func olarkWebhookPayload(body []byte) ([]byte, url.Values, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, nil, fmt.Errorf("olark webhook body is empty")
	}
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		return []byte(trimmed), url.Values{}, nil
	}
	form, err := url.ParseQuery(trimmed)
	if err != nil {
		return nil, nil, fmt.Errorf("parse olark form payload: %w", err)
	}
	data := strings.TrimSpace(form.Get("data"))
	if data == "" {
		return nil, nil, fmt.Errorf("olark webhook data field is required")
	}
	return []byte(data), form, nil
}

func mapOlarkWebhook(payload []byte, webhookID, topic string) (SyncRequest, bool) {
	var tr olarkTranscript
	if err := json.Unmarshal(payload, &tr); err != nil {
		return SyncRequest{}, false
	}
	ticket, ok := mapOlarkTranscript(tr)
	if !ok {
		return SyncRequest{}, false
	}
	raw := map[string]any{}
	_ = json.Unmarshal(payload, &raw)
	if ticket.Properties == nil {
		ticket.Properties = map[string]any{}
	}
	ticket.Properties["olark_webhook_id"] = strings.TrimSpace(webhookID)
	ticket.Properties["olark_webhook_event"] = strings.TrimSpace(topic)
	ticket.Properties["olark_webhook_source"] = "form_data_transcript"
	if len(raw) > 0 {
		ticket.Properties["olark_raw"] = raw
	}
	messages := mapOlarkTranscriptMessages(tr, ticket)
	for i := range messages {
		if messages[i].Properties == nil {
			messages[i].Properties = map[string]any{}
		}
		messages[i].Properties["olark_webhook_id"] = strings.TrimSpace(webhookID)
		messages[i].Properties["olark_webhook_event"] = strings.TrimSpace(topic)
	}
	cursorID := strings.TrimSpace(firstString(tr.ID, olarkWebhookPayloadHash(payload)))
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "webhook",
		Tickets:  []TicketInput{ticket},
		Messages: messages,
		Cursor:   "olark-webhook:" + cursorID,
	}), true
}

func olarkWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		chi.URLParam(r, "webhook_id"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("olark_webhook_id"),
		r.URL.Query().Get("token"),
		r.Header.Get("X-Olark-Webhook-Id"),
		r.Header.Get("X-Olark-Webhook-ID"),
		r.Header.Get("X-Webhook-Id"),
		r.Header.Get("X-Webhook-ID"),
		r.Header.Get("X-Postwave-Webhook-Id"),
	))
}

func olarkWebhookDeliveryID(r *http.Request, siteID, webhookID, topic string, payload []byte) string {
	return "olark:" + strings.Join([]string{
		strings.TrimSpace(siteID),
		strings.TrimSpace(webhookID),
		strings.TrimSpace(firstString(
			r.Header.Get("X-Olark-Delivery-Id"),
			r.Header.Get("X-Olark-Delivery-ID"),
			r.Header.Get("X-Webhook-Delivery"),
			r.URL.Query().Get("delivery_id"),
			topic,
		)),
		olarkWebhookPayloadHash(payload),
	}, ":")
}

func olarkWebhookPayloadHash(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])[:24]
}
