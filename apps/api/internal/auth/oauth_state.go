// SPDX-License-Identifier: AGPL-3.0-only
//
// CSRF-state + PKCE bookkeeping for the OAuth round-trip.
//
// A DB row keyed by the state nonce gives every API replica the same
// single-use, expiring envelope. The state context also binds new flows to
// the browser cookie set by /start, preventing cross-browser login CSRF.
//
// Lifecycle:
//
//   - IssueState   → INSERT (state, provider, pkce_verifier, redirect_to, expires_at).
//   - ConsumeState → DELETE … RETURNING. The DELETE-on-read makes the
//     row trivially single-use; if the user double-clicks the bounce
//     link the second click sees ErrNotFound and the handler returns
//     a clean error.
//
// Pre-auth: this table is intentionally NOT tenant-scoped (the user
// hasn't been resolved to a tenant yet). The migration leaves RLS off,
// so a plain *db.Pool tx is fine.
package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// OAuthStateTTL is how long a state nonce remains valid. Mirrors the
// 10-minute window the auth_oauth_state.expires_at column documents
// in 0058_auth_backend.sql. The provider's auth screen typically
// completes within a minute; we give 10 to absorb slow networks /
// MFA prompts on the IdP side.
const OAuthStateTTL = 10 * time.Minute

// OAuthStateRepo owns reads + writes to auth_oauth_state. Pre-auth,
// hence no tenant. Wraps *db.Pool so the test suite can inject a
// mock pool the same way the rest of the auth package does.
type OAuthStateRepo struct {
	Pool *db.Pool
}

// OAuthStateStore is the single-use state persistence contract consumed by
// the handlers. The concrete implementation remains OAuthStateRepo; the
// interface makes provider and DB failure paths deterministic in unit tests.
type OAuthStateStore interface {
	IssueState(ctx context.Context, provider, stateContext, pkceVerifier string) (string, error)
	ConsumeState(ctx context.Context, state string) (provider, stateContext, pkceVerifier string, err error)
}

// IssueState mints a fresh random state nonce and persists it
// alongside the provider key, a compact state context (safe redirect plus an
// optional authenticated link intent), and the PKCE code_verifier (the SHA-256
// challenge of which is sent to the IdP). The legacy `redirect_to` DB column
// stores that encoded context so rolling deploys require no schema change.
// Returns the plaintext state — the caller embeds it in the URL
// query string of the redirect to the IdP.
func (r *OAuthStateRepo) IssueState(
	ctx context.Context,
	provider, stateContext, pkceVerifier string,
) (string, error) {
	state, err := randomToken(24)
	if err != nil {
		return "", fmt.Errorf("oauth state: random: %w", err)
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO auth_oauth_state (state, provider, pkce_verifier, redirect_to, expires_at)
VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
		state, provider, pkceVerifier, stateContext,
		fmt.Sprintf("%d", int(OAuthStateTTL.Seconds()))); err != nil {
		return "", fmt.Errorf("oauth state insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return state, nil
}

// ConsumeState atomically reads-and-deletes a state row, returning
// the (provider, state context, pkce_verifier) the original /start handler
// stored. ErrNotFound when:
//
//   - the state was never issued,
//   - it was already consumed (rows are deleted on first read),
//   - it has expired (expires_at < now()).
//
// All three collapse to the same surface so a tampered state nonce
// can't be distinguished from an expired one via timing.
func (r *OAuthStateRepo) ConsumeState(
	ctx context.Context, state string,
) (provider, stateContext, pkceVerifier string, err error) {
	tx, txErr := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if txErr != nil {
		return "", "", "", txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rt, pv *string
	err = tx.QueryRow(ctx, `
DELETE FROM auth_oauth_state
 WHERE state = $1
   AND expires_at > now()
 RETURNING provider, redirect_to, pkce_verifier`, state).
		Scan(&provider, &rt, &pv)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", "", err
	}
	if rt != nil {
		stateContext = *rt
	}
	if pv != nil {
		pkceVerifier = *pv
	}
	return provider, stateContext, pkceVerifier, nil
}
