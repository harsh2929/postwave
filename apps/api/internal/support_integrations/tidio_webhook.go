// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
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

var ErrMissingTidioWebhookSecret = errors.New("tidio webhook secret is required")

type TidioWebhookStore interface {
	FindTidioIntegrationByProject(ctx context.Context, projectPublicKey, webhookID string) (*Integration, error)
}

func (d *Deps) TidioWebhook(w http.ResponseWriter, r *http.Request) {
	routeProjectKey := normalizeTidioProjectPublicKey(chi.URLParam(r, "project_public_key"))
	routeWebhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "tidio webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read tidio webhook body")
		return
	}
	raw := tidioWebhookRaw(body)
	if raw == nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "tidio webhook payload must be a JSON object")
		return
	}
	bodyProjectKey := tidioWebhookProjectPublicKey(raw)
	if routeProjectKey != "" && bodyProjectKey != "" && bodyProjectKey != routeProjectKey {
		httperror.Write(w, http.StatusBadRequest, "project_mismatch", "tidio webhook project_public_key does not match route")
		return
	}
	projectKey := normalizeTidioProjectPublicKey(firstString(routeProjectKey, bodyProjectKey))
	if projectKey == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_project_public_key", "tidio project_public_key is required")
		return
	}
	webhookID := firstString(routeWebhookID, tidioWebhookConfiguredID(raw))
	store, ok := d.Repo.(TidioWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "tidio webhook lookup is not configured")
		return
	}
	integration, err := store.FindTidioIntegrationByProject(r.Context(), projectKey, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "tidio integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret, err := d.tidioWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyTidioWebhookSignature(body, r.Header.Get("x-tidio-signature"), secret); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := tidioWebhookTopic(raw)
	deliveryID := tidioWebhookDeliveryID(projectKey, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderTidio, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.tidioWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if tidioRefreshMissing(err) {
			if fallback, ok := tidioDirectWebhookRequest(raw, body, webhookID, topic); ok {
				req = fallback
			} else {
				if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderTidio, deliveryID); markErr != nil {
					httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
					return
				}
				writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
				return
			}
		} else {
			_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderTidio, deliveryID, err)
			writeTidioRefreshError(w, err)
			return
		}
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderTidio, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderTidio, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "tidio webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderTidio, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderTidio, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) tidioWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.TidioBackfiller.(TidioConversationRefresher)
	if refresher != nil {
		if ticketID := tidioWebhookTicketID(raw); ticketID != "" {
			req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ticketID)
			if err != nil {
				return SyncRequest{}, err
			}
			return tidioWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
		if contactID := tidioWebhookContactID(raw); contactID != "" {
			req, err := refresher.RefreshContactConversation(ctx, integration.TenantID, *integration, contactID)
			if err != nil {
				return SyncRequest{}, err
			}
			return tidioWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := tidioDirectWebhookRequest(raw, body, webhookID, topic); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func tidioDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, bool) {
	req, ok := mapSupportWebhook(ProviderTidio, body)
	if !ok {
		return SyncRequest{}, false
	}
	return tidioWebhookAnnotateRequest(req, raw, body, webhookID, topic), true
}

func tidioWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "tidio-webhook-" + firstString(tidioWebhookTicketID(raw), tidioWebhookContactID(raw), tidioWebhookLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["tidio_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["tidio_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["tidio_project_public_key"] = tidioWebhookProjectPublicKey(raw)
		in.Tickets[i].Properties["tidio_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["tidio_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["tidio_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["tidio_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func (d *Deps) tidioWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingTidioWebhookSecret
	}
	if secret := strings.TrimSpace(firstString(
		settingString(integration.Settings, "tidio_webhook_secret"),
		settingString(integration.Settings, "webhook_secret"),
	)); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "tidio_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
	))
	if ref == "" {
		return "", ErrMissingTidioWebhookSecret
	}
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingTidioWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingTidioWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyTidioWebhookSignature(body []byte, header, secret string) error {
	timestamp, signatures, err := parseTidioSignatureHeader(header)
	if err != nil {
		return err
	}
	payload := append(append([]byte{}, body...), '_')
	payload = append(payload, timestamp...)
	mac := hmac.New(sha256.New, []byte(strings.TrimSpace(secret)))
	if _, err := mac.Write(payload); err != nil {
		return err
	}
	expected := hex.EncodeToString(mac.Sum(nil))
	for _, sig := range signatures {
		if subtle.ConstantTimeCompare([]byte(expected), []byte(strings.ToLower(sig))) == 1 {
			return nil
		}
	}
	return fmt.Errorf("tidio signature mismatch")
}

func parseTidioSignatureHeader(header string) ([]byte, []string, error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return nil, nil, fmt.Errorf("tidio signature is required")
	}
	var timestamp string
	signatures := []string{}
	for _, item := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(item), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "t":
			timestamp = strings.TrimSpace(value)
		case "s":
			signature := strings.ToLower(strings.TrimSpace(value))
			if signature != "" {
				signatures = append(signatures, signature)
			}
		}
	}
	if timestamp == "" {
		return nil, nil, fmt.Errorf("tidio signature timestamp is required")
	}
	if _, err := strconv.ParseInt(timestamp, 10, 64); err != nil {
		return nil, nil, fmt.Errorf("tidio signature timestamp is invalid")
	}
	if len(signatures) == 0 {
		return nil, nil, fmt.Errorf("tidio signature value is required")
	}
	return []byte(timestamp), signatures, nil
}

func tidioRefreshMissing(err error) bool {
	var restErr TidioRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeTidioRefreshError(w http.ResponseWriter, err error) {
	var restErr TidioRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "tidio_refresh_failed", httperror.MessageInternal)
}

func tidioWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil
	}
	return raw
}

func tidioWebhookProjectPublicKey(raw map[string]any) string {
	return normalizeTidioProjectPublicKey(firstString(
		supportWebhookString(raw, "project_public_key"),
		supportWebhookString(raw, "project", "public_key"),
	))
}

func tidioWebhookConfiguredID(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "webhook_id"),
		supportWebhookString(raw, "id"),
	))
}

func tidioWebhookTopic(raw map[string]any) string {
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "topic"),
		supportWebhookString(raw, "event"),
		supportWebhookString(raw, "type"),
	))
}

func tidioWebhookTicketID(raw map[string]any) string {
	topic := strings.ToLower(tidioWebhookTopic(raw))
	if !strings.HasPrefix(topic, "ticket.") {
		return ""
	}
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "content", "ticket_id"),
		supportWebhookString(raw, "content", "ticket", "id"),
		supportWebhookString(raw, "content", "id"),
		supportWebhookString(raw, "ticket_id"),
		supportWebhookString(raw, "ticket", "id"),
	))
}

func tidioWebhookContactID(raw map[string]any) string {
	topic := strings.ToLower(tidioWebhookTopic(raw))
	if strings.HasPrefix(topic, "ticket.") {
		return strings.TrimSpace(firstString(
			supportWebhookString(raw, "content", "contact_id"),
			supportWebhookString(raw, "content", "contact", "id"),
			supportWebhookString(raw, "contact_id"),
		))
	}
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "content", "contact_id"),
		supportWebhookString(raw, "content", "contact", "id"),
		supportWebhookString(raw, "content", "id"),
		supportWebhookString(raw, "contact_id"),
		supportWebhookString(raw, "contact", "id"),
	))
}

func tidioWebhookDeliveryID(projectPublicKey, webhookID string, raw map[string]any, body []byte) string {
	return strings.Join([]string{
		normalizeTidioProjectPublicKey(projectPublicKey),
		strings.TrimSpace(firstString(webhookID, tidioWebhookConfiguredID(raw))),
		tidioWebhookTopic(raw),
		tidioWebhookLocalHash(body),
	}, ":")
}

func tidioWebhookLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:8])
}

func normalizeTidioProjectPublicKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
