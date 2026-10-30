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
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var ErrMissingKayakoWebhookToken = errors.New("kayako webhook route token is required")

type KayakoWebhookStore interface {
	FindKayakoIntegrationByDomain(ctx context.Context, accountDomain, webhookID string) (*Integration, error)
}

func (d *Deps) KayakoWebhook(w http.ResponseWriter, r *http.Request) {
	accountDomain := normalizeKayakoWebhookDomain(chi.URLParam(r, "account_domain"))
	if accountDomain == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_domain", "kayako account domain is required")
		return
	}
	webhookID := kayakoWebhookID(r)
	if webhookID == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "request authentication failed")
		return
	}
	store, ok := d.Repo.(KayakoWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "kayako webhook lookup is not configured")
		return
	}
	integration, err := store.FindKayakoIntegrationByDomain(r.Context(), accountDomain, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "kayako integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "kayako payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read kayako webhook body")
		return
	}
	caseID := kayakoWebhookCaseID(body)
	if caseID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_case_id", "kayako webhook case id is required")
		return
	}
	topic := kayakoWebhookTopic(body)
	deliveryID := kayakoWebhookDeliveryID(r, accountDomain, webhookID, caseID, topic, body)
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderKayako, deliveryID, topic, body)
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
	req, refreshed, err := d.refreshKayakoWebhookCase(r.Context(), integration, caseID, body, webhookID, topic)
	if err != nil {
		if kayakoRefreshCaseMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderKayako, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "case_not_found"})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderKayako, deliveryID, err)
		writeKayakoRefreshError(w, err)
		return
	}
	if !refreshed {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderKayako, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true})
		return
	}
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderKayako, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "kayako webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderKayako, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderKayako, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshKayakoWebhookCase(ctx context.Context, integration *Integration, caseID string, body []byte, webhookID, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.KayakoBackfiller.(KayakoCaseRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("kayako case refresh is not configured")
	}
	req, err := refresher.RefreshCase(ctx, integration.TenantID, *integration, caseID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = kayakoWebhookRefreshRequest(req, body, webhookID, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func kayakoWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	raw := map[string]any{}
	_ = json.Unmarshal(body, &raw)
	caseID := kayakoWebhookCaseID(body)
	in.RunMode = "webhook"
	in.Cursor = "kayako-webhook-" + firstString(caseID, kayakoWebhookPayloadHash(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["kayako_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["kayako_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["kayako_refresh_source"] = "webhook_sparse_case"
		in.Tickets[i].Properties["kayako_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["kayako_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["kayako_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func kayakoRefreshCaseMissing(err error) bool {
	var restErr KayakoRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeKayakoRefreshError(w http.ResponseWriter, err error) {
	var restErr KayakoRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "kayako_refresh_failed", httperror.MessageInternal)
}

func kayakoWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		chi.URLParam(r, "webhook_id"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("kayako_webhook_id"),
		r.URL.Query().Get("token"),
		r.Header.Get("X-Kayako-Webhook-Id"),
		r.Header.Get("X-Kayako-Webhook-ID"),
		r.Header.Get("X-Webhook-Id"),
		r.Header.Get("X-Webhook-ID"),
		r.Header.Get("X-Postwave-Webhook-Id"),
	))
}

func kayakoWebhookCaseID(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "case_id"),
		supportWebhookString(raw, "caseId"),
		supportWebhookString(raw, "case", "id"),
		supportWebhookString(raw, "case", "case_id"),
		supportWebhookString(raw, "conversation_id"),
		supportWebhookString(raw, "conversationId"),
		supportWebhookString(raw, "conversation", "id"),
		supportWebhookString(raw, "data", "case_id"),
		supportWebhookString(raw, "data", "id"),
		supportWebhookString(raw, "data", "case", "id"),
		supportWebhookString(raw, "payload", "case_id"),
		supportWebhookString(raw, "payload", "case", "id"),
		supportWebhookString(raw, "Case ID"),
		supportWebhookString(raw, "id"),
	))
}

func kayakoWebhookTopic(body []byte) string {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return "case.updated"
	}
	return strings.TrimSpace(firstString(
		supportWebhookString(raw, "event"),
		supportWebhookString(raw, "type"),
		supportWebhookString(raw, "action"),
		supportWebhookString(raw, "topic"),
		supportWebhookString(raw, "data", "event"),
		supportWebhookString(raw, "payload", "event"),
		"case.updated",
	))
}

func kayakoWebhookDeliveryID(r *http.Request, accountDomain, webhookID, caseID, topic string, body []byte) string {
	return "kayako:" + strings.Join([]string{
		normalizeKayakoWebhookDomain(accountDomain),
		strings.TrimSpace(webhookID),
		strings.TrimSpace(firstString(
			r.Header.Get("X-Kayako-Delivery-Id"),
			r.Header.Get("X-Kayako-Delivery-ID"),
			r.Header.Get("X-Webhook-Delivery"),
			r.URL.Query().Get("delivery_id"),
			caseID,
		)),
		strings.TrimSpace(topic),
		kayakoWebhookPayloadHash(body),
	}, ":")
}

func kayakoWebhookPayloadHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])[:24]
}

func normalizeKayakoWebhookDomain(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		if parsed, err := http.NewRequest(http.MethodGet, raw, nil); err == nil {
			raw = parsed.URL.Host
		}
	}
	raw = strings.Trim(strings.ToLower(raw), "/")
	raw = strings.TrimSuffix(raw, ".kayako.com")
	return raw
}
