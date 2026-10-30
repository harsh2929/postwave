// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const webauthnSelectCols = `id::text, user_id::text, tenant_id::text, credential_id, public_key,
       sign_count, aaguid, transports, backup_eligible, backup_state, name, created_at, last_used_at`

func scanWebauthnCredential(row pgx.Row) (*WebauthnCredential, error) {
	var c WebauthnCredential
	if err := row.Scan(&c.ID, &c.UserID, &c.TenantID, &c.CredentialID, &c.PublicKey,
		&c.SignCount, &c.AAGUID, &c.Transports, &c.BackupEligible, &c.BackupState,
		&c.Name, &c.CreatedAt, &c.LastUsedAt); err != nil {
		return nil, err
	}
	return &c, nil
}

// StoreWebauthnCredential persists a newly-registered passkey, tenant-scoped.
func (r *Repo) StoreWebauthnCredential(ctx context.Context, tenantID string, c WebauthnCredential) (*WebauthnCredential, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO webauthn_credentials
    (tenant_id, user_id, credential_id, public_key, sign_count, aaguid,
     transports, backup_eligible, backup_state, name)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING `+webauthnSelectCols,
		tenantID, c.UserID, c.CredentialID, c.PublicKey, c.SignCount, c.AAGUID,
		c.Transports, c.BackupEligible, c.BackupState, c.Name)
	out, err := scanWebauthnCredential(row)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrCredentialExists
		}
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListWebauthnCredentials returns a user's passkeys for management, newest-first.
func (r *Repo) ListWebauthnCredentials(ctx context.Context, tenantID, userID string) ([]WebauthnCredential, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT `+webauthnSelectCols+`
  FROM webauthn_credentials WHERE tenant_id = $1::uuid AND user_id = $2::uuid
 ORDER BY created_at DESC`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WebauthnCredential{}
	for rows.Next() {
		c, err := scanWebauthnCredential(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// WebauthnCredentialByRawID resolves a credential by its raw credential id
// BEFORE any session/tenant context (discoverable login). Runs under the auth
// resolver GUC. ErrNotFound when unknown.
func (r *Repo) WebauthnCredentialByRawID(ctx context.Context, rawID []byte) (*WebauthnCredential, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	c, err := scanWebauthnCredential(tx.QueryRow(ctx,
		`SELECT `+webauthnSelectCols+` FROM webauthn_credentials WHERE credential_id = $1`, rawID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, tx.Commit(ctx)
}

// WebauthnCredentialsForUserResolver reads all of a user's passkeys under the
// resolver GUC (pre-session), so the discoverable-login user adapter can offer
// the library the full credential set to verify the assertion against.
func (r *Repo) WebauthnCredentialsForUserResolver(ctx context.Context, userID string) ([]WebauthnCredential, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT `+webauthnSelectCols+`
  FROM webauthn_credentials WHERE user_id = $1::uuid`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WebauthnCredential{}
	for rows.Next() {
		c, err := scanWebauthnCredential(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UserByIDResolver resolves a user (with tenant name/slug/email) by id under the
// resolver GUC — used by discoverable login to build the session after the
// assertion verifies. ErrNotFound when unknown.
func (r *Repo) UserByIDResolver(ctx context.Context, userID string) (*User, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var u User
	err = tx.QueryRow(ctx, `
SELECT u.id::text, u.tenant_id::text, t.name, t.slug,
       u.email, u.role, u.auth_provider, u.email_verified_at, u.status
  FROM users u JOIN tenants t ON t.id = u.tenant_id
 WHERE u.id = $1::uuid`, userID).Scan(
		&u.ID, &u.TenantID, &u.TenantName, &u.TenantSlug, &u.Email, &u.Role,
		&u.AuthProvider, &u.EmailVerifiedAt, &u.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, tx.Commit(ctx)
}

// UpdateWebauthnSignCount records the post-assertion signature counter +
// last-used time, tenant-scoped (the tenant is known once the credential
// resolved).
func (r *Repo) UpdateWebauthnSignCount(ctx context.Context, tenantID string, rawID []byte, signCount int64) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE webauthn_credentials SET sign_count = $2, last_used_at = now()
          WHERE tenant_id = $1::uuid AND credential_id = $3`,
		tenantID, signCount, rawID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RenameWebauthnCredential relabels a passkey. Returns false (no error) when the
// id isn't the user's.
func (r *Repo) RenameWebauthnCredential(ctx context.Context, tenantID, userID, id, name string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`UPDATE webauthn_credentials SET name = $4
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id::text = $3`,
		tenantID, userID, id, name)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, tx.Commit(ctx)
	}
	return true, tx.Commit(ctx)
}

// DeleteWebauthnCredential removes a passkey. Returns false when not the user's.
func (r *Repo) DeleteWebauthnCredential(ctx context.Context, tenantID, userID, id string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM webauthn_credentials
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND id::text = $3`,
		tenantID, userID, id)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, tx.Commit(ctx)
	}
	return true, tx.Commit(ctx)
}

// StoreWebauthnChallenge records a begun ceremony nonce so finish can enforce
// single-use (replay defense). The table carries no tenant data — only opaque
// hashes — so it needs no tenant/RLS scope and runs directly on the pool. Each
// call also opportunistically GCs expired nonces to keep the table bounded.
func (r *Repo) StoreWebauthnChallenge(ctx context.Context, hash []byte, purpose string, expiresAt time.Time) error {
	_, _ = r.Pool.Exec(ctx, `DELETE FROM webauthn_challenges WHERE expires_at < now()`)
	_, err := r.Pool.Exec(ctx,
		`INSERT INTO webauthn_challenges (challenge_hash, purpose, expires_at)
		 VALUES ($1, $2, $3) ON CONFLICT (challenge_hash) DO NOTHING`,
		hash, purpose, expiresAt)
	return err
}

// ConsumeWebauthnChallenge atomically deletes the nonce, returning true only if
// it was present AND unexpired — i.e. this is its first valid use. A replayed,
// expired, or forged challenge returns false, which the caller rejects.
func (r *Repo) ConsumeWebauthnChallenge(ctx context.Context, hash []byte, purpose string, now time.Time) (bool, error) {
	tag, err := r.Pool.Exec(ctx,
		`DELETE FROM webauthn_challenges
		  WHERE challenge_hash = $1 AND purpose = $2 AND expires_at > $3`,
		hash, purpose, now)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ErrCredentialExists is returned when a passkey with the same credential id is
// already registered (the UNIQUE constraint fired).
var ErrCredentialExists = errors.New("auth: webauthn credential already registered")
