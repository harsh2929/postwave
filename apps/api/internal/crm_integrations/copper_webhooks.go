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
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

type copperWebhookIntegrationFinder interface {
	FindCopperIntegrationByWebhookToken(context.Context, string) (*Integration, error)
}

type copperWebhookPayload struct {
	IDs               []json.Number  `json:"ids"`
	Type              string         `json:"type"`
	Event             string         `json:"event"`
	SubscriptionID    json.Number    `json:"subscription_id"`
	Timestamp         string         `json:"timestamp"`
	UpdatedAttributes map[string]any `json:"updated_attributes"`
}

func (d *Deps) CopperWebhook(w http.ResponseWriter, r *http.Request) {
	routeToken := strings.TrimSpace(chi.URLParam(r, "webhook_token"))
	if routeToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "Copper webhook route token is required")
		return
	}
	finder, ok := d.Repo.(copperWebhookIntegrationFinder)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "Copper webhook lookup is not configured")
		return
	}
	integration, err := finder.FindCopperIntegrationByWebhookToken(r.Context(), routeToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "Copper integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, crmJSONMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "Copper webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read Copper webhook body")
		return
	}
	payload, err := decodeCopperWebhookPayload(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if err := validateCopperWebhookRouteIdentity(payload, *integration); err != nil {
		if d.Logger != nil {
			d.Logger.Warn("copper webhook identity mismatch", "integration", integration.ID, "err", err.Error())
		}
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Copper integration not found")
		return
	}
	current, err := d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Copper integration not found")
		return
	}
	integration = current
	deliveryID := copperWebhookDeliveryID(payload, body)
	topic := copperWebhookTopic(payload)
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID, topic, body)
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
	req, handled, err := d.mapCopperWebhookSyncRequest(r.Context(), payload, *integration)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "event_id": deliveryID})
		return
	}
	current, err = d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID, err)
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID, errCRMIntegrationDisconnected)
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "Copper integration not found")
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "Copper webhook sync failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_sync_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderCopper, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

func decodeCopperWebhookPayload(body []byte) (copperWebhookPayload, error) {
	var out copperWebhookPayload
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	if err := dec.Decode(&out); err != nil {
		return copperWebhookPayload{}, fmt.Errorf("decode copper webhook body: %w", err)
	}
	out.Type = strings.ToLower(strings.TrimSpace(out.Type))
	out.Event = strings.ToLower(strings.TrimSpace(out.Event))
	if len(out.IDs) == 0 || out.Type == "" || out.Event == "" {
		return copperWebhookPayload{}, fmt.Errorf("copper webhook ids, type, and event are required")
	}
	return out, nil
}

func validateCopperWebhookRouteIdentity(payload copperWebhookPayload, integration Integration) error {
	gotSubscriptionID := strings.TrimSpace(payload.SubscriptionID.String())
	wantSubscriptionID := strings.TrimSpace(firstString(
		settingString(integration.Settings, "copper_webhook_subscription_id"),
		settingString(integration.Settings, "webhook_subscription_id"),
		settingString(integration.Settings, "copper_webhook_id"),
	))
	if gotSubscriptionID != "" && wantSubscriptionID != "" && gotSubscriptionID != wantSubscriptionID {
		return fmt.Errorf("copper webhook subscription_id mismatch")
	}
	return nil
}

func copperWebhookDeliveryID(payload copperWebhookPayload, body []byte) string {
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	parts := []string{
		strings.TrimSpace(payload.SubscriptionID.String()),
		copperWebhookTopic(payload),
		strings.Join(copperWebhookIDs(payload), ","),
		strings.TrimSpace(payload.Timestamp),
	}
	return "copper:" + firstString(strings.Join(uniqueCRMStrings(parts), ":"), bodyHash)
}

func copperWebhookTopic(payload copperWebhookPayload) string {
	event := payload.Event
	switch event {
	case "new":
		event = "created"
	case "update":
		event = "updated"
	case "delete":
		event = "deleted"
	}
	return firstString(payload.Type, "unknown") + "." + firstString(event, "unknown")
}

func copperWebhookIDs(payload copperWebhookPayload) []string {
	out := make([]string, 0, len(payload.IDs))
	for _, id := range payload.IDs {
		if value := strings.TrimSpace(id.String()); value != "" {
			out = append(out, value)
		}
	}
	return uniqueCRMStrings(out)
}

func (d *Deps) mapCopperWebhookSyncRequest(ctx context.Context, payload copperWebhookPayload, integration Integration) (SyncRequest, bool, error) {
	if payload.Event == "delete" {
		return SyncRequest{}, false, nil
	}
	if d.CopperCredentials == nil {
		return SyncRequest{}, false, fmt.Errorf("copper credential resolver is not configured")
	}
	creds, err := d.CopperCredentials.ResolveCopper(ctx, integration.TenantID, integration)
	if err != nil {
		return SyncRequest{}, false, err
	}
	runtime := copperRuntime{
		ctx:         ctx,
		client:      crmHTTPClient(nil, ProviderCopper),
		baseURL:     firstString(strings.TrimRight(settingString(integration.Settings, "api_base_url"), "/"), strings.TrimRight(creds.APIBaseURL, "/"), copperDefaultAPIBaseURL),
		headers:     copperAuthHeaders(creds),
		userAgent:   firstString(creds.UserAgent, copperDefaultUserAgent),
		integration: integration,
	}
	contacts := make([]ContactInput, 0, len(payload.IDs))
	events := make([]EventInput, 0, len(payload.IDs))
	for _, id := range copperWebhookIDs(payload) {
		switch payload.Type {
		case "person":
			person, err := runtime.fetchPerson(id)
			if err != nil {
				return SyncRequest{}, false, err
			}
			if mapped, ok := mapCopperPerson(person, integration); ok {
				applyCopperWebhookContactMetadata(&mapped, payload)
				contacts = append(contacts, mapped)
			}
		case "company":
			company, err := runtime.fetchRecord("companies", id)
			if err != nil {
				return SyncRequest{}, false, err
			}
			contact, ok, err := runtime.companyContact(company)
			if err != nil {
				return SyncRequest{}, false, err
			}
			if ok {
				applyCopperWebhookContactMetadata(&contact, payload)
				contacts = append(contacts, contact)
			}
		case "opportunity":
			opportunity, err := runtime.fetchRecord("opportunities", id)
			if err != nil {
				return SyncRequest{}, false, err
			}
			resolved, ok, err := runtime.resolveOpportunityContact(opportunity)
			if err != nil {
				return SyncRequest{}, false, err
			}
			if ok {
				if event, ok := mapCopperOpportunityEvent(opportunity, resolved, integration, payload.Event); ok {
					applyCopperWebhookEventMetadata(&event, payload)
					events = append(events, event)
				}
			}
		case "project":
			project, err := runtime.fetchRecord("projects", id)
			if err != nil {
				return SyncRequest{}, false, err
			}
			resolved, ok, err := runtime.resolveRelatedContact(project)
			if err != nil {
				return SyncRequest{}, false, err
			}
			if ok {
				if event, ok := mapCopperProjectEvent(project, resolved, integration, payload.Event); ok {
					applyCopperWebhookEventMetadata(&event, payload)
					events = append(events, event)
				}
			}
		case "activity":
			activity, err := runtime.fetchRecord("activities", id)
			if err != nil {
				return SyncRequest{}, false, err
			}
			resolved, ok, err := runtime.resolveRelatedContact(activity)
			if err != nil {
				return SyncRequest{}, false, err
			}
			if ok {
				if event, ok := mapCopperActivityEvent(activity, resolved, integration, payload.Event); ok {
					applyCopperWebhookEventMetadata(&event, payload)
					events = append(events, event)
				}
			}
		default:
			return SyncRequest{}, false, nil
		}
	}
	if len(contacts) == 0 && len(events) == 0 {
		return SyncRequest{}, false, nil
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: contacts, Events: events, Cursor: "copper-webhook-" + strings.TrimSpace(payload.Timestamp)}), true, nil
}

func applyCopperWebhookContactMetadata(contact *ContactInput, payload copperWebhookPayload) {
	if contact == nil {
		return
	}
	contact.Properties = copperEnsureProperties(contact.Properties)
	contact.Properties["copper_webhook_event"] = payload.Event
	contact.Properties["copper_webhook_subscription_id"] = strings.TrimSpace(payload.SubscriptionID.String())
	contact.Properties["copper_webhook_timestamp"] = strings.TrimSpace(payload.Timestamp)
}

func applyCopperWebhookEventMetadata(event *EventInput, payload copperWebhookPayload) {
	if event == nil {
		return
	}
	event.Properties = copperEnsureProperties(event.Properties)
	event.Properties["copper_webhook_event"] = payload.Event
	event.Properties["copper_webhook_subscription_id"] = strings.TrimSpace(payload.SubscriptionID.String())
	event.Properties["copper_webhook_timestamp"] = strings.TrimSpace(payload.Timestamp)
}
