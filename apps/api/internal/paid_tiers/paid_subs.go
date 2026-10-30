// Package paid_tiers retains read-only access to historical paid and gift
// subscription records plus the provider seam required before paid commerce
// can be enabled. Mutation routes are deliberately not mounted until a real,
// reconciled Stripe implementation is available.
package paid_tiers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/discounts"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Interval is the Stripe billing interval.
type Interval string

const (
	IntervalMonth Interval = "month"
	IntervalYear  Interval = "year"
)

// PaidSub is the public projection of a paid_subs row.
type PaidSub struct {
	ID                   string     `json:"id"`
	TenantID             string     `json:"tenant_id"`
	SubscriberEmail      string     `json:"subscriber_email"`
	PlanID               string     `json:"plan_id"`
	Status               string     `json:"status"`
	BillingInterval      Interval   `json:"interval"`
	FoundingMember       bool       `json:"founding_member"`
	ExtraAmountCents     int        `json:"extra_amount_cents"`
	DiscountCode         string     `json:"discount_code,omitempty"`
	TrialEndsAt          *time.Time `json:"trial_ends_at,omitempty"`
	CurrentPeriodEnd     *time.Time `json:"current_period_end,omitempty"`
	StripeSubscriptionID string     `json:"stripe_subscription_id,omitempty"`
	StripeCustomerID     string     `json:"stripe_customer_id,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
}

// PaidSubCreateInput accepts the SDK paid_sub create body, additively
// extended to carry the new Sprint X3 fields. Older clients that omit the
// new fields fall through to the same defaults the schema sets.
type PaidSubCreateInput struct {
	SubscriberEmail  string   `json:"subscriber_email"`
	PlanID           string   `json:"plan_id"`
	TrialDays        int      `json:"trial_days,omitempty"`
	Interval         Interval `json:"interval,omitempty"`
	FoundingMember   bool     `json:"founding_member,omitempty"`
	ExtraAmountCents int      `json:"extra_amount_cents,omitempty"`
	DiscountCode     string   `json:"discount_code,omitempty"`
}

// GiftSub is the projection of a gift_subscriptions row.
type GiftSub struct {
	ID               string     `json:"id"`
	TenantID         string     `json:"tenant_id"`
	PurchaserEmail   string     `json:"purchaser_email"`
	RecipientEmail   string     `json:"recipient_email"`
	PlanID           string     `json:"plan_id"`
	DurationMonths   int        `json:"duration_months"`
	Message          string     `json:"message,omitempty"`
	Status           string     `json:"status"`
	StripeInvoiceID  string     `json:"stripe_invoice_id,omitempty"`
	StripePaymentURL string     `json:"stripe_payment_url,omitempty"`
	GrantedAt        *time.Time `json:"granted_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	// RedemptionURL is the public link the recipient clicks to claim
	// the gift. Returned ONCE at create time — the raw token is never
	// re-issued. The dashboard's "Resend gift" affordance uses this
	// to email the recipient.
	RedemptionURL string `json:"redemption_url,omitempty"`
	// RedeemedAt is set when the recipient clicks Claim on the public
	// redemption page. Mirror of GrantedAt; both refer to "the
	// recipient now has access."
	RedeemedAt *time.Time `json:"redeemed_at,omitempty"`
	// ExpiresAt is when an unclaimed pending gift auto-expires.
	// Default 90d from create; the sweeper transitions stale rows to
	// status='expired'.
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
	// CanceledAt + CancelReason capture operator-initiated cancels
	// via POST /api/v1/gift-subscriptions/{id}/cancel.
	CanceledAt   *time.Time `json:"canceled_at,omitempty"`
	CancelReason string     `json:"cancel_reason,omitempty"`
	// GifterSubscriberID links the purchaser to a known subscriber row
	// when the gift originated from an existing member.
	GifterSubscriberID string `json:"gifter_subscriber_id,omitempty"`
	// GifterAttributionToken is the short ?ref= code stamped onto the
	// one-time redemption link for word-of-mouth attribution.
	GifterAttributionToken string `json:"gifter_attribution_token,omitempty"`
}

// GiftSubCreateInput is the body for POST /api/v1/gift-subscriptions.
type GiftSubCreateInput struct {
	PurchaserEmail     string `json:"purchaser_email"`
	RecipientEmail     string `json:"recipient_email"`
	PlanID             string `json:"plan_id"`
	DurationMonths     int    `json:"duration_months"`
	Message            string `json:"message,omitempty"`
	GifterSubscriberID string `json:"gifter_subscriber_id,omitempty"`
}

const paidTierJSONMaxBodyBytes int64 = 64 << 10 // 64 KiB

// ErrNotFound is returned when a row lookup misses.
var ErrNotFound = errors.New("paid_tiers: not found")

// ErrStripeBridgeUnavailable prevents local money/subscription state from
// being persisted when no verified payment-provider implementation exists.
var ErrStripeBridgeUnavailable = errors.New("paid_tiers: Stripe bridge unavailable")

// StripeBridge mirrors a paid sub onto Stripe. Implementations MUST
// pass idempotencyKey through to Stripe's `Idempotency-Key` request
// header. Stripe deduplicates on that key for 24h, so a retry of the
// same (tenant, subscriber, plan) call returns the original Stripe
// object instead of minting a second subscription / invoice.
//
// Two layers of idempotency apply here:
//
//  1. INBOUND: the route is mounted inside the apps/api idempotency
//     middleware group — same Idempotency-Key from the client returns
//     the cached HTTP response byte-for-byte without re-running the
//     handler.
//  2. OUTBOUND (this parameter): handles the rare case where the
//     handler ran (Stripe call succeeded) but our local DB commit
//     failed, leaving no cached response. The client's retry then
//     reaches Stripe a second time — without the key, Stripe creates
//     a second subscription; with it, Stripe returns the original
//     and the local row is recreated cleanly.
//
// A nil bridge is an error. Paid state must never fall back to local-only
// success because that would diverge from the payment provider.
type StripeBridge interface {
	CreateSubscription(ctx context.Context, tenantID, idempotencyKey string, in PaidSubCreateInput) (subID, customerID string, periodEnd time.Time, err error)
	CreateGiftInvoice(ctx context.Context, tenantID, idempotencyKey string, in GiftSubCreateInput) (invoiceID, paymentURL string, err error)
	// UpdateSubscription is called by SetInterval / MarkFounding to
	// push billing-interval and founding-member contribution changes
	// onto the existing Stripe subscription. stripeSubID must identify
	// a provider-backed subscription. Audit finding H2: without this, local DB and
	// Stripe state silently diverge on next renewal.
	UpdateSubscription(ctx context.Context, tenantID, idempotencyKey, stripeSubID string, patch SubscriptionPatch) error
}

// SubscriptionPatch is the diff applied to an existing Stripe sub.
// Zero/empty fields mean "don't change".
type SubscriptionPatch struct {
	Interval         Interval
	FoundingMember   bool
	ExtraAmountCents int
}

// derivePaidSubIdempotencyKey computes a stable Stripe-side idempotency
// key for a paid-sub creation. Same (tenant, subscriber, plan,
// interval, trial_days) tuple → same key, so a retried POST converges
// to the original Stripe subscription object.
func derivePaidSubIdempotencyKey(tenantID string, in PaidSubCreateInput) string {
	src := fmt.Sprintf("paidsub|%s|%s|%s|%s|%d",
		tenantID,
		strings.ToLower(strings.TrimSpace(in.SubscriberEmail)),
		strings.TrimSpace(in.PlanID),
		string(in.Interval),
		in.TrialDays,
	)
	h := sha256.Sum256([]byte(src))
	return "pw_paidsub_" + hex.EncodeToString(h[:16])
}

// deriveGiftIdempotencyKey is the gift-subscription counterpart.
func deriveGiftIdempotencyKey(tenantID string, in GiftSubCreateInput) string {
	src := fmt.Sprintf("gift|%s|%s|%s|%s|%d",
		tenantID,
		strings.ToLower(strings.TrimSpace(in.PurchaserEmail)),
		strings.ToLower(strings.TrimSpace(in.RecipientEmail)),
		strings.TrimSpace(in.PlanID),
		in.DurationMonths,
	)
	h := sha256.Sum256([]byte(src))
	return "pw_gift_" + hex.EncodeToString(h[:16])
}

// Repo is the pgx repository for paid_subs + gift_subscriptions.
type Repo struct {
	Pool      *db.Pool
	Bridge    StripeBridge
	Discounts *discounts.Repo
	// PublicBaseURL is the origin the recipient hits to claim a gift
	// (e.g. "https://app.moosewave.com"). The redemption URL is
	// constructed as `${PublicBaseURL}/gift/${raw_token}`. Empty
	// disables URL generation — useful for tests that don't care
	// about the link shape.
	PublicBaseURL string
	// GiftExpiryDays caps how long an unclaimed pending gift lives
	// before the sweeper transitions it to status='expired'. Zero
	// falls back to DefaultGiftExpiryDays (90).
	GiftExpiryDays int
	// Notifier, when set, fires recipient + giver emails on the
	// gift lifecycle events (created / redeemed / canceled /
	// expired). Nil = silent (tests, dev sandbox).
	Notifier GiftNotifier
}

// CreatePaidSub provisions a paid subscription end-to-end.
func (r *Repo) CreatePaidSub(ctx context.Context, tenantID string, in PaidSubCreateInput) (*PaidSub, error) {
	if strings.TrimSpace(in.SubscriberEmail) == "" || strings.TrimSpace(in.PlanID) == "" {
		return nil, fmt.Errorf("subscriber_email and plan_id required")
	}
	if in.Interval == "" {
		in.Interval = IntervalMonth
	}
	if in.Interval != IntervalMonth && in.Interval != IntervalYear {
		return nil, fmt.Errorf("interval must be month|year")
	}
	if in.ExtraAmountCents < 0 {
		return nil, fmt.Errorf("extra_amount_cents must be >= 0")
	}

	if in.DiscountCode != "" && r.Discounts != nil {
		_, err := r.Discounts.GetByCode(ctx, tenantID, in.DiscountCode)
		if err != nil {
			if errors.Is(err, discounts.ErrNotFound) {
				return nil, fmt.Errorf("unknown discount_code")
			}
			return nil, err
		}
	}

	if r == nil || r.Bridge == nil {
		return nil, ErrStripeBridgeUnavailable
	}
	idemKey := derivePaidSubIdempotencyKey(tenantID, in)
	subID, custID, periodEnd, err := r.Bridge.CreateSubscription(ctx, tenantID, idemKey, in)
	if err != nil {
		return nil, fmt.Errorf("stripe bridge: %w", err)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var trialEnds *time.Time
	if in.TrialDays > 0 {
		t := time.Now().UTC().AddDate(0, 0, in.TrialDays)
		trialEnds = &t
	}
	var pe *time.Time
	if !periodEnd.IsZero() {
		pe = &periodEnd
	}
	out := PaidSub{
		TenantID:             tenantID,
		SubscriberEmail:      strings.ToLower(in.SubscriberEmail),
		PlanID:               in.PlanID,
		BillingInterval:      in.Interval,
		FoundingMember:       in.FoundingMember,
		ExtraAmountCents:     in.ExtraAmountCents,
		DiscountCode:         in.DiscountCode,
		TrialEndsAt:          trialEnds,
		CurrentPeriodEnd:     pe,
		StripeSubscriptionID: subID,
		StripeCustomerID:     custID,
	}
	row := tx.QueryRow(ctx, `
INSERT INTO paid_subs (tenant_id, subscriber_email, plan_id, billing_interval,
        founding_member, extra_amount_cents, discount_code, trial_ends_at,
        current_period_end, stripe_subscription_id, stripe_customer_id,
        status)
VALUES ($1::uuid, $2, $3, $4, $5, $6, NULLIF($7,''), $8, $9,
        NULLIF($10,''), NULLIF($11,''), CASE WHEN $8 IS NOT NULL THEN 'trialing' ELSE 'active' END)
ON CONFLICT (tenant_id, subscriber_email, plan_id) DO UPDATE SET
    billing_interval = EXCLUDED.billing_interval,
    founding_member  = EXCLUDED.founding_member,
    extra_amount_cents = EXCLUDED.extra_amount_cents,
    discount_code    = EXCLUDED.discount_code,
    updated_at       = now()
RETURNING id::text, status, created_at`,
		tenantID, out.SubscriberEmail, out.PlanID, string(out.BillingInterval),
		out.FoundingMember, out.ExtraAmountCents, out.DiscountCode,
		trialEnds, pe, subID, custID)
	if err := row.Scan(&out.ID, &out.Status, &out.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetInterval flips a paid sub between monthly and yearly billing.
// Tells Stripe FIRST (so a failure leaves local state untouched and
// surfaces the error to the operator) then commits locally. Audit
// finding H2: previously this only wrote the local row, so next
// Stripe renewal billed the OLD interval and the tenant was
// over/under-charged with no signal.
func (r *Repo) SetInterval(ctx context.Context, tenantID, id string, interval Interval) error {
	if interval != IntervalMonth && interval != IntervalYear {
		return fmt.Errorf("interval must be month|year")
	}
	if r == nil || r.Bridge == nil {
		return ErrStripeBridgeUnavailable
	}
	existing, err := r.LookupPaidSubByID(ctx, tenantID, id)
	if err != nil {
		return err
	}
	idemKey := fmt.Sprintf("pw_paidsub_interval_%s_%s_%s", tenantID, id, interval)
	if err := r.Bridge.UpdateSubscription(ctx, tenantID, idemKey, existing.StripeSubscriptionID, SubscriptionPatch{
		Interval: interval,
	}); err != nil {
		return fmt.Errorf("stripe bridge: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`UPDATE paid_subs SET billing_interval = $2, updated_at = now()
         WHERE tenant_id = $1::uuid AND id = $3::uuid`,
		tenantID, string(interval), id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// MarkFounding flags a paid sub as a founding-member tier and records the
// optional above-floor contribution. Pushes the contribution change to
// Stripe before committing locally (same H2 finding rationale as
// SetInterval).
func (r *Repo) MarkFounding(ctx context.Context, tenantID, id string, extraCents int) error {
	if extraCents < 0 {
		return fmt.Errorf("extra_amount_cents must be >= 0")
	}
	if r == nil || r.Bridge == nil {
		return ErrStripeBridgeUnavailable
	}
	existing, err := r.LookupPaidSubByID(ctx, tenantID, id)
	if err != nil {
		return err
	}
	idemKey := fmt.Sprintf("pw_paidsub_founding_%s_%s_%d", tenantID, id, extraCents)
	if err := r.Bridge.UpdateSubscription(ctx, tenantID, idemKey, existing.StripeSubscriptionID, SubscriptionPatch{
		FoundingMember:   true,
		ExtraAmountCents: extraCents,
	}); err != nil {
		return fmt.Errorf("stripe bridge: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`UPDATE paid_subs SET founding_member = true, extra_amount_cents = $2, updated_at = now()
         WHERE tenant_id = $1::uuid AND id = $3::uuid`,
		tenantID, extraCents, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// CreateGift inserts a pending gift subscription row, mints a
// unique redemption token (sha256 stored; raw returned in
// RedemptionURL ONCE), and asks the bridge to mint a Stripe invoice
// for the purchaser. The recipient claims via
// /api/public/gifts/{token}/redeem (see gifts.go).
//
// expires_at is set to (PublicBaseURL determines hostname)
// created_at + r.GiftExpiryDays days (default 90 — see gifts.go).
// The sweeper transitions unclaimed pending rows to status='expired'
// after this cliff so the dashboard's "pending" count stays
// meaningful.
func (r *Repo) CreateGift(ctx context.Context, tenantID string, in GiftSubCreateInput) (*GiftSub, error) {
	if in.PurchaserEmail == "" || in.RecipientEmail == "" || in.PlanID == "" {
		return nil, fmt.Errorf("purchaser_email, recipient_email, plan_id required")
	}
	if in.DurationMonths < 1 || in.DurationMonths > 60 {
		return nil, fmt.Errorf("duration_months must be in [1,60]")
	}
	if r == nil || r.Bridge == nil {
		return nil, ErrStripeBridgeUnavailable
	}
	idemKey := deriveGiftIdempotencyKey(tenantID, in)
	invoiceID, payURL, err := r.Bridge.CreateGiftInvoice(ctx, tenantID, idemKey, in)
	if err != nil {
		return nil, fmt.Errorf("stripe bridge: %w", err)
	}

	// Mint redemption token. 32 random bytes → 43-char base64-url.
	rawToken, tokenHash, err := mintRedemptionToken()
	if err != nil {
		return nil, fmt.Errorf("mint token: %w", err)
	}
	days := r.GiftExpiryDays
	if days <= 0 {
		days = DefaultGiftExpiryDays
	}
	expiresAt := time.Now().UTC().AddDate(0, 0, days)

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	gifterID := strings.TrimSpace(in.GifterSubscriberID)
	if gifterID == "" {
		if resolved, err := resolveGifterSubscriber(ctx, tx, tenantID, in.PurchaserEmail); err != nil {
			return nil, err
		} else {
			gifterID = resolved
		}
	}
	attributionToken, err := mintAttributionToken()
	if err != nil {
		return nil, fmt.Errorf("mint attribution token: %w", err)
	}
	g := GiftSub{
		TenantID:               tenantID,
		PurchaserEmail:         strings.ToLower(in.PurchaserEmail),
		RecipientEmail:         strings.ToLower(in.RecipientEmail),
		PlanID:                 in.PlanID,
		DurationMonths:         in.DurationMonths,
		Message:                in.Message,
		StripeInvoiceID:        invoiceID,
		StripePaymentURL:       payURL,
		ExpiresAt:              &expiresAt,
		GifterSubscriberID:     gifterID,
		GifterAttributionToken: attributionToken,
	}
	row := tx.QueryRow(ctx, `
INSERT INTO gift_subscriptions (tenant_id, purchaser_email, recipient_email,
        plan_id, duration_months, message, stripe_invoice_id, stripe_payment_url,
        redemption_token_sha256, expires_at, gifter_subscriber_id, gifter_attribution_token)
VALUES ($1::uuid, $2, $3, $4, $5, NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
        $9, $10, NULLIF($11,'')::uuid, NULLIF($12,''))
RETURNING id::text, status, created_at`,
		tenantID, g.PurchaserEmail, g.RecipientEmail, g.PlanID, g.DurationMonths,
		g.Message, invoiceID, payURL, tokenHash[:], expiresAt,
		g.GifterSubscriberID, g.GifterAttributionToken)
	if err := row.Scan(&g.ID, &g.Status, &g.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Return the raw token to the caller exactly once. The dashboard
	// renders it as a copyable redemption URL; the recipient email
	// embeds it too.
	g.RedemptionURL = giftRedemptionURL(r.PublicBaseURL, rawToken)
	if g.GifterAttributionToken != "" {
		g.RedemptionURL += "?ref=" + g.GifterAttributionToken
	}
	// Fire-and-forget the notifier (recipient + giver emails). Nil
	// notifier (tests, dev) silently skips.
	if r.Notifier != nil {
		go r.Notifier.SendGiftCreated(context.Background(), g, rawToken)
	}
	return &g, nil
}

// ListGifts returns all gift subscriptions for the tenant, newest first.
func (r *Repo) ListGifts(ctx context.Context, tenantID string) ([]GiftSub, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, purchaser_email, recipient_email, plan_id,
       duration_months, COALESCE(message,''), status,
       COALESCE(stripe_invoice_id,''), COALESCE(stripe_payment_url,''),
       granted_at, created_at,
       redeemed_at, expires_at, canceled_at, COALESCE(cancel_reason,''),
       COALESCE(gifter_subscriber_id::text,''), COALESCE(gifter_attribution_token,'')
FROM gift_subscriptions
WHERE tenant_id = $1::uuid
ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GiftSub{}
	for rows.Next() {
		var g GiftSub
		if err := rows.Scan(&g.ID, &g.TenantID, &g.PurchaserEmail, &g.RecipientEmail,
			&g.PlanID, &g.DurationMonths, &g.Message, &g.Status,
			&g.StripeInvoiceID, &g.StripePaymentURL, &g.GrantedAt, &g.CreatedAt,
			&g.RedeemedAt, &g.ExpiresAt, &g.CanceledAt, &g.CancelReason,
			&g.GifterSubscriberID, &g.GifterAttributionToken); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// LookupPaidSubByID returns one row.
func (r *Repo) LookupPaidSubByID(ctx context.Context, tenantID, id string) (*PaidSub, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p PaidSub
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, subscriber_email, plan_id, status,
       billing_interval, founding_member, extra_amount_cents, COALESCE(discount_code,''),
       trial_ends_at, current_period_end,
       COALESCE(stripe_subscription_id,''), COALESCE(stripe_customer_id,''), created_at
FROM paid_subs WHERE id = $1::uuid`, id)
	var interval string
	if err := row.Scan(&p.ID, &p.TenantID, &p.SubscriberEmail, &p.PlanID, &p.Status,
		&interval, &p.FoundingMember, &p.ExtraAmountCents, &p.DiscountCode,
		&p.TrialEndsAt, &p.CurrentPeriodEnd,
		&p.StripeSubscriptionID, &p.StripeCustomerID, &p.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	p.BillingInterval = Interval(interval)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &p, nil
}

// Deps bundles handler dependencies and exposes the route mount.
type Deps struct {
	Repo   *Repo
	Logger *slog.Logger
}

// MountRoutes registers the historical read-only endpoint. Paid and gift
// mutations are intentionally unmounted until a real provider adapter,
// reconciliation, and live contract certification exist.
func (d *Deps) MountRoutes(r chi.Router) {
	r.With(
		giftHistoryNoStore,
		apikeys.RequireScope(apikeys.ScopeReadReports),
	).Get("/api/v1/gift-subscriptions", d.ListGifts)
}

// CreatePaidSub POST /api/v1/paid-subs.
func (d *Deps) CreatePaidSub(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in PaidSubCreateInput
	if err := httpbody.DecodeJSON(w, r, paidTierJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.CreatePaidSub(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

// SetInterval POST /api/v1/paid-subs/{id}/interval.
func (d *Deps) SetInterval(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		Interval Interval `json:"interval"`
	}
	if err := httpbody.DecodeJSON(w, r, paidTierJSONMaxBodyBytes, &body); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if err := d.Repo.SetInterval(r.Context(), t.ID, id, body.Interval); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "paid subscription not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "interval": body.Interval})
}

// MarkFounding POST /api/v1/paid-subs/{id}/founding.
func (d *Deps) MarkFounding(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var body struct {
		ExtraAmountCents int `json:"extra_amount_cents"`
	}
	if r.ContentLength > 0 {
		if err := httpbody.DecodeJSONWith(w, r, paidTierJSONMaxBodyBytes, &body, httpbody.Options{AllowEmptyBody: true}); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
	}
	if err := d.Repo.MarkFounding(r.Context(), t.ID, id, body.ExtraAmountCents); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "paid subscription not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// CreateGift POST /api/v1/gift-subscriptions.
func (d *Deps) CreateGift(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in GiftSubCreateInput
	if err := httpbody.DecodeJSON(w, r, paidTierJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.CreateGift(r.Context(), t.ID, in)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	// p5-audit-gifts: audit the gift create. The "after" payload deliberately
	// excludes the raw redemption token + redemption URL — those are
	// one-shot secrets and a leaked audit row must not allow replay.
	audit.EmitOrLog(r.Context(), d.Repo.Pool,
		"gift_subscription.create", "gift_subscription", out.ID,
		nil, map[string]any{
			"id":              out.ID,
			"purchaser_email": out.PurchaserEmail,
			"recipient_email": out.RecipientEmail,
			"plan_id":         out.PlanID,
			"duration_months": out.DurationMonths,
			"status":          out.Status,
		}, nil)
	writeJSON(w, http.StatusCreated, out)
}

// ListGifts GET /api/v1/gift-subscriptions. The mounted archive returns only
// the sanitized GiftHistoryRecord projection; the internal GiftSub model is
// never serialized from this read path.
func (d *Deps) ListGifts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	query, err := giftHistoryQueryFromRequest(r)
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_query", "gift history query is invalid")
		return
	}
	page, err := d.Repo.ListGiftHistory(r.Context(), t.ID, query)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
