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
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var ErrMissingGrooveWebhookToken = errors.New("groove webhook route token is required")

type GrooveWebhookStore interface {
	FindGrooveIntegrationByMailbox(ctx context.Context, mailboxID, webhookID string) (*Integration, error)
}

func (d *Deps) GrooveWebhook(w http.ResponseWriter, r *http.Request) {
	mailboxID := strings.TrimSpace(chi.URLParam(r, "mailbox_id"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	if webhookID == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "request authentication failed")
		return
	}
	store, ok := d.Repo.(GrooveWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "groove webhook lookup is not configured")
		return
	}
	integration, err := store.FindGrooveIntegrationByMailbox(r.Context(), mailboxID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "groove integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "groove webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read groove webhook body")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "groove webhook payload must be a JSON object")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "groove webhook idempotency is not configured")
		return
	}
	topic := grooveWebhookTopic(raw)
	deliveryID := grooveWebhookDeliveryID(mailboxID, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderGroove, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.grooveWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if grooveRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGroove, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGroove, deliveryID, err)
		writeGrooveRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGroove, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGroove, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "groove webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGroove, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGroove, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) grooveWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.GrooveBackfiller.(GrooveTicketRefresher)
	if refresher != nil {
		if ticketNumber := grooveWebhookTicketNumber(raw); ticketNumber != "" {
			req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ticketNumber)
			if err != nil {
				return SyncRequest{}, err
			}
			return grooveWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := grooveDirectWebhookRequest(raw, body, webhookID, topic); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func grooveDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, bool) {
	ticketRaw := firstMap(grooveWebhookMap(raw, "ticket"), grooveWebhookMap(raw, "data", "ticket"), grooveWebhookMap(raw, "payload", "ticket"))
	if ticketRaw == nil {
		return SyncRequest{}, false
	}
	ticket := grooveTicketFromMap(ticketRaw)
	mapped, ok := mapGrooveTicket(ticket)
	if !ok {
		return SyncRequest{}, false
	}
	return grooveWebhookAnnotateRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: "groove-webhook-" + firstString(mapped.ConversationID, grooveWebhookLocalHash(body))}, raw, body, webhookID, topic), true
}

func grooveWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "groove-webhook-" + firstString(grooveWebhookTicketNumber(raw), grooveWebhookLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["groove_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["groove_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["groove_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["groove_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["groove_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["groove_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func grooveWebhookTopic(raw map[string]any) string {
	return firstString(
		grooveWebhookString(raw, "event"),
		grooveWebhookString(raw, "event_name"),
		grooveWebhookString(raw, "type"),
		grooveWebhookString(raw, "action"),
		grooveWebhookString(raw, "data", "event"),
	)
}

func grooveWebhookTicketNumber(raw map[string]any) string {
	return firstString(
		grooveWebhookString(raw, "number"),
		grooveWebhookString(raw, "ticket_number"),
		grooveWebhookString(raw, "ticket", "number"),
		grooveWebhookString(raw, "data", "number"),
		grooveWebhookString(raw, "data", "ticket", "number"),
		grooveIDFromHref(grooveWebhookString(raw, "links", "ticket", "href")),
		grooveIDFromHref(grooveWebhookString(raw, "ticket", "href")),
	)
}

func grooveWebhookDeliveryID(mailboxID, webhookID string, raw map[string]any, body []byte) string {
	return "groove:" + strings.Join(cleanStrings([]string{
		strings.TrimSpace(mailboxID),
		strings.TrimSpace(webhookID),
		firstString(grooveWebhookString(raw, "id"), grooveWebhookString(raw, "event_id"), grooveWebhookString(raw, "message_id")),
		grooveWebhookTopic(raw),
		grooveWebhookTicketNumber(raw),
		grooveWebhookLocalHash(body),
	}), ":")
}

func grooveWebhookLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func grooveRefreshMissing(err error) bool {
	var restErr GrooveRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeGrooveRefreshError(w http.ResponseWriter, err error) {
	var restErr GrooveRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "groove_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "groove_refresh_failed", httperror.MessageInternal)
}

func grooveTicketFromMap(raw map[string]any) grooveTicket {
	return grooveTicket{
		NumberString: firstString(grooveWebhookString(raw, "number"), grooveWebhookString(raw, "number_string")),
		Title:        grooveWebhookString(raw, "title"),
		Summary:      grooveWebhookString(raw, "summary"),
		State:        grooveWebhookString(raw, "state"),
		Priority:     grooveWebhookString(raw, "priority"),
		CreatedAt:    grooveWebhookString(raw, "created_at"),
		UpdatedAt:    grooveWebhookString(raw, "updated_at"),
		Href:         grooveWebhookString(raw, "href"),
		Links: grooveLinks{
			Customer: grooveHref{Href: firstString(grooveWebhookString(raw, "links", "customer", "href"), grooveWebhookString(raw, "customer", "href"))},
			Mailbox:  grooveHref{Href: firstString(grooveWebhookString(raw, "links", "mailbox", "href"), grooveWebhookString(raw, "mailbox", "href"))},
		},
	}
}

func grooveWebhookString(raw map[string]any, path ...string) string {
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
	}
	return strings.TrimSpace(fmt.Sprint(cur))
}

func grooveWebhookMap(raw map[string]any, path ...string) map[string]any {
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
