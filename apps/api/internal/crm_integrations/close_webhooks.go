// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingCloseWebhookSignature = errors.New("close webhook signature is required")
	ErrInvalidCloseWebhookSignature = errors.New("invalid close webhook signature")
)

type closeWebhookIntegrationFinder interface {
	FindCloseIntegrationByWebhookToken(context.Context, string) (*Integration, error)
}

type closeWebhookPayload struct {
	Event          closeWebhookEvent `json:"event"`
	SubscriptionID string            `json:"subscription_id"`
	Raw            map[string]any    `json:"-"`
}

type closeWebhookEvent struct {
	ID             string         `json:"id"`
	Action         string         `json:"action"`
	ObjectType     string         `json:"object_type"`
	ObjectID       string         `json:"object_id"`
	LeadID         string         `json:"lead_id"`
	OrganizationID string         `json:"organization_id"`
	UserID         string         `json:"user_id"`
	RequestID      string         `json:"request_id"`
	DateCreated    string         `json:"date_created"`
	DateUpdated    string         `json:"date_updated"`
	ChangedFields  []string       `json:"changed_fields"`
	PreviousData   map[string]any `json:"previous_data"`
	Data           map[string]any `json:"data"`
	Meta           map[string]any `json:"meta"`
}

func (d *Deps) CloseWebhook(w http.ResponseWriter, r *http.Request) {
	routeToken := strings.TrimSpace(chi.URLParam(r, "webhook_token"))
	if routeToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "Close webhook route token is required")
		return
	}
	finder, ok := d.Repo.(closeWebhookIntegrationFinder)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "Close webhook lookup is not configured")
		return
	}
	integration, err := finder.FindCloseIntegrationByWebhookToken(r.Context(), routeToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Close integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, crmJSONMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Close webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read Close webhook body")
		return
	}
	creds, err := d.closeWebhookCredentials(r.Context(), integration)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if err := VerifyCloseWebhookSignature(creds.WebhookSignatureKey, body, r.Header.Get("close-sig-timestamp"), r.Header.Get("close-sig-hash")); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_signature", "request authentication failed")
		return
	}
	current, err := d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Close integration not found")
		return
	}
	integration = current
	payload, err := decodeCloseWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if err := validateCloseWebhookRouteIdentity(payload, *integration); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("close webhook identity mismatch", "integration", integration.ID, "err", err.Error())
		}
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Close integration not found")
		return
	}
	deliveryID := closeWebhookDeliveryID(payload, body)
	topic := closeWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID, topic, body)
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
	req, handled, err := d.mapCloseWebhookSyncRequest(r.Context(), payload, *integration, creds, deliveryID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "event_id": deliveryID})
		return
	}
	current, err = d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID, err)
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID, errCRMIntegrationDisconnected)
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Close integration not found")
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "Close webhook sync failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_sync_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderClose, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func (d *Deps) closeWebhookCredentials(ctx context.Context, integration *Integration) (CloseCredentials, error) {
	if d.CloseCredentials == nil {
		return CloseCredentials{}, fmt.Errorf("close credential resolver is not configured")
	}
	return d.CloseCredentials.ResolveClose(ctx, integration.TenantID, *integration)
}

func VerifyCloseWebhookSignature(signatureKey string, body []byte, timestamp, signature string) error {
	signatureKey = strings.TrimSpace(signatureKey)
	timestamp = strings.TrimSpace(timestamp)
	signature = strings.ToLower(strings.TrimSpace(signature))
	if signatureKey == "" || timestamp == "" || signature == "" {
		return ErrMissingCloseWebhookSignature
	}
	key, err := hex.DecodeString(signatureKey)
	if err != nil || len(key) == 0 {
		return ErrInvalidCloseWebhookSignature
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return ErrInvalidCloseWebhookSignature
	}
	return nil
}

func decodeCloseWebhookPayload(body []byte) (closeWebhookPayload, error) {
	var out closeWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return closeWebhookPayload{}, fmt.Errorf("decode close webhook body: %w", err)
	}
	_ = json.Unmarshal(body, &out.Raw)
	if strings.TrimSpace(out.Event.ID) == "" && strings.TrimSpace(out.Event.ObjectType) == "" {
		return closeWebhookPayload{}, fmt.Errorf("close event is required")
	}
	return out, nil
}

func validateCloseWebhookRouteIdentity(payload closeWebhookPayload, integration Integration) error {
	got := strings.TrimSpace(payload.Event.OrganizationID)
	want := strings.TrimSpace(firstString(settingString(integration.Settings, "organization_id"), settingString(integration.Settings, "close_organization_id")))
	if got != "" && want != "" && got != want {
		return fmt.Errorf("close webhook organization_id mismatch")
	}
	return nil
}

func closeWebhookDeliveryID(payload closeWebhookPayload, body []byte) string {
	sum := sha256.Sum256(body)
	base := hex.EncodeToString(sum[:])
	return "close:" + firstString(
		strings.Join(uniqueCRMStrings([]string{strings.TrimSpace(payload.SubscriptionID), strings.TrimSpace(payload.Event.ID)}), ":"),
		strings.TrimSpace(payload.Event.ID),
		strings.TrimSpace(payload.SubscriptionID),
		base,
	)
}

func closeWebhookTopic(payload closeWebhookPayload) string {
	objectType := strings.ToLower(strings.TrimSpace(payload.Event.ObjectType))
	action := strings.ToLower(strings.TrimSpace(payload.Event.Action))
	return firstString(objectType, "unknown") + "." + firstString(action, "unknown")
}

func (d *Deps) mapCloseWebhookSyncRequest(ctx context.Context, payload closeWebhookPayload, integration Integration, creds CloseCredentials, deliveryID string) (SyncRequest, bool, error) {
	objectType := strings.ToLower(strings.TrimSpace(payload.Event.ObjectType))
	action := strings.ToLower(strings.TrimSpace(payload.Event.Action))
	data := payload.Event.Data
	if len(data) == 0 {
		data = payload.Event.PreviousData
	}
	if len(data) == 0 {
		return SyncRequest{}, false, nil
	}
	switch objectType {
	case "contact":
		if action == "deleted" || action == "delete" {
			event, ok := mapCloseGenericEvent(payload, data, deliveryID)
			if !ok {
				return SyncRequest{}, false, nil
			}
			event.EventName = "crm.contact.deleted"
			return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: []EventInput{event}, Cursor: deliveryID}), true, nil
		}
		contact, ok := mapCloseWebhookContact(payload, integration)
		if !ok {
			return SyncRequest{}, false, nil
		}
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: []ContactInput{contact}, Cursor: deliveryID}), true, nil
	case "opportunity", "task", "lead", "activity", "note", "call", "email", "sms", "meeting":
		event, ok := mapCloseGenericEvent(payload, data, deliveryID)
		if !ok && closeWebhookContactID(data) != "" {
			contact, err := fetchCloseWebhookContact(ctx, creds, integration, closeWebhookContactID(data))
			if err != nil {
				return SyncRequest{}, false, err
			}
			contact.Properties["close_webhook_event_id"] = payload.Event.ID
			event, ok = mapCloseGenericEventWithIdentity(payload, data, deliveryID, contact.Email, contact.Phone)
			if ok {
				return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: []ContactInput{contact}, Events: []EventInput{event}, Cursor: deliveryID}), true, nil
			}
		}
		if !ok {
			return SyncRequest{}, false, nil
		}
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Events: []EventInput{event}, Cursor: deliveryID}), true, nil
	default:
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: deliveryID}), false, nil
	}
}

func mapCloseWebhookContact(payload closeWebhookPayload, integration Integration) (ContactInput, bool) {
	data := payload.Event.Data
	if len(data) == 0 {
		data = payload.Event.PreviousData
	}
	email := closeWebhookEmail(data)
	if email == "" {
		return ContactInput{}, false
	}
	id := firstString(closeString(data, "id"), payload.Event.ObjectID, email)
	props := closeWebhookProperties(payload, data)
	props["close_id"] = id
	props["close_lead_id"] = firstString(closeString(data, "lead_id"), payload.Event.LeadID)
	return ContactInput{
		SourceID:       "close://contact/" + id,
		Email:          email,
		FullName:       firstString(closeString(data, "name"), closeString(data, "display_name")),
		Phone:          closeWebhookPhone(data),
		LifecycleStage: closeString(data, "title"),
		ListIDs:        crmListIDs(integration),
		Tags:           crmDefaultTags(integration, "close"),
		Properties:     props,
	}, true
}

func mapCloseGenericEvent(payload closeWebhookPayload, data map[string]any, deliveryID string) (EventInput, bool) {
	return mapCloseGenericEventWithIdentity(payload, data, deliveryID, closeWebhookEmail(data), closeWebhookPhone(data))
}

func mapCloseGenericEventWithIdentity(payload closeWebhookPayload, data map[string]any, deliveryID, email, phone string) (EventInput, bool) {
	email = strings.ToLower(strings.TrimSpace(email))
	phone = strings.TrimSpace(phone)
	if email == "" && phone == "" {
		return EventInput{}, false
	}
	objectType := strings.ToLower(strings.TrimSpace(payload.Event.ObjectType))
	action := strings.ToLower(strings.TrimSpace(payload.Event.Action))
	id := firstString(closeString(data, "id"), payload.Event.ObjectID, deliveryID)
	eventName := closeWebhookEventName(objectType, action, data)
	props := closeWebhookProperties(payload, data)
	props["delivery_id"] = deliveryID
	props["close_object_id"] = id
	return EventInput{
		SourceID:   "close://" + firstString(objectType, "object") + "/" + id,
		Email:      email,
		Phone:      phone,
		EventName:  eventName,
		OccurredAt: firstParsedHubSpotTime(payload.Event.DateUpdated, payload.Event.DateCreated, closeString(data, "date_updated"), closeString(data, "date_created")),
		Properties: props,
	}, true
}

func closeWebhookEventName(objectType, action string, data map[string]any) string {
	objectType = strings.ToLower(strings.TrimSpace(objectType))
	action = strings.ToLower(strings.TrimSpace(action))
	if objectType == "opportunity" {
		switch strings.ToLower(strings.TrimSpace(closeString(data, "status_type"))) {
		case "won":
			return "crm.opportunity.won"
		case "lost":
			return "crm.opportunity.lost"
		}
	}
	if objectType == "task" && (closeBool(data, "is_complete") || closeBool(data, "done")) {
		return "crm.task.completed"
	}
	return "crm." + firstString(objectType, "close_object") + "." + firstString(action, "changed")
}

func closeWebhookProperties(payload closeWebhookPayload, data map[string]any) map[string]any {
	return map[string]any{
		"provider_event":        closeWebhookTopic(payload),
		"close_subscription_id": payload.SubscriptionID,
		"close_event_id":        payload.Event.ID,
		"close_request_id":      payload.Event.RequestID,
		"close_object_type":     payload.Event.ObjectType,
		"close_object_id":       firstString(payload.Event.ObjectID, closeString(data, "id")),
		"close_lead_id":         firstString(payload.Event.LeadID, closeString(data, "lead_id")),
		"close_organization_id": payload.Event.OrganizationID,
		"changed_fields":        payload.Event.ChangedFields,
		"previous_data":         payload.Event.PreviousData,
		"close_raw":             data,
	}
}

func fetchCloseWebhookContact(ctx context.Context, creds CloseCredentials, integration Integration, contactID string) (ContactInput, error) {
	contactID = strings.TrimSpace(contactID)
	if contactID == "" {
		return ContactInput{}, fmt.Errorf("close contact_id is required")
	}
	baseURL := firstString(strings.TrimRight(settingString(integration.Settings, "api_base_url"), "/"), strings.TrimRight(creds.APIBaseURL, "/"), closeDefaultAPIBaseURL)
	headers := map[string]string{"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(creds.APIKey+":"))}
	var contact closeContact
	if err := crmStaticDoJSON(ctx, crmHTTPClient(nil, ProviderClose), http.MethodGet, baseURL, "/api/v1/contact/"+url.PathEscape(contactID)+"/", nil, headers, nil, firstString(creds.UserAgent, closeDefaultUserAgent), &contact); err != nil {
		return ContactInput{}, err
	}
	mapped, ok := mapCloseContact(contact, integration)
	if !ok {
		return ContactInput{}, fmt.Errorf("close contact %s has no email", contactID)
	}
	return mapped, nil
}

func closeWebhookContactID(data map[string]any) string {
	return firstString(closeString(data, "contact_id"), closeString(data, "primary_contact_id"))
}

func closeWebhookEmail(data map[string]any) string {
	return strings.ToLower(firstString(
		closeString(data, "email"),
		closeString(data, "primary_email"),
		closeNestedString(data["contact"], "email"),
		closeNestedString(data["person"], "email"),
		closeFirstNestedString(data["emails"], "email"),
	))
}

func closeWebhookPhone(data map[string]any) string {
	return firstString(
		closeString(data, "phone"),
		closeString(data, "primary_phone"),
		closeNestedString(data["contact"], "phone"),
		closeFirstNestedString(data["phones"], "phone"),
	)
}

func closeString(record map[string]any, key string) string {
	if record == nil {
		return ""
	}
	return closeAnyString(record[key])
}

func closeNestedString(value any, key string) string {
	if typed, ok := value.(map[string]any); ok {
		return closeString(typed, key)
	}
	return ""
}

func closeFirstNestedString(value any, key string) string {
	values, ok := value.([]any)
	if !ok {
		return ""
	}
	for _, item := range values {
		if typed, ok := item.(map[string]any); ok {
			if out := closeString(typed, key); out != "" {
				return out
			}
		}
	}
	return ""
}

func closeBool(record map[string]any, key string) bool {
	switch typed := record[key].(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	default:
		return false
	}
}

func closeAnyString(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}
