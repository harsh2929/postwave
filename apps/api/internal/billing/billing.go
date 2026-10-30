// Package billing implements payment-provider checkout and webhook → tenant
// provisioning pipelines. Dodo Payments is Moosewave's canonical collection
// provider. A narrow Stripe reader remains for existing installations and
// historical records during migration.
//
// Design:
//
//   - Webhook delivery is idempotent. Provider-scoped delivery IDs are claimed
//     in `billing_events`; redelivered events become no-ops.
//   - Signature verification is implemented in-package. Dodo uses the Standard
//     Webhooks id.timestamp.raw-body scheme; legacy Stripe uses its timestamped
//     HMAC scheme. Both enforce a bounded replay window.
//   - Tier transitions delegate to sending.Provisioner. This package owns no
//     business logic about Postmark / DKIM / dedicated IPs.
package billing

import (
	"encoding/json"
	"time"
)

// Tier mirrors the tier vocabulary used by tenants + sending_state.
type Tier string

const (
	TierSandbox Tier = "sandbox"
	TierLaunch  Tier = "launch"
	TierGrowth  Tier = "growth"
	TierScale   Tier = "scale"

	// Legacy tiers remain readable for historical Stripe and self-hosted rows.
	// New Moosewave checkout never writes them.
	TierStudio  Tier = "studio"
	TierSending Tier = "sending"
	TierPro     Tier = "pro"
)

// String makes Tier formatter-friendly.
func (t Tier) String() string { return string(t) }

// BillingState is the projection of the billing_state row.
type BillingState struct {
	TenantID       string   `json:"tenant_id"`
	Provider       Provider `json:"provider,omitempty"`
	CustomerID     string   `json:"customer_id,omitempty"`
	SubscriptionID string   `json:"subscription_id,omitempty"`
	// StripeCustomerID and StripeSubscriptionID are compatibility fields for
	// records written before the provider-neutral billing migration. New Dodo
	// writes use CustomerID and SubscriptionID.
	StripeCustomerID     string    `json:"stripe_customer_id,omitempty"`
	StripeSubscriptionID string    `json:"stripe_subscription_id,omitempty"`
	Tier                 Tier      `json:"tier"`
	CurrentPeriodEnd     time.Time `json:"current_period_end,omitempty"`
	CancelAt             time.Time `json:"cancel_at,omitempty"`
	Dunning              bool      `json:"dunning"`
	// DunningSet distinguishes an authoritative payment-state write from a
	// subscription projection that merely happens to carry Go's zero value.
	// Without it, every customer.subscription.updated webhook silently cleared
	// a prior invoice.payment_failed transition before the succeeding paid
	// invoice could report a real recovery.
	DunningSet bool      `json:"-"`
	UpdatedAt  time.Time `json:"updated_at"`
	// BILL-052 overage. OverageEnabled/OverageCap are a user PREFERENCE (never
	// written by the Stripe projection). StripeOverageItemID is the metered
	// subscription-item id captured FROM Stripe; empty until a metered price is
	// on the subscription.
	OverageEnabled      bool   `json:"overage_enabled"`
	OverageCap          *int   `json:"overage_cap,omitempty"`
	StripeOverageItemID string `json:"-"`
}

// StripeEvent is the minimum shape we need from a Stripe Event payload. We
// keep it deliberately narrow — only the fields the dispatcher actually
// branches on — because the full Stripe schema is enormous and re-typed for
// every language the SDKs target.
type StripeEvent struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Created int64           `json:"created"`
	Data    StripeEventData `json:"data"`
}

// StripeEventData wraps the polymorphic .object in event payloads.
type StripeEventData struct {
	Object json.RawMessage `json:"object"`
}

// CheckoutSession is the subset of checkout.session we read from
// checkout.session.completed events. `client_reference_id` is the field we
// instruct the marketing site to set to the tenant id.
//
// CustomerEmail is the email Stripe captured during checkout (either
// pre-filled by us via `customer_email` or entered by the buyer).
// Used by the auto-provision path when ClientReferenceID is empty —
// see webhook.go::handleCheckoutCompleted.
type CheckoutSession struct {
	ID                string            `json:"id"`
	Customer          string            `json:"customer"`
	CustomerEmail     string            `json:"customer_email"`
	ClientReferenceID string            `json:"client_reference_id"`
	Mode              string            `json:"mode"` // "payment" (LTD) | "subscription"
	Metadata          map[string]string `json:"metadata"`
}

// Subscription is the subset of customer.subscription objects we care about.
type Subscription struct {
	ID                string            `json:"id"`
	Customer          string            `json:"customer"`
	Status            string            `json:"status"`
	CurrentPeriodEnd  int64             `json:"current_period_end"`
	CancelAt          *int64            `json:"cancel_at"`
	CancelAtPeriodEnd bool              `json:"cancel_at_period_end"`
	Items             SubscriptionItems `json:"items"`
	Metadata          map[string]string `json:"metadata"`
}

// SubscriptionItems mirrors `items.data[].price.id`.
type SubscriptionItems struct {
	Data []SubscriptionItem `json:"data"`
}

// SubscriptionItem holds the nested data we read. ID is the subscription-item
// id (si_...) — the target of a metered usage-record POST (BILL-052).
type SubscriptionItem struct {
	ID    string            `json:"id"`
	Price SubscriptionPrice `json:"price"`
}

// SubscriptionPrice is a Stripe price object excerpt.
type SubscriptionPrice struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

// Invoice is the subset of invoice.* events we care about.
type Invoice struct {
	ID           string `json:"id"`
	Number       string `json:"number"`
	Customer     string `json:"customer"`
	Subscription string `json:"subscription"`
	AmountPaid   int64  `json:"amount_paid"`
	AmountDue    int64  `json:"amount_due"`
	AttemptCount int    `json:"attempt_count"`
	HostedURL    string `json:"hosted_invoice_url"`
}

// Charge is the subset of charge.refunded.
type Charge struct {
	ID             string `json:"id"`
	Customer       string `json:"customer"`
	PaymentIntent  string `json:"payment_intent"`
	AmountRefunded int64  `json:"amount_refunded"`
	Amount         int64  `json:"amount"`
	Refunded       bool   `json:"refunded"`
}

type DashboardInvoice struct {
	ID          string `json:"id"`
	Number      string `json:"number"`
	Date        string `json:"date"`
	Amount      string `json:"amount"`
	Status      string `json:"status"`
	DownloadURL string `json:"downloadUrl"`
}

type UsagePoint struct {
	Date string `json:"date"`
	Sent int    `json:"sent"`
}
