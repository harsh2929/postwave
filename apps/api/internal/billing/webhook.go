package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/notifications"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// DefaultSignatureTolerance matches Stripe's documented default of 5 minutes.
// We accept a slightly wider window in tests via WebhookHandler.Tolerance.
const DefaultSignatureTolerance = 5 * time.Minute

const stripeWebhookMaxBodyBytes int64 = 1 << 20 // 1 MiB

// PriceMap maps Stripe price IDs to the tier they grant. Configured at
// startup from env (`STRIPE_PRICE_SENDING`, `STRIPE_PRICE_PRO`,
// `STRIPE_PRICE_LTD`).
type PriceMap struct {
	Sending string
	Pro     string
	LTD     string
	// Overage is the metered price id (STRIPE_PRICE_OVERAGE) whose subscription
	// item receives usage records (BILL-052). Empty disables metered reporting.
	Overage string
}

// OverageItemID returns the subscription-item id (si_...) of the metered
// overage price on a subscription, or "" if the configured overage price is not
// present. Never trusts a caller-supplied id — it only matches the env-pinned
// price, exactly like TierFor.
func (p PriceMap) OverageItemID(sub Subscription) string {
	if strings.TrimSpace(p.Overage) == "" {
		return ""
	}
	for _, it := range sub.Items.Data {
		if strings.TrimSpace(it.Price.ID) == p.Overage {
			return strings.TrimSpace(it.ID)
		}
	}
	return ""
}

// TierFor resolves a price id to a Tier; returns "" if unknown.
func (p PriceMap) TierFor(priceID string) Tier {
	priceID = strings.TrimSpace(priceID)
	if priceID == "" {
		return ""
	}
	switch {
	case p.Sending != "" && priceID == p.Sending:
		return TierSending
	case p.Pro != "" && priceID == p.Pro:
		return TierPro
	case p.LTD != "" && priceID == p.LTD:
		return TierStudio
	}
	return ""
}

// Provisioner is the subset of sending.Provisioner we depend on. Defined as
// an interface here so webhook tests can stub it out.
type Provisioner interface {
	ProvisionTenant(ctx context.Context, t sending.Tenant) (*sending.State, error)
	DeprovisionTenant(ctx context.Context, tenantID string) error
}

// AffiliateReverser is an optional hook called on full refunds. The affiliate
// package implements it; if nil, refunds simply skip the reversal step.
type AffiliateReverser interface {
	ReverseConversion(ctx context.Context, stripeCustomerID, chargeID string) error
}

// AffiliateAttributor records affiliate conversions from the verified Stripe
// webhook path without coupling billing to affiliate internals.
type AffiliateAttributor interface {
	RecordStripeEvent(ctx context.Context, eventID, eventType string, object json.RawMessage) error
}

// AuditLogger writes domain audit events. Optional; nil is allowed.
type AuditLogger interface {
	Write(ctx context.Context, tenantID, action string, payload map[string]any) error
}

// TenantAutoProvisioner is the optional hook the webhook uses to mint a
// fresh tenant + owner user from a Stripe customer email when a
// checkout session arrives without a `client_reference_id`. Implementations
// must be idempotent on `email` so a Stripe redelivery doesn't create a
// duplicate tenant.
//
// Returns the (tenantID) so the webhook can stamp it on
// billing_state and the rest of the dispatch chain.
type TenantAutoProvisioner interface {
	// EnsureTenantForEmail returns the tenant id for `email`, creating
	// a fresh tenant + owner user + sending an invitation magic-link
	// when one doesn't exist. `customerID` (if non-empty) is recorded
	// on the new tenant so subsequent webhook fan-outs can dedupe by
	// stripe_customer_id.
	EnsureTenantForEmail(ctx context.Context, email, customerID string) (tenantID string, created bool, err error)
}

// RetryEnqueuer is the narrow surface the webhook handler uses to
// enqueue events whose inline dispatch failed. Implemented by
// internal/billing/webhook_retry.PgStore in production. nil disables
// the retry path entirely (legacy behaviour: return 500 so Stripe
// retries on its own cadence).
//
// Defined as an interface here so the billing package doesn't import
// webhook_retry (which would create a cycle: webhook_retry's worker
// invokes the same WebhookHandler.ServeHTTP).
type RetryEnqueuer interface {
	Enqueue(ctx context.Context, eventID string, payload []byte) error
}

// AutomationEvent is the billing event shape forwarded to the automation
// runtime as a product_event. SubscriberEmail is the tenant owner or checkout
// customer email because the automation engine is subscriber-address keyed.
type AutomationEvent struct {
	TenantID        string
	SubscriberEmail string
	EventName       string
	Payload         map[string]any
	At              time.Time
}

// AutomationEventEmitter is implemented by apps/api's automation sidecar
// client. Billing calls it best-effort after durable billing state/audit writes.
type AutomationEventEmitter interface {
	EmitBillingAutomationEvent(ctx context.Context, ev AutomationEvent) error
}

// WebhookHandler is the HTTP handler bundling all dependencies.
type WebhookHandler struct {
	Secret string // STRIPE_WEBHOOK_SECRET (primary)
	// SecondarySecret enables rolling rotation. Stripe lets you have
	// two endpoint secrets active simultaneously; both must verify
	// for the rotation window so in-flight retries signed under the
	// old secret keep landing while the new one rolls out. Empty
	// disables the secondary check. Audit (webhook-rotation CRITICAL #1).
	SecondarySecret string        // STRIPE_WEBHOOK_SECRET_SECONDARY (optional)
	Tolerance       time.Duration // overrides DefaultSignatureTolerance when nonzero
	Repo            *Repo         // billing_events + billing_state mirror
	Provisioner     Provisioner   // sending tier orchestrator
	Prices          PriceMap      // price-id → tier mapping
	Affiliates      AffiliateReverser
	Attributor      AffiliateAttributor
	// PaymentFailedMailer, when non-nil, is used by handleInvoiceFailed
	// to send a customer-facing dunning email. Email failures are
	// logged + counted but never fail the webhook (Stripe would retry).
	// nil disables the email path entirely (log-only).
	PaymentFailedMailer PaymentFailedMailer
	// NotifDispatcher gates customer-facing emails on the per-user
	// notification_preferences row. nil = always-send (the dispatcher
	// is fail-open by contract anyway, so a nil here is just the
	// fastest possible "always allow" path). Wired from main.go to
	// the shared notifications.PgDispatcher.
	NotifDispatcher notifications.Dispatcher
	// PaymentFailedNotifier, when non-nil, delivers the dunning alert to the
	// in-app feed, the browser and the PHONE alongside the email (COMMERCE#4).
	// A failed charge already sets billing_state.dunning and writes an audit
	// row; the only person told was whoever reads the owner mailbox, so a
	// workspace could lapse in silence.
	//
	// The interface is declared HERE, in primitives, rather than taking a
	// *notifyfanout.Fanout: billing is a payments package and must not acquire
	// a dependency on the notification stack to gain a second channel. main.go
	// supplies the adapter. nil = the historical email-only behaviour.
	PaymentFailedNotifier PaymentFailedNotifier
	Audit                 AuditLogger
	Logger                *slog.Logger
	Now                   func() time.Time
	// RetryQueue, when non-nil, takes ownership of failed-event retry
	// from Stripe. On dispatch failure we ENQUEUE the event into the
	// retry queue and return 200 so Stripe stops retrying — our
	// worker takes it from here, with finer-grained backoff and a
	// dead-letter queue. nil = legacy: return 500 and let Stripe
	// retry.
	RetryQueue RetryEnqueuer
	// AutoTenant, when wired, is consulted by handleCheckoutCompleted
	// when a session arrives without a client_reference_id /
	// metadata.tenant_id. The implementation creates a tenant from the
	// customer email and emails an invitation magic-link. nil = legacy
	// behaviour (return error so Stripe retries — preserves the
	// historical contract for tenants that drive checkout from
	// inside the dashboard).
	AutoTenant TenantAutoProvisioner
	// Automation forwards billing lifecycle events into product-event
	// automations. nil = billing remains durable but no automation fan-out.
	Automation AutomationEventEmitter
}

// tolerance picks the configured tolerance or falls back to the default.
func (h *WebhookHandler) tolerance() time.Duration {
	if h.Tolerance > 0 {
		return h.Tolerance
	}
	return DefaultSignatureTolerance
}

func (h *WebhookHandler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now().UTC()
}

func (h *WebhookHandler) emitAutomationEvent(ctx context.Context, tenantID, email, eventName string, payload map[string]any) {
	if h.Automation == nil || tenantID == "" || eventName == "" {
		return
	}
	email = strings.TrimSpace(email)
	if email == "" && h.Repo != nil {
		if ownerEmail, _, err := ownerEmailAndIDForTenant(ctx, h.Repo.Pool, tenantID); err == nil {
			email = ownerEmail
		} else if h.Logger != nil {
			h.Logger.Warn("billing automation email lookup failed",
				"tenant_id", tenantID, "event_name", eventName, "err", err.Error())
		}
	}
	if email == "" || !strings.Contains(email, "@") {
		if h.Logger != nil {
			h.Logger.Warn("billing automation event skipped: no subscriber email",
				"tenant_id", tenantID, "event_name", eventName)
		}
		return
	}
	if payload == nil {
		payload = map[string]any{}
	}
	payload["event_name"] = eventName
	if !h.startAsync("automation-event", func() {
		emitCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := h.Automation.EmitBillingAutomationEvent(emitCtx, AutomationEvent{
			TenantID:        tenantID,
			SubscriberEmail: email,
			EventName:       eventName,
			Payload:         payload,
			At:              h.now(),
		})
		if err != nil && h.Logger != nil {
			h.Logger.Warn("billing automation event failed",
				"tenant_id", tenantID, "event_name", eventName, "err", err.Error())
		}
	}) && h.Logger != nil {
		h.Logger.Warn("billing automation event dropped: async capacity exhausted",
			"tenant_id", tenantID, "event_name", eventName)
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func writeWebhookError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// ServeHTTP implements http.Handler. Wired to POST /api/public/stripe/webhook.
func (h *WebhookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeWebhookError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST required")
		return
	}
	body, err := httpbody.ReadAtMost(r.Body, stripeWebhookMaxBodyBytes)
	if err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) {
			writeWebhookError(w, http.StatusRequestEntityTooLarge, "payload_too_large", "webhook payload is too large")
			return
		}
		writeWebhookError(w, http.StatusBadRequest, "read_failed", "could not read webhook payload")
		return
	}
	defer func() { _ = r.Body.Close() }()

	sig := r.Header.Get("Stripe-Signature")
	// Two-secret verification for rolling rotation. Audit
	// (webhook-rotation CRITICAL #1): the primary always verifies;
	// the secondary (when configured) is the fallback for events
	// signed under the previous secret during a Stripe-dashboard
	// rotation window. After the window closes, the operator clears
	// STRIPE_WEBHOOK_SECRET_SECONDARY and we return to single-secret.
	verifyErr := VerifySignature(h.Secret, sig, body, h.now(), h.tolerance())
	if verifyErr != nil && h.SecondarySecret != "" {
		if secondaryErr := VerifySignature(h.SecondarySecret, sig, body, h.now(), h.tolerance()); secondaryErr == nil {
			verifyErr = nil
		}
	}
	if verifyErr != nil {
		if h.Logger != nil {
			h.Logger.Warn("stripe webhook signature failed", "err", verifyErr.Error())
		}
		writeWebhookError(w, http.StatusBadRequest, "invalid_signature", "invalid Stripe signature")
		return
	}

	var ev StripeEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		writeWebhookError(w, http.StatusBadRequest, "bad_json", "could not decode Stripe event")
		return
	}
	if strings.TrimSpace(ev.ID) == "" || strings.TrimSpace(ev.Type) == "" {
		writeWebhookError(w, http.StatusBadRequest, "malformed_event", "Stripe event is missing id or type")
		return
	}

	// Idempotency: if we have already processed this event id, ack and return.
	// Otherwise, claim the row before dispatch so a concurrent redelivery
	// becomes a no-op.
	if h.Repo != nil {
		claim, err := h.Repo.RecordEvent(r.Context(), ev, body)
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
		case EventClaimed:
		default:
			writeWebhookError(w, http.StatusInternalServerError, "record_failed", "could not claim webhook event")
			return
		}
	}

	if err := h.dispatch(r.Context(), ev); err != nil {
		if h.Repo != nil {
			_ = h.Repo.MarkFailed(r.Context(), ev.ID, err.Error())
		}
		if h.Logger != nil {
			h.Logger.Error("stripe webhook dispatch failed",
				"event_id", ev.ID, "type", ev.Type, "err", err.Error())
		}
		// Trust-ops retry path: when a RetryQueue is wired, we own
		// the retry schedule (30s, 5m, 30m, 2h, 8h, 1d, 7d → DLQ)
		// rather than relying on Stripe's coarse cadence. We enqueue
		// the raw payload + event id and ack 200 so Stripe stops
		// firing this event. The retry worker re-runs the same
		// handler against the queued payload until success or DLQ.
		//
		// If enqueue itself fails (transient DB blip), fall back to
		// returning 500 so Stripe still has a shot at redelivering.
		if h.RetryQueue != nil {
			if qErr := h.RetryQueue.Enqueue(r.Context(), ev.ID, body); qErr == nil {
				if h.Logger != nil {
					h.Logger.Info("stripe webhook enqueued for retry",
						"event_id", ev.ID, "type", ev.Type, "err", err.Error())
				}
				w.WriteHeader(http.StatusOK)
				return
			} else if h.Logger != nil {
				h.Logger.Error("stripe webhook retry enqueue failed; falling back to 500",
					"event_id", ev.ID, "type", ev.Type, "err", qErr.Error())
			}
		}
		// Return 500 so Stripe retries.
		writeWebhookError(w, http.StatusInternalServerError, "dispatch_failed", "webhook dispatch failed")
		return
	}
	if h.Repo != nil {
		if err := h.Repo.MarkProcessed(r.Context(), ev.ID); err != nil {
			if h.Logger != nil {
				h.Logger.Error("stripe webhook mark processed failed",
					"event_id", ev.ID, "type", ev.Type, "err", err.Error())
			}
			writeWebhookError(w, http.StatusInternalServerError, "mark_processed_failed", "could not mark webhook event processed")
			return
		}
	}
	w.WriteHeader(http.StatusOK)
}

// dispatch routes a verified event to the appropriate handler.
func (h *WebhookHandler) dispatch(ctx context.Context, ev StripeEvent) error {
	switch ev.Type {
	case "checkout.session.completed":
		if err := h.handleCheckoutCompleted(ctx, ev); err != nil {
			return err
		}
		return h.recordAffiliateConversion(ctx, ev)
	case "customer.subscription.created":
		return h.handleSubscriptionCreated(ctx, ev)
	case "customer.subscription.updated":
		return h.handleSubscriptionUpdated(ctx, ev)
	case "customer.subscription.deleted":
		return h.handleSubscriptionDeleted(ctx, ev)
	case "invoice.payment_succeeded":
		if err := h.handleInvoicePaid(ctx, ev); err != nil {
			return err
		}
		return h.recordAffiliateConversion(ctx, ev)
	case "invoice.payment_failed":
		return h.handleInvoiceFailed(ctx, ev)
	case "charge.refunded":
		return h.handleChargeRefunded(ctx, ev)
	default:
		// Unknown / uninteresting events are acked so Stripe stops retrying.
		return nil
	}
}

func (h *WebhookHandler) handleCheckoutCompleted(ctx context.Context, ev StripeEvent) error {
	var sess CheckoutSession
	if err := json.Unmarshal(ev.Data.Object, &sess); err != nil {
		return fmt.Errorf("decode checkout session: %w", err)
	}
	tenantID := sess.ClientReferenceID
	// public_checkout.go stuffs `auto:<email>` into client_reference_id for
	// every unauthenticated marketing checkout; strip that prefix here so the
	// rest of the dispatch chain doesn't see a non-UUID tenant id.
	autoEmailFromRef := ""
	if strings.HasPrefix(tenantID, "auto:") {
		autoEmailFromRef = strings.TrimPrefix(tenantID, "auto:")
		tenantID = ""
	}
	if tenantID == "" {
		tenantID = sess.Metadata["tenant_id"]
	}
	if tenantID == "" {
		// Auto-provision path. The marketing-site /pricing flow lands
		// here for brand-new signups: no tenant exists yet, the
		// customer just paid, we need to create one keyed off their
		// email and send them a magic-link invitation. Idempotency is
		// the AutoTenant implementation's job — see
		// TenantAutoProvisioner.EnsureTenantForEmail.
		email := strings.TrimSpace(autoEmailFromRef)
		if email == "" {
			email = strings.TrimSpace(sess.Metadata["customer_email"])
		}
		if email == "" {
			email = strings.TrimSpace(sess.CustomerEmail)
		}
		if email == "" || !strings.Contains(email, "@") {
			return errors.New("checkout.session.completed missing client_reference_id, metadata.tenant_id, AND a usable customer email — cannot auto-provision")
		}
		if h.AutoTenant == nil {
			return errors.New("checkout.session.completed has no client_reference_id and AutoTenant is not configured; cannot auto-provision")
		}
		newTenantID, created, err := h.AutoTenant.EnsureTenantForEmail(ctx, email, sess.Customer)
		if err != nil {
			return fmt.Errorf("auto-provision tenant for %s: %w", email, err)
		}
		tenantID = newTenantID
		if h.Logger != nil {
			h.Logger.Info("billing auto-provisioned tenant",
				"event_id", ev.ID,
				"email", email,
				"tenant_id", tenantID,
				"created", created,
				"customer_id", sess.Customer)
		}
		h.audit(ctx, tenantID, "billing.tenant.auto_provisioned", map[string]any{
			"email":               email,
			"checkout_session_id": sess.ID,
			"customer_id":         sess.Customer,
			"created":             created,
		})
	}
	// Studio LTD purchases: no Postmark provisioning (BYO sender). We just
	// upsert the billing_state row at tier=studio so feature gates flip on.
	if sess.Mode == "payment" {
		if err := h.Repo.UpsertState(ctx, BillingState{
			TenantID:         tenantID,
			StripeCustomerID: sess.Customer,
			Tier:             TierStudio,
			UpdatedAt:        h.now(),
		}); err != nil {
			return fmt.Errorf("upsert studio billing state: %w", err)
		}
		h.audit(ctx, tenantID, "billing.studio.purchased", map[string]any{
			"checkout_session_id": sess.ID,
		})
		h.emitAutomationEvent(ctx, tenantID, firstNonEmpty(autoEmailFromRef, sess.Metadata["customer_email"], sess.CustomerEmail), "billing.studio.purchased", map[string]any{
			"checkout_session_id": sess.ID,
			"stripe_customer_id":  sess.Customer,
			"tier":                string(TierStudio),
			"mode":                sess.Mode,
		})
		return nil
	}
	// Subscription mode: defer the heavy lifting to subscription.created
	// (Stripe will fire it immediately after the session completes anyway).
	return nil
}

func (h *WebhookHandler) handleSubscriptionCreated(ctx context.Context, ev StripeEvent) error {
	sub, tenantID, tier, err := h.extractSubscription(ctx, ev)
	if err != nil {
		return err
	}
	if tier == "" {
		// Sub created against a price that does not map to a Moosewave tier —
		// likely a manual sandbox sub. Record state, skip provisioning.
		if err := h.Repo.UpsertState(ctx, BillingState{
			TenantID:             tenantID,
			StripeCustomerID:     sub.Customer,
			StripeSubscriptionID: sub.ID,
			CurrentPeriodEnd:     time.Unix(sub.CurrentPeriodEnd, 0).UTC(),
			StripeOverageItemID:  h.Prices.OverageItemID(sub),
			UpdatedAt:            h.now(),
		}); err != nil {
			return fmt.Errorf("upsert unmapped subscription billing state: %w", err)
		}
		return nil
	}
	if h.Provisioner != nil && (tier == TierSending || tier == TierPro) {
		_, err := h.Provisioner.ProvisionTenant(ctx, sending.Tenant{
			ID:   tenantID,
			Slug: sub.Metadata["tenant_slug"],
			Name: sub.Metadata["tenant_name"],
			Tier: string(tier),
		})
		if err != nil {
			return fmt.Errorf("provision %s: %w", tier, err)
		}
	}
	if err := h.Repo.UpsertState(ctx, BillingState{
		TenantID:             tenantID,
		StripeCustomerID:     sub.Customer,
		StripeSubscriptionID: sub.ID,
		Tier:                 tier,
		CurrentPeriodEnd:     time.Unix(sub.CurrentPeriodEnd, 0).UTC(),
		StripeOverageItemID:  h.Prices.OverageItemID(sub),
		UpdatedAt:            h.now(),
	}); err != nil {
		return fmt.Errorf("upsert subscription billing state: %w", err)
	}
	h.audit(ctx, tenantID, "billing.subscription.created", map[string]any{
		"subscription_id": sub.ID, "tier": string(tier),
	})
	h.emitAutomationEvent(ctx, tenantID, firstNonEmpty(sub.Metadata["customer_email"], sub.Metadata["email"]), "billing.subscription.created", map[string]any{
		"subscription_id":    sub.ID,
		"stripe_customer_id": sub.Customer,
		"tier":               string(tier),
		"status":             sub.Status,
	})
	// Telemetry: hard signal — paid sub. Structured log only (no
	// customer email / metadata leaked); the logs → PostHog
	// forwarder picks up the "event:posthog:" prefix.
	slog.Info("event:posthog:paid_sub_created",
		"event", "paid_sub_created",
		"tenant_id", tenantID,
		"tier", string(tier),
	)
	return nil
}

func (h *WebhookHandler) handleSubscriptionUpdated(ctx context.Context, ev StripeEvent) error {
	sub, tenantID, newTier, err := h.extractSubscription(ctx, ev)
	if err != nil {
		return err
	}
	prev, _ := h.Repo.GetState(ctx, tenantID)
	if prev != nil && prev.Tier != newTier && newTier != "" && h.Provisioner != nil {
		// Tier change. Sending → Pro adds dedicated IP; Pro → Sending we
		// leave the dedicated IP in place until subscription.deleted (the
		// downgrade is mid-cycle and we honor the contracted IP for the
		// remainder of the paid period).
		if newTier == TierPro {
			if _, err := h.Provisioner.ProvisionTenant(ctx, sending.Tenant{
				ID: tenantID, Tier: string(newTier),
			}); err != nil {
				return fmt.Errorf("upgrade to pro: %w", err)
			}
		}
	}
	cancelAt := time.Time{}
	if sub.CancelAt != nil {
		cancelAt = time.Unix(*sub.CancelAt, 0).UTC()
	}
	if err := h.Repo.UpsertState(ctx, BillingState{
		TenantID:             tenantID,
		StripeCustomerID:     sub.Customer,
		StripeSubscriptionID: sub.ID,
		Tier:                 newTier,
		CurrentPeriodEnd:     time.Unix(sub.CurrentPeriodEnd, 0).UTC(),
		CancelAt:             cancelAt,
		StripeOverageItemID:  h.Prices.OverageItemID(sub),
		UpdatedAt:            h.now(),
	}); err != nil {
		return fmt.Errorf("upsert updated subscription billing state: %w", err)
	}
	h.audit(ctx, tenantID, "billing.subscription.updated", map[string]any{
		"subscription_id": sub.ID, "tier": string(newTier),
	})
	h.emitAutomationEvent(ctx, tenantID, firstNonEmpty(sub.Metadata["customer_email"], sub.Metadata["email"]), "billing.subscription.updated", map[string]any{
		"subscription_id":      sub.ID,
		"stripe_customer_id":   sub.Customer,
		"tier":                 string(newTier),
		"status":               sub.Status,
		"cancel_at_period_end": sub.CancelAtPeriodEnd,
	})
	return nil
}

func (h *WebhookHandler) handleSubscriptionDeleted(ctx context.Context, ev StripeEvent) error {
	sub, tenantID, _, err := h.extractSubscription(ctx, ev)
	if err != nil {
		return err
	}
	if h.Provisioner != nil {
		if err := h.Provisioner.DeprovisionTenant(ctx, tenantID); err != nil {
			return fmt.Errorf("deprovision: %w", err)
		}
	}
	if err := h.Repo.UpsertState(ctx, BillingState{
		TenantID:             tenantID,
		StripeCustomerID:     sub.Customer,
		StripeSubscriptionID: "",
		Tier:                 TierStudio, // retain Studio access for any prior LTD purchase
		Dunning:              false,
		DunningSet:           true,
		UpdatedAt:            h.now(),
	}); err != nil {
		return fmt.Errorf("upsert deleted subscription billing state: %w", err)
	}
	h.audit(ctx, tenantID, "billing.subscription.deleted", map[string]any{
		"subscription_id": sub.ID,
	})
	h.emitAutomationEvent(ctx, tenantID, firstNonEmpty(sub.Metadata["customer_email"], sub.Metadata["email"]), "billing.subscription.deleted", map[string]any{
		"subscription_id":    sub.ID,
		"stripe_customer_id": sub.Customer,
		"status":             sub.Status,
	})
	return nil
}

func (h *WebhookHandler) handleInvoicePaid(ctx context.Context, ev StripeEvent) error {
	var inv Invoice
	if err := json.Unmarshal(ev.Data.Object, &inv); err != nil {
		return fmt.Errorf("decode invoice: %w", err)
	}
	tenantID := h.tenantByCustomer(ctx, inv.Customer)
	if tenantID != "" && h.Repo != nil {
		_, err := h.Repo.ClearDunning(ctx, tenantID)
		if err != nil {
			return fmt.Errorf("clear dunning: %w", err)
		}
	}
	h.audit(ctx, tenantID, "billing.payment.received", map[string]any{
		"invoice_id":  inv.ID,
		"amount_paid": inv.AmountPaid,
	})
	h.emitAutomationEvent(ctx, tenantID, "", "billing.payment.received", map[string]any{
		"invoice_id":         inv.ID,
		"stripe_customer_id": inv.Customer,
		"subscription_id":    inv.Subscription,
		"amount_paid":        inv.AmountPaid,
	})
	return nil
}

func (h *WebhookHandler) handleInvoiceFailed(ctx context.Context, ev StripeEvent) error {
	var inv Invoice
	if err := json.Unmarshal(ev.Data.Object, &inv); err != nil {
		return fmt.Errorf("decode invoice: %w", err)
	}
	tenantID := h.tenantByCustomer(ctx, inv.Customer)
	if tenantID != "" && h.Repo != nil {
		if err := h.Repo.SetDunning(ctx, tenantID, true); err != nil {
			return fmt.Errorf("set dunning: %w", err)
		}
	}
	h.audit(ctx, tenantID, "billing.payment.failed", map[string]any{
		"invoice_id": inv.ID, "attempt": inv.AttemptCount, "url": inv.HostedURL,
	})
	h.emitAutomationEvent(ctx, tenantID, "", "billing.payment.failed", map[string]any{
		"invoice_id":         inv.ID,
		"stripe_customer_id": inv.Customer,
		"subscription_id":    inv.Subscription,
		"attempt":            inv.AttemptCount,
	})
	// Customer-facing dunning email. Best-effort: any failure here is
	// logged + counted but does NOT fail the webhook. Stripe retries
	// would otherwise re-fire the whole event chain (re-running
	// SetDunning + re-emitting the audit row), which is worse than
	// occasionally missing an email.
	//
	// We DETACH the email send into a goroutine because the email
	// providers (SES, listmonk transactional) can take seconds; Stripe
	// expects a webhook ack inside 30s, and we'd rather ack first.
	//
	// COMMERCE#4 — the same detached call now also raises the alert on the
	// in-app feed / browser / phone, so the condition is "we have SOME way to
	// tell them", not "we have a mailer".
	if tenantID != "" && h.Repo != nil &&
		(h.PaymentFailedMailer != nil || h.PaymentFailedNotifier != nil) {
		if !h.startAsync("payment-failed-notice", func() { h.sendPaymentFailedAsync(tenantID, inv) }) && h.Logger != nil {
			h.Logger.Warn("payment_failed notice dropped: async capacity exhausted",
				"tenant_id", tenantID, "invoice_id", inv.ID)
		}
	} else if h.Logger != nil {
		// No mailer wired (or no tenant resolved): log so an operator
		// can see the dunning notice would have gone out. Same shape as
		// a real send so log searches catch both branches.
		h.Logger.Info("would_send_payment_failed_email",
			"tenant_id", tenantID,
			"invoice_id", inv.ID,
			"attempt", inv.AttemptCount,
			"hosted_url", inv.HostedURL,
		)
	}
	return nil
}

// sendPaymentFailedAsync resolves the owner email for `tenantID` and
// fires the dunning notice through h.PaymentFailedMailer. Runs in a
// detached goroutine — see the call site for why.
//
// All errors are logged + counted; nothing propagates back. We use a
// fresh context bounded at 30s because the request context the webhook
// handler used is cancelled the moment we ack.
func (h *WebhookHandler) sendPaymentFailedAsync(tenantID string, inv Invoice) {
	defer func() {
		if rec := recover(); rec != nil && h.Logger != nil {
			h.Logger.Error("payment_failed email panic",
				"tenant_id", tenantID,
				"invoice_id", inv.ID,
				"panic", fmt.Sprintf("%v", rec))
			billingPaymentFailedEmailFailures.Inc()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	email, userID, err := ownerEmailAndIDForTenant(ctx, h.Repo.Pool, tenantID)
	if err != nil {
		if h.Logger != nil {
			h.Logger.Error("payment_failed email owner lookup",
				"tenant_id", tenantID,
				"invoice_id", inv.ID,
				"err", err.Error())
		}
		billingPaymentFailedEmailFailures.Inc()
		return
	}
	if email == "" {
		if h.Logger != nil {
			h.Logger.Warn("payment_failed email skipped: no owner found",
				"tenant_id", tenantID,
				"invoice_id", inv.ID)
		}
		return
	}
	// Gate on the owner's per-user pref. PrefBounceAlert is the
	// closest existing pref column for "operational alert"; the
	// notification_preferences schema doesn't have a billing-
	// specific pref. Fail-open by contract so a transient pgx
	// hiccup never silently drops the dunning notice.
	if h.NotifDispatcher != nil {
		allowed, gerr := h.NotifDispatcher.Gate(ctx, tenantID, userID, notifications.PrefBounceAlert)
		if gerr != nil && h.Logger != nil {
			h.Logger.Warn("payment_failed pref lookup failed; failing open",
				"tenant_id", tenantID,
				"user_id", userID,
				"err", gerr.Error())
		}
		if !allowed {
			if h.Logger != nil {
				h.Logger.Info("payment_failed email gated off by user pref",
					"tenant_id", tenantID,
					"user_id", userID,
					"invoice_id", inv.ID)
			}
			return
		}
	}
	// COMMERCE#4. Fires BEFORE the email because it is the leg that can reach
	// someone in seconds, and because the mailer can block for the better part
	// of this 30s budget. Same tenant, same user, same pref gate — the alert
	// simply stops being inbox-only.
	if h.PaymentFailedNotifier != nil {
		h.PaymentFailedNotifier.NotifyPaymentFailed(ctx, PaymentFailedAlert{
			TenantID:     tenantID,
			UserID:       userID,
			InvoiceID:    inv.ID,
			AttemptCount: inv.AttemptCount,
			HostedURL:    inv.HostedURL,
		})
	}
	if h.PaymentFailedMailer == nil {
		// Notification-only deployment: everything below is the email leg.
		return
	}
	if err := h.PaymentFailedMailer.SendPaymentFailed(ctx, PaymentFailedEmail{
		To:           email,
		HostedURL:    inv.HostedURL,
		AttemptCount: inv.AttemptCount,
	}); err != nil {
		if h.Logger != nil {
			h.Logger.Error("payment_failed email send",
				"tenant_id", tenantID,
				"invoice_id", inv.ID,
				"to", email,
				"err", err.Error())
		}
		billingPaymentFailedEmailFailures.Inc()
		return
	}
	if h.Logger != nil {
		h.Logger.Info("payment_failed email sent",
			"tenant_id", tenantID,
			"invoice_id", inv.ID,
			"to", email,
			"attempt", inv.AttemptCount)
	}
}

func (h *WebhookHandler) handleChargeRefunded(ctx context.Context, ev StripeEvent) error {
	var ch Charge
	if err := json.Unmarshal(ev.Data.Object, &ch); err != nil {
		return fmt.Errorf("decode charge: %w", err)
	}
	full := ch.Refunded || ch.AmountRefunded >= ch.Amount
	if full && h.Affiliates != nil {
		conversionID := ch.PaymentIntent
		if conversionID == "" {
			conversionID = ch.ID
		}
		if err := h.Affiliates.ReverseConversion(ctx, ch.Customer, conversionID); err != nil {
			return fmt.Errorf("reverse affiliate conversion: %w", err)
		}
	}
	tenantID := h.tenantByCustomer(ctx, ch.Customer)
	h.audit(ctx, tenantID, "billing.charge.refunded", map[string]any{
		"charge_id": ch.ID, "amount_refunded": ch.AmountRefunded, "full": full,
	})
	return nil
}

// extractSubscription pulls a Subscription out of an event and resolves the
// tenant id + tier from metadata + the configured price map.
func (h *WebhookHandler) extractSubscription(ctx context.Context, ev StripeEvent) (Subscription, string, Tier, error) {
	var sub Subscription
	if err := json.Unmarshal(ev.Data.Object, &sub); err != nil {
		return sub, "", "", fmt.Errorf("decode subscription: %w", err)
	}
	tenantID := sub.Metadata["tenant_id"]
	if tenantID == "" && h.Repo != nil {
		tenantID = h.tenantByCustomer(ctx, sub.Customer)
	}
	if tenantID == "" {
		return sub, "", "", fmt.Errorf("subscription %s missing tenant_id metadata", sub.ID)
	}
	var tier Tier
	for _, it := range sub.Items.Data {
		if t := h.Prices.TierFor(it.Price.ID); t != "" {
			tier = t
			break
		}
	}
	return sub, tenantID, tier, nil
}

func (h *WebhookHandler) recordAffiliateConversion(ctx context.Context, ev StripeEvent) error {
	if h.Attributor == nil {
		return nil
	}
	return h.Attributor.RecordStripeEvent(ctx, ev.ID, ev.Type, ev.Data.Object)
}

func (h *WebhookHandler) tenantByCustomer(ctx context.Context, customerID string) string {
	if h.Repo == nil || customerID == "" {
		return ""
	}
	tenantID, _ := h.Repo.TenantByCustomer(ctx, customerID)
	return tenantID
}

func (h *WebhookHandler) audit(ctx context.Context, tenantID, action string, payload map[string]any) {
	if h.Audit == nil {
		return
	}
	_ = h.Audit.Write(ctx, tenantID, action, payload)
}

// ---------------------------------------------------------------------------
// Stripe-Signature verification
// ---------------------------------------------------------------------------

// VerifySignature implements the protocol documented at
// https://stripe.com/docs/webhooks/signatures.
//
// Header format: "t=<unix>,v1=<sig>[,v1=<sig>...]"
// Signed payload: "<unix>.<raw body>"
// Algorithm: HMAC-SHA256 with the endpoint secret.
//
// Returns nil on success; a descriptive error otherwise. Constant-time
// comparison is used to thwart timing oracles.
func VerifySignature(secret, header string, body []byte, now time.Time, tolerance time.Duration) error {
	if secret == "" {
		return errors.New("webhook secret not configured")
	}
	if header == "" {
		return errors.New("missing Stripe-Signature header")
	}
	var ts string
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			ts = kv[1]
		case "v1":
			sigs = append(sigs, kv[1])
		}
	}
	if ts == "" || len(sigs) == 0 {
		return errors.New("malformed signature header")
	}
	tsi, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return fmt.Errorf("bad timestamp: %w", err)
	}
	delta := now.Unix() - tsi
	if delta < 0 {
		delta = -delta
	}
	if time.Duration(delta)*time.Second > tolerance {
		return fmt.Errorf("timestamp outside tolerance window (%ds)", delta)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := mac.Sum(nil)
	expectedHex := hex.EncodeToString(expected)
	for _, s := range sigs {
		if hmac.Equal([]byte(s), []byte(expectedHex)) {
			return nil
		}
	}
	return errors.New("no matching signature")
}
