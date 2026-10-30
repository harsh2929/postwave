// SPDX-License-Identifier: AGPL-3.0-only
//
// SETC-021 — reading and unlinking a user's own IdP (social) identities.
// These run under the tenant-context RLS path (auth_idp_links.tenant_visible,
// which walks user_id -> users.tenant_id against app.tenant_id), NOT the
// pre-tenant resolver path used by login.
package auth

import (
	"context"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// IdPLink is one linked social identity, from the account owner's point of view.
type IdPLink struct {
	Provider string    `json:"provider"`
	Email    string    `json:"email"`
	LinkedAt time.Time `json:"linked_at"`
}

// ErrLastLoginMethod means an unlink was refused because it would leave the
// account with no way to sign in (no password AND no other IdP link).
var ErrLastLoginMethod = errors.New("auth: cannot unlink the only remaining login method")

// ListIdPLinks returns the tenant-user's linked IdP identities, newest first.
func (r *Repo) ListIdPLinks(ctx context.Context, tenantID, userID string) ([]IdPLink, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT provider, email::text, linked_at
  FROM auth_idp_links
 WHERE user_id = $1::uuid
 ORDER BY linked_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IdPLink{}
	for rows.Next() {
		var l IdPLink
		if err := rows.Scan(&l.Provider, &l.Email, &l.LinkedAt); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UserHasPassword reports whether the user has a password credential — one of
// the login methods the lockout guard counts.
func (r *Repo) UserHasPassword(ctx context.Context, tenantID, userID string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM auth_credentials WHERE user_id = $1::uuid)`,
		userID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

// UserHasPasskey reports whether the user has an enrolled WebAuthn passkey —
// also a standing login method the lockout guard must count, or a passkey-only
// user is wrongly told to "set a password" before unlinking.
func (r *Repo) UserHasPasskey(ctx context.Context, tenantID, userID string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM webauthn_credentials WHERE user_id = $1::uuid)`,
		userID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, tx.Commit(ctx)
}

// UnlinkIdP removes the user's link(s) for a provider, but REFUSES when that
// would leave the account with no way to sign in — no password and no other
// IdP link (ErrLastLoginMethod). Magic-link is deliberately NOT counted as a
// standing credential here: it is a recovery fallback, and the safe default for
// a destructive account action is to require a real primary credential first.
//
// Returns (unlinked, err): unlinked=false with a nil error means there was no
// such link to remove.
func (r *Repo) UnlinkIdP(ctx context.Context, tenantID, userID, provider string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Serialize concurrent unlinks for THIS user (lock the users row): otherwise
	// two racing deletes of the last two methods can each observe the other's
	// method, both pass the guard, and both commit — stripping every login
	// method. The lock forces the second to re-read after the first commits.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE`, userID); err != nil {
		return false, err
	}

	// Standing login methods that survive removing this provider: a password, a
	// passkey, or a link to a DIFFERENT provider. (Magic-link is deliberately
	// not counted — a recovery fallback, not a primary credential.)
	var thisLink, hasPassword, otherLinks, hasPasskey int
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM auth_idp_links       WHERE user_id = $1::uuid AND provider = $2),
  (SELECT count(*) FROM auth_credentials      WHERE user_id = $1::uuid),
  (SELECT count(*) FROM auth_idp_links        WHERE user_id = $1::uuid AND provider <> $2),
  (SELECT count(*) FROM webauthn_credentials  WHERE user_id = $1::uuid)`,
		userID, provider).Scan(&thisLink, &hasPassword, &otherLinks, &hasPasskey); err != nil {
		return false, err
	}
	if thisLink == 0 {
		// Nothing to unlink — not an error, just a no-op the handler maps to 404.
		return false, tx.Commit(ctx)
	}
	if hasPassword == 0 && otherLinks == 0 && hasPasskey == 0 {
		// The provider being removed is the account's only login method.
		return false, ErrLastLoginMethod
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM auth_idp_links WHERE user_id = $1::uuid AND provider = $2`,
		userID, provider)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, tx.Commit(ctx)
}
