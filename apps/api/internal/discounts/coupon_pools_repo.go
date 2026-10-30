package discounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (r *Repo) ListCouponPools(ctx context.Context, tenantID, status string, limit, offset int) (*CouponPoolsPage, error) {
	limit, offset = normalizePage(limit, offset)
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM coupon_pools
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR status = $2)`, tenantID, status).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, couponPoolSelectSQL+`
WHERE p.tenant_id = $1::uuid
  AND ($2 = '' OR p.status = $2)
ORDER BY p.updated_at DESC, p.created_at DESC
LIMIT $3 OFFSET $4`, tenantID, status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CouponPool{}
	for rows.Next() {
		item, err := scanCouponPool(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CouponPoolsPage{Items: items, PageInfo: PageInfoLike{Total: total, Page: offset/limit + 1, PerPage: limit}}, nil
}

func (r *Repo) UpsertCouponPool(ctx context.Context, tenantID string, in CouponPoolInput) (*CouponPool, error) {
	if err := in.NormalizeAndValidate(); err != nil {
		return nil, err
	}
	var discountID string
	if in.DiscountCode != "" {
		disc, err := r.GetByCode(ctx, tenantID, in.DiscountCode)
		if err != nil {
			return nil, err
		}
		discountID = disc.ID
		if in.DefaultCode == "" {
			in.DefaultCode = disc.Code
		}
	}
	settings, err := json.Marshal(in.Settings)
	if err != nil {
		return nil, fmt.Errorf("%w: settings must be JSON serializable", ErrInvalidInput)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id string
	// The three bounds are passed as nullable parameters rather than folded into
	// EXCLUDED: an omitted bound on a re-upsert must keep whatever an operator
	// deliberately raised it to, not reset it to the column default. EXCLUDED
	// would carry the coalesced insert value and silently do the reset.
	err = tx.QueryRow(ctx, `
INSERT INTO coupon_pools (
    tenant_id, discount_id, name, description, provider, provider_ref,
    code_type, status, default_code, expires_at, settings,
    max_codes_per_subscriber, max_codes_per_campaign, max_reservation_ttl_seconds
) VALUES (
    $1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6,
    $7, $8, $9, $10, $11::jsonb,
    COALESCE($12::int, 1), COALESCE($13::int, 10000), COALESCE($14::int, 86400)
)
ON CONFLICT (tenant_id, name) DO UPDATE SET
    discount_id = EXCLUDED.discount_id,
    description = EXCLUDED.description,
    provider = EXCLUDED.provider,
    provider_ref = EXCLUDED.provider_ref,
    code_type = EXCLUDED.code_type,
    status = EXCLUDED.status,
    default_code = EXCLUDED.default_code,
    expires_at = EXCLUDED.expires_at,
    settings = EXCLUDED.settings,
    max_codes_per_subscriber = COALESCE($12::int, coupon_pools.max_codes_per_subscriber),
    max_codes_per_campaign = COALESCE($13::int, coupon_pools.max_codes_per_campaign),
    max_reservation_ttl_seconds = COALESCE($14::int, coupon_pools.max_reservation_ttl_seconds)
RETURNING id::text`,
		tenantID, discountID, in.Name, in.Description, in.Provider, in.ProviderRef,
		string(in.CodeType), string(in.Status), in.DefaultCode, in.ExpiresAt, string(settings),
		in.MaxCodesPerSubscriber, in.MaxCodesPerCampaign, in.MaxReservationTTLSeconds).Scan(&id)
	if err != nil {
		return nil, err
	}
	pool, err := queryCouponPoolTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return pool, nil
}

func (r *Repo) GetCouponPool(ctx context.Context, tenantID, poolID string) (*CouponPool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	pool, err := queryCouponPoolTx(ctx, tx, tenantID, poolID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return pool, nil
}

func (r *Repo) ImportCouponCodes(ctx context.Context, tenantID, poolID string, in CouponCodeImportInput, now time.Time) (*CouponCodeImportSummary, error) {
	codes, err := in.NormalizeAndValidate()
	if err != nil {
		return nil, err
	}
	pool, err := r.GetCouponPool(ctx, tenantID, poolID)
	if err != nil {
		return nil, err
	}
	if pool.CodeType == CouponPoolStatic {
		return nil, fmt.Errorf("%w: static coupon pools cannot import unique codes", ErrInvalidInput)
	}
	metadata, err := json.Marshal(in.Metadata)
	if err != nil {
		return nil, fmt.Errorf("%w: metadata must be JSON serializable", ErrInvalidInput)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	imported := 0
	for _, code := range codes {
		tag, err := tx.Exec(ctx, `
INSERT INTO coupon_codes (tenant_id, pool_id, code, expires_at, metadata)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
ON CONFLICT (tenant_id, pool_id, code) DO NOTHING`,
			tenantID, poolID, code, in.ExpiresAt, string(metadata))
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() > 0 {
			imported++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CouponCodeImportSummary{
		PoolID:     pool.ID,
		Seen:       len(codes),
		Imported:   imported,
		Duplicates: len(codes) - imported,
		ImportedAt: now.UTC(),
	}, nil
}

func (r *Repo) ListCouponCodes(ctx context.Context, tenantID, poolID, status string, limit, offset int) (*CouponCodesPage, error) {
	limit, offset = normalizePage(limit, offset)
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := queryCouponPoolTx(ctx, tx, tenantID, poolID); err != nil {
		return nil, err
	}
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM coupon_codes
WHERE tenant_id = $1::uuid
  AND pool_id = $2::uuid
  AND ($3 = '' OR status = $3)`, tenantID, poolID, status).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, couponCodeSelectSQL+`
WHERE tenant_id = $1::uuid
  AND pool_id = $2::uuid
  AND ($3 = '' OR status = $3)
ORDER BY created_at DESC, id DESC
LIMIT $4 OFFSET $5`, tenantID, poolID, status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CouponCode{}
	for rows.Next() {
		item, err := scanCouponCode(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CouponCodesPage{Items: items, PageInfo: PageInfoLike{Total: total, Page: offset/limit + 1, PerPage: limit}}, nil
}

func (r *Repo) AssignCoupon(ctx context.Context, tenantID, poolID string, in CouponAssignmentInput, now time.Time) (*CouponAssignmentResult, error) {
	if err := in.NormalizeAndValidate(); err != nil {
		return nil, err
	}
	metadata, err := json.Marshal(in.Metadata)
	if err != nil {
		return nil, fmt.Errorf("%w: metadata must be JSON serializable", ErrInvalidInput)
	}
	now = now.UTC()

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindCouponTransitionContext(ctx, tx, CouponActorAllocator, CouponReasonAllocated); err != nil {
		return nil, err
	}

	pool, err := lockCouponPoolTx(ctx, tx, tenantID, poolID)
	if err != nil {
		return nil, err
	}
	if pool.Status != CouponPoolActive {
		return nil, fmt.Errorf("%w: coupon pool is not active", ErrInvalidInput)
	}
	if pool.ExpiresAt != nil && !pool.ExpiresAt.After(now) {
		return nil, ErrCouponExhausted
	}
	// A reservation is inventory withheld from everyone else. Refuse a TTL past
	// the pool's ceiling instead of clamping it: a caller that asked for a week
	// and silently got an hour will hand out a code it believes is still held.
	if pool.MaxReservationTTLSeconds > 0 && in.ReservationTTLSeconds > pool.MaxReservationTTLSeconds {
		return nil, fmt.Errorf("%w: reservation_ttl_seconds (%d) exceeds this pool's max_reservation_ttl_seconds (%d)",
			ErrInvalidInput, in.ReservationTTLSeconds, pool.MaxReservationTTLSeconds)
	}

	existing, err := queryExistingAssignmentTx(ctx, tx, tenantID, poolID, in)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		reservation, err := ensureRenderReservationTx(ctx, tx, tenantID, poolID, in, existing, metadata)
		if err != nil {
			return nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return &CouponAssignmentResult{Assignment: *existing, RenderReservation: reservation}, nil
	}

	// Abuse controls. The authoritative enforcement is the BEFORE INSERT trigger
	// coupon_assignment_quota_guard (migration 1970) — this package is not the
	// only writer of coupon_assignments, and a bound that only exists in one
	// caller is not a bound. This pre-check exists so the refusal arrives as a
	// typed error before any code row is moved out of 'available', and so the
	// operator-facing message names which bound was hit. The pool row is already
	// locked FOR UPDATE above, so the count cannot be overtaken.
	if err := checkCouponQuotaTx(ctx, tx, tenantID, poolID, in, pool); err != nil {
		return nil, err
	}

	status := CouponAssignmentAssigned
	codeStatus := CouponCodeAssigned
	var reservedUntil *time.Time
	if in.ReservationTTLSeconds > 0 {
		status = CouponAssignmentReserved
		codeStatus = CouponCodeReserved
		until := now.Add(time.Duration(in.ReservationTTLSeconds) * time.Second)
		reservedUntil = &until
	}

	var codeID, code string
	var codeExpiresAt *time.Time
	switch pool.CodeType {
	case CouponPoolStatic:
		code = pool.DefaultCode
	case CouponPoolImported:
		if err := tx.QueryRow(ctx, `
SELECT id::text, code, expires_at
FROM coupon_codes
WHERE tenant_id = $1::uuid
  AND pool_id = $2::uuid
  AND status = 'available'
  AND (expires_at IS NULL OR expires_at > $3)
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1`, tenantID, poolID, now).Scan(&codeID, &code, &codeExpiresAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrCouponExhausted
			}
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
UPDATE coupon_codes
   SET status = $1,
       subscriber_id = NULLIF($2,'')::uuid,
       subscriber_email = $3,
       context_key = $4,
       assigned_at = $5,
       reserved_until = $6
 WHERE tenant_id = $7::uuid
   AND id = $8::uuid`,
			string(codeStatus), in.SubscriberID, in.SubscriberEmail, in.ContextKey,
			now, reservedUntil, tenantID, codeID); err != nil {
			return nil, err
		}
	case CouponPoolGenerated:
		for tries := 0; tries < 8; tries++ {
			generated, err := generatedCouponCode(pool.Settings)
			if err != nil {
				return nil, err
			}
			err = tx.QueryRow(ctx, `
INSERT INTO coupon_codes (
    tenant_id, pool_id, code, status, subscriber_id, subscriber_email,
    context_key, assigned_at, reserved_until, expires_at, metadata
) VALUES (
    $1::uuid, $2::uuid, $3, $4, NULLIF($5,'')::uuid, $6,
    $7, $8, $9, $10, $11::jsonb
)
ON CONFLICT (tenant_id, pool_id, code) DO NOTHING
RETURNING id::text, code, expires_at`,
				tenantID, poolID, generated, string(codeStatus), in.SubscriberID,
				in.SubscriberEmail, in.ContextKey, now, reservedUntil, pool.ExpiresAt,
				string(metadata)).Scan(&codeID, &code, &codeExpiresAt)
			if err == nil {
				break
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
		}
		if codeID == "" {
			return nil, ErrCouponExhausted
		}
	default:
		return nil, fmt.Errorf("%w: unsupported coupon pool code_type", ErrInvalidInput)
	}
	if code == "" {
		return nil, ErrCouponExhausted
	}
	expiresAt := pool.ExpiresAt
	if codeExpiresAt != nil {
		expiresAt = codeExpiresAt
	}

	assignment, err := insertCouponAssignmentTx(ctx, tx, tenantID, poolID, codeID, code, in, status, now, reservedUntil, expiresAt, metadata)
	if err != nil {
		return nil, couponQuotaError(err)
	}
	reservation, err := ensureRenderReservationTx(ctx, tx, tenantID, poolID, in, assignment, metadata)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CouponAssignmentResult{Assignment: *assignment, RenderReservation: reservation}, nil
}

func (r *Repo) ListCouponAssignments(ctx context.Context, tenantID, poolID, status string, limit, offset int) (*CouponAssignmentsPage, error) {
	limit, offset = normalizePage(limit, offset)
	status = strings.ToLower(strings.TrimSpace(status))
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := queryCouponPoolTx(ctx, tx, tenantID, poolID); err != nil {
		return nil, err
	}
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
FROM coupon_assignments
WHERE tenant_id = $1::uuid
  AND pool_id = $2::uuid
  AND ($3 = '' OR status = $3)`, tenantID, poolID, status).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, couponAssignmentSelectSQL+`
WHERE a.tenant_id = $1::uuid
  AND a.pool_id = $2::uuid
  AND ($3 = '' OR a.status = $3)
ORDER BY a.assigned_at DESC, a.id DESC
LIMIT $4 OFFSET $5`, tenantID, poolID, status, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CouponAssignment{}
	for rows.Next() {
		item, err := scanCouponAssignment(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CouponAssignmentsPage{Items: items, PageInfo: PageInfoLike{Total: total, Page: offset/limit + 1, PerPage: limit}}, nil
}

const couponPoolSelectSQL = `
SELECT p.id::text,
       p.tenant_id::text,
       COALESCE(p.discount_id::text, ''),
       p.name,
       p.description,
       p.provider,
       p.provider_ref,
       p.code_type,
       p.status,
       p.default_code,
       p.expires_at,
       p.settings,
       p.max_codes_per_subscriber,
       p.max_codes_per_campaign,
       p.max_reservation_ttl_seconds,
       (SELECT count(*)::int FROM coupon_codes c WHERE c.tenant_id = p.tenant_id AND c.pool_id = p.id AND c.status = 'available') AS available_codes,
       (SELECT count(*)::int FROM coupon_codes c WHERE c.tenant_id = p.tenant_id AND c.pool_id = p.id AND c.status IN ('reserved','assigned')) AS assigned_codes,
       (SELECT count(*)::int FROM coupon_codes c WHERE c.tenant_id = p.tenant_id AND c.pool_id = p.id AND c.status = 'redeemed') AS redeemed_codes,
       p.created_at,
       p.updated_at
FROM coupon_pools p
`

const couponCodeSelectSQL = `
SELECT id::text,
       tenant_id::text,
       pool_id::text,
       code,
       status,
       COALESCE(subscriber_id::text, ''),
       subscriber_email,
       context_key,
       assigned_at,
       reserved_until,
       redeemed_at,
       expires_at,
       metadata,
       created_at,
       updated_at
FROM coupon_codes
`

const couponAssignmentSelectSQL = `
SELECT a.id::text,
       a.tenant_id::text,
       a.pool_id::text,
       COALESCE(a.code_id::text, ''),
       COALESCE(c.code, a.static_code),
       COALESCE(a.subscriber_id::text, ''),
       a.subscriber_email,
       a.context_key,
       a.render_key,
       a.channel,
       a.surface,
       a.status,
       a.assigned_at,
       a.reserved_until,
       a.redeemed_at,
       a.expires_at,
       a.metadata,
       a.created_at,
       a.updated_at
FROM coupon_assignments a
LEFT JOIN coupon_codes c
       ON c.tenant_id = a.tenant_id
      AND c.id = a.code_id
`

func queryCouponPoolTx(ctx context.Context, tx pgx.Tx, tenantID, poolID string) (*CouponPool, error) {
	row := tx.QueryRow(ctx, couponPoolSelectSQL+`
WHERE p.tenant_id = $1::uuid
  AND p.id = $2::uuid`, tenantID, poolID)
	pool, err := scanCouponPool(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return pool, nil
}

func lockCouponPoolTx(ctx context.Context, tx pgx.Tx, tenantID, poolID string) (*CouponPool, error) {
	var p CouponPool
	var codeType, status string
	var raw []byte
	err := tx.QueryRow(ctx, `
SELECT id::text,
       tenant_id::text,
       COALESCE(discount_id::text, ''),
       name,
       description,
       provider,
       provider_ref,
       code_type,
       status,
       default_code,
       expires_at,
       settings,
       max_codes_per_subscriber,
       max_codes_per_campaign,
       max_reservation_ttl_seconds,
       created_at,
       updated_at
FROM coupon_pools
WHERE tenant_id = $1::uuid
  AND id = $2::uuid
FOR UPDATE`, tenantID, poolID).Scan(
		&p.ID,
		&p.TenantID,
		&p.DiscountID,
		&p.Name,
		&p.Description,
		&p.Provider,
		&p.ProviderRef,
		&codeType,
		&status,
		&p.DefaultCode,
		&p.ExpiresAt,
		&raw,
		&p.MaxCodesPerSubscriber,
		&p.MaxCodesPerCampaign,
		&p.MaxReservationTTLSeconds,
		&p.CreatedAt,
		&p.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	p.CodeType = CouponPoolCodeType(codeType)
	p.Status = CouponPoolStatus(status)
	p.Settings = decodeJSONMap(raw)
	return &p, nil
}

func queryExistingAssignmentTx(ctx context.Context, tx pgx.Tx, tenantID, poolID string, in CouponAssignmentInput) (*CouponAssignment, error) {
	if in.RenderKey != "" {
		row := tx.QueryRow(ctx, couponAssignmentSelectSQL+`
WHERE a.tenant_id = $1::uuid
  AND a.pool_id = $2::uuid
  AND a.render_key = $3
LIMIT 1`, tenantID, poolID, in.RenderKey)
		item, err := scanCouponAssignment(row)
		if err == nil {
			return item, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	row := tx.QueryRow(ctx, couponAssignmentSelectSQL+`
WHERE a.tenant_id = $1::uuid
  AND a.pool_id = $2::uuid
  AND a.context_key = $3
  AND a.status IN ('reserved','assigned','redeemed')
  AND (($4 <> '' AND COALESCE(a.subscriber_id::text, '') = $4)
       OR ($5 <> '' AND lower(a.subscriber_email) = lower($5)))
ORDER BY a.assigned_at DESC, a.id DESC
LIMIT 1`, tenantID, poolID, in.ContextKey, in.SubscriberID, in.SubscriberEmail)
	item, err := scanCouponAssignment(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return item, nil
}

// checkCouponQuotaTx applies the pool's abuse-control bounds to a NEW draw.
//
// "Live" is reserved|assigned|redeemed — the same set the partial unique indexes
// on coupon_assignments use. A released or expired assignment gave its code back
// and deliberately does not count against the recipient again; otherwise a
// failed send would permanently consume a recipient's entitlement.
//
// The sending scope is campaign_id when the caller names one, otherwise
// context_key. Both identify "the thing that is looping if something is
// looping"; a bound on neither is what lets one replayed webhook drain a pool.
func checkCouponQuotaTx(ctx context.Context, tx pgx.Tx, tenantID, poolID string, in CouponAssignmentInput, pool *CouponPool) error {
	if in.SubscriberID != "" || in.SubscriberEmail != "" {
		var held int
		if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM coupon_assignments a
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.status IN ('reserved', 'assigned', 'redeemed')
   AND (
        ($3 <> '' AND COALESCE(a.subscriber_id::text, '') = $3)
     OR ($4 <> '' AND lower(a.subscriber_email) = lower($4))
   )`, tenantID, poolID, in.SubscriberID, in.SubscriberEmail).Scan(&held); err != nil {
			return err
		}
		if held >= pool.MaxCodesPerSubscriber {
			return fmt.Errorf("%w: subscriber already holds %d of %d code(s) permitted from this pool",
				ErrCouponQuotaExceeded, held, pool.MaxCodesPerSubscriber)
		}
	}

	scope := in.CampaignID
	if scope == "" {
		scope = in.ContextKey
	}
	if scope == "" {
		return nil
	}
	var drawn int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM coupon_assignments a
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.status IN ('reserved', 'assigned', 'redeemed')
   AND COALESCE(a.campaign_id::text, NULLIF(a.context_key, '')) = $3`,
		tenantID, poolID, scope).Scan(&drawn); err != nil {
		return err
	}
	if drawn >= pool.MaxCodesPerCampaign {
		return fmt.Errorf("%w: sending scope %q already drew %d of %d code(s) permitted from this pool",
			ErrCouponQuotaExceeded, scope, drawn, pool.MaxCodesPerCampaign)
	}
	return nil
}

func insertCouponAssignmentTx(ctx context.Context, tx pgx.Tx, tenantID, poolID, codeID, code string, in CouponAssignmentInput, status CouponAssignmentStatus, assignedAt time.Time, reservedUntil, expiresAt *time.Time, metadata []byte) (*CouponAssignment, error) {
	// The projection is built from the INSERT's own RETURNING list, NOT by
	// re-selecting the row through a data-modifying CTE.
	//
	// The CTE form this replaces
	//
	//     WITH inserted AS (INSERT ... RETURNING id)
	//     SELECT ... FROM coupon_assignments a WHERE a.id = (SELECT id FROM inserted)
	//
	// cannot work: the outer SELECT reads the snapshot taken before the
	// statement, so the just-inserted row is invisible to it and the query
	// returns zero rows every single time. AssignCoupon therefore failed with
	// pgx.ErrNoRows for every new allocation. Nothing caught it because the
	// allocation surface is gated off (CouponAllocationAvailable) and unmounted,
	// so the only caller was a path nobody could reach.
	//
	// `$4::text` is the issued code, which is a parameter rather than a column
	// here — coupon_assignments stores it in static_code only for static pools,
	// and the code table row is joined in on read.
	row := tx.QueryRow(ctx, `
INSERT INTO coupon_assignments (
    tenant_id, pool_id, code_id, static_code, subscriber_id, subscriber_email,
    context_key, render_key, channel, surface, status, assigned_at,
    reserved_until, expires_at, metadata, campaign_id
) VALUES (
    $1::uuid, $2::uuid, NULLIF($3,'')::uuid, $4, NULLIF($5,'')::uuid, $6,
    $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, NULLIF($16,'')::uuid
)
RETURNING id::text,
          tenant_id::text,
          pool_id::text,
          COALESCE(code_id::text, ''),
          $4::text,
          COALESCE(subscriber_id::text, ''),
          subscriber_email,
          context_key,
          render_key,
          channel,
          surface,
          status,
          assigned_at,
          reserved_until,
          redeemed_at,
          expires_at,
          metadata,
          created_at,
          updated_at`, tenantID, poolID, codeID, code, in.SubscriberID, in.SubscriberEmail,
		in.ContextKey, in.RenderKey, in.Channel, in.Surface, string(status),
		assignedAt, reservedUntil, expiresAt, string(metadata), in.CampaignID)
	return scanCouponAssignment(row)
}

const couponRenderReservationProjection = `id::text,
          tenant_id::text,
          pool_id::text,
          assignment_id::text,
          COALESCE(subscriber_id::text, ''),
          subscriber_email,
          context_key,
          render_key,
          channel,
          surface,
          code,
          expires_at,
          metadata,
          created_at`

// ensureRenderReservationTx pins one render key to one code, permanently.
//
// The conflict arm is DO NOTHING + read-back, not DO UPDATE. Two reasons, and
// the first one is that DO UPDATE could not run at all: migration 0200 grants
// only SELECT, INSERT and DELETE on coupon_render_reservations, so the previous
// `DO UPDATE SET metadata = coupon_render_reservations.metadata` — a self
// assignment written purely to force a RETURNING row — failed with "permission
// denied" on every repeated render. That took the whole AssignCoupon call with
// it whenever a render key was supplied.
//
// The second reason is why the grant is shaped that way: a render key must
// always resolve to the same code. Re-rendering the same message must not be
// able to rewrite what a recipient was already shown, so the stored row wins and
// is returned unchanged.
func ensureRenderReservationTx(ctx context.Context, tx pgx.Tx, tenantID, poolID string, in CouponAssignmentInput, assignment *CouponAssignment, metadata []byte) (*CouponRenderReservation, error) {
	if in.RenderKey == "" {
		return nil, nil
	}
	row := tx.QueryRow(ctx, `
INSERT INTO coupon_render_reservations (
    tenant_id, pool_id, assignment_id, subscriber_id, subscriber_email,
    context_key, render_key, channel, surface, code, expires_at, metadata
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, NULLIF($4,'')::uuid, $5,
    $6, $7, $8, $9, $10, $11, $12::jsonb
)
ON CONFLICT (tenant_id, pool_id, render_key) DO NOTHING
RETURNING `+couponRenderReservationProjection,
		tenantID, poolID, assignment.ID, in.SubscriberID, in.SubscriberEmail,
		in.ContextKey, in.RenderKey, in.Channel, in.Surface, assignment.Code,
		assignment.ExpiresAt, string(metadata))
	out, err := scanCouponRenderReservation(row)
	if err == nil {
		return out, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	return scanCouponRenderReservation(tx.QueryRow(ctx, `
SELECT `+couponRenderReservationProjection+`
  FROM coupon_render_reservations
 WHERE tenant_id = $1::uuid
   AND pool_id = $2::uuid
   AND render_key = $3`, tenantID, poolID, in.RenderKey))
}

func scanCouponRenderReservation(row pgx.Row) (*CouponRenderReservation, error) {
	var out CouponRenderReservation
	var raw []byte
	if err := row.Scan(
		&out.ID,
		&out.TenantID,
		&out.PoolID,
		&out.AssignmentID,
		&out.SubscriberID,
		&out.SubscriberEmail,
		&out.ContextKey,
		&out.RenderKey,
		&out.Channel,
		&out.Surface,
		&out.Code,
		&out.ExpiresAt,
		&raw,
		&out.CreatedAt,
	); err != nil {
		return nil, err
	}
	out.Metadata = decodeJSONMap(raw)
	return &out, nil
}

func scanCouponPool(row pgx.Row) (*CouponPool, error) {
	var p CouponPool
	var codeType, status string
	var raw []byte
	if err := row.Scan(
		&p.ID,
		&p.TenantID,
		&p.DiscountID,
		&p.Name,
		&p.Description,
		&p.Provider,
		&p.ProviderRef,
		&codeType,
		&status,
		&p.DefaultCode,
		&p.ExpiresAt,
		&raw,
		&p.MaxCodesPerSubscriber,
		&p.MaxCodesPerCampaign,
		&p.MaxReservationTTLSeconds,
		&p.AvailableCodes,
		&p.AssignedCodes,
		&p.RedeemedCodes,
		&p.CreatedAt,
		&p.UpdatedAt,
	); err != nil {
		return nil, err
	}
	p.CodeType = CouponPoolCodeType(codeType)
	p.Status = CouponPoolStatus(status)
	p.Settings = decodeJSONMap(raw)
	return &p, nil
}

func scanCouponCode(row pgx.Row) (*CouponCode, error) {
	var c CouponCode
	var status string
	var raw []byte
	if err := row.Scan(
		&c.ID,
		&c.TenantID,
		&c.PoolID,
		&c.Code,
		&status,
		&c.SubscriberID,
		&c.SubscriberEmail,
		&c.ContextKey,
		&c.AssignedAt,
		&c.ReservedUntil,
		&c.RedeemedAt,
		&c.ExpiresAt,
		&raw,
		&c.CreatedAt,
		&c.UpdatedAt,
	); err != nil {
		return nil, err
	}
	c.Status = CouponCodeStatus(status)
	c.Metadata = decodeJSONMap(raw)
	return &c, nil
}

func scanCouponAssignment(row pgx.Row) (*CouponAssignment, error) {
	var a CouponAssignment
	var status string
	var raw []byte
	if err := row.Scan(
		&a.ID,
		&a.TenantID,
		&a.PoolID,
		&a.CodeID,
		&a.Code,
		&a.SubscriberID,
		&a.SubscriberEmail,
		&a.ContextKey,
		&a.RenderKey,
		&a.Channel,
		&a.Surface,
		&status,
		&a.AssignedAt,
		&a.ReservedUntil,
		&a.RedeemedAt,
		&a.ExpiresAt,
		&raw,
		&a.CreatedAt,
		&a.UpdatedAt,
	); err != nil {
		return nil, err
	}
	a.Status = CouponAssignmentStatus(status)
	a.Metadata = decodeJSONMap(raw)
	return &a, nil
}

func decodeJSONMap(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func normalizePage(limit, offset int) (int, int) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}
