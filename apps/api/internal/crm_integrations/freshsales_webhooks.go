// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

type freshsalesWebhookIntegrationFinder interface {
	FindFreshsalesIntegrationByWebhookToken(context.Context, string) (*Integration, error)
}

type freshsalesWebhookPayload struct {
	Raw        map[string]any
	Contact    map[string]any
	ContactID  string
	ObjectType string
	Action     string
	EventID    string
	Timestamp  string
}

func (d *Deps) FreshsalesWebhook(w http.ResponseWriter, r *http.Request) {
	routeToken := strings.TrimSpace(chi.URLParam(r, "webhook_token"))
	if routeToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "Freshsales webhook route token is required")
		return
	}
	finder, ok := d.Repo.(freshsalesWebhookIntegrationFinder)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "Freshsales webhook lookup is not configured")
		return
	}
	integration, err := finder.FindFreshsalesIntegrationByWebhookToken(r.Context(), routeToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Freshsales integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, crmJSONMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Freshsales webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read Freshsales webhook body")
		return
	}
	payload, err := decodeFreshsalesWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	current, err := d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Freshsales integration not found")
		return
	}
	integration = current
	deliveryID := freshsalesWebhookDeliveryID(payload, body)
	topic := freshsalesWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID, topic, body)
	if err != nil {
		if errors.Is(err, ErrCRMWebhookBodyMismatch) {
			httperror.Write(w, http.StatusConflict, "webhook_body_mismatch", "webhook delivery id was reused with a different body")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if claim == WebhookProcessed {
		w.WriteHeader(http.StatusOK)
		return
	}
	if claim == WebhookInProgress {
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "webhook is already being processed")
		return
	}
	req, handled, err := d.mapFreshsalesWebhookSyncRequest(r.Context(), payload, *integration, deliveryID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "event_id": deliveryID})
		return
	}
	current, err = d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID, err)
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID, errCRMIntegrationDisconnected)
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Freshsales integration not found")
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "Freshsales webhook sync failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_sync_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderFreshsales, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func decodeFreshsalesWebhookPayload(body []byte) (freshsalesWebhookPayload, error) {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return freshsalesWebhookPayload{}, fmt.Errorf("decode freshsales webhook body: %w", err)
	}
	if len(raw) == 0 {
		return freshsalesWebhookPayload{}, fmt.Errorf("freshsales webhook body is required")
	}
	contact := freshsalesWebhookContactMap(raw)
	out := freshsalesWebhookPayload{
		Raw:        raw,
		Contact:    contact,
		ContactID:  freshsalesWebhookContactID(raw, contact),
		ObjectType: freshsalesWebhookObjectType(raw, contact),
		Action:     freshsalesWebhookAction(raw),
		EventID:    freshsalesWebhookEventID(raw),
		Timestamp:  freshsalesWebhookTimestamp(raw),
	}
	if out.ObjectType == "" {
		out.ObjectType = "unknown"
	}
	if out.Action == "" {
		out.Action = "updated"
	}
	return out, nil
}

func freshsalesWebhookDeliveryID(payload freshsalesWebhookPayload, body []byte) string {
	if eventID := strings.TrimSpace(payload.EventID); eventID != "" {
		return "freshsales:" + eventID
	}
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	parts := uniqueCRMStrings([]string{
		freshsalesWebhookTopic(payload),
		strings.TrimSpace(payload.ContactID),
		strings.TrimSpace(payload.Timestamp),
	})
	if len(parts) == 0 {
		return "freshsales:" + bodyHash
	}
	if strings.TrimSpace(payload.Timestamp) == "" {
		parts = append(parts, bodyHash)
	}
	return "freshsales:" + strings.Join(parts, ":")
}

func freshsalesWebhookTopic(payload freshsalesWebhookPayload) string {
	return firstString(payload.ObjectType, "unknown") + "." + firstString(payload.Action, "updated")
}

func (d *Deps) mapFreshsalesWebhookSyncRequest(ctx context.Context, payload freshsalesWebhookPayload, integration Integration, deliveryID string) (SyncRequest, bool, error) {
	if payload.ObjectType != "contact" || payload.Action == "deleted" {
		return SyncRequest{}, false, nil
	}
	contact, ok := freshsalesContactFromMap(payload.Contact)
	if ok && strings.TrimSpace(contact.ID.String()) == "" && payload.ContactID != "" {
		contact.ID = json.Number(payload.ContactID)
	}
	if !ok || strings.TrimSpace(contact.Email) == "" {
		if strings.TrimSpace(payload.ContactID) == "" {
			return SyncRequest{}, false, nil
		}
		if d.FreshsalesCredentials == nil {
			return SyncRequest{}, false, fmt.Errorf("freshsales credential resolver is not configured")
		}
		creds, err := d.FreshsalesCredentials.ResolveFreshsales(ctx, integration.TenantID, integration)
		if err != nil {
			return SyncRequest{}, false, err
		}
		contact, err = d.fetchFreshsalesWebhookContact(ctx, integration, creds, payload.ContactID)
		if err != nil {
			return SyncRequest{}, false, err
		}
	}
	mapped, ok := mapFreshsalesContact(contact, integration)
	if !ok {
		return SyncRequest{}, false, nil
	}
	mapped.Properties["freshsales_webhook_topic"] = freshsalesWebhookTopic(payload)
	mapped.Properties["freshsales_webhook_event_id"] = strings.TrimSpace(payload.EventID)
	mapped.Properties["freshsales_webhook_timestamp"] = strings.TrimSpace(payload.Timestamp)
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: []ContactInput{mapped}, Cursor: deliveryID}), true, nil
}

func (d *Deps) fetchFreshsalesWebhookContact(ctx context.Context, integration Integration, creds FreshsalesCredentials, id string) (freshsalesContact, error) {
	baseURL, err := freshsalesBaseURL(settingString(integration.Settings, "api_base_url"), creds)
	if err != nil {
		return freshsalesContact{}, err
	}
	var out map[string]any
	path := "/crm/sales/api/contacts/" + url.PathEscape(strings.TrimSpace(id))
	if err := crmStaticDoJSON(ctx, crmHTTPClient(nil, ProviderFreshsales), http.MethodGet, baseURL, path, nil, freshsalesAuthHeaders(creds), nil, firstString(creds.UserAgent, freshsalesDefaultUserAgent), &out); err != nil {
		return freshsalesContact{}, err
	}
	if contact, ok := freshsalesWebhookMap(out["contact"]); ok {
		mapped, ok := freshsalesContactFromMap(contact)
		if !ok {
			return freshsalesContact{}, fmt.Errorf("freshsales contact %q response is empty", id)
		}
		return mapped, nil
	}
	mapped, ok := freshsalesContactFromMap(out)
	if !ok {
		return freshsalesContact{}, fmt.Errorf("freshsales contact %q response is empty", id)
	}
	return mapped, nil
}

func freshsalesWebhookContactMap(raw map[string]any) map[string]any {
	for _, key := range []string{"contact", "sales_contact"} {
		if contact, ok := freshsalesWebhookMap(raw[key]); ok {
			return contact
		}
	}
	for _, containerKey := range []string{"data", "payload", "record", "resource"} {
		container, ok := freshsalesWebhookMap(raw[containerKey])
		if !ok {
			continue
		}
		for _, key := range []string{"contact", "sales_contact"} {
			if contact, ok := freshsalesWebhookMap(container[key]); ok {
				return contact
			}
		}
		if freshsalesWebhookLooksLikeContact(container) {
			return container
		}
	}
	if freshsalesWebhookLooksLikeContact(raw) {
		return raw
	}
	return nil
}

func freshsalesWebhookContactID(raw, contact map[string]any) string {
	if id := freshsalesWebhookString(contact, "id", "contact_id", "contactId"); id != "" {
		return id
	}
	if id := freshsalesWebhookString(raw, "contact_id", "contactId", "record_id", "entity_id"); id != "" {
		return id
	}
	if freshsalesWebhookObjectType(raw, contact) == "contact" {
		if id := freshsalesWebhookString(raw, "id"); id != "" {
			return id
		}
	}
	for _, containerKey := range []string{"data", "payload", "record", "resource"} {
		container, ok := freshsalesWebhookMap(raw[containerKey])
		if !ok {
			continue
		}
		if id := freshsalesWebhookString(container, "contact_id", "contactId", "record_id", "entity_id", "id"); id != "" {
			return id
		}
	}
	return ""
}

func freshsalesWebhookObjectType(raw, contact map[string]any) string {
	for _, key := range []string{"object_type", "object", "entity", "entity_type", "module", "module_name", "type", "record_type"} {
		if object := normalizeFreshsalesWebhookObjectType(freshsalesWebhookString(raw, key)); object != "" && object != "workflow" {
			return object
		}
	}
	for _, containerKey := range []string{"data", "payload", "record", "resource"} {
		container, ok := freshsalesWebhookMap(raw[containerKey])
		if !ok {
			continue
		}
		for _, key := range []string{"object_type", "object", "entity", "entity_type", "module", "module_name", "type", "record_type"} {
			if object := normalizeFreshsalesWebhookObjectType(freshsalesWebhookString(container, key)); object != "" && object != "workflow" {
				return object
			}
		}
	}
	if len(contact) > 0 || freshsalesWebhookString(raw, "contact_id", "contactId") != "" {
		return "contact"
	}
	for _, key := range []string{"deal", "account", "activity", "task"} {
		if _, ok := freshsalesWebhookMap(raw[key]); ok {
			return key
		}
	}
	return normalizeFreshsalesWebhookObjectType(freshsalesWebhookString(raw, "event", "event_type", "action"))
}

func normalizeFreshsalesWebhookObjectType(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.ReplaceAll(value, "-", "_")
	value = strings.ReplaceAll(value, ".", "_")
	value = strings.ReplaceAll(value, " ", "_")
	switch {
	case value == "":
		return ""
	case strings.Contains(value, "contact") || strings.Contains(value, "lead"):
		return "contact"
	case strings.Contains(value, "deal") || strings.Contains(value, "opportunity"):
		return "deal"
	case strings.Contains(value, "account") || strings.Contains(value, "company"):
		return "account"
	case strings.Contains(value, "activity"):
		return "activity"
	case strings.Contains(value, "task"):
		return "task"
	case strings.Contains(value, "workflow"):
		return "workflow"
	default:
		return value
	}
}

func freshsalesWebhookAction(raw map[string]any) string {
	value := strings.ToLower(strings.TrimSpace(firstString(
		freshsalesWebhookString(raw, "event"),
		freshsalesWebhookString(raw, "event_type"),
		freshsalesWebhookString(raw, "action"),
		freshsalesWebhookString(raw, "operation"),
		freshsalesWebhookString(raw, "trigger"),
		freshsalesWebhookString(raw, "name"),
	)))
	value = strings.ReplaceAll(value, "-", "_")
	value = strings.ReplaceAll(value, ".", "_")
	value = strings.ReplaceAll(value, " ", "_")
	switch {
	case value == "":
		return "updated"
	case strings.Contains(value, "delete") || strings.Contains(value, "destroy") || strings.Contains(value, "remove"):
		return "deleted"
	case strings.Contains(value, "create") || strings.Contains(value, "created") || strings.Contains(value, "new") || strings.Contains(value, "add"):
		return "created"
	case strings.Contains(value, "update") || strings.Contains(value, "updated") || strings.Contains(value, "change") || strings.Contains(value, "edit"):
		return "updated"
	default:
		return value
	}
}

func freshsalesWebhookEventID(raw map[string]any) string {
	for _, key := range []string{"event_id", "webhook_event_id", "delivery_id", "request_id", "workflow_run_id"} {
		if id := freshsalesWebhookString(raw, key); id != "" {
			return id
		}
	}
	for _, key := range []string{"meta", "metadata", "headers"} {
		if nested, ok := freshsalesWebhookMap(raw[key]); ok {
			for _, idKey := range []string{"event_id", "webhook_event_id", "delivery_id", "request_id", "workflow_run_id"} {
				if id := freshsalesWebhookString(nested, idKey); id != "" {
					return id
				}
			}
		}
	}
	return ""
}

func freshsalesWebhookTimestamp(raw map[string]any) string {
	for _, key := range []string{"timestamp", "occurred_at", "triggered_at", "updated_at", "created_at"} {
		if ts := freshsalesWebhookString(raw, key); ts != "" {
			return ts
		}
	}
	return ""
}

func freshsalesContactFromMap(record map[string]any) (freshsalesContact, bool) {
	if len(record) == 0 {
		return freshsalesContact{}, false
	}
	out := freshsalesContact{
		ID:           json.Number(freshsalesWebhookString(record, "id", "contact_id", "contactId")),
		Email:        firstString(freshsalesWebhookString(record, "email", "email_address"), freshsalesEmailFromValue(record["emails"])),
		FirstName:    firstString(freshsalesWebhookString(record, "first_name", "firstName"), freshsalesWebhookString(record, "first name")),
		LastName:     firstString(freshsalesWebhookString(record, "last_name", "lastName"), freshsalesWebhookString(record, "last name")),
		MobileNumber: freshsalesWebhookString(record, "mobile_number", "mobileNumber", "mobile", "phone_mobile"),
		WorkNumber:   freshsalesWebhookString(record, "work_number", "workNumber", "phone", "phone_number", "work_phone"),
		JobTitle:     freshsalesWebhookString(record, "job_title", "jobTitle", "title"),
		UpdatedAt:    freshsalesWebhookString(record, "updated_at", "updatedAt", "updated_time", "modified_at", "last_updated_at"),
	}
	return out, strings.TrimSpace(out.Email) != "" || strings.TrimSpace(out.ID.String()) != ""
}

func freshsalesWebhookLooksLikeContact(record map[string]any) bool {
	if len(record) == 0 {
		return false
	}
	if freshsalesWebhookString(record, "email", "email_address", "contact_id", "contactId") != "" || freshsalesEmailFromValue(record["emails"]) != "" {
		return true
	}
	return freshsalesWebhookString(record, "first_name", "firstName", "last_name", "lastName") != "" && freshsalesWebhookString(record, "id") != ""
}

func freshsalesWebhookString(record map[string]any, keys ...string) string {
	if len(record) == 0 {
		return ""
	}
	for _, key := range keys {
		value, ok := record[key]
		if !ok {
			continue
		}
		if out := freshsalesStringValue(value); out != "" {
			return out
		}
	}
	return ""
}

func freshsalesEmailFromValue(value any) string {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if email := freshsalesEmailFromValue(item); email != "" {
				return email
			}
		}
	case []map[string]any:
		for _, item := range typed {
			if email := freshsalesEmailFromValue(item); email != "" {
				return email
			}
		}
	case map[string]any:
		return freshsalesWebhookString(typed, "email", "value")
	default:
		return freshsalesStringValue(value)
	}
	return ""
}

func freshsalesStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case map[string]any:
		return firstString(
			freshsalesWebhookString(typed, "value"),
			freshsalesWebhookString(typed, "email"),
			freshsalesWebhookString(typed, "id"),
			freshsalesWebhookString(typed, "number"),
			freshsalesWebhookString(typed, "name"),
		)
	case []any:
		for _, item := range typed {
			if out := freshsalesStringValue(item); out != "" {
				return out
			}
		}
	}
	return ""
}

func freshsalesWebhookMap(value any) (map[string]any, bool) {
	typed, ok := value.(map[string]any)
	return typed, ok && len(typed) > 0
}
