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
	ErrMissingAsanaWebhookSignature = errors.New("asana webhook signature is required")
	ErrInvalidAsanaWebhookSignature = errors.New("asana webhook signature mismatch")
	ErrMissingAsanaWebhookSecret    = errors.New("asana webhook secret is required")
)

type AsanaSupportWebhookStore interface {
	FindAsanaSupportIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error)
}

func (d *Deps) AsanaSupportWebhook(w http.ResponseWriter, r *http.Request) {
	if hookSecret := strings.TrimSpace(r.Header.Get("X-Hook-Secret")); hookSecret != "" && strings.TrimSpace(r.Header.Get("X-Hook-Signature")) == "" {
		w.Header().Set("X-Hook-Secret", hookSecret)
		w.WriteHeader(http.StatusOK)
		return
	}
	workspaceID := strings.TrimSpace(chi.URLParam(r, "workspace_id"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	store, ok := d.Repo.(AsanaSupportWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "asana support webhook lookup is not configured")
		return
	}
	integration, err := store.FindAsanaSupportIntegrationByWorkspace(r.Context(), workspaceID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "asana support integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "asana support webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read asana support webhook body")
		return
	}
	secret, err := d.asanaSupportWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyAsanaWebhookSignature(secret, body, r.Header.Get("X-Hook-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "asana support webhook payload must be a JSON object")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "asana support webhook idempotency is not configured")
		return
	}
	topic := asanaWebhookTopic(raw)
	deliveryID := asanaWebhookDeliveryID(workspaceID, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderAsanaSupport, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.asanaWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if asanaRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderAsanaSupport, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderAsanaSupport, deliveryID, err)
		writeAsanaRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderAsanaSupport, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderAsanaSupport, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "asana support webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderAsanaSupport, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderAsanaSupport, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) asanaSupportWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingAsanaWebhookSecret
	}
	if secret := strings.TrimSpace(firstString(settingString(integration.Settings, "asana_webhook_secret"), settingString(integration.Settings, "webhook_secret"))); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "asana_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
	))
	if ref == "" || d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingAsanaWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingAsanaWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyAsanaWebhookSignature(secret string, body []byte, signature string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingAsanaWebhookSecret
	}
	signature = strings.TrimSpace(strings.ToLower(signature))
	if signature == "" {
		return ErrMissingAsanaWebhookSignature
	}
	signature = strings.TrimPrefix(signature, "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return ErrInvalidAsanaWebhookSignature
	}
	return nil
}

func (d *Deps) asanaWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.AsanaSupportBackfiller.(AsanaSupportTaskRefresher)
	if refresher != nil {
		if taskID := asanaWebhookTaskID(raw); taskID != "" {
			req, err := refresher.RefreshTask(ctx, integration.TenantID, *integration, taskID)
			if err != nil {
				return SyncRequest{}, err
			}
			return asanaWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func asanaWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "asana-support-webhook-" + firstString(asanaWebhookTaskID(raw), asanaLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["asana_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["asana_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["asana_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["asana_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["asana_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["asana_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func asanaWebhookTopic(raw map[string]any) string {
	events := asanaWebhookSlice(raw, "events")
	if len(events) > 0 {
		return firstString(
			asanaWebhookString(events[0], "resource", "resource_type")+"."+asanaWebhookString(events[0], "action"),
			asanaWebhookString(events[0], "action"),
		)
	}
	return firstString(asanaWebhookString(raw, "action"), asanaWebhookString(raw, "type"))
}

func asanaWebhookTaskID(raw map[string]any) string {
	events := asanaWebhookSlice(raw, "events")
	for _, event := range events {
		if gid := firstString(asanaWebhookString(event, "resource", "gid"), asanaWebhookString(event, "parent", "gid")); gid != "" {
			return gid
		}
	}
	return firstString(asanaWebhookString(raw, "resource", "gid"), asanaWebhookString(raw, "task", "gid"), asanaWebhookString(raw, "gid"))
}

func asanaWebhookDeliveryID(workspaceID, webhookID string, raw map[string]any, body []byte) string {
	return "asana-support:" + strings.Join(cleanStrings([]string{
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(webhookID),
		asanaWebhookTopic(raw),
		asanaWebhookTaskID(raw),
		asanaLocalHash(body),
	}), ":")
}

func asanaLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func asanaRefreshMissing(err error) bool {
	var restErr AsanaSupportRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeAsanaRefreshError(w http.ResponseWriter, err error) {
	var restErr AsanaSupportRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "asana_support_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "asana_support_refresh_failed", httperror.MessageInternal)
}

func asanaWebhookString(raw map[string]any, path ...string) string {
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

func asanaWebhookSlice(raw map[string]any, key string) []map[string]any {
	values, _ := raw[key].([]any)
	out := []map[string]any{}
	for _, value := range values {
		if m, ok := value.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}
