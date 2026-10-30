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

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var ErrMissingJiraServiceManagementWebhookToken = errors.New("jira service management webhook route token is required")

type JiraServiceManagementWebhookStore interface {
	FindJiraServiceManagementIntegrationBySite(ctx context.Context, siteID, webhookID string) (*Integration, error)
}

func (d *Deps) JiraServiceManagementWebhook(w http.ResponseWriter, r *http.Request) {
	siteID := normalizeJiraServiceManagementSiteLookup(chi.URLParam(r, "site_id"))
	webhookID := strings.TrimSpace(chi.URLParam(r, "webhook_id"))
	if webhookID == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "request authentication failed")
		return
	}
	store, ok := d.Repo.(JiraServiceManagementWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "jira service management webhook lookup is not configured")
		return
	}
	integration, err := store.FindJiraServiceManagementIntegrationBySite(r.Context(), siteID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "jira service management integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "jira service management webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read jira service management webhook body")
		return
	}
	raw := map[string]any{}
	if err := json.Unmarshal(body, &raw); err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "jira service management webhook payload must be a JSON object")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "jira service management webhook idempotency is not configured")
		return
	}
	topic := jiraServiceWebhookTopic(raw)
	deliveryID := jiraServiceWebhookDeliveryID(siteID, webhookID, raw, body, r.Header.Get("X-Atlassian-Webhook-Identifier"))
	claim, err := claimStore.ClaimSupportWebhook(r.Context(), integration.TenantID, integration.ID, ProviderJiraServiceManagement, deliveryID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed || claim == WebhookInProgress {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "duplicate": true})
		return
	}
	req, err := d.jiraServiceWebhookSyncRequest(r.Context(), integration, raw, body, webhookID, topic)
	if err != nil {
		if jiraServiceRefreshMissing(err) {
			if markErr := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderJiraServiceManagement, deliveryID); markErr != nil {
				httperror.WriteInternal(w, d.Logger, markErr, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
				return
			}
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
			return
		}
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderJiraServiceManagement, deliveryID, err)
		writeJiraServiceRefreshError(w, err)
		return
	}
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderJiraServiceManagement, deliveryID); err != nil {
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
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderJiraServiceManagement, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "jira service management webhook processing failed"))
		_ = claimStore.MarkSupportWebhookFailed(r.Context(), integration.TenantID, ProviderJiraServiceManagement, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSupportWebhookProcessed(r.Context(), integration.TenantID, ProviderJiraServiceManagement, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) jiraServiceWebhookSyncRequest(ctx context.Context, integration *Integration, raw map[string]any, body []byte, webhookID, topic string) (SyncRequest, error) {
	refresher, _ := d.JiraServiceManagementBackfiller.(JiraServiceManagementRequestRefresher)
	if refresher != nil {
		if issue := jiraServiceWebhookIssueID(raw); issue != "" {
			req, err := refresher.RefreshRequest(ctx, integration.TenantID, *integration, issue)
			if err != nil {
				return SyncRequest{}, err
			}
			return jiraServiceWebhookAnnotateRequest(req, raw, body, webhookID, topic), nil
		}
	}
	if req, ok := jiraServiceDirectWebhookRequest(raw, body, webhookID, topic, *integration); ok {
		return req, nil
	}
	return SyncRequest{RunMode: "webhook"}, nil
}

func jiraServiceDirectWebhookRequest(raw map[string]any, body []byte, webhookID, topic string, integration Integration) (SyncRequest, bool) {
	issueRaw := firstMap(jiraServiceWebhookMap(raw, "issue"), jiraServiceWebhookMap(raw, "data", "issue"))
	if issueRaw == nil {
		return SyncRequest{}, false
	}
	request := jiraServiceRequestFromWebhook(issueRaw, raw)
	ticket, ok := mapJiraServiceRequest(request, integration)
	if !ok {
		return SyncRequest{}, false
	}
	return jiraServiceWebhookAnnotateRequest(SyncRequest{RunMode: "webhook", Tickets: []TicketInput{ticket}, Cursor: "jira-service-management-webhook-" + firstString(ticket.ConversationID, jiraServiceLocalHash(body))}, raw, body, webhookID, topic), true
}

func jiraServiceWebhookAnnotateRequest(in SyncRequest, raw map[string]any, body []byte, webhookID, topic string) SyncRequest {
	in.RunMode = "webhook"
	if strings.TrimSpace(in.Cursor) == "" {
		in.Cursor = "jira-service-management-webhook-" + firstString(jiraServiceWebhookIssueID(raw), jiraServiceLocalHash(body))
	}
	for i := range in.Tickets {
		if in.Tickets[i].Properties == nil {
			in.Tickets[i].Properties = map[string]any{}
		}
		in.Tickets[i].Properties["jira_service_management_webhook_id"] = strings.TrimSpace(webhookID)
		in.Tickets[i].Properties["jira_service_management_webhook_event"] = strings.TrimSpace(topic)
		in.Tickets[i].Properties["jira_service_management_refresh_source"] = "webhook_sparse"
		in.Tickets[i].Properties["jira_service_management_webhook_raw"] = raw
	}
	for i := range in.Messages {
		if in.Messages[i].Properties == nil {
			in.Messages[i].Properties = map[string]any{}
		}
		in.Messages[i].Properties["jira_service_management_webhook_id"] = strings.TrimSpace(webhookID)
		in.Messages[i].Properties["jira_service_management_webhook_event"] = strings.TrimSpace(topic)
	}
	return normalizeSyncRequest(in)
}

func jiraServiceWebhookTopic(raw map[string]any) string {
	return firstString(
		jiraServiceWebhookString(raw, "webhookEvent"),
		jiraServiceWebhookString(raw, "issue_event_type_name"),
		jiraServiceWebhookString(raw, "event"),
		jiraServiceWebhookString(raw, "type"),
	)
}

func jiraServiceWebhookIssueID(raw map[string]any) string {
	return firstString(
		jiraServiceWebhookString(raw, "issue", "key"),
		jiraServiceWebhookString(raw, "issue", "id"),
		jiraServiceWebhookString(raw, "issueKey"),
		jiraServiceWebhookString(raw, "issueId"),
		jiraServiceWebhookString(raw, "data", "issue", "key"),
		jiraServiceWebhookString(raw, "data", "issue", "id"),
	)
}

func jiraServiceWebhookDeliveryID(siteID, webhookID string, raw map[string]any, body []byte, atlassianID string) string {
	return "jira-service-management:" + strings.Join(cleanStrings([]string{
		strings.TrimSpace(siteID),
		strings.TrimSpace(webhookID),
		strings.TrimSpace(atlassianID),
		jiraServiceWebhookString(raw, "timestamp"),
		jiraServiceWebhookTopic(raw),
		jiraServiceWebhookIssueID(raw),
		jiraServiceLocalHash(body),
	}), ":")
}

func jiraServiceLocalHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:12])
}

func jiraServiceRefreshMissing(err error) bool {
	var restErr JiraServiceManagementRESTError
	return errors.As(err, &restErr) && restErr.StatusCode == http.StatusNotFound
}

func writeJiraServiceRefreshError(w http.ResponseWriter, err error) {
	var restErr JiraServiceManagementRESTError
	if errors.As(err, &restErr) {
		if restErr.RetryAfter > 0 {
			w.Header().Set("Retry-After", fmt.Sprintf("%.0f", restErr.RetryAfter.Seconds()))
		}
		httperror.Write(w, http.StatusBadGateway, "jira_service_management_refresh_failed", httperror.MessageInternal)
		return
	}
	httperror.Write(w, http.StatusBadGateway, "jira_service_management_refresh_failed", httperror.MessageInternal)
}

func jiraServiceRequestFromWebhook(issue map[string]any, raw map[string]any) jiraServiceRequest {
	fields := jiraServiceWebhookMap(issue, "fields")
	request := jiraServiceRequest{
		IssueID: strings.TrimSpace(jiraServiceWebhookString(issue, "id")),
		IssueKey: strings.TrimSpace(firstString(
			jiraServiceWebhookString(issue, "key"),
			jiraServiceWebhookString(raw, "issueKey"),
		)),
		Summary: firstString(jiraServiceWebhookString(fields, "summary"), jiraServiceWebhookString(issue, "summary")),
		Description: firstString(
			jiraServiceWebhookString(fields, "description"),
			jiraServiceWebhookString(issue, "description"),
		),
		Fields: fields,
	}
	request.Reporter = jiraServiceUser{
		AccountID:    jiraServiceWebhookString(fields, "reporter", "accountId"),
		DisplayName:  jiraServiceWebhookString(fields, "reporter", "displayName"),
		EmailAddress: jiraServiceWebhookString(fields, "reporter", "emailAddress"),
	}
	request.CurrentStatus.Status = jiraServiceWebhookString(fields, "status", "name")
	request.ServiceDeskID = firstString(jiraServiceWebhookString(fields, "serviceDeskId"), jiraServiceWebhookString(raw, "serviceDeskId"))
	request.RequestTypeID = firstString(jiraServiceWebhookString(fields, "requestTypeId"), jiraServiceWebhookString(raw, "requestTypeId"))
	request.Links.Web = jiraServiceWebhookString(issue, "self")
	return request
}

func normalizeJiraServiceManagementSiteLookup(site string) string {
	site = strings.ToLower(strings.TrimSpace(site))
	site = strings.TrimRight(strings.TrimPrefix(strings.TrimPrefix(site, "https://"), "http://"), "/")
	site = strings.TrimSuffix(site, ".atlassian.net")
	return site
}

func jiraServiceWebhookString(raw map[string]any, path ...string) string {
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

func jiraServiceWebhookMap(raw map[string]any, path ...string) map[string]any {
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
