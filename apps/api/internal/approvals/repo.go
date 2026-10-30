// SPDX-License-Identifier: AGPL-3.0-only
package approvals

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Repo wraps the pgx pool with approvals CRUD. All tenant-scoped reads/writes
// open a WithTenant tx so RLS fires.
type Repo struct {
	Pool *db.Pool

	// TransactionalWebhookFanout writes canonical outbound-webhook delivery
	// intents into the exact transaction that mutates the approval row. A
	// configured fanout is fail-closed: if intent creation fails, the approval
	// mutation is rolled back with it.
	TransactionalWebhookFanout TransactionalWebhookFanout

	// beginTenantTx is a hermetic-test seam. Production leaves it nil and uses
	// db.WithTenant so RLS is always scoped before either the approval or its
	// webhook intent is written.
	beginTenantTx func(context.Context, string) (pgx.Tx, error)
}

// TransactionalWebhookEvent is the approvals-owned boundary for durable
// customer webhook fanout. Keeping this contract here avoids coupling the
// domain package to outbound_webhooks while still requiring the caller's
// pgx transaction.
type TransactionalWebhookEvent struct {
	TenantID      string
	EventType     string
	SourceEventID string
	Body          map[string]any
	OccurredAt    time.Time
}

// TransactionalWebhookFanout persists matching customer delivery intents in
// the supplied business transaction. Network delivery happens later in the
// outbound webhook worker.
type TransactionalWebhookFanout interface {
	FanoutApprovalEvent(context.Context, pgx.Tx, TransactionalWebhookEvent) error
}

// Insert inserts a row and populates a.ID + RequestedAt + ExpiresAt with the
// row the database actually wrote. Also persists a.ContentHash so the
// consumption gate (D7) can detect post-approval edits, and
// a.RequestedByUserID so Service.Decide can enforce the two-person
// rule (audit HIGH F5).
func (r *Repo) Insert(ctx context.Context, a *Approval) error {
	tx, err := r.tenantTx(ctx, a.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO approvals (
    tenant_id, resource_type, resource_id,
    requested_by_actor_type, requested_by_actor_label,
    requested_by_api_key_id, requested_by_user_id,
    status, requested_at, expires_at, content_hash
)
VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id::text, requested_at, expires_at`,
		a.TenantID, a.ResourceType, a.ResourceID,
		nullable(a.RequestedByActorType), nullable(a.RequestedByActorLabel),
		uuidPtr(a.RequestedByAPIKeyID), uuidPtr(a.RequestedByUserID),
		string(a.Status), a.RequestedAt, a.ExpiresAt, nullable(a.ContentHash))
	if err := row.Scan(&a.ID, &a.RequestedAt, &a.ExpiresAt); err != nil {
		return err
	}
	if err := r.fanoutApprovalEvent(ctx, tx, approvalRequestedWebhookEvent(a)); err != nil {
		return fmt.Errorf("approvals: enqueue approval.requested webhook: %w", err)
	}
	return tx.Commit(ctx)
}

func (r *Repo) tenantTx(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if r.beginTenantTx != nil {
		return r.beginTenantTx(ctx, tenantID)
	}
	return db.WithTenant(ctx, r.Pool, tenantID)
}

func (r *Repo) fanoutApprovalEvent(ctx context.Context, tx pgx.Tx, event TransactionalWebhookEvent) error {
	if r.TransactionalWebhookFanout == nil {
		return nil
	}
	return r.TransactionalWebhookFanout.FanoutApprovalEvent(ctx, tx, event)
}

func approvalRequestedWebhookEvent(a *Approval) TransactionalWebhookEvent {
	body := map[string]any{
		"approval_id":   a.ID,
		"resource_type": a.ResourceType,
		"resource_id":   a.ResourceID,
		"status":        string(StatusPending),
		"requested_at": a.RequestedAt.UTC().
			Format(time.RFC3339Nano),
		"expires_at": a.ExpiresAt.UTC().Format(time.RFC3339Nano),
	}
	if requestedBy := strings.TrimSpace(a.RequestedByActorLabel); requestedBy != "" {
		body["requested_by"] = requestedBy
	}
	if actorType := strings.TrimSpace(a.RequestedByActorType); actorType != "" {
		body["requested_by_actor_type"] = actorType
	}
	return TransactionalWebhookEvent{
		TenantID:      a.TenantID,
		EventType:     "approval.requested",
		SourceEventID: "approval.requested:" + a.ID + ":" + string(StatusPending),
		Body:          body,
		OccurredAt:    a.RequestedAt,
	}
}

// MarkTokenConsumed records that the supplied raw token has been used
// for the supplied approval id. Returns ErrTokenAlreadyUsed when the
// (approval_id, sha256(token)) pair already exists in the ledger —
// that's the gate that closes audit CRITICAL F2 (a captured token
// could previously be replayed for the full 24h expiry window).
//
// Runs without a tenant tx because the public-decide path doesn't
// have a tenant context at insert time (the verifier runs pre-tenant)
// and the table carries no PII. The unique index on (approval_id,
// token_sha256) is what makes the gate race-safe — Postgres rejects
// the second concurrent click with 23505 / unique_violation before
// any approvals row is touched.
func (r *Repo) MarkTokenConsumed(ctx context.Context, approvalID, rawToken string) error {
	approvalID = strings.TrimSpace(approvalID)
	rawToken = strings.TrimSpace(rawToken)
	if approvalID == "" || rawToken == "" {
		return ErrBadToken
	}
	sum := sha256.Sum256([]byte(rawToken))
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	_, err = conn.Exec(ctx, `
INSERT INTO approval_token_consumption (approval_id, token_sha256)
VALUES ($1::uuid, $2)`,
		approvalID, sum[:])
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ErrTokenAlreadyUsed
		}
		return err
	}
	return nil
}

// MarkConsumed flips approvals.consumed_at to now() for an approval
// that has just had its side-effect fire (e.g. a campaign queue-fill
// after the approval was granted). Idempotent — re-calling on an
// already-consumed row is a no-op. Returns ErrNotFound if the row is
// missing.
func (r *Repo) MarkConsumed(ctx context.Context, tenantID, approvalID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE approvals
   SET consumed_at = COALESCE(consumed_at, now())
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, approvalID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// FingerprintAndConsumed reads only the (content_hash, consumed_at)
// pair for an approval — a narrow projection used by the consumption
// gate so it doesn't have to widen the existing scanRow code path.
// Returns ErrNotFound if the row doesn't exist.
func (r *Repo) FingerprintAndConsumed(ctx context.Context, tenantID, approvalID string) (string, *time.Time, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var hash *string
	var consumed *time.Time
	err = tx.QueryRow(ctx, `
SELECT content_hash, consumed_at FROM approvals
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, approvalID).Scan(&hash, &consumed)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", nil, ErrNotFound
		}
		return "", nil, err
	}
	out := ""
	if hash != nil {
		out = *hash
	}
	return out, consumed, nil
}

// Get loads a single row by id within the tenant.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Approval, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	a, err := scanOne(ctx, tx, `
SELECT id::text, tenant_id::text, resource_type, resource_id::text,
       coalesce(requested_by_actor_type,''),
       coalesce(requested_by_actor_label,''),
       requested_by_api_key_id::text, requested_by_user_id::text,
       status, requested_at, decided_at, decided_by_user_id::text,
       coalesce(notes,''), expires_at
FROM approvals
WHERE id::text = $1`, id)
	if err != nil {
		return nil, err
	}
	if cerr := tx.Commit(ctx); cerr != nil {
		return nil, cerr
	}
	return a, nil
}

// GetUnscoped resolves an approval id without a tenant context, used by the
// public one-click decide endpoint after HMAC verification. It binds the
// verified id into app.public_approval_id so RLS can expose only that row.
func (r *Repo) GetUnscoped(ctx context.Context, id string) (*Approval, error) {
	if id == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.public_approval_id', $1, true)`, id); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, resource_type, resource_id::text,
       coalesce(requested_by_actor_type,''),
       coalesce(requested_by_actor_label,''),
       requested_by_api_key_id::text, requested_by_user_id::text,
       status, requested_at, decided_at, decided_by_user_id::text,
       coalesce(notes,''), expires_at
FROM approvals
WHERE id::text = $1`, id)
	a, err := scanRow(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// List returns rows for a tenant filtered by status (empty = all), newest
// first.
func (r *Repo) List(ctx context.Context, tenantID, statusFilter string, limit int) ([]Approval, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rows pgx.Rows
	if statusFilter == "" {
		rows, err = tx.Query(ctx, `
SELECT id::text, tenant_id::text, resource_type, resource_id::text,
       coalesce(requested_by_actor_type,''),
       coalesce(requested_by_actor_label,''),
       requested_by_api_key_id::text, requested_by_user_id::text,
       status, requested_at, decided_at, decided_by_user_id::text,
       coalesce(notes,''), expires_at
FROM approvals
WHERE tenant_id = $1::uuid
ORDER BY requested_at DESC
LIMIT $2`, tenantID, limit)
	} else {
		rows, err = tx.Query(ctx, `
SELECT id::text, tenant_id::text, resource_type, resource_id::text,
       coalesce(requested_by_actor_type,''),
       coalesce(requested_by_actor_label,''),
       requested_by_api_key_id::text, requested_by_user_id::text,
       status, requested_at, decided_at, decided_by_user_id::text,
       coalesce(notes,''), expires_at
FROM approvals
WHERE tenant_id = $1::uuid AND status = $2
ORDER BY requested_at DESC
LIMIT $3`, tenantID, statusFilter, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Approval{}
	for rows.Next() {
		a, err := scanFromRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// LatestForResource returns the newest approval row for a resource inside a
// tenant. Send gates use this to avoid creating duplicate pending approvals
// when a caller retries after receiving approval_required.
func (r *Repo) LatestForResource(ctx context.Context, tenantID string, resourceType ResourceType, resourceID string) (*Approval, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	a, err := scanOne(ctx, tx, `
SELECT id::text, tenant_id::text, resource_type, resource_id::text,
       coalesce(requested_by_actor_type,''),
       coalesce(requested_by_actor_label,''),
       requested_by_api_key_id::text, requested_by_user_id::text,
       status, requested_at, decided_at, decided_by_user_id::text,
       coalesce(notes,''), expires_at
FROM approvals
WHERE tenant_id = $1::uuid
  AND resource_type = $2
  AND resource_id::text = $3
ORDER BY requested_at DESC
LIMIT 1`, tenantID, string(resourceType), resourceID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// UpdateStatus flips pending → target (approved | rejected | expired). For
// the public one-click path tenantID may be empty; that path binds the exact
// approval id into app.public_approval_id so RLS still pins the update.
func (r *Repo) UpdateStatus(ctx context.Context, tenantID, id string, status Status, userID, notes string, now time.Time) error {
	if tenantID == "" {
		tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.public_approval_id', $1, true)`, id); err != nil {
			return err
		}
		event, err := r.updateStatusInTx(ctx, tx, id, status, userID, notes, now)
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			// Distinguish "row doesn't exist" from "row exists but
			// is no longer pending" (race-loser / replay). Audit
			// (approvals HIGH F3): the prior code conflated both as
			// ErrNotFound → 404, misleading the second clicker.
			var exists bool
			_ = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM approvals WHERE id::text = $1)`, id).Scan(&exists)
			if exists {
				return ErrNotPending
			}
			return ErrNotFound
		}
		if event.EventType != "" {
			// The public one-click route initially scopes RLS to the exact
			// approval id. Once that row has yielded its tenant, bind tenant
			// scope in the same transaction so canonical webhook destinations
			// are visible without widening the public lookup window.
			if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, event.TenantID); err != nil {
				return err
			}
			if err := r.fanoutApprovalEvent(ctx, tx, event); err != nil {
				return fmt.Errorf("approvals: enqueue approval.decided webhook: %w", err)
			}
		}
		return tx.Commit(ctx)
	}
	tx, err := r.tenantTx(ctx, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	event, err := r.updateStatusInTx(ctx, tx, id, status, userID, notes, now)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if event.EventType != "" {
		if err := r.fanoutApprovalEvent(ctx, tx, event); err != nil {
			return fmt.Errorf("approvals: enqueue approval.decided webhook: %w", err)
		}
	}
	return tx.Commit(ctx)
}

func (r *Repo) updateStatusInTx(
	ctx context.Context,
	tx pgx.Tx,
	id string,
	status Status,
	userID, notes string,
	now time.Time,
) (TransactionalWebhookEvent, error) {
	var eventTenantID, resourceType, resourceID string
	err := tx.QueryRow(ctx, `
UPDATE approvals SET status = $1, decided_at = $2,
    decided_by_user_id = NULLIF($3,'')::uuid,
    notes = NULLIF($4,'')
WHERE id::text = $5 AND status = 'pending'
RETURNING tenant_id::text, resource_type, resource_id::text`,
		string(status), now, userID, notes, id).
		Scan(&eventTenantID, &resourceType, &resourceID)
	if err != nil {
		return TransactionalWebhookEvent{}, err
	}
	event := approvalDecidedWebhookEvent(
		eventTenantID,
		id,
		resourceType,
		resourceID,
		status,
		userID,
		now,
	)
	return event, nil
}

func approvalDecidedWebhookEvent(
	tenantID, approvalID, resourceType, resourceID string,
	status Status,
	userID string,
	decidedAt time.Time,
) TransactionalWebhookEvent {
	if status != StatusApproved && status != StatusRejected {
		return TransactionalWebhookEvent{}
	}
	body := map[string]any{
		"approval_id":   approvalID,
		"resource_type": resourceType,
		"resource_id":   resourceID,
		"decision":      string(status),
		"status":        string(status),
		"decided_at":    decidedAt.UTC().Format(time.RFC3339Nano),
	}
	if decidedBy := strings.TrimSpace(userID); decidedBy != "" {
		body["decided_by"] = decidedBy
	}
	return TransactionalWebhookEvent{
		TenantID:      tenantID,
		EventType:     "approval.decided",
		SourceEventID: "approval.decided:" + approvalID + ":" + string(status),
		Body:          body,
		OccurredAt:    decidedAt,
	}
}

// SweepExpired marks all pending rows past their expires_at as expired in a
// single tenant-agnostic query (the row itself carries the tenant id).
// Returns the count + (tenant_id, approval_id) pairs for each row
// expired this sweep so the service layer can emit per-row
// `approval.expired` events. Audit (approvals HIGH F4): prior code
// returned only the count; downstream automation + outbound-webhook
// subscribers never learned about expiry.
func (r *Repo) SweepExpired(ctx context.Context, now time.Time) (int, []ExpiredRow, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.approvals_expiry_sweep', '1', true)`); err != nil {
		return 0, nil, err
	}
	rows, err := tx.Query(ctx, `
UPDATE approvals SET status = 'expired', decided_at = $1
WHERE status = 'pending' AND expires_at < $1
RETURNING tenant_id::text, id::text`, now)
	if err != nil {
		return 0, nil, err
	}
	var expired []ExpiredRow
	for rows.Next() {
		var r ExpiredRow
		if err := rows.Scan(&r.TenantID, &r.ID); err != nil {
			rows.Close()
			return 0, nil, err
		}
		expired = append(expired, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, nil, err
	}
	return len(expired), expired, nil
}

// ExpiredRow is the per-row payload SweepExpired returns. Lets the
// service emit `approval.expired` events for each row.
type ExpiredRow struct {
	TenantID string
	ID       string
}

// LookupTenantApprovalNotifyEmail returns the tenant's notify email, or "".
// Used by the notifier; runs without a tenant tx because it reads tenants
// directly (which has a permissive SELECT policy from 0001).
func (r *Repo) LookupTenantApprovalNotifyEmail(ctx context.Context, tenantID string) (string, error) {
	conn, err := r.Pool.Acquire(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Release()
	var email *string
	err = conn.QueryRow(ctx, `SELECT approval_notify_email FROM tenants WHERE id::text = $1`, tenantID).Scan(&email)
	if err != nil {
		return "", err
	}
	if email == nil {
		return "", nil
	}
	return *email, nil
}

// --- helpers ---

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func uuidPtr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

func scanOne(ctx context.Context, tx pgx.Tx, q string, args ...any) (*Approval, error) {
	row := tx.QueryRow(ctx, q, args...)
	return scanRow(row)
}

func scanRow(row pgx.Row) (*Approval, error) {
	a := &Approval{}
	var apiKeyID, requestedBy, decidedBy *string
	var status string
	if err := row.Scan(
		&a.ID, &a.TenantID, &a.ResourceType, &a.ResourceID,
		&a.RequestedByActorType, &a.RequestedByActorLabel,
		&apiKeyID, &requestedBy, &status, &a.RequestedAt, &a.DecidedAt,
		&decidedBy, &a.Notes, &a.ExpiresAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if apiKeyID != nil && *apiKeyID != "" {
		a.RequestedByAPIKeyID = apiKeyID
	}
	if requestedBy != nil && *requestedBy != "" {
		a.RequestedByUserID = requestedBy
	}
	if decidedBy != nil && *decidedBy != "" {
		a.DecidedByUserID = decidedBy
	}
	a.Status = Status(status)
	return a, nil
}

func scanFromRows(rows pgx.Rows) (*Approval, error) {
	a := &Approval{}
	var apiKeyID, requestedBy, decidedBy *string
	var status string
	if err := rows.Scan(
		&a.ID, &a.TenantID, &a.ResourceType, &a.ResourceID,
		&a.RequestedByActorType, &a.RequestedByActorLabel,
		&apiKeyID, &requestedBy, &status, &a.RequestedAt, &a.DecidedAt,
		&decidedBy, &a.Notes, &a.ExpiresAt,
	); err != nil {
		return nil, err
	}
	if apiKeyID != nil && *apiKeyID != "" {
		a.RequestedByAPIKeyID = apiKeyID
	}
	if requestedBy != nil && *requestedBy != "" {
		a.RequestedByUserID = requestedBy
	}
	if decidedBy != nil && *decidedBy != "" {
		a.DecidedByUserID = decidedBy
	}
	a.Status = Status(status)
	return a, nil
}
