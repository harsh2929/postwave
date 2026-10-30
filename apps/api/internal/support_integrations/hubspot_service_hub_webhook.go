// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
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

const hubSpotServiceHubWebhookV3DefaultTolerance = 5 * time.Minute

var (
	ErrMissingHubSpotServiceHubWebhookSecret    = errors.New("hubspot service hub webhook client secret is required")
	ErrMissingHubSpotServiceHubWebhookSignature = errors.New("hubspot service hub webhook signature is required")
	ErrInvalidHubSpotServiceHubWebhookSignature = errors.New("invalid hubspot service hub webhook signature")
	ErrStaleHubSpotServiceHubWebhookSignature   = errors.New("stale hubspot service hub webhook timestamp")
)

type HubSpotServiceHubWebhookStore interface {
	FindHubSpotServiceHubIntegrationByPortal(ctx context.Context, portalID, webhookID string) (*Integration, error)
}

type hubSpotServiceHubWebhookEvent struct {
	EventID          json.Number `json:"eventId"`
	SubscriptionType string      `json:"subscriptionType"`
	PortalID         json.Number `json:"portalId"`
	ObjectID         json.Number `json:"objectId"`
	OccurredAt       int64       `json:"occurredAt"`
	PropertyName     string      `json:"propertyName,omitempty"`
}

type HubSpotServiceHubWebhookSummary struct {
	Received  int `json:"received"`
	Processed int `json:"processed"`
	Ignored   int `json:"ignored"`
	Duplicate int `json:"duplicate"`
}

// HubSpotServiceHubWebhook receives HubSpot app webhook batches for Service Hub
// ticket events. HubSpot signs the exact method + absolute request URI + body +
// timestamp with the app client secret.
func (d *Deps) HubSpotServiceHubWebhook(w http.ResponseWriter, r *http.Request) {
	portalID := strings.TrimSpace(chi.URLParam(r, "portal_id"))
	body, err := httpbody.ReadAtMost(r.Body, supportIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "hubspot service hub payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read hubspot service hub webhook body")
		return
	}
	events, err := decodeHubSpotServiceHubWebhookEvents(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if portalID == "" {
		var ok bool
		portalID, ok = hubSpotServiceHubWebhookPortalID(events)
		if !ok {
			httperror.Write(w, http.StatusBadRequest, "missing_portal_id", "hubspot service hub webhook payload must contain one portalId")
			return
		}
	}
	store, ok := d.Repo.(HubSpotServiceHubWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "hubspot service hub webhook lookup is not configured")
		return
	}
	webhookID := hubSpotServiceHubWebhookID(r)
	integration, err := store.FindHubSpotServiceHubIntegrationByPortal(r.Context(), portalID, webhookID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "hubspot service hub integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	secret, err := d.hubSpotServiceHubWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifyHubSpotServiceHubWebhookV3(secret, r.Method, d.hubSpotServiceHubWebhookRequestURI(r), body, r.Header.Get("X-HubSpot-Signature-v3"), r.Header.Get("X-HubSpot-Request-Timestamp"), d.now(), hubSpotServiceHubWebhookV3DefaultTolerance); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	if !hubSpotServiceHubWebhookPortalMatches(portalID, events) {
		httperror.Write(w, http.StatusBadRequest, "portal_mismatch", "hubspot service hub webhook portal does not match route")
		return
	}
	claimStore, ok := d.Repo.(SupportWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "support webhook claim storage is not configured")
		return
	}
	summary, err := d.processHubSpotServiceHubWebhookEvents(r.Context(), integration, claimStore, webhookID, events, body)
	if err != nil {
		writeHubSpotServiceHubWebhookRefreshError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) processHubSpotServiceHubWebhookEvents(ctx context.Context, integration *Integration, claimStore SupportWebhookClaimStore, webhookID string, events []hubSpotServiceHubWebhookEvent, body []byte) (HubSpotServiceHubWebhookSummary, error) {
	summary := HubSpotServiceHubWebhookSummary{Received: len(events)}
	for _, ev := range events {
		topic := strings.TrimSpace(ev.SubscriptionType)
		if !hubSpotServiceHubTicketWebhookTopic(topic) {
			summary.Ignored++
			continue
		}
		eventID := strings.TrimSpace(ev.EventID.String())
		objectID := strings.TrimSpace(ev.ObjectID.String())
		if eventID == "" || objectID == "" {
			summary.Ignored++
			continue
		}
		deliveryID := "hubspot-service-hub:" + eventID
		claim, err := claimStore.ClaimSupportWebhook(ctx, integration.TenantID, integration.ID, ProviderHubSpotServiceHub, deliveryID, topic, body)
		if err != nil {
			return summary, err
		}
		if claim == WebhookProcessed || claim == WebhookInProgress {
			summary.Duplicate++
			continue
		}
		req, ok, err := d.refreshHubSpotServiceHubWebhookTicket(ctx, integration, objectID, ev, webhookID)
		if err != nil {
			if hubSpotServiceHubRefreshTicketMissing(err) {
				if markErr := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderHubSpotServiceHub, deliveryID); markErr != nil {
					return summary, markErr
				}
				summary.Ignored++
				continue
			}
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderHubSpotServiceHub, deliveryID, err)
			return summary, err
		}
		if !ok {
			if err := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderHubSpotServiceHub, deliveryID); err != nil {
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
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderHubSpotServiceHub, deliveryID, err)
			return summary, err
		}
		syncSummary.RunID = run.ID
		if syncSummary.Status == "failed" {
			err := errors.New(firstString(syncSummary.ErrorMessage, "hubspot service hub webhook processing failed"))
			_ = claimStore.MarkSupportWebhookFailed(ctx, integration.TenantID, ProviderHubSpotServiceHub, deliveryID, err)
			return summary, err
		}
		if err := claimStore.MarkSupportWebhookProcessed(ctx, integration.TenantID, ProviderHubSpotServiceHub, deliveryID); err != nil {
			return summary, err
		}
		summary.Processed++
	}
	return summary, nil
}

func (d *Deps) refreshHubSpotServiceHubWebhookTicket(ctx context.Context, integration *Integration, ticketID string, ev hubSpotServiceHubWebhookEvent, webhookID string) (SyncRequest, bool, error) {
	refresher, ok := d.HubSpotServiceHubBackfiller.(HubSpotServiceHubTicketRefresher)
	if !ok || refresher == nil {
		return SyncRequest{}, false, fmt.Errorf("hubspot service hub ticket refresh is not configured")
	}
	req, err := refresher.RefreshTicket(ctx, integration.TenantID, *integration, ticketID)
	if err != nil {
		return SyncRequest{}, false, err
	}
	req.RunMode = "webhook"
	req.Cursor = "hubspot-service-hub-webhook-" + firstString(strings.TrimSpace(ev.EventID.String()), ticketID)
	for i := range req.Tickets {
		if req.Tickets[i].Properties == nil {
			req.Tickets[i].Properties = map[string]any{}
		}
		req.Tickets[i].Properties["hubspot_portal_id"] = strings.TrimSpace(ev.PortalID.String())
		req.Tickets[i].Properties["hubspot_ticket_id"] = ticketID
		req.Tickets[i].Properties["hubspot_webhook_id"] = strings.TrimSpace(webhookID)
		req.Tickets[i].Properties["hubspot_webhook_event"] = strings.TrimSpace(ev.SubscriptionType)
		req.Tickets[i].Properties["hubspot_webhook_property"] = strings.TrimSpace(ev.PropertyName)
		req.Tickets[i].Properties["hubspot_refresh_source"] = "webhook_sparse_ticket"
	}
	req = normalizeSyncRequest(req)
	if len(req.Tickets)+len(req.Messages)+len(req.Events) == 0 {
		return req, false, nil
	}
	return req, true, nil
}

func (d *Deps) hubSpotServiceHubWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d != nil && strings.TrimSpace(d.HubSpotWebhookClientSecret) != "" {
		return strings.TrimSpace(d.HubSpotWebhookClientSecret), nil
	}
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingHubSpotServiceHubWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "hubspot_service_hub_webhook_secret_ref"),
		settingString(integration.Settings, "hubspot_webhook_secret_ref"),
		settingString(integration.Settings, "hubspot_client_secret_ref"),
		settingString(integration.Settings, "webhook_signature_ref"),
		settingString(integration.Settings, "webhook_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingHubSpotServiceHubWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingHubSpotServiceHubWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func VerifyHubSpotServiceHubWebhookV3(clientSecret, method, requestURI string, body []byte, signature, timestamp string, now time.Time, tolerance time.Duration) error {
	clientSecret = strings.TrimSpace(clientSecret)
	signature = strings.TrimSpace(signature)
	timestamp = strings.TrimSpace(timestamp)
	if clientSecret == "" {
		return ErrMissingHubSpotServiceHubWebhookSecret
	}
	if signature == "" {
		return ErrMissingHubSpotServiceHubWebhookSignature
	}
	if timestamp == "" {
		return ErrStaleHubSpotServiceHubWebhookSignature
	}
	if tolerance <= 0 {
		tolerance = hubSpotServiceHubWebhookV3DefaultTolerance
	}
	ms, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return fmt.Errorf("%w: timestamp is not a unix-millis integer", ErrStaleHubSpotServiceHubWebhookSignature)
	}
	if drift := now.Sub(time.UnixMilli(ms)); drift > tolerance || drift < -tolerance {
		return ErrStaleHubSpotServiceHubWebhookSignature
	}
	mac := hmac.New(sha256.New, []byte(clientSecret))
	mac.Write([]byte(method))
	mac.Write([]byte(requestURI))
	mac.Write(body)
	mac.Write([]byte(timestamp))
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return ErrInvalidHubSpotServiceHubWebhookSignature
	}
	return nil
}

func decodeHubSpotServiceHubWebhookEvents(body []byte) ([]hubSpotServiceHubWebhookEvent, error) {
	var events []hubSpotServiceHubWebhookEvent
	if err := json.Unmarshal(body, &events); err != nil {
		return nil, fmt.Errorf("decode hubspot service hub webhook payload: %w", err)
	}
	return events, nil
}

func hubSpotServiceHubTicketWebhookTopic(topic string) bool {
	switch strings.ToLower(strings.TrimSpace(topic)) {
	case "ticket.creation", "ticket.propertychange", "ticket.deletion":
		return true
	default:
		return false
	}
}

func hubSpotServiceHubWebhookPortalMatches(portalID string, events []hubSpotServiceHubWebhookEvent) bool {
	portalID = strings.TrimSpace(portalID)
	for _, ev := range events {
		eventPortal := strings.TrimSpace(ev.PortalID.String())
		if eventPortal != "" && eventPortal != portalID {
			return false
		}
	}
	return true
}

func hubSpotServiceHubWebhookPortalID(events []hubSpotServiceHubWebhookEvent) (string, bool) {
	var portalID string
	for _, ev := range events {
		eventPortal := strings.TrimSpace(ev.PortalID.String())
		if eventPortal == "" {
			continue
		}
		if portalID == "" {
			portalID = eventPortal
			continue
		}
		if eventPortal != portalID {
			return "", false
		}
	}
	return portalID, portalID != ""
}

func hubSpotServiceHubRefreshTicketMissing(err error) bool {
	var restErr HubSpotServiceHubRESTError
	if errors.As(err, &restErr) {
		return restErr.StatusCode == http.StatusNotFound || restErr.StatusCode == http.StatusGone
	}
	return false
}

func writeHubSpotServiceHubWebhookRefreshError(w http.ResponseWriter, err error) {
	var restErr HubSpotServiceHubRESTError
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
	httperror.Write(w, http.StatusServiceUnavailable, "hubspot_service_hub_refresh_failed", httperror.MessageInternal)
}

func (d *Deps) hubSpotServiceHubWebhookRequestURI(r *http.Request) string {
	base := strings.TrimRight(d.publicBaseURL(r), "/")
	if base == "" {
		scheme := "https"
		if r.TLS == nil && strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")) == "" {
			scheme = "http"
		}
		base = scheme + "://" + r.Host
	}
	return base + r.URL.RequestURI()
}

func (d *Deps) publicBaseURL(r *http.Request) string {
	if d != nil && strings.TrimSpace(d.PublicBaseURL) != "" {
		return strings.TrimRight(strings.TrimSpace(d.PublicBaseURL), "/")
	}
	if r == nil {
		return ""
	}
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return ""
	}
	proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return strings.TrimRight(proto+"://"+host, "/")
}

func hubSpotServiceHubWebhookID(r *http.Request) string {
	return strings.TrimSpace(firstString(
		r.Header.Get("X-HubSpot-Webhook-Id"),
		r.Header.Get("X-HubSpot-Webhook-ID"),
		r.URL.Query().Get("webhook_id"),
		r.URL.Query().Get("hubspot_webhook_id"),
		r.URL.Query().Get("hubspot_service_hub_webhook_id"),
	))
}
