// SPDX-License-Identifier: AGPL-3.0-only
//
// coupon_allocation_safety.go — the four containment prerequisites named in the
// CouponAllocationAvailable gate comment that are CODE rather than a business
// fact: reservation expiry/release, durable entitlement auditing, abuse
// controls, and reconciliation.
//
// The gate stays false. What this file changes is the QUESTION a human is asked
// at certification time: not "has anyone built the release path yet?" but "is
// this evidence good enough?". See coupon_allocation_certification.go for what
// is left, and why no test can settle it.
//
// The durable-auditing half lives in the database (migration 1970): every
// coupon_codes and coupon_assignments status transition writes an append-only
// coupon_entitlement_events receipt from a trigger. Nothing in this file writes
// a receipt, on purpose — a receipt that call sites are responsible for writing
// is a receipt that is missing exactly when it matters. The Go side only labels
// the receipt, by binding `app.coupon_actor` and `app.coupon_transition_reason`
// for the transaction before it mutates anything.

package discounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrCouponQuotaExceeded reports that an allocation was refused by a pool's
// abuse-control bound (max_codes_per_subscriber / max_codes_per_campaign).
//
// It is a REFUSAL, not an exhaustion: the pool may be full of codes. Callers
// that treat ErrCouponExhausted as terminal should treat this one the same way
// — retrying draws the same refusal — but must not report it to an operator as
// "the pool ran out", which sends them to buy inventory they already have.
var ErrCouponQuotaExceeded = errors.New("discounts: coupon allocation quota exceeded")

// Actor labels written onto entitlement receipts. They name the mechanism that
// caused a transition, so a receipt trail distinguishes "an operator released
// this" from "the sweeper reclaimed it" from "a recipient redeemed it".
const (
	CouponActorAllocator  = "coupon_allocator"
	CouponActorSweeper    = "reservation_sweeper"
	CouponActorRelease    = "release_api"
	CouponActorConfirm    = "reservation_confirm"
	CouponActorRedemption = "redemption"
)

// Reasons written onto entitlement receipts alongside the actor.
const (
	CouponReasonAllocated           = "allocated"
	CouponReasonReservationExpired  = "reservation_expired"
	CouponReasonReservationReleased = "reservation_released"
	CouponReasonReservationConfirm  = "reservation_confirmed"
	CouponReasonRedeemed            = "redeemed"
)

// SQLSTATEs raised by migration 1970's guards.
const (
	sqlStateSubscriberQuota = "PWQ01"
	sqlStateCampaignQuota   = "PWQ02"
	sqlStateLedgerForged    = "PWL01"
	sqlStateLedgerMutation  = "PWL02"
)

// maxReconciliationFindingsPerCheck bounds one reconciliation report. A pool
// that has gone badly wrong produces unbounded drift, and a report that cannot
// be read is a report nobody reads.
const maxReconciliationFindingsPerCheck = 200

// CouponReleaseRecord names one reservation that returned to the pool.
type CouponReleaseRecord struct {
	AssignmentID    string     `json:"assignment_id"`
	PoolID          string     `json:"pool_id"`
	CodeID          string     `json:"code_id,omitempty"`
	Code            string     `json:"code,omitempty"`
	SubscriberID    string     `json:"subscriber_id,omitempty"`
	SubscriberEmail string     `json:"subscriber_email,omitempty"`
	ContextKey      string     `json:"context_key,omitempty"`
	RenderKey       string     `json:"render_key,omitempty"`
	ReservedUntil   *time.Time `json:"reserved_until,omitempty"`
	CodeReturned    bool       `json:"code_returned"`
}

// CouponReservationSweep is the result of one expiry pass.
type CouponReservationSweep struct {
	PoolID                    string                `json:"pool_id,omitempty"`
	SweptAt                   time.Time             `json:"swept_at"`
	AssignmentsExpired        int                   `json:"assignments_expired"`
	CodesReturnedToPool       int                   `json:"codes_returned_to_pool"`
	OrphanCodesReturned       int                   `json:"orphan_codes_returned"`
	RenderReservationsRemoved int                   `json:"render_reservations_removed"`
	Released                  []CouponReleaseRecord `json:"released"`
}

// CouponReleaseOutcome is the result of an explicit release.
//
// Released is false for every no-op, and Reason says which no-op it was. The
// call is idempotent: releasing an already-released assignment changes nothing
// and adds no second receipt, because the database writes a receipt on a status
// CHANGE and there is no change to make.
type CouponReleaseOutcome struct {
	AssignmentID   string `json:"assignment_id"`
	PoolID         string `json:"pool_id"`
	CodeID         string `json:"code_id,omitempty"`
	Code           string `json:"code,omitempty"`
	PreviousStatus string `json:"previous_status"`
	Released       bool   `json:"released"`
	CodeReturned   bool   `json:"code_returned"`
	Reason         string `json:"reason,omitempty"`
}

// CouponConfirmOutcome is the result of promoting a reservation to an
// assignment — the "the message actually went out" half of reserve/assign.
type CouponConfirmOutcome struct {
	AssignmentID   string `json:"assignment_id"`
	PoolID         string `json:"pool_id"`
	CodeID         string `json:"code_id,omitempty"`
	Code           string `json:"code,omitempty"`
	PreviousStatus string `json:"previous_status"`
	Confirmed      bool   `json:"confirmed"`
	Reason         string `json:"reason,omitempty"`
}

// ExpireCouponReservations returns every reservation whose deadline has passed
// to the pool.
//
// WHY THIS HAS TO EXIST. A reserved code is inventory withheld from everyone
// else on behalf of one recipient. If the process that reserved it dies before
// the message goes out — or the send fails, or the render is abandoned — nobody
// ever gets that code and nobody else can be given it. `reserved_until` was
// written by the allocator since migration 0200 and never once read. This reads
// it.
//
// CRASH SAFETY. Reserve and the assignment row are written in one transaction,
// so there is no window where a code is held with no record of who holds it.
// The window that does exist is between COMMIT and the send: the reservation is
// durable and the delivery has not happened. That window is closed by expiry,
// not by cleanup-on-crash, because a crashed process cannot clean anything up.
//
// IDEMPOTENCE. Every statement is conditioned on the state it is changing away
// from ('reserved'), so a second pass over the same tenant matches zero rows,
// changes nothing, and writes no second receipt. Two sweepers racing take row
// locks and the loser re-evaluates its predicate after the winner commits.
//
// A code that was REDEEMED between the deadline and this pass is deliberately
// left alone: its assignment is no longer 'reserved', so the first statement
// skips it, and its code row is no longer 'reserved', so the second does too.
// Reclaiming a redeemed code would hand a spent discount to a second recipient.
//
// poolID may be empty to sweep every pool of the tenant. Scheduling is the
// caller's problem and is deliberately not wired: with CouponAllocationAvailable
// false there is nothing to sweep, and a cross-tenant scheduler needs a worker
// scope this package does not own.
func (r *Repo) ExpireCouponReservations(ctx context.Context, tenantID, poolID string, now time.Time) (*CouponReservationSweep, error) {
	if strings.TrimSpace(poolID) != "" {
		if _, err := uuid.Parse(strings.TrimSpace(poolID)); err != nil {
			return nil, fmt.Errorf("%w: pool id must be a UUID", ErrInvalidInput)
		}
		poolID = strings.TrimSpace(poolID)
	}
	now = now.UTC()

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindCouponTransitionContext(ctx, tx, CouponActorSweeper, CouponReasonReservationExpired); err != nil {
		return nil, err
	}

	out := &CouponReservationSweep{PoolID: poolID, SweptAt: now, Released: []CouponReleaseRecord{}}

	rows, err := tx.Query(ctx, `
UPDATE coupon_assignments
   SET status = 'expired',
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND (NULLIF($2, '') IS NULL OR pool_id = NULLIF($2, '')::uuid)
   AND status = 'reserved'
   AND reserved_until IS NOT NULL
   AND reserved_until <= $3
RETURNING id::text,
          pool_id::text,
          COALESCE(code_id::text, ''),
          COALESCE(subscriber_id::text, ''),
          subscriber_email,
          context_key,
          render_key,
          reserved_until`, tenantID, poolID, now)
	if err != nil {
		return nil, err
	}
	expired := []CouponReleaseRecord{}
	for rows.Next() {
		var rec CouponReleaseRecord
		if err := rows.Scan(&rec.AssignmentID, &rec.PoolID, &rec.CodeID, &rec.SubscriberID,
			&rec.SubscriberEmail, &rec.ContextKey, &rec.RenderKey, &rec.ReservedUntil); err != nil {
			rows.Close()
			return nil, err
		}
		expired = append(expired, rec)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out.AssignmentsExpired = len(expired)

	assignmentIDs := make([]string, 0, len(expired))
	codeIDs := make([]string, 0, len(expired))
	for _, rec := range expired {
		assignmentIDs = append(assignmentIDs, rec.AssignmentID)
		if rec.CodeID != "" {
			codeIDs = append(codeIDs, rec.CodeID)
		}
	}

	returned := map[string]string{}
	if len(codeIDs) > 0 {
		codeRows, err := tx.Query(ctx, `
UPDATE coupon_codes
   SET status = 'available',
       subscriber_id = NULL,
       subscriber_email = '',
       context_key = '',
       assigned_at = NULL,
       reserved_until = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = ANY($2::uuid[])
   AND status = 'reserved'
RETURNING id::text, code`, tenantID, codeIDs)
		if err != nil {
			return nil, err
		}
		for codeRows.Next() {
			var id, code string
			if err := codeRows.Scan(&id, &code); err != nil {
				codeRows.Close()
				return nil, err
			}
			returned[id] = code
		}
		codeRows.Close()
		if err := codeRows.Err(); err != nil {
			return nil, err
		}
	}
	out.CodesReturnedToPool = len(returned)

	for i := range expired {
		if code, ok := returned[expired[i].CodeID]; ok {
			expired[i].Code = code
			expired[i].CodeReturned = true
		}
	}
	out.Released = expired

	// Orphans: a code past its reservation deadline with no live assignment at
	// all. Nothing in the current allocator can produce one (the code update and
	// the assignment insert share a transaction), which is exactly why it is
	// worth reclaiming — if one appears, the assumption that made it impossible
	// has stopped holding, and the inventory should not be lost while we find
	// out why. Reconciliation reports the same condition as drift.
	orphanRows, err := tx.Query(ctx, `
UPDATE coupon_codes c
   SET status = 'available',
       subscriber_id = NULL,
       subscriber_email = '',
       context_key = '',
       assigned_at = NULL,
       reserved_until = NULL,
       updated_at = now()
 WHERE c.tenant_id = $1::uuid
   AND (NULLIF($2, '') IS NULL OR c.pool_id = NULLIF($2, '')::uuid)
   AND c.status = 'reserved'
   AND c.reserved_until IS NOT NULL
   AND c.reserved_until <= $3
   AND NOT EXISTS (
       SELECT 1
         FROM coupon_assignments a
        WHERE a.tenant_id = c.tenant_id
          AND a.code_id = c.id
          AND a.status IN ('reserved', 'assigned', 'redeemed')
   )
RETURNING c.id::text`, tenantID, poolID, now)
	if err != nil {
		return nil, err
	}
	for orphanRows.Next() {
		var id string
		if err := orphanRows.Scan(&id); err != nil {
			orphanRows.Close()
			return nil, err
		}
		out.OrphanCodesReturned++
	}
	orphanRows.Close()
	if err := orphanRows.Err(); err != nil {
		return nil, err
	}

	if len(assignmentIDs) > 0 {
		tag, err := tx.Exec(ctx, `
DELETE FROM coupon_render_reservations
 WHERE tenant_id = $1::uuid
   AND assignment_id = ANY($2::uuid[])`, tenantID, assignmentIDs)
		if err != nil {
			return nil, err
		}
		out.RenderReservationsRemoved = int(tag.RowsAffected())
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ReleaseCouponAssignment hands one reservation or assignment back to the pool
// before its deadline — the operator-driven and send-failed path.
//
// Idempotent by construction: the transition is conditioned on the current
// status, and a redeemed assignment is never released. A caller that retries
// after a timeout gets Released=false with a Reason rather than a second
// release, and the ledger keeps exactly one release receipt.
//
// The clock parameter is accepted for signature symmetry with its siblings but
// unused: a release has no deadline to compare against and the row and ledger
// are stamped by the database clock (updated_at = now()).
func (r *Repo) ReleaseCouponAssignment(ctx context.Context, tenantID, assignmentID, reason string, _ time.Time) (*CouponReleaseOutcome, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(assignmentID))
	if err != nil {
		return nil, fmt.Errorf("%w: assignment id must be a UUID", ErrInvalidInput)
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = CouponReasonReservationReleased
	}
	if len(reason) > 200 {
		return nil, fmt.Errorf("%w: release reason must be at most 200 characters", ErrInvalidInput)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindCouponTransitionContext(ctx, tx, CouponActorRelease, reason); err != nil {
		return nil, err
	}

	var out CouponReleaseOutcome
	out.AssignmentID = parsed.String()
	if err := tx.QueryRow(ctx, `
SELECT pool_id::text,
       COALESCE(code_id::text, ''),
       COALESCE(NULLIF(static_code, ''), ''),
       status
  FROM coupon_assignments
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   FOR UPDATE`, tenantID, parsed.String()).Scan(&out.PoolID, &out.CodeID, &out.Code, &out.PreviousStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	switch out.PreviousStatus {
	case string(CouponAssignmentRedeemed):
		out.Reason = "already_redeemed"
		return &out, nil
	case string(CouponAssignmentReleased):
		out.Reason = "already_released"
		return &out, nil
	case string(CouponAssignmentExpired):
		out.Reason = "already_expired"
		return &out, nil
	}

	tag, err := tx.Exec(ctx, `
UPDATE coupon_assignments
   SET status = 'released',
       reserved_until = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status IN ('reserved', 'assigned')`, tenantID, parsed.String())
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		// Lost a race with a concurrent redeem/release between the locking read
		// and here. Report the no-op rather than inventing a release.
		out.Reason = "not_releasable"
		return &out, nil
	}
	out.Released = true

	if out.CodeID != "" {
		var code string
		err := tx.QueryRow(ctx, `
UPDATE coupon_codes
   SET status = 'available',
       subscriber_id = NULL,
       subscriber_email = '',
       context_key = '',
       assigned_at = NULL,
       reserved_until = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status IN ('reserved', 'assigned')
RETURNING code`, tenantID, out.CodeID).Scan(&code)
		switch {
		case err == nil:
			out.Code = code
			out.CodeReturned = true
		case errors.Is(err, pgx.ErrNoRows):
			// The code moved on (redeemed or disabled) under us. The assignment
			// release stands and reconciliation will report the mismatch; we do
			// not force the code back into inventory.
		default:
			return nil, err
		}
	}

	if _, err := tx.Exec(ctx, `
DELETE FROM coupon_render_reservations
 WHERE tenant_id = $1::uuid
   AND assignment_id = $2::uuid`, tenantID, parsed.String()); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// ConfirmCouponReservation promotes a live reservation to a durable assignment.
//
// This is the missing half of the reserve/assign pair. Without it a reservation
// could only ever expire, which made `reservation_ttl_seconds` a way to lose
// inventory rather than a way to protect it: the caller reserved, sent the
// message, and the code went back in the pool anyway.
//
// A reservation whose deadline has passed is NOT resurrected — the sweeper may
// already have handed that code to someone else, and confirming here would
// promise the same discount twice. The caller gets Confirmed=false with
// reason "reservation_expired" and must allocate again.
func (r *Repo) ConfirmCouponReservation(ctx context.Context, tenantID, assignmentID string, now time.Time) (*CouponConfirmOutcome, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(assignmentID))
	if err != nil {
		return nil, fmt.Errorf("%w: assignment id must be a UUID", ErrInvalidInput)
	}
	now = now.UTC()

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := bindCouponTransitionContext(ctx, tx, CouponActorConfirm, CouponReasonReservationConfirm); err != nil {
		return nil, err
	}

	var out CouponConfirmOutcome
	out.AssignmentID = parsed.String()
	var reservedUntil *time.Time
	if err := tx.QueryRow(ctx, `
SELECT pool_id::text,
       COALESCE(code_id::text, ''),
       COALESCE(NULLIF(static_code, ''), ''),
       status,
       reserved_until
  FROM coupon_assignments
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   FOR UPDATE`, tenantID, parsed.String()).Scan(&out.PoolID, &out.CodeID, &out.Code, &out.PreviousStatus, &reservedUntil); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	switch out.PreviousStatus {
	case string(CouponAssignmentAssigned):
		out.Reason = "already_assigned"
		return &out, nil
	case string(CouponAssignmentRedeemed):
		out.Reason = "already_redeemed"
		return &out, nil
	case string(CouponAssignmentReleased):
		out.Reason = "already_released"
		return &out, nil
	case string(CouponAssignmentExpired):
		out.Reason = CouponReasonReservationExpired
		return &out, nil
	}
	if reservedUntil != nil && !reservedUntil.After(now) {
		out.Reason = CouponReasonReservationExpired
		return &out, nil
	}

	tag, err := tx.Exec(ctx, `
UPDATE coupon_assignments
   SET status = 'assigned',
       reserved_until = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'reserved'`, tenantID, parsed.String())
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		out.Reason = "not_confirmable"
		return &out, nil
	}
	out.Confirmed = true

	if out.CodeID != "" {
		var code string
		err := tx.QueryRow(ctx, `
UPDATE coupon_codes
   SET status = 'assigned',
       reserved_until = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
   AND status = 'reserved'
RETURNING code`, tenantID, out.CodeID).Scan(&code)
		switch {
		case err == nil:
			out.Code = code
		case errors.Is(err, pgx.ErrNoRows):
		default:
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// CouponEntitlementEvent is one append-only receipt: who got what, when, under
// which actor, and why.
type CouponEntitlementEvent struct {
	ID              int64      `json:"id"`
	TenantID        string     `json:"tenant_id"`
	PoolID          string     `json:"pool_id"`
	SubjectKind     string     `json:"subject_kind"`
	CodeID          string     `json:"code_id,omitempty"`
	AssignmentID    string     `json:"assignment_id,omitempty"`
	Code            string     `json:"code,omitempty"`
	FromStatus      string     `json:"from_status,omitempty"`
	ToStatus        string     `json:"to_status"`
	SubscriberID    string     `json:"subscriber_id,omitempty"`
	SubscriberEmail string     `json:"subscriber_email,omitempty"`
	ContextKey      string     `json:"context_key,omitempty"`
	RenderKey       string     `json:"render_key,omitempty"`
	CampaignID      string     `json:"campaign_id,omitempty"`
	Actor           string     `json:"actor"`
	Reason          string     `json:"reason,omitempty"`
	ReservedUntil   *time.Time `json:"reserved_until,omitempty"`
	OccurredAt      time.Time  `json:"occurred_at"`
}

// CouponEntitlementFilter narrows an entitlement-trail read. Every field is
// optional; an empty filter returns the pool's whole trail newest-first.
type CouponEntitlementFilter struct {
	AssignmentID    string
	CodeID          string
	SubscriberID    string
	SubscriberEmail string
}

// CouponEntitlementEventsPage is a paginated entitlement trail.
type CouponEntitlementEventsPage struct {
	Items    []CouponEntitlementEvent `json:"items"`
	PageInfo PageInfoLike             `json:"page_info"`
}

// ListCouponEntitlementEvents reads the append-only trail for a pool.
//
// This is the read side of "a discount is money": the answer to a chargeback is
// a receipt naming the recipient, the code, the transition, and the time — not
// a current-state row that has since moved on.
func (r *Repo) ListCouponEntitlementEvents(ctx context.Context, tenantID, poolID string, filter CouponEntitlementFilter, limit, offset int) (*CouponEntitlementEventsPage, error) {
	parsedPool, err := uuid.Parse(strings.TrimSpace(poolID))
	if err != nil {
		return nil, fmt.Errorf("%w: pool id must be a UUID", ErrInvalidInput)
	}
	for label, raw := range map[string]string{
		"assignment_id": filter.AssignmentID,
		"code_id":       filter.CodeID,
		"subscriber_id": filter.SubscriberID,
	} {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		if _, err := uuid.Parse(strings.TrimSpace(raw)); err != nil {
			return nil, fmt.Errorf("%w: %s must be a UUID", ErrInvalidInput, label)
		}
	}
	limit, offset = normalizePage(limit, offset)

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	args := []any{
		tenantID,
		parsedPool.String(),
		strings.TrimSpace(filter.AssignmentID),
		strings.TrimSpace(filter.CodeID),
		strings.TrimSpace(filter.SubscriberID),
		strings.ToLower(strings.TrimSpace(filter.SubscriberEmail)),
	}
	const where = `
WHERE tenant_id = $1::uuid
  AND pool_id = $2::uuid
  AND (NULLIF($3, '') IS NULL OR assignment_id = NULLIF($3, '')::uuid)
  AND (NULLIF($4, '') IS NULL OR code_id = NULLIF($4, '')::uuid)
  AND (NULLIF($5, '') IS NULL OR subscriber_id = NULLIF($5, '')::uuid)
  AND ($6 = '' OR lower(subscriber_email) = $6)`

	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*)::int FROM coupon_entitlement_events`+where, args...).Scan(&total); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
SELECT id,
       tenant_id::text,
       pool_id::text,
       subject_kind,
       COALESCE(code_id::text, ''),
       COALESCE(assignment_id::text, ''),
       code,
       COALESCE(from_status, ''),
       to_status,
       COALESCE(subscriber_id::text, ''),
       subscriber_email,
       context_key,
       render_key,
       COALESCE(campaign_id::text, ''),
       actor,
       reason,
       reserved_until,
       occurred_at
  FROM coupon_entitlement_events`+where+`
ORDER BY id DESC
LIMIT $7 OFFSET $8`, append(args, limit, offset)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CouponEntitlementEvent{}
	for rows.Next() {
		var ev CouponEntitlementEvent
		if err := rows.Scan(&ev.ID, &ev.TenantID, &ev.PoolID, &ev.SubjectKind, &ev.CodeID,
			&ev.AssignmentID, &ev.Code, &ev.FromStatus, &ev.ToStatus, &ev.SubscriberID,
			&ev.SubscriberEmail, &ev.ContextKey, &ev.RenderKey, &ev.CampaignID,
			&ev.Actor, &ev.Reason, &ev.ReservedUntil, &ev.OccurredAt); err != nil {
			return nil, err
		}
		items = append(items, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &CouponEntitlementEventsPage{
		Items:    items,
		PageInfo: PageInfoLike{Total: total, Page: offset/limit + 1, PerPage: limit},
	}, nil
}

// CouponDriftKind names one way a coupon pool's books can disagree with itself.
type CouponDriftKind string

const (
	// Inventory is held but nobody is entitled to it: the code will never be
	// given to anyone and never returns to the pool.
	CouponDriftCodeHeldWithoutAssignment CouponDriftKind = "code_held_without_live_assignment"
	// The ledger says a recipient holds this code; inventory says it is free.
	// The same code can be handed to a second recipient.
	CouponDriftAssignmentWithoutHeldCode CouponDriftKind = "assignment_without_held_code"
	// Assignment and code disagree about redemption.
	CouponDriftStatusMismatch CouponDriftKind = "assignment_code_status_mismatch"
	// A reservation is past its deadline and still held: the sweeper is not
	// running, or is failing.
	CouponDriftReservationPastDeadline CouponDriftKind = "reservation_past_deadline"
	// A transition exists with no append-only receipt for its current status.
	CouponDriftMissingReceipt CouponDriftKind = "missing_entitlement_receipt"
	// More live codes are held by one subscriber than the pool permits.
	CouponDriftSubscriberQuotaBreached CouponDriftKind = "subscriber_quota_breached"
	// More live codes were drawn by one sending scope than the pool permits.
	CouponDriftCampaignQuotaBreached CouponDriftKind = "campaign_quota_breached"
	// One code is held live by more than one assignment.
	CouponDriftCodeHeldTwice CouponDriftKind = "code_held_by_multiple_assignments"
)

// CouponDrift is one reconciliation finding. It is a REPORT: no field of it
// implies a repair, and nothing in this package repairs anything.
type CouponDrift struct {
	Kind            CouponDriftKind `json:"kind"`
	CodeID          string          `json:"code_id,omitempty"`
	AssignmentID    string          `json:"assignment_id,omitempty"`
	Code            string          `json:"code,omitempty"`
	SubscriberID    string          `json:"subscriber_id,omitempty"`
	SubscriberEmail string          `json:"subscriber_email,omitempty"`
	ContextKey      string          `json:"context_key,omitempty"`
	ScopeKey        string          `json:"scope_key,omitempty"`
	Observed        string          `json:"observed,omitempty"`
	Expected        string          `json:"expected,omitempty"`
	Detail          string          `json:"detail"`
}

// CouponStatusCounts is the ledger side of a pool at reconciliation time.
type CouponStatusCounts struct {
	Available int `json:"available"`
	Reserved  int `json:"reserved"`
	Assigned  int `json:"assigned"`
	Redeemed  int `json:"redeemed"`
	Released  int `json:"released"`
	Expired   int `json:"expired"`
	Disabled  int `json:"disabled"`
	Total     int `json:"total"`
}

// CouponPoolReconciliation is one read-only reconciliation report.
type CouponPoolReconciliation struct {
	PoolID           string             `json:"pool_id"`
	CheckedAt        time.Time          `json:"checked_at"`
	Codes            CouponStatusCounts `json:"codes"`
	Assignments      CouponStatusCounts `json:"assignments"`
	ReceiptCount     int                `json:"receipt_count"`
	Drift            []CouponDrift      `json:"drift"`
	DriftCount       int                `json:"drift_count"`
	Truncated        bool               `json:"truncated"`
	Healthy          bool               `json:"healthy"`
	MaxPerSubscriber int                `json:"max_codes_per_subscriber"`
	MaxPerCampaign   int                `json:"max_codes_per_campaign"`
}

// ReconcileCouponPool compares a pool's inventory, its assignment ledger, and
// its append-only entitlement receipts, and REPORTS every disagreement.
//
// IT DOES NOT CORRECT ANYTHING, and it is structurally unable to. The whole
// routine runs inside a READ ONLY transaction, so an "obvious" one-line repair
// added here later does not quietly succeed — PostgreSQL refuses the statement.
// That is the point: silent correction destroys the evidence that something went
// wrong. A pool that drifted once will drift again, and the second time nobody
// will know it is the second time. Repairs are separate, deliberate, logged
// operations (ReleaseCouponAssignment, ExpireCouponReservations) that leave
// their own receipts.
//
// A report with Healthy=false is not an incident by itself: rows written before
// migration 1970 have no receipts and are reported as CouponDriftMissingReceipt
// exactly once each, which is honest — there is no evidence for them, and
// manufacturing some would be worse.
func (r *Repo) ReconcileCouponPool(ctx context.Context, tenantID, poolID string, now time.Time) (*CouponPoolReconciliation, error) {
	parsedPool, err := uuid.Parse(strings.TrimSpace(poolID))
	if err != nil {
		return nil, fmt.Errorf("%w: pool id must be a UUID", ErrInvalidInput)
	}
	pool := parsedPool.String()
	now = now.UTC()

	tx, err := db.WithTenantOptions(ctx, r.Pool, tenantID, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &CouponPoolReconciliation{PoolID: pool, CheckedAt: now, Drift: []CouponDrift{}}

	if err := tx.QueryRow(ctx, `
SELECT max_codes_per_subscriber, max_codes_per_campaign
  FROM coupon_pools
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, pool).Scan(&out.MaxPerSubscriber, &out.MaxPerCampaign); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE status = 'available')::int,
       count(*) FILTER (WHERE status = 'reserved')::int,
       count(*) FILTER (WHERE status = 'assigned')::int,
       count(*) FILTER (WHERE status = 'redeemed')::int,
       count(*) FILTER (WHERE status = 'expired')::int,
       count(*) FILTER (WHERE status = 'disabled')::int,
       count(*)::int
  FROM coupon_codes
 WHERE tenant_id = $1::uuid
   AND pool_id = $2::uuid`, tenantID, pool).Scan(
		&out.Codes.Available, &out.Codes.Reserved, &out.Codes.Assigned,
		&out.Codes.Redeemed, &out.Codes.Expired, &out.Codes.Disabled, &out.Codes.Total); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE status = 'reserved')::int,
       count(*) FILTER (WHERE status = 'assigned')::int,
       count(*) FILTER (WHERE status = 'redeemed')::int,
       count(*) FILTER (WHERE status = 'released')::int,
       count(*) FILTER (WHERE status = 'expired')::int,
       count(*)::int
  FROM coupon_assignments
 WHERE tenant_id = $1::uuid
   AND pool_id = $2::uuid`, tenantID, pool).Scan(
		&out.Assignments.Reserved, &out.Assignments.Assigned, &out.Assignments.Redeemed,
		&out.Assignments.Released, &out.Assignments.Expired, &out.Assignments.Total); err != nil {
		return nil, err
	}

	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM coupon_entitlement_events
 WHERE tenant_id = $1::uuid
   AND pool_id = $2::uuid`, tenantID, pool).Scan(&out.ReceiptCount); err != nil {
		return nil, err
	}

	checks := []struct {
		kind CouponDriftKind
		sql  string
		args []any
	}{
		{
			kind: CouponDriftCodeHeldWithoutAssignment,
			sql: `
SELECT c.id::text, '', c.code, COALESCE(c.subscriber_id::text, ''), c.subscriber_email, c.context_key, '', c.status, 'available or a live assignment'
  FROM coupon_codes c
 WHERE c.tenant_id = $1::uuid
   AND c.pool_id = $2::uuid
   AND c.status IN ('reserved', 'assigned')
   AND NOT EXISTS (
       SELECT 1 FROM coupon_assignments a
        WHERE a.tenant_id = c.tenant_id
          AND a.code_id = c.id
          AND a.status IN ('reserved', 'assigned', 'redeemed')
   )
 ORDER BY c.updated_at DESC, c.id
 LIMIT $3`,
		},
		{
			kind: CouponDriftAssignmentWithoutHeldCode,
			sql: `
SELECT COALESCE(a.code_id::text, ''), a.id::text, COALESCE(c.code, a.static_code),
       COALESCE(a.subscriber_id::text, ''), a.subscriber_email, a.context_key, '',
       COALESCE(c.status, 'missing'), 'reserved, assigned or redeemed'
  FROM coupon_assignments a
  LEFT JOIN coupon_codes c
         ON c.tenant_id = a.tenant_id AND c.id = a.code_id
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.code_id IS NOT NULL
   AND a.status IN ('reserved', 'assigned')
   AND (c.id IS NULL OR c.status NOT IN ('reserved', 'assigned', 'redeemed'))
 ORDER BY a.assigned_at DESC, a.id
 LIMIT $3`,
		},
		{
			kind: CouponDriftStatusMismatch,
			sql: `
SELECT COALESCE(a.code_id::text, ''), a.id::text, COALESCE(c.code, a.static_code),
       COALESCE(a.subscriber_id::text, ''), a.subscriber_email, a.context_key, '',
       'assignment=' || a.status || ' code=' || COALESCE(c.status, 'missing'),
       'both redeemed or neither'
  FROM coupon_assignments a
  JOIN coupon_codes c
    ON c.tenant_id = a.tenant_id AND c.id = a.code_id
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND (
        (a.status = 'redeemed' AND c.status <> 'redeemed')
     OR (c.status = 'redeemed' AND a.status IN ('reserved', 'assigned'))
   )
 ORDER BY a.assigned_at DESC, a.id
 LIMIT $3`,
		},
		{
			kind: CouponDriftReservationPastDeadline,
			sql: `
SELECT COALESCE(a.code_id::text, ''), a.id::text, COALESCE(c.code, a.static_code),
       COALESCE(a.subscriber_id::text, ''), a.subscriber_email, a.context_key, '',
       'reserved_until=' || to_char(a.reserved_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SSZ'),
       'released back to the pool'
  FROM coupon_assignments a
  LEFT JOIN coupon_codes c
         ON c.tenant_id = a.tenant_id AND c.id = a.code_id
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.status = 'reserved'
   AND a.reserved_until IS NOT NULL
   AND a.reserved_until <= $4
 ORDER BY a.reserved_until, a.id
 LIMIT $3`,
			args: []any{now},
		},
		{
			kind: CouponDriftCodeHeldTwice,
			sql: `
SELECT a.code_id::text, '', max(c.code), '', '', '', '',
       count(*)::text || ' live assignments', 'exactly 1'
  FROM coupon_assignments a
  JOIN coupon_codes c
    ON c.tenant_id = a.tenant_id AND c.id = a.code_id
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.status IN ('reserved', 'assigned', 'redeemed')
 GROUP BY a.code_id
HAVING count(*) > 1
 ORDER BY count(*) DESC, a.code_id
 LIMIT $3`,
		},
		{
			kind: CouponDriftMissingReceipt,
			sql: `
SELECT COALESCE(a.code_id::text, ''), a.id::text, COALESCE(c.code, a.static_code),
       COALESCE(a.subscriber_id::text, ''), a.subscriber_email, a.context_key, '',
       'no receipt for status ' || a.status, 'one append-only receipt per transition'
  FROM coupon_assignments a
  LEFT JOIN coupon_codes c
         ON c.tenant_id = a.tenant_id AND c.id = a.code_id
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND NOT EXISTS (
       SELECT 1 FROM coupon_entitlement_events e
        WHERE e.tenant_id = a.tenant_id
          AND e.assignment_id = a.id
          AND e.to_status = a.status
   )
 ORDER BY a.assigned_at DESC, a.id
 LIMIT $3`,
		},
		{
			// The CODE leg of the same rule.
			//
			// The assignment leg above was the only missing-receipt check, so a
			// code transition with no receipt produced NO drift finding. That is
			// the half that matters most for evidence: coupon_codes carries the
			// inventory state a reconciliation is trying to account for, and a
			// status it reached with nothing recording how is exactly the
			// un-evidenced transition this whole ledger exists to make impossible.
			//
			// Restricted to live statuses because 'available' is the resting
			// state a code is CREATED in rather than a state it transitions to,
			// and demanding a receipt for it would report every freshly imported
			// pool as drifted on the day it was created.
			//
			// subject_kind = 'code' is what makes this leg INDEPENDENT of the one
			// above. The assignment trigger also writes a receipt naming the code,
			// so without this predicate an assignment receipt would satisfy the
			// code's requirement and the two legs would be one check wearing two
			// names — which is exactly how the missing leg went unnoticed: the
			// only proof disabled both triggers at once and the assignment leg
			// fired.
			kind: CouponDriftMissingReceipt,
			sql: `
SELECT c.id::text, '', c.code, '', '', '', '',
       'no receipt for code status ' || c.status, 'one append-only receipt per transition'
  FROM coupon_codes c
 WHERE c.tenant_id = $1::uuid
   AND c.pool_id = $2::uuid
   AND c.status IN ('reserved', 'assigned', 'redeemed')
   AND NOT EXISTS (
       SELECT 1 FROM coupon_entitlement_events e
        WHERE e.tenant_id = c.tenant_id
          AND e.code_id = c.id
          AND e.subject_kind = 'code'
          AND e.to_status = c.status
   )
 ORDER BY c.id
 LIMIT $3`,
		},
		{
			kind: CouponDriftSubscriberQuotaBreached,
			sql: `
SELECT '', '', '',
       COALESCE(max(a.subscriber_id::text), ''),
       max(a.subscriber_email),
       '',
       COALESCE(NULLIF(a.subscriber_id::text, ''), lower(a.subscriber_email)),
       count(*)::text || ' live codes',
       'at most ' || $4::int::text
  FROM coupon_assignments a
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.status IN ('reserved', 'assigned', 'redeemed')
   AND (a.subscriber_id IS NOT NULL OR a.subscriber_email <> '')
 GROUP BY COALESCE(NULLIF(a.subscriber_id::text, ''), lower(a.subscriber_email))
HAVING count(*) > $4::int
 ORDER BY count(*) DESC
 LIMIT $3`,
		},
		{
			kind: CouponDriftCampaignQuotaBreached,
			sql: `
SELECT '', '', '', '', '', '',
       COALESCE(a.campaign_id::text, NULLIF(a.context_key, '')),
       count(*)::text || ' live codes',
       'at most ' || $4::int::text
  FROM coupon_assignments a
 WHERE a.tenant_id = $1::uuid
   AND a.pool_id = $2::uuid
   AND a.status IN ('reserved', 'assigned', 'redeemed')
   AND COALESCE(a.campaign_id::text, NULLIF(a.context_key, '')) IS NOT NULL
 GROUP BY COALESCE(a.campaign_id::text, NULLIF(a.context_key, ''))
HAVING count(*) > $4::int
 ORDER BY count(*) DESC
 LIMIT $3`,
		},
	}

	for _, check := range checks {
		args := []any{tenantID, pool, maxReconciliationFindingsPerCheck}
		switch check.kind {
		case CouponDriftSubscriberQuotaBreached:
			args = append(args, out.MaxPerSubscriber)
		case CouponDriftCampaignQuotaBreached:
			args = append(args, out.MaxPerCampaign)
		default:
			args = append(args, check.args...)
		}
		found, err := collectCouponDrift(ctx, tx, check.kind, check.sql, args)
		if err != nil {
			return nil, err
		}
		if len(found) == maxReconciliationFindingsPerCheck {
			out.Truncated = true
		}
		out.Drift = append(out.Drift, found...)
	}

	out.DriftCount = len(out.Drift)
	out.Healthy = out.DriftCount == 0
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func collectCouponDrift(ctx context.Context, tx pgx.Tx, kind CouponDriftKind, query string, args []any) ([]CouponDrift, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("reconcile %s: %w", kind, err)
	}
	defer rows.Close()
	out := []CouponDrift{}
	for rows.Next() {
		item := CouponDrift{Kind: kind}
		if err := rows.Scan(&item.CodeID, &item.AssignmentID, &item.Code, &item.SubscriberID,
			&item.SubscriberEmail, &item.ContextKey, &item.ScopeKey,
			&item.Observed, &item.Expected); err != nil {
			return nil, fmt.Errorf("reconcile %s: %w", kind, err)
		}
		item.Detail = string(kind) + ": observed " + item.Observed + ", expected " + item.Expected
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reconcile %s: %w", kind, err)
	}
	return out, nil
}

// bindCouponTransitionContext labels every entitlement receipt written by the
// rest of this transaction. Transaction-local on purpose: the label must not
// ride a recycled pooled connection into an unrelated caller's writes.
func bindCouponTransitionContext(ctx context.Context, tx pgx.Tx, actor, reason string) error {
	if actor == "" {
		actor = "unattributed"
	}
	_, err := tx.Exec(ctx,
		`SELECT set_config('app.coupon_actor', $1, true),
		        set_config('app.coupon_transition_reason', $2, true)`,
		actor, reason)
	return err
}

// couponQuotaError maps migration 1970's quota SQLSTATEs onto
// ErrCouponQuotaExceeded so callers branch on a typed error rather than on
// message text. Any other error is returned unchanged — a database failure must
// not be laundered into "quota reached".
func couponQuotaError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case sqlStateSubscriberQuota, sqlStateCampaignQuota:
		return fmt.Errorf("%w: %s", ErrCouponQuotaExceeded, pgErr.Message)
	default:
		return err
	}
}
