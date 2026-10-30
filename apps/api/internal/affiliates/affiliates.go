// Package affiliates owns the platform-level affiliate program: signup,
// click attribution, conversion recording, and payout administration.
//
// LICENSE BOUNDARY: this package never imports any github.com/.../listmonk
// package. Stripe webhook integration plugs in through a thin internal
// callback (RecordConversion); the actual Stripe SDK + webhook plumbing is
// owned by the gateway entrypoint, not this package, so we stay testable
// without Stripe creds.
//
// Affiliate rows are NOT tenant-scoped (they sit above tenants — an
// affiliate may refer many tenants). We therefore do NOT use RLS here and
// access is gated by a role check at the HTTP layer (requireAdmin
// middleware in handlers.go).
package affiliates

import (
	"time"
)

// Status is the lifecycle of an affiliate account.
type Status string

const (
	StatusPending    Status = "pending"
	StatusApproved   Status = "approved"
	StatusSuspended  Status = "suspended"
	StatusTerminated Status = "terminated"
)

// PayoutMethod enumerates the payout rails we support.
type PayoutMethod string

const (
	PayoutPayPal        PayoutMethod = "paypal"
	PayoutWise          PayoutMethod = "wise"
	PayoutStripeConnect PayoutMethod = "stripe_connect"
)

// TaxFormStatus tracks W-9 / W-8BEN collection. The IRS $600/yr threshold
// kicks the form into 'pending' once an affiliate's lifetime payouts cross
// it; until then it can stay 'not_required'.
type TaxFormStatus string

const (
	TaxFormNotRequired TaxFormStatus = "not_required"
	TaxFormPending     TaxFormStatus = "pending"
	TaxFormSubmitted   TaxFormStatus = "submitted"
	TaxFormExpired     TaxFormStatus = "expired"
)

// TaxFormType — W-9 for US persons, W-8BEN otherwise.
type TaxFormType string

const (
	TaxFormW9    TaxFormType = "w9"
	TaxFormW8BEN TaxFormType = "w8ben"
	TaxFormNone  TaxFormType = "none"
)

// Kind is the kind of revenue event a conversion represents.
type Kind string

const (
	KindLTDPurchase         Kind = "ltd_purchase"
	KindSendingSubscription Kind = "sending_subscription"
	KindProSubscription     Kind = "pro_subscription"
)

// ConversionStatus is the lifecycle of a single conversion event.
type ConversionStatus string

const (
	ConversionPending  ConversionStatus = "pending"
	ConversionApproved ConversionStatus = "approved"
	ConversionPaid     ConversionStatus = "paid"
	ConversionReversed ConversionStatus = "reversed"
	ConversionDisputed ConversionStatus = "disputed"
)

// PayoutStatus is the lifecycle of a payout transfer.
type PayoutStatus string

const (
	PayoutPending PayoutStatus = "pending"
	PayoutSent    PayoutStatus = "sent"
	PayoutFailed  PayoutStatus = "failed"
)

// Affiliate mirrors the affiliates row on the wire (camelCase JSON).
type Affiliate struct {
	ID            string        `json:"id"`
	Slug          string        `json:"slug"`
	Email         string        `json:"email"`
	Name          string        `json:"name"`
	Country       string        `json:"country,omitempty"`
	Status        Status        `json:"status"`
	PayoutMethod  PayoutMethod  `json:"payoutMethod,omitempty"`
	PayoutEmail   string        `json:"payoutEmail,omitempty"`
	TaxFormStatus TaxFormStatus `json:"taxFormStatus,omitempty"`
	TaxFormType   TaxFormType   `json:"taxFormType,omitempty"`
	Notes         string        `json:"notes,omitempty"`
	Website       string        `json:"website,omitempty"`
	AudienceSize  int           `json:"audienceSize,omitempty"`
	AudienceDesc  string        `json:"audienceDesc,omitempty"`
	CreatedAt     time.Time     `json:"createdAt"`
	ApprovedAt    *time.Time    `json:"approvedAt,omitempty"`
	UpdatedAt     time.Time     `json:"updatedAt"`
}

type AffiliateProgramRow struct {
	Affiliate Affiliate `json:"affiliate"`
	Last30    Stats     `json:"last30"`
	Lifetime  Stats     `json:"lifetime"`
}

type AffiliateProgramOverview struct {
	ActiveCount        int   `json:"activeCount"`
	Clicks30D          int   `json:"clicks30d"`
	Conversions30D     int   `json:"conversions30d"`
	PendingPayoutCents int64 `json:"pendingPayoutCents"`
}

type AffiliateProgramPage struct {
	Rows     []AffiliateProgramRow    `json:"rows"`
	Overview AffiliateProgramOverview `json:"overview"`
	Total    int                      `json:"total"`
	Page     int                      `json:"page"`
	PerPage  int                      `json:"perPage"`
}

// AffiliateClick is one click on a tracking link or pixel.
type AffiliateClick struct {
	ID          int64     `json:"id"`
	AffiliateID string    `json:"affiliateId"`
	IP          string    `json:"ip,omitempty"`
	UserAgent   string    `json:"userAgent,omitempty"`
	LandingPage string    `json:"landingPage,omitempty"`
	UTMSource   string    `json:"utmSource,omitempty"`
	UTMMedium   string    `json:"utmMedium,omitempty"`
	UTMCampaign string    `json:"utmCampaign,omitempty"`
	UTMContent  string    `json:"utmContent,omitempty"`
	UTMTerm     string    `json:"utmTerm,omitempty"`
	CookieID    string    `json:"cookieId"`
	ClickedAt   time.Time `json:"clickedAt"`
}

// AffiliateConversion is one revenue event attributed to an affiliate.
type AffiliateConversion struct {
	ID                    int64            `json:"id"`
	AffiliateID           string           `json:"affiliateId"`
	TenantID              string           `json:"tenantId,omitempty"`
	CookieID              string           `json:"cookieId"`
	Kind                  Kind             `json:"kind"`
	AmountCents           int64            `json:"amountCents"`
	CommissionCents       int64            `json:"commissionCents"`
	CommissionRatePct     float64          `json:"commissionRatePct"`
	RecurringPeriodEnd    *time.Time       `json:"recurringPeriodEnd,omitempty"`
	Status                ConversionStatus `json:"status"`
	StripePaymentIntentID string           `json:"stripePaymentIntentId,omitempty"`
	CreatedAt             time.Time        `json:"createdAt"`
	PaidAt                *time.Time       `json:"paidAt,omitempty"`
	ReversedAt            *time.Time       `json:"reversedAt,omitempty"`
}

// AffiliatePayout is one outgoing payout transfer.
type AffiliatePayout struct {
	ID              string       `json:"id"`
	AffiliateID     string       `json:"affiliateId"`
	AmountCents     int64        `json:"amountCents"`
	Currency        string       `json:"currency"`
	PayoutMethod    PayoutMethod `json:"payoutMethod,omitempty"`
	PayoutReference string       `json:"payoutReference,omitempty"`
	Status          PayoutStatus `json:"status"`
	SentAt          *time.Time   `json:"sentAt,omitempty"`
	Notes           string       `json:"notes,omitempty"`
	CreatedAt       time.Time    `json:"createdAt"`
}

// Stats is an at-a-glance roll-up for one affiliate over a period.
type Stats struct {
	Clicks               int64 `json:"clicks"`
	Signups              int64 `json:"signups"`
	Conversions          int64 `json:"conversions"`
	TotalCommissionCents int64 `json:"totalCommissionCents"`
	PendingPayoutCents   int64 `json:"pendingPayoutCents"`
}

// Commission rate constants. Exposed so tests + UI can reference them
// without re-deriving the policy.
const (
	// LTDFlatCommissionCents — flat $50 per LTD sale.
	LTDFlatCommissionCents int64 = 5000

	// SendingRatePct — 30% recurring on the Sending tier ($29/mo).
	SendingRatePct float64 = 30.0

	// ProRatePct — 25% recurring on the Pro Sending tier ($79/mo).
	ProRatePct float64 = 25.0
)

// CommissionFor encodes the rate rules. Returns (rate_pct, commission_cents).
//
//   - ltd_purchase           → flat $50 regardless of sale price.
//   - sending_subscription   → 30% of amount_cents, rounded down.
//   - pro_subscription       → 25% of amount_cents, rounded down.
//
// Unknown kinds return (0, 0).
//
// Negative or zero amounts produce zero commission (and zero rate). Refunds
// land in the conversions table as status='reversed' rather than via a
// negative commission row, so we never need a negative result here.
func CommissionFor(kind Kind, amountCents int64) (ratePct float64, commissionCents int64) {
	if amountCents <= 0 {
		return 0, 0
	}
	switch kind {
	case KindLTDPurchase:
		// Flat $50 — the rate-pct is informational only.
		commission := LTDFlatCommissionCents
		// We still surface an *effective* rate so the admin UI can
		// show "this represented X% of the sale price" in the table.
		rate := float64(commission) * 100.0 / float64(amountCents)
		return rate, commission
	case KindSendingSubscription:
		return SendingRatePct, amountCents * 30 / 100
	case KindProSubscription:
		return ProRatePct, amountCents * 25 / 100
	}
	return 0, 0
}

// CookieMaxAgeSeconds — 60-day attribution window. Matches the cookie's
// Max-Age and the SQL window in LastTouchAttribute.
const CookieMaxAgeSeconds = 60 * 24 * 60 * 60

// CookieName — must match what the browser-side tracking link sets.
const CookieName = "pw_ref"

// SignupInput is the body of POST /api/public/affiliates/signup.
type SignupInput struct {
	Email        string `json:"email"`
	Name         string `json:"name"`
	Country      string `json:"country,omitempty"`
	Slug         string `json:"slug,omitempty"`
	Website      string `json:"website,omitempty"`
	AudienceSize int    `json:"audienceSize,omitempty"`
	AudienceDesc string `json:"audienceDesc,omitempty"`
	AgreedToToS  bool   `json:"agreedToTos"`
}

// UpdateInput is the body of PATCH /api/v1/admin/affiliates/{id}. Every
// field is optional so admins can patch one column at a time.
type UpdateInput struct {
	Status        *Status        `json:"status,omitempty"`
	PayoutMethod  *PayoutMethod  `json:"payoutMethod,omitempty"`
	PayoutEmail   *string        `json:"payoutEmail,omitempty"`
	TaxFormStatus *TaxFormStatus `json:"taxFormStatus,omitempty"`
	TaxFormType   *TaxFormType   `json:"taxFormType,omitempty"`
	Notes         *string        `json:"notes,omitempty"`
}
