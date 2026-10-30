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
	ErrMissingFreshdeskWebhookSecret = errors.New("freshdesk webhook secret is required")
	ErrMissingFreshdeskWebhookAuth   = errors.New("freshdesk webhook authentication is required")
	ErrInvalidFreshdeskWebhookAuth   = errors.New("invalid freshdesk webhook authentication")
)

type FreshdeskWebhookStore interface {
	FindFreshdeskIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error)
}

// FreshdeskWebhook receives Freshdesk automation webhooks. Freshdesk automation
// webhooks support custom headers/authentication rather than a documented
// provider HMAC, so this endpoint requires a vault-backed shared secret header.
func (d *Deps) FreshdeskWebhook(w http.ResponseWriter, r *http.Request) {
	accountDomain := normalizeFreshdeskWebhookDomain(chi.URLParam(r, "account_domain"))
	if accountDomain == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_domain", "freshdesk account domain is required")
		return
	}
	store, ok := d.Repo.(FreshdeskWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "freshdesk webhook lookup is not configured")
		return
	}
	webhookID := freshdeskWebhookID(r)
	integration, err := store.FindFreshdeskIntegrationByDomain(r.Context(), accountDomain, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "freshdesk integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "freshdesk payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read freshdesk webhook body")
		return
	}
	secret, err := d.freshdeskWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyFreshdeskWebhookAuth(secret, r); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := freshdeskWebhookTopic(body)
	deliveryID := freshdeskWebhookDeliveryID(r, accountDomain, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderFreshdesk, deliveryID, topic, body)
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
	req, ok := mapFreshdeskWebhook(body, *integration, webhookID)
	if !ok {
		ticketID := freshdeskTicketIDFromWebhook(body)
		if ticketID != "" {
			refreshed, refreshedOK, err := d.refreshFreshdeskWebhookTicket(r.Context(), integration, ticketID, body, webhookID)
			if err != nil {
				if freshdeskRefreshTicketMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFreshdesk, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "ticket_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFreshdesk, deliveryID, err)
				writeFreshdeskRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFreshdesk, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFreshdesk, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "freshdesk webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFreshdesk, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFreshdesk, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshFreshdeskWebhookTicket(ctx context.Context, integration *Integration, ticketID string, body []byte, webhookID string) (SyncRequest, bool, error) {
	refresher, ok := d.FreshdeskBackfiller.(FreshdeskTicketRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("freshdesk ticket refresh is not configured")
	}
	req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ticketID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = freshdeskWebhookRefreshRequest(req, body, webhookID)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func freshdeskWebhookRefreshRequest(in SyncRequest, body []byte, webhookID string) SyncRequest {
	raw := freshdeskWebhookRaw(body)
	in.RunMode = "webhook"
	in.Cursor = "freshdesk-webhook-" + firstString(freshdeskTicketID(raw), freshdeskWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["freshdesk_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["freshdesk_webhook_event"] = freshdeskWebhookTopicFromRaw(raw)
		in.Tickets[i].Properties["freshdesk_refresh_source"] = "webhook_sparse_ticket"
		in.Tickets[i].Properties["freshdesk_raw"] = raw
	}
	return normalizeSyncRequest(in)
}

func freshdeskRefreshTicketMissing(err error) bool {
	var restErr FreshdeskRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeFreshdeskRefreshError(w http.ResponseWriter, err error) {
	var restErr FreshdeskRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "freshdesk_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) freshdeskWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingFreshdeskWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "freshdesk_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingFreshdeskWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingFreshdeskWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyFreshdeskWebhookAuth(secret string, r *http.Request) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingFreshdeskWebhookSecret
	}
	if r == nil {
		return ErrMissingFreshdeskWebhookAuth
	}
	got := freshdeskSharedSecretHeader(r)
	if got == "" {
		return ErrMissingFreshdeskWebhookAuth
	}
	if !hmac.Equal([]byte(got), []byte(secret)) {
		return ErrInvalidFreshdeskWebhookAuth
	}
	return nil
}

func freshdeskSharedSecretHeader(r *http.Request) string {
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if rest, found := strings.CutPrefix(auth, "Bearer "); found {
		return strings.TrimSpace(rest)
	}
	if rest, found := strings.CutPrefix(auth, "Basic "); found {
		if decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rest)); err == nil {
			user, pass, found := strings.Cut(string(decoded), ":")
			if found {
				return firstString(pass, user)
			}
			return strings.TrimSpace(string(decoded))
		}
	}
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Freshdesk-Webhook-Secret"),
		r.Header.Get("X-Freshdesk-Secret"),
		r.Header.Get("X-Freshdesk-Webhook-Token"),
		r.Header.Get("X-Webhook-Secret"),
		r.Header.Get("X-Postwave-Webhook-Secret"),
		r.Header.Get("X-Postwave-Secret"),
	))
}

func mapFreshdeskWebhook(body []byte, _ Integration, webhookID string) (SyncRequest, bool) {
	raw := freshdeskWebhookRaw(body)
	if raw == nil {
		return SyncRequest{}, false
	}
	ticket, ok := freshdeskWebhookTicket(raw)
	if !ok {
		return SyncRequest{}, false
	}
	mapped, ok := mapFreshdeskTicket(ticket)
	if !ok {
		return SyncRequest{}, false
	}
	if mapped.Properties == nil {
		mapped.Properties = map[string]any{}
	}
	mapped.Properties["freshdesk_webhook_id"] = strings.TrimSpace(webhookID)
	mapped.Properties["freshdesk_webhook_event"] = freshdeskWebhookTopicFromRaw(raw)
	mapped.Properties["freshdesk_raw"] = raw
	cursor := "freshdesk-webhook-" + firstString(freshdeskTicketID(raw), mapped.ConversationID, freshdeskWebhookLocalID(body))
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{mapped}, Cursor: cursor}), true
}

func freshdeskWebhookTicket(raw map[string]any) (freshdeskTicket, bool) {
	candidates := []any{raw}
	if ticket, ok := raw["ticket"]; ok {
		candidates = append(candidates, ticket)
	}
	if data, ok := raw["data"].(map[string]any); ok {
		candidates = append(candidates, data)
		if ticket, ok := data["ticket"]; ok {
			candidates = append(candidates, ticket)
		}
	}
	for _, candidate := range candidates {
		encoded, err := json.Marshal(candidate)
		if err != nil {
			continue
		}
		var ticket freshdeskTicket
		if err := json.Unmarshal(encoded, &ticket); err != nil {
			continue
		}
		if strings.TrimSpace(ticket.ID.String()) != "" {
			return ticket, true
		}
	}
	return freshdeskTicket{}, false
}

func freshdeskTicketIDFromWebhook(body []byte) string {
	return freshdeskTicketID(freshdeskWebhookRaw(body))
}

func freshdeskTicketID(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		freshdeskWebhookString(raw, "ticket", "id"),
		freshdeskWebhookString(raw, "data", "ticket", "id"),
		freshdeskWebhookString(raw, "data", "id"),
		freshdeskWebhookString(raw, "ticket_id"),
		freshdeskWebhookString(raw, "freshdesk_ticket_id"),
		freshdeskWebhookString(raw, "id"),
	))
}

func freshdeskWebhookID(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("freshdesk_webhook_id"),
		r.Header.Get("X-Freshdesk-Webhook-Id"),
		r.Header.Get("X-Freshdesk-Automation-Id"),
		r.Header.Get("X-Webhook-Id"),
	))
}

func freshdeskWebhookDeliveryID(r *http.Request, accountDomain, webhookID string, body []byte) string {
	headerID := ""
	if r != nil {
		headerID = strings.TrimSpace(firstString(
			r.Header.Get("X-Freshdesk-Event-Id"),
			r.Header.Get("X-Freshdesk-Request-Id"),
			r.Header.Get("X-Request-Id"),
			r.Header.Get("X-Webhook-Delivery"),
			r.Header.Get("X-Webhook-Id"),
		))
	}
	if headerID != "" {
		return "freshdesk:" + accountDomain + ":" + firstString(webhookID, "webhook") + ":" + headerID
	}
	ticketID := freshdeskTicketIDFromWebhook(body)
	return "freshdesk:" + accountDomain + ":" + firstString(webhookID, ticketID, "body") + ":" + freshdeskWebhookLocalID(body)
}

func freshdeskWebhookTopic(body []byte) string {
	return freshdeskWebhookTopicFromRaw(freshdeskWebhookRaw(body))
}

func freshdeskWebhookTopicFromRaw(raw map[string]any) string {
	if raw == nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		freshdeskWebhookString(raw, "event"),
		freshdeskWebhookString(raw, "topic"),
		freshdeskWebhookString(raw, "type"),
		freshdeskWebhookString(raw, "action"),
		freshdeskWebhookString(raw, "trigger"),
		freshdeskWebhookString(raw, "data", "event"),
		freshdeskWebhookString(raw, "ticket", "event"),
	))
}

func freshdeskWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func normalizeFreshdeskWebhookDomain(value string) string {
	return normalizeFreshdeskDomain(value)
}

func freshdeskWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil
	}
	return raw
}

func freshdeskWebhookString(node map[string]any, path ...string) string {
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
				return ""
			}
		}
		cur = v
	}
	return ""
}
