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
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

type highLevelWebhookIntegrationFinder interface {
	FindHighLevelIntegrationByWebhookToken(context.Context, string) (*Integration, error)
}

type highLevelWebhookPayload struct {
	Type       string
	LocationID string
	Timestamp  string
	Raw        map[string]any
}

func (d *Deps) HighLevelWebhook(w http.ResponseWriter, r *http.Request) {
	routeToken := strings.TrimSpace(chi.URLParam(r, "webhook_token"))
	if routeToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "HighLevel webhook route token is required")
		return
	}
	finder, ok := d.Repo.(highLevelWebhookIntegrationFinder)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "HighLevel webhook lookup is not configured")
		return
	}
	integration, err := finder.FindHighLevelIntegrationByWebhookToken(r.Context(), routeToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "HighLevel integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, crmJSONMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "HighLevel webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read HighLevel webhook body")
		return
	}
	payload, err := decodeHighLevelWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if err := validateHighLevelWebhookRouteIdentity(payload, *integration); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("highLevel webhook identity mismatch", "integration", integration.ID, "err", err.Error())
		}
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "HighLevel integration not found")
		return
	}
	current, err := d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "HighLevel integration not found")
		return
	}
	integration = current
	deliveryID := highLevelWebhookDeliveryID(payload, body)
	topic := highLevelWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID, topic, body)
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
	req, handled, err := d.mapHighLevelWebhookSyncRequest(r.Context(), payload, *integration)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "event_id": deliveryID})
		return
	}
	current, err = d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID, err)
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID, errCRMIntegrationDisconnected)
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "HighLevel integration not found")
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "HighLevel webhook sync failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_sync_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderHighLevel, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func decodeHighLevelWebhookPayload(body []byte) (highLevelWebhookPayload, error) {
	var raw map[string]any
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return highLevelWebhookPayload{}, fmt.Errorf("decode HighLevel webhook body: %w", err)
	}
	eventType := firstString(
		highLevelRecordString(raw, "type"),
		highLevelRecordString(raw, "event"),
		highLevelRecordString(raw, "eventType"),
		highLevelRecordString(raw, "webhookEvent"),
	)
	if eventType == "" {
		return highLevelWebhookPayload{}, fmt.Errorf("highLevel webhook type is required")
	}
	locationID := firstString(
		highLevelRecordString(raw, "locationId", "location_id"),
		highLevelRecordString(highLevelMapValue(raw["location"]), "id"),
	)
	timestamp := firstString(
		highLevelRecordString(raw, "timestamp", "dateAdded", "dateUpdated", "createdAt", "updatedAt"),
		highLevelRecordString(highLevelWebhookPayloadRecord(raw, "appointment"), "dateUpdated", "dateAdded", "startTime"),
	)
	return highLevelWebhookPayload{
		Type:       strings.TrimSpace(eventType),
		LocationID: strings.TrimSpace(locationID),
		Timestamp:  strings.TrimSpace(timestamp),
		Raw:        raw,
	}, nil
}

func validateHighLevelWebhookRouteIdentity(payload highLevelWebhookPayload, integration Integration) error {
	gotLocationID := strings.TrimSpace(payload.LocationID)
	wantLocationID := strings.TrimSpace(firstString(
		settingString(integration.Settings, "location_id"),
		settingString(integration.Settings, "locationId"),
		settingString(integration.Settings, "highlevel_location_id"),
		settingString(integration.Settings, "sub_account_id"),
	))
	if gotLocationID != "" && wantLocationID != "" && gotLocationID != wantLocationID {
		return fmt.Errorf("highLevel webhook locationId mismatch")
	}
	return nil
}

func highLevelWebhookDeliveryID(payload highLevelWebhookPayload, body []byte) string {
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	parts := []string{
		strings.TrimSpace(payload.LocationID),
		highLevelWebhookTopic(payload),
		strings.Join(highLevelWebhookIDs(payload), ","),
		strings.TrimSpace(payload.Timestamp),
	}
	return "highlevel:" + firstString(strings.Join(uniqueCRMStrings(parts), ":"), bodyHash)
}

func highLevelWebhookTopic(payload highLevelWebhookPayload) string {
	eventType := strings.ToLower(strings.TrimSpace(payload.Type))
	switch eventType {
	case "contactcreate":
		return "contact.created"
	case "contactupdate", "contactdndupdate", "contacttagupdate":
		return "contact.updated"
	case "contactdelete":
		return "contact.deleted"
	case "opportunitycreate":
		return "opportunity.created"
	case "opportunitydelete":
		return "opportunity.deleted"
	case "opportunityupdate", "opportunityassignedtoupdate", "opportunitymonetaryvalueupdate", "opportunitystageupdate", "opportunitystatusupdate":
		return "opportunity.updated"
	case "appointmentcreate":
		return "appointment.created"
	case "appointmentdelete":
		return "appointment.deleted"
	case "appointmentupdate":
		return "appointment.updated"
	case "conversationupdate", "conversationunreadwebhook":
		return "conversation.updated"
	case "inboundmessage", "outboundmessage", "provideroutboundmessage":
		return "message.created"
	default:
		return firstString(highLevelWebhookObject(payload), "unknown") + ".unknown"
	}
}

func highLevelWebhookObject(payload highLevelWebhookPayload) string {
	eventType := strings.ToLower(strings.TrimSpace(payload.Type))
	switch {
	case strings.HasPrefix(eventType, "contact"):
		return "contact"
	case strings.HasPrefix(eventType, "opportunity"):
		return "opportunity"
	case strings.HasPrefix(eventType, "appointment"):
		return "appointment"
	case strings.HasPrefix(eventType, "conversation"), eventType == "inboundmessage", eventType == "outboundmessage", eventType == "provideroutboundmessage":
		return "conversation"
	default:
		return ""
	}
}

func highLevelWebhookIsDelete(payload highLevelWebhookPayload) bool {
	return strings.HasSuffix(highLevelWebhookTopic(payload), ".deleted")
}

func highLevelWebhookIDs(payload highLevelWebhookPayload) []string {
	return uniqueCRMStrings([]string{
		highLevelWebhookContactID(payload),
		highLevelWebhookOpportunityID(payload),
		highLevelWebhookAppointmentID(payload),
		highLevelWebhookConversationID(payload),
		highLevelWebhookMessageID(payload),
	})
}

func (d *Deps) mapHighLevelWebhookSyncRequest(ctx context.Context, payload highLevelWebhookPayload, integration Integration) (SyncRequest, bool, error) {
	if highLevelWebhookIsDelete(payload) {
		return SyncRequest{}, false, nil
	}
	if d.HighLevelCredentials == nil {
		return SyncRequest{}, false, fmt.Errorf("highLevel credential resolver is not configured")
	}
	creds, err := d.HighLevelCredentials.ResolveHighLevel(ctx, integration.TenantID, integration)
	if err != nil {
		return SyncRequest{}, false, err
	}
	if strings.TrimSpace(creds.AccessToken) == "" {
		return SyncRequest{}, false, fmt.Errorf("highLevel access token is required")
	}
	if gotLocationID := strings.TrimSpace(payload.LocationID); gotLocationID != "" {
		if wantLocationID := highLevelLocationID(creds, integration); wantLocationID != "" && gotLocationID != wantLocationID {
			return SyncRequest{}, false, fmt.Errorf("highLevel webhook locationId mismatch")
		}
	}
	baseURL, err := highLevelAPIBaseURL(firstString(settingString(integration.Settings, "api_base_url"), creds.APIBaseURL))
	if err != nil {
		return SyncRequest{}, false, err
	}
	runtime := highLevelRuntime{
		ctx:         ctx,
		client:      crmHTTPClient(nil, ProviderHighLevel),
		baseURL:     baseURL,
		creds:       creds,
		userAgent:   firstString(creds.UserAgent, highLevelDefaultUserAgent),
		integration: integration,
		pageSize:    highLevelDefaultPageSize,
	}
	switch highLevelWebhookObject(payload) {
	case "contact":
		return runtime.mapHighLevelWebhookContact(payload)
	case "opportunity":
		return runtime.mapHighLevelWebhookOpportunity(payload)
	case "appointment":
		return runtime.mapHighLevelWebhookAppointment(payload)
	case "conversation":
		return runtime.mapHighLevelWebhookConversation(payload)
	default:
		return SyncRequest{}, false, nil
	}
}

func (rt highLevelRuntime) mapHighLevelWebhookContact(payload highLevelWebhookPayload) (SyncRequest, bool, error) {
	record := highLevelWebhookPayloadRecord(payload.Raw, "contact")
	if contactID := highLevelWebhookContactID(payload); contactID != "" {
		fetched, err := rt.fetchContact(contactID)
		if err != nil {
			return SyncRequest{}, false, err
		}
		record = highLevelWebhookMergeRecord(fetched, record)
	}
	highLevelWebhookFill(record, "id", highLevelWebhookContactID(payload))
	highLevelWebhookFill(record, "locationId", payload.LocationID)
	contact, ok := mapHighLevelContact("contact", record, rt.integration)
	if !ok {
		return SyncRequest{}, false, nil
	}
	applyHighLevelWebhookContactMetadata(&contact, payload)
	return normalizeSyncRequest(SyncRequest{
		RunMode:  "webhook",
		Contacts: []ContactInput{contact},
		Cursor:   "highlevel-webhook-" + strings.TrimSpace(payload.Timestamp),
	}), true, nil
}

func (rt highLevelRuntime) mapHighLevelWebhookOpportunity(payload highLevelWebhookPayload) (SyncRequest, bool, error) {
	record := highLevelWebhookPayloadRecord(payload.Raw, "opportunity")
	if opportunityID := highLevelWebhookOpportunityID(payload); opportunityID != "" {
		fetched, err := rt.fetchHighLevelWebhookRecord("/opportunities/"+url.PathEscape(opportunityID), "opportunity", "data")
		if err != nil {
			return SyncRequest{}, false, err
		}
		record = highLevelWebhookMergeRecord(fetched, record)
		highLevelWebhookFill(record, "id", opportunityID)
		highLevelWebhookFill(record, "opportunityId", opportunityID)
	}
	highLevelWebhookFill(record, "contactId", highLevelWebhookContactID(payload))
	highLevelWebhookFill(record, "locationId", payload.LocationID)
	contact, ok, err := rt.resolveRecordContact(record)
	if err != nil {
		return SyncRequest{}, false, err
	}
	if !ok {
		return SyncRequest{}, false, nil
	}
	event, ok := mapHighLevelOpportunityEvent(record, contact, rt.integration)
	if !ok {
		return SyncRequest{}, false, nil
	}
	applyHighLevelWebhookEventMetadata(&event, payload)
	return normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []EventInput{event},
		Cursor:  "highlevel-webhook-" + strings.TrimSpace(payload.Timestamp),
	}), true, nil
}

func (rt highLevelRuntime) mapHighLevelWebhookAppointment(payload highLevelWebhookPayload) (SyncRequest, bool, error) {
	record := highLevelWebhookPayloadRecord(payload.Raw, "appointment", "event")
	if appointmentID := highLevelWebhookAppointmentID(payload); appointmentID != "" {
		fetched, err := rt.fetchHighLevelWebhookRecord("/calendars/events/appointments/"+url.PathEscape(appointmentID), "appointment", "event", "data")
		if err != nil {
			return SyncRequest{}, false, err
		}
		record = highLevelWebhookMergeRecord(fetched, record)
		highLevelWebhookFill(record, "id", appointmentID)
		highLevelWebhookFill(record, "eventId", appointmentID)
	}
	highLevelWebhookFill(record, "contactId", highLevelWebhookContactID(payload))
	highLevelWebhookFill(record, "locationId", payload.LocationID)
	contact, ok, err := rt.resolveRecordContact(record)
	if err != nil {
		return SyncRequest{}, false, err
	}
	if !ok {
		return SyncRequest{}, false, nil
	}
	event, ok := mapHighLevelAppointmentEvent(record, contact, rt.integration)
	if !ok {
		return SyncRequest{}, false, nil
	}
	applyHighLevelWebhookEventMetadata(&event, payload)
	return normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []EventInput{event},
		Cursor:  "highlevel-webhook-" + strings.TrimSpace(payload.Timestamp),
	}), true, nil
}

func (rt highLevelRuntime) mapHighLevelWebhookConversation(payload highLevelWebhookPayload) (SyncRequest, bool, error) {
	record := highLevelWebhookPayloadRecord(payload.Raw, "conversation", "message")
	if conversationID := highLevelWebhookConversationID(payload); conversationID != "" {
		fetched, err := rt.fetchHighLevelWebhookRecord("/conversations/"+url.PathEscape(conversationID), "conversation", "data")
		if err != nil {
			return SyncRequest{}, false, err
		}
		record = highLevelWebhookMergeRecord(fetched, record)
		highLevelWebhookFill(record, "id", conversationID)
		highLevelWebhookFill(record, "conversationId", conversationID)
	}
	highLevelWebhookFill(record, "contactId", highLevelWebhookContactID(payload))
	highLevelWebhookFill(record, "locationId", payload.LocationID)
	contact, ok, err := rt.resolveRecordContact(record)
	if err != nil {
		return SyncRequest{}, false, err
	}
	if !ok {
		return SyncRequest{}, false, nil
	}
	event, ok := mapHighLevelConversationEvent(record, contact, rt.integration)
	if !ok {
		return SyncRequest{}, false, nil
	}
	applyHighLevelWebhookEventMetadata(&event, payload)
	return normalizeSyncRequest(SyncRequest{
		RunMode: "webhook",
		Events:  []EventInput{event},
		Cursor:  "highlevel-webhook-" + strings.TrimSpace(payload.Timestamp),
	}), true, nil
}

func (rt highLevelRuntime) fetchHighLevelWebhookRecord(path string, wrappers ...string) (map[string]any, error) {
	var raw map[string]any
	if err := highLevelDoJSON(rt.ctx, rt.client, rt.baseURL, rt.creds, rt.userAgent, http.MethodGet, path, nil, &raw); err != nil {
		return nil, err
	}
	for _, wrapper := range wrappers {
		if record := highLevelMapValue(raw[wrapper]); len(record) > 0 {
			return record, nil
		}
	}
	return raw, nil
}

func highLevelWebhookPayloadRecord(raw map[string]any, wrappers ...string) map[string]any {
	for _, wrapper := range wrappers {
		if record := highLevelMapValue(raw[wrapper]); len(record) > 0 {
			return highLevelWebhookCloneRecord(record)
		}
	}
	return highLevelWebhookCloneRecord(raw)
}

func highLevelWebhookMergeRecord(primary, fallback map[string]any) map[string]any {
	out := highLevelWebhookCloneRecord(primary)
	if len(out) == 0 {
		out = map[string]any{}
	}
	for key, value := range fallback {
		if _, ok := out[key]; !ok {
			out[key] = value
		}
	}
	return out
}

func highLevelWebhookCloneRecord(record map[string]any) map[string]any {
	if len(record) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any, len(record))
	for key, value := range record {
		out[key] = value
	}
	return out
}

func highLevelWebhookFill(record map[string]any, key, value string) {
	if record == nil || strings.TrimSpace(value) == "" {
		return
	}
	if highLevelRecordString(record, key) == "" {
		record[key] = strings.TrimSpace(value)
	}
}

func highLevelWebhookContactID(payload highLevelWebhookPayload) string {
	raw := payload.Raw
	nestedAppointment := highLevelMapValue(raw["appointment"])
	return firstString(
		highLevelRecordString(raw, "contactId", "contact_id"),
		highLevelRecordString(highLevelMapValue(raw["contact"]), "id", "contactId"),
		highLevelRecordString(highLevelMapValue(raw["contactDetails"]), "id", "contactId"),
		highLevelRecordString(nestedAppointment, "contactId", "contact_id"),
		func() string {
			if highLevelWebhookObject(payload) == "contact" {
				return highLevelRecordString(raw, "id")
			}
			return ""
		}(),
	)
}

func highLevelWebhookOpportunityID(payload highLevelWebhookPayload) string {
	raw := payload.Raw
	return firstString(
		highLevelRecordString(raw, "opportunityId", "opportunity_id"),
		highLevelRecordString(highLevelMapValue(raw["opportunity"]), "id", "opportunityId"),
		func() string {
			if highLevelWebhookObject(payload) == "opportunity" {
				return highLevelRecordString(raw, "id")
			}
			return ""
		}(),
	)
}

func highLevelWebhookAppointmentID(payload highLevelWebhookPayload) string {
	raw := payload.Raw
	return firstString(
		highLevelRecordString(raw, "appointmentId", "appointment_id", "eventId", "event_id"),
		highLevelRecordString(highLevelMapValue(raw["appointment"]), "id", "eventId", "appointmentId"),
		highLevelRecordString(highLevelMapValue(raw["event"]), "id", "eventId", "appointmentId"),
		func() string {
			if highLevelWebhookObject(payload) == "appointment" {
				return highLevelRecordString(raw, "id")
			}
			return ""
		}(),
	)
}

func highLevelWebhookConversationID(payload highLevelWebhookPayload) string {
	raw := payload.Raw
	return firstString(
		highLevelRecordString(raw, "conversationId", "conversation_id", "newConversationId", "new_conversation_id"),
		highLevelRecordString(highLevelMapValue(raw["conversation"]), "id", "conversationId"),
		highLevelRecordString(highLevelMapValue(raw["message"]), "conversationId", "conversation_id"),
		func() string {
			if highLevelWebhookObject(payload) == "conversation" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(payload.Type)), "conversation") {
				return highLevelRecordString(raw, "id")
			}
			return ""
		}(),
	)
}

func highLevelWebhookMessageID(payload highLevelWebhookPayload) string {
	raw := payload.Raw
	return firstString(
		highLevelRecordString(raw, "messageId", "message_id"),
		highLevelRecordString(highLevelMapValue(raw["message"]), "id", "messageId"),
	)
}

func applyHighLevelWebhookContactMetadata(contact *ContactInput, payload highLevelWebhookPayload) {
	if contact == nil {
		return
	}
	if contact.Properties == nil {
		contact.Properties = map[string]any{}
	}
	contact.Properties["highlevel_webhook_type"] = payload.Type
	contact.Properties["highlevel_webhook_topic"] = highLevelWebhookTopic(payload)
	contact.Properties["highlevel_webhook_location_id"] = strings.TrimSpace(payload.LocationID)
	contact.Properties["highlevel_webhook_timestamp"] = strings.TrimSpace(payload.Timestamp)
}

func applyHighLevelWebhookEventMetadata(event *EventInput, payload highLevelWebhookPayload) {
	if event == nil {
		return
	}
	if event.Properties == nil {
		event.Properties = map[string]any{}
	}
	event.Properties["highlevel_webhook_type"] = payload.Type
	event.Properties["highlevel_webhook_topic"] = highLevelWebhookTopic(payload)
	event.Properties["highlevel_webhook_location_id"] = strings.TrimSpace(payload.LocationID)
	event.Properties["highlevel_webhook_timestamp"] = strings.TrimSpace(payload.Timestamp)
	if messageID := highLevelWebhookMessageID(payload); messageID != "" {
		event.Properties["highlevel_webhook_message_id"] = messageID
	}
}
