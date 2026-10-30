package affiliates

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/billing"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// StripeEvent is a deliberately-narrow projection of the Stripe webhook
// envelope — we only consume the bits we need to attribute a conversion.
// The real Stripe SDK + signature verification lives outside this package
// (the gateway entrypoint owns it). Here we accept the parsed event and
// translate to a RecordConversion call.
//
// See plan.md Phase 4 — full Stripe webhook integration is a follow-up;
// this scaffold gives the affiliate program a working hook point in the
// meantime. The contract is intentionally Stripe-shaped (Type + Data.Object)
// so when we wire the real SDK we can swap construction without touching the
// inner logic.
type StripeEvent struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	Data StripeEventData `json:"data"`
}

// StripeEventData mirrors the Stripe envelope wrapper.
type StripeEventData struct {
	Object json.RawMessage `json:"object"`
}

// stripeCheckoutSession is the bits of checkout.session we need.
type stripeCheckoutSession struct {
	ID             string            `json:"id"`
	PaymentIntent  string            `json:"payment_intent"`
	AmountTotal    int64             `json:"amount_total"`
	ClientRefID    string            `json:"client_reference_id"`
	CustomerEmail  string            `json:"customer_email"`
	Metadata       map[string]string `json:"metadata"`
	Mode           string            `json:"mode"` // payment | subscription
	SubscriptionID string            `json:"subscription"`
}

// stripeInvoice is the bits of invoice.payment_succeeded we need.
type stripeInvoice struct {
	ID            string            `json:"id"`
	PaymentIntent string            `json:"payment_intent"`
	AmountPaid    int64             `json:"amount_paid"`
	Subscription  string            `json:"subscription"`
	CustomerEmail string            `json:"customer_email"`
	Metadata      map[string]string `json:"metadata"`
	Lines         struct {
		Data []struct {
			Price struct {
				LookupKey string `json:"lookup_key"`
				ID        string `json:"id"`
				Recurring struct {
					Interval string `json:"interval"`
				} `json:"recurring"`
			} `json:"price"`
		} `json:"data"`
	} `json:"lines"`
}

// kindFromLookupKey maps Stripe price lookup keys to our Kind enum. The
// price lookup keys are configured at billing-product setup time:
//   - "studio_ltd"          → ltd_purchase
//   - "sending_monthly"     → sending_subscription
//   - "pro_sending_monthly" → pro_subscription
//
// Anything else returns ("", false) and the conversion is skipped.
func kindFromLookupKey(key string) (Kind, bool) {
	switch key {
	case "studio_ltd":
		return KindLTDPurchase, true
	case "sending_monthly":
		return KindSendingSubscription, true
	case "pro_sending_monthly":
		return KindProSubscription, true
	}
	return "", false
}

// HandleStripeEvent dispatches the event to the right attribution path.
// Idempotent: a second call with the same Stripe payment_intent id is a
// no-op because of the partial unique index on stripe_payment_intent_id.
func (d *Deps) HandleStripeEvent(ctx context.Context, ev StripeEvent) error {
	if !OperationallyAvailable() {
		return ErrProgramUnavailable
	}
	switch ev.Type {
	case "checkout.session.completed":
		var s stripeCheckoutSession
		if err := json.Unmarshal(ev.Data.Object, &s); err != nil {
			return err
		}
		return d.handleCheckoutSession(ctx, &s)
	case "invoice.payment_succeeded":
		var inv stripeInvoice
		if err := json.Unmarshal(ev.Data.Object, &inv); err != nil {
			return err
		}
		return d.handleInvoicePayment(ctx, &inv)
	}
	return nil // unhandled event types are silently ignored
}

// RecordStripeEvent lets the verified billing webhook reuse affiliate
// attribution without exposing a second public Stripe endpoint.
func (d *Deps) RecordStripeEvent(ctx context.Context, eventID, eventType string, object json.RawMessage) error {
	return d.HandleStripeEvent(ctx, StripeEvent{
		ID:   eventID,
		Type: eventType,
		Data: StripeEventData{Object: object},
	})
}

// ReverseConversion marks a credited affiliate conversion as reversed after a
// verified Stripe refund event.
func (d *Deps) ReverseConversion(ctx context.Context, stripeCustomerID, chargeOrPaymentIntentID string) error {
	if !OperationallyAvailable() {
		return ErrProgramUnavailable
	}
	if d == nil || d.Repo == nil {
		return nil
	}
	return d.Repo.ReverseConversion(ctx, stripeCustomerID, chargeOrPaymentIntentID)
}

func (d *Deps) handleCheckoutSession(ctx context.Context, s *stripeCheckoutSession) error {
	cookieID := s.Metadata["pw_ref_cookie_id"]
	if cookieID == "" {
		return nil // not affiliate-tagged
	}
	tenantID := s.Metadata["pw_tenant_id"]
	// Mode == "payment" implies LTD checkout; subscription invoices land in
	// invoice.payment_succeeded.
	if s.Mode != "payment" {
		return nil
	}
	conv, err := d.Repo.RecordConversion(ctx, cookieID, KindLTDPurchase,
		s.AmountTotal, tenantID, s.PaymentIntent)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil // cookie expired / never tracked — silent skip
		}
		return err
	}
	slog.Info("affiliate conversion recorded",
		"kind", "ltd_purchase", "affiliate_id", conv.AffiliateID,
		"commission_cents", conv.CommissionCents)
	return nil
}

func (d *Deps) handleInvoicePayment(ctx context.Context, inv *stripeInvoice) error {
	cookieID := inv.Metadata["pw_ref_cookie_id"]
	if cookieID == "" {
		return nil
	}
	tenantID := inv.Metadata["pw_tenant_id"]
	if len(inv.Lines.Data) == 0 {
		return nil
	}
	kind, ok := kindFromLookupKey(inv.Lines.Data[0].Price.LookupKey)
	if !ok {
		return nil
	}
	conv, err := d.Repo.RecordConversion(ctx, cookieID, kind, inv.AmountPaid, tenantID, inv.PaymentIntent)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	slog.Info("affiliate conversion recorded",
		"kind", kind, "affiliate_id", conv.AffiliateID,
		"commission_cents", conv.CommissionCents)
	return nil
}

// StripeWebhookHandler is retained only for legacy internal wiring. The main
// production path is billing.WebhookHandler; this handler stays closed unless
// it has the same Stripe signing secret.
func (d *Deps) StripeWebhookHandler(w http.ResponseWriter, r *http.Request) {
	if !OperationallyAvailable() {
		writeJSONError(
			w,
			http.StatusServiceUnavailable,
			"affiliate_program_unavailable",
			"affiliate attribution is not release-qualified",
		)
		return
	}
	body, err := httpbody.ReadJSONAtMost(r, 1<<20, httpbody.Options{})
	if err != nil {
		if httpbody.StatusCode(err) != http.StatusBadRequest {
			httpbody.WriteError(w, err)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if d.StripeWebhookSecret == "" {
		writeJSONError(w, http.StatusUnauthorized, "signature_required", "stripe webhook secret is not configured")
		return
	}
	if err := billing.VerifySignature(
		d.StripeWebhookSecret,
		r.Header.Get("Stripe-Signature"),
		body,
		time.Now().UTC(),
		billing.DefaultSignatureTolerance,
	); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	var ev StripeEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if err := d.HandleStripeEvent(r.Context(), ev); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": true})
}
