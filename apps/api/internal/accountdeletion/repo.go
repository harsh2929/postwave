// SPDX-License-Identifier: AGPL-3.0-only
package accountdeletion

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type Repo struct {
	Pool *db.Pool
}

func (r *Repo) Create(ctx context.Context, p CreateParams) (Request, bool, error) {
	if r == nil || r.Pool == nil {
		return Request{}, false, fmt.Errorf("account deletion repository is not configured")
	}
	tx, txErr := db.WithTenant(ctx, r.Pool, p.TenantID)
	if txErr != nil {
		return Request{}, false, txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if existing, operationErr := findActive(ctx, tx, p.TenantID, p.UserID); operationErr == nil {
		if err := tx.Commit(ctx); err != nil {
			return Request{}, false, err
		}
		return existing, true, nil
	} else if !errors.Is(operationErr, pgx.ErrNoRows) {
		return Request{}, false, operationErr
	}

	var role string
	if err := tx.QueryRow(ctx, `
SELECT role
  FROM users
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 FOR UPDATE`, p.TenantID, p.UserID).Scan(&role); errors.Is(err, pgx.ErrNoRows) {
		return Request{}, false, ErrActorNotFound
	} else if err != nil {
		return Request{}, false, err
	}
	otherOwners := 0
	if role == "owner" {
		if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM users
 WHERE tenant_id = $1::uuid AND role = 'owner' AND id <> $2::uuid`,
			p.TenantID, p.UserID).Scan(&otherOwners); err != nil {
			return Request{}, false, err
		}
		if isLastOwner(role, otherOwners) {
			return Request{}, false, ErrLastOwner
		}
	}

	id, txErr := newID()
	if txErr != nil {
		return Request{}, false, txErr
	}
	_, txErr = tx.Exec(ctx, `
INSERT INTO privacy_requests (
    id, tenant_id, request_type, region, status, requester_user_id,
    requester_email, subject_type, subject_user_id, subject_email,
    requested_at, due_at, verified_at, verified_method,
    reauthentication_method, execute_after, retention_expires_at,
    idempotency_key_hash, notes, fulfillment, updated_at
) VALUES (
    $1, $2::uuid, 'account_deletion', $3, 'queued', $4::uuid,
    NULL, 'account_user', $4::uuid, NULL,
    $5, $6, $5, 'session', $7, $8, $9, $10, NULL,
    '{"scope":"authenticated_user_only","workspace_content_deleted":false}'::jsonb, $5
)
ON CONFLICT DO NOTHING`,
		id, p.TenantID, p.Region, p.UserID, p.Now, p.DueAt, p.ReauthMethod,
		p.ExecuteAfter, p.RetentionExpires, nullableBytes(p.IdempotencyDigest),
	)
	if txErr != nil {
		return Request{}, false, txErr
	}
	created, txErr := findActive(ctx, tx, p.TenantID, p.UserID)
	if txErr != nil {
		return Request{}, false, txErr
	}
	replayed := created.ID != id
	if err := tx.Commit(ctx); err != nil {
		return Request{}, false, err
	}
	return created, replayed, nil
}

func (r *Repo) Status(ctx context.Context, tenantID, userID string) (*Request, error) {
	if r == nil || r.Pool == nil {
		return nil, fmt.Errorf("account deletion repository is not configured")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out Request
	err = tx.QueryRow(ctx, requestProjection+`
 WHERE tenant_id = $1::uuid
   AND subject_type = 'account_user'
   AND subject_user_id = $2::uuid
 ORDER BY requested_at DESC
 LIMIT 1`, tenantID, userID).Scan(requestScan(&out)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

const requestProjection = `
SELECT id, status, requested_at,
       COALESCE(execute_after, requested_at), due_at, completed_at,
       legal_hold, COALESCE(retention_expires_at, due_at)`

func findActive(ctx context.Context, tx pgx.Tx, tenantID, userID string) (Request, error) {
	var out Request
	err := tx.QueryRow(ctx, requestProjection+`
 WHERE tenant_id = $1::uuid
   AND subject_type = 'account_user'
   AND subject_user_id = $2::uuid
   AND status IN ('queued','verifying','in_progress','blocked_legal_hold','blocked_ownership')
 ORDER BY requested_at DESC
 LIMIT 1`, tenantID, userID).Scan(requestScan(&out)...)
	return out, err
}

func requestScan(out *Request) []any {
	return []any{&out.ID, &out.Status, &out.RequestedAt, &out.ExecuteAfter, &out.DueAt,
		&out.CompletedAt, &out.LegalHold, &out.RetentionExpiresAt}
}

func nullableBytes(v []byte) any {
	if len(v) == 0 {
		return nil
	}
	return v
}

func newID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("account deletion request id: %w", err)
	}
	return "prv-self-account-deletion_" + hex.EncodeToString(b[:]), nil
}
