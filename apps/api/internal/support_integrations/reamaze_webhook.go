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

var ErrMissingReamazeWebhookToken = errors.New("re:amaze webhook route token is required")

type ReamazeWebhookStore interface {
	FindReamazeIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error)
}

func (d *Deps) ReamazeWebhook(w http.ResponseWriter, r *http.Request) {
	accountDomain := normalizeReamazeAccountDomain(chi.URLParam(r, "account_domain"))
	if accountDomain == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_domain", "re:amaze account domain is required")
		return
	}
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	if webhookID == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "request authentication failed")
		return
	}
	store, ok := d.Repo.(ReamazeWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "re:amaze webhook lookup is not configured")
		return
	}
	integration, err := store.FindReamazeIntegrationByDomain(r.Context(), accountDomain, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "re:amaze integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "re:amaze webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read re:amaze webhook body")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "re:amaze webhook payload must be a JSON object")
		return
	}
	slug := reamazeWebhookConversationSlug(raw)
	if slug == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_conversation_slug", "re:amaze webhook conversation slug is required")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "re:amaze webhook idempotency is not configured")
		return
	}
	topic := reamazeWebhookTopic(raw)
	deliveryID := reamazeWebhookDeliveryID(accountDomain, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderReamaze, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.reamazeWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if reamazeRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderReamaze, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderReamaze, deliveryID, err)
		writeReamazeRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderReamaze, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderReamaze, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "re:amaze webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderReamaze, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderReamaze, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) reamazeWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	slug := reamazeWebhookConversationSlug(raw)
	refresher, _ := d.ReamazeBackfiller.(ReamazeConversationRefresher)
	if refresher != nil && slug != "" {
		req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, slug)
		if err != nil {
			return SyncRequest{}, err
		}
		req = reamazeWebhookAnnotateRequest(req, raw, body, webhookID, topic)
		if len(req.Tickets)+len(req.Messages)+len(req.Events) > 0 {
			return req, nil
		}
	}
	if req, ok := reamazeDirectWebhookRequest(raw, body, webhookID, topic); ok {
		return req, nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: "reamaze-webhook-" + firstString(slug, reamazeWebhookLocalHash(body))}), nil
}

func reamazeDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, bool) {
	conversationRaw := firstMap(
		reamazeWebhookMap(raw, "conversation"),
		reamazeWebhookMap(raw, "data", "conversation"),
		reamazeWebhookMap(raw, "payload", "conversation"),
		reamazeWebhookMap(raw, "conversation_data"),
	)
	if conversationRaw == nil {
		conversationRaw = raw
	}
	conversation := reamazeConversationFromWebhook(conversationRaw)
	conversation.Slug = firstString(conversation.Slug, reamazeWebhookConversationSlug(raw))
	ticket, ok := mapReamazeConversation(conversation)
	if !ok {
		return SyncRequest{}, false
	}
	messages := []MessageInput{}
	messageRaw := firstMap(reamazeWebhookMap(raw, "message"), reamazeWebhookMap(raw, "data", "message"), reamazeWebhookMap(raw, "payload", "message"))
	if messageRaw != nil {
		message := reamazeMessageFromWebhook(messageRaw, ticket)
		if mapped, ok := mapReamazeMessage(message, ticket, 0); ok {
			messages = append(messages, mapped)
		}
	}
	return reamazeWebhookAnnotateRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "reamaze-webhook-" + firstString(ticket.ConversationID, reamazeWebhookLocalHash(body))}, raw, body, webhookID, topic), true
}

func reamazeWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "reamaze-webhook-" + firstString(reamazeWebhookConversationSlug(raw), reamazeWebhookLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["reamaze_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["reamaze_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["reamaze_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["reamaze_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["reamaze_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["reamaze_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func reamazeConversationFromWebhook(raw map[string]any) reamazeConversation {
	var out reamazeConversation
	payload, _ := json.Marshal(raw)
	_ = json.Unmarshal(payload, &out)
	out.Slug = firstString(out.Slug, supportWebhookString(raw, "slug"), supportWebhookString(raw, "conversation_slug"), supportWebhookString(raw, "conversationId"), supportWebhookString(raw, "conversation_id"))
	out.Subject = firstString(out.Subject, supportWebhookString(raw, "subject"), supportWebhookString(raw, "title"))
	if out.Author.Email == "" {
		out.Author.Email = firstString(supportWebhookString(raw, "email"), supportWebhookString(raw, "customer", "email"), supportWebhookString(raw, "author", "email"), supportWebhookString(raw, "user", "email"))
	}
	if out.Author.Name == "" {
		out.Author.Name = firstString(supportWebhookString(raw, "name"), supportWebhookString(raw, "customer", "name"), supportWebhookString(raw, "author", "name"), supportWebhookString(raw, "user", "name"))
	}
	return out
}

func reamazeMessageFromWebhook(raw map[string]any, ticket TicketInput) reamazeMessage {
	var out reamazeMessage
	payload, _ := json.Marshal(raw)
	_ = json.Unmarshal(payload, &out)
	out.OriginID = firstString(out.OriginID, supportWebhookString(raw, "id"), supportWebhookString(raw, "message_id"), supportWebhookString(raw, "origin_id"))
	out.Body = firstString(out.Body, supportWebhookString(raw, "body"), supportWebhookString(raw, "text"))
	out.OriginalBody = firstString(out.OriginalBody, supportWebhookString(raw, "original_body"), supportWebhookString(raw, "html"))
	out.CreatedAt = firstString(out.CreatedAt, supportWebhookString(raw, "created_at"), supportWebhookString(raw, "timestamp"))
	if out.User.Email == "" {
		out.User.Email = firstString(supportWebhookString(raw, "user", "email"), supportWebhookString(raw, "author", "email"), ticket.Email)
	}
	if out.User.Name == "" {
		out.User.Name = firstString(supportWebhookString(raw, "user", "name"), supportWebhookString(raw, "author", "name"), ticket.RequesterName)
	}
	out.Conversation.Slug = firstString(out.Conversation.Slug, ticket.ConversationID)
	out.Conversation.Subject = firstString(out.Conversation.Subject, ticket.Subject)
	return out
}

func reamazeWebhookTopic(raw map[string]any) string {
	return firstString(
		supportWebhookString(raw, "event"),
		supportWebhookString(raw, "event_name"),
		supportWebhookString(raw, "type"),
		supportWebhookString(raw, "action"),
		supportWebhookString(raw, "data", "event"),
		"conversation.updated",
	)
}

func reamazeWebhookConversationSlug(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "slug"),
		supportWebhookString(raw, "conversation_slug"),
		supportWebhookString(raw, "conversationId"),
		supportWebhookString(raw, "conversation_id"),
		supportWebhookString(raw, "conversation", "slug"),
		supportWebhookString(raw, "conversation", "id"),
		supportWebhookString(raw, "data", "slug"),
		supportWebhookString(raw, "data", "conversation_slug"),
		supportWebhookString(raw, "data", "conversation", "slug"),
		supportWebhookString(raw, "payload", "conversation", "slug"),
	))
}

func reamazeWebhookDeliveryID(accountDomain, webhookID string, raw map[string]any, body []byte) string {
	return "reamaze:" + strings.Join(cleanStrings([]string{
		normalizeReamazeAccountDomain(accountDomain),
		strings.TrimSpace(webhookID),
		firstString(supportWebhookString(raw, "id"), supportWebhookString(raw, "event_id"), supportWebhookString(raw, "message_id")),
		reamazeWebhookTopic(raw),
		reamazeWebhookConversationSlug(raw),
		reamazeWebhookLocalHash(body),
	}), ":")
}

func reamazeWebhookMap(raw map[string]any, path ...string) map[string]any {
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
	if m, ok := cur.(map[string]any); ok {
		return m
	}
	return nil
}

func reamazeWebhookLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func reamazeRefreshMissing(err error) bool {
	var restErr ReamazeRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeReamazeRefreshError(w http.ResponseWriter, err error) {
	var restErr ReamazeRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "reamaze_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "reamaze_refresh_failed", httperror.MessageInternal)
}

func normalizeReamazeAccountDomain(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "https://")
	value = strings.TrimPrefix(value, "http://")
	value = strings.Trim(value, "/")
	value = strings.TrimSuffix(value, ".reamaze.io")
	value = strings.TrimSuffix(value, ".reamaze.com")
	return strings.TrimSpace(value)
}
