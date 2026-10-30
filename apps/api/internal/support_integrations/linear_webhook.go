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
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

const linearWebhookMaxSkew = 60 * time.Second

var (
	ErrMissingLinearWebhookSignature = errors.New("linear webhook signature is required")
	ErrInvalidLinearWebhookSignature = errors.New("linear webhook signature mismatch")
	ErrMissingLinearWebhookSecret    = errors.New("linear webhook signing secret is required")
	ErrStaleLinearWebhookTimestamp   = errors.New("linear webhook timestamp is outside the accepted window")
)

type LinearWebhookStore interface {
	FindLinearIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error)
}

func (d *Deps) LinearWebhook(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(chi.URLParam(r, "workspace_id"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	store, ok := d.Repo.(LinearWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "linear webhook lookup is not configured")
		return
	}
	integration, err := store.FindLinearIntegrationByWorkspace(r.Context(), workspaceID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "linear integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "linear webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read linear webhook body")
		return
	}
	signingSecret, err := d.linearWebhookSigningSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifyLinearWebhookSignature(signingSecret, body, r.Header.Get("Linear-Signature")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	now := time.Now().UTC()
	if d.Now != nil {
		now = d.Now().UTC()
	}
	if err := VerifyLinearWebhookTimestamp(firstString(r.Header.Get("Linear-Timestamp"), r.Header.Get("linear-timestamp")), now); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_timestamp", "request authentication failed")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "linear webhook payload must be a JSON object")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "linear webhook idempotency is not configured")
		return
	}
	topic := firstString(r.Header.Get("Linear-Event"), linearWebhookTopic(raw))
	deliveryID := linearWebhookDeliveryID(workspaceID, webhookID, raw, body, r.Header.Get("Linear-Delivery"))
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderLinear, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.linearWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if linearRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderLinear, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderLinear, deliveryID, err)
		writeLinearRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderLinear, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderLinear, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "linear webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderLinear, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderLinear, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) linearWebhookSigningSecret(ctx context.Context, integration *Integration) (string, error) {
	if integration == nil {
		return "", ErrMissingLinearWebhookSecret
	}
	if secret := strings.TrimSpace(firstString(
		settingString(integration.Settings, "linear_webhook_secret"),
		settingString(integration.Settings, "webhook_secret"),
	)); secret != "" {
		return secret, nil
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "linear_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
	))
	if ref == "" || d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingLinearWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingLinearWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyLinearWebhookSignature(secret string, body []byte, signature string) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingLinearWebhookSecret
	}
	signature = strings.TrimSpace(strings.ToLower(signature))
	if signature == "" {
		return ErrMissingLinearWebhookSignature
	}
	signature = strings.TrimPrefix(signature, "sha256=")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return ErrInvalidLinearWebhookSignature
	}
	return nil
}

func VerifyLinearWebhookTimestamp(raw string, now time.Time) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var at time.Time
	if unix, err := strconv.ParseInt(raw, 10, 64); err == nil {
		at = time.Unix(unix, 0).UTC()
	} else if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		at = parsed.UTC()
	} else {
		return ErrStaleLinearWebhookTimestamp
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if at.Before(now.Add(-linearWebhookMaxSkew)) || at.After(now.Add(linearWebhookMaxSkew)) {
		return ErrStaleLinearWebhookTimestamp
	}
	return nil
}

func (d *Deps) linearWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.LinearBackfiller.(LinearIssueRefresher)
	if refresher != nil {
		if issueID := linearWebhookIssueID(raw); issueID != "" {
			req, err := refresher.RefreshIssue(ctx, integration.TenantID, *integration, issueID)
			if err != nil {
				return SyncRequest{}, err
			}
			return linearWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := linearDirectWebhookRequest(raw, body, webhookID, topic, *integration); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func linearDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string, integration Integration) (SyncRequest, bool) {
	data := firstMap(linearWebhookMap(raw, "data"), linearWebhookMap(raw, "issue"))
	if data == nil {
		return SyncRequest{}, false
	}
	issue := linearIssueFromWebhook(data)
	ticket, ok := mapLinearIssue(issue, integration)
	if !ok {
		return SyncRequest{}, false
	}
	return linearWebhookAnnotateRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Cursor: "linear-webhook-" + firstString(ticket.ConversationID, linearLocalHash(body))}, raw, body, webhookID, topic), true
}

func linearWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "linear-webhook-" + firstString(linearWebhookIssueID(raw), linearLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["linear_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["linear_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["linear_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["linear_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["linear_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["linear_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func linearWebhookTopic(raw map[string]any) string {
	return firstString(linearWebhookString(raw, "type"), linearWebhookString(raw, "action"), linearWebhookString(raw, "event"))
}

func linearWebhookIssueID(raw map[string]any) string {
	return firstString(
		linearWebhookString(raw, "data", "id"),
		linearWebhookString(raw, "data", "issue", "id"),
		linearWebhookString(raw, "issue", "id"),
		linearWebhookString(raw, "id"),
	)
}

func linearWebhookDeliveryID(workspaceID, webhookID string, raw map[string]any, body []byte, deliveryID string) string {
	return "linear:" + strings.Join(cleanStrings([]string{
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(webhookID),
		strings.TrimSpace(deliveryID),
		linearWebhookString(raw, "webhookTimestamp"),
		linearWebhookTopic(raw),
		linearWebhookIssueID(raw),
		linearLocalHash(body),
	}), ":")
}

func linearLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func linearRefreshMissing(err error) bool {
	var restErr LinearRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeLinearRefreshError(w http.ResponseWriter, err error) {
	var restErr LinearRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "linear_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "linear_refresh_failed", httperror.MessageInternal)
}

func linearIssueFromWebhook(raw map[string]any) linearIssue {
	return linearIssue{
		ID:          linearWebhookString(raw, "id"),
		Identifier:  firstString(linearWebhookString(raw, "identifier"), linearWebhookString(raw, "key")),
		Title:       linearWebhookString(raw, "title"),
		Description: linearWebhookString(raw, "description"),
		URL:         linearWebhookString(raw, "url"),
		CreatedAt:   linearWebhookString(raw, "createdAt"),
		UpdatedAt:   linearWebhookString(raw, "updatedAt"),
		Team:        linearNamedRef{ID: linearWebhookString(raw, "team", "id"), Key: linearWebhookString(raw, "team", "key"), Name: linearWebhookString(raw, "team", "name")},
		State:       linearNamedRef{ID: linearWebhookString(raw, "state", "id"), Name: linearWebhookString(raw, "state", "name"), Type: linearWebhookString(raw, "state", "type")},
		Assignee:    linearUser{ID: linearWebhookString(raw, "assignee", "id"), Name: linearWebhookString(raw, "assignee", "name"), DisplayName: linearWebhookString(raw, "assignee", "displayName"), Email: linearWebhookString(raw, "assignee", "email")},
		Creator:     linearUser{ID: linearWebhookString(raw, "creator", "id"), Name: linearWebhookString(raw, "creator", "name"), DisplayName: linearWebhookString(raw, "creator", "displayName"), Email: linearWebhookString(raw, "creator", "email")},
	}
}

func linearWebhookString(raw map[string]any, path ...string) string {
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

func linearWebhookMap(raw map[string]any, path ...string) map[string]any {
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
