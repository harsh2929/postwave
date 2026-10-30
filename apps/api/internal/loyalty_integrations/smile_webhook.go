// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

var (
	ErrMissingSmileWebhookSecret    = errors.New("smile webhook secret is required")
	ErrMissingSmileWebhookSignature = errors.New("smile webhook signature is required")
	ErrInvalidSmileWebhookSignature = errors.New("invalid smile webhook signature")
)

type SmileWebhookStore interface {
	FindSmileIntegrationByAccountID(ctx context.Context, accountID string) (*Integration, error)
}

type LoyaltyWebhookClaimStore interface {
	ClaimLoyaltyWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error)
	MarkLoyaltyWebhookProcessed(ctx context.Context, tenantID, integrationID, provider, webhookID string) error
	MarkLoyaltyWebhookFailed(ctx context.Context, tenantID, integrationID, provider, webhookID string, err error) error
}

type smileWebhookEvent struct {
	AccountID string
	Topic     string
	Customer  smileCustomer
	Raw       map[string]any
}

// SmileWebhook receives signed Smile.io app webhooks. Smile delivers one app URL
// for all authorized accounts and includes account_id in the JSON body, so the
// handler parses only routing metadata before resolving the tenant integration.
func (d *Deps) SmileWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := httpbody.ReadAtMost(r.Body, loyaltyIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "smile webhook payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read smile webhook body")
		return
	}
	event, err := decodeSmileWebhookEvent(body)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_payload", "request payload is invalid")
		return
	}
	if event.AccountID == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_account_id", "smile account_id is required")
		return
	}
	store, ok := d.Repo.(SmileWebhookStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "smile webhook lookup is not configured")
		return
	}
	integration, err := store.FindSmileIntegrationByAccountID(r.Context(), event.AccountID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "smile integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if strings.EqualFold(strings.TrimSpace(integration.Status), "disconnected") {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "smile integration not found")
		return
	}
	secret, err := d.smileWebhookSecret(r.Context(), integration)
	if err != nil {
		httperror.Write(w, http.StatusUnauthorized, "missing_signature_secret", "request authentication failed")
		return
	}
	if err := VerifySmileWebhook(secret, body, r, d.now()); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	current, err := d.currentLoyaltyIntegrationForSync(r.Context(), integration.TenantID, integration)
	if err != nil {
		if errors.Is(err, errIntegrationDisconnected) || errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "smile integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	integration = current
	claimStore, ok := d.Repo.(LoyaltyWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "loyalty webhook claim storage is not configured")
		return
	}
	deliveryID := smileWebhookDeliveryIDFromRequest(r, event, body)
	claim, err := claimStore.ClaimLoyaltyWebhook(r.Context(), integration.TenantID, integration.ID, ProviderSmile, deliveryID, event.Topic, body)
	if err != nil {
		if errors.Is(err, ErrLoyaltyWebhookBodyMismatch) {
			httperror.Write(w, http.StatusConflict, "webhook_body_mismatch", "loyalty webhook delivery body does not match the previously claimed message")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "duplicate": true})
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "smile webhook is already being processed")
		return
	}
	req, ok := mapSmileWebhookEvent(event, deliveryID)
	if !ok {
		if err := claimStore.MarkLoyaltyWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderSmile, deliveryID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true})
		return
	}
	current, err = d.currentLoyaltyIntegrationForSync(r.Context(), integration.TenantID, integration)
	if err != nil {
		_ = claimStore.MarkLoyaltyWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderSmile, deliveryID, err)
		if errors.Is(err, errIntegrationDisconnected) || errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "smile integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	integration = current
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = claimStore.MarkLoyaltyWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderSmile, deliveryID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "smile webhook processing failed"))
		_ = claimStore.MarkLoyaltyWebhookFailed(r.Context(), integration.TenantID, integration.ID, ProviderSmile, deliveryID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkLoyaltyWebhookProcessed(r.Context(), integration.TenantID, integration.ID, ProviderSmile, deliveryID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func VerifySmileWebhook(secret string, body []byte, r *http.Request, now time.Time) error {
	if strings.TrimSpace(secret) == "" {
		return ErrMissingSmileWebhookSecret
	}
	if r == nil {
		return ErrMissingSmileWebhookSignature
	}
	timestamp := strings.TrimSpace(r.Header.Get("Smile-Timestamp"))
	signature := strings.TrimSpace(r.Header.Get("Smile-Signature"))
	if timestamp == "" || signature == "" {
		return ErrMissingSmileWebhookSignature
	}
	if !VerifySmileWebhookSignature(secret, body, timestamp, signature, now) {
		return ErrInvalidSmileWebhookSignature
	}
	return nil
}

func (d *Deps) smileWebhookSecret(ctx context.Context, integration *Integration) (string, error) {
	if d == nil || d.WebhookSecrets == nil {
		return "", ErrMissingSmileWebhookSecret
	}
	ref := strings.TrimSpace(firstString(
		settingString(integration.Settings, "webhook_secret_ref"),
		settingString(integration.Settings, "smile_client_secret_ref"),
	))
	if ref == "" {
		return "", ErrMissingSmileWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(ctx, ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return "", ErrMissingSmileWebhookSecret
	}
	return strings.TrimSpace(secret), nil
}

func decodeSmileWebhookEvent(body []byte) (smileWebhookEvent, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return smileWebhookEvent{}, fmt.Errorf("decode smile webhook body: %w", err)
	}
	event := smileWebhookEvent{
		AccountID: smileWebhookStringValue(raw["account_id"]),
		Topic:     strings.TrimSpace(smileWebhookStringValue(raw["topic"])),
		Raw:       raw,
	}
	if data, _ := raw["data"].(map[string]any); data != nil {
		if customerRaw, ok := data["customer"]; ok && customerRaw != nil {
			encoded, _ := json.Marshal(customerRaw)
			_ = json.Unmarshal(encoded, &event.Customer)
		}
	}
	return event, nil
}

func mapSmileWebhookEvent(event smileWebhookEvent, deliveryID string) (SyncRequest, bool) {
	switch event.Topic {
	case "ping":
		return SyncRequest{RunMode: "webhook", Cursor: "smile-webhook-" + deliveryID}, false
	case "customer/updated":
		member, ok := mapSmileCustomer(event.Customer)
		if !ok {
			return SyncRequest{}, false
		}
		if member.Properties == nil {
			member.Properties = map[string]any{}
		}
		member.Properties["smile_account_id"] = event.AccountID
		member.Properties["smile_webhook_topic"] = event.Topic
		member.Properties["smile_webhook_delivery_id"] = deliveryID
		member.Properties["smile_webhook_source"] = "app_webhook"
		eventInput := LoyaltyEventInput{
			SourceID:   "smile://webhook/" + deliveryID,
			Email:      member.Email,
			EventName:  "loyalty.customer_updated",
			VIPTier:    member.VIPTier,
			Properties: map[string]any{"smile_account_id": event.AccountID, "smile_webhook_topic": event.Topic, "smile_customer_id": event.Customer.ID},
			OccurredAt: member.UpdatedAt,
		}
		return normalizeSyncRequest(SyncRequest{
			RunMode: "webhook",
			Members: []MemberInput{
				member,
			},
			Events: []LoyaltyEventInput{
				eventInput,
			},
			Cursor: "smile-webhook-" + smileWebhookCustomerCursor(event.Customer.ID, deliveryID),
		}), true
	default:
		return SyncRequest{RunMode: "webhook", Cursor: "smile-webhook-" + deliveryID}, false
	}
}

func smileWebhookDeliveryID(event smileWebhookEvent, body []byte) string {
	sum := sha256.Sum256(body)
	return strings.Join([]string{
		strings.TrimSpace(event.AccountID),
		strings.TrimSpace(event.Topic),
		hex.EncodeToString(sum[:]),
	}, ":")
}

func smileWebhookDeliveryIDFromRequest(r *http.Request, event smileWebhookEvent, body []byte) string {
	if r != nil {
		if value := strings.TrimSpace(firstString(
			r.Header.Get("Smile-Webhook-Id"),
			r.Header.Get("Smile-Delivery-Id"),
			r.Header.Get("Smile-Event-Id"),
			r.Header.Get("X-Webhook-Id"),
			r.Header.Get("X-Delivery-Id"),
			r.Header.Get("X-Request-Id"),
		)); value != "" {
			return strings.Join([]string{strings.TrimSpace(event.AccountID), strings.TrimSpace(event.Topic), value}, ":")
		}
	}
	for _, key := range []string{"webhook_id", "delivery_id", "event_id", "id"} {
		if value := smileWebhookStringValue(event.Raw[key]); value != "" {
			return strings.Join([]string{strings.TrimSpace(event.AccountID), strings.TrimSpace(event.Topic), value}, ":")
		}
	}
	return smileWebhookDeliveryID(event, body)
}

func smileWebhookCustomerCursor(customerID int, deliveryID string) string {
	if customerID > 0 {
		return strconv.Itoa(customerID)
	}
	return deliveryID
}

func smileWebhookStringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strings.TrimSpace(strconv.FormatFloat(typed, 'f', -1, 64))
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case nil:
		return ""
	default:
		return ""
	}
}
