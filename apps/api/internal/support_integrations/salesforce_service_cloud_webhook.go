// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingSalesforceServiceCloudWebhookSecret = errors.New("salesforce service cloud webhook relay secret is required")
	ErrInvalidSalesforceServiceCloudWebhookSecret = errors.New("invalid salesforce service cloud webhook relay secret")
)

type SalesforceServiceCloudWebhookStore interface {
	FindSalesforceServiceCloudIntegrationByInstance(ctx context.Context, instanceURL, webhookID string) (*Integration, error)
}

type salesforceServiceCloudCDCEnvelope struct {
	EventID    string
	Topic      string
	ChangeType string
	EntityName string
	CaseID     string
	CommitTime *time.Time
	Raw        map[string]any
}

type SalesforceServiceCloudCDCSummary struct {
	Received  int `json:"received"`
	Processed int `json:"processed"`
	Ignored   int `json:"ignored"`
	Duplicate int `json:"duplicate"`
}

// SalesforceServiceCloudWebhook receives decoded Salesforce CDC/Pub/Sub relay
// events for Service Cloud Cases. Salesforce CDC is a streaming contract, so
// Moosewave treats this HTTP endpoint as an operator-managed relay target rather
// than a managed Salesforce webhook subscription.
func (d *Deps) SalesforceServiceCloudWebhook(w http.ResponseWriter, r *http.Request) {
	instanceURL := strings.TrimSpace(chi.URLParam(r, "instance_url"))
	if instanceURL == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_instance_url", "salesforce service cloud instance url is required")
		return
	}
	store, ok := d.Repo.(SalesforceServiceCloudWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "salesforce service cloud webhook lookup is not configured")
		return
	}
	webhookID := salesforceServiceCloudWebhookID(r)
	integration, err := store.FindSalesforceServiceCloudIntegrationByInstance(r.Context(), instanceURL, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "salesforce service cloud integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "salesforce service cloud payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read salesforce service cloud webhook body")
		return
	}
	secret, err := d.salesforceServiceCloudWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_secret", "request authentication failed")
		return
	}
	if err := VerifySalesforceServiceCloudWebhookSecret(secret, salesforceServiceCloudWebhookSecretValue(r)); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_secret", "request authentication failed")
		return
	}
	events, err := decodeSalesforceServiceCloudCDCEvents(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	summary, err := d.processSalesforceServiceCloudCDCEvents(r.Context(), integration, claimStore, webhookID, events, body)
	if err != nil {
		writeSalesforceServiceCloudCDCRefreshError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) processSalesforceServiceCloudCDCEvents(ctx context.Context, integration *Integration, claimStore SupportWebhookClaimStore, webhookID string, events []salesforceServiceCloudCDCEnvelope, body []byte) (SalesforceServiceCloudCDCSummary, error) {
	summary := SalesforceServiceCloudCDCSummary{Received: len(events)}
	for _, ev := range events {
		if !salesforceServiceCloudCaseCDCEvent(ev) || ev.CaseID == "" {
			summary.Ignored++
			continue
		}
		deliveryID := salesforceServiceCloudCDCDeliveryID(ev, webhookID)
		topic := firstString(ev.Topic, "CaseChangeEvent")
		claim, err := claimStore.ClaimSupportWebhook(ctx, integration.TenantID, integration.ID, ProviderSalesforceServiceCloud, deliveryID, topic, body)
		if err != nil {
			return summary, err
		}
		if claim == WebhookProcessed || claim == WebhookInProgress {
			summary.Duplicate++
			continue
		}
		req, ok, err := d.refreshSalesforceServiceCloudCDCCase(ctx, integration, ev, webhookID)
		if err != nil {
			if salesforceServiceCloudRefreshCaseMissing(err) {
				if markErr := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderSalesforceServiceCloud, deliveryID); markErr != nil {
					return summary, markErr
				}
				summary.Ignored++
				continue
			}
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderSalesforceServiceCloud, deliveryID, err)
			return summary, err
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderSalesforceServiceCloud, deliveryID); err != nil {
				return summary, err
			}
			summary.Ignored++
			continue
		}
		started := d.now()
		syncSummary := d.executeSync(ctx, integration.TenantID, integration, req)
		completed := d.now()
		run, err := d.Repo.RecordSyncRun(ctx, integration.TenantID, integration.ID, syncSummary, req, started, completed)
		if err != nil {
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderSalesforceServiceCloud, deliveryID, err)
			return summary, err
		}
		syncSummary.RunID = run.ID
		if syncSummary.Status == "failed" {
			err := errors.New(firstString(syncSummary.ErrorMessage, "salesforce service cloud CDC relay processing failed"))
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderSalesforceServiceCloud, deliveryID, err)
			return summary, err
		}
		if err := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderSalesforceServiceCloud, deliveryID); err != nil {
			return summary, err
		}
		summary.Processed++
	}
	return summary, nil
}

func (d *Deps) refreshSalesforceServiceCloudCDCCase(ctx context.Context, integration *Integration, ev salesforceServiceCloudCDCEnvelope, webhookID string) (SyncRequest, bool, error) {
	refresher, ok := d.SalesforceServiceCloudBackfiller.(SalesforceServiceCloudCaseRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("salesforce service cloud case refresh is not configured")
	}
	req, err := refresher.RefreshCase(ctx, integration.TenantID, *integration, ev.CaseID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req.RunMode = "webhook"
	req.Cursor = "salesforce-service-cloud-cdc-" + firstString(ev.EventID, ev.CaseID)
	for i := range req.Tickets {
		if req.Tickets[i].Properties == nil {
			req.Tickets[i].Properties = map[string]any{}
		}
		req.Tickets[i].Properties["salesforce_service_cloud_webhook_id"] = strings.TrimSpace(webhookID)
		req.Tickets[i].Properties["salesforce_cdc_event_id"] = strings.TrimSpace(ev.EventID)
		req.Tickets[i].Properties["salesforce_cdc_event"] = strings.TrimSpace(firstString(ev.Topic, ev.EntityName, "CaseChangeEvent"))
		req.Tickets[i].Properties["salesforce_cdc_change_type"] = strings.TrimSpace(ev.ChangeType)
		req.Tickets[i].Properties["salesforce_refresh_source"] = "cdc_sparse_case"
		req.Tickets[i].Properties["salesforce_cdc_raw"] = ev.Raw
	}
	req = normalizeSyncRequest(req)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func (d *Deps) salesforceServiceCloudWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingSalesforceServiceCloudWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "salesforce_service_cloud_webhook_secret_ref"),
		settingString(integration.Settings, "salesforce_webhook_secret_ref"),
		settingString(integration.Settings, "webhook_auth_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingSalesforceServiceCloudWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingSalesforceServiceCloudWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifySalesforceServiceCloudWebhookSecret(secret, got string) error {
	secret = strings.TrimSpace(secret)
	got = strings.TrimSpace(got)
	if secret == "" || got == "" {
		return ErrMissingSalesforceServiceCloudWebhookSecret
	}
	if subtle.ConstantTimeCompare([]byte(secret), []byte(got)) == 1 {
		return nil
	}
	return ErrInvalidSalesforceServiceCloudWebhookSecret
}

func decodeSalesforceServiceCloudCDCEvents(body []byte) ([]salesforceServiceCloudCDCEnvelope, error) {
	var root any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&root); err != nil {
		return nil, fmt.Errorf("decode salesforce service cloud CDC payload: %w", err)
	}
	nodes := salesforceServiceCloudEventNodes(root)
	if len(nodes) == 0 {
		return nil, fmt.Errorf("salesforce service cloud CDC payload must contain at least one event")
	}
	out := make([]salesforceServiceCloudCDCEnvelope, 0, len(nodes))
	for _, node := range nodes {
		ev := salesforceServiceCloudCDCEnvelopeFromRaw(node)
		out = append(out, ev)
	}
	return out, nil
}

func salesforceServiceCloudEventNodes(root any) []map[string]any {
	switch typed := root.(type) {
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case map[string]any:
		for _, key := range []string{"events", "records"} {
			if raw, ok := typed[key].([]any); ok {
				out := make([]map[string]any, 0, len(raw))
				for _, item := range raw {
					if m, ok := item.(map[string]any); ok {
						out = append(out, m)
					}
				}
				if len(out) > 0 {
					return out
				}
			}
		}
		return []map[string]any{typed}
	default:
		return nil
	}
}

func salesforceServiceCloudCDCEnvelopeFromRaw(raw map[string]any) salesforceServiceCloudCDCEnvelope {
	payload := salesforceServiceCloudCDCMap(raw, "payload")
	if len(payload) == 0 {
		payload = raw
	}
	header := salesforceServiceCloudCDCMap(payload, "ChangeEventHeader")
	if len(header) == 0 {
		header = salesforceServiceCloudCDCMap(payload, "changeEventHeader")
	}
	if len(header) == 0 {
		header = salesforceServiceCloudCDCMap(raw, "ChangeEventHeader")
	}
	if len(header) == 0 {
		header = salesforceServiceCloudCDCMap(raw, "changeEventHeader")
	}
	caseID := firstString(
		salesforceServiceCloudCDCString(payload, "Id"),
		salesforceServiceCloudCDCString(payload, "id"),
		salesforceServiceCloudCDCString(payload, "CaseId"),
		salesforceServiceCloudCDCString(payload, "caseId"),
		salesforceServiceCloudCDCString(raw, "case_id"),
		salesforceServiceCloudCDCString(raw, "caseId"),
	)
	if caseID == "" {
		caseID = salesforceServiceCloudFirstRecordID(header)
	}
	commitTime := salesforceServiceCloudCDCCommitTime(header, payload, raw)
	return salesforceServiceCloudCDCEnvelope{
		EventID: strings.TrimSpace(firstString(
			salesforceServiceCloudCDCString(raw, "eventId"),
			salesforceServiceCloudCDCString(raw, "event_id"),
			salesforceServiceCloudCDCString(raw, "replayId"),
			salesforceServiceCloudCDCString(raw, "replay_id"),
			salesforceServiceCloudCDCString(header, "commitNumber"),
			salesforceServiceCloudCDCString(header, "sequenceNumber"),
			caseID,
		)),
		Topic: strings.TrimSpace(firstString(
			salesforceServiceCloudCDCString(raw, "topic"),
			salesforceServiceCloudCDCString(raw, "channel"),
			salesforceServiceCloudCDCString(raw, "event", "topic"),
			salesforceServiceCloudCDCString(header, "entityName"),
		)),
		ChangeType: strings.TrimSpace(salesforceServiceCloudCDCString(header, "changeType")),
		EntityName: strings.TrimSpace(firstString(
			salesforceServiceCloudCDCString(header, "entityName"),
			salesforceServiceCloudCDCString(raw, "entityName"),
		)),
		CaseID:     strings.TrimSpace(caseID),
		CommitTime: commitTime,
		Raw:        salesforceServiceCloudCDCScrubbedRaw(raw),
	}
}

func salesforceServiceCloudCaseCDCEvent(ev salesforceServiceCloudCDCEnvelope) bool {
	entity := strings.ToLower(strings.TrimSpace(firstString(ev.EntityName, ev.Topic)))
	return entity == "" || strings.Contains(entity, "case")
}

func salesforceServiceCloudCDCDeliveryID(ev salesforceServiceCloudCDCEnvelope, webhookID string) string {
	return "salesforce-service-cloud:" + firstString(strings.TrimSpace(ev.EventID), strings.TrimSpace(webhookID)+"-"+strings.TrimSpace(ev.CaseID), strings.TrimSpace(ev.CaseID))
}

func salesforceServiceCloudRefreshCaseMissing(err error) bool {
	var restErr SalesforceServiceCloudRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeSalesforceServiceCloudCDCRefreshError(w http.ResponseWriter, err error) {
	var restErr SalesforceServiceCloudRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "salesforce_service_cloud_refresh_failed", httperror.MessageInternal)
}

func salesforceServiceCloudWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("relay_id"),
		r.URL.Query().Get("subscription_id"),
		r.Header.Get("X-Postwave-Webhook-Id"),
		r.Header.Get("X-Salesforce-Webhook-Id"),
		r.Header.Get("X-Salesforce-Relay-Id"),
	))
}

func salesforceServiceCloudWebhookSecretValue(r *http.Request) string {
	got := strings.TrimSpace(r.Header.Get("Authorization"))
	if rest, found := strings.CutPrefix(got, "Bearer "); found {
		got = strings.TrimSpace(rest)
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Webhook-Secret"))
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Salesforce-Relay-Secret"))
	}
	return got
}

func normalizeSalesforceServiceCloudInstanceLookup(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if unescaped, err := url.PathUnescape(raw); err == nil {
		raw = strings.TrimSpace(unescaped)
	}
	raw = strings.TrimRight(strings.ToLower(raw), "/")
	if parsed, err := url.Parse(raw); err == nil && parsed.Host != "" {
		scheme := parsed.Scheme
		if scheme == "" {
			scheme = "https"
		}
		return scheme + "://" + strings.ToLower(parsed.Host)
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	return strings.TrimRight(raw, "/")
}

func salesforceServiceCloudCDCMap(node map[string]any, key string) map[string]any {
	if node == nil {
		return nil
	}
	if raw, ok := node[key].(map[string]any); ok {
		return raw
	}
	return nil
}

func salesforceServiceCloudCDCString(node map[string]any, path ...string) string {
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

func salesforceServiceCloudFirstRecordID(header map[string]any) string {
	for _, key := range []string{"recordIds", "record_ids", "recordIds__c"} {
		switch typed := header[key].(type) {
		case []any:
			if len(typed) > 0 {
				return strings.TrimSpace(fmt.Sprint(typed[0]))
			}
		case []string:
			if len(typed) > 0 {
				return strings.TrimSpace(typed[0])
			}
		case string:
			return strings.TrimSpace(typed)
		}
	}
	return ""
}

func salesforceServiceCloudCDCCommitTime(nodes ...map[string]any) *time.Time {
	for _, node := range nodes {
		raw := firstString(
			salesforceServiceCloudCDCString(node, "commitTimestamp"),
			salesforceServiceCloudCDCString(node, "commit_time"),
			salesforceServiceCloudCDCString(node, "createdDate"),
			salesforceServiceCloudCDCString(node, "CreatedDate"),
		)
		if raw == "" {
			continue
		}
		if millis, err := strconv.ParseInt(raw, 10, 64); err == nil && millis > 0 {
			t := time.UnixMilli(millis).UTC()
			return &t
		}
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func salesforceServiceCloudCDCScrubbedRaw(raw map[string]any) map[string]any {
	if raw == nil {
		return nil
	}
	copied := copySettings(raw)
	for _, key := range []string{"secret", "token", "authorization", "relay_secret", "webhook_secret"} {
		delete(copied, key)
		delete(copied, strings.ToUpper(key))
		delete(copied, strings.Title(key))
	}
	return copied
}
