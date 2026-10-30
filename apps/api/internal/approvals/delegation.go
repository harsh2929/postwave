// SPDX-License-Identifier: AGPL-3.0-only
//
// delegation.go — A/B's "Bob covers Alice while she's on PTO."
//
// Pairs with the two-person rule (migration 0173): self-approval is
// normally refused, but a delegation row whose (from_user_id =
// requester, to_user_id = decider) is active at decide-time
// suppresses ErrSelfApproval. The decider's role check still runs;
// delegation only widens the "who can decide" set.

package approvals

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Delegation mirrors an approval_delegations row.
type Delegation struct {
	ID            string     `json:"id"`
	TenantID      string     `json:"tenantId"`
	FromUserID    string     `json:"fromUserId"`
	ToUserID      string     `json:"toUserId"`
	StartsAt      time.Time  `json:"startsAt"`
	EndsAt        *time.Time `json:"endsAt,omitempty"`
	Reason        string     `json:"reason,omitempty"`
	CreatedByUser string     `json:"createdByUserId,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	RevokedAt     *time.Time `json:"revokedAt,omitempty"`
}

// DelegationLookup is the narrow interface Service.Decide uses to
// check "is decider currently covering requester?". main.go wires
// this with a *Repo-backed implementation; tests pass a fake.
type DelegationLookup interface {
	IsActive(ctx context.Context, tenantID, fromUserID, toUserID string) (bool, error)
}

// HasActiveDelegation queries approval_delegations for an active row
// covering (fromUserID → toUserID) at now(). Returns (true, nil) when
// such a row exists, (false, nil) otherwise.
func (r *Repo) IsActive(ctx context.Context, tenantID, fromUserID, toUserID string) (bool, error) {
	if tenantID == "" || fromUserID == "" || toUserID == "" {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS(
  SELECT 1 FROM approval_delegations
   WHERE tenant_id = $1::uuid
     AND from_user_id = $2::uuid
     AND to_user_id   = $3::uuid
     AND revoked_at IS NULL
     AND starts_at <= now()
     AND (ends_at IS NULL OR ends_at > now())
)`, tenantID, fromUserID, toUserID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

// ListDelegations returns every delegation row for a tenant ordered
// by created_at DESC. Used by the settings UI.
func (r *Repo) ListDelegations(ctx context.Context, tenantID string) ([]Delegation, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, from_user_id::text, to_user_id::text,
       starts_at, ends_at, reason,
       COALESCE(created_by_user_id::text, ''), created_at, revoked_at
  FROM approval_delegations
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Delegation{}
	for rows.Next() {
		var d Delegation
		if err := rows.Scan(&d.ID, &d.TenantID, &d.FromUserID, &d.ToUserID,
			&d.StartsAt, &d.EndsAt, &d.Reason, &d.CreatedByUser, &d.CreatedAt, &d.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ErrInvalidInput marks a caller mistake rather than a server failure.
//
// Without it a handler cannot tell "you sent an empty body" from "the database
// is down", so every rejection here surfaced as a 500: the client could not
// show the operator what to fix, and the error budget counted user typos as
// outages. Follows the convention already in internal/audiences.
var ErrInvalidInput = errors.New("approvals: invalid input")

// CreateDelegation inserts a new approval_delegations row. Validates
// from ≠ to (DB constraint also covers); ends_at, when set, must be
// in the future.
func (r *Repo) CreateDelegation(ctx context.Context, d Delegation) (Delegation, error) {
	if d.TenantID == "" || d.FromUserID == "" || d.ToUserID == "" {
		return Delegation{}, fmt.Errorf("%w: tenant + from + to required", ErrInvalidInput)
	}
	if d.FromUserID == d.ToUserID {
		return Delegation{}, fmt.Errorf("%w: cannot delegate to self", ErrInvalidInput)
	}
	if d.EndsAt != nil && d.EndsAt.Before(time.Now()) {
		return Delegation{}, fmt.Errorf("%w: ends_at must be in the future", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, d.TenantID)
	if err != nil {
		return Delegation{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var createdBy any
	if d.CreatedByUser != "" {
		createdBy = d.CreatedByUser
	}
	row := tx.QueryRow(ctx, `
INSERT INTO approval_delegations (tenant_id, from_user_id, to_user_id, starts_at, ends_at, reason, created_by_user_id)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, NULLIF($7,'')::uuid)
RETURNING id::text, created_at`,
		d.TenantID, d.FromUserID, d.ToUserID, d.StartsAt, d.EndsAt, d.Reason, createdBy)
	if err := row.Scan(&d.ID, &d.CreatedAt); err != nil {
		return Delegation{}, err
	}
	return d, tx.Commit(ctx)
}

// RevokeDelegation stamps revoked_at on a delegation row. Idempotent.
func (r *Repo) RevokeDelegation(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE approval_delegations
   SET revoked_at = COALESCE(revoked_at, now())
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// EscalationPolicy mirrors approval_escalation_policies (one row per
// tenant).
type EscalationPolicy struct {
	TenantID           string `json:"tenantId"`
	EscalateAfterHours *int   `json:"escalateAfterHours,omitempty"`
	NotifyOwners       bool   `json:"notifyOwners"`
}

// GetEscalationPolicy returns the per-tenant policy or the zero
// value (escalation disabled) when no row exists.
func (r *Repo) GetEscalationPolicy(ctx context.Context, tenantID string) (EscalationPolicy, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return EscalationPolicy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var p EscalationPolicy
	p.TenantID = tenantID
	p.NotifyOwners = true
	err = tx.QueryRow(ctx, `
SELECT escalate_after_hours, notify_owners
  FROM approval_escalation_policies
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&p.EscalateAfterHours, &p.NotifyOwners)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return EscalationPolicy{}, err
	}
	return p, tx.Commit(ctx)
}

// UpsertEscalationPolicy writes the per-tenant escalation policy.
// escalateAfterHours = nil disables escalation entirely (the default).
func (r *Repo) UpsertEscalationPolicy(ctx context.Context, p EscalationPolicy, updatedByUserID string) error {
	if p.TenantID == "" {
		return errors.New("approvals: tenant required")
	}
	if p.EscalateAfterHours != nil && (*p.EscalateAfterHours < 1 || *p.EscalateAfterHours > 24*30) {
		return errors.New("approvals: escalate_after_hours must be 1..720")
	}
	tx, err := db.WithTenant(ctx, r.Pool, p.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var updatedBy any
	if updatedByUserID != "" {
		updatedBy = updatedByUserID
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO approval_escalation_policies (tenant_id, escalate_after_hours, notify_owners, updated_at, updated_by_user_id)
VALUES ($1::uuid, $2, $3, now(), NULLIF($4,'')::uuid)
ON CONFLICT (tenant_id)
DO UPDATE SET escalate_after_hours = EXCLUDED.escalate_after_hours,
              notify_owners        = EXCLUDED.notify_owners,
              updated_at           = now(),
              updated_by_user_id   = EXCLUDED.updated_by_user_id`,
		p.TenantID, p.EscalateAfterHours, p.NotifyOwners, updatedBy); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Compile-time guard — kept the pgx import live for symmetry with
// other repo files even though this one doesn't use it directly.
var _ = pgx.ErrNoRows
