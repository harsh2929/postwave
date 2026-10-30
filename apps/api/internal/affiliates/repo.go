package affiliates

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when a lookup misses.
var ErrNotFound = errors.New("affiliates: not found")

// ErrSlugConflict is returned when a slug is already taken.
var ErrSlugConflict = errors.New("affiliates: slug already in use")

// ErrEmailConflict is returned when an email already has an affiliate row.
var ErrEmailConflict = errors.New("affiliates: email already registered")

var ErrNoPayoutBalance = errors.New("affiliates: no approved or pending payout balance")
var ErrPayoutBelowMinimum = errors.New("affiliates: payout balance is below the $100 minimum")
var ErrIllegalConversionTransition = errors.New("affiliates: illegal conversion status transition")

// Repo wraps the platform-level affiliate tables. Unlike forms.Repo, no
// methods open a tenant-scoped tx — affiliates sit above tenants and are
// gated at the HTTP layer.
type Repo struct {
	Pool *db.Pool
}

// ListFilters is a small filter bag for ListAffiliates.
type ListFilters struct {
	Status  []Status
	Country string
	// SortBy: "created_at" (default) | "total_commission" | "name".
	SortBy string
	Limit  int
	Offset int
}

// CreateAffiliate inserts an affiliate. Translates unique-violation errors
// to ErrSlugConflict / ErrEmailConflict.
func (r *Repo) CreateAffiliate(ctx context.Context, a *Affiliate) error {
	const q = `
INSERT INTO affiliates (slug, email, name, country, status, payout_method,
                        payout_email, tax_form_status, tax_form_type,
                        website, audience_size, audience_desc, notes,
                        approved_at)
VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),
        NULLIF($10,''), NULLIF($11,0), NULLIF($12,''), NULLIF($13,''), $14)
RETURNING id::text, created_at, updated_at`
	row := r.Pool.QueryRow(ctx, q,
		a.Slug, a.Email, a.Name, nullableStr(a.Country), a.Status,
		string(a.PayoutMethod), a.PayoutEmail, string(a.TaxFormStatus),
		string(a.TaxFormType), a.Website, a.AudienceSize, a.AudienceDesc,
		a.Notes, a.ApprovedAt,
	)
	if err := row.Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt); err != nil {
		if isUniqueViolationOn(err, "affiliates_slug_idx", "affiliates_slug_key", "slug") {
			return ErrSlugConflict
		}
		if isUniqueViolation(err) {
			// Email isn't UNIQUE in schema (we want to allow updates by
			// admins) — keep this branch defensive in case a future
			// migration adds a partial unique index on email.
			return ErrEmailConflict
		}
		return fmt.Errorf("affiliates: insert: %w", err)
	}
	return nil
}

// GetAffiliateBySlug fetches by slug.
func (r *Repo) GetAffiliateBySlug(ctx context.Context, slug string) (*Affiliate, error) {
	return r.scanAffiliate(ctx, "slug = $1", slug)
}

// GetAffiliateByEmail fetches by email (citext, case-insensitive).
func (r *Repo) GetAffiliateByEmail(ctx context.Context, email string) (*Affiliate, error) {
	return r.scanAffiliate(ctx, "email = $1", email)
}

// GetAffiliateByID fetches by uuid.
func (r *Repo) GetAffiliateByID(ctx context.Context, id string) (*Affiliate, error) {
	return r.scanAffiliate(ctx, "id::text = $1", id)
}

// ListAffiliates returns affiliates matching filters.
func (r *Repo) ListAffiliates(ctx context.Context, f ListFilters) ([]Affiliate, error) {
	args := []any{}
	where := []string{"1=1"}
	if len(f.Status) > 0 {
		ss := make([]string, len(f.Status))
		for i, s := range f.Status {
			ss[i] = string(s)
		}
		args = append(args, ss)
		where = append(where, fmt.Sprintf("status = ANY($%d)", len(args)))
	}
	if f.Country != "" {
		args = append(args, f.Country)
		where = append(where, fmt.Sprintf("country = $%d", len(args)))
	}
	orderBy := "created_at DESC"
	switch f.SortBy {
	case "total_commission":
		// Sub-select roll-up; keeps the API simple. For very large affiliate
		// counts this would benefit from a materialized view on
		// affiliate_conversions aggregated by affiliate_id, refreshed
		// hourly. Not done today: the affiliate scale (< 10k rows) makes
		// the full scan trivial. Would close with `CREATE MATERIALIZED
		// VIEW affiliate_commission_totals` + a cron-triggered REFRESH.
		orderBy = `(SELECT COALESCE(SUM(commission_cents),0) FROM affiliate_conversions c
                    WHERE c.affiliate_id = affiliates.id) DESC`
	case "name":
		orderBy = "name ASC"
	}
	limit := f.Limit
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	q := fmt.Sprintf(`
SELECT id::text, slug, email, name, COALESCE(country,''), status,
       COALESCE(payout_method,''), COALESCE(payout_email::text,''),
       COALESCE(tax_form_status,''), COALESCE(tax_form_type,''),
       COALESCE(notes,''), COALESCE(website,''), COALESCE(audience_size,0),
       COALESCE(audience_desc,''),
       created_at, approved_at, updated_at
FROM affiliates
WHERE %s
ORDER BY %s
LIMIT %d OFFSET %d`, strings.Join(where, " AND "), orderBy, limit, f.Offset)

	rows, err := r.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Affiliate{}
	for rows.Next() {
		a, err := scanRowAffiliate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (r *Repo) AffiliateProgramOverview(ctx context.Context) (AffiliateProgramOverview, error) {
	var out AffiliateProgramOverview
	err := r.Pool.QueryRow(ctx, `
SELECT
  (SELECT count(*)::int FROM affiliates WHERE status = 'approved'),
  (SELECT count(*)::int FROM affiliate_clicks WHERE clicked_at > now() - interval '30 days'),
  (SELECT count(*)::int FROM affiliate_conversions WHERE created_at > now() - interval '30 days'),
  (SELECT COALESCE(sum(commission_cents), 0)::bigint
     FROM affiliate_conversions WHERE status IN ('approved', 'pending'))`,
	).Scan(&out.ActiveCount, &out.Clicks30D, &out.Conversions30D, &out.PendingPayoutCents)
	return out, err
}

func (r *Repo) CountAffiliates(ctx context.Context) (int, error) {
	var total int
	err := r.Pool.QueryRow(ctx, `SELECT count(*)::int FROM affiliates`).Scan(&total)
	return total, err
}

// MonthCommission is one month's non-reversed commission for the chart.
type MonthCommission struct {
	Label           string `json:"label"`
	CommissionCents int64  `json:"commissionCents"`
}

// MonthlyCommission returns `months` zero-filled monthly commission buckets
// (BILL-018) so the affiliate chart no longer requires loading every
// conversion client-side. Reversed/disputed conversions are excluded, matching
// the previous bucketByMonth client transform.
func (r *Repo) MonthlyCommission(ctx context.Context, affiliateID string, months int) ([]MonthCommission, error) {
	if months <= 0 {
		months = 12
	}
	rows, err := r.Pool.Query(ctx, `
SELECT to_char(m, 'Mon') AS label, COALESCE(s.total, 0)::bigint AS commission_cents
  FROM generate_series(
         date_trunc('month', now()) - make_interval(months => $2 - 1),
         date_trunc('month', now()),
         interval '1 month'
       ) AS m
  LEFT JOIN (
    SELECT date_trunc('month', created_at) AS bucket, SUM(commission_cents) AS total
      FROM affiliate_conversions
     WHERE affiliate_id = $1::uuid AND status NOT IN ('reversed', 'disputed')
     GROUP BY 1
  ) s ON s.bucket = m
 ORDER BY m`, affiliateID, months)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MonthCommission{}
	for rows.Next() {
		var mc MonthCommission
		if err := rows.Scan(&mc.Label, &mc.CommissionCents); err != nil {
			return nil, err
		}
		out = append(out, mc)
	}
	return out, rows.Err()
}

// CountAffiliatesFiltered mirrors ListAffiliates' status/country WHERE so a
// filtered program page reports an accurate total/page count (BILL-030).
func (r *Repo) CountAffiliatesFiltered(ctx context.Context, f ListFilters) (int, error) {
	args := []any{}
	where := []string{"1=1"}
	if len(f.Status) > 0 {
		ss := make([]string, len(f.Status))
		for i, s := range f.Status {
			ss[i] = string(s)
		}
		args = append(args, ss)
		where = append(where, fmt.Sprintf("status = ANY($%d)", len(args)))
	}
	if f.Country != "" {
		args = append(args, f.Country)
		where = append(where, fmt.Sprintf("country = $%d", len(args)))
	}
	var total int
	err := r.Pool.QueryRow(ctx,
		"SELECT count(*)::int FROM affiliates WHERE "+strings.Join(where, " AND "),
		args...).Scan(&total)
	return total, err
}

func (r *Repo) StatsForAffiliates(ctx context.Context, ids []string) (map[string]AffiliateProgramRow, error) {
	out := make(map[string]AffiliateProgramRow, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := r.Pool.Query(ctx, `
WITH target AS (
  SELECT unnest($1::uuid[]) AS id
), click_stats AS (
  SELECT affiliate_id,
         count(*) FILTER (WHERE clicked_at > now() - interval '30 days')::int AS clicks_30
  FROM affiliate_clicks
  WHERE affiliate_id = ANY($1::uuid[])
  GROUP BY affiliate_id
), conversion_stats AS (
  SELECT affiliate_id,
         count(DISTINCT tenant_id) FILTER (
           WHERE created_at > now() - interval '30 days' AND tenant_id IS NOT NULL
         )::int AS signups_30,
         count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS conversions_30,
         COALESCE(sum(commission_cents) FILTER (
           WHERE created_at > now() - interval '30 days'
             AND status NOT IN ('reversed', 'disputed')
         ), 0)::bigint AS commission_30,
         count(DISTINCT tenant_id) FILTER (WHERE tenant_id IS NOT NULL)::int AS signups_lifetime,
         count(*)::int AS conversions_lifetime,
         COALESCE(sum(commission_cents) FILTER (
           WHERE status NOT IN ('reversed', 'disputed')
         ), 0)::bigint AS commission_lifetime,
         COALESCE(sum(commission_cents) FILTER (
           WHERE status IN ('approved', 'pending')
         ), 0)::bigint AS pending_lifetime
  FROM affiliate_conversions
  WHERE affiliate_id = ANY($1::uuid[])
  GROUP BY affiliate_id
)
SELECT target.id::text,
       COALESCE(click_stats.clicks_30, 0),
       COALESCE(conversion_stats.signups_30, 0),
       COALESCE(conversion_stats.conversions_30, 0),
       COALESCE(conversion_stats.commission_30, 0),
       COALESCE(conversion_stats.signups_lifetime, 0),
       COALESCE(conversion_stats.conversions_lifetime, 0),
       COALESCE(conversion_stats.commission_lifetime, 0),
       COALESCE(conversion_stats.pending_lifetime, 0)
FROM target
LEFT JOIN click_stats ON click_stats.affiliate_id = target.id
LEFT JOIN conversion_stats ON conversion_stats.affiliate_id = target.id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var row AffiliateProgramRow
		if err := rows.Scan(
			&id,
			&row.Last30.Clicks,
			&row.Last30.Signups,
			&row.Last30.Conversions,
			&row.Last30.TotalCommissionCents,
			&row.Lifetime.Signups,
			&row.Lifetime.Conversions,
			&row.Lifetime.TotalCommissionCents,
			&row.Lifetime.PendingPayoutCents,
		); err != nil {
			return nil, err
		}
		out[id] = row
	}
	return out, rows.Err()
}

// UpdateAffiliate applies a patch. Sets approved_at when transitioning to
// 'approved' for the first time.
func (r *Repo) UpdateAffiliate(ctx context.Context, id string, in UpdateInput) (*Affiliate, error) {
	cur, err := r.GetAffiliateByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if in.Status != nil {
		cur.Status = *in.Status
		if cur.Status == StatusApproved && cur.ApprovedAt == nil {
			now := time.Now().UTC()
			cur.ApprovedAt = &now
		}
	}
	if in.PayoutMethod != nil {
		cur.PayoutMethod = *in.PayoutMethod
	}
	if in.PayoutEmail != nil {
		cur.PayoutEmail = *in.PayoutEmail
	}
	if in.TaxFormStatus != nil {
		cur.TaxFormStatus = *in.TaxFormStatus
	}
	if in.TaxFormType != nil {
		cur.TaxFormType = *in.TaxFormType
	}
	if in.Notes != nil {
		cur.Notes = *in.Notes
	}
	const q = `
UPDATE affiliates
SET status=$1, payout_method=NULLIF($2,''), payout_email=NULLIF($3,''),
    tax_form_status=NULLIF($4,''), tax_form_type=NULLIF($5,''),
    notes=NULLIF($6,''), approved_at=$7, updated_at=now()
WHERE id::text = $8
RETURNING updated_at`
	row := r.Pool.QueryRow(ctx, q,
		cur.Status, string(cur.PayoutMethod), cur.PayoutEmail,
		string(cur.TaxFormStatus), string(cur.TaxFormType),
		cur.Notes, cur.ApprovedAt, id,
	)
	if err := row.Scan(&cur.UpdatedAt); err != nil {
		return nil, err
	}
	return cur, nil
}

// RecordClick inserts an affiliate_clicks row. Caller has already resolved
// the affiliate from slug.
func (r *Repo) RecordClick(ctx context.Context, c *AffiliateClick) error {
	const q = `
INSERT INTO affiliate_clicks (affiliate_id, ip, user_agent, landing_page,
                              utm_source, utm_medium, utm_campaign,
                              utm_content, utm_term, cookie_id)
VALUES ($1::uuid, NULLIF($2,'')::inet, NULLIF($3,''), NULLIF($4,''),
        NULLIF($5,''), NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
        NULLIF($9,''), $10)
RETURNING id, clicked_at`
	return r.Pool.QueryRow(ctx, q,
		c.AffiliateID, c.IP, c.UserAgent, c.LandingPage,
		c.UTMSource, c.UTMMedium, c.UTMCampaign, c.UTMContent, c.UTMTerm,
		c.CookieID,
	).Scan(&c.ID, &c.ClickedAt)
}

// RecordConversion looks up the affiliate via cookie_id (last touch within
// the 60-day window) and inserts an affiliate_conversions row. Returns the
// resulting conversion (with computed commission) or ErrNotFound if the
// cookie doesn't map to any recent click.
func (r *Repo) RecordConversion(ctx context.Context, cookieID string, kind Kind, amountCents int64, tenantID string, stripePI string) (*AffiliateConversion, error) {
	affiliateID, err := r.lastTouchAffiliateID(ctx, cookieID)
	if err != nil {
		return nil, err
	}
	rate, commission := CommissionFor(kind, amountCents)
	const q = `
INSERT INTO affiliate_conversions
  (affiliate_id, tenant_id, cookie_id, kind, amount_cents, commission_cents,
   commission_rate_pct, status, stripe_payment_intent_id)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6, $7, 'pending', NULLIF($8,''))
RETURNING id, created_at`
	conv := &AffiliateConversion{
		AffiliateID:           affiliateID,
		TenantID:              tenantID,
		CookieID:              cookieID,
		Kind:                  kind,
		AmountCents:           amountCents,
		CommissionCents:       commission,
		CommissionRatePct:     rate,
		Status:                ConversionPending,
		StripePaymentIntentID: stripePI,
	}
	if err := r.Pool.QueryRow(ctx, q,
		affiliateID, tenantID, cookieID, kind, amountCents,
		commission, rate, stripePI,
	).Scan(&conv.ID, &conv.CreatedAt); err != nil {
		if stripePI != "" && isUniqueViolation(err) {
			return r.getConversionByPaymentIntent(ctx, stripePI)
		}
		return nil, err
	}
	return conv, nil
}

func (r *Repo) getConversionByPaymentIntent(ctx context.Context, stripePI string) (*AffiliateConversion, error) {
	const q = `
	SELECT id, affiliate_id::text, COALESCE(tenant_id::text,''), cookie_id, kind,
	       amount_cents, commission_cents, commission_rate_pct,
	       recurring_period_end, status,
	       COALESCE(stripe_payment_intent_id,''), created_at, paid_at, reversed_at
	FROM affiliate_conversions
	WHERE stripe_payment_intent_id = $1`
	row := r.Pool.QueryRow(ctx, q, stripePI)
	var c AffiliateConversion
	if err := row.Scan(&c.ID, &c.AffiliateID, &c.TenantID, &c.CookieID,
		&c.Kind, &c.AmountCents, &c.CommissionCents, &c.CommissionRatePct,
		&c.RecurringPeriodEnd, &c.Status, &c.StripePaymentIntentID,
		&c.CreatedAt, &c.PaidAt, &c.ReversedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return &c, nil
}

// ListConversions returns conversions for an affiliate, newest first.
func (r *Repo) ListConversions(ctx context.Context, affiliateID string, status []ConversionStatus, limit, offset int) ([]AffiliateConversion, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	args := []any{affiliateID}
	where := "affiliate_id::text = $1"
	if len(status) > 0 {
		ss := make([]string, len(status))
		for i, s := range status {
			ss[i] = string(s)
		}
		args = append(args, ss)
		where += fmt.Sprintf(" AND status = ANY($%d)", len(args))
	}
	q := fmt.Sprintf(`
SELECT id, affiliate_id::text, COALESCE(tenant_id::text,''), cookie_id, kind,
       amount_cents, commission_cents, commission_rate_pct,
       recurring_period_end, status,
       COALESCE(stripe_payment_intent_id,''), created_at, paid_at, reversed_at
FROM affiliate_conversions
WHERE %s
ORDER BY created_at DESC
LIMIT %d OFFSET %d`, where, limit, offset)
	rows, err := r.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AffiliateConversion{}
	for rows.Next() {
		var c AffiliateConversion
		if err := rows.Scan(&c.ID, &c.AffiliateID, &c.TenantID, &c.CookieID,
			&c.Kind, &c.AmountCents, &c.CommissionCents, &c.CommissionRatePct,
			&c.RecurringPeriodEnd, &c.Status, &c.StripePaymentIntentID,
			&c.CreatedAt, &c.PaidAt, &c.ReversedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateConversionStatus moderates a single conversion (BILL-033). Only
// approve/reverse/dispute are operator actions; a settled 'paid' row is
// immutable (the guarded WHERE leaves it untouched → ErrNotFound). Reversing
// stamps reversed_at so the audit timeline and payout math see the change.
func (r *Repo) UpdateConversionStatus(ctx context.Context, affiliateID string, conversionID int64, to ConversionStatus) (AffiliateConversion, error) {
	switch to {
	case ConversionApproved, ConversionReversed, ConversionDisputed:
	default:
		return AffiliateConversion{}, ErrIllegalConversionTransition
	}
	const q = `
UPDATE affiliate_conversions
   SET status = $3,
       reversed_at = CASE WHEN $3 = 'reversed' THEN now() ELSE reversed_at END
 WHERE affiliate_id = $1::uuid AND id = $2 AND status <> 'paid'
RETURNING id, affiliate_id::text, COALESCE(tenant_id::text,''), cookie_id, kind,
          amount_cents, commission_cents, commission_rate_pct,
          recurring_period_end, status,
          COALESCE(stripe_payment_intent_id,''), created_at, paid_at, reversed_at`
	var c AffiliateConversion
	err := r.Pool.QueryRow(ctx, q, affiliateID, conversionID, string(to)).Scan(
		&c.ID, &c.AffiliateID, &c.TenantID, &c.CookieID, &c.Kind,
		&c.AmountCents, &c.CommissionCents, &c.CommissionRatePct,
		&c.RecurringPeriodEnd, &c.Status, &c.StripePaymentIntentID,
		&c.CreatedAt, &c.PaidAt, &c.ReversedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AffiliateConversion{}, ErrNotFound
	}
	if err != nil {
		return AffiliateConversion{}, err
	}
	return c, nil
}

// CreatePayoutForOutstanding locks and pays every currently approved or
// pending conversion in one serializable transaction. The database, not the
// dashboard button, enforces the program's $100 minimum.
func (r *Repo) CreatePayoutForOutstanding(ctx context.Context, p *AffiliatePayout) ([]int64, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, commission_cents
FROM affiliate_conversions
WHERE affiliate_id = $1::uuid
  AND status IN ('approved', 'pending')
ORDER BY id
FOR UPDATE`, p.AffiliateID)
	if err != nil {
		return nil, err
	}
	var ids []int64
	var total int64
	for rows.Next() {
		var id, commission int64
		if err := rows.Scan(&id, &commission); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		total += commission
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if total <= 0 {
		return nil, ErrNoPayoutBalance
	}
	if total < 10_000 {
		return nil, ErrPayoutBelowMinimum
	}
	p.AmountCents = total
	if err := tx.QueryRow(ctx, `
INSERT INTO affiliate_payouts (affiliate_id, amount_cents, currency,
                               payout_method, status, notes)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), 'pending', NULLIF($5,''))
RETURNING id::text, created_at`,
		p.AffiliateID, p.AmountCents, p.Currency, string(p.PayoutMethod), p.Notes,
	).Scan(&p.ID, &p.CreatedAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE affiliate_conversions
SET status = 'paid', paid_at = now()
WHERE id = ANY($1) AND status IN ('approved', 'pending')`, ids); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return ids, nil
}

// MarkConversionPaid flips approved → paid for all matching ids.
func (r *Repo) MarkConversionPaid(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	const q = `UPDATE affiliate_conversions
                SET status = 'paid', paid_at = now()
              WHERE id = ANY($1) AND status IN ('approved','pending')`
	_, err := r.Pool.Exec(ctx, q, ids)
	return err
}

// ReverseConversion marks a previously attributed conversion as reversed.
// Stripe refund events carry the charge and payment_intent; conversions are
// keyed by payment intent, so callers should pass payment_intent when present.
func (r *Repo) ReverseConversion(ctx context.Context, stripeCustomerID, chargeOrPaymentIntentID string) error {
	_ = stripeCustomerID
	if strings.TrimSpace(chargeOrPaymentIntentID) == "" {
		return nil
	}
	const q = `
UPDATE affiliate_conversions
   SET status = 'reversed', reversed_at = now()
 WHERE stripe_payment_intent_id = $1
   AND status <> 'reversed'`
	_, err := r.Pool.Exec(ctx, q, chargeOrPaymentIntentID)
	return err
}

// CreatePayout inserts a pending payout row.
func (r *Repo) CreatePayout(ctx context.Context, p *AffiliatePayout) error {
	const q = `
INSERT INTO affiliate_payouts (affiliate_id, amount_cents, currency,
                               payout_method, status, notes)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), 'pending', NULLIF($5,''))
RETURNING id::text, created_at`
	return r.Pool.QueryRow(ctx, q,
		p.AffiliateID, p.AmountCents, p.Currency,
		string(p.PayoutMethod), p.Notes,
	).Scan(&p.ID, &p.CreatedAt)
}

// CreatePayoutAndMarkConversionsPaid atomically inserts a payout row
// and flips the listed conversions to status='paid'. Replaces the
// previous "two separate, non-transactional calls" pattern in
// AdminCreatePayout — audit finding H1: under concurrent admin
// requests (button-mash, retry) the prior code observed the same
// conversion set, created two payout rows, and only partial-success
// of MarkConversionPaid kept the ledger consistent. Both now
// commit-or-rollback together. Stripe transfer fires AFTER commit
// using a deterministic Idempotency-Key derived from the conversion
// set, so the external side is still race-safe.
func (r *Repo) CreatePayoutAndMarkConversionsPaid(ctx context.Context, p *AffiliatePayout, conversionIDs []int64) error {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	const insPayout = `
INSERT INTO affiliate_payouts (affiliate_id, amount_cents, currency,
                               payout_method, status, notes)
VALUES ($1::uuid, $2, $3, NULLIF($4,''), 'pending', NULLIF($5,''))
RETURNING id::text, created_at`
	if err := tx.QueryRow(ctx, insPayout,
		p.AffiliateID, p.AmountCents, p.Currency,
		string(p.PayoutMethod), p.Notes,
	).Scan(&p.ID, &p.CreatedAt); err != nil {
		return err
	}
	if len(conversionIDs) > 0 {
		// Conditional UPDATE: only flip rows still in approved/pending.
		// If a concurrent transaction already paid them, RowsAffected
		// reflects that — but more importantly, the SERIALIZABLE
		// guarantee here is "the WHERE clause is evaluated at commit
		// time", so the two-payout race becomes a serialization
		// failure on the loser, which `tx.Rollback` cleans up.
		const markPaid = `
UPDATE affiliate_conversions
   SET status = 'paid', paid_at = now()
 WHERE id = ANY($1) AND status IN ('approved','pending')`
		if _, err := tx.Exec(ctx, markPaid, conversionIDs); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ListPayouts returns the affiliate's payouts newest first.
func (r *Repo) ListPayouts(ctx context.Context, affiliateID string) ([]AffiliatePayout, error) {
	const q = `
SELECT id::text, affiliate_id::text, amount_cents, currency,
       COALESCE(payout_method,''), COALESCE(payout_reference,''),
       status, sent_at, COALESCE(notes,''), created_at
FROM affiliate_payouts
WHERE affiliate_id::text = $1
ORDER BY created_at DESC`
	rows, err := r.Pool.Query(ctx, q, affiliateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AffiliatePayout{}
	for rows.Next() {
		var p AffiliatePayout
		if err := rows.Scan(&p.ID, &p.AffiliateID, &p.AmountCents, &p.Currency,
			&p.PayoutMethod, &p.PayoutReference, &p.Status, &p.SentAt,
			&p.Notes, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// MarkPayoutSent flips a payout to 'sent' and stamps the external ref.
func (r *Repo) MarkPayoutSent(ctx context.Context, id, ref string) error {
	const q = `UPDATE affiliate_payouts
                SET status='sent', payout_reference=$2, sent_at=now()
              WHERE id::text = $1 AND status='pending'`
	tag, err := r.Pool.Exec(ctx, q, id, ref)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Stats rolls up counts + commission totals for an affiliate over the past
// `days` days. days<=0 defaults to lifetime.
func (r *Repo) Stats(ctx context.Context, affiliateID string, days int) (Stats, error) {
	var s Stats
	period := "interval '100 years'"
	if days > 0 {
		period = fmt.Sprintf("interval '%d days'", days)
	}
	q := fmt.Sprintf(`
SELECT
  (SELECT COUNT(*) FROM affiliate_clicks
       WHERE affiliate_id::text = $1 AND clicked_at > now() - %s),
  (SELECT COUNT(DISTINCT tenant_id) FROM affiliate_conversions
       WHERE affiliate_id::text = $1 AND created_at > now() - %s
         AND tenant_id IS NOT NULL),
  (SELECT COUNT(*) FROM affiliate_conversions
       WHERE affiliate_id::text = $1 AND created_at > now() - %s),
  (SELECT COALESCE(SUM(commission_cents),0) FROM affiliate_conversions
       WHERE affiliate_id::text = $1 AND created_at > now() - %s
         AND status NOT IN ('reversed','disputed')),
  (SELECT COALESCE(SUM(commission_cents),0) FROM affiliate_conversions
       WHERE affiliate_id::text = $1
         AND status IN ('approved','pending'))`,
		period, period, period, period)
	row := r.Pool.QueryRow(ctx, q, affiliateID)
	if err := row.Scan(&s.Clicks, &s.Signups, &s.Conversions,
		&s.TotalCommissionCents, &s.PendingPayoutCents); err != nil {
		return s, err
	}
	return s, nil
}

// ---- helpers ----

// lastTouchAffiliateID returns the affiliate id of the most recent click on
// `cookieID` within the 60-day attribution window.
func (r *Repo) lastTouchAffiliateID(ctx context.Context, cookieID string) (string, error) {
	if cookieID == "" {
		return "", ErrNotFound
	}
	const q = `
SELECT affiliate_id::text
FROM affiliate_clicks
WHERE cookie_id = $1 AND clicked_at > now() - interval '60 days'
ORDER BY clicked_at DESC
LIMIT 1`
	var id string
	if err := r.Pool.QueryRow(ctx, q, cookieID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	return id, nil
}

func (r *Repo) scanAffiliate(ctx context.Context, where string, args ...any) (*Affiliate, error) {
	q := `
SELECT id::text, slug, email, name, COALESCE(country,''), status,
       COALESCE(payout_method,''), COALESCE(payout_email::text,''),
       COALESCE(tax_form_status,''), COALESCE(tax_form_type,''),
       COALESCE(notes,''), COALESCE(website,''), COALESCE(audience_size,0),
       COALESCE(audience_desc,''),
       created_at, approved_at, updated_at
FROM affiliates WHERE ` + where + ` LIMIT 1`
	row := r.Pool.QueryRow(ctx, q, args...)
	a, err := scanRowAffiliate(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return a, nil
}

// scanRowAffiliate reads one row using the same column order produced by
// scanAffiliate / ListAffiliates.
type scanner interface {
	Scan(dest ...any) error
}

func scanRowAffiliate(row scanner) (*Affiliate, error) {
	var a Affiliate
	var pm, pe, tfs, tft string
	if err := row.Scan(&a.ID, &a.Slug, &a.Email, &a.Name, &a.Country, &a.Status,
		&pm, &pe, &tfs, &tft, &a.Notes, &a.Website, &a.AudienceSize,
		&a.AudienceDesc, &a.CreatedAt, &a.ApprovedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	a.PayoutMethod = PayoutMethod(pm)
	a.PayoutEmail = pe
	a.TaxFormStatus = TaxFormStatus(tfs)
	a.TaxFormType = TaxFormType(tft)
	return &a, nil
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func isUniqueViolation(err error) bool {
	type sqlStater interface{ SQLState() string }
	var pgerr sqlStater
	if errors.As(err, &pgerr) {
		return pgerr.SQLState() == "23505"
	}
	return false
}

func isUniqueViolationOn(err error, names ...string) bool {
	if !isUniqueViolation(err) {
		return false
	}
	msg := err.Error()
	for _, n := range names {
		if strings.Contains(msg, n) {
			return true
		}
	}
	return false
}
