// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var ErrMissingFreshchatWebhookPublicKey = errors.New("freshchat webhook public key is required")

type FreshchatWebhookStore interface {
	FindFreshchatIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error)
}

func (d *Deps) FreshchatWebhook(w http.ResponseWriter, r *http.Request) {
	accountDomain := normalizeFreshchatWebhookDomain(chi.URLParam(r, "account_domain"))
	webhookID := freshchatWebhookID(r)
	store, ok := d.Repo.(FreshchatWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "freshchat webhook lookup is not configured")
		return
	}
	integration, err := store.FindFreshchatIntegrationByDomain(r.Context(), accountDomain, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "freshchat integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "freshchat webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read freshchat webhook body")
		return
	}
	if err := d.verifyFreshchatWebhookSignature(r, integration, body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	conversationID := freshchatWebhookConversationID(body)
	userID := freshchatWebhookUserID(body)
	if conversationID == "" || userID == "" {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "freshchat webhook idempotency is not configured")
		return
	}
	topic := freshchatWebhookTopic(body)
	deliveryID := freshchatWebhookDeliveryID(r, accountDomain, webhookID, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderFreshchat, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.freshchatWebhookRefresh(r.Context(), integration, body, webhookID, topic, conversationID, userID)
	if err != nil {
		if freshchatRefreshConversationMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFreshchat, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFreshchat, deliveryID, err)
		writeFreshchatRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFreshchat, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderFreshchat, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderFreshchat, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) freshchatWebhookRefresh(ctx context.Context, integration *Integration, body []byte, webhookID, topic, conversationID, userID string) (SyncRequest, error) {
	refresher, ok := d.FreshchatBackfiller.(FreshchatConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, fmt.Errorf("freshchat conversation refresher is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID, userID)
	if err != nil {
		return SyncRequest{}, err
	}
	req = freshchatWebhookRefreshRequest(req, body, webhookID, topic)
	return req, nil
}

func freshchatWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	webhookID = strings.TrimSpace(webhookID)
	topic = strings.TrimSpace(topic)
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["freshchat_webhook_id"] = webhookID
		in.Tickets[i].Properties["freshchat_webhook_event"] = topic
		in.Tickets[i].Properties["freshchat_refresh_source"] = "webhook_sparse_conversation"
		in.Tickets[i].Properties["freshchat_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["freshchat_webhook_id"] = webhookID
		in.Messages[i].Properties["freshchat_webhook_event"] = topic
	}
	in.RunMode = "webhook"
	return normalizeSyncRequest(in)
}

func (d *Deps) verifyFreshchatWebhookSignature(r *http.Request, integration *Integration, body []byte) error {
	signature := strings.TrimSpace(r.Header.Get("X-Freshchat-Signature"))
	if signature == "" {
		return fmt.Errorf("freshchat signature is required")
	}
	key, err := d.freshchatWebhookPublicKey(r.Context(), integration)
	if err != nil {
		return err
	}
	return verifyFreshchatSignature(body, signature, key)
}

func (d *Deps) freshchatWebhookPublicKey(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingFreshchatWebhookPublicKey
	}
	if key := strings.TrimSpace(firstString(
		settingString(integration.Settings, "freshchat_webhook_public_key"),
		settingString(integration.Settings, "freshchat_public_key"),
	)); key != "" {
		return key, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "freshchat_webhook_public_key_ref"),
		settingString(integration.Settings, "webhook_public_key_ref"),
	))
	if ref == "" {
		return "", ErrMissingFreshchatWebhookPublicKey
	}
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingFreshchatWebhookPublicKey
	}
	key, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(key) == "" {
		return "", ErrMissingFreshchatWebhookPublicKey
	}
	return key, nil
}

func verifyFreshchatSignature(body []byte, signature, publicKey string) error {
	pub, err := parseFreshchatPublicKey(publicKey)
	if err != nil {
		return err
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil {
		return fmt.Errorf("decode freshchat signature: %w", err)
	}
	sum := sha256.Sum256(body)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], decoded); err != nil {
		return fmt.Errorf("freshchat signature mismatch")
	}
	return nil
}

func parseFreshchatPublicKey(value string) (*rsa.PublicKey, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, ErrMissingFreshchatWebhookPublicKey
	}
	var der []byte
	if block, _ := pem.Decode([]byte(value)); block != nil {
		der = block.Bytes
	} else {
		raw := strings.TrimSpace(value)
		raw = strings.TrimPrefix(raw, "-----BEGIN PUBLIC KEY-----")
		raw = strings.TrimSuffix(raw, "-----END PUBLIC KEY-----")
		raw = strings.ReplaceAll(raw, "\n", "")
		raw = strings.ReplaceAll(raw, "\r", "")
		raw = strings.ReplaceAll(raw, " ", "")
		decoded, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("decode freshchat public key: %w", err)
		}
		der = decoded
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("parse freshchat public key: %w", err)
	}
	pub, ok := parsed.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("freshchat public key must be RSA")
	}
	return pub, nil
}

func freshchatRefreshConversationMissing(err error) bool {
	var restErr FreshchatRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeFreshchatRefreshError(w http.ResponseWriter, err error) {
	var restErr FreshchatRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", strconv.FormatInt(int64(restErr.RetryAfter.Seconds()), 10))
		}
		if restErr.StatusCode == http.StatusTooManyRequests || restErr.StatusCode >= 500 {
			httperror.Write(w, http.StatusAccepted, "freshchat_refresh_retry", "freshchat refresh failed; retry later")
			return
		}
	}
	httperror.Write(w, http.StatusBadGateway, "freshchat_refresh_failed", httperror.MessageInternal)
}

func freshchatWebhookID(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		chi.URLParam(r, "webhook_id"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("freshchat_webhook_id"),
		r.Header.Get("X-Freshchat-Webhook-Id"),
		r.Header.Get("X-Freshchat-Webhook-ID"),
	))
}

func freshchatWebhookConversationID(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return firstString(
		supportWebhookString(raw, "data", "message", "conversation_id"),
		supportWebhookString(raw, "data", "conversation", "conversation_id"),
		supportWebhookString(raw, "data", "conversation", "id"),
		supportWebhookString(raw, "message", "conversation_id"),
		supportWebhookString(raw, "conversation", "conversation_id"),
		supportWebhookString(raw, "conversation", "id"),
		supportWebhookString(raw, "conversation_id"),
	)
}

func freshchatWebhookUserID(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return firstString(
		supportWebhookString(raw, "data", "message", "user_id"),
		supportWebhookString(raw, "data", "conversation", "user_id"),
		supportWebhookString(raw, "message", "user_id"),
		supportWebhookString(raw, "conversation", "user_id"),
		supportWebhookString(raw, "user_id"),
	)
}

func freshchatWebhookTopic(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return "freshchat.webhook"
	}
	return firstString(
		supportWebhookString(raw, "action"),
		supportWebhookString(raw, "event"),
		supportWebhookString(raw, "topic"),
		"freshchat.webhook",
	)
}

func freshchatWebhookDeliveryID(r *http.Request, accountDomain, webhookID string, body []byte) string {
	requestID := ""
	if r != nil {
		requestID = firstString(
			r.Header.Get("X-Request-Id"),
			r.Header.Get("X-Freshchat-Request-Id"),
		)
	}
	return "domain:" + normalizeFreshchatWebhookDomain(accountDomain) +
		":webhook:" + firstString(strings.TrimSpace(webhookID), "unscoped") +
		":delivery:" + firstString(strings.TrimSpace(requestID), "body:"+freshchatWebhookPayloadHash(body))
}

func freshchatWebhookPayloadHash(body []byte) string {
	sum := sha256.Sum256(body)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func normalizeFreshchatWebhookDomain(value string) string {
	value = normalizeFreshchatDomain(value)
	value = strings.TrimSuffix(value, freshchatDefaultFreshchatHost)
	value = strings.TrimSuffix(value, freshchatDefaultFreshworksHost)
	return strings.TrimSpace(value)
}
