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

var (
	ErrMissingClickUpWebhookSignature = errors.New("clickup webhook signature is required")
	ErrInvalidClickUpWebhookSignature = errors.New("clickup webhook signature mismatch")
	ErrMissingClickUpWebhookSecret    = errors.New("clickup webhook secret is required")
)

type ClickUpSupportWebhookStore interface {
	FindClickUpSupportIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error)
}

func (d *Deps) ClickUpSupportWebhook(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(chi.URLParam(r, "workspace_id"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	store, ok := d.Repo.(ClickUpSupportWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "clickup support webhook lookup is not configured")
		return
	}
	integration, err := store.FindClickUpSupportIntegrationByWorkspace(r.Context(), workspaceID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "clickup support integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "clickup support webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read clickup support webhook body")
		return
	}
	secret, err := d.clickUpSupportWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyClickUpWebhookSignature(secret, body, r.Header.Get("X-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "clickup support webhook payload must be a JSON object")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "clickup support webhook idempotency is not configured")
		return
	}
	topic := clickUpWebhookTopic(raw)
	deliveryID := clickUpWebhookDeliveryID(workspaceID, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderClickUpSupport, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.clickUpWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if clickUpRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderClickUpSupport, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderClickUpSupport, deliveryID, err)
		writeClickUpRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderClickUpSupport, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderClickUpSupport, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "clickup support webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderClickUpSupport, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderClickUpSupport, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) clickUpSupportWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingClickUpWebhookSecret
	}
	if secret := strings.TrimSpace(firstString(settingString(integration.Settings, "clickup_webhook_secret"), settingString(integration.Settings, "webhook_secret"))); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "clickup_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
	))
	if ref == "" || d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingClickUpWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingClickUpWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyClickUpWebhookSignature(secret string, body []byte, signature string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingClickUpWebhookSecret
	}
	signature = strings.TrimSpace(strings.ToLower(signature))
	if signature == "" {
		return ErrMissingClickUpWebhookSignature
	}
	signature = strings.TrimPrefix(signature, "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return ErrInvalidClickUpWebhookSignature
	}
	return nil
}

func (d *Deps) clickUpWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.ClickUpSupportBackfiller.(ClickUpSupportTaskRefresher)
	if refresher != nil {
		if taskID := clickUpWebhookTaskID(raw); taskID != "" {
			req, err := refresher.RefreshTask(ctx, integration.TenantID, *integration, taskID)
			if err != nil {
				return SyncRequest{}, err
			}
			return clickUpWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func clickUpWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "clickup-support-webhook-" + firstString(clickUpWebhookTaskID(raw), clickUpLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["clickup_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["clickup_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["clickup_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["clickup_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["clickup_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["clickup_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func clickUpWebhookTopic(raw map[string]any) string {
	return firstString(clickUpWebhookString(raw, "event"), clickUpWebhookString(raw, "type"), clickUpWebhookString(raw, "history_items", "0", "field"))
}

func clickUpWebhookTaskID(raw map[string]any) string {
	return firstString(
		clickUpWebhookString(raw, "task_id"),
		clickUpWebhookString(raw, "task", "id"),
		clickUpWebhookString(raw, "data", "task_id"),
		clickUpWebhookString(raw, "history_items", "0", "parent_id"),
	)
}

func clickUpWebhookDeliveryID(workspaceID, webhookID string, raw map[string]any, body []byte) string {
	return "clickup-support:" + strings.Join(cleanStrings([]string{
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(webhookID),
		clickUpWebhookString(raw, "webhook_id"),
		clickUpWebhookString(raw, "event"),
		clickUpWebhookTaskID(raw),
		clickUpLocalHash(body),
	}), ":")
}

func clickUpLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func clickUpRefreshMissing(err error) bool {
	var restErr ClickUpSupportRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeClickUpRefreshError(w http.ResponseWriter, err error) {
	var restErr ClickUpSupportRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "clickup_support_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "clickup_support_refresh_failed", httperror.MessageInternal)
}

func clickUpWebhookString(raw map[string]any, path ...string) string {
	if raw == nil {
		return ""
	}
	var cur any = raw
	for _, key := range path {
		if arr, ok := cur.([]any); ok {
			idx, err := strconv.Atoi(key)
			if err != nil || idx < 0 || idx >= len(arr) {
				return ""
			}
			cur = arr[idx]
			continue
		}
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
