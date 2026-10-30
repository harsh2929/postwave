// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"bytes"
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
	ErrMissingGorgiasWebhookSecret    = errors.New("gorgias webhook secret is required")
	ErrMissingGorgiasWebhookAuth      = errors.New("gorgias webhook authentication is required")
	ErrInvalidGorgiasWebhookSignature = errors.New("invalid gorgias webhook signature")
)

type GorgiasWebhookStore interface {
	FindGorgiasIntegrationByDomain(ctx context.Context, accountDomain, integrationID string) (*Integration, error)
}

// GorgiasWebhook receives custom Gorgias HTTP-integration callbacks on a
// provider-shaped public endpoint. Gorgias documents HTTP integration triggers
// and custom headers; the exact hmac_secret signature header shape still needs
// live certification, so this handler requires a vault-backed shared secret and
// accepts both custom secret headers and conservative HMAC-SHA256 forms.
func (d *Deps) GorgiasWebhook(w http.ResponseWriter, r *http.Request) {
	accountDomain := normalizeGorgiasWebhookDomain(chi.URLParam(r, "account_domain"))
	if accountDomain == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_domain", "gorgias account domain is required")
		return
	}
	store, ok := d.Repo.(GorgiasWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "gorgias webhook lookup is not configured")
		return
	}
	integrationID := gorgiasHTTPIntegrationID(r)
	integration, err := store.FindGorgiasIntegrationByDomain(r.Context(), accountDomain, integrationID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "gorgias integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "gorgias payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read gorgias webhook body")
		return
	}
	secret, err := d.gorgiasWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyGorgiasWebhookAuth(secret, body, r); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	deliveryID := gorgiasWebhookDeliveryID(accountDomain, integrationID, body)
	topic := gorgiasWebhookTopic(body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderGorgias, deliveryID, topic, body)
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
	req, ok := mapGorgiasWebhook(body, *integration, integrationID)
	if !ok {
		ticketID := gorgiasTicketIDFromWebhook(body)
		if ticketID != "" {
			refreshed, refreshedOK, err := d.refreshGorgiasWebhookTicket(r.Context(), integration, ticketID, body, integrationID)
			if err != nil {
				if gorgiasRefreshTicketMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGorgias, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "ticket_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGorgias, deliveryID, err)
				writeGorgiasRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGorgias, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGorgias, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "gorgias webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderGorgias, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderGorgias, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshGorgiasWebhookTicket(ctx context.Context, integration *Integration, ticketID string, body []byte, integrationID string) (SyncRequest, bool, error) {
	refresher, ok := d.GorgiasBackfiller.(GorgiasTicketRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("gorgias ticket refresh is not configured")
	}
	req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ticketID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = gorgiasWebhookRefreshRequest(req, body, integrationID)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func gorgiasWebhookRefreshRequest(in SyncRequest, body []byte, integrationID string) SyncRequest {
	var raw map[string]any
	raw, _ = decodeGorgiasWebhookJSON(body)
	in.RunMode = "webhook"
	in.Cursor = "gorgias-webhook-" + firstString(strings.TrimSpace(integrationID), gorgiasTicketID(raw), gorgiasWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["gorgias_http_integration_id"] = strings.TrimSpace(integrationID)
		in.Tickets[i].Properties["gorgias_event"] = firstString(gorgiasWebhookString(raw, "event"), gorgiasWebhookString(raw, "trigger"), gorgiasWebhookString(raw, "type"))
		in.Tickets[i].Properties["gorgias_refresh_source"] = "webhook_sparse_ticket"
		in.Tickets[i].Properties["gorgias_raw"] = raw
		in.Tickets[i].Properties = mergeGorgiasCommerceEvidence(in.Tickets[i].Properties, raw)
		if message, ok := mapGorgiasWebhookMessage(raw, in.Tickets[i], integrationID); ok {
			in.Messages = append(in.Messages, message)
		}
	}
	return normalizeSyncRequest(in)
}

func gorgiasRefreshTicketMissing(err error) bool {
	var restErr GorgiasRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeGorgiasRefreshError(w http.ResponseWriter, err error) {
	var restErr GorgiasRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "gorgias_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) gorgiasWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingGorgiasWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "gorgias_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingGorgiasWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingGorgiasWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyGorgiasWebhookAuth(secret string, body []byte, r *http.Request) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingGorgiasWebhookSecret
	}
	if r == nil {
		return ErrMissingGorgiasWebhookAuth
	}
	if got := gorgiasSharedSecretHeader(r); got != "" {
		if hmac.Equal([]byte(got), []byte(secret)) {
			return nil
		}
		return ErrInvalidGorgiasWebhookSignature
	}
	signature := strings.TrimSpace(firstString(
		r.Header.Get("X-Gorgias-Hmac-Sha256"),
		r.Header.Get("X-Gorgias-HMAC-SHA256"),
		r.Header.Get("X-Gorgias-Signature"),
		r.Header.Get("X-Webhook-Signature"),
		r.Header.Get("X-Postwave-Signature"),
	))
	if signature == "" {
		return ErrMissingGorgiasWebhookAuth
	}
	timestamp := strings.TrimSpace(firstString(
		r.Header.Get("X-Gorgias-Webhook-Timestamp"),
		r.Header.Get("X-Gorgias-Timestamp"),
		r.Header.Get("X-Webhook-Timestamp"),
	))
	if verifyGorgiasHMACSignature(secret, body, signature, timestamp) {
		return nil
	}
	return ErrInvalidGorgiasWebhookSignature
}

func gorgiasSharedSecretHeader(r *http.Request) string {
	got := ""
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if rest, found := strings.CutPrefix(auth, "Bearer "); found {
		got = strings.TrimSpace(rest)
	}
	return strings.TrimSpace(firstString(
		got,
		r.Header.Get("X-Gorgias-Webhook-Secret"),
		r.Header.Get("X-Postwave-Webhook-Secret"),
		r.Header.Get("X-Webhook-Secret"),
	))
}

func verifyGorgiasHMACSignature(secret string, body []byte, signatureHeader, timestamp string) bool {
	got, ok := decodeGorgiasSignature(signatureHeader)
	if !ok {
		return false
	}
	candidates := [][]byte{body}
	if timestamp != "" {
		candidates = append(candidates,
			append([]byte(timestamp), body...),
			append(append([]byte(timestamp), '.'), body...),
		)
	}
	for _, candidate := range candidates {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(candidate)
		if hmac.Equal(got, mac.Sum(nil)) {
			return true
		}
	}
	return false
}

func decodeGorgiasSignature(raw string) ([]byte, bool) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "sha256=")
	if raw == "" {
		return nil, false
	}
	if got, err := hex.DecodeString(raw); err == nil {
		return got, true
	}
	if got, err := base64.StdEncoding.DecodeString(raw); err == nil {
		return got, true
	}
	if got, err := base64.RawStdEncoding.DecodeString(raw); err == nil {
		return got, true
	}
	return nil, false
}

func mapGorgiasWebhook(body []byte, integration Integration, integrationID string) (SyncRequest, bool) {
	raw, err := decodeGorgiasWebhookJSON(body)
	if err != nil {
		return SyncRequest{}, false
	}
	ticketID := gorgiasTicketID(raw)
	email := strings.ToLower(strings.TrimSpace(firstString(
		gorgiasWebhookString(raw, "ticket", "customer", "email"),
		gorgiasWebhookString(raw, "customer", "email"),
		gorgiasWebhookString(raw, "data", "ticket", "customer", "email"),
		gorgiasWebhookString(raw, "email"),
	)))
	if ticketID == "" || email == "" {
		return SyncRequest{}, false
	}
	customerName := firstString(
		gorgiasWebhookString(raw, "ticket", "customer", "name"),
		gorgiasWebhookString(raw, "customer", "name"),
		gorgiasWebhookString(raw, "name"),
	)
	updatedAt := firstString(
		gorgiasWebhookString(raw, "ticket", "updated_datetime"),
		gorgiasWebhookString(raw, "ticket", "updated_at"),
		gorgiasWebhookString(raw, "updated_datetime"),
		gorgiasWebhookString(raw, "updated_at"),
	)
	ticket := TicketInput{
		SourceID:       "gorgias://ticket/" + ticketID,
		ConversationID: ticketID,
		Email:          email,
		RequesterName:  customerName,
		Subject: firstString(
			gorgiasWebhookString(raw, "ticket", "subject"),
			gorgiasWebhookString(raw, "subject"),
			gorgiasWebhookString(raw, "data", "ticket", "subject"),
		),
		Status: firstString(
			gorgiasWebhookString(raw, "ticket", "status"),
			gorgiasWebhookString(raw, "status"),
			gorgiasWebhookString(raw, "data", "ticket", "status"),
		),
		Priority: firstString(gorgiasWebhookString(raw, "ticket", "priority"), gorgiasWebhookString(raw, "priority")),
		Tags:     gorgiasWebhookTags(raw),
		Properties: map[string]any{
			"gorgias_ticket_id":           ticketID,
			"gorgias_http_integration_id": strings.TrimSpace(integrationID),
			"gorgias_event":               firstString(gorgiasWebhookString(raw, "event"), gorgiasWebhookString(raw, "trigger"), gorgiasWebhookString(raw, "type")),
			"gorgias_raw":                 raw,
		},
		UpdatedAt: parseGorgiasTime(updatedAt),
	}
	ticket.Properties = mergeGorgiasCommerceEvidence(ticket.Properties, raw)
	messages := []MessageInput{}
	if message, ok := mapGorgiasWebhookMessage(raw, ticket, integrationID); ok {
		messages = append(messages, message)
	}
	cursor := "gorgias-webhook-" + firstString(strings.TrimSpace(integrationID), gorgiasWebhookLocalID(body))
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: cursor}), true
}

func gorgiasTicketIDFromWebhook(body []byte) string {
	raw, err := decodeGorgiasWebhookJSON(body)
	if err != nil {
		return ""
	}
	return gorgiasTicketID(raw)
}

func gorgiasTicketID(raw map[string]any) string {
	return firstString(
		gorgiasWebhookString(raw, "ticket", "id"),
		gorgiasWebhookString(raw, "ticket_id"),
		gorgiasWebhookString(raw, "data", "ticket", "id"),
		gorgiasWebhookString(raw, "id"),
	)
}

func mapGorgiasWebhookMessage(raw map[string]any, ticket TicketInput, integrationID string) (MessageInput, bool) {
	messageID := firstString(
		gorgiasWebhookString(raw, "message", "id"),
		gorgiasWebhookString(raw, "message", "message_id"),
		gorgiasWebhookString(raw, "ticket", "message", "id"),
		gorgiasWebhookString(raw, "data", "message", "id"),
	)
	bodyText := firstString(
		gorgiasWebhookString(raw, "message", "body_text"),
		gorgiasWebhookString(raw, "message", "stripped_text"),
		gorgiasWebhookString(raw, "ticket", "message", "body_text"),
		gorgiasWebhookString(raw, "data", "message", "body_text"),
		gorgiasWebhookString(raw, "body_text"),
	)
	bodyHTML := firstString(
		gorgiasWebhookString(raw, "message", "body_html"),
		gorgiasWebhookString(raw, "message", "stripped_html"),
		gorgiasWebhookString(raw, "ticket", "message", "body_html"),
		gorgiasWebhookString(raw, "data", "message", "body_html"),
		gorgiasWebhookString(raw, "body_html"),
	)
	if messageID == "" && bodyText == "" && bodyHTML == "" {
		return MessageInput{}, false
	}
	sourceID := "gorgias://message/" + firstString(messageID, gorgiasWebhookLocalIDString(ticket.ConversationID+"|"+bodyText+"|"+bodyHTML))
	fromAgent := gorgiasWebhookBool(raw, "message", "from_agent") || gorgiasWebhookBool(raw, "from_agent")
	direction := "inbound"
	senderType := "customer"
	if fromAgent {
		direction = "outbound"
		senderType = "agent"
	}
	out := MessageInput{
		SourceID:       sourceID,
		ConversationID: ticket.ConversationID,
		Email:          ticket.Email,
		RequesterName:  ticket.RequesterName,
		Subject:        firstString(gorgiasWebhookString(raw, "message", "subject"), ticket.Subject),
		Direction:      direction,
		SenderType:     senderType,
		Sender: firstString(
			gorgiasWebhookString(raw, "message", "sender", "name"),
			gorgiasWebhookString(raw, "sender", "name"),
			ticket.RequesterName,
		),
		BodyText: bodyText,
		BodyHTML: bodyHTML,
		Properties: map[string]any{
			"gorgias_ticket_id":           ticket.ConversationID,
			"gorgias_message_id":          messageID,
			"gorgias_http_integration_id": strings.TrimSpace(integrationID),
		},
		OccurredAt: firstParsedGorgiasTime(
			gorgiasWebhookString(raw, "message", "created_datetime"),
			gorgiasWebhookString(raw, "message", "sent_datetime"),
			gorgiasWebhookString(raw, "data", "message", "created_datetime"),
		),
	}
	out.Properties = mergeGorgiasCommerceEvidence(out.Properties, raw)
	for _, key := range []string{
		"gorgias_commerce_context_present",
		"gorgias_commerce_context_source",
		"gorgias_commerce_provider",
		"external_order_id",
		"shopify_order_id",
		"order_number",
		"order_status",
		"order_financial_status",
		"order_fulfillment_status",
		"order_total",
		"order_currency",
		"external_customer_id",
		"shopify_customer_id",
		"recharge_subscription_id",
		"recharge_subscription_status",
	} {
		if value, ok := ticket.Properties[key]; ok {
			if _, exists := out.Properties[key]; !exists {
				out.Properties[key] = value
			}
		}
	}
	return out, true
}

func gorgiasHTTPIntegrationID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Gorgias-Integration-Id"),
		r.Header.Get("X-Gorgias-HTTP-Integration-Id"),
		r.URL.Query().Get("integration_id"),
		r.URL.Query().Get("http_integration_id"),
	))
}

func gorgiasWebhookDeliveryID(accountDomain, integrationID string, body []byte) string {
	return "domain:" + normalizeGorgiasWebhookDomain(accountDomain) +
		":integration:" + firstString(strings.TrimSpace(integrationID), "unscoped") +
		":body:" + gorgiasWebhookLocalID(body)
}

func gorgiasWebhookTopic(body []byte) string {
	raw, _ := decodeGorgiasWebhookJSON(body)
	return firstString(
		gorgiasWebhookString(raw, "event"),
		gorgiasWebhookString(raw, "trigger"),
		gorgiasWebhookString(raw, "type"),
		"ticket-updated",
	)
}

func normalizeGorgiasWebhookDomain(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	raw = strings.TrimPrefix(strings.TrimPrefix(raw, "https://"), "http://")
	raw = strings.Trim(strings.TrimSpace(raw), "/")
	return raw
}

func gorgiasWebhookString(node map[string]any, path ...string) string {
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

func gorgiasWebhookBool(node map[string]any, path ...string) bool {
	value := strings.ToLower(gorgiasWebhookString(node, path...))
	return value == "true" || value == "1" || value == "yes"
}

func gorgiasWebhookTags(raw map[string]any) []string {
	for _, path := range [][]string{{"ticket", "tags"}, {"tags"}, {"data", "ticket", "tags"}} {
		if tags := gorgiasWebhookStrings(raw, path...); len(tags) > 0 {
			return tags
		}
	}
	return nil
}

func gorgiasWebhookStrings(node map[string]any, path ...string) []string {
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
			if m, ok := item.(map[string]any); ok {
				out = append(out, firstString(gorgiasWebhookString(m, "name"), gorgiasWebhookString(m, "value")))
				continue
			}
			out = append(out, strings.TrimSpace(fmt.Sprint(item)))
		}
		return cleanStrings(out)
	default:
		return nil
	}
}

func firstParsedGorgiasTime(values ...string) *time.Time {
	for _, value := range values {
		if t := parseGorgiasTime(value); t != nil {
			return t
		}
	}
	return nil
}

func gorgiasWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}

func decodeGorgiasWebhookJSON(body []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func gorgiasWebhookLocalIDString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}
