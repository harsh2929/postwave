package discounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo is the pgx repository for discounts + redemptions.
type Repo struct{ Pool *db.Pool }

// Create inserts a new discount row, mirrors it to Stripe via the bridge,
// then writes the returned ids back. The whole flow runs inside one
// tenant-scoped transaction so the local row never exists without the
// Stripe ids when the bridge succeeds.
func (r *Repo) Create(ctx context.Context, bridge StripeBridge, tenantID string, in CreateInput) (*Discount, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	currency := in.Currency
	if currency == "" {
		currency = "usd"
	}
	in.Currency = currency
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))

	if bridge == nil {
		return nil, ErrStripeBridgeUnavailable
	}
	couponID, promoID, err := bridge.UpsertCoupon(ctx, tenantID, in)
	if err != nil {
		return nil, err
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	d := Discount{
		TenantID:       tenantID,
		Code:           in.Code,
		PercentOff:     in.PercentOff,
		AmountOffCents: in.AmountOffCents,
		Currency:       in.Currency,
		MaxRedemptions: in.MaxRedemptions,
		ExpiresAt:      in.ExpiresAt,
		AppliesTo:      in.AppliesTo,
		StripeCouponID: couponID,
		StripePromoID:  promoID,
	}

	row := tx.QueryRow(ctx, `
INSERT INTO discounts (tenant_id, code, percent_off, amount_off_cents, currency,
        max_redemptions, expires_at, applies_to, stripe_coupon_id, stripe_promo_id)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, NULLIF($9,''), NULLIF($10,''))
RETURNING id::text, times_redeemed, created_at`,
		tenantID, d.Code, d.PercentOff, d.AmountOffCents, d.Currency,
		d.MaxRedemptions, d.ExpiresAt, string(d.AppliesTo), couponID, promoID)
	if err := row.Scan(&d.ID, &d.TimesRedeemed, &d.CreatedAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &d, nil
}

// List returns all discounts for the tenant, newest first. When q is
// non-empty it filters by code substring (case-insensitive ILIKE).
func (r *Repo) List(ctx context.Context, tenantID, q string) ([]Discount, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, code, percent_off, amount_off_cents, currency,
       max_redemptions, times_redeemed, expires_at, applies_to,
       COALESCE(stripe_coupon_id,''), COALESCE(stripe_promo_id,''), created_at
FROM discounts
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR code ILIKE '%' || $2 || '%')
ORDER BY created_at DESC`, tenantID, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Discount{}
	for rows.Next() {
		var d Discount
		var applies string
		if err := rows.Scan(&d.ID, &d.TenantID, &d.Code, &d.PercentOff, &d.AmountOffCents,
			&d.Currency, &d.MaxRedemptions, &d.TimesRedeemed, &d.ExpiresAt,
			&applies, &d.StripeCouponID, &d.StripePromoID, &d.CreatedAt); err != nil {
			return nil, err
		}
		d.AppliesTo = AppliesTo(applies)
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListHistoricalRecords reads one bounded page for the production archive.
// Unlike the retained provider-management List method above, this query never
// selects a redeemable code, tenant identifier, or provider identifier into
// application memory. One extra row produces a truthful continuation signal
// without an unbounded count or result set.
func (r *Repo) ListHistoricalRecords(ctx context.Context, tenantID, recordID string, limit, offset int) ([]HistoricalDiscountRecord, bool, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	var parsedRecordID string
	if recordID != "" {
		parsedID, err := uuid.Parse(recordID)
		if err != nil || parsedID.String() != recordID {
			return nil, false, fmt.Errorf("%w: discount record id must be a UUID", ErrInvalidInput)
		}
		parsedRecordID = parsedID.String()
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	query := `
SELECT id::text, percent_off, amount_off_cents,
       CASE WHEN btrim(currency) ~ '^[A-Za-z]{3}$'
            THEN upper(btrim(currency)) ELSE 'XXX' END AS currency,
       max_redemptions, times_redeemed, expires_at, applies_to, created_at
FROM discounts
WHERE tenant_id = $1::uuid
ORDER BY created_at DESC, id DESC
LIMIT $2 OFFSET $3`
	args := []any{tenantID, limit + 1, offset}
	if parsedRecordID != "" {
		// Keep the point lookup as a separate shape so PostgreSQL can use the
		// tenant/id index directly rather than planning through a nullable OR.
		query = `
SELECT id::text, percent_off, amount_off_cents,
       CASE WHEN btrim(currency) ~ '^[A-Za-z]{3}$'
            THEN upper(btrim(currency)) ELSE 'XXX' END AS currency,
       max_redemptions, times_redeemed, expires_at, applies_to, created_at
FROM discounts
WHERE tenant_id = $1::uuid
  AND id = $2::uuid
ORDER BY created_at DESC, id DESC
LIMIT $3 OFFSET $4`
		args = []any{tenantID, parsedRecordID, limit + 1, offset}
	}
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]HistoricalDiscountRecord, 0, limit+1)
	for rows.Next() {
		var item HistoricalDiscountRecord
		var applies string
		if err := rows.Scan(
			&item.ID,
			&item.PercentOff,
			&item.AmountOffCents,
			&item.Currency,
			&item.MaxRedemptions,
			&item.TimesRedeemed,
			&item.ExpiresAt,
			&applies,
			&item.CreatedAt,
		); err != nil {
			return nil, false, err
		}
		item.AppliesTo = AppliesTo(applies)
		item.Label = historicalDiscountRecord(Discount{ID: item.ID}).Label
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return items, hasMore, nil
}

// GetByCode returns a discount by its code.
func (r *Repo) GetByCode(ctx context.Context, tenantID, code string) (*Discount, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var d Discount
	var applies string
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, code, percent_off, amount_off_cents, currency,
       max_redemptions, times_redeemed, expires_at, applies_to,
       COALESCE(stripe_coupon_id,''), COALESCE(stripe_promo_id,''), created_at
FROM discounts
WHERE tenant_id = $1::uuid AND code = $2`, tenantID, code)
	if err := row.Scan(&d.ID, &d.TenantID, &d.Code, &d.PercentOff, &d.AmountOffCents,
		&d.Currency, &d.MaxRedemptions, &d.TimesRedeemed, &d.ExpiresAt,
		&applies, &d.StripeCouponID, &d.StripePromoID, &d.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	d.AppliesTo = AppliesTo(applies)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &d, nil
}

// ListRedemptions returns the newest redemption events for a discount code.
// The code lookup happens first so callers get ErrNotFound for unknown codes
// and an empty list for a known-but-never-used discount.
func (r *Repo) ListRedemptions(ctx context.Context, tenantID, code string, limit, offset int) ([]Redemption, error) {
	d, err := r.GetByCode(ctx, tenantID, code)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT r.id,
       r.tenant_id::text,
       r.discount_id::text,
       $3::text AS discount_code,
       COALESCE(r.subscriber_id::text, '') AS subscriber_id,
       COALESCE(s.email::text, '') AS subscriber_email,
       r.redeemed_at
FROM discount_redemptions r
LEFT JOIN subscribers s
       ON s.tenant_id = r.tenant_id
      AND s.id = r.subscriber_id
WHERE r.tenant_id = $1::uuid
  AND r.discount_id = $2::uuid
ORDER BY r.redeemed_at DESC, r.id DESC
LIMIT $4 OFFSET $5`, tenantID, d.ID, d.Code, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Redemption{}
	for rows.Next() {
		var item Redemption
		if err := rows.Scan(
			&item.ID,
			&item.TenantID,
			&item.DiscountID,
			&item.DiscountCode,
			&item.SubscriberID,
			&item.SubscriberEmail,
			&item.RedeemedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListHistoricalRedemptionEvents returns the PII-free recent-event projection
// exposed by the archive-only HTTP surface. The opaque discount record ID is
// validated before entering SQL, and both the existence check and event query
// retain explicit tenant predicates in addition to the transaction's RLS
// binding.
func (r *Repo) ListHistoricalRedemptionEvents(ctx context.Context, tenantID, discountID string, limit, offset int) ([]HistoricalRedemptionEvent, error) {
	parsedID, err := uuid.Parse(discountID)
	if err != nil || parsedID.String() != discountID {
		return nil, fmt.Errorf("%w: discount record id must be a UUID", ErrInvalidInput)
	}
	if limit <= 0 {
		limit = 50
	}
	// The mounted handler may request one lookahead row beyond its public
	// 100-row page ceiling to compute has_more.
	if limit > 101 {
		limit = 101
	}
	if offset < 0 {
		offset = 0
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists int
	if err := tx.QueryRow(ctx, `
SELECT 1
FROM discounts
WHERE tenant_id = $1::uuid
  AND id = $2::uuid`, tenantID, parsedID.String()).Scan(&exists); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	rows, err := tx.Query(ctx, `
SELECT redeemed_at,
       subscriber_id IS NOT NULL AS subscriber_linked
FROM discount_redemptions
WHERE tenant_id = $1::uuid
  AND discount_id = $2::uuid
ORDER BY redeemed_at DESC, id DESC
LIMIT $3 OFFSET $4`, tenantID, parsedID.String(), limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoricalRedemptionEvent{}
	for rows.Next() {
		var item HistoricalRedemptionEvent
		if err := rows.Scan(&item.RedeemedAt, &item.SubscriberLinked); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Update applies an additive-only patch to a discount. See
// discounts.UpdateInput for the wire-level field semantics. The
// enforcement rules:
//
//   - MaxRedemptions  bump only — must be >= times_redeemed (lower
//     would invalidate already-redeemed rows).
//   - ExpiresAt       push only — must be >= existing expires_at
//     (earlier would retroactively invalidate redemptions made in
//     the now-skipped window).
//   - Clear flags     always allowed; uncapping / unsetting expiry
//     is strictly additive.
//
// Returns the refreshed Discount on success, ErrNotFound when the
// code doesn't exist, or ErrInvalidInput with a descriptive cause
// when a rule is violated.
func (r *Repo) Update(ctx context.Context, tenantID, code string, in UpdateInput) (*Discount, error) {
	// Reject contradictory inputs up front so the handler can return
	// 400 rather than a silently-truncated patch.
	if in.MaxRedemptions != nil && in.ClearMaxRedemptions {
		return nil, fmt.Errorf("%w: max_redemptions and clear_max_redemptions are mutually exclusive", ErrInvalidInput)
	}
	if in.ExpiresAt != nil && in.ClearExpiresAt {
		return nil, fmt.Errorf("%w: expires_at and clear_expires_at are mutually exclusive", ErrInvalidInput)
	}
	if in.MaxRedemptions == nil && !in.ClearMaxRedemptions &&
		in.ExpiresAt == nil && !in.ClearExpiresAt {
		return nil, fmt.Errorf("%w: nothing to update", ErrInvalidInput)
	}

	existing, err := r.GetByCode(ctx, tenantID, code)
	if err != nil {
		return nil, err
	}

	// Validate the bump-only constraints against the current row.
	if in.MaxRedemptions != nil {
		if *in.MaxRedemptions < existing.TimesRedeemed {
			return nil, fmt.Errorf(
				"%w: max_redemptions (%d) cannot be lower than times_redeemed (%d)",
				ErrInvalidInput, *in.MaxRedemptions, existing.TimesRedeemed)
		}
	}
	if in.ExpiresAt != nil && existing.ExpiresAt != nil {
		if in.ExpiresAt.Before(*existing.ExpiresAt) {
			return nil, fmt.Errorf(
				"%w: expires_at cannot move earlier (was %s)",
				ErrInvalidInput, existing.ExpiresAt.UTC().Format(time.RFC3339))
		}
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Build the SET clause dynamically. Keeps the SQL simple and
	// readable next to a single UPDATE that hand-writes every
	// 4-case permutation.
	sets := []string{}
	args := []any{tenantID, existing.Code}
	next := 3
	if in.MaxRedemptions != nil {
		sets = append(sets, fmt.Sprintf("max_redemptions = $%d", next))
		args = append(args, *in.MaxRedemptions)
		next++
	} else if in.ClearMaxRedemptions {
		sets = append(sets, "max_redemptions = NULL")
	}
	if in.ExpiresAt != nil {
		sets = append(sets, fmt.Sprintf("expires_at = $%d", next))
		args = append(args, *in.ExpiresAt)
	} else if in.ClearExpiresAt {
		sets = append(sets, "expires_at = NULL")
	}

	q := fmt.Sprintf(`
UPDATE discounts SET %s
 WHERE tenant_id = $1::uuid AND code = $2`,
		strings.Join(sets, ", "))
	tag, err := tx.Exec(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// Re-read so the caller sees the canonical post-update row
	// (including times_redeemed if a concurrent Redeem fired during
	// the patch — rare but possible).
	return r.GetByCode(ctx, tenantID, existing.Code)
}

// Delete removes a discount by code, also informing the Stripe bridge.
func (r *Repo) Delete(ctx context.Context, bridge StripeBridge, tenantID, code string) error {
	if bridge == nil {
		return ErrStripeBridgeUnavailable
	}
	code = strings.ToUpper(strings.TrimSpace(code))
	d, err := r.GetByCode(ctx, tenantID, code)
	if err != nil {
		return err
	}
	if err := bridge.DeleteCoupon(ctx, tenantID, d.StripeCouponID, d.StripePromoID); err != nil {
		return fmt.Errorf("stripe bridge: %w", err)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM discounts WHERE tenant_id = $1::uuid AND code = $2`,
		tenantID, code); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Redeem records a redemption row and bumps times_redeemed.
//
// Concurrency model (audit finding C3): two simultaneous redemption
// calls used to both read times_redeemed=N-1, both pass the
// CheckRedeemable ceiling check in Go, then both increment — allowing
// N+1 redemptions on a code capped at N. Worst case: a 100%-off code
// can be redeemed more times than the operator configured, with
// proportional revenue loss.
//
// The fix runs the entire pre-check + insert + bump inside a single
// tenant-scoped transaction and uses a compare-and-swap UPDATE
// `WHERE times_redeemed < max_redemptions OR max_redemptions IS NULL`.
// If the row's counter has already hit the ceiling between the
// initial GetByCode read and the UPDATE, RowsAffected returns 0 and
// the transaction rolls back. Returns the same `max_redemptions_reached`
// reason that CheckRedeemable would have returned in the non-racing
// case — the caller can't distinguish a race-loss from a single-
// caller ceiling hit, which is the desired UX.
func (r *Repo) Redeem(ctx context.Context, tenantID, code string, in CouponRedemptionInput, now time.Time) (*RedeemResult, error) {
	code = normalizeCouponCode(code)
	in.Normalize()
	d, err := r.GetByCode(ctx, tenantID, code)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return r.redeemCouponOnly(ctx, tenantID, code, in, now)
		}
		return nil, err
	}
	// Cheap fast-path: surface expiry / disabled state without a
	// transaction. Race-prone counter checks fall through to the CAS
	// below — we don't reject here on max_redemptions because the
	// read could be stale; instead we let the CAS UPDATE be the
	// source of truth.
	if ok, reason := CheckRedeemable(d, now); !ok && reason != "max_redemptions_reached" {
		return &RedeemResult{Code: d.Code, Valid: true, CurrentlyRedeemable: false, Reason: reason}, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Label every entitlement receipt this transaction's coupon transitions
	// produce, so a redemption is distinguishable from an allocation in the
	// append-only trail.
	if err := bindCouponTransitionContext(ctx, tx, CouponActorRedemption, CouponReasonRedeemed); err != nil {
		return nil, err
	}
	// CAS bump. The `max_redemptions IS NULL` arm covers uncapped
	// codes; the `times_redeemed < max_redemptions` arm enforces the
	// ceiling atomically. RowsAffected = 0 means the row was already
	// at the cap by the time we executed.
	tag, err := tx.Exec(ctx, `
UPDATE discounts
   SET times_redeemed = times_redeemed + 1
 WHERE id = $1::uuid
   AND (max_redemptions IS NULL OR times_redeemed < max_redemptions)`,
		d.ID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		// Either the code hit its cap concurrently, or the row was
		// deleted between GetByCode and here. Treat both as the
		// "max_redemptions_reached" UX state — CheckRedeemable would
		// have returned this if its counter read had been current.
		return &RedeemResult{Code: d.Code, Valid: true, CurrentlyRedeemable: false, Reason: "max_redemptions_reached"}, nil
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO discount_redemptions (tenant_id, discount_id, subscriber_id)
VALUES ($1::uuid, $2::uuid, NULLIF($3,'')::uuid)`,
		tenantID, d.ID, in.SubscriberID); err != nil {
		return nil, err
	}
	sync, err := redeemCouponTx(ctx, tx, tenantID, d.Code, in, now)
	if err != nil {
		return nil, err
	}
	if sync != nil && !sync.Redeemed {
		return couponRedeemResult(d.Code, sync), nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if sync != nil {
		return couponRedeemResult(d.Code, sync), nil
	}
	return &RedeemResult{Code: d.Code, Valid: true, CurrentlyRedeemable: true}, nil
}

func (r *Repo) redeemCouponOnly(ctx context.Context, tenantID, code string, in CouponRedemptionInput, now time.Time) (*RedeemResult, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindCouponTransitionContext(ctx, tx, CouponActorRedemption, CouponReasonRedeemed); err != nil {
		return nil, err
	}
	sync, err := redeemCouponTx(ctx, tx, tenantID, code, in, now)
	if err != nil {
		return nil, err
	}
	if sync == nil {
		return &RedeemResult{Code: code, Valid: false, Reason: "unknown_code"}, nil
	}
	if !sync.Redeemed {
		return couponRedeemResult(code, sync), nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return couponRedeemResult(code, sync), nil
}
