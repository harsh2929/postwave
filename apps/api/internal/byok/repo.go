// SPDX-License-Identifier: AGPL-3.0-only
//
// Package byok wires per-tenant KEK rows (tenant_keys table) to the
// packages/kms provider registry. The cipher layer (apps/api/internal/crypto)
// consults TenantCipher.EncryptForTenant / DecryptForTenant; this package
// hydrates the active KEK + dispatches the wrap/unwrap call.
package byok

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	pwkms "github.com/postwave/postwave/packages/kms"
)

// Repo is the pgx-backed tenant_keys store.
type Repo struct {
	Pool *db.Pool
}

// ErrNotFound is returned when no matching row exists.
var ErrNotFound = errors.New("byok: tenant key not found")

// ErrNoActiveKey is returned by GetActive when the tenant has no key in
// status='active'. Callers should fall back to platform encryption (or
// surface "BYOK not configured for this tenant" to the operator).
var ErrNoActiveKey = errors.New("byok: tenant has no active key")

// ErrAlreadyActive surfaces a race in Activate: another caller already
// flipped a row to active for this tenant.
var ErrAlreadyActive = errors.New("byok: tenant already has an active key")

// Key mirrors a tenant_keys row.
type Key struct {
	ID                 string
	TenantID           string
	Provider           string
	KeyRef             string
	Status             pwkms.TenantKeyStatus
	Description        string
	CreatedByUserID    string
	CreatedAt          time.Time
	ActivatedAt        *time.Time
	RotatedAt          *time.Time
	DeletedAt          *time.Time
	LastHealthCheckAt  *time.Time
	LastHealthCheckOK  *bool
	LastHealthCheckErr string
}

// CreateInput is the payload for Create.
type CreateInput struct {
	Provider        string
	KeyRef          string
	Description     string
	CreatedByUserID string
}

// Create inserts a new key in status='inactive'. Callers must call
// Activate to make it the tenant's active KEK (which atomically flips
// any existing active row to inactive).
func (r *Repo) Create(ctx context.Context, tenantID string, in CreateInput) (*Key, error) {
	if !pwkms.IsValidProvider(in.Provider) {
		return nil, fmt.Errorf("invalid provider %q", in.Provider)
	}
	if in.KeyRef == "" {
		return nil, errors.New("key_ref required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var creator any
	if in.CreatedByUserID != "" {
		creator = in.CreatedByUserID
	}

	row := tx.QueryRow(ctx, `
INSERT INTO tenant_keys (tenant_id, provider, key_ref, status, description, created_by_user_id)
VALUES ($1::uuid, $2, $3, 'inactive', $4, $5::uuid)
RETURNING id::text, tenant_id::text, provider, key_ref, status, description,
          COALESCE(created_by_user_id::text,''), created_at, activated_at,
          rotated_at, deleted_at, last_health_check_at, last_health_check_ok,
          COALESCE(last_health_check_err,'')`,
		tenantID, in.Provider, in.KeyRef, in.Description, creator)
	k, err := scanKey(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// List returns all keys for a tenant ordered by created_at DESC.
func (r *Repo) List(ctx context.Context, tenantID string) ([]Key, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, provider, key_ref, status, description,
       COALESCE(created_by_user_id::text,''), created_at, activated_at,
       rotated_at, deleted_at, last_health_check_at, last_health_check_ok,
       COALESCE(last_health_check_err,'')
  FROM tenant_keys
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Key{}
	for rows.Next() {
		k, err := scanKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *k)
	}
	return out, rows.Err()
}

// Get fetches a single key by id.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*Key, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, key_ref, status, description,
       COALESCE(created_by_user_id::text,''), created_at, activated_at,
       rotated_at, deleted_at, last_health_check_at, last_health_check_ok,
       COALESCE(last_health_check_err,'')
  FROM tenant_keys
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	k, err := scanKey(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return k, nil
}

// GetActive returns the tenant's currently-active KEK or ErrNoActiveKey.
//
// This is the hot-path call: every Encrypt operation that needs the
// tenant's KEK consults GetActive. The query is a single row read with
// the partial unique index doing the heavy lifting.
func (r *Repo) GetActive(ctx context.Context, tenantID string) (*Key, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, provider, key_ref, status, description,
       COALESCE(created_by_user_id::text,''), created_at, activated_at,
       rotated_at, deleted_at, last_health_check_at, last_health_check_ok,
       COALESCE(last_health_check_err,'')
  FROM tenant_keys
 WHERE tenant_id = $1::uuid AND status = 'active'
 LIMIT 1`, tenantID)
	k, err := scanKey(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNoActiveKey
	}
	if err != nil {
		return nil, err
	}
	return k, nil
}

// Activate flips a key to status='active' atomically. Any previously-
// active key for the same tenant is moved to 'inactive' and stamped
// with rotated_at. Returns the activated key.
//
// Atomicity is essential: two concurrent Activate calls must not both
// succeed or the partial unique index will fire and one of them will
// roll back cleanly.
func (r *Repo) Activate(ctx context.Context, tenantID, id string) (*Key, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Step 1: demote any currently-active key.
	_, err = tx.Exec(ctx, `
UPDATE tenant_keys
   SET status = 'inactive', rotated_at = now()
 WHERE tenant_id = $1::uuid AND status = 'active' AND id::text <> $2`,
		tenantID, id)
	if err != nil {
		return nil, err
	}

	// Step 2: promote the target.
	row := tx.QueryRow(ctx, `
UPDATE tenant_keys
   SET status = 'active', activated_at = COALESCE(activated_at, now())
 WHERE tenant_id = $1::uuid AND id::text = $2 AND status <> 'deleted'
RETURNING id::text, tenant_id::text, provider, key_ref, status, description,
          COALESCE(created_by_user_id::text,''), created_at, activated_at,
          rotated_at, deleted_at, last_health_check_at, last_health_check_ok,
          COALESCE(last_health_check_err,'')`,
		tenantID, id)
	k, err := scanKey(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// MarkDeleted soft-deletes a key. It must not be the active one — caller
// should activate a replacement first.
func (r *Repo) MarkDeleted(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE tenant_keys
   SET status = 'deleted', deleted_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND status <> 'active'`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// Could be: doesn't exist, OR is still active. Distinguish.
		var status string
		row := tx.QueryRow(ctx, `SELECT status FROM tenant_keys WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
		if err := row.Scan(&status); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("byok: cannot delete %s key (deactivate first)", status)
	}
	return tx.Commit(ctx)
}

// RecordHealthCheck stamps the result of the last HealthCheck call so
// the admin UI can render a "last verified ✓ 2m ago" badge.
func (r *Repo) RecordHealthCheck(ctx context.Context, tenantID, id string, ok bool, errMsg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE tenant_keys
   SET last_health_check_at  = now(),
       last_health_check_ok  = $3,
       last_health_check_err = NULLIF($4, '')
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id, ok, errMsg)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// --- internals ---

type scanner interface {
	Scan(dst ...any) error
}

func scanKey(s scanner) (*Key, error) {
	var k Key
	var status string
	var activatedAt, rotatedAt, deletedAt, lastCheck *time.Time
	var lastOK *bool
	if err := s.Scan(
		&k.ID, &k.TenantID, &k.Provider, &k.KeyRef, &status, &k.Description,
		&k.CreatedByUserID, &k.CreatedAt, &activatedAt,
		&rotatedAt, &deletedAt, &lastCheck, &lastOK, &k.LastHealthCheckErr,
	); err != nil {
		return nil, err
	}
	k.Status = pwkms.TenantKeyStatus(status)
	k.ActivatedAt = activatedAt
	k.RotatedAt = rotatedAt
	k.DeletedAt = deletedAt
	k.LastHealthCheckAt = lastCheck
	k.LastHealthCheckOK = lastOK
	return &k, nil
}
