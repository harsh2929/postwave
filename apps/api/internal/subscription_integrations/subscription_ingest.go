// SPDX-License-Identifier: AGPL-3.0-only
//
// subscription_ingest.go — native subscription/shipping webhook inbound runtime.
//
// Some subscription and post-purchase desks (Ordergroove, Wonderment, and any
// push-only program) expose NO bulk-list or export REST API — they only push
// events via webhooks. For those, the native integration is inbound: a public
// per-integration ingest URL carrying an opaque token resolves the owning tenant
// (before tenant context exists) via an RLS lookup policy, then a tolerant
// mapper turns the webhook body into a canonical SubscriptionInput (or, for a
// tracking/shipment event, a ShipmentInput) and lands it. Mirrors the
// loyalty/support webhook-ingest pattern for the subscription domain.
package subscription_integrations

import (
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

const subscriptionIngestMaxBodyBytes = 1 << 20

// SubscriptionIngestStore resolves a subscription integration by its public
// ingest token.
type SubscriptionIngestStore interface {
	FindSubscriptionIntegrationByIngestToken(ctx context.Context, provider, token string) (*Integration, error)
}

type SubscriptionWebhookClaimStore interface {
	ClaimSubscriptionWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error)
	MarkSubscriptionWebhookProcessed(ctx context.Context, tenantID, provider, webhookID string) error
	MarkSubscriptionWebhookFailed(ctx context.Context, tenantID, provider, webhookID string, err error) error
}

// MountPublicRoutes registers the unauthenticated subscription webhook ingest
// endpoint (per-integration token in the URL).
func MountPublicRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	r.Post("/api/public/subscription-integrations/{provider}/ingest/{token}", d.SubscriptionWebhookIngest)
}

// SubscriptionWebhookIngest receives a provider subscription/shipping webhook on
// a per-integration public URL, resolves the owning tenant by the URL token,
// verifies the optional shared secret, maps the body to a canonical
// subscription (or shipment), and lands it.
func (d *Deps) SubscriptionWebhookIngest(w http.ResponseWriter, r *http.Request) {
	provider := strings.ToLower(strings.TrimSpace(chi.URLParam(r, "provider")))
	token := strings.TrimSpace(chi.URLParam(r, "token"))
	if token == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_token", "subscription ingest token is required")
		return
	}
	store, ok := d.Repo.(SubscriptionIngestStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "ingest_unavailable", "subscription ingest lookup is not configured")
		return
	}
	integration, err := store.FindSubscriptionIntegrationByIngestToken(r.Context(), provider, token)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "integration_not_found", "subscription integration not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if subscriptionIntegrationDisconnected(integration) {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "subscription integration not found")
		return
	}
	if provider != "" && integration.Provider != provider {
		httperror.Write(w, http.StatusNotFound, "integration_not_found", "subscription integration not found")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, subscriptionIngestMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			httperror.Write(w, http.StatusRequestEntityTooLarge, "payload_too_large", "subscription payload exceeds 1 MiB")
			return
		}
		httperror.Write(w, http.StatusBadRequest, "read_failed", "failed to read ingest body")
		return
	}
	if err := d.verifySubscriptionWebhook(r, integration, body); err != nil {
		httperror.Write(w, http.StatusUnauthorized, "invalid_signature", "request authentication failed")
		return
	}
	claimStore, ok := d.Repo.(SubscriptionWebhookClaimStore)
	if !ok {
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_unavailable", "subscription webhook claim storage is not configured")
		return
	}
	topic := subscriptionWebhookTopicForClaim(r, integration, body)
	webhookID := subscriptionWebhookDeliveryID(r, integration, topic, body)
	claim, err := claimStore.ClaimSubscriptionWebhook(r.Context(), integration.TenantID, integration.ID, integration.Provider, webhookID, topic, body)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	switch claim {
	case WebhookProcessed:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "duplicate": true})
		return
	case WebhookInProgress:
		w.Header().Set("Retry-After", "10")
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_in_progress", "subscription webhook is already being processed")
		return
	}
	req, ok := mapProviderSubscriptionWebhook(r, integration, body)
	if !ok {
		if err := claimStore.MarkSubscriptionWebhookProcessed(r.Context(), integration.TenantID, integration.Provider, webhookID); err != nil {
			httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ignored": true})
		return
	}
	req = normalizeSyncRequest(req)
	started := d.now()
	summary := d.executeSync(r.Context(), integration.TenantID, integration, req)
	completed := d.now()
	run, err := d.Repo.RecordSyncRun(r.Context(), integration.TenantID, integration.ID, summary, req, started, completed)
	if err != nil {
		_ = claimStore.MarkSubscriptionWebhookFailed(r.Context(), integration.TenantID, integration.Provider, webhookID, err)
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	summary.RunID = run.ID
	if summary.Status == "failed" {
		err := errors.New(firstString(summary.ErrorMessage, "subscription webhook processing failed"))
		_ = claimStore.MarkSubscriptionWebhookFailed(r.Context(), integration.TenantID, integration.Provider, webhookID, err)
		httperror.Write(w, http.StatusServiceUnavailable, "webhook_processing_failed", httperror.MessageInternal)
		return
	}
	if err := claimStore.MarkSubscriptionWebhookProcessed(r.Context(), integration.TenantID, integration.Provider, webhookID); err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), integration.TenantID))
		return
	}
	writeJSON(w, http.StatusAccepted, summary)
}

// verifySubscriptionWebhook validates the optional webhook secret. The
// per-integration URL token is the primary auth (unguessable); a configured
// webhook_secret_ref adds a shared-secret or provider-signature check.
func (d *Deps) verifySubscriptionWebhook(r *http.Request, integration *Integration, body []byte) error {
	ref := strings.TrimSpace(settingString(integration.Settings, "webhook_secret_ref"))
	if ref == "" {
		return nil
	}
	if d.WebhookSecrets == nil {
		return ErrMissingWebhookSecret
	}
	secret, err := d.WebhookSecrets.Get(r.Context(), ref)
	if err != nil || strings.TrimSpace(secret) == "" {
		return ErrMissingWebhookSecret
	}
	if integration.Provider == ProviderRecharge {
		return VerifyRechargeWebhookSignature(secret, body, firstString(
			r.Header.Get("X-Recharge-Hmac-Sha256"),
			r.Header.Get("X-Recharge-HMAC-SHA256"),
			r.Header.Get("X-Recharge-Signature"),
		))
	}
	got := strings.TrimSpace(r.Header.Get("Authorization"))
	if rest, found := strings.CutPrefix(got, "Bearer "); found {
		got = strings.TrimSpace(rest)
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Webhook-Secret"))
	}
	if got != strings.TrimSpace(secret) {
		return fmt.Errorf("subscription webhook secret mismatch")
	}
	return nil
}

func mapProviderSubscriptionWebhook(r *http.Request, integration *Integration, body []byte) (SyncRequest, bool) {
	if integration != nil && integration.Provider == ProviderRecharge {
		if topic := rechargeWebhookTopic(r, body); topic != "" {
			if req, ok := mapRechargeWebhookEvent(topic, body, *integration); ok {
				return req, true
			}
		}
	}
	provider := ""
	if integration != nil {
		provider = integration.Provider
	}
	return mapSubscriptionWebhook(provider, body)
}

func rechargeWebhookTopic(r *http.Request, body []byte) string {
	topic := strings.TrimSpace(firstString(
		r.Header.Get("X-Recharge-Topic"),
		r.Header.Get("X-Recharge-Webhook-Topic"),
		r.Header.Get("X-Recharge-Event"),
		r.Header.Get("X-Webhook-Topic"),
		r.URL.Query().Get("topic"),
	))
	if topic != "" {
		return topic
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	return strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "topic"),
		subscriptionWebhookString(raw, "event"),
		subscriptionWebhookString(raw, "type"),
	))
}

func subscriptionWebhookTopicForClaim(r *http.Request, integration *Integration, body []byte) string {
	if integration != nil && integration.Provider == ProviderRecharge {
		if topic := rechargeWebhookTopic(r, body); topic != "" {
			return topic
		}
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err == nil {
		if topic := strings.TrimSpace(firstString(
			subscriptionWebhookString(raw, "topic"),
			subscriptionWebhookString(raw, "event"),
			subscriptionWebhookString(raw, "type"),
			subscriptionWebhookString(raw, "event_name"),
		)); topic != "" {
			return topic
		}
	}
	if integration != nil && integration.Provider != "" {
		return integration.Provider + ".webhook"
	}
	return "subscription.webhook"
}

func subscriptionWebhookDeliveryID(r *http.Request, integration *Integration, topic string, body []byte) string {
	headerID := strings.TrimSpace(firstString(
		r.Header.Get("X-Recharge-Webhook-ID"),
		r.Header.Get("X-Recharge-Webhook-Id"),
		r.Header.Get("X-Recharge-Delivery-ID"),
		r.Header.Get("X-Recharge-Delivery-Id"),
		r.Header.Get("X-Recharge-Event-ID"),
		r.Header.Get("X-Recharge-Event-Id"),
		r.Header.Get("X-Webhook-ID"),
		r.Header.Get("X-Webhook-Id"),
		r.Header.Get("X-Delivery-ID"),
		r.Header.Get("X-Delivery-Id"),
		r.Header.Get("X-Request-ID"),
		r.Header.Get("X-Request-Id"),
	))
	if headerID != "" {
		return "delivery:" + headerID
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err == nil {
		if bodyID := strings.TrimSpace(firstString(
			subscriptionWebhookString(raw, "webhook_id"),
			subscriptionWebhookString(raw, "delivery_id"),
			subscriptionWebhookString(raw, "event_id"),
			subscriptionWebhookString(raw, "id"),
			subscriptionWebhookString(raw, "data", "id"),
		)); bodyID != "" {
			return "delivery:" + bodyID
		}
	}
	sum := sha256.Sum256(body)
	integrationID := ""
	if integration != nil {
		integrationID = integration.ID
	}
	return "integration:" + integrationID + ":topic:" + strings.TrimSpace(topic) + ":body:" + hex.EncodeToString(sum[:])
}

// mapSubscriptionWebhook tolerantly turns a subscription/shipping webhook body
// into a canonical sync request. A SubscriptionInput keyed on email is the safe
// default; when the payload clearly represents a shipment/tracking event it maps
// to a ShipmentInput instead. Field locations vary by provider, so it probes
// common paths. Returns false when no email can be resolved.
func mapSubscriptionWebhook(provider string, body []byte) (SyncRequest, bool) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return SyncRequest{}, false
	}
	email := strings.ToLower(strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "email"),
		subscriptionWebhookString(raw, "customer_email"),
		subscriptionWebhookString(raw, "customer", "email"),
		subscriptionWebhookString(raw, "contact", "email"),
		subscriptionWebhookString(raw, "data", "email"),
		subscriptionWebhookString(raw, "data", "customer_email"),
		subscriptionWebhookString(raw, "data", "customer", "email"),
		subscriptionWebhookString(raw, "subscription", "email"),
		subscriptionWebhookString(raw, "subscription", "customer", "email"),
	)))
	if email == "" {
		return SyncRequest{}, false
	}

	trackingNumber := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "tracking_number"),
		subscriptionWebhookString(raw, "tracking", "number"),
		subscriptionWebhookString(raw, "shipment", "tracking_number"),
		subscriptionWebhookString(raw, "data", "tracking_number"),
	))
	event := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "event"),
		subscriptionWebhookString(raw, "topic"),
		subscriptionWebhookString(raw, "type"),
		subscriptionWebhookString(raw, "event_name"),
	))

	// A clear tracking/shipment event maps to ShipmentInput.
	if trackingNumber != "" || strings.Contains(strings.ToLower(event), "track") || strings.Contains(strings.ToLower(event), "ship") || strings.Contains(strings.ToLower(event), "delivery") {
		orderID := strings.TrimSpace(firstString(
			subscriptionWebhookString(raw, "order_id"),
			subscriptionWebhookString(raw, "order", "id"),
			subscriptionWebhookString(raw, "order_number"),
			subscriptionWebhookString(raw, "data", "order_id"),
		))
		carrier := strings.TrimSpace(firstString(
			subscriptionWebhookString(raw, "carrier"),
			subscriptionWebhookString(raw, "slug"),
			subscriptionWebhookString(raw, "shipment", "carrier"),
			subscriptionWebhookString(raw, "data", "carrier"),
		))
		status := strings.TrimSpace(firstString(
			subscriptionWebhookString(raw, "status"),
			subscriptionWebhookString(raw, "tag"),
			subscriptionWebhookString(raw, "shipment", "status"),
			subscriptionWebhookString(raw, "data", "status"),
		))
		shipment := ShipmentInput{
			SourceID:       provider + "://shipment/" + firstString(trackingNumber, orderID, email),
			Email:          email,
			OrderID:        orderID,
			TrackingNumber: trackingNumber,
			Carrier:        carrier,
			Status:         status,
			Properties:     map[string]any{provider + "_event": event},
		}
		if t := parseRechargeTime(firstString(
			subscriptionWebhookString(raw, "eta"),
			subscriptionWebhookString(raw, "expected_delivery"),
			subscriptionWebhookString(raw, "estimated_delivery_date"),
		)); t != nil {
			shipment.ETA = t
		}
		if t := parseRechargeTime(firstString(
			subscriptionWebhookString(raw, "delivered_at"),
			subscriptionWebhookString(raw, "shipment_delivery_date"),
		)); t != nil {
			shipment.DeliveredAt = t
		}
		return SyncRequest{RunMode: "webhook", Shipments: []ShipmentInput{shipment}}, true
	}

	// Otherwise treat the payload as a subscription lifecycle update.
	subscriptionID := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "subscription_id"),
		subscriptionWebhookString(raw, "subscription", "id"),
		subscriptionWebhookString(raw, "id"),
		subscriptionWebhookString(raw, "data", "subscription_id"),
		subscriptionWebhookString(raw, "data", "id"),
	))
	customerID := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "customer_id"),
		subscriptionWebhookString(raw, "customer", "id"),
		subscriptionWebhookString(raw, "subscription", "customer_id"),
		subscriptionWebhookString(raw, "data", "customer_id"),
	))
	status := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "status"),
		subscriptionWebhookString(raw, "subscription_status"),
		subscriptionWebhookString(raw, "subscription", "status"),
		subscriptionWebhookString(raw, "state"),
		subscriptionWebhookString(raw, "data", "status"),
	))
	frequency := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "frequency"),
		subscriptionWebhookString(raw, "plan"),
		subscriptionWebhookString(raw, "plan_name"),
		subscriptionWebhookString(raw, "subscription", "plan"),
		subscriptionWebhookString(raw, "data", "plan_name"),
	))
	productID := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "product_id"),
		subscriptionWebhookString(raw, "subscription", "product_id"),
		subscriptionWebhookString(raw, "data", "product_id"),
	))
	sku := strings.TrimSpace(firstString(
		subscriptionWebhookString(raw, "sku"),
		subscriptionWebhookString(raw, "subscription", "sku"),
		subscriptionWebhookString(raw, "data", "sku"),
	))
	subscription := SubscriptionInput{
		SourceID:       provider + "://subscription/" + firstString(subscriptionID, customerID, email),
		Email:          email,
		CustomerID:     customerID,
		SubscriptionID: subscriptionID,
		Status:         status,
		ProductID:      productID,
		SKU:            sku,
		Frequency:      frequency,
		Properties:     map[string]any{provider + "_event": event},
	}
	if t := parseRechargeTime(firstString(
		subscriptionWebhookString(raw, "next_charge"),
		subscriptionWebhookString(raw, "next_charge_at"),
		subscriptionWebhookString(raw, "next_billing"),
		subscriptionWebhookString(raw, "next_billing_date"),
		subscriptionWebhookString(raw, "next_charge_scheduled_at"),
		subscriptionWebhookString(raw, "subscription", "next_charge_scheduled_at"),
		subscriptionWebhookString(raw, "data", "next_charge_at"),
	)); t != nil {
		subscription.NextChargeAt = t
	}
	if t := parseRechargeTime(firstString(
		subscriptionWebhookString(raw, "cancelled_at"),
		subscriptionWebhookString(raw, "canceled_at"),
		subscriptionWebhookString(raw, "subscription", "cancelled_at"),
	)); t != nil {
		subscription.CancelledAt = t
	}
	if t := parseRechargeTime(firstString(
		subscriptionWebhookString(raw, "updated_at"),
		subscriptionWebhookString(raw, "subscription", "updated_at"),
		subscriptionWebhookString(raw, "data", "updated_at"),
	)); t != nil {
		subscription.UpdatedAt = t
	}
	return SyncRequest{RunMode: "webhook", Subscriptions: []SubscriptionInput{subscription}}, true
}

func subscriptionWebhookString(node map[string]any, path ...string) string {
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
			case float64:
				return strings.TrimSpace(fmt.Sprint(typed))
			default:
				return ""
			}
		}
		cur = v
	}
	return ""
}
