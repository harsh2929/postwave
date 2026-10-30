// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"bytes"
	"context"
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

var (
	ErrMissingDriftWebhookToken = errors.New("drift webhook verification token is required")
	ErrInvalidDriftWebhookToken = errors.New("invalid drift webhook verification token")
)

type DriftWebhookStore interface {
	FindDriftIntegrationByWorkspace(ctx context.Context, workspaceID, webhookID string) (*Integration, error)
}

// DriftWebhook receives Drift app webhook deliveries scoped to a workspace/org.
// Drift includes the same verification token in the JSON body and
// X-Verification-Token header.
func (d *Deps) DriftWebhook(w http.ResponseWriter, r *http.Request) {
	workspaceID := strings.TrimSpace(chi.URLParam(r, "workspace_id"))
	if workspaceID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_workspace_id", "drift workspace id is required")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "drift payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read drift webhook body")
		return
	}
	raw := driftWebhookRaw(body)
	if raw == nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "drift webhook payload must be a JSON object")
		return
	}
	if !driftWebhookWorkspaceMatches(workspaceID, raw) {
		httperror.Write(w, http.StatusBadRequest, "workspace_mismatch", "drift webhook org does not match route")
		return
	}
	store, ok := d.Repo.(DriftWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "drift webhook lookup is not configured")
		return
	}
	webhookID := driftWebhookID(r)
	integration, err := store.FindDriftIntegrationByWorkspace(r.Context(), workspaceID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "drift integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret, err := d.driftWebhookToken(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "request authentication failed")
		return
	}
	if err := VerifyDriftWebhookToken(secret, driftWebhookTokenValue(r, raw)); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_token", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	topic := driftWebhookTopicFromRaw(raw)
	deliveryID := driftWebhookDeliveryID(r, workspaceID, webhookID, raw, body)
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderDrift, deliveryID, topic, body)
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
	req, ok := mapDriftWebhook(body, *integration, webhookID)
	if !ok {
		conversationID := driftConversationIDFromRaw(raw)
		if conversationID != "" {
			refreshed, refreshedOK, err := d.refreshDriftWebhookConversation(r.Context(), integration, conversationID, body, webhookID, topic)
			if err != nil {
				if driftRefreshConversationMissing(err) {
					if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderDrift, deliveryID); err != nil {
						httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
						return
					}
					writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "reason": "conversation_not_found"})
					return
				}
				_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderDrift, deliveryID, err)
				writeDriftRefreshError(w, err)
				return
			}
			if refreshedOK {
				req = refreshed
				ok = true
			}
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderDrift, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderDrift, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "drift webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderDrift, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderDrift, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) refreshDriftWebhookConversation(ctx context.Context, integration *Integration, conversationID string, body []byte, webhookID, topic string) (SyncRequest, bool, error) {
	refresher, ok := d.DriftBackfiller.(DriftConversationRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("drift conversation refresh is not configured")
	}
	req, err := refresher.RefreshConversation(ctx, integration.TenantID, *integration, conversationID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req = driftWebhookRefreshRequest(req, body, webhookID, topic)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func driftWebhookRefreshRequest(in SyncRequest, body []byte, webhookID, topic string) SyncRequest {
	raw := driftWebhookScrubbedRaw(driftWebhookRaw(body))
	conversationID := driftConversationIDFromRaw(raw)
	in.RunMode = "webhook"
	in.Cursor = "drift-webhook-" + firstString(conversationID, driftWebhookLocalID(body))
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["drift_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["drift_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["drift_refresh_source"] = "webhook_sparse_conversation"
		in.Tickets[i].Properties["drift_raw"] = raw
	}
	return normalizeSyncRequest(in)
}

func driftRefreshConversationMissing(err error) bool {
	var restErr DriftRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeDriftRefreshError(w http.ResponseWriter, err error) {
	var restErr DriftRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "drift_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) driftWebhookToken(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingDriftWebhookToken
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "drift_webhook_secret_ref"),
		settingString(integration.Settings, "drift_webhook_token_ref"),
		settingString(integration.Settings, "drift_verification_token_ref"),
		settingString(integration.Settings, "webhook_auth_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingDriftWebhookToken
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingDriftWebhookToken
	}
	return strings.TrimSpace(secret), nil
}

func VerifyDriftWebhookToken(secret, got string) error {
	secret = strings.TrimSpace(secret)
	got = strings.TrimSpace(got)
	if secret == "" || got == "" {
		return ErrMissingDriftWebhookToken
	}
	if subtle.ConstantTimeCompare([]byte(secret), []byte(got)) == 1 {
		return nil
	}
	return ErrInvalidDriftWebhookToken
}

func mapDriftWebhook(body []byte, _ Integration, webhookID string) (SyncRequest, bool) {
	raw := driftWebhookRaw(body)
	if raw == nil {
		return SyncRequest{}, false
	}
	data := driftWebhookData(raw)
	conversationID := driftConversationIDFromRaw(raw)
	email := strings.ToLower(strings.TrimSpace(driftWebhookEmail(raw)))
	if conversationID == "" || email == "" {
		return SyncRequest{}, false
	}
	topic := driftWebhookTopicFromRaw(raw)
	name := driftWebhookName(raw)
	ticket := TicketInput{
		SourceID:       "drift://conversation/" + conversationID,
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  name,
		Status:         firstString(driftWebhookString(data, "status"), "open"),
		Properties: map[string]any{
			"drift_conversation_id": conversationID,
			"drift_webhook_id":      strings.TrimSpace(webhookID),
			"drift_webhook_event":   topic,
			"drift_org_id":          driftWebhookOrgID(raw),
			"drift_raw":             driftWebhookScrubbedRaw(raw),
		},
	}
	if t := driftWebhookOccurredAt(raw); t != nil {
		ticket.UpdatedAt = t
	}
	messages := driftWebhookMessages(raw, conversationID, email, name, webhookID, topic)
	req := SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Messages: messages, Cursor: "drift-webhook-" + firstString(driftWebhookEventID(raw), conversationID, driftWebhookLocalID(body))}
	return normalizeSyncRequest(req), true
}

func driftWebhookMessages(raw map[string]any, conversationID, email, requesterName, webhookID, topic string) []MessageInput {
	if topic != "new_message" && topic != "new_command_message" {
		return nil
	}
	data := driftWebhookData(raw)
	bodyText := strings.TrimSpace(firstString(
		driftWebhookString(data, "body"),
		driftWebhookString(data, "text"),
		driftWebhookString(data, "message"),
		driftWebhookString(data, "content"),
	))
	if bodyText == "" {
		return nil
	}
	messageID := firstString(
		driftWebhookString(data, "id"),
		driftWebhookString(data, "messageId"),
		driftWebhookString(data, "message_id"),
		driftWebhookEventID(raw),
	)
	direction := "inbound"
	senderType := "customer"
	authorType := strings.ToLower(firstString(
		driftWebhookString(data, "author", "type"),
		driftWebhookString(data, "authorType"),
		driftWebhookString(data, "userType"),
		driftWebhookString(data, "type"),
	))
	if authorType == "user" || authorType == "agent" || authorType == "bot" {
		direction = "outbound"
		senderType = firstString(authorType, "agent")
	}
	message := MessageInput{
		SourceID:       "drift://message/" + firstString(messageID, conversationID+"-"+driftWebhookLocalIDString(bodyText)),
		ConversationID: conversationID,
		Email:          email,
		RequesterName:  requesterName,
		Direction:      direction,
		SenderType:     senderType,
		Sender: firstString(
			driftWebhookString(data, "author", "name"),
			driftWebhookString(data, "user", "name"),
			requesterName,
		),
		BodyText: bodyText,
		Properties: map[string]any{
			"drift_message_id":      messageID,
			"drift_webhook_id":      strings.TrimSpace(webhookID),
			"drift_webhook_event":   topic,
			"drift_conversation_id": conversationID,
		},
	}
	if t := driftWebhookOccurredAt(raw); t != nil {
		message.OccurredAt = t
	}
	return []MessageInput{message}
}

func driftWebhookRaw(body []byte) map[string]any {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil
	}
	return raw
}

func driftWebhookData(raw map[string]any) map[string]any {
	if raw == nil {
		return nil
	}
	if data, ok := raw["data"].(map[string]any); ok {
		return data
	}
	return nil
}

func driftWebhookScrubbedRaw(raw map[string]any) map[string]any {
	if raw == nil {
		return nil
	}
	out := make(map[string]any, len(raw))
	for k, v := range raw {
		if strings.EqualFold(k, "token") {
			out[k] = "redacted"
			continue
		}
		out[k] = v
	}
	return out
}

func driftWebhookTopic(body []byte) string {
	return driftWebhookTopicFromRaw(driftWebhookRaw(body))
}

func driftWebhookTopicFromRaw(raw map[string]any) string {
	return strings.TrimSpace(driftWebhookString(raw, "type"))
}

func driftConversationIDFromWebhook(body []byte) string {
	return driftConversationIDFromRaw(driftWebhookRaw(body))
}

func driftConversationIDFromRaw(raw map[string]any) string {
	data := driftWebhookData(raw)
	topic := driftWebhookTopicFromRaw(raw)
	return firstString(
		driftWebhookString(data, "conversationId"),
		driftWebhookString(data, "conversation_id"),
		driftWebhookString(data, "conversation", "id"),
		driftWebhookString(data, "conversation", "conversationId"),
		func() string {
			if topic == "new_conversation" {
				return driftWebhookString(data, "id")
			}
			return ""
		}(),
	)
}

func driftWebhookEmail(raw map[string]any) string {
	data := driftWebhookData(raw)
	return firstString(
		driftWebhookString(data, "contact", "email"),
		driftWebhookString(data, "contact", "attributes", "email"),
		driftWebhookString(data, "visitor", "email"),
		driftWebhookString(data, "email"),
		driftWebhookString(data, "attributes", "email"),
	)
}

func driftWebhookName(raw map[string]any) string {
	data := driftWebhookData(raw)
	name := firstString(
		driftWebhookString(data, "contact", "name"),
		driftWebhookString(data, "contact", "attributes", "name"),
		driftWebhookString(data, "visitor", "name"),
		driftWebhookString(data, "name"),
		driftWebhookString(data, "attributes", "name"),
	)
	if name != "" {
		return name
	}
	return strings.TrimSpace(firstString(
		strings.TrimSpace(driftWebhookString(data, "firstName")+" "+driftWebhookString(data, "lastName")),
		strings.TrimSpace(driftWebhookString(data, "attributes", "first_name")+" "+driftWebhookString(data, "attributes", "last_name")),
	))
}

func driftWebhookOccurredAt(raw map[string]any) *time.Time {
	data := driftWebhookData(raw)
	rawTime := firstString(
		driftWebhookString(data, "createdAt"),
		driftWebhookString(data, "updatedAt"),
		driftWebhookString(data, "lastUpdated"),
		driftWebhookString(data, "changedAt"),
		driftWebhookString(data, "pushedAt"),
		driftWebhookString(raw, "createdAt"),
	)
	if rawTime == "" {
		return nil
	}
	if ms, err := strconv.ParseInt(rawTime, 10, 64); err == nil {
		t := time.Unix(ms/1000, 0).UTC()
		return &t
	}
	if t, err := time.Parse(time.RFC3339, rawTime); err == nil {
		u := t.UTC()
		return &u
	}
	return nil
}

func driftWebhookWorkspaceMatches(workspaceID string, raw map[string]any) bool {
	workspaceID = strings.TrimSpace(workspaceID)
	orgID := driftWebhookOrgID(raw)
	return workspaceID != "" && orgID != "" && workspaceID == orgID
}

func driftWebhookOrgID(raw map[string]any) string {
	return firstString(
		driftWebhookString(raw, "orgId"),
		driftWebhookString(raw, "org_id"),
		driftWebhookString(raw, "organizationId"),
	)
}

func driftWebhookTokenValue(r *http.Request, raw map[string]any) string {
	return firstString(
		r.Header.Get("X-Verification-Token"),
		r.Header.Get("X-Drift-Verification-Token"),
		driftWebhookString(raw, "token"),
	)
}

func driftWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-Drift-Webhook-Id"),
		r.Header.Get("X-Drift-Webhook-ID"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("drift_webhook_id"),
	))
}

func driftWebhookDeliveryID(r *http.Request, workspaceID, webhookID string, raw map[string]any, body []byte) string {
	return "drift:" + firstString(
		r.Header.Get("X-Drift-Event-Id"),
		r.Header.Get("X-Drift-Event-ID"),
		r.Header.Get("X-Drift-Request-Id"),
		r.Header.Get("X-Request-Id"),
		driftWebhookEventID(raw),
		strings.TrimSpace(workspaceID)+":"+strings.TrimSpace(webhookID)+":"+driftWebhookTopicFromRaw(raw)+":"+driftWebhookLocalID(body),
	)
}

func driftWebhookEventID(raw map[string]any) string {
	data := driftWebhookData(raw)
	return firstString(
		driftWebhookString(raw, "eventId"),
		driftWebhookString(raw, "event_id"),
		driftWebhookString(data, "eventId"),
		driftWebhookString(data, "event_id"),
		driftWebhookString(data, "id"),
		func() string {
			conversationID := driftConversationIDFromRaw(raw)
			topic := driftWebhookTopicFromRaw(raw)
			occurred := ""
			if t := driftWebhookOccurredAt(raw); t != nil {
				occurred = strconv.FormatInt(t.UnixMilli(), 10)
			}
			if conversationID != "" && topic != "" && occurred != "" {
				return conversationID + ":" + topic + ":" + occurred
			}
			return ""
		}(),
	)
}

func driftWebhookLocalID(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:16])
}

func driftWebhookLocalIDString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

func driftWebhookString(node map[string]any, path ...string) string {
	var current any = node
	for _, key := range path {
		obj, ok := current.(map[string]any)
		if !ok {
			return ""
		}
		current = obj[key]
	}
	switch v := current.(type) {
	case string:
		return strings.TrimSpace(v)
	case json.Number:
		return strings.TrimSpace(v.String())
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case bool:
		return strconv.FormatBool(v)
	default:
		return ""
	}
}
