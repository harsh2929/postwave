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

const zendeskWebhookSignatureTolerance = 5 * time.Minute

var (
	ErrMissingZendeskWebhookSecret    = errors.New("zendesk webhook secret is required")
	ErrMissingZendeskWebhookSignature = errors.New("zendesk webhook signature is required")
	ErrInvalidZendeskWebhookSignature = errors.New("invalid zendesk webhook signature")
	ErrStaleZendeskWebhookSignature   = errors.New("stale zendesk webhook signature timestamp")
)

type ZendeskWebhookStore interface {
	FindZendeskIntegrationBySubdomain(ctx context.Context, subdomain, webhookID string) (*Integration, error)
}

type SupportWebhookClaimStore interface {
	ClaimSupportWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error)
	MarkSupportWebhookProcessed(ctx context.Context, tenantID, provider, webhookID string) error
	MarkSupportWebhookFailed(ctx context.Context, tenantID, provider, webhookID string, err error) error
}

// ZendeskWebhook receives native Zendesk trigger/webhook deliveries on a public
// provider-shaped endpoint. The route is tenantless; lookup is constrained by
// subdomain plus optional provider webhook id, then the raw body is verified
// with Zendesk's HMAC-SHA256 signature headers before canonical ingest.
func (d *Deps) ZendeskWebhook(w http.ResponseWriter, r *http.Request) {
	subdomain := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "subdomain")))
	if subdomain == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_subdomain", "zendesk subdomain is required")
		return
	}
	store, ok := d.Repo.(ZendeskWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "zendesk webhook lookup is not configured")
		return
	}
	webhookID := zendeskWebhookID(r)
	integration, err := store.FindZendeskIntegrationBySubdomain(r.Context(), subdomain, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "zendesk integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "zendesk payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read zendesk webhook body")
		return
	}
	secret, err := d.zendeskWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyZendeskWebhookSignature(secret, body, r.Header.Get("X-Zendesk-Webhook-Signature-Timestamp"), r.Header.Get("X-Zendesk-Webhook-Signature"), d.now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	deliveryID := zendeskWebhookDeliveryID(r, subdomain, webhookID, body)
	topic := zendeskWebhookTopic(body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderZendesk, deliveryID, topic, body)
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
	req, ok := mapZendeskWebhook(body, *integration, webhookID)
	if !ok {
		ticketID := zendeskTicketIDFromWebhook(body)
		if ticketID != "" {
			refreshed, refreshedOK, err := d.refreshZendeskWebhookTicket(r.Context(), integration, ticketID, body, webhookID)
			if err != nil {
				if zendeskRefreshTicketMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderZendesk, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "ticket_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderZendesk, deliveryID, err)
				writeZendeskRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderZendesk, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderZendesk, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "zendesk webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderZendesk, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderZendesk, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshZendeskWebhookTicket(ctx context.Context, integration *Integration, ticketID string, body []byte, webhookID string) (SyncRequest, bool, error) {
	refresher, ok := d.ZendeskBackfiller.(ZendeskTicketRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("zendesk ticket refresh is not configured")
	}
	req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ticketID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = zendeskWebhookRefreshRequest(req, body, webhookID)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func zendeskWebhookRefreshRequest(in SyncRequest, body []byte, webhookID string) SyncRequest {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	in.RunMode = "webhook"
	in.Cursor = "zendesk-webhook-" + firstString(strings.TrimSpace(webhookID), zendeskTicketID(raw), zendeskWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["zendesk_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["zendesk_trigger_id"] = zendeskWebhookString(raw, "trigger", "id")
		in.Tickets[i].Properties["zendesk_trigger_name"] = zendeskWebhookString(raw, "trigger", "title")
		in.Tickets[i].Properties["zendesk_event"] = firstString(zendeskWebhookString(raw, "event"), zendeskWebhookString(raw, "type"))
		in.Tickets[i].Properties["zendesk_refresh_source"] = "webhook_sparse_ticket"
		in.Tickets[i].Properties["zendesk_raw"] = raw
		if message, ok := mapZendeskWebhookMessage(raw, in.Tickets[i], webhookID); ok {
			in.Messages = append(in.Messages, message)
		}
	}
	return normalizeSyncRequest(in)
}

func zendeskRefreshTicketMissing(err error) bool {
	var restErr ZendeskRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeZendeskRefreshError(w http.ResponseWriter, err error) {
	var restErr ZendeskRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "zendesk_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) zendeskWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingZendeskWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "zendesk_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingZendeskWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingZendeskWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyZendeskWebhookSignature(secret string, body []byte, timestampHeader, signatureHeader string, now time.Time) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingZendeskWebhookSecret
	}
	timestampHeader = strings.TrimSpace(timestampHeader)
	signatureHeader = strings.TrimSpace(signatureHeader)
	if timestampHeader == "" || signatureHeader == "" {
		return ErrMissingZendeskWebhookSignature
	}
	if err := zendeskValidateSignatureTimestamp(timestampHeader, now); err != nil {
		return err
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestampHeader))
	mac.Write(body)
	expected := mac.Sum(nil)
	signatureHeader = strings.TrimPrefix(signatureHeader, "sha256=")
	got, err := base64.StdEncoding.DecodeString(signatureHeader)
	if err != nil {
		return ErrInvalidZendeskWebhookSignature
	}
	if !hmac.Equal(got, expected) {
		return ErrInvalidZendeskWebhookSignature
	}
	return nil
}

func zendeskValidateSignatureTimestamp(raw string, now time.Time) error {
	if now.IsZero() {
		return nil
	}
	var ts time.Time
	if unix, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil {
		ts = time.Unix(unix, 0).UTC()
	} else if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(raw)); err == nil {
		ts = parsed.UTC()
	} else {
		return ErrStaleZendeskWebhookSignature
	}
	delta := now.UTC().Sub(ts)
	if delta < 0 {
		delta = -delta
	}
	if delta > zendeskWebhookSignatureTolerance {
		return ErrStaleZendeskWebhookSignature
	}
	return nil
}

func mapZendeskWebhook(body []byte, integration Integration, webhookID string) (SyncRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	ticketID := zendeskTicketID(raw)
	email := strings.ToLower(strings.TrimSpace(firstString(
		zendeskWebhookString(raw, "ticket", "requester", "email"),
		zendeskWebhookString(raw, "requester", "email"),
		zendeskWebhookString(raw, "user", "email"),
		zendeskWebhookString(raw, "email"),
		zendeskWebhookString(raw, "data", "ticket", "requester", "email"),
	)))
	if ticketID == "" || email == "" {
		return SyncRequest{}, false
	}
	requesterName := firstString(
		zendeskWebhookString(raw, "ticket", "requester", "name"),
		zendeskWebhookString(raw, "requester", "name"),
		zendeskWebhookString(raw, "user", "name"),
		zendeskWebhookString(raw, "name"),
	)
	status := firstString(
		zendeskWebhookString(raw, "ticket", "status"),
		zendeskWebhookString(raw, "status"),
		zendeskWebhookString(raw, "data", "ticket", "status"),
	)
	updatedAt := firstString(
		zendeskWebhookString(raw, "ticket", "updated_at"),
		zendeskWebhookString(raw, "updated_at"),
		zendeskWebhookString(raw, "data", "ticket", "updated_at"),
	)
	ticket := TicketInput{
		SourceID:       "zendesk://ticket/" + ticketID,
		ConversationID: ticketID,
		Email:          email,
		RequesterName:  requesterName,
		Subject: firstString(
			zendeskWebhookString(raw, "ticket", "subject"),
			zendeskWebhookString(raw, "subject"),
			zendeskWebhookString(raw, "data", "ticket", "subject"),
		),
		Status:   status,
		Priority: firstString(zendeskWebhookString(raw, "ticket", "priority"), zendeskWebhookString(raw, "priority")),
		Tags:     zendeskWebhookStrings(raw, "ticket", "tags"),
		Properties: map[string]any{
			"zendesk_ticket_id":    ticketID,
			"zendesk_webhook_id":   strings.TrimSpace(webhookID),
			"zendesk_trigger_id":   zendeskWebhookString(raw, "trigger", "id"),
			"zendesk_trigger_name": zendeskWebhookString(raw, "trigger", "title"),
			"zendesk_event":        firstString(zendeskWebhookString(raw, "event"), zendeskWebhookString(raw, "type")),
			"zendesk_raw":          raw,
		},
		UpdatedAt: parseZendeskTime(updatedAt),
	}
	messages := []MessageInput{}
	if message, ok := mapZendeskWebhookMessage(raw, ticket, webhookID); ok {
		messages = append(messages, message)
	}
	cursor := "zendesk-webhook-" + firstString(strings.TrimSpace(webhookID), zendeskWebhookLocalID(body))
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: cursor}), true
}

func zendeskTicketIDFromWebhook(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return zendeskTicketID(raw)
}

func zendeskTicketID(raw map[string]any) string {
	return firstString(
		zendeskWebhookString(raw, "ticket", "id"),
		zendeskWebhookString(raw, "ticket_id"),
		zendeskWebhookString(raw, "data", "ticket", "id"),
		zendeskWebhookString(raw, "id"),
	)
}

func mapZendeskWebhookMessage(raw map[string]any, ticket TicketInput, webhookID string) (MessageInput, bool) {
	commentID := firstString(
		zendeskWebhookString(raw, "comment", "id"),
		zendeskWebhookString(raw, "ticket", "comment", "id"),
		zendeskWebhookString(raw, "data", "comment", "id"),
	)
	bodyText := firstString(
		zendeskWebhookString(raw, "comment", "body"),
		zendeskWebhookString(raw, "ticket", "comment", "body"),
		zendeskWebhookString(raw, "data", "comment", "body"),
		zendeskWebhookString(raw, "comment", "plain_body"),
	)
	bodyHTML := firstString(
		zendeskWebhookString(raw, "comment", "html_body"),
		zendeskWebhookString(raw, "ticket", "comment", "html_body"),
		zendeskWebhookString(raw, "data", "comment", "html_body"),
	)
	if commentID == "" && bodyText == "" && bodyHTML == "" {
		return MessageInput{}, false
	}
	sourceID := "zendesk://comment/" + firstString(commentID, zendeskWebhookLocalIDString(ticket.ConversationID+"|"+bodyText+"|"+bodyHTML))
	occurred := firstParsedSupportTime(
		zendeskWebhookString(raw, "comment", "created_at"),
		zendeskWebhookString(raw, "ticket", "comment", "created_at"),
		zendeskWebhookString(raw, "data", "comment", "created_at"),
	)
	return MessageInput{
		SourceID:       sourceID,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        ticket.Subject,
		Direction:      firstString(zendeskWebhookString(raw, "comment", "direction"), "inbound"),
		SenderType:     firstString(zendeskWebhookString(raw, "comment", "author", "role"), "customer"),
		Sender:         firstString(zendeskWebhookString(raw, "comment", "author", "name"), ticket.RequesterName),
		BodyText:       bodyText,
		BodyHTML:       bodyHTML,
		Properties: map[string]any{
			"zendesk_ticket_id":  ticket.ConversationID,
			"zendesk_comment_id": commentID,
			"zendesk_webhook_id": strings.TrimSpace(webhookID),
		},
		OccurredAt: occurred,
	}, true
}

func zendeskWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Zendesk-Webhook-Id"),
		r.Header.Get("X-Zendesk-Webhook-ID"),
		r.URL.Query().Get("webhook_id"),
	))
}

func zendeskWebhookDeliveryID(r *http.Request, subdomain, webhookID string, body []byte) string {
	invocationID := ""
	if r != nil {
		invocationID = firstString(
			r.Header.Get("X-Zendesk-Webhook-Invocation-Id"),
			r.Header.Get("X-Zendesk-Webhook-Invocation-ID"),
			r.Header.Get("X-Zendesk-Webhook-Request-Id"),
			r.Header.Get("X-Request-Id"),
		)
	}
	return "subdomain:" + strings.ToLower(strings.TrimSpace(subdomain)) +
		":webhook:" + firstString(strings.TrimSpace(webhookID), "unscoped") +
		":delivery:" + firstString(strings.TrimSpace(invocationID), "body:"+zendeskWebhookLocalID(body))
}

func zendeskWebhookTopic(body []byte) string {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	return firstString(
		zendeskWebhookString(raw, "event"),
		zendeskWebhookString(raw, "type"),
		zendeskWebhookString(raw, "trigger", "category"),
		"ticket.updated",
	)
}

func zendeskWebhookString(node map[string]any, path ...string) string {
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

func zendeskWebhookStrings(node map[string]any, path ...string) []string {
	cur := any(node)
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[key]
	}
	switch typed := cur.(type) {
	case []string:
		return cleanStrings(typed)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, strings.TrimSpace(fmt.Sprint(item)))
		}
		return cleanStrings(out)
	default:
		return nil
	}
}

func firstParsedSupportTime(values ...string) *time.Time {
	for _, value := range values {
		if t := parseZendeskTime(value); t != nil {
			return t
		}
	}
	return nil
}

func zendeskWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}

func zendeskWebhookLocalIDString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}
