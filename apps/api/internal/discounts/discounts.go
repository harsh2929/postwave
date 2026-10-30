// Package discounts implements tenant-scoped discount codes that bridge
// to Stripe coupons / promotion codes when a paid subscription is created.
//
// The local code is the source of truth for max_redemptions and expiry;
// Stripe is told about the same code through StripeBridge so paid-sub
// flows can attach it at subscription create time. Bridge calls are
// best-effort: failures log but do not block local creation, mirroring
// the rest of apps/api/internal/billing's "Stripe is downstream of our
// projection" stance.
package discounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// AppliesTo enumerates how a discount is applied to a Stripe sub.
type AppliesTo string

const (
	AppliesFirstPayment AppliesTo = "first_payment"
	AppliesRecurring    AppliesTo = "recurring"
	AppliesBoth         AppliesTo = "both"
)

// Discount is the public projection.
type Discount struct {
	ID             string     `json:"id"`
	TenantID       string     `json:"tenant_id"`
	Code           string     `json:"code"`
	PercentOff     *int       `json:"percent_off,omitempty"`
	AmountOffCents *int       `json:"amount_off_cents,omitempty"`
	Currency       string     `json:"currency"`
	MaxRedemptions *int       `json:"max_redemptions,omitempty"`
	TimesRedeemed  int        `json:"times_redeemed"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	AppliesTo      AppliesTo  `json:"applies_to"`
	StripeCouponID string     `json:"stripe_coupon_id,omitempty"`
	StripePromoID  string     `json:"stripe_promo_id,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
}

// HistoricalDiscountRecord is the release-qualified, read-only projection
// exposed to desktop archive clients. It deliberately omits the tenant ID,
// provider identifiers, and the redeemable discount code. ID is an opaque
// record key used only to fetch the equally sanitized recent-event timeline.
type HistoricalDiscountRecord struct {
	ID             string     `json:"id"`
	Label          string     `json:"label"`
	PercentOff     *int       `json:"percent_off,omitempty"`
	AmountOffCents *int       `json:"amount_off_cents,omitempty"`
	Currency       string     `json:"currency"`
	MaxRedemptions *int       `json:"max_redemptions,omitempty"`
	TimesRedeemed  int        `json:"times_redeemed"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	AppliesTo      AppliesTo  `json:"applies_to"`
	CreatedAt      time.Time  `json:"created_at"`
}

// HistoricalRedemptionEvent is the minimum event projection needed by the
// desktop archive. Subscriber identifiers and emails never cross the handler
// boundary; callers learn only whether the historical row was linked.
type HistoricalRedemptionEvent struct {
	RedeemedAt       time.Time `json:"redeemed_at"`
	SubscriberLinked bool      `json:"subscriber_linked"`
}

func historicalDiscountRecord(d Discount) HistoricalDiscountRecord {
	labelID := strings.ReplaceAll(strings.TrimSpace(d.ID), "-", "")
	if len(labelID) > 8 {
		labelID = labelID[:8]
	}
	if labelID == "" {
		labelID = "unknown"
	}
	return HistoricalDiscountRecord{
		ID:             d.ID,
		Label:          "Discount record " + strings.ToUpper(labelID),
		PercentOff:     d.PercentOff,
		AmountOffCents: d.AmountOffCents,
		Currency:       d.Currency,
		MaxRedemptions: d.MaxRedemptions,
		TimesRedeemed:  d.TimesRedeemed,
		ExpiresAt:      d.ExpiresAt,
		AppliesTo:      d.AppliesTo,
		CreatedAt:      d.CreatedAt,
	}
}

// CreateInput is the API body for POST /api/v1/discounts.
type CreateInput struct {
	Code           string     `json:"code"`
	PercentOff     *int       `json:"percent_off,omitempty"`
	AmountOffCents *int       `json:"amount_off_cents,omitempty"`
	Currency       string     `json:"currency,omitempty"`
	MaxRedemptions *int       `json:"max_redemptions,omitempty"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	AppliesTo      AppliesTo  `json:"applies_to"`
}

// UpdateInput is the API body for PATCH /api/v1/discounts/{code}.
//
// Field semantics are *additive only* — see Repo.Update for the
// enforcement rules. We need a three-state encoding ("absent" /
// "clear" / "set to value") and encoding/json doesn't give us the
// absent-vs-null distinction on a plain *int. The explicit clear flag
// is the unambiguous workaround:
//
//   - both fields absent           → don't touch that column
//   - MaxRedemptions != nil        → bump cap to this value (must be
//     >= times_redeemed; enforced in Repo.Update)
//   - ClearMaxRedemptions == true  → set cap to NULL (uncap entirely)
//   - ExpiresAt != nil             → push expiry to this time (must be
//     >= current expires_at; enforced in Repo.Update)
//   - ClearExpiresAt == true       → set expires_at to NULL (no expiry)
//
// Sending both `max_redemptions` and `clear_max_redemptions` together
// is rejected as invalid input.
type UpdateInput struct {
	MaxRedemptions      *int       `json:"max_redemptions,omitempty"`
	ClearMaxRedemptions bool       `json:"clear_max_redemptions,omitempty"`
	ExpiresAt           *time.Time `json:"expires_at,omitempty"`
	ClearExpiresAt      bool       `json:"clear_expires_at,omitempty"`
}

type CouponRedemptionInput struct {
	SubscriberID    string `json:"subscriber_id,omitempty"`
	SubscriberEmail string `json:"subscriber_email,omitempty"`
	ContextKey      string `json:"context_key,omitempty"`
	RenderKey       string `json:"render_key,omitempty"`
}

func (in *CouponRedemptionInput) Normalize() {
	in.SubscriberID = strings.TrimSpace(in.SubscriberID)
	in.SubscriberEmail = strings.TrimSpace(strings.ToLower(in.SubscriberEmail))
	in.ContextKey = strings.TrimSpace(in.ContextKey)
	in.RenderKey = strings.TrimSpace(in.RenderKey)
}

// RedeemResult is what /api/v1/discounts/{code}/redeem returns.
type RedeemResult struct {
	Code                 string `json:"code"`
	Valid                bool   `json:"valid"`
	CurrentlyRedeemable  bool   `json:"currently_redeemable"`
	Reason               string `json:"reason,omitempty"`
	CouponPoolID         string `json:"coupon_pool_id,omitempty"`
	CouponCodeID         string `json:"coupon_code_id,omitempty"`
	CouponAssignmentID   string `json:"coupon_assignment_id,omitempty"`
	CouponPreviousStatus string `json:"coupon_previous_status,omitempty"`
}

// Redemption is the admin-facing projection of one discount redemption.
// Subscriber fields are nullable because public checkout/redeem flows can
// validate a code before the subscriber row exists.
type Redemption struct {
	ID              int64     `json:"id"`
	TenantID        string    `json:"tenant_id"`
	DiscountID      string    `json:"discount_id"`
	DiscountCode    string    `json:"discount_code"`
	SubscriberID    string    `json:"subscriber_id,omitempty"`
	SubscriberEmail string    `json:"subscriber_email,omitempty"`
	RedeemedAt      time.Time `json:"redeemed_at"`
}

// ErrNotFound is returned when a discount code lookup misses.
var ErrNotFound = errors.New("discounts: not found")

// ErrInvalidInput captures user-facing validation errors.
var ErrInvalidInput = errors.New("discounts: invalid input")

// ErrStripeBridgeUnavailable prevents a local discount mutation from being
// reported as successful when no payment-provider mirror is configured.
var ErrStripeBridgeUnavailable = errors.New("discounts: Stripe bridge unavailable")

// Validate checks the create input is internally consistent.
func (in CreateInput) Validate() error {
	if strings.TrimSpace(in.Code) == "" {
		return fmt.Errorf("%w: code required", ErrInvalidInput)
	}
	hasPercent := in.PercentOff != nil
	hasAmount := in.AmountOffCents != nil
	if hasPercent == hasAmount {
		return fmt.Errorf("%w: exactly one of percent_off / amount_off_cents required", ErrInvalidInput)
	}
	if hasPercent && (*in.PercentOff < 1 || *in.PercentOff > 100) {
		return fmt.Errorf("%w: percent_off must be in [1,100]", ErrInvalidInput)
	}
	if hasAmount && *in.AmountOffCents < 1 {
		return fmt.Errorf("%w: amount_off_cents must be > 0", ErrInvalidInput)
	}
	switch in.AppliesTo {
	case AppliesFirstPayment, AppliesRecurring, AppliesBoth:
	default:
		return fmt.Errorf("%w: applies_to must be first_payment|recurring|both", ErrInvalidInput)
	}
	if in.MaxRedemptions != nil && *in.MaxRedemptions < 1 {
		return fmt.Errorf("%w: max_redemptions must be > 0", ErrInvalidInput)
	}
	return nil
}

// CheckRedeemable reports whether d is currently usable: not expired, not
// at the redemption ceiling. The reason string is empty when redeemable.
func CheckRedeemable(d *Discount, now time.Time) (bool, string) {
	if d == nil {
		return false, "unknown_code"
	}
	if d.ExpiresAt != nil && !d.ExpiresAt.After(now) {
		return false, "expired"
	}
	if d.MaxRedemptions != nil && d.TimesRedeemed >= *d.MaxRedemptions {
		return false, "max_redemptions_reached"
	}
	return true, ""
}

// StripeBridge abstracts the side-effect of mirroring a discount to Stripe.
// Implementations should be idempotent on Code and should return the Stripe
// ids to persist back on the local row. A nil bridge is an error: local-only
// discount success would make checkout and provider state diverge.
type StripeBridge interface {
	UpsertCoupon(ctx context.Context, tenantID string, in CreateInput) (couponID, promoID string, err error)
	DeleteCoupon(ctx context.Context, tenantID, couponID, promoID string) error
}
