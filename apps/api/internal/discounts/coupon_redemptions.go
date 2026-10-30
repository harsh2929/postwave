package discounts

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type couponRedemptionSync struct {
	PoolID         string
	CodeID         string
	AssignmentID   string
	PreviousStatus string
	Redeemed       bool
	Reason         string
}

func redeemCouponTx(ctx context.Context, tx pgx.Tx, tenantID, code string, in CouponRedemptionInput, now time.Time) (*couponRedemptionSync, error) {
	code = normalizeCouponCode(code)
	if code == "" {
		return nil, nil
	}
	if sync, err := redeemCouponAssignmentTx(ctx, tx, tenantID, code, in, now); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	} else {
		return sync, nil
	}
	if sync, err := redeemCouponCodeOnlyTx(ctx, tx, tenantID, code, in, now); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	} else {
		return sync, nil
	}
	return redeemStaticCouponPoolTx(ctx, tx, tenantID, code, in, now)
}

func redeemCouponAssignmentTx(ctx context.Context, tx pgx.Tx, tenantID, code string, in CouponRedemptionInput, now time.Time) (*couponRedemptionSync, error) {
	row := tx.QueryRow(ctx, `
SELECT a.id::text,
       a.pool_id::text,
       COALESCE(a.code_id::text, ''),
       COALESCE(c.code, a.static_code),
       a.status,
       COALESCE(c.status, ''),
       a.expires_at,
       c.expires_at
FROM coupon_assignments a
LEFT JOIN coupon_codes c
       ON c.tenant_id = a.tenant_id
      AND c.id = a.code_id
WHERE a.tenant_id = $1::uuid
  AND upper(COALESCE(c.code, a.static_code)) = $2
  AND ($3 = '' OR a.render_key = $3)
  AND ($4 = '' OR a.context_key = $4)
  AND ($5 = '' OR COALESCE(a.subscriber_id::text, '') = $5)
  AND ($6 = '' OR lower(a.subscriber_email) = lower($6))
ORDER BY CASE WHEN $3 <> '' AND a.render_key = $3 THEN 0 ELSE 1 END,
         CASE WHEN $4 <> '' AND a.context_key = $4 THEN 0 ELSE 1 END,
         CASE WHEN $5 <> '' AND COALESCE(a.subscriber_id::text, '') = $5 THEN 0 ELSE 1 END,
         CASE WHEN $6 <> '' AND lower(a.subscriber_email) = lower($6) THEN 0 ELSE 1 END,
         a.assigned_at DESC,
         a.id DESC
LIMIT 1
FOR UPDATE OF a`,
		tenantID, code, in.RenderKey, in.ContextKey, in.SubscriberID, in.SubscriberEmail)

	var assignmentID, poolID, codeID, matchedCode, assignmentStatus, codeStatus string
	var assignmentExpiresAt, codeExpiresAt *time.Time
	if err := row.Scan(&assignmentID, &poolID, &codeID, &matchedCode, &assignmentStatus,
		&codeStatus, &assignmentExpiresAt, &codeExpiresAt); err != nil {
		return nil, err
	}
	sync := &couponRedemptionSync{
		PoolID:         poolID,
		CodeID:         codeID,
		AssignmentID:   assignmentID,
		PreviousStatus: compactStatus(assignmentStatus, codeStatus),
	}
	if reason := couponNotRedeemableReason(assignmentStatus, codeStatus, assignmentExpiresAt, codeExpiresAt, now); reason != "" {
		if reason == "expired" {
			_ = expireCouponRowsTx(ctx, tx, tenantID, assignmentID, codeID)
		}
		sync.Reason = reason
		return sync, nil
	}
	if codeID != "" {
		if err := markCouponCodeRedeemedTx(ctx, tx, tenantID, codeID, in, now); err != nil {
			return nil, err
		}
	}
	if err := markCouponAssignmentRedeemedTx(ctx, tx, tenantID, assignmentID, in, now); err != nil {
		return nil, err
	}
	sync.Redeemed = true
	_ = matchedCode
	return sync, nil
}

func redeemCouponCodeOnlyTx(ctx context.Context, tx pgx.Tx, tenantID, code string, in CouponRedemptionInput, now time.Time) (*couponRedemptionSync, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text,
       pool_id::text,
       status,
       expires_at
FROM coupon_codes
WHERE tenant_id = $1::uuid
  AND upper(code) = $2
  AND ($3 = '' OR subscriber_id IS NULL OR COALESCE(subscriber_id::text, '') = $3)
  AND ($4 = '' OR subscriber_email = '' OR lower(subscriber_email) = lower($4))
ORDER BY CASE WHEN $3 <> '' AND COALESCE(subscriber_id::text, '') = $3 THEN 0 ELSE 1 END,
         CASE WHEN $4 <> '' AND lower(subscriber_email) = lower($4) THEN 0 ELSE 1 END,
         updated_at DESC,
         created_at DESC
LIMIT 1
FOR UPDATE`,
		tenantID, code, in.SubscriberID, in.SubscriberEmail)
	var codeID, poolID, status string
	var expiresAt *time.Time
	if err := row.Scan(&codeID, &poolID, &status, &expiresAt); err != nil {
		return nil, err
	}
	sync := &couponRedemptionSync{
		PoolID:         poolID,
		CodeID:         codeID,
		PreviousStatus: status,
	}
	if reason := couponNotRedeemableReason("", status, nil, expiresAt, now); reason != "" {
		if reason == "expired" {
			_ = expireCouponRowsTx(ctx, tx, tenantID, "", codeID)
		}
		sync.Reason = reason
		return sync, nil
	}
	if err := markCouponCodeRedeemedTx(ctx, tx, tenantID, codeID, in, now); err != nil {
		return nil, err
	}
	assignmentID, err := insertExternalCouponRedemptionAssignmentTx(ctx, tx, tenantID, poolID, codeID, "", in, now)
	if err != nil {
		return nil, err
	}
	sync.AssignmentID = assignmentID
	sync.Redeemed = true
	return sync, nil
}

func redeemStaticCouponPoolTx(ctx context.Context, tx pgx.Tx, tenantID, code string, in CouponRedemptionInput, now time.Time) (*couponRedemptionSync, error) {
	row := tx.QueryRow(ctx, `
SELECT id::text,
       status,
       expires_at
FROM coupon_pools
WHERE tenant_id = $1::uuid
  AND upper(default_code) = $2
ORDER BY updated_at DESC
LIMIT 1
FOR UPDATE`, tenantID, code)
	var poolID, status string
	var expiresAt *time.Time
	if err := row.Scan(&poolID, &status, &expiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	sync := &couponRedemptionSync{
		PoolID:         poolID,
		PreviousStatus: status,
	}
	if status != string(CouponPoolActive) {
		sync.Reason = "coupon_pool_" + status
		return sync, nil
	}
	if expiresAt != nil && !expiresAt.After(now) {
		sync.Reason = "expired"
		return sync, nil
	}
	assignmentID, err := insertExternalCouponRedemptionAssignmentTx(ctx, tx, tenantID, poolID, "", code, in, now)
	if err != nil {
		return nil, err
	}
	sync.AssignmentID = assignmentID
	sync.Redeemed = true
	return sync, nil
}

func markCouponCodeRedeemedTx(ctx context.Context, tx pgx.Tx, tenantID, codeID string, in CouponRedemptionInput, now time.Time) error {
	_, err := tx.Exec(ctx, `
UPDATE coupon_codes
   SET status = 'redeemed',
       redeemed_at = COALESCE(redeemed_at, $3),
       subscriber_id = COALESCE(subscriber_id, NULLIF($4, '')::uuid),
       subscriber_email = CASE WHEN subscriber_email = '' THEN $5 ELSE subscriber_email END,
       context_key = CASE WHEN context_key = '' THEN $6 ELSE context_key END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, codeID, now, in.SubscriberID, in.SubscriberEmail, in.ContextKey)
	return err
}

func markCouponAssignmentRedeemedTx(ctx context.Context, tx pgx.Tx, tenantID, assignmentID string, in CouponRedemptionInput, now time.Time) error {
	_, err := tx.Exec(ctx, `
UPDATE coupon_assignments
   SET status = 'redeemed',
       redeemed_at = COALESCE(redeemed_at, $3),
       subscriber_id = COALESCE(subscriber_id, NULLIF($4, '')::uuid),
       subscriber_email = CASE WHEN subscriber_email = '' THEN $5 ELSE subscriber_email END,
       context_key = CASE WHEN context_key = '' THEN $6 ELSE context_key END,
       render_key = CASE WHEN render_key = '' THEN $7 ELSE render_key END,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, assignmentID, now, in.SubscriberID, in.SubscriberEmail, in.ContextKey, in.RenderKey)
	return err
}

func insertExternalCouponRedemptionAssignmentTx(ctx context.Context, tx pgx.Tx, tenantID, poolID, codeID, staticCode string, in CouponRedemptionInput, now time.Time) (string, error) {
	metadata, _ := json.Marshal(map[string]any{
		"redemption_source": "redeem_endpoint",
		"materialized":      true,
	})
	var id string
	err := tx.QueryRow(ctx, `
INSERT INTO coupon_assignments (
    tenant_id, pool_id, code_id, static_code, subscriber_id, subscriber_email,
    context_key, render_key, status, assigned_at, redeemed_at, metadata
) VALUES (
    $1::uuid, $2::uuid, NULLIF($3, '')::uuid, $4, NULLIF($5, '')::uuid, $6,
    $7, $8, 'redeemed', $9, $9, $10::jsonb
)
RETURNING id::text`,
		tenantID, poolID, codeID, staticCode, in.SubscriberID, in.SubscriberEmail,
		in.ContextKey, in.RenderKey, now, string(metadata)).Scan(&id)
	return id, err
}

func expireCouponRowsTx(ctx context.Context, tx pgx.Tx, tenantID, assignmentID, codeID string) error {
	if assignmentID != "" {
		if _, err := tx.Exec(ctx, `
UPDATE coupon_assignments
   SET status = 'expired', updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status <> 'redeemed'`, tenantID, assignmentID); err != nil {
			return err
		}
	}
	if codeID != "" {
		if _, err := tx.Exec(ctx, `
UPDATE coupon_codes
   SET status = 'expired', updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status <> 'redeemed'`, tenantID, codeID); err != nil {
			return err
		}
	}
	return nil
}

func couponNotRedeemableReason(assignmentStatus, codeStatus string, assignmentExpiresAt, codeExpiresAt *time.Time, now time.Time) string {
	if codeStatus == string(CouponCodeRedeemed) || assignmentStatus == string(CouponAssignmentRedeemed) {
		return "already_redeemed"
	}
	if codeStatus == string(CouponCodeDisabled) {
		return "coupon_disabled"
	}
	if assignmentStatus == string(CouponAssignmentReleased) {
		return "coupon_released"
	}
	if codeStatus == string(CouponCodeExpired) || assignmentStatus == string(CouponAssignmentExpired) {
		return "expired"
	}
	if assignmentExpiresAt != nil && !assignmentExpiresAt.After(now) {
		return "expired"
	}
	if codeExpiresAt != nil && !codeExpiresAt.After(now) {
		return "expired"
	}
	return ""
}

func couponRedeemResult(code string, sync *couponRedemptionSync) *RedeemResult {
	return &RedeemResult{
		Code:                 normalizeCouponCode(code),
		Valid:                true,
		CurrentlyRedeemable:  sync.Redeemed,
		Reason:               sync.Reason,
		CouponPoolID:         sync.PoolID,
		CouponCodeID:         sync.CodeID,
		CouponAssignmentID:   sync.AssignmentID,
		CouponPreviousStatus: sync.PreviousStatus,
	}
}

func compactStatus(assignmentStatus, codeStatus string) string {
	parts := []string{}
	if assignmentStatus != "" {
		parts = append(parts, "assignment:"+assignmentStatus)
	}
	if codeStatus != "" {
		parts = append(parts, "code:"+codeStatus)
	}
	return strings.Join(parts, ",")
}
