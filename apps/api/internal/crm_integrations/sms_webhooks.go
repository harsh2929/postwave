// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"crypto/hmac"
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

var (
	ErrMissingPostscriptWebhookSignature = errors.New("postscript webhook signature is required")
	ErrInvalidPostscriptWebhookSignature = errors.New("invalid postscript webhook signature")
	ErrMissingAttentiveWebhookSignature  = errors.New("attentive webhook signature is required")
	ErrInvalidAttentiveWebhookSignature  = errors.New("invalid attentive webhook signature")
)

type postscriptWebhookPayload struct {
	WebhookID    string         `json:"webhook_id"`
	ResourceType string         `json:"resource_type"`
	ResourceID   string         `json:"resource_id"`
	EventTime    string         `json:"event_time"`
	Event        string         `json:"event"`
	EventData    map[string]any `json:"event_data"`
}

type attentiveWebhookPayload struct {
	Type             string         `json:"type"`
	Timestamp        int64          `json:"timestamp"`
	Company          map[string]any `json:"company"`
	Subscriber       map[string]any `json:"subscriber"`
	Creative         map[string]any `json:"creative"`
	Subscription     map[string]any `json:"subscription"`
	Message          map[string]any `json:"message"`
	MessageLinkClick map[string]any `json:"message_link_click"`
	UserProperty     map[string]any `json:"user_property"`
}

type smsWebhookIntegrationFinder interface {
	FindSMSIntegrationByWebhookToken(context.Context, string, string) (*Integration, error)
}

func (d *Deps) PostscriptWebhook(w http.ResponseWriter, r *http.Request) {
	d.smsWebhook(w, r, ProviderPostscript)
}

func (d *Deps) AttentiveWebhook(w http.ResponseWriter, r *http.Request) {
	d.smsWebhook(w, r, ProviderAttentive)
}

func (d *Deps) smsWebhook(w http.ResponseWriter, r *http.Request, provider string) {
	routeToken := strings.TrimSpace(chi.URLParam(r, "webhook_token"))
	if routeToken == "" {
		httperror.Write(w, http.StatusUnauthorized, "missing_webhook_token", "SMS webhook route token is required")
		return
	}
	finder, ok := d.Repo.(smsWebhookIntegrationFinder)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "SMS webhook lookup is not configured")
		return
	}
	integration, err := finder.FindSMSIntegrationByWebhookToken(r.Context(), provider, routeToken)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "SMS integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, crmJSONMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "SMS webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read SMS webhook body")
		return
	}
	if err := d.verifySMSWebhookSignature(r.Context(), provider, integration, body, r); err != nil {
		if errors.Is(err, ErrMissingPostscriptWebhookSignature) || errors.Is(err, ErrInvalidPostscriptWebhookSignature) ||
			errors.Is(err, ErrMissingAttentiveWebhookSignature) || errors.Is(err, ErrInvalidAttentiveWebhookSignature) {
			httperror.Write(w, http.StatusUnauthorized, "invalid_webhook_signature", "request authentication failed")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	current, err := d.Repo.GetIntegration(r.Context(), integration.TenantID, integration.ID)
	if err != nil {
		d.writeRepoError(w, r, integration.TenantID, err)
		return
	}
	if crmIntegrationDisconnected(current) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "SMS integration not found")
		return
	}
	integration = current
	req, deliveryID, topic, handled, err := mapSMSWebhookSyncRequest(provider, *integration, body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	claim, err := d.Repo.ClaimWebhook(r.Context(), integration.TenantID, integration.ID, provider, deliveryID, topic, body)
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
	if !handled {
		if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, provider, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true, "event_id": deliveryID})
		return
	}
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, provider, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "SMS webhook sync failed"))
		_ = d.Repo.MarkWebhookFailed(r.Context(), integration.TenantID, integration.ID, provider, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_sync_failed", httperror.MessageInternal)
		return
	}
	if err := d.Repo.MarkWebhookProcessed(r.Context(), integration.TenantID, integration.ID, provider, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (d *Deps) verifySMSWebhookSignature(ctx context.Context, provider string, integration *Integration, body []byte, r *http.Request) error {
	switch provider {
	case ProviderPostscript:
		if d.PostscriptCredentials == nil {
			return fmt.Errorf("postscript credential resolver is not configured")
		}
		creds, err := d.PostscriptCredentials.ResolvePostscript(ctx, integration.TenantID, *integration)
		if err != nil {
			return err
		}
		return VerifyPostscriptWebhookSignature(creds.WebhookSigningToken, r.Header.Get("Postscript-Signature"))
	case ProviderAttentive:
		if d.AttentiveCredentials == nil {
			return fmt.Errorf("attentive credential resolver is not configured")
		}
		creds, err := d.AttentiveCredentials.ResolveAttentive(ctx, integration.TenantID, *integration)
		if err != nil {
			return err
		}
		return VerifyAttentiveWebhookSignature(creds.WebhookSecret, body, r.Header.Get("x-attentive-hmac-sha256"))
	default:
		return fmt.Errorf("unsupported SMS webhook provider %q", provider)
	}
}

func VerifyPostscriptWebhookSignature(signingToken, header string) error {
	signingToken = strings.TrimSpace(signingToken)
	header = strings.TrimSpace(header)
	if signingToken == "" || header == "" {
		return ErrMissingPostscriptWebhookSignature
	}
	if !hmac.Equal([]byte(signingToken), []byte(header)) {
		return ErrInvalidPostscriptWebhookSignature
	}
	return nil
}

func VerifyAttentiveWebhookSignature(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(strings.TrimPrefix(header, "sha256="))
	if secret == "" || header == "" {
		return ErrMissingAttentiveWebhookSignature
	}
	expected := hmac.New(sha256.New, []byte(secret))
	_, _ = expected.Write(body)
	if !hmac.Equal([]byte(hex.EncodeToString(expected.Sum(nil))), []byte(strings.ToLower(header))) {
		return ErrInvalidAttentiveWebhookSignature
	}
	return nil
}

func mapSMSWebhookSyncRequest(provider string, integration Integration, body []byte) (SyncRequest, string, string, bool, error) {
	switch provider {
	case ProviderPostscript:
		var payload postscriptWebhookPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			return SyncRequest{}, "", "", false, err
		}
		return mapPostscriptWebhookSyncRequest(payload, integration, body)
	case ProviderAttentive:
		var payload attentiveWebhookPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			return SyncRequest{}, "", "", false, err
		}
		return mapAttentiveWebhookSyncRequest(payload, integration, body)
	default:
		return SyncRequest{}, "", "", false, fmt.Errorf("unsupported SMS webhook provider %q", provider)
	}
}

func mapPostscriptWebhookSyncRequest(payload postscriptWebhookPayload, integration Integration, body []byte) (SyncRequest, string, string, bool, error) {
	topic := strings.TrimSpace(payload.Event)
	if topic == "" {
		return SyncRequest{}, "", "", false, fmt.Errorf("postscript event is required")
	}
	deliveryID := postscriptWebhookDeliveryID(payload, body)
	eventName := postscriptWebhookEventName(topic)
	if eventName == "" {
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: deliveryID}), deliveryID, topic, false, nil
	}
	data := payload.EventData
	phone := firstString(smsString(data, "from_number"), smsString(data, "phone_number"), smsString(data, "phone"), smsString(data, "subscriber_phone"))
	email := strings.ToLower(firstString(smsString(data, "email"), smsString(data, "subscriber_email")))
	subscriberID := firstString(smsString(data, "subscriber_id"), smsString(data, "id"), phone, email)
	occurred := smsParseTimestamp(firstString(payload.EventTime, smsString(data, "created_at")))
	contact := ContactInput{
		SourceID:   "postscript://subscriber/" + subscriberID,
		Email:      email,
		Phone:      phone,
		ListIDs:    crmListIDs(integration),
		Tags:       crmDefaultTags(integration, "postscript"),
		Properties: map[string]any{"postscript_id": subscriberID, "sms_phone": phone, "sms_channel": "postscript", "webhook_topic": topic},
	}
	event := EventInput{
		SourceID:   "postscript://webhook/" + firstString(smsString(data, "id"), deliveryID),
		Email:      email,
		Phone:      phone,
		EventName:  eventName,
		OccurredAt: occurred,
		Properties: smsWebhookProperties(map[string]any{
			"delivery_id":    deliveryID,
			"provider_event": topic,
			"webhook_id":     payload.WebhookID,
			"resource_type":  payload.ResourceType,
			"resource_id":    payload.ResourceID,
			"subscriber_id":  subscriberID,
			"from_number":    phone,
			"body":           smsString(data, "body"),
			"is_opt_out":     data["is_opt_out"],
		}),
	}
	contacts := []ContactInput{}
	if contact.Email != "" || contact.Phone != "" {
		contacts = append(contacts, contact)
	}
	events := []EventInput{}
	if event.Email != "" || event.Phone != "" {
		events = append(events, event)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: contacts, Events: events, Cursor: deliveryID}), deliveryID, topic, len(contacts)+len(events) > 0, nil
}

func postscriptWebhookEventName(topic string) string {
	switch strings.TrimSpace(topic) {
	case "shop.incoming_message":
		return "sms.inbound_message"
	case "shop.subscriber.opt_in":
		return "sms.subscribed"
	case "shop.subscriber.opt_out":
		return "sms.unsubscribed"
	default:
		return ""
	}
}

func postscriptWebhookDeliveryID(payload postscriptWebhookPayload, body []byte) string {
	data := payload.EventData
	sum := sha256.Sum256(body)
	return "postscript:" + firstString(
		strings.Join(uniqueCRMStrings([]string{payload.WebhookID, payload.Event, payload.EventTime, smsString(data, "id"), smsString(data, "subscriber_id"), smsString(data, "from_number"), smsString(data, "phone")}), ":"),
		hex.EncodeToString(sum[:]),
	)
}

func mapAttentiveWebhookSyncRequest(payload attentiveWebhookPayload, integration Integration, body []byte) (SyncRequest, string, string, bool, error) {
	topic := strings.TrimSpace(payload.Type)
	if topic == "" {
		return SyncRequest{}, "", "", false, fmt.Errorf("attentive type is required")
	}
	if !attentiveWebhookTopicHandled(topic) {
		deliveryID := attentiveWebhookDeliveryID(payload, body)
		return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Cursor: deliveryID}), deliveryID, topic, false, nil
	}
	subscriber := payload.Subscriber
	phone := smsString(subscriber, "phone")
	email := strings.ToLower(smsString(subscriber, "email"))
	externalID := firstString(smsString(subscriber, "external_id"), phone, email)
	deliveryID := attentiveWebhookDeliveryID(payload, body)
	occurred := smsUnixMillis(payload.Timestamp)
	contact := ContactInput{
		SourceID:   "attentive://subscriber/" + externalID,
		Email:      email,
		Phone:      phone,
		ListIDs:    crmListIDs(integration),
		Tags:       crmDefaultTags(integration, "attentive"),
		Properties: map[string]any{"attentive_id": externalID, "sms_phone": phone, "sms_channel": "attentive", "webhook_topic": topic},
	}
	event := EventInput{
		SourceID:   "attentive://webhook/" + deliveryID,
		Email:      email,
		Phone:      phone,
		EventName:  topic,
		OccurredAt: occurred,
		Properties: smsWebhookProperties(map[string]any{
			"delivery_id":         deliveryID,
			"provider_event":      topic,
			"subscriber_id":       externalID,
			"company_id":          smsString(payload.Company, "company_id"),
			"company_name":        smsString(payload.Company, "display_name"),
			"creative_name":       smsString(payload.Creative, "name"),
			"creative_type":       smsString(payload.Creative, "type"),
			"subscription_type":   smsString(payload.Subscription, "type"),
			"message_id":          firstString(smsString(payload.Message, "id"), smsString(payload.MessageLinkClick, "messageId")),
			"message_type":        firstString(smsString(payload.Message, "type"), smsString(payload.MessageLinkClick, "messageType")),
			"message_text":        smsString(payload.Message, "text"),
			"to_phone":            smsString(payload.Message, "to_phone"),
			"link_target":         firstString(smsString(payload.MessageLinkClick, "linkTarget"), smsString(payload.MessageLinkClick, "link_target")),
			"user_property_id":    smsString(payload.UserProperty, "id"),
			"user_property_name":  smsString(payload.UserProperty, "name"),
			"user_property_value": smsString(payload.UserProperty, "value"),
		}),
	}
	contacts := []ContactInput{}
	if contact.Email != "" || contact.Phone != "" {
		contacts = append(contacts, contact)
	}
	events := []EventInput{}
	if event.Email != "" || event.Phone != "" {
		events = append(events, event)
	}
	return normalizeSyncRequest(SyncRequest{RunMode: "webhook", Contacts: contacts, Events: events, Cursor: deliveryID}), deliveryID, topic, len(contacts)+len(events) > 0, nil
}

func attentiveWebhookTopicHandled(topic string) bool {
	switch strings.TrimSpace(topic) {
	case "sms.subscribed", "sms.unsubscribed", "sms.inbound_message", "sms.sent", "sms.message_link_click", "custom_attribute.set":
		return true
	default:
		return false
	}
}

func attentiveWebhookDeliveryID(payload attentiveWebhookPayload, body []byte) string {
	sum := sha256.Sum256(body)
	return "attentive:" + firstString(
		strings.Join(uniqueCRMStrings([]string{payload.Type, strconv.FormatInt(payload.Timestamp, 10), smsString(payload.Subscriber, "external_id"), smsString(payload.Subscriber, "phone"), smsString(payload.Message, "id"), smsString(payload.MessageLinkClick, "linkId")}), ":"),
		hex.EncodeToString(sum[:]),
	)
}

func smsWebhookProperties(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		switch typed := v.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				out[k] = strings.TrimSpace(typed)
			}
		case nil:
		default:
			out[k] = typed
		}
	}
	return out
}

func smsString(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	return smsAnyString(values[key])
}

func smsAnyString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return ""
	}
}

func smsParseTimestamp(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999",
		"2006-01-02T15:04:05",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, raw); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

func smsUnixMillis(value int64) *time.Time {
	if value <= 0 {
		return nil
	}
	parsed := time.UnixMilli(value).UTC()
	return &parsed
}
