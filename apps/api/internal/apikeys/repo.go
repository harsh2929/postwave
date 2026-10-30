// SPDX-License-Identifier: AGPL-3.0-only
package apikeys

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ErrNotFound is returned when an api_keys lookup misses.
var ErrNotFound = errors.New("apikeys: not found")

// Repo wraps the pgx pool with api_keys CRUD.
//
// Pepper, when set, is mixed into key_hash via HMAC-SHA256. It MUST match
// the pepper that was active when existing rows were written; rotating
// it invalidates every existing api_keys row. See HashWithPepper.
type Repo struct {
	Pool   *db.Pool
	Pepper []byte
}

// HashKey is the package-internal helper used by both Create (to write a
// new row) and Middleware (to look up a presented bearer token). Routing
// every hash through here guarantees both paths agree on the algorithm.
func (r *Repo) HashKey(plaintext string) string {
	return HashWithPepper(plaintext, r.Pepper)
}

// keyColumns is the canonical SELECT list for api_keys reads. Single
// source of truth so List/Get/LookupByHash all return identical
// shapes — adding a column means changing the list once and all
// scanners pick it up.
const keyColumns = `id::text, tenant_id::text, label, prefix, scopes, created_at,
       last_used_at, revoked_at, actor_type, actor_label,
       sends_per_day, dollars_per_month_cents, allowed_ips::text[],
       rate_limit_per_min, rate_limit_per_day, rate_limit_burst, sandbox_only,
       expires_at, COALESCE(user_id::text, '')`

// List returns the tenant's keys newest-first. Plaintext is never returned —
// the admin UI displays prefix only, with the masked tail re-derived from
// the prefix column on the server.
func (r *Repo) List(ctx context.Context, tenantID string) ([]APIKey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT `+keyColumns+`
FROM api_keys
WHERE tenant_id = $1::uuid
ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		k, err := scanKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *k)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// scanKey is the shared row scanner used by every read path. Keep
// the column order in lockstep with keyColumns above.
func scanKey(row interface{ Scan(...any) error }) (*APIKey, error) {
	var k APIKey
	var scopes []string
	var actorLabel *string
	var allowedIPs []string
	if err := row.Scan(&k.ID, &k.TenantID, &k.Label, &k.Prefix, &scopes,
		&k.CreatedAt, &k.LastUsedAt, &k.RevokedAt,
		&k.ActorType, &actorLabel,
		&k.SendsPerDay, &k.DollarsPerMonthCents,
		&allowedIPs,
		&k.RateLimitPerMin, &k.RateLimitPerDay, &k.RateLimitBurst,
		&k.SandboxOnly, &k.ExpiresAt, &k.UserID); err != nil {
		return nil, err
	}
	if actorLabel != nil {
		k.ActorLabel = *actorLabel
	}
	k.Scopes = make([]Scope, len(scopes))
	for i, s := range scopes {
		k.Scopes[i] = Scope(s)
	}
	k.AllowedIPs = allowedIPs
	return &k, nil
}

// Create inserts a fresh key. The caller supplies the plaintext (so the
// HTTP response can echo it once); we store only the prefix + sha256 hash.
// Update edits a live key's metadata (label + scopes) in place, without
// rotating the secret (SETC-040). Revoked keys are immutable. ErrNotFound
// when no live row matches.
func (r *Repo) Update(ctx context.Context, tenantID, id, label string, scopes []Scope) (*APIKey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	scopeStrs := make([]string, len(scopes))
	for i, s := range scopes {
		scopeStrs[i] = string(s)
	}
	row := tx.QueryRow(ctx, `
UPDATE api_keys SET label = $2, scopes = $3
WHERE tenant_id = $1::uuid AND id::text = $4 AND revoked_at IS NULL
RETURNING `+keyColumns, tenantID, label, scopeStrs, id)
	k, err := scanKey(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

func (r *Repo) Create(ctx context.Context, tenantID, label, plaintext string, scopes []Scope) (*APIKey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	prefix := PrefixOf(plaintext)
	hash := r.HashKey(plaintext)
	scopeStrs := make([]string, len(scopes))
	for i, s := range scopes {
		scopeStrs[i] = string(s)
	}

	row := tx.QueryRow(ctx, `
INSERT INTO api_keys (tenant_id, label, prefix, key_hash, scopes)
VALUES ($1::uuid, $2, $3, $4, $5)
RETURNING `+keyColumns,
		tenantID, label, prefix, hash, scopeStrs)
	k, err := scanKey(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// CreateWithAllowedIPs is the long-form Create that accepts an IP/CIDR
// allowlist. The 5-arg Create stays for callers (and tests) that don't
// care about allowlists — it's equivalent to passing nil here.
//
// `allowedIPs` is a list of CIDR strings (`192.0.2.0/24`) or single
// addresses (`203.0.113.5/32`). Postgres normalises and validates them
// at INSERT time; if any value is malformed the INSERT fails with
// invalid_text_representation (22P02), which we surface as a typed
// validation error.
func (r *Repo) CreateWithAllowedIPs(ctx context.Context, tenantID, label, plaintext string, scopes []Scope, allowedIPs []string) (*APIKey, error) {
	return r.CreateWithOptions(ctx, tenantID, label, plaintext, scopes, CreateOptions{AllowedIPs: allowedIPs})
}

// CreateOptions carries optional key attributes that must stay explicit in
// call sites. Zero value = unrestricted, live key.
type CreateOptions struct {
	AllowedIPs  []string
	SandboxOnly bool
	// UserID binds user-private API/MCP state to the non-impersonable
	// dashboard principal that created this key.
	UserID string
	// ExpiresAt is an optional expiry stamped atomically at create (SETC-036).
	ExpiresAt *time.Time
}

// CreateWithOptions is the long-form key creator for security posture flags
// that must be persisted atomically with the plaintext hash.
func (r *Repo) CreateWithOptions(ctx context.Context, tenantID, label, plaintext string, scopes []Scope, opts CreateOptions) (*APIKey, error) {
	if len(opts.AllowedIPs) == 0 && !opts.SandboxOnly && opts.ExpiresAt == nil &&
		opts.UserID == "" {
		return r.Create(ctx, tenantID, label, plaintext, scopes)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	prefix := PrefixOf(plaintext)
	hash := r.HashKey(plaintext)
	scopeStrs := make([]string, len(scopes))
	for i, s := range scopes {
		scopeStrs[i] = string(s)
	}
	// api_keys.allowed_ips is NOT NULL DEFAULT '{}' (migration 0046). A nil
	// slice encodes as SQL NULL, and a DEFAULT applies only when the column is
	// omitted from the statement -- never when NULL is passed for it. The
	// statement below names the column, so nil is a constraint violation.
	//
	// This is the ordinary case, not a corner: the handler always sets UserID
	// from the session principal, which defeats the short-circuit above, so
	// every signed-in operator creating a key WITHOUT an allowlist landed here
	// and got a 500. Unrestricted is the empty list, not the absent one.
	allowedIPs := opts.AllowedIPs
	if allowedIPs == nil {
		allowedIPs = []string{}
	}
	row := tx.QueryRow(ctx, `
INSERT INTO api_keys (tenant_id, label, prefix, key_hash, scopes, allowed_ips,
                      sandbox_only, expires_at, user_id)
VALUES ($1::uuid, $2, $3, $4, $5, $6::inet[], $7, $8, NULLIF($9, '')::uuid)
RETURNING `+keyColumns,
		tenantID, label, prefix, hash, scopeStrs, allowedIPs,
		opts.SandboxOnly, opts.ExpiresAt, opts.UserID)
	k, err := scanKey(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// Get returns one key by id (tenant-scoped). Plaintext is never
// recoverable. Returns ErrNotFound if no row matched the (tenant, id)
// pair — RLS makes this safe even if the id from another tenant leaks.
func (r *Repo) Get(ctx context.Context, tenantID, id string) (*APIKey, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT `+keyColumns+`
FROM api_keys
WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, id)
	k, err := scanKey(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// Rotate atomically revokes an existing key and creates a new one
// inheriting the same label / scopes / budget caps. The caller passes
// the new plaintext (so the HTTP response can echo it once); we store
// only the prefix + hash, just like Create.
//
// Why two rows instead of mutating key_hash on the existing row:
//
//   - The old plaintext must stop working the instant the rotate
//     commits. Mutating in place creates a window between the new
//     hash being written and the old hash being invalidated where
//     the old plaintext still authenticates against the new hash.
//
//   - Audit trail: revoked_at on the old row preserves a record of
//     when the rotation happened. Mutating in place loses that
//     unconditionally.
//
//   - Last-used continuity: rotation should NOT carry forward the old
//     row's last_used_at, because a fresh secret has no usage history.
//
// Returns the NEW APIKey row. The old id is also returned so the caller
// can surface "rotated from X" in the audit log + admin UI.
func (r *Repo) Rotate(ctx context.Context, tenantID, oldID, newPlaintext string) (newKey *APIKey, oldRevokedID string, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Load the source row so we know what label + scopes + budget +
	// allowlist to carry forward. RLS ensures we can only rotate keys
	// we own.
	var label string
	var scopes []string
	var sendsPerDay *int
	var dollarsPerMonthCents *int
	var allowedIPs []string
	var sandboxOnly bool
	var userID string
	var expiresAt *time.Time
	var actorType string
	var actorLabel *string
	var rateLimitPerMin, rateLimitPerDay, rateLimitBurst *int
	if err := tx.QueryRow(ctx, `
SELECT label, scopes, sends_per_day, dollars_per_month_cents,
       allowed_ips::text[], sandbox_only, COALESCE(user_id::text, ''),
       expires_at, actor_type, actor_label,
       rate_limit_per_min, rate_limit_per_day, rate_limit_burst
FROM api_keys
WHERE tenant_id = $1::uuid AND id::text = $2 AND revoked_at IS NULL`,
		tenantID, oldID,
	).Scan(&label, &scopes, &sendsPerDay, &dollarsPerMonthCents,
		&allowedIPs, &sandboxOnly, &userID, &expiresAt, &actorType, &actorLabel,
		&rateLimitPerMin, &rateLimitPerDay, &rateLimitBurst); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrNotFound
		}
		return nil, "", err
	}

	// Revoke the source row inside the same tx — fail the whole
	// rotation if the revoke didn't take.
	tag, err := tx.Exec(ctx, `
UPDATE api_keys SET revoked_at = now() WHERE id::text = $1 AND revoked_at IS NULL`,
		oldID)
	if err != nil {
		return nil, "", err
	}
	if tag.RowsAffected() == 0 {
		return nil, "", ErrNotFound
	}

	// Insert the new row carrying forward the source's metadata,
	// including allowed_ips so a rotated key keeps its security posture.
	prefix := PrefixOf(newPlaintext)
	hash := r.HashKey(newPlaintext)
	row := tx.QueryRow(ctx, `
INSERT INTO api_keys (tenant_id, label, prefix, key_hash, scopes,
                      sends_per_day, dollars_per_month_cents, allowed_ips,
                      sandbox_only, user_id, expires_at, actor_type, actor_label,
                      rate_limit_per_min, rate_limit_per_day, rate_limit_burst)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::inet[], $9,
        NULLIF($10, '')::uuid, $11, $12, $13, $14, $15, $16)
RETURNING `+keyColumns,
		tenantID, label, prefix, hash, scopes,
		sendsPerDay, dollarsPerMonthCents, allowedIPs, sandboxOnly, userID,
		expiresAt, actorType, actorLabel, rateLimitPerMin, rateLimitPerDay, rateLimitBurst)
	k, err := scanKey(row)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	return k, oldID, nil
}

// LiveHashByID returns the stored one-way hash for local auth-cache
// invalidation. It never exposes or reconstructs plaintext and remains tenant
// scoped. Distributed cache revocation still requires a shared invalidation
// channel; callers must not describe this as globally instantaneous.
func (r *Repo) LiveHashByID(ctx context.Context, tenantID, id string) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var hash string
	if err := tx.QueryRow(ctx, `
SELECT key_hash
  FROM api_keys
 WHERE tenant_id = $1::uuid AND id::text = $2 AND revoked_at IS NULL`,
		tenantID, id).Scan(&hash); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return hash, nil
}

// Revoke flips revoked_at instead of deleting (audit trail).
func (r *Repo) Revoke(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Belt-and-suspenders tenant guard (audit finding M4): RLS
	// `app.tenant_id` already filters this row, but matching Get /
	// Rotate which both carry an explicit `tenant_id = $1::uuid`
	// predicate means a future RLS misconfig (or a SECURITY DEFINER
	// path that forgets to set the GUC) can't accidentally revoke a
	// sibling tenant's key.
	tag, err := tx.Exec(ctx, `
UPDATE api_keys SET revoked_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND revoked_at IS NULL`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// LookupByHash resolves a hashed key to its tenant id WITHOUT a tenant
// context. It binds app.api_key_hash so RLS can expose only that active hash.
// Used by the bearer-token middleware before it sets app.tenant_id for
// downstream queries.
func (r *Repo) LookupByHash(ctx context.Context, hash string) (*APIKey, error) {
	if hash == "" {
		return nil, ErrInvalidKey
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.api_key_hash', $1, true)`, hash); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT `+keyColumns+`
FROM api_keys
WHERE key_hash = $1 AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
LIMIT 1`, hash)
	k, err := scanKey(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidKey
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// LookupByID resolves an API key row by id WITHOUT a tenant context.
//
// Used by the per-API-key rate-limit middleware, which runs BEFORE the
// tenant middleware has bound app.tenant_id and therefore cannot use
// the tenant-scoped Get(). The query is gated by RLS policy
// api_keys_id_lookup (migration 0329), which uses app.api_key_id to
// expose exactly the one row matching the bound id and nothing else.
//
// Returns ErrNotFound when no row matches (including revoked keys —
// the RLS policy filters revoked_at IS NOT NULL).
func (r *Repo) LookupByID(ctx context.Context, id string) (*APIKey, error) {
	if id == "" {
		return nil, ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.api_key_id', $1, true)`, id); err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
SELECT `+keyColumns+`
FROM api_keys
WHERE id::text = $1 AND revoked_at IS NULL
LIMIT 1`, id)
	k, err := scanKey(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return k, nil
}

// TouchLastUsed best-effort updates last_used_at. Errors are swallowed by
// callers — middleware path must not block on it.
func (r *Repo) TouchLastUsed(ctx context.Context, id string) error {
	if id == "" {
		return ErrNotFound
	}
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.api_key_id', $1, true)`, id); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE api_keys SET last_used_at = $1 WHERE id::text = $2`,
		time.Now().UTC(), id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
