// SPDX-License-Identifier: AGPL-3.0-only
//
// coupon.go — the cross-service wire for the coupon_assign node. The automation
// engine has no coupon-pool logic; it enqueues an `automation.coupon_assign`
// outbox row and apps/api (which owns the discounts package) reserves/assigns a
// code from the pool for the subscriber. Mirrors the send_sms → automation.sms
// pattern exactly.

package runtime

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// couponKind is the outbox kind. MUST stay equal to apps/api
// discounts.AutomationCouponKind.
const couponKind = "automation.coupon_assign"

// CouponAllocationAvailable is the automation service's compile-time
// containment gate. The engine composition root must not install an emitter
// while provider authority and entitlement reconciliation are unavailable.
const CouponAllocationAvailable = false

// CouponAssignRequest is the outbox payload (wire contract with apps/api).
type CouponAssignRequest struct {
	PoolID          string `json:"pool_id"`
	SubscriberEmail string `json:"subscriber_email"`
	AutomationID    string `json:"automation_id"`
	NodeID          string `json:"node_id"`
}

// CouponEmitter enqueues a coupon assignment for apps/api to fulfil.
type CouponEmitter interface {
	Emit(ctx context.Context, tenantID string, req CouponAssignRequest) error
}

// PgxCouponEmitter writes the automation.coupon_assign outbox row.
type PgxCouponEmitter struct {
	Pool *pgxpool.Pool
}

func (e *PgxCouponEmitter) Emit(ctx context.Context, tenantID string, req CouponAssignRequest) error {
	// A misconfigured emitter must not report success. Returning nil here told the
	// engine the work was enqueued and it advanced to the next node — so a
	// coupon assignment that never happened looked exactly like one that did: no error, no
	// retry, no DLQ entry, and a run marked complete.
	//
	// The nil-INTERFACE case is already handled at the call site (engine.go checks
	// `if e.Email != nil` before reaching this), so arriving here means somebody
	// wired an emitter. A nil receiver, an unset pool or an empty tenant are all
	// wiring faults, and the only safe answer to "did it send?" is an error.
	if tenantID == "" {
		return fmt.Errorf("automation coupon: tenant id required")
	}
	if e == nil || e.Pool == nil {
		return fmt.Errorf("automation coupon: emitter is not configured")
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("automation coupon: marshal: %w", err)
	}
	tx, err := e.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("automation coupon: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("automation coupon: bind tenant: %w", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload, max_attempts)
VALUES ($1::uuid, $2, $3::jsonb, 10)`, tenantID, couponKind, string(payload)); err != nil {
		return fmt.Errorf("automation coupon: enqueue: %w", err)
	}
	return tx.Commit(ctx)
}
