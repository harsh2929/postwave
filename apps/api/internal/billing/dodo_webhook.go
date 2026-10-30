// SPDX-License-Identifier: AGPL-3.0-only

package billing

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

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const dodoWebhookMaxBodyBytes int64 = 1 << 20

// ProviderTenantAutoProvisioner is the provider-aware extension implemented by
// Moosewave's tenant bootstrap adapter. The older interface remains available
// so self-hosted implementations do not break immediately.
type ProviderTenantAutoProvisioner interface {
	EnsureTenantForProviderEmail(ctx context.Context, provider Provider, email, customerID string) (tenantID string, created bool, err error)
}

type DodoWebhookHandler struct {
	Secret          string
	SecondarySecret string
	Tolerance       time.Duration
	Core            *WebhookHandler
	Now             func() time.Time
}

type dodoWebhookEnvelope struct {
	BusinessID string          `json:"business_id"`
	Type       string          `json:"type"`
	Timestamp  string          `json:"timestamp"`
	Data       json.RawMessage `json:"data"`
}

type dodoCustomer struct {
	CustomerID string `json:"customer_id"`
	Email      string `json:"email"`
	Name       string `json:"name"`
}

type dodoPayment struct {
	PaymentID         string            `json:"payment_id"`
	SubscriptionID    string            `json:"subscription_id"`
	CheckoutSessionID string            `json:"checkout_session_id"`
	Customer          dodoCustomer      `json:"customer"`
	Metadata          map[string]any    `json:"metadata"`
	ProductCart       []dodoProductItem `json:"product_cart"`
	Status            string            `json:"status"`
	InvoiceID         string            `json:"invoice_id"`
	InvoiceURL        string            `json:"invoice_url"`
	TotalAmount       int64             `json:"total_amount"`
	Currency          string            `json:"currency"`
	RetryAttempt      int               `json:"retry_attempt"`
}

type dodoSubscription struct {
	SubscriptionID          string         `json:"subscription_id"`
	ProductID               string         `json:"product_id"`
	Customer                dodoCustomer   `json:"customer"`
	Metadata                map[string]any `json:"metadata"`
	Status                  string         `json:"status"`
	NextBillingDate         string         `json:"next_billing_date"`
	CancelAtNextBillingDate bool           `json:"cancel_at_next_billing_date"`
	CancelledAt             string         `json:"cancelled_at"`
}

type dodoRefund struct {
	RefundID  string         `json:"refund_id"`
	PaymentID string         `json:"payment_id"`
	Customer  dodoCustomer   `json:"customer"`
	Metadata  map[string]any `json:"metadata"`
	IsPartial bool           `json:"is_partial"`
	Amount    int64          `json:"amount"`
}

type dodoDunning struct {
	CustomerID     string `json:"customer_id"`
	SubscriptionID string `json:"subscription_id"`
	PaymentID      string `json:"payment_id"`
	Status         string `json:"status"`
	TriggerState   string `json:"trigger_state"`
}

func (h *DodoWebhookHandler) now() time.Time {
	if h != nil && h.Now != nil {
		return h.Now()
	}
	return time.Now().UTC()
}

func (h *DodoWebhookHandler) tolerance() time.Duration {
	if h != nil && h.Tolerance > 0 {
		return h.Tolerance
	}
	return DefaultSignatureTolerance
}

func (h *DodoWebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeWebhookError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, dodoWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeWebhookError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "webhook payload is too large")
			return
		}
		writeWebhookError(w, http.StatusBadRequest, "read_failed", "could not read webhook payload")
		return
	}
	defer func() { _ = r.Body.Close() }()

	deliveryID := strings.TrimSpace(r.Header.Get("webhook-id"))
	timestamp := strings.TrimSpace(r.Header.Get("webhook-timestamp"))
	signature := strings.TrimSpace(r.Header.Get("webhook-signature"))
	verifyErr := VerifyDodoSignature(h.Secret, deliveryID, timestamp, signature, body, h.now(), h.tolerance())
	if verifyErr != nil && strings.TrimSpace(h.SecondarySecret) != "" {
		verifyErr = VerifyDodoSignature(h.SecondarySecret, deliveryID, timestamp, signature, body, h.now(), h.tolerance())
	}
	if verifyErr != nil {
		if h.Core != nil && h.Core.Logger != nil {
			h.Core.Logger.Warn("Dodo Payments webhook signature failed", "err", verifyErr.Error())
		}
		writeWebhookError(w, http.StatusBadRequest, "invalid_signature", "invalid Dodo Payments signature")
		return
	}

	var event dodoWebhookEnvelope
	if err := json.Unmarshal(body, &event); err != nil {
		writeWebhookError(w, http.StatusBadRequest, "bad_json", "could not decode Dodo Payments event")
		return
	}
	if deliveryID == "" || strings.TrimSpace(event.Type) == "" || len(event.Data) == 0 {
		writeWebhookError(w, http.StatusBadRequest, "malformed_event", "Dodo Payments event is missing id, type, or data")
		return
	}
	if h.Core == nil {
		writeWebhookError(w, http.StatusServiceUnavailable, "billing_not_configured", "billing webhook is not configured")
		return
	}

	eventID := "dodo:" + deliveryID
	if h.Core.Repo != nil {
		claim, err := h.Core.Repo.RecordProviderEvent(r.Context(), eventID, event.Type, body)
		if err != nil {
			writeWebhookError(w, http.StatusInternalServerError, "record_failed", "could not record webhook event")
			return
		}
		switch claim {
		case EventProcessed:
			w.WriteHeader(http.StatusOK)
			return
		case EventInProgress:
			w.Header().Set("Retry-After", "10")
			writeWebhookError(w, http.StatusServiceUnavailable, "event_in_progress", "webhook event is already being processed")
			return
		}
	}

	if err := h.dispatch(r.Context(), event); err != nil {
		if h.Core.Repo != nil {
			_ = h.Core.Repo.MarkFailed(r.Context(), eventID, err.Error())
		}
		if h.Core.Logger != nil {
			h.Core.Logger.Error("Dodo Payments webhook dispatch failed", "event_id", deliveryID, "type", event.Type, "err", err.Error())
		}
		writeWebhookError(w, http.StatusInternalServerError, "dispatch_failed", "webhook dispatch failed")
		return
	}
	if h.Core.Repo != nil {
		if err := h.Core.Repo.MarkProcessed(r.Context(), eventID); err != nil {
			writeWebhookError(w, http.StatusInternalServerError, "mark_processed_failed", "could not mark webhook event processed")
			return
		}
	}
	w.WriteHeader(http.StatusOK)
}

func (h *DodoWebhookHandler) dispatch(ctx context.Context, event dodoWebhookEnvelope) error {
	switch event.Type {
	case "payment.succeeded":
		return h.handlePaymentSucceeded(ctx, event)
	case "payment.failed", "payment.cancelled":
		return h.handlePaymentFailed(ctx, event)
	case "subscription.active", "subscription.renewed", "subscription.plan_changed", "subscription.updated", "subscription.unpaused":
		return h.handleSubscriptionCurrent(ctx, event)
	case "subscription.past_due", "subscription.on_hold", "subscription.failed", "subscription.paused":
		return h.handleSubscriptionDunning(ctx, event)
	case "subscription.cancelled", "subscription.expired":
		return h.handleSubscriptionEnded(ctx, event)
	case "refund.succeeded":
		return h.handleRefundSucceeded(ctx, event)
	case "dunning.started":
		return h.handleDunningEvent(ctx, event, true)
	case "dunning.recovered":
		return h.handleDunningEvent(ctx, event, false)
	default:
		return nil
	}
}

func (h *DodoWebhookHandler) resolveTenant(ctx context.Context, metadata map[string]any, customer dodoCustomer, allowCreate bool) (string, string, error) {
	email := firstNonEmpty(metadataString(metadata, "customer_email"), customer.Email)
	if tenantID := metadataString(metadata, "tenant_id"); tenantID != "" {
		return tenantID, email, nil
	}
	if h.Core.Repo != nil && strings.TrimSpace(customer.CustomerID) != "" {
		tenantID, err := h.Core.Repo.TenantByProviderCustomer(ctx, ProviderDodo, customer.CustomerID)
		if err != nil {
			return "", email, fmt.Errorf("resolve Dodo Payments customer: %w", err)
		}
		if tenantID != "" {
			return tenantID, email, nil
		}
	}
	if !allowCreate {
		return "", email, nil
	}
	if email == "" || !strings.Contains(email, "@") {
		return "", email, errors.New("Dodo Payments event has no tenant metadata or usable customer email")
	}
	if h.Core.AutoTenant == nil {
		return "", email, errors.New("Dodo Payments event requires tenant auto-provisioning but AutoTenant is not configured")
	}
	var tenantID string
	var created bool
	var err error
	if providerAware, ok := h.Core.AutoTenant.(ProviderTenantAutoProvisioner); ok {
		tenantID, created, err = providerAware.EnsureTenantForProviderEmail(ctx, ProviderDodo, email, customer.CustomerID)
	} else {
		tenantID, created, err = h.Core.AutoTenant.EnsureTenantForEmail(ctx, email, customer.CustomerID)
	}
	if err != nil {
		return "", email, fmt.Errorf("auto-provision tenant for %s: %w", email, err)
	}
	h.Core.audit(ctx, tenantID, "billing.tenant.auto_provisioned", map[string]any{
		"provider": ProviderDodo, "customer_id": customer.CustomerID, "email": email, "created": created,
	})
	return tenantID, email, nil
}

func (h *DodoWebhookHandler) handlePaymentSucceeded(ctx context.Context, event dodoWebhookEnvelope) error {
	var payment dodoPayment
	if err := json.Unmarshal(event.Data, &payment); err != nil {
		return fmt.Errorf("decode Dodo Payments payment: %w", err)
	}
	tenantID, email, err := h.resolveTenant(ctx, payment.Metadata, payment.Customer, false)
	if err != nil {
		return err
	}
	if tenantID == "" {
		// A payment can precede subscription.active. The subscription event owns
		// provisioning, while this event remains useful as a durable invoice row.
		return nil
	}
	if h.Core.Repo != nil {
		if _, err := h.Core.Repo.ClearDunning(ctx, tenantID); err != nil {
			return fmt.Errorf("clear Dodo Payments dunning: %w", err)
		}
	}
	h.Core.audit(ctx, tenantID, "billing.payment.received", map[string]any{
		"provider": ProviderDodo, "payment_id": payment.PaymentID, "subscription_id": payment.SubscriptionID, "amount_paid": payment.TotalAmount,
	})
	h.Core.emitAutomationEvent(ctx, tenantID, email, "billing.payment.received", map[string]any{
		"provider": ProviderDodo, "payment_id": payment.PaymentID, "subscription_id": payment.SubscriptionID, "amount_paid": payment.TotalAmount,
	})
	return nil
}

func (h *DodoWebhookHandler) handlePaymentFailed(ctx context.Context, event dodoWebhookEnvelope) error {
	var payment dodoPayment
	if err := json.Unmarshal(event.Data, &payment); err != nil {
		return fmt.Errorf("decode Dodo Payments failed payment: %w", err)
	}
	tenantID, email, err := h.resolveTenant(ctx, payment.Metadata, payment.Customer, false)
	if err != nil {
		return err
	}
	if tenantID != "" && h.Core.Repo != nil {
		if err := h.Core.Repo.SetDunning(ctx, tenantID, true); err != nil {
			return fmt.Errorf("set Dodo Payments dunning: %w", err)
		}
	}
	h.Core.audit(ctx, tenantID, "billing.payment.failed", map[string]any{
		"provider": ProviderDodo, "payment_id": payment.PaymentID, "subscription_id": payment.SubscriptionID, "attempt": payment.RetryAttempt + 1,
	})
	h.Core.emitAutomationEvent(ctx, tenantID, email, "billing.payment.failed", map[string]any{
		"provider": ProviderDodo, "payment_id": payment.PaymentID, "subscription_id": payment.SubscriptionID, "attempt": payment.RetryAttempt + 1,
	})
	if tenantID != "" && h.Core.Repo != nil && (h.Core.PaymentFailedMailer != nil || h.Core.PaymentFailedNotifier != nil) {
		invoice := Invoice{
			ID: payment.PaymentID, Customer: payment.Customer.CustomerID, Subscription: payment.SubscriptionID,
			AmountDue: payment.TotalAmount, AttemptCount: payment.RetryAttempt + 1, HostedURL: payment.InvoiceURL,
		}
		if !h.Core.startAsync("dodo-payment-failed-notice", func() { h.Core.sendPaymentFailedAsync(tenantID, invoice) }) && h.Core.Logger != nil {
			h.Core.Logger.Warn("Dodo payment_failed notice dropped: async capacity exhausted",
				"tenant_id", tenantID, "payment_id", payment.PaymentID)
		}
	}
	return nil
}

func (h *DodoWebhookHandler) handleSubscriptionCurrent(ctx context.Context, event dodoWebhookEnvelope) error {
	sub, tenantID, email, tier, err := h.subscriptionContext(ctx, event.Data, true)
	if err != nil {
		return err
	}
	if tier == "" {
		return fmt.Errorf("Dodo Payments subscription %s uses an unconfigured product %s", sub.SubscriptionID, sub.ProductID)
	}
	// The webhook grants the plan entitlement only. Sender-provider setup is an
	// explicit workspace action; accepting payment must never create an external
	// Postmark resource or depend on the separately held provisioning workflow.
	periodEnd, _ := time.Parse(time.RFC3339, sub.NextBillingDate)
	cancelAt := time.Time{}
	if sub.CancelAtNextBillingDate {
		cancelAt = periodEnd
	}
	if h.Core.Repo != nil {
		if err := h.Core.Repo.UpsertState(ctx, BillingState{
			TenantID: tenantID, Provider: ProviderDodo, CustomerID: sub.Customer.CustomerID,
			SubscriptionID: sub.SubscriptionID, Tier: tier, CurrentPeriodEnd: periodEnd,
			CancelAt: cancelAt, Dunning: false, DunningSet: true, UpdatedAt: h.now(),
		}); err != nil {
			return fmt.Errorf("upsert Dodo Payments subscription: %w", err)
		}
	}
	action := "billing.subscription.updated"
	if event.Type == "subscription.active" {
		action = "billing.subscription.created"
	}
	h.Core.audit(ctx, tenantID, action, map[string]any{
		"provider": ProviderDodo, "subscription_id": sub.SubscriptionID, "tier": tier, "status": sub.Status,
	})
	h.Core.emitAutomationEvent(ctx, tenantID, email, action, map[string]any{
		"provider": ProviderDodo, "subscription_id": sub.SubscriptionID, "tier": tier, "status": sub.Status,
	})
	return nil
}

func (h *DodoWebhookHandler) handleSubscriptionDunning(ctx context.Context, event dodoWebhookEnvelope) error {
	sub, tenantID, email, _, err := h.subscriptionContext(ctx, event.Data, false)
	if err != nil {
		return err
	}
	if tenantID == "" {
		return nil
	}
	if h.Core.Repo != nil {
		if err := h.Core.Repo.SetDunning(ctx, tenantID, true); err != nil {
			return fmt.Errorf("set Dodo Payments subscription dunning: %w", err)
		}
	}
	h.Core.audit(ctx, tenantID, "billing.subscription.dunning", map[string]any{
		"provider": ProviderDodo, "subscription_id": sub.SubscriptionID, "status": sub.Status,
	})
	h.Core.emitAutomationEvent(ctx, tenantID, email, "billing.subscription.dunning", map[string]any{
		"provider": ProviderDodo, "subscription_id": sub.SubscriptionID, "status": sub.Status,
	})
	return nil
}

func (h *DodoWebhookHandler) handleSubscriptionEnded(ctx context.Context, event dodoWebhookEnvelope) error {
	sub, tenantID, email, _, err := h.subscriptionContext(ctx, event.Data, false)
	if err != nil {
		return err
	}
	if tenantID == "" {
		return nil
	}
	if h.Core.Provisioner != nil {
		if err := h.Core.Provisioner.DeprovisionTenant(ctx, tenantID); err != nil {
			return fmt.Errorf("deprovision Dodo Payments subscription: %w", err)
		}
	}
	if h.Core.Repo != nil {
		if err := h.Core.Repo.UpsertState(ctx, BillingState{
			TenantID: tenantID, Provider: ProviderDodo, CustomerID: sub.Customer.CustomerID,
			SubscriptionID: "", Tier: TierSandbox, Dunning: false, DunningSet: true, UpdatedAt: h.now(),
		}); err != nil {
			return fmt.Errorf("upsert ended Dodo Payments subscription: %w", err)
		}
	}
	h.Core.audit(ctx, tenantID, "billing.subscription.deleted", map[string]any{
		"provider": ProviderDodo, "subscription_id": sub.SubscriptionID, "status": sub.Status,
	})
	h.Core.emitAutomationEvent(ctx, tenantID, email, "billing.subscription.deleted", map[string]any{
		"provider": ProviderDodo, "subscription_id": sub.SubscriptionID, "status": sub.Status,
	})
	return nil
}

func (h *DodoWebhookHandler) subscriptionContext(ctx context.Context, raw json.RawMessage, allowCreate bool) (dodoSubscription, string, string, Tier, error) {
	var sub dodoSubscription
	if err := json.Unmarshal(raw, &sub); err != nil {
		return sub, "", "", "", fmt.Errorf("decode Dodo Payments subscription: %w", err)
	}
	tenantID, email, err := h.resolveTenant(ctx, sub.Metadata, sub.Customer, allowCreate)
	if err != nil {
		return sub, "", email, "", err
	}
	return sub, tenantID, email, tierForDodoProduct(sub.ProductID), nil
}

func (h *DodoWebhookHandler) handleRefundSucceeded(ctx context.Context, event dodoWebhookEnvelope) error {
	var refund dodoRefund
	if err := json.Unmarshal(event.Data, &refund); err != nil {
		return fmt.Errorf("decode Dodo Payments refund: %w", err)
	}
	tenantID, _, err := h.resolveTenant(ctx, refund.Metadata, refund.Customer, false)
	if err != nil {
		return err
	}
	h.Core.audit(ctx, tenantID, "billing.charge.refunded", map[string]any{
		"provider": ProviderDodo, "refund_id": refund.RefundID, "payment_id": refund.PaymentID,
		"amount_refunded": refund.Amount, "full": !refund.IsPartial,
	})
	return nil
}

func (h *DodoWebhookHandler) handleDunningEvent(ctx context.Context, event dodoWebhookEnvelope, active bool) error {
	var dunning dodoDunning
	if err := json.Unmarshal(event.Data, &dunning); err != nil {
		return fmt.Errorf("decode Dodo Payments dunning event: %w", err)
	}
	if strings.TrimSpace(dunning.CustomerID) == "" {
		return errors.New("Dodo Payments dunning event has no customer_id")
	}
	tenantID := ""
	if h.Core.Repo != nil {
		var err error
		tenantID, err = h.Core.Repo.TenantByProviderCustomer(ctx, ProviderDodo, dunning.CustomerID)
		if err != nil {
			return fmt.Errorf("resolve Dodo Payments dunning customer: %w", err)
		}
		if tenantID != "" {
			if active {
				err = h.Core.Repo.SetDunning(ctx, tenantID, true)
			} else {
				_, err = h.Core.Repo.ClearDunning(ctx, tenantID)
			}
			if err != nil {
				return fmt.Errorf("project Dodo Payments dunning state: %w", err)
			}
		}
	}
	action := "billing.dunning.recovered"
	if active {
		action = "billing.dunning.started"
	}
	fields := map[string]any{
		"provider": ProviderDodo, "customer_id": dunning.CustomerID,
		"subscription_id": dunning.SubscriptionID, "payment_id": dunning.PaymentID,
		"status": dunning.Status, "trigger_state": dunning.TriggerState,
	}
	h.Core.audit(ctx, tenantID, action, fields)
	h.Core.emitAutomationEvent(ctx, tenantID, "", action, fields)
	return nil
}

func dodoPaymentTier(payment dodoPayment) Tier {
	for _, product := range payment.ProductCart {
		if tier := tierForDodoProduct(product.ProductID); tier != "" {
			return tier
		}
	}
	return tierFromMetadata(payment.Metadata)
}

func tierFromMetadata(metadata map[string]any) Tier {
	switch metadataString(metadata, "tier") {
	case "launch":
		return TierLaunch
	case "growth":
		return TierGrowth
	case "scale":
		return TierScale
	case "studio", "studio_ltd":
		return TierStudio
	case "sending", "studio_ltd_cloud":
		return TierSending
	case "pro", "studio_ltd_plus":
		return TierPro
	default:
		return ""
	}
}

func metadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	value, ok := metadata[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

// VerifyDodoSignature implements the Standard Webhooks signature scheme used
// by Dodo Payments. The signed message is id.timestamp.raw-body and the v1
// signature is base64-encoded HMAC-SHA256. Secrets from the dashboard use the
// whsec_ prefix and contain a base64-encoded key.
func VerifyDodoSignature(secret, messageID, timestamp, header string, body []byte, now time.Time, tolerance time.Duration) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return errors.New("Dodo Payments webhook secret not configured")
	}
	if messageID == "" || timestamp == "" || header == "" {
		return errors.New("missing Standard Webhooks signature headers")
	}
	unixSeconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return errors.New("invalid webhook timestamp")
	}
	signedAt := time.Unix(unixSeconds, 0)
	if tolerance <= 0 {
		tolerance = DefaultSignatureTolerance
	}
	if now.Sub(signedAt) > tolerance || signedAt.Sub(now) > tolerance {
		return errors.New("webhook timestamp outside tolerance")
	}
	keyText := strings.TrimPrefix(secret, "whsec_")
	key, err := base64.StdEncoding.DecodeString(keyText)
	if err != nil {
		return errors.New("invalid Dodo Payments webhook secret")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = fmt.Fprintf(mac, "%s.%s.", messageID, timestamp)
	_, _ = mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	for _, token := range strings.Fields(header) {
		parts := strings.SplitN(token, ",", 2)
		if len(parts) == 2 && parts[0] == "v1" && hmac.Equal([]byte(parts[1]), []byte(expected)) {
			return nil
		}
	}
	return errors.New("no matching Dodo Payments webhook signature")
}
