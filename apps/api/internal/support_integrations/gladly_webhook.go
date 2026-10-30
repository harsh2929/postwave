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
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingGladlyWebhookAuth = errors.New("gladly webhook auth token is required")
	ErrInvalidGladlyWebhookAuth = errors.New("gladly webhook auth mismatch")
)

type GladlyWebhookStore interface {
	FindGladlyIntegrationByOrganization(ctx context.Context, organizationDomain, webhookID string) (*Integration, error)
}

func (d *Deps) GladlyWebhook(w http.ResponseWriter, r *http.Request) {
	organizationDomain := normalizeGladlyOrganizationDomain(chi.URLParam(r, "organization_domain"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	store, ok := d.Repo.(GladlyWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "gladly webhook lookup is not configured")
		return
	}
	integration, err := store.FindGladlyIntegrationByOrganization(r.Context(), organizationDomain, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "gladly integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "gladly webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read gladly webhook body")
		return
	}
	if err := d.verifyGladlyWebhookAuth(r, integration); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_auth", "request authentication failed")
		return
	}
	raw := map[string]any{}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &raw); err != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_payload", "gladly webhook payload must be a JSON object")
			return
		}
	}
	topic := gladlyWebhookTopic(raw)
	if strings.EqualFold(topic, "PING") {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ping": true})
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "gladly webhook idempotency is not configured")
		return
	}
	deliveryID := gladlyWebhookDeliveryID(organizationDomain, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderGladly, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.gladlyWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if gladlyRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGladly, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGladly, deliveryID, err)
		writeGladlyRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGladly, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGladly, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "gladly webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGladly, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGladly, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) gladlyWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.GladlyBackfiller.(GladlyConversationRefresher)
	if refresher != nil {
		if conversationID := gladlyWebhookConversationID(raw); conversationID != "" {
			req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
			if err != nil {
				return SyncRequest{}, err
			}
			return gladlyWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
		if taskID := gladlyWebhookTaskID(raw); taskID != "" {
			req, err := refresher.RefreshTask(ctx, integration.TenantID, *integration, taskID)
			if err != nil {
				return SyncRequest{}, err
			}
			return gladlyWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
		if customerID := gladlyWebhookCustomerID(raw); customerID != "" {
			req, err := refresher.RefreshCustomer(ctx, integration.TenantID, *integration, customerID)
			if err != nil {
				return SyncRequest{}, err
			}
			return gladlyWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := gladlyDirectWebhookRequest(raw, body, webhookID, topic); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func gladlyDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, bool) {
	data := gladlyWebhookData(raw)
	if data == nil {
		data = raw
	}
	customer := firstMap(gladlyMap(data, "customer"), gladlyMap(raw, "customer"), gladlyMap(raw, "data", "customer"))
	ticket, ok := mapGladlyConversation(data, customer)
	if !ok {
		return SyncRequest{}, false
	}
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Cursor: "gladly-webhook-" + firstString(ticket.ConversationID, gladlyWebhookLocalHash(body))}
	if msg, ok := mapGladlyItem(data, ticket, 0); ok {
		req.Messages = []MessageInput{msg}
	}
	return gladlyWebhookAnnotateRequest(req, raw, body, webhookID, topic), true
}

func gladlyWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "gladly-webhook-" + firstString(gladlyWebhookConversationID(raw), gladlyWebhookCustomerID(raw), gladlyWebhookTaskID(raw), gladlyWebhookLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["gladly_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["gladly_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["gladly_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["gladly_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["gladly_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["gladly_webhook_event"] = strings.TrimSpace(topic)
	}
	for i := range in.Events {
		if in.Events[i].Properties == nil {
			in.Events[i].Properties = map[string]any{}
		}
		in.Events[i].Properties["gladly_webhook_id"] = strings.TrimSpace(webhookID)
		in.Events[i].Properties["gladly_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func (d *Deps) verifyGladlyWebhookAuth(r *http.Request, integration *Integration) error {
	secret, err := d.gladlyWebhookSecret(r.Context(), integration)
	if err != nil {
		return err
	}
	return VerifyGladlyWebhookAuth(secret, r)
}

func (d *Deps) gladlyWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingGladlyWebhookAuth
	}
	if secret := strings.TrimSpace(firstString(
		settingString(integration.Settings, "gladly_webhook_token"),
		settingString(integration.Settings, "gladly_webhook_secret"),
		settingString(integration.Settings, "webhook_secret"),
	)); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "gladly_webhook_token_ref"),
		settingString(integration.Settings, "gladly_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_auth_ref"),
	))
	if ref == "" {
		return "", ErrMissingGladlyWebhookAuth
	}
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingGladlyWebhookAuth
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingGladlyWebhookAuth
	}
	return strings.TrimSpace(secret), nil
}

func VerifyGladlyWebhookAuth(secret string, r *http.Request) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingGladlyWebhookAuth
	}
	candidates := []string{
		r.Header.Get("X-Gladly-Webhook-Token"),
		r.Header.Get("X-Gladly-Webhook-Secret"),
		r.Header.Get("X-Webhook-Token"),
		r.Header.Get("X-Webhook-Secret"),
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if bearer, ok := strings.CutPrefix(auth, "Bearer "); ok {
		candidates = append(candidates, bearer)
	}
	if username, password, ok := r.BasicAuth(); ok {
		candidates = append(candidates, password, username+":"+password)
	}
	sawCredential := false
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		sawCredential = true
		if candidate == secret {
			return nil
		}
	}
	if !sawCredential {
		return ErrMissingGladlyWebhookAuth
	}
	return ErrInvalidGladlyWebhookAuth
}

func gladlyWebhookTopic(raw map[string]any) string {
	return firstString(
		gladlyString(raw, "event"),
		gladlyString(raw, "eventName"),
		gladlyString(raw, "event_name"),
		gladlyString(raw, "name"),
		gladlyString(raw, "type"),
		gladlyString(raw, "data", "event"),
		gladlyString(raw, "payload", "event"),
	)
}

func gladlyWebhookConversationID(raw map[string]any) string {
	return firstString(
		gladlyString(raw, "conversationId"),
		gladlyString(raw, "conversation_id"),
		gladlyString(raw, "conversation", "id"),
		gladlyString(raw, "data", "conversationId"),
		gladlyString(raw, "data", "conversation_id"),
		gladlyString(raw, "data", "conversation", "id"),
		gladlyString(raw, "payload", "conversationId"),
		gladlyString(raw, "payload", "conversation", "id"),
	)
}

func gladlyWebhookCustomerID(raw map[string]any) string {
	return firstString(
		gladlyString(raw, "customerId"),
		gladlyString(raw, "customer_id"),
		gladlyString(raw, "customer", "id"),
		gladlyString(raw, "data", "customerId"),
		gladlyString(raw, "data", "customer_id"),
		gladlyString(raw, "data", "customer", "id"),
		gladlyString(raw, "payload", "customerId"),
		gladlyString(raw, "payload", "customer", "id"),
	)
}

func gladlyWebhookTaskID(raw map[string]any) string {
	return firstString(
		gladlyString(raw, "taskId"),
		gladlyString(raw, "task_id"),
		gladlyString(raw, "task", "id"),
		gladlyString(raw, "data", "taskId"),
		gladlyString(raw, "data", "task_id"),
		gladlyString(raw, "data", "task", "id"),
		gladlyString(raw, "payload", "taskId"),
		gladlyString(raw, "payload", "task", "id"),
	)
}

func gladlyWebhookData(raw map[string]any) map[string]any {
	return firstMap(gladlyMap(raw, "data"), gladlyMap(raw, "payload"), gladlyMap(raw, "event"))
}

func gladlyWebhookDeliveryID(organizationDomain, webhookID string, raw map[string]any, body []byte) string {
	return "gladly:" + strings.Join(cleanStrings([]string{
		normalizeGladlyOrganizationDomain(organizationDomain),
		strings.TrimSpace(webhookID),
		firstString(gladlyString(raw, "id"), gladlyString(raw, "eventId"), gladlyString(raw, "event_id"), gladlyString(raw, "data", "id")),
		gladlyWebhookTopic(raw),
		gladlyWebhookConversationID(raw),
		gladlyWebhookCustomerID(raw),
		gladlyWebhookTaskID(raw),
		gladlyWebhookLocalHash(body),
	}), ":")
}

func gladlyWebhookLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func gladlyRefreshMissing(err error) bool {
	var restErr GladlyRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeGladlyRefreshError(w http.ResponseWriter, err error) {
	var restErr GladlyRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "gladly_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "gladly_refresh_failed", httperror.MessageInternal)
}
