// SPDX-License-Identifier: AGPL-3.0-only
//
// Package retention_offers implements the gap feature
// archive-retention-offers (P3, surface=archive).
//
// Production exposes read-only admin history and stored configuration GETs.
// Portal resolution, offer mutations, provider coupon application, event
// writes, and win-back dispatch remain dormant/release-held until their
// provider adapter, reconciliation, and public-route controls are certified.
// The stored retention_offer_events ledger can still support an honest
// historical shown→accepted funnel for data that already exists.
//
// Inspired by Ghost's cancel-flow save offers (and broadly Substack /
// beehiiv / Patreon): a single tier-scoped offer that Ghost calls a
// "cancel-flow save offer." Multi-step offer ladders are a v2 concern.
//
// This file owns the data layer (Repo + Offer / Event projections). The
// HTTP layer lives in handlers.go; dormant Stripe coupon mirroring lives
// behind StripeBridge. Provider-backed mutations fail closed when that
// bridge is unavailable and are not mounted by the production route set.
package retention_offers

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// EventType enumerates the four lifecycle events captured in
// retention_offer_events. Match the CHECK constraint in migration 0306
// — additions here MUST also widen the constraint, or inserts will
// fail at runtime.
type EventType string

const (
	EventShown    EventType = "shown"
	EventAccepted EventType = "accepted"
	EventDeclined EventType = "declined"
	EventExpired  EventType = "expired"
)

const (
	// MaxReadRows is the complete-result ceiling for each admin
	// retention-offer list. Repository reads request MaxReadRows+1 rows so an
	// oversized result is detected and rejected; they never return a silently
	// truncated catalog or funnel.
	MaxReadRows = 1000
	// MaxHeadlineBytes matches every production client's UTF-8 byte ceiling.
	MaxHeadlineBytes = 1000
	// MaxBodyBytes matches every production client's UTF-8 byte ceiling.
	MaxBodyBytes = 10000
	// MaxProviderReferenceBytes bounds the stored Stripe coupon reference.
	MaxProviderReferenceBytes = 512
	// MaxFunnelEventCount keeps each aggregate and the worst-case sum across a
	// complete 1,000-tile response exactly representable by JavaScript clients.
	MaxFunnelEventCount int64 = 2251799813685
)

// Offer is the public projection of a retention_offers row.
type Offer struct {
	ID             string    `json:"id"`
	TenantID       string    `json:"tenant_id"`
	PaywallTierID  string    `json:"paywall_tier_id"`
	PercentOff     *int      `json:"percent_off,omitempty"`
	FixedOffCents  *int      `json:"fixed_off_cents,omitempty"`
	DurationMonths int       `json:"duration_months"`
	Headline       string    `json:"headline,omitempty"`
	Body           string    `json:"body,omitempty"`
	StripeCouponID string    `json:"stripe_coupon_id,omitempty"`
	Active         bool      `json:"active"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// OfferInput is the create/update body.
//
// ID empty inserts; non-empty updates. Active uses a pointer so callers
// can leave it untouched on update (nil = don't change) — the create
// path defaults to true.
//
// PercentOff XOR FixedOffCents — exactly one must be set. The DB CHECK
// enforces this too; we validate up-front so the handler returns 422
// instead of a generic 500.
type OfferInput struct {
	ID             string `json:"id,omitempty"`
	PaywallTierID  string `json:"paywall_tier_id"`
	PercentOff     *int   `json:"percent_off,omitempty"`
	FixedOffCents  *int   `json:"fixed_off_cents,omitempty"`
	DurationMonths int    `json:"duration_months,omitempty"`
	Headline       string `json:"headline,omitempty"`
	Body           string `json:"body,omitempty"`
	Active         *bool  `json:"active,omitempty"`
}

// Event is the public projection of a retention_offer_events row.
type Event struct {
	ID                  int64     `json:"id"`
	OfferID             string    `json:"offer_id"`
	PaidSubID           string    `json:"paid_sub_id,omitempty"`
	SubscriberEmail     string    `json:"subscriber_email,omitempty"`
	EventType           EventType `json:"event_type"`
	StripeApplicationID string    `json:"stripe_application_id,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
}

// EventInput is the body shape retained for the dormant event-write paths.
// Those routes are not mounted in production. SubscriberEmail or PaidSubID is
// required for accepted/declined so any future certified writer can preserve
// the intended shown→accept attribution.
type EventInput struct {
	PaidSubID           string    `json:"paid_sub_id,omitempty"`
	SubscriberEmail     string    `json:"subscriber_email,omitempty"`
	EventType           EventType `json:"event_type"`
	StripeApplicationID string    `json:"stripe_application_id,omitempty"`
}

// FunnelTile bundles the headline counts for the dashboard's
// retention-offer card. Acceptance rate is accepted / shown, with zero on the
// wire when shown is zero.
type FunnelTile struct {
	OfferID        string  `json:"offer_id"`
	TierID         string  `json:"tier_id"`
	Shown          int64   `json:"shown"`
	Accepted       int64   `json:"accepted"`
	Declined       int64   `json:"declined"`
	Expired        int64   `json:"expired"`
	AcceptanceRate float64 `json:"acceptance_rate"`
}

// Errors surfaced to the HTTP layer.
var (
	ErrNotFound                  = errors.New("retention_offers: not found")
	ErrTierRequired              = errors.New("retention_offers: paywall_tier_id required")
	ErrAmountInvalid             = errors.New("retention_offers: exactly one of percent_off or fixed_off_cents must be set")
	ErrDurationRange             = errors.New("retention_offers: duration_months must be in [1, 60]")
	ErrInvalidEvent              = errors.New("retention_offers: event_type must be one of shown|accepted|declined|expired")
	ErrTierConflict              = errors.New("retention_offers: offer already exists for this tier")
	ErrStripeBridgeUnavailable   = errors.New("retention_offers: Stripe bridge unavailable")
	ErrProviderReferenceRequired = errors.New("retention_offers: Stripe subscription and coupon references required")
	// ErrOfferFieldInvalid is the errors.Is sentinel for an offer string that
	// cannot be represented by the bounded client contract.
	ErrOfferFieldInvalid = errors.New("retention_offers: offer field violates the bounded wire contract")
	// ErrFunnelProjectionInvalid marks stored aggregate evidence that cannot be
	// represented by the strict all-platform response contract.
	ErrFunnelProjectionInvalid = errors.New("retention_offers: funnel projection violates the bounded wire contract")
	// ErrReadSetTooLarge is the errors.Is sentinel for a complete admin read
	// that cannot fit inside MaxReadRows. Callers can errors.As the concrete
	// *ReadSetTooLargeError to retain the resource and limit metadata.
	ErrReadSetTooLarge = errors.New("retention_offers: result set exceeds read limit")
)

// OfferFieldError identifies a bounded wire-contract violation without
// carrying the rejected value (which may contain provider data or unsafe
// display controls).
type OfferFieldError struct {
	Field    string
	MaxBytes int
}

func (e *OfferFieldError) Error() string {
	return fmt.Sprintf("retention_offers: %s must be a trimmed safe UTF-8 string of at most %d bytes", e.Field, e.MaxBytes)
}

func (e *OfferFieldError) Unwrap() error { return ErrOfferFieldInvalid }

// FunnelProjectionError identifies the invalid aggregate field without
// retaining any tenant or offer identity.
type FunnelProjectionError struct {
	Field string
}

func (e *FunnelProjectionError) Error() string {
	return fmt.Sprintf("retention_offers: funnel %s violates the bounded wire contract", e.Field)
}

func (e *FunnelProjectionError) Unwrap() error { return ErrFunnelProjectionInvalid }

// ReadSetTooLargeError identifies which complete retention-offer projection
// exceeded its hard row ceiling. It deliberately carries no tenant data.
type ReadSetTooLargeError struct {
	Resource string
	Limit    int
}

func (e *ReadSetTooLargeError) Error() string {
	return fmt.Sprintf("retention_offers: %s result exceeds %d rows", e.Resource, e.Limit)
}

// Unwrap supports stable errors.Is matching without discarding typed details.
func (e *ReadSetTooLargeError) Unwrap() error { return ErrReadSetTooLarge }

// StripeBridge defines the dormant provider boundary for mirroring offer
// coupons. Production does not mount the methods that call it. A future
// certified implementation must be idempotent on (tenant_id, offer_id), and a
// nil bridge remains an error so local intent cannot masquerade as an applied
// billing discount.
type StripeBridge interface {
	// UpsertCoupon mints (or updates) the Stripe coupon backing a
	// retention offer. Returns the coupon id to persist back on the
	// row so future Activate calls can target the same Stripe object.
	UpsertCoupon(ctx context.Context, tenantID string, offer Offer) (couponID string, err error)
	// ApplyToSubscription attaches the offer's coupon to a Stripe
	// subscription on accept. Returns a Stripe application id that
	// we persist in the retention_offer_events row so support can
	// trace a specific accept back to a Stripe receipt.
	ApplyToSubscription(ctx context.Context, tenantID, stripeSubscriptionID, couponID string) (applicationID string, err error)
}

// Repo is the pgx-backed data-access layer. All methods route through
// db.WithTenant so RLS clamps reads + writes to the caller's tenant.
type Repo struct {
	Pool   *db.Pool
	Bridge StripeBridge
}

// validate normalises an OfferInput and returns an error if it can't be
// saved. Mutates the receiver so the caller can re-read the canonical
// fields (e.g. DurationMonths default).
func (in *OfferInput) validate() error {
	in.PaywallTierID = strings.TrimSpace(in.PaywallTierID)
	if in.PaywallTierID == "" {
		return ErrTierRequired
	}
	hasPct := in.PercentOff != nil
	hasFixed := in.FixedOffCents != nil
	if hasPct == hasFixed {
		return ErrAmountInvalid
	}
	if hasPct {
		if *in.PercentOff < 1 || *in.PercentOff > 100 {
			return ErrAmountInvalid
		}
	} else {
		if *in.FixedOffCents <= 0 {
			return ErrAmountInvalid
		}
	}
	if in.DurationMonths == 0 {
		in.DurationMonths = 1
	}
	if in.DurationMonths < 1 || in.DurationMonths > 60 {
		return ErrDurationRange
	}
	in.Headline = strings.TrimSpace(in.Headline)
	in.Body = strings.TrimSpace(in.Body)
	if err := validateOfferString("headline", in.Headline, MaxHeadlineBytes); err != nil {
		return err
	}
	if err := validateOfferString("body", in.Body, MaxBodyBytes); err != nil {
		return err
	}
	return nil
}

func validateOfferString(field, value string, maxBytes int) error {
	if value == "" {
		return nil
	}
	if !utf8.ValidString(value) || len(value) > maxBytes || value != strings.TrimSpace(value) {
		return &OfferFieldError{Field: field, MaxBytes: maxBytes}
	}
	for _, character := range value {
		if character <= '\u0008' || character == '\u000b' || character == '\u000c' ||
			(character >= '\u000e' && character <= '\u001f') || character == '\u007f' ||
			(character >= '\u202a' && character <= '\u202e') ||
			(character >= '\u2066' && character <= '\u2069') {
			return &OfferFieldError{Field: field, MaxBytes: maxBytes}
		}
	}
	return nil
}

func (o *Offer) validateReadProjection() error {
	if err := validateOfferString("headline", o.Headline, MaxHeadlineBytes); err != nil {
		return err
	}
	if err := validateOfferString("body", o.Body, MaxBodyBytes); err != nil {
		return err
	}
	return validateOfferString("stripe_coupon_id", o.StripeCouponID, MaxProviderReferenceBytes)
}

func (t *FunnelTile) validateReadProjection() error {
	counts := []struct {
		field string
		value int64
	}{
		{field: "shown", value: t.Shown},
		{field: "accepted", value: t.Accepted},
		{field: "declined", value: t.Declined},
		{field: "expired", value: t.Expired},
	}
	for _, count := range counts {
		if count.value < 0 || count.value > MaxFunnelEventCount {
			return &FunnelProjectionError{Field: count.field}
		}
	}
	if t.Accepted > t.Shown {
		return &FunnelProjectionError{Field: "accepted_exceeds_shown"}
	}
	return nil
}

// ListOffers returns the complete stored offer history (active + inactive) for
// the tenant's read-only admin surface when it fits inside MaxReadRows. The
// production portal and mutation routes are not mounted. Oversized catalogs
// return *ReadSetTooLargeError; partial history is never returned.
func (r *Repo) ListOffers(ctx context.Context, tenantID string) ([]Offer, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, paywall_tier_id::text,
       percent_off, fixed_off_cents, duration_months,
       COALESCE(headline, ''), COALESCE(body, ''),
       COALESCE(stripe_coupon_id, ''),
       active, created_at, updated_at
 FROM retention_offers
 WHERE tenant_id = $1::uuid
 ORDER BY active DESC, created_at DESC
 LIMIT $2`, tenantID, MaxReadRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Offer{}
	for rows.Next() {
		var o Offer
		if err := rows.Scan(&o.ID, &o.TenantID, &o.PaywallTierID,
			&o.PercentOff, &o.FixedOffCents, &o.DurationMonths,
			&o.Headline, &o.Body, &o.StripeCouponID,
			&o.Active, &o.CreatedAt, &o.UpdatedAt); err != nil {
			return nil, err
		}
		if err := o.validateReadProjection(); err != nil {
			return nil, err
		}
		out = append(out, o)
		if len(out) > MaxReadRows {
			return nil, &ReadSetTooLargeError{Resource: "offers", Limit: MaxReadRows}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// LookupByTier resolves the single active offer for a tier (or nil if none).
// It exists for the dormant portal integration; production does not mount that
// route while provider reconciliation and public-route controls are
// release-held. Returns (nil, nil) when no row matches so a future certified
// caller can branch on a clean zero-value.
func (r *Repo) LookupByTier(ctx context.Context, tenantID, tierID string) (*Offer, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var o Offer
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, paywall_tier_id::text,
       percent_off, fixed_off_cents, duration_months,
       COALESCE(headline, ''), COALESCE(body, ''),
       COALESCE(stripe_coupon_id, ''),
       active, created_at, updated_at
  FROM retention_offers
 WHERE tenant_id = $1::uuid
   AND paywall_tier_id = $2::uuid
   AND active = true`, tenantID, tierID).Scan(
		&o.ID, &o.TenantID, &o.PaywallTierID,
		&o.PercentOff, &o.FixedOffCents, &o.DurationMonths,
		&o.Headline, &o.Body, &o.StripeCouponID,
		&o.Active, &o.CreatedAt, &o.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err := o.validateReadProjection(); err != nil {
		return nil, err
	}
	return &o, tx.Commit(ctx)
}

// LookupByID is the single-row read retained for dormant event/provider paths.
// Those callers are not mounted in the production route set.
func (r *Repo) LookupByID(ctx context.Context, tenantID, id string) (*Offer, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var o Offer
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, paywall_tier_id::text,
       percent_off, fixed_off_cents, duration_months,
       COALESCE(headline, ''), COALESCE(body, ''),
       COALESCE(stripe_coupon_id, ''),
       active, created_at, updated_at
  FROM retention_offers
 WHERE id = $1::uuid`, id).Scan(
		&o.ID, &o.TenantID, &o.PaywallTierID,
		&o.PercentOff, &o.FixedOffCents, &o.DurationMonths,
		&o.Headline, &o.Body, &o.StripeCouponID,
		&o.Active, &o.CreatedAt, &o.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := o.validateReadProjection(); err != nil {
		return nil, err
	}
	return &o, tx.Commit(ctx)
}

// UpsertOffer creates or updates an offer. Empty ID inserts; non-empty
// updates. On insert, ON CONFLICT (tenant_id, paywall_tier_id) updates
// the existing row — one offer per tier is the v1 contract. On a
// successful active insert, a configured Bridge must mint a Stripe coupon
// before the local transaction commits. Provider failure is returned; an
// active local offer must never exist without its billing-side coupon.
func (r *Repo) UpsertOffer(ctx context.Context, tenantID string, in OfferInput) (*Offer, error) {
	if err := (&in).validate(); err != nil {
		return nil, err
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	if active && (r == nil || r.Bridge == nil) {
		return nil, ErrStripeBridgeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var o Offer
	if strings.TrimSpace(in.ID) == "" {
		err = tx.QueryRow(ctx, `
INSERT INTO retention_offers
    (tenant_id, paywall_tier_id, percent_off, fixed_off_cents,
     duration_months, headline, body, active)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULLIF($6,''), NULLIF($7,''), $8)
ON CONFLICT (tenant_id, paywall_tier_id) DO UPDATE SET
    percent_off       = EXCLUDED.percent_off,
    fixed_off_cents   = EXCLUDED.fixed_off_cents,
    duration_months   = EXCLUDED.duration_months,
    headline          = EXCLUDED.headline,
    body              = EXCLUDED.body,
    active            = EXCLUDED.active,
    updated_at        = now()
RETURNING id::text, tenant_id::text, paywall_tier_id::text,
          percent_off, fixed_off_cents, duration_months,
          COALESCE(headline,''), COALESCE(body,''),
          COALESCE(stripe_coupon_id,''),
          active, created_at, updated_at`,
			tenantID, in.PaywallTierID, in.PercentOff, in.FixedOffCents,
			in.DurationMonths, strings.TrimSpace(in.Headline),
			strings.TrimSpace(in.Body), active).Scan(
			&o.ID, &o.TenantID, &o.PaywallTierID,
			&o.PercentOff, &o.FixedOffCents, &o.DurationMonths,
			&o.Headline, &o.Body, &o.StripeCouponID,
			&o.Active, &o.CreatedAt, &o.UpdatedAt)
	} else {
		err = tx.QueryRow(ctx, `
UPDATE retention_offers
   SET percent_off     = $3,
       fixed_off_cents = $4,
       duration_months = $5,
       headline        = NULLIF($6,''),
       body            = NULLIF($7,''),
       active          = $8,
       updated_at      = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 RETURNING id::text, tenant_id::text, paywall_tier_id::text,
           percent_off, fixed_off_cents, duration_months,
           COALESCE(headline,''), COALESCE(body,''),
           COALESCE(stripe_coupon_id,''),
           active, created_at, updated_at`,
			tenantID, in.ID, in.PercentOff, in.FixedOffCents,
			in.DurationMonths, strings.TrimSpace(in.Headline),
			strings.TrimSpace(in.Body), active).Scan(
			&o.ID, &o.TenantID, &o.PaywallTierID,
			&o.PercentOff, &o.FixedOffCents, &o.DurationMonths,
			&o.Headline, &o.Body, &o.StripeCouponID,
			&o.Active, &o.CreatedAt, &o.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrTierConflict
		}
		return nil, err
	}
	if o.Active {
		couponID, bridgeErr := r.Bridge.UpsertCoupon(ctx, tenantID, o)
		if bridgeErr != nil {
			return nil, fmt.Errorf("retention_offers: Stripe upsert: %w", bridgeErr)
		}
		couponID = strings.TrimSpace(couponID)
		if couponID == "" {
			return nil, errors.New("retention_offers: Stripe upsert returned no coupon id")
		}
		if err := validateOfferString("stripe_coupon_id", couponID, MaxProviderReferenceBytes); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx,
			`UPDATE retention_offers
                SET stripe_coupon_id = $2, updated_at = now()
              WHERE tenant_id = $1::uuid AND id = $3::uuid`,
			tenantID, couponID, o.ID); err != nil {
			return nil, err
		}
		o.StripeCouponID = couponID
	}
	if err := o.validateReadProjection(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &o, nil
}

// DeactivateOffer soft-deletes by flipping active=false. Preserves the
// row + its event history so the funnel tile still resolves for past
// events.
func (r *Repo) DeactivateOffer(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE retention_offers
   SET active = false, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// LogEvent appends one row to retention_offer_events. Validates the
// event_type up-front so the handler returns 422 instead of letting the
// DB CHECK trip a 500.
func (r *Repo) LogEvent(ctx context.Context, tenantID, offerID string, in EventInput) (*Event, error) {
	switch in.EventType {
	case EventShown, EventAccepted, EventDeclined, EventExpired:
	default:
		return nil, ErrInvalidEvent
	}
	// Verify the offer belongs to this tenant before logging — RLS
	// guards inserts too, but the explicit lookup gives a cleaner
	// not_found path than the generic insert-failure surface.
	if _, err := r.LookupByID(ctx, tenantID, offerID); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var e Event
	var paidSubID, email, applicationID *string
	if s := strings.TrimSpace(in.PaidSubID); s != "" {
		paidSubID = &s
	}
	if s := strings.TrimSpace(strings.ToLower(in.SubscriberEmail)); s != "" {
		email = &s
	}
	if s := strings.TrimSpace(in.StripeApplicationID); s != "" {
		applicationID = &s
	}
	err = tx.QueryRow(ctx, `
INSERT INTO retention_offer_events
    (tenant_id, offer_id, paid_sub_id, subscriber_email,
     event_type, stripe_application_id)
VALUES ($1::uuid, $2::uuid,
        NULLIF($3,'')::uuid, NULLIF($4,''),
        $5, NULLIF($6,''))
RETURNING id, offer_id::text,
          COALESCE(paid_sub_id::text, ''),
          COALESCE(subscriber_email, ''),
          event_type,
          COALESCE(stripe_application_id, ''),
          created_at`,
		tenantID, offerID,
		ptrOrEmpty(paidSubID), ptrOrEmpty(email),
		string(in.EventType), ptrOrEmpty(applicationID)).Scan(
		&e.ID, &e.OfferID, &e.PaidSubID, &e.SubscriberEmail,
		&e.EventType, &e.StripeApplicationID, &e.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &e, tx.Commit(ctx)
}

// AcceptOffer is retained for a future certified cancel-flow integration; its
// handler is not mounted in production. If activated later, it applies the
// provider coupon before logging acceptance. Provider failures return without
// an accepted event so intent cannot be confused with an applied offer.
func (r *Repo) AcceptOffer(ctx context.Context, tenantID, offerID, stripeSubscriptionID string, in EventInput) (*Event, error) {
	in.EventType = EventAccepted
	if r == nil || r.Bridge == nil {
		return nil, ErrStripeBridgeUnavailable
	}
	offer, err := r.LookupByID(ctx, tenantID, offerID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(offer.StripeCouponID) == "" || strings.TrimSpace(stripeSubscriptionID) == "" {
		return nil, ErrProviderReferenceRequired
	}
	appID, err := r.Bridge.ApplyToSubscription(ctx, tenantID, stripeSubscriptionID, offer.StripeCouponID)
	if err != nil {
		return nil, fmt.Errorf("retention_offers: Stripe apply: %w", err)
	}
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return nil, errors.New("retention_offers: Stripe apply returned no application id")
	}
	in.StripeApplicationID = appID
	return r.LogEvent(ctx, tenantID, offerID, in)
}

// LoadFunnel aggregates stored events into shown / accepted / declined /
// expired counts per offer for the read-only admin history surface. It returns
// one row per stored offer even when there are no events. Results over
// MaxReadRows fail with *ReadSetTooLargeError; partial evidence is never
// returned.
func (r *Repo) LoadFunnel(ctx context.Context, tenantID string) ([]FunnelTile, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT o.id::text, o.paywall_tier_id::text,
       COALESCE(SUM(CASE WHEN e.event_type = 'shown'    THEN 1 ELSE 0 END), 0) AS shown,
       COALESCE(SUM(CASE WHEN e.event_type = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
       COALESCE(SUM(CASE WHEN e.event_type = 'declined' THEN 1 ELSE 0 END), 0) AS declined,
       COALESCE(SUM(CASE WHEN e.event_type = 'expired'  THEN 1 ELSE 0 END), 0) AS expired
  FROM retention_offers o
  LEFT JOIN retention_offer_events e
    ON e.tenant_id = o.tenant_id AND e.offer_id = o.id
 WHERE o.tenant_id = $1::uuid
 GROUP BY o.id, o.paywall_tier_id
 ORDER BY shown DESC, o.created_at DESC
 LIMIT $2`, tenantID, MaxReadRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FunnelTile{}
	for rows.Next() {
		var t FunnelTile
		if err := rows.Scan(&t.OfferID, &t.TierID,
			&t.Shown, &t.Accepted, &t.Declined, &t.Expired); err != nil {
			return nil, err
		}
		if err := t.validateReadProjection(); err != nil {
			return nil, err
		}
		if t.Shown > 0 {
			t.AcceptanceRate = float64(t.Accepted) / float64(t.Shown)
		}
		out = append(out, t)
		if len(out) > MaxReadRows {
			return nil, &ReadSetTooLargeError{Resource: "funnel", Limit: MaxReadRows}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ptrOrEmpty unwraps a *string to "" when nil so the NULLIF($n,”) idiom
// in the INSERT can convert to NULL. We pass strings (not *string)
// because the pgx driver's NULLIF handling on a typed-nil *string vs a
// literal NULL is brittle across versions — explicit empty is portable.
func ptrOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// FormatAmount renders a human-readable summary of an offer's
// percent_off / fixed_off_cents tuple. Used by the handler when
// composing the modal payload and by tests for assertions. Kept in the
// data package (vs the handler) so a future server-rendered email
// template can call the same formatter.
func (o *Offer) FormatAmount() string {
	if o.PercentOff != nil {
		return fmt.Sprintf("%d%% off", *o.PercentOff)
	}
	if o.FixedOffCents != nil {
		// The legacy retention_offers table has no currency column. Cents do
		// not imply USD, so a fixed amount cannot be labelled honestly. Keep it
		// unavailable until the schema and provider contract carry currency.
		return ""
	}
	return ""
}
