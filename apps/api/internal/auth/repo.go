// SPDX-License-Identifier: AGPL-3.0-only
//
// Auth data access. Three call shapes:
//
//   - Pre-tenant lookups (LookupUserByEmail, LookupSession): run with
//     `app.auth_resolver = 'true'` so the permissive RLS policies on
//     auth_credentials / auth_sessions / auth_tokens fire.
//   - Post-tenant writes (CreateUser, CreateCredential, CreateSession,
//     RevokeSession): run inside db.WithTenant so the tenant_isolation
//     policy applies normally.
//   - Token consumption (ConsumeToken): pre-tenant lookup THEN
//     post-tenant write — wrapped in a single tx that flips the GUC
//     mid-flight.
//
// The split is deliberate: it's the same pattern the outbox worker
// uses (app.outbox_worker GUC), so operators only learn one trick.
package auth

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
	"github.com/postwave/postwave/apps/api/internal/limits"
	"github.com/postwave/postwave/apps/api/internal/pagination"
	"github.com/postwave/postwave/apps/api/internal/regions"
)

// ErrNotFound is the canonical "no such row" sentinel callers compare
// against. Wraps pgx.ErrNoRows for the data-access layer's internal
// shape but exposes a stable identity for handlers.
var (
	ErrNotFound              = errors.New("not found")
	ErrIdentityAlreadyLinked = errors.New("identity already linked to another user")
	// ErrAlreadyMember is returned by AcceptInvitation when the invited email
	// already has a user row in the invited tenant — so the accept path 409s
	// cleanly instead of surfacing the users unique-index violation as a 500.
	ErrAlreadyMember = errors.New("already a member of this workspace")
)

// Repo is the auth data-access surface. Construct in main.go and
// share across handlers + middleware resolver.
type Repo struct {
	Pool   *db.Pool
	Pepper []byte // POSTWAVE_AUTH_HMAC_PEPPER, ≥ 32 bytes
	// DeviceSignInOutbox is the mandatory transactional side-effect sink for
	// a confirmed cross-device session. Confirmation and alert intent must
	// commit together; a nil/unavailable sink therefore leaves the session
	// provisional and makes the requester retry instead of silently losing a
	// security alert.
	DeviceSignInOutbox DeviceSignInOutboxAppender
	// TrustPepper peppers the AUTH#48 device-trust verifier. It is a SECOND
	// credential's key and must never be the session pepper: the trust token
	// outlives the session, so the two hash spaces have to be disjoint or a
	// verifier_hash lifted from one table would be usable against the other.
	//
	// Optional. When empty, trustPepper() falls back to
	// DeriveTrustPepper(Pepper) — a domain-separated derivation from the same
	// server secret, which keeps the spaces disjoint without requiring every
	// deployment to provision a new secret. Set it explicitly (from
	// POSTWAVE_AUTH_DEVICE_TRUST_PEPPER) when you want independent rotation.
	TrustPepper []byte
}

// User is the row from `users` plus the resolved tenant id; matches
// what the session resolver needs to set up middleware context.
type User struct {
	ID              string
	TenantID        string
	TenantName      string
	TenantSlug      string
	Email           string
	Role            string // owner|admin|editor|viewer
	AuthProvider    string
	EmailVerifiedAt *time.Time
	// Status is the users.status lifecycle value (active|suspended|deleted,
	// migration 0122). Read by SwitchWorkspace so a membership an operator
	// has already revoked in Settings > Team cannot be re-entered from a
	// session that was minted before the revocation. Fakes that do not set
	// it leave it empty; treat "" as active for backward compatibility.
	Status string
}

// Credential is the auth_credentials row.
type Credential struct {
	UserID            string
	TenantID          string
	PasswordPHC       string
	PasswordUpdatedAt time.Time
	FailedAttempts    int
	LockedUntil       *time.Time
}

// Session is the resolver's projection of an auth_sessions row.
type Session struct {
	ID           string
	UserID       string
	TenantID     string
	VerifierHash []byte
	IssuedAt     time.Time
	LastSeenAt   time.Time
	ExpiresAt    time.Time
	RevokedAt    *time.Time
	MFASatisfied bool
	// MFASatisfiedAt is WHEN the possession factor was last proven. Zero means
	// no record — including sessions predating migration 1892 — which every
	// step-up policy treats as "prompt", never "allow".
	MFASatisfiedAt time.Time
	AuthMethod     string
	// IP + UserAgent are sourced from auth_sessions.ip / user_agent
	// and only populated by handlers that explicitly need them
	// (ListUserSessions for the "active devices" UX). The resolver
	// hot path leaves them empty for speed.
	IP        string
	UserAgent string
	// RoleOverride is the SUB-091 per-session effective-role override
	// for the View-as-Viewer admin preview affordance. Empty string =
	// no override (use the durable users.role). When set it is one of
	// owner|admin|editor|viewer; the resolver surfaces it as the
	// effective role to the middleware + /me without mutating the
	// durable role.
	RoleOverride string
}

// withResolverGUC starts a transaction with the permissive pre-auth GUCs set
// so the pre-tenant lookups can read across tenants. `app.auth_resolver` opens
// the users/auth_credentials/auth_sessions resolver policies; `app.tenant_resolver`
// opens the tenants resolver policy — LookupUserByEmail JOINs `tenants` for the
// workspace name/slug, and without the tenants GUC that JOIN is RLS-filtered to
// zero rows, which made every password login fail as invalid_credentials.
// Caller is responsible for Commit/Rollback.
func (r *Repo) withResolverGUC(ctx context.Context) (pgx.Tx, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.auth_resolver', 'true', true),
		        set_config('app.tenant_resolver', 'true', true)`); err != nil {
		_ = tx.Rollback(ctx)
		return nil, fmt.Errorf("set resolver gucs: %w", err)
	}
	return tx, nil
}

// LookupUserByEmail finds a user by email across tenants. Returns
// ErrNotFound when no row exists. Used by the password login path
// (pre-tenant resolution).
//
// The (lower(email)) index is per-tenant unique, so collision across
// tenants returns multiple rows — caller must handle the picker case.
func (r *Repo) LookupUserByEmail(ctx context.Context, email string) ([]User, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT u.id::text, u.tenant_id::text, t.name, t.slug,
       u.email, u.role, u.auth_provider, u.email_verified_at, u.status
  FROM users u
  JOIN tenants t ON t.id = u.tenant_id
 WHERE lower(u.email) = lower($1)`, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.TenantID, &u.TenantName, &u.TenantSlug, &u.Email, &u.Role,
			&u.AuthProvider, &u.EmailVerifiedAt, &u.Status); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out, nil
}

// SlugAvailable reports whether a workspace slug is free (AUTH-015). A pre-tenant
// signup probe, so it runs under the resolver GUC to read `tenants` across all
// tenants. Advisory only — the tenants_slug_key unique constraint remains the
// authority (signup still races on the 409). Exact match mirrors that index;
// signup slugs are already lowercased by the slug pattern.
func (r *Repo) SlugAvailable(ctx context.Context, slug string) (bool, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var available bool
	if err := tx.QueryRow(ctx,
		`SELECT NOT EXISTS(SELECT 1 FROM tenants WHERE slug = $1)`, slug).
		Scan(&available); err != nil {
		return false, err
	}
	return available, tx.Commit(ctx)
}

// LookupCredential reads the auth_credentials row for a given user.
// Pre-tenant. Returns ErrNotFound if missing (e.g. OAuth-only user).
func (r *Repo) LookupCredential(ctx context.Context, userID string) (*Credential, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var c Credential
	err = tx.QueryRow(ctx, `
SELECT user_id::text, tenant_id::text, password_phc, password_updated_at,
       failed_attempts, locked_until
  FROM auth_credentials WHERE user_id = $1::uuid`, userID).Scan(
		&c.UserID, &c.TenantID, &c.PasswordPHC, &c.PasswordUpdatedAt,
		&c.FailedAttempts, &c.LockedUntil)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, tx.Commit(ctx)
}

// LookupSession reads a session row by its opaque id, then verifies
// the cookie verifier against the stored HMAC. Returns ErrNotFound
// (mapped from pgx.ErrNoRows OR verifier mismatch — same surface so
// timing differences don't leak whether the id existed) for any
// non-success.
//
// Returns ErrSessionExpired / ErrSessionRevoked separately so the
// resolver can clear the cookie on those paths.
func (r *Repo) LookupSession(ctx context.Context, id, verifier string) (*Session, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s Session
	var roleOverride *string
	err = tx.QueryRow(ctx, `
SELECT id, user_id::text, tenant_id::text, verifier_hash, issued_at,
       last_seen_at, expires_at, revoked_at, mfa_satisfied,
       COALESCE(mfa_satisfied_at, 'epoch'::timestamptz), auth_method,
       role_override
  FROM auth_sessions
 WHERE id = $1
   AND (auth_method <> 'device_grant' OR device_grant_confirmed_at IS NOT NULL)`, id).Scan(
		&s.ID, &s.UserID, &s.TenantID, &s.VerifierHash, &s.IssuedAt,
		&s.LastSeenAt, &s.ExpiresAt, &s.RevokedAt, &s.MFASatisfied, &s.MFASatisfiedAt,
		&s.AuthMethod, &roleOverride)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if roleOverride != nil {
		s.RoleOverride = *roleOverride
	}
	if !VerifyVerifier(verifier, s.VerifierHash, r.Pepper) {
		return nil, ErrNotFound
	}
	if s.RevokedAt != nil {
		_ = tx.Commit(ctx)
		return nil, ErrSessionRevoked
	}
	if time.Now().After(s.ExpiresAt) {
		_ = tx.Commit(ctx)
		return nil, ErrSessionExpired
	}
	return &s, tx.Commit(ctx)
}

// IsActiveIdentityLinkSession revalidates the server-side session captured
// when an authenticated user explicitly started an IdP-link flow. The OAuth
// state nonce is unguessable and DB-backed, so the callback only needs the
// session id here; it must still fail closed if that session was revoked,
// expired, or no longer belongs to the intended user and tenant while the user
// was at the provider.
func (r *Repo) IsActiveIdentityLinkSession(
	ctx context.Context,
	sessionID, userID, tenantID string,
) (bool, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var active bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM auth_sessions
     WHERE id = $1
       AND user_id = $2::uuid
       AND tenant_id = $3::uuid
       AND revoked_at IS NULL
       AND expires_at > now()
)`, sessionID, userID, tenantID).Scan(&active); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return active, nil
}

// TouchSession bumps last_seen_at if it has been > 60s since the
// previous bump. Called from the resolver on every authenticated
// request. The 60s grace prevents a tx storm on chatty clients.
func (r *Repo) TouchSession(ctx context.Context, id string) error {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE auth_sessions
   SET last_seen_at = now()
 WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CreateSession inserts a new auth_sessions row. Caller has already
// resolved tenant_id from the user. Tenant-scoped tx.
//
// Session-binding fields: ip + user_agent are populated from the
// Session struct so the resolver can detect hijack signals later
// (audit finding H3, auth boundary). Previously these columns were
// hard-coded to empty strings, leaving a stolen cookie fully
// reusable from any IP/browser with no server-side telemetry.
func (r *Repo) CreateSession(ctx context.Context, tenantID string, s Session) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO auth_sessions (
    id, user_id, tenant_id, verifier_hash, expires_at,
    ip, user_agent, mfa_satisfied, auth_method)
VALUES ($1, $2::uuid, $3::uuid, $4, $5, NULLIF($6,'')::inet, $7, $8, $9)`,
		s.ID, s.UserID, tenantID, s.VerifierHash, s.ExpiresAt,
		s.IP, s.UserAgent, s.MFASatisfied, s.AuthMethod)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RevokeSession sets revoked_at on a session. Pre-tenant since the
// resolver may need to revoke a stale session before the tenant tx
// is set up.
func (r *Repo) RevokeSession(ctx context.Context, id string) error {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RevokeAllUserSessions marks every active session for a user as
// revoked. Used after a password reset (defense-in-depth: a stolen
// session shouldn't survive a credential change). Pre-tenant: the
// caller may not have a tenant context (e.g. password-reset confirm
// runs unauth), and the resolver GUC's UPDATE policy on auth_sessions
// covers this write.
func (r *Repo) RevokeAllUserSessions(ctx context.Context, userID string) error {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE auth_sessions SET revoked_at = now()
		  WHERE user_id = $1::uuid AND revoked_at IS NULL`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListUserSessions returns every active (non-revoked, non-expired)
// session for the user with keyset pagination on (last_seen_at, id).
// Used by the operator-facing "show me my active sessions" page.
// Order: most-recently-seen first. Scoped by userID (not tenantID) via
// the resolver GUC — that scoping is preserved. limit is the page size
// (caller clamps via pagination.ReadParamsWithDefault); a non-empty
// next cursor is returned when more rows remain.
func (r *Repo) ListUserSessions(ctx context.Context, userID string, limit int, cursor pagination.Cursor) ([]Session, string, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// $1 userID, $2 limit+1; the keyset bound (when paging) takes $3/$4.
	args := []any{userID, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		// auth_sessions.id is a TEXT primary key (a base64url session token),
		// not a uuid — cast the cursor boundary to text to match.
		keyset = "AND (last_seen_at, id) < ($3::timestamptz, $4::text)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, `
SELECT id, user_id::text, tenant_id::text,
       issued_at, last_seen_at, expires_at,
       COALESCE(host(ip), ''), COALESCE(user_agent, ''),
       mfa_satisfied, auth_method
  FROM auth_sessions
 WHERE user_id = $1::uuid
   AND revoked_at IS NULL
   AND expires_at > now()
   `+keyset+`
 ORDER BY last_seen_at DESC, id DESC
 LIMIT $2`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var s Session
		if err := rows.Scan(&s.ID, &s.UserID, &s.TenantID,
			&s.IssuedAt, &s.LastSeenAt, &s.ExpiresAt,
			&s.IP, &s.UserAgent, &s.MFASatisfied, &s.AuthMethod); err != nil {
			return nil, "", err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.LastSeenAt, ID: last.ID})
	}
	return out, next, nil
}

// priorDeviceScanLimit bounds the "have I seen this device before?" scan.
// A user with more than this many DISTINCT user agents is not a case the
// heuristic can help with anyway, and an unbounded scan on the login path
// is how a security nicety turns into a login outage.
const priorDeviceScanLimit = 50

// PriorSessionUserAgents returns the distinct user-agent strings from the
// user's OTHER sessions — every session except excludeSessionID, including
// revoked and expired ones, because "I signed in from this laptop last
// year" is exactly the memory that makes a new-device alert quiet.
//
// Bounded by priorDeviceScanLimit, most recent first. Pre-tenant (resolver
// GUC) because it is called from the login path alongside CreateSession.
func (r *Repo) PriorSessionUserAgents(ctx context.Context, userID, excludeSessionID string) ([]string, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT user_agent
  FROM (
    SELECT DISTINCT ON (COALESCE(user_agent, '')) COALESCE(user_agent, '') AS user_agent,
           issued_at
      FROM auth_sessions
     WHERE user_id = $1::uuid
       AND id <> $2
     ORDER BY COALESCE(user_agent, ''), issued_at DESC
  ) d
 ORDER BY d.issued_at DESC
 LIMIT $3`, userID, excludeSessionID, priorDeviceScanLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var ua string
		if err := rows.Scan(&ua); err != nil {
			return nil, err
		}
		out = append(out, ua)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeUserSessionByID revokes a single session, but ONLY if it
// belongs to the supplied userID. Returns true when a row was
// updated; false when the (userID, id) pair didn't match an active
// session.
func (r *Repo) RevokeUserSessionByID(ctx context.Context, userID, sessionID string) (bool, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_sessions SET revoked_at = now()
 WHERE id = $1
   AND user_id = $2::uuid
   AND revoked_at IS NULL`, sessionID, userID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RevokeUserSessionsExcept revokes every active session for the
// user EXCEPT the one whose id matches `keepSessionID`. Used by the
// "log out all other devices" flow. Returns the count revoked.
//
// When keepSessionID is empty, behaves like RevokeAllUserSessions
// (which is the correct semantics if the caller isn't running
// under a session cookie — there's nothing to keep).
func (r *Repo) RevokeUserSessionsExcept(ctx context.Context, userID, keepSessionID string) (int, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_sessions SET revoked_at = now()
 WHERE user_id = $1::uuid
   AND revoked_at IS NULL
   AND id <> $2`, userID, keepSessionID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// RecordLoginFailure increments failed_attempts and applies a 15-minute
// lockout after 10 failures. Pre-tenant; uses the resolver GUC.
func (r *Repo) RecordLoginFailure(ctx context.Context, userID string) error {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE auth_credentials
   SET failed_attempts = failed_attempts + 1,
       locked_until = CASE WHEN failed_attempts + 1 >= 10
                           THEN now() + interval '15 minutes'
                           ELSE locked_until END
 WHERE user_id = $1::uuid`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ResetLoginCounters zeroes the failed_attempts + locked_until columns
// after a successful login.
func (r *Repo) ResetLoginCounters(ctx context.Context, userID string) error {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE auth_credentials
   SET failed_attempts = 0, locked_until = NULL
 WHERE user_id = $1::uuid`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CreateTenantWithOwner is the signup landing path. Atomically:
//   - INSERTS a tenants row (tier=sandbox as the default starter plan)
//   - INSERTS a users row (role=owner, auth_provider=password)
//   - INSERTS auth_credentials with the given PHC string
//
// Returns (tenantID, userID).
func (r *Repo) CreateTenantWithOwner(
	ctx context.Context,
	workspaceName, workspaceSlug, email, passwordPHC string,
) (string, string, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Pre-generate the tenant UUID so we can set `app.tenant_id` BEFORE
	// inserting. The tenants RLS policy's WITH CHECK requires the new
	// row's id to equal app.tenant_id — chicken-and-egg unless we know
	// the id up front.
	var tenantID string
	if err := tx.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		return "", "", fmt.Errorf("gen tenant id: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", "", fmt.Errorf("set tenant guc: %w", err)
	}

	// data_region seeded from the replica's POSTWAVE_DEPLOYMENT_REGION
	// so a signup hitting the eu-central-1 replica pins the tenant to
	// eu-central-1 (not the us-east-1 default). Audit (multi-region
	// CRITICAL #1): the prior INSERT omitted data_region, so every
	// new tenant defaulted to us-east-1 via the column DEFAULT — EU
	// signups immediately 421'd on every subsequent request.
	region := regions.Provisioning()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier, data_region)
VALUES ($1::uuid, $2, $3, 'sandbox', $4)`, tenantID, workspaceSlug, workspaceName, region); err != nil {
		return "", "", fmt.Errorf("insert tenant: %w", err)
	}

	var userID string
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, auth_provider)
VALUES ($1::uuid, $2, 'owner', 'password')
RETURNING id::text`, tenantID, email).Scan(&userID); err != nil {
		return "", "", fmt.Errorf("insert user: %w", err)
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO auth_credentials (user_id, tenant_id, password_phc)
VALUES ($1::uuid, $2::uuid, $3)`, userID, tenantID, passwordPHC); err != nil {
		return "", "", fmt.Errorf("insert credential: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return tenantID, userID, nil
}

// IssueToken generates a one-time token (verify / reset / magic-link),
// stores SHA-256(token) in auth_tokens, and returns the plaintext for
// inclusion in the email body. Tenant-scoped tx.
func (r *Repo) IssueToken(
	ctx context.Context, tenantID, userID, purpose string, ttl time.Duration,
) (string, error) {
	plain, err := randomToken(32)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256([]byte(plain))

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO auth_tokens (user_id, tenant_id, token_hash, purpose, expires_at)
VALUES ($1::uuid, $2::uuid, $3, $4, now() + ($5 || ' seconds')::interval)`,
		userID, tenantID, hash[:], purpose, fmt.Sprintf("%d", int(ttl.Seconds()))); err != nil {
		return "", err
	}
	return plain, tx.Commit(ctx)
}

// ConsumeToken marks a token consumed and returns (userID, tenantID,
// purpose). Returns ErrNotFound if the token doesn't exist, is
// expired, or was already consumed. Pre-tenant: callers don't know
// the tenant until the row is read.
func (r *Repo) ConsumeToken(ctx context.Context, plain string) (userID, tenantID, purpose string, err error) {
	hash := sha256.Sum256([]byte(plain))
	tx, txErr := r.withResolverGUC(ctx)
	if txErr != nil {
		return "", "", "", txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
UPDATE auth_tokens
   SET consumed_at = now()
 WHERE token_hash = $1
   AND consumed_at IS NULL
   AND expires_at > now()
 RETURNING user_id::text, tenant_id::text, purpose`, hash[:]).Scan(&userID, &tenantID, &purpose)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", "", err
	}
	return userID, tenantID, purpose, nil
}

// AcceptInvitation redeems a copy-link team invitation (SETC-010): it creates
// the invited user in the invitation's tenant with the invited role and a
// password credential, and marks the invitation consumed — all in one
// transaction so a token cannot be redeemed twice.
//
// The invitee has no session yet, so the token lookup runs under the resolver
// GUC (app.auth_resolver='true' opens team_invitations.auth_resolver_all)
// exactly like ConsumeToken. app.tenant_id is then bound to the INVITE's
// tenant before the users INSERT, so the row lands in the invited workspace
// and tenant_isolation's WITH CHECK passes.
func (r *Repo) AcceptInvitation(ctx context.Context, plainToken, passwordPHC string) (tenantID, userID, email string, err error) {
	hash := sha256.Sum256([]byte(plainToken))
	tx, txErr := r.withResolverGUC(ctx)
	if txErr != nil {
		return "", "", "", txErr
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var inviteID, inviteRole string
	err = tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, email::text, role
  FROM team_invitations
 WHERE token_hash = $1
   AND accepted_at IS NULL
   AND expires_at > now()
 FOR UPDATE`, hash[:]).Scan(&inviteID, &tenantID, &email, &inviteRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", err
	}

	// Bind the tenant so the INSERTs land in the invited workspace (NOT any
	// caller tenant) and RLS WITH CHECK passes.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return "", "", "", err
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 9137))`, tenantID); err != nil {
		return "", "", "", err
	}

	// Duplicate-member guard: return a clean sentinel instead of hitting the
	// users_tenant_email unique index (which would surface as a 500).
	var existing string
	err = tx.QueryRow(ctx, `
SELECT id::text FROM users
 WHERE tenant_id = $1::uuid AND lower(email) = lower($2)`, tenantID, email).Scan(&existing)
	if err == nil {
		return "", "", "", ErrAlreadyMember
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", err
	}

	var rawTier string
	var occupied int
	if err := tx.QueryRow(ctx, `
SELECT lower(COALESCE(NULLIF(bs.tier, ''), NULLIF(t.tier, ''), 'sandbox')),
       (SELECT count(*) FROM users u
         WHERE u.tenant_id = t.id AND u.status <> 'deleted')
  FROM tenants t
  LEFT JOIN billing_state bs ON bs.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID).Scan(&rawTier, &occupied); err != nil {
		return "", "", "", err
	}
	tier, allowance := limits.WorkspaceSeatAllowance(rawTier)
	if occupied >= allowance {
		return "", "", "", &limits.Error{
			Resource: limits.ResourceSeats,
			Tier:     tier,
			Limit:    allowance,
			Current:  occupied,
		}
	}

	// Create the member with the invited role (external_user_id stays NULL,
	// same shape as a fresh password signup — CreateTenantWithOwner).
	if err := tx.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, status, auth_provider)
VALUES ($1::uuid, $2, $3, 'active', 'password')
RETURNING id::text`, tenantID, email, inviteRole).Scan(&userID); err != nil {
		return "", "", "", err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO auth_credentials (user_id, tenant_id, password_phc)
VALUES ($1::uuid, $2::uuid, $3)`, userID, tenantID, passwordPHC); err != nil {
		return "", "", "", err
	}
	// Single-use: consume the invitation in the same FOR UPDATE transaction.
	if _, err := tx.Exec(ctx, `
UPDATE team_invitations
   SET accepted_at = now(), accepted_by_user_id = $2::uuid
 WHERE id = $1::uuid`, inviteID, userID); err != nil {
		return "", "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", "", "", err
	}
	return tenantID, userID, email, nil
}

// ResetPassword atomically consumes a password-reset token, replaces the
// associated local password credential, and revokes every active session for
// that user. No security state is committed unless all three writes succeed:
// a transient session-revocation failure therefore leaves the old password in
// place and the reset token retryable instead of returning a false success
// while a stolen session remains valid.
func (r *Repo) ResetPassword(ctx context.Context, plain, newPHC string) error {
	if strings.TrimSpace(plain) == "" || strings.TrimSpace(newPHC) == "" {
		return ErrNotFound
	}
	hash := sha256.Sum256([]byte(plain))
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return resetPasswordInTransaction(ctx, tx, hash[:], newPHC)
}

type passwordResetTransaction interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Commit(ctx context.Context) error
}

func resetPasswordInTransaction(
	ctx context.Context,
	tx passwordResetTransaction,
	tokenHash []byte,
	newPHC string,
) error {
	var userID, tenantID string
	operationErr := tx.QueryRow(ctx, `
UPDATE auth_tokens
   SET consumed_at = now()
 WHERE token_hash = $1
   AND purpose = 'password_reset'
   AND consumed_at IS NULL
   AND expires_at > now()
 RETURNING user_id::text, tenant_id::text`, tokenHash).Scan(&userID, &tenantID)
	if errors.Is(operationErr, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if operationErr != nil {
		return fmt.Errorf("consume password reset token: %w", operationErr)
	}

	// The token identifies the tenant. Bind it inside this same transaction so
	// the normal tenant RLS policy authorizes the credential update; the
	// resolver policy remains active only for the pre-tenant token lookup and
	// session revocation.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return fmt.Errorf("bind password reset tenant: %w", err)
	}
	credentialTag, operationErr := tx.Exec(ctx, `
UPDATE auth_credentials
   SET password_phc = $1,
       password_updated_at = now(),
       failed_attempts = 0,
       locked_until = NULL
 WHERE user_id = $2::uuid
   AND tenant_id = $3::uuid`, newPHC, userID, tenantID)
	if operationErr != nil {
		return fmt.Errorf("update password credential: %w", operationErr)
	}
	if credentialTag.RowsAffected() != 1 {
		return fmt.Errorf("update password credential: expected one row, updated %d", credentialTag.RowsAffected())
	}

	if _, err := tx.Exec(ctx, `
UPDATE auth_sessions
   SET revoked_at = now()
 WHERE user_id = $1::uuid
   AND tenant_id = $2::uuid
   AND revoked_at IS NULL`, userID, tenantID); err != nil {
		return fmt.Errorf("revoke password reset sessions: %w", err)
	}

	// AUTH#48 — and every device-trust record with them.
	//
	// A password reset is the "I may be compromised" verb, and it already
	// promises to end every session. A trusted device is a SECOND credential
	// that lets a BRAND NEW session start already MFA-satisfied, so leaving it
	// alive would mean the standard compromise response — reset the password,
	// sign everything out — quietly left the MFA bypass running on the very
	// laptop the user was worried about. Whoever ends up with the new password
	// and that machine would skip the second factor entirely.
	//
	// Note the asymmetry with LOGOUT, which deliberately does NOT revoke trust:
	// surviving logout is the entire point of the feature. Surviving a
	// credential reset is not.
	if _, err := tx.Exec(ctx, `
UPDATE auth_trusted_devices
   SET revoked_at = now()
 WHERE user_id = $1::uuid
   AND tenant_id = $2::uuid
   AND revoked_at IS NULL`, userID, tenantID); err != nil {
		return fmt.Errorf("revoke password reset trusted devices: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit password reset: %w", err)
	}
	return nil
}

// MarkEmailVerified flips the users.email_verified_at column. Tenant
// tx; called from the verify-email handler after ConsumeToken.
func (r *Repo) MarkEmailVerified(ctx context.Context, tenantID, userID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE users SET email_verified_at = now() WHERE id = $1::uuid AND email_verified_at IS NULL`,
		userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// UserAuthState reads the persisted provider and verification state for /me.
func (r *Repo) UserAuthState(ctx context.Context, tenantID, userID string) (string, bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var provider string
	var verified bool
	if err := tx.QueryRow(ctx, `
SELECT auth_provider, email_verified_at IS NOT NULL
  FROM users
 WHERE id = $1::uuid`, userID).Scan(&provider, &verified); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, ErrNotFound
		}
		return "", false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return provider, verified, nil
}

// IsEmailVerified preserves the narrower repository API used by callers that
// do not need the authentication provider.
func (r *Repo) IsEmailVerified(ctx context.Context, tenantID, userID string) (bool, error) {
	_, verified, err := r.UserAuthState(ctx, tenantID, userID)
	return verified, err
}

// LinkIdP records a (provider, subject) → user mapping in
// auth_idp_links. Cross-tenant by design (the (provider, subject) pair
// resolves a user before the tenant is known — see migration 0058 for
// the original rationale), so we run inside the resolver GUC tx rather
// than db.WithTenant. Migration 0332 added RLS on auth_idp_links gated
// on the same app.auth_resolver = 'true' GUC that withResolverGUC sets,
// so this call path remains the only authorized writer. Idempotent on
// the (provider, subject) UNIQUE: an existing row's email + raw_claims
// are refreshed so subsequent logins capture the latest IdP claims.
func (r *Repo) LinkIdP(
	ctx context.Context,
	userID, provider, subject, email string,
	rawClaims []byte,
) error {
	if rawClaims == nil {
		rawClaims = []byte(`{}`)
	}
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
INSERT INTO auth_idp_links (user_id, provider, subject, email, raw_claims)
VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
    ON CONFLICT (provider, subject) DO UPDATE
       SET email = EXCLUDED.email,
           raw_claims = EXCLUDED.raw_claims,
           linked_at = now()
     WHERE auth_idp_links.user_id = EXCLUDED.user_id`,
		userID, provider, subject, email, string(rawClaims))
	if err != nil {
		return fmt.Errorf("link idp: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrIdentityAlreadyLinked
	}
	return tx.Commit(ctx)
}

// LookupUserByIdP resolves the user behind a (provider, subject) IdP
// identity. Pre-tenant: callers don't know which tenant the user
// belongs to until the row comes back. Returns ErrNotFound when the
// IdP identity has never been linked.
func (r *Repo) LookupUserByIdP(ctx context.Context, provider, subject string) (*User, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var u User
	err = tx.QueryRow(ctx, `
SELECT u.id::text, u.tenant_id::text, u.email, u.role,
       u.auth_provider, u.email_verified_at
  FROM auth_idp_links l
  JOIN users u ON u.id = l.user_id
 WHERE l.provider = $1 AND l.subject = $2`, provider, subject).Scan(
		&u.ID, &u.TenantID, &u.Email, &u.Role, &u.AuthProvider, &u.EmailVerifiedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &u, nil
}

// UpdatePassword writes a new PHC hash and resets login counters in
// one tx. Used by password reset + by the post-login rehash upgrade.
func (r *Repo) UpdatePassword(ctx context.Context, tenantID, userID, newPHC string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE auth_credentials
   SET password_phc = $1, password_updated_at = now(),
       failed_attempts = 0, locked_until = NULL
 WHERE user_id = $2::uuid`, newPHC, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// UpsertTOTPSecret writes (or replaces) a user's encrypted TOTP secret
// + recovery-code hashes. Idempotent: re-enrollment overwrites the
// prior row, including resetting last_used_at to NULL so the
// "enrolled but never used" signal stays accurate.
//
// Tenant-scoped tx: writes go through the tenant_isolation policy.
func (r *Repo) UpsertTOTPSecret(
	ctx context.Context,
	tenantID, userID string,
	encryptedSecret []byte,
	recoveryHashes [][]byte,
) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO auth_totp_secrets (
    user_id, tenant_id, secret_encrypted, recovery_codes_hash,
    enrolled_at, last_used_at)
VALUES ($1::uuid, $2::uuid, $3, $4, now(), NULL)
ON CONFLICT (user_id) DO UPDATE
   SET tenant_id           = EXCLUDED.tenant_id,
       secret_encrypted    = EXCLUDED.secret_encrypted,
       recovery_codes_hash = EXCLUDED.recovery_codes_hash,
       enrolled_at         = now(),
       last_used_at        = NULL`,
		userID, tenantID, encryptedSecret, recoveryHashes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// HasTOTPSecret reports whether the user has a confirmed TOTP secret.
// Cheaper than GetTOTPSecret (no decrypt, no recovery-code fetch) and
// safe to call in any request context — the Settings UI's Security
// section uses it to pick between "Set up 2FA" and "Disable 2FA"
// affordances, and only the boolean is ever surfaced to the client.
func (r *Repo) HasTOTPSecret(ctx context.Context, userID string) (bool, error) {
	_, confirmed, err := r.TOTPSecretState(ctx, userID)
	return confirmed, err
}

// TOTPSecretState distinguishes an unfinished enrollment row from an active
// second factor. TOTPEnroll uses exists+confirmed to allow restarting an
// abandoned first-time setup while refusing a pre-MFA session that attempts
// to rotate an already-confirmed factor.
func (r *Repo) TOTPSecretState(ctx context.Context, userID string) (exists, confirmed bool, err error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return false, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rowExists, rowConfirmed bool
	err = tx.QueryRow(ctx, `
SELECT EXISTS(SELECT 1 FROM auth_totp_secrets WHERE user_id = $1::uuid),
       EXISTS(SELECT 1 FROM auth_totp_secrets
               WHERE user_id = $1::uuid AND last_used_at IS NOT NULL)`,
		userID).Scan(&rowExists, &rowConfirmed)
	if err != nil {
		return false, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, false, err
	}
	return rowExists, rowConfirmed, nil
}

// TOTPFactorStatus reports, in ONE query, whether the user has a confirmed
// second factor and how many unused recovery codes remain. /auth/me needs
// both, and issuing two round trips for facts that live in the same row is
// how the two values drift apart under concurrent consumption.
//
// remaining is 0 whenever there is no row at all, so a caller that only
// checks `confirmed` behaves exactly like the older HasTOTPSecret.
//
// Pre-tenant (resolver GUC) for the same reason GetTOTPSecret is: the
// callers run on paths where a tenant tx may not be established yet.
func (r *Repo) TOTPFactorStatus(ctx context.Context, userID string) (confirmed bool, remaining int, err error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return false, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT last_used_at IS NOT NULL,
       COALESCE(array_length(recovery_codes_hash, 1), 0)
  FROM auth_totp_secrets WHERE user_id = $1::uuid`, userID).Scan(&confirmed, &remaining)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, err
	}
	return confirmed, remaining, nil
}

// ReplaceRecoveryCodes swaps the whole recovery-code bundle for a user whose
// factor is already CONFIRMED. Regeneration is a full replace by design: the
// old codes must stop working the moment the new sheet is displayed,
// otherwise a leaked printout stays live forever.
//
// The `last_used_at IS NOT NULL` predicate is the confirmed-factor gate. An
// unfinished enrollment has no codes worth rotating — that user should
// restart /totp/enroll, which mints a fresh secret AND a fresh bundle.
// Returns ErrNotFound when no confirmed row matched.
//
// Tenant-scoped tx: the write goes through auth_totp_secrets' tenant policy,
// same as UpsertTOTPSecret.
func (r *Repo) ReplaceRecoveryCodes(
	ctx context.Context, tenantID, userID string, recoveryHashes [][]byte,
) error {
	if len(recoveryHashes) == 0 {
		return errors.New("refusing to replace recovery codes with an empty bundle")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_totp_secrets
   SET recovery_codes_hash = $2
 WHERE user_id = $1::uuid
   AND last_used_at IS NOT NULL`, userID, recoveryHashes)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// GetTOTPSecret reads the encrypted secret + recovery-code hashes for
// a user. Pre-tenant: the challenge handler runs before the session is
// MFA-satisfied (and so before the tenant middleware has wired tenant
// context), but we still need to read the secret to verify the code.
//
// Returns ErrNotFound if the user hasn't enrolled.
func (r *Repo) GetTOTPSecret(ctx context.Context, userID string) (
	encryptedSecret []byte, recoveryHashes [][]byte, err error,
) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	err = tx.QueryRow(ctx, `
SELECT secret_encrypted, recovery_codes_hash
  FROM auth_totp_secrets WHERE user_id = $1::uuid`, userID).Scan(
		&encryptedSecret, &recoveryHashes)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return encryptedSecret, recoveryHashes, nil
}

// MarkTOTPUsed bumps last_used_at to now(). Called from the verify and
// challenge handlers on success. Tenant-scoped because the row is
// already enrolled and the policy interlock is fine.
func (r *Repo) MarkTOTPUsed(ctx context.Context, tenantID, userID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE auth_totp_secrets SET last_used_at = now()
 WHERE user_id = $1::uuid`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ConsumeRecoveryCode atomically removes a single matching recovery
// hash from the user's recovery_codes_hash array. Returns ErrNotFound
// if the hash isn't present (already consumed, or never issued).
//
// The `$2 = ANY(...)` predicate is the gate; without it, array_remove
// is a no-op on a missing element and we'd report success on a bad
// code. The `RETURNING 1` lets us tell match-vs-no-match from
// rowcount even when the array is unchanged.
func (r *Repo) ConsumeRecoveryCode(
	ctx context.Context, tenantID, userID string, codeHash []byte,
) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var matched int
	err = tx.QueryRow(ctx, `
UPDATE auth_totp_secrets
   SET recovery_codes_hash = array_remove(recovery_codes_hash, $2)
 WHERE user_id = $1::uuid
   AND $2 = ANY(recovery_codes_hash)
RETURNING 1`, userID, codeHash).Scan(&matched)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// DeleteTOTPSecret removes a user's TOTP enrollment row entirely.
// Used by the "disable MFA" flow. Tenant-scoped.
func (r *Repo) DeleteTOTPSecret(ctx context.Context, tenantID, userID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`DELETE FROM auth_totp_secrets WHERE user_id = $1::uuid`, userID); err != nil {
		return err
	}
	// AUTH#48 — the factor's device-trust records die with it, atomically.
	//
	// A trust record only exists because THIS factor produced a code that this
	// server verified; it is a standing promise not to ask that factor again.
	// When the factor is gone the promise is meaningless, and worse than
	// meaningless if the user re-enrolls: the common reason to disable and
	// re-enroll is "my authenticator was lost or compromised", and a surviving
	// trust record would let whoever caused that skip the BRAND NEW factor.
	if _, err := tx.Exec(ctx, `
UPDATE auth_trusted_devices
   SET revoked_at = now()
 WHERE user_id = $1::uuid
   AND tenant_id = $2::uuid
   AND revoked_at IS NULL`, userID, tenantID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetSessionRoleOverride writes (or clears, when override == "") the
// SUB-091 per-session role_override column for the View-as-Viewer admin
// preview affordance. Pre-tenant: it runs through the same resolver GUC
// path (app.auth_resolver = 'true') the rest of the session machinery
// uses, so the auth_resolver_update policy on auth_sessions (migration
// 0058) authorizes the write. Only mutates an active (non-revoked)
// session; returns true when a row was updated, false when the (id,
// active) pair didn't match.
//
// The caller (ToggleViewerMode) is responsible for validating the
// supplied role string and enforcing the down-only policy — the repo
// just persists whatever it's given (the migration's CHECK constraint
// is the final backstop on vocabulary).
func (r *Repo) SetSessionRoleOverride(ctx context.Context, sessionID, override string) (bool, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_sessions
   SET role_override = NULLIF($2, '')
 WHERE id = $1 AND revoked_at IS NULL`, sessionID, override)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// GetSessionRoleOverride reads the SUB-091 role_override for a session
// id. Returns "" when the column is NULL (no override) or the session
// does not exist. Pre-tenant via the resolver GUC.
func (r *Repo) GetSessionRoleOverride(ctx context.Context, sessionID string) (string, error) {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var override *string
	err = tx.QueryRow(ctx, `
SELECT role_override FROM auth_sessions WHERE id = $1`, sessionID).Scan(&override)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	if override == nil {
		return "", nil
	}
	return *override, nil
}

// MarkSessionMFASatisfied flips auth_sessions.mfa_satisfied to true on
// the supplied session id. Pre-tenant: the verify/challenge flows run
// before the session has cleared MFA, and the auth_resolver_update
// policy on auth_sessions (migration 0058) is the path we use for
// these resolver-time mutations.
func (r *Repo) MarkSessionMFASatisfied(ctx context.Context, sessionID string) error {
	tx, err := r.withResolverGUC(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_sessions
   SET mfa_satisfied = true,
       -- WHEN, not just whether. A step-up policy cannot ask "prove it again"
       -- of a boolean; migration 1892 exists because the one endpoint that
       -- needed freshness had to bypass this flag entirely rather than
       -- interrogate it.
       mfa_satisfied_at = now()
	 WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`, sessionID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}
