// SPDX-License-Identifier: AGPL-3.0-only
//
// device_trust_repo.go — persistence for AUTH#48 device trust.
//
// Every statement here runs inside db.WithTenant. auth_trusted_devices has NO
// pre-tenant resolver policy (unlike auth_sessions) precisely so that these
// rows cannot be probed before the caller has proved who they are: the
// consumption path is reached only after a password / passkey / magic-link
// check has already resolved (tenant, user).
package auth

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TrustedDevice is the wire + storage projection of one auth_trusted_devices
// row. The verifier hash never leaves the repository.
type TrustedDevice struct {
	ID        string
	TenantID  string
	UserID    string
	Label     string
	UserAgent string
	IP        string
	TrustDays int
	IssuedAt  time.Time
	ExpiresAt time.Time
	// LastUsedAt is nil until the record has actually satisfied MFA once.
	// ABSENCE IS NOT ZERO: a nil here means "never used", which a client must
	// render as "not yet used", never as an epoch timestamp.
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// trustPepper resolves the device-trust HMAC pepper: the explicitly configured
// one when main.go wires a dedicated secret, otherwise a domain-separated
// derivation of the session pepper. Never the session pepper itself — the two
// hash spaces must not overlap.
func (r *Repo) trustPepper() []byte {
	if len(r.TrustPepper) > 0 {
		return r.TrustPepper
	}
	return DeriveTrustPepper(r.Pepper)
}

// deviceTrustAllowedTx reads the tenant's allow_trusted_devices policy inside
// an existing tenant-scoped transaction.
//
// A MISSING ROW MEANS ALLOWED. tenant_security_settings is created lazily the
// first time a workspace opens a security screen, so the overwhelming majority
// of tenants have no row at all; treating that as "denied" would make the
// approved feature unavailable to almost everyone. A row that exists is
// authoritative in both directions.
func deviceTrustAllowedTx(ctx context.Context, tx pgx.Tx, tenantID string) (bool, error) {
	var allowed bool
	err := tx.QueryRow(ctx, `
SELECT allow_trusted_devices
  FROM tenant_security_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return allowed, nil
}

// DeviceTrustAllowed reports whether this tenant permits device trust. Callers
// MUST treat an error as "do not proceed" rather than as false-y: a policy we
// could not read is not a policy that said yes.
func (r *Repo) DeviceTrustAllowed(ctx context.Context, tenantID string) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	allowed, err := deviceTrustAllowedTx(ctx, tx, tenantID)
	if err != nil {
		return false, err
	}
	return allowed, tx.Commit(ctx)
}

// CreateTrustedDevice persists a new trust record and returns the stored row.
//
// Two invariants are enforced here rather than left to the caller:
//
//   - trust_days is re-checked against the approved set. The handler already
//     validated it; this is the belt to the database CHECK's braces, and it
//     turns a programming mistake into a clear Go error instead of a 23514.
//   - the per-user cap is applied by REVOKING the oldest surplus records in
//     the same transaction, so the devices list cannot grow without bound and
//     the surplus is revoked (auditable) rather than deleted (invisible).
func (r *Repo) CreateTrustedDevice(
	ctx context.Context, d TrustedDevice, verifierHash []byte,
) (TrustedDevice, error) {
	if !IsAllowedTrustDays(d.TrustDays) {
		return TrustedDevice{}, errors.New("auth: trust_days must be 30, 90 or 180")
	}
	tx, err := db.WithTenant(ctx, r.Pool, d.TenantID)
	if err != nil {
		return TrustedDevice{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out TrustedDevice
	err = tx.QueryRow(ctx, `
INSERT INTO auth_trusted_devices (
    id, tenant_id, user_id, verifier_hash, trust_days,
    label, user_agent, ip, expires_at)
VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, NULLIF($8,'')::inet, $9)
RETURNING id, tenant_id::text, user_id::text, trust_days, label,
          COALESCE(user_agent,''), COALESCE(host(ip),''),
          issued_at, expires_at`,
		d.ID, d.TenantID, d.UserID, verifierHash, d.TrustDays,
		d.Label, d.UserAgent, d.IP, d.ExpiresAt).
		Scan(&out.ID, &out.TenantID, &out.UserID, &out.TrustDays, &out.Label,
			&out.UserAgent, &out.IP, &out.IssuedAt, &out.ExpiresAt)
	if err != nil {
		return TrustedDevice{}, err
	}

	// Revoke anything past the cap, oldest first. The row just inserted is the
	// newest, so it is never the one revoked.
	if _, err := tx.Exec(ctx, `
UPDATE auth_trusted_devices
   SET revoked_at = now()
 WHERE tenant_id = $1::uuid
   AND user_id = $2::uuid
   AND revoked_at IS NULL
   AND expires_at > now()
   AND id NOT IN (
       SELECT id FROM auth_trusted_devices
        WHERE tenant_id = $1::uuid
          AND user_id = $2::uuid
          AND revoked_at IS NULL
          AND expires_at > now()
        ORDER BY issued_at DESC, id DESC
        LIMIT $3
   )`, d.TenantID, d.UserID, MaxTrustedDevicesPerUser); err != nil {
		return TrustedDevice{}, err
	}
	return out, tx.Commit(ctx)
}

// ConsumeTrustedDevice is THE most dangerous query in this package: a true
// return value makes a brand new session MFA-satisfied without the user
// touching their authenticator. Everything it checks is therefore checked
// explicitly, in one transaction, and failure is always "no trust".
//
//	tenant + user must match       — a trust record belongs to one identity in
//	                                 one workspace; it never speaks for another.
//	verifier must match            — constant-time HMAC against the DEVICE-TRUST
//	                                 pepper, so a session verifier is useless.
//	revoked_at must be NULL        — revocation is immediate, not lazy.
//	expires_at must be in future   — absolute; see below.
//	tenant policy must still allow — a workspace that turns device trust off
//	                                 stops existing records working at once.
//
// On success it updates last_used_at ONLY. expires_at is never rewritten: a
// trust record must not be silently extended by being used, or a device used
// daily would be trusted forever and the 180-day ceiling would be fiction.
func (r *Repo) ConsumeTrustedDevice(
	ctx context.Context, tenantID, userID, id, verifier string,
) (bool, error) {
	if tenantID == "" || userID == "" || id == "" || verifier == "" {
		return false, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	allowed, err := deviceTrustAllowedTx(ctx, tx, tenantID)
	if err != nil {
		return false, err
	}
	if !allowed {
		return false, nil
	}

	var storedHash []byte
	var expiresAt time.Time
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `
SELECT verifier_hash, expires_at, revoked_at
  FROM auth_trusted_devices
 WHERE id = $1 AND tenant_id = $2::uuid AND user_id = $3::uuid
 FOR UPDATE`, id, tenantID, userID).Scan(&storedHash, &expiresAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// Constant-time, and BEFORE the state checks, so a caller cannot learn
	// whether an id exists by timing the expiry branch.
	if !VerifyTrustVerifier(verifier, storedHash, r.trustPepper()) {
		return false, nil
	}
	if revokedAt != nil {
		return false, nil
	}
	if !time.Now().Before(expiresAt) {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `
UPDATE auth_trusted_devices SET last_used_at = now() WHERE id = $1`, id); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ListTrustedDevices returns the caller's LIVE trust records, newest first.
// Revoked and expired rows are omitted: this list is the answer to "what can
// currently skip my second factor", and a dead row in it would misinform the
// only person who can act on it.
func (r *Repo) ListTrustedDevices(
	ctx context.Context, tenantID, userID string,
) ([]TrustedDevice, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, tenant_id::text, user_id::text, trust_days, label,
       COALESCE(user_agent,''), COALESCE(host(ip),''),
       issued_at, expires_at, last_used_at
  FROM auth_trusted_devices
 WHERE tenant_id = $1::uuid
   AND user_id = $2::uuid
   AND revoked_at IS NULL
   AND expires_at > now()
 ORDER BY issued_at DESC, id DESC
 LIMIT 200`, tenantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TrustedDevice{}
	for rows.Next() {
		var d TrustedDevice
		if err := rows.Scan(&d.ID, &d.TenantID, &d.UserID, &d.TrustDays, &d.Label,
			&d.UserAgent, &d.IP, &d.IssuedAt, &d.ExpiresAt, &d.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeTrustedDevice kills one record. Scoped to (tenant, user) so an id
// belonging to somebody else is indistinguishable from one that never existed
// — the same non-disclosure the session revoke path uses.
func (r *Repo) RevokeTrustedDevice(
	ctx context.Context, tenantID, userID, id string,
) (bool, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_trusted_devices
   SET revoked_at = now()
 WHERE id = $1
   AND tenant_id = $2::uuid
   AND user_id = $3::uuid
   AND revoked_at IS NULL`, id, tenantID, userID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// RevokeAllTrustedDevices is the panic button: after it returns, no device
// anywhere can skip this user's second factor. Returns how many records it
// killed so the UI can say what it did rather than claiming a vague success.
func (r *Repo) RevokeAllTrustedDevices(
	ctx context.Context, tenantID, userID string,
) (int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE auth_trusted_devices
   SET revoked_at = now()
 WHERE tenant_id = $1::uuid
   AND user_id = $2::uuid
   AND revoked_at IS NULL`, tenantID, userID)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
