// SPDX-License-Identifier: AGPL-3.0-only
//
// portal.go — embeddable customer-facing audit portal session helpers
// (WorkOS Admin Portal pattern). audit-2026 (API, P1).
//
// Two flows:
//
//  1. Mint: an admin POSTs /api/v1/audit/portal/sessions; the handler
//     calls CreatePortalSession to mint a short-lived HMAC-SHA256 JWT
//     bound to (tenant_id, scope, exp). The JWT is returned to the
//     admin; only its sha256 hex digest is persisted in
//     audit_portal_sessions so a DB leak doesn't yield a valid token.
//
//  2. Exchange: the portal URL carries the bootstrap JWT only in its URL
//     fragment (which never reaches HTTP logs). The SPA removes the fragment
//     immediately and exchanges it once for a distinct HttpOnly cookie token.
//
//  3. Browse: portal-only endpoints validate the cookie token, resolve its
//     tenant, and expose only the read-only portal route set.
//
// We don't use a third-party JWT library to keep the API binary's
// dependency tree small — the wire shape (header.payload.signature
// with HMAC-SHA256 + base64url) is identical to the standard JWS
// compact serialization, just hand-rolled.
package audit

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DefaultSessionTTL is the default lifetime of a portal session JWT
// when the caller doesn't pass an explicit TTL. 30 minutes balances
// the audit gap-doc's "must be short-lived" guidance against the UX
// reality that a customer support call can run that long without
// requiring a re-mint.
const DefaultSessionTTL = 30 * time.Minute

// MaxSessionTTL is the upper bound on caller-supplied TTLs. Beyond
// this an attacker who exfiltrates a portal_url at minute 0 still
// can't use it indefinitely.
const MaxSessionTTL = 24 * time.Hour

// PortalScope is the default JWT scope. Today only audit:read is ever
// minted into a portal session; the scope column on
// audit_portal_sessions exists for forward-compatibility with
// per-sub-tenant carve-outs.
const PortalScope = "audit:read"

// portalJWTIssuer is embedded in the JWT payload's `iss` claim so a
// validator can distinguish portal tokens from other HMAC JWTs in the
// same secret namespace.
const portalJWTIssuer = "postwave-audit-portal"

const (
	portalPurposeBootstrap = "bootstrap"
	portalPurposeSession   = "session"
)

// SessionPayload is the validated portal-session claim set returned by
// ValidatePortalSessionJWT. Handlers read .TenantID to scope DB
// queries via WithTenant.
type SessionPayload struct {
	TenantID    string    `json:"tenant_id"`
	SubTenantID string    `json:"sub_tenant_id,omitempty"`
	Scope       string    `json:"scope"`
	SessionID   string    `json:"sid"`
	Purpose     string    `json:"purpose"`
	IssuedAt    time.Time `json:"-"`
	ExpiresAt   time.Time `json:"-"`
}

// CreatePortalSessionInput is the wire input to CreatePortalSession.
// All fields are optional except TenantID; TTL defaults to
// DefaultSessionTTL, Scope to PortalScope.
type CreatePortalSessionInput struct {
	TenantID    string
	SubTenantID string
	CreatedBy   string // user id of the admin minting the session (audit)
	TTL         time.Duration
}

// CreatedPortalSession is the wire output. PortalURL is
// "<origin>/portal/audit#bootstrap=<jwt>"; URL fragments are never sent in
// HTTP requests, and the SPA removes the fragment before doing any I/O.
type CreatedPortalSession struct {
	SessionID string    `json:"session_id"`
	Token     string    `json:"-"`
	PortalURL string    `json:"portal_url"`
	ExpiresAt time.Time `json:"expires_at"`
}

// PortalSessionDeps is what handlers wire into the package. Kept thin
// so it can be mocked in tests (the JWT round-trip is exercised in
// portal_test.go without touching the DB).
type PortalSessionDeps struct {
	Pool      *pgxpool.Pool
	Secret    []byte // HMAC secret. If empty, falls back to POSTWAVE_PORTAL_JWT_SECRET env.
	NowFn     func() time.Time
	OriginURL string // e.g. "https://app.postwave.io"; used to build portal_url.
}

// now returns the current time, honouring the optional injected clock.
func (d *PortalSessionDeps) now() time.Time {
	if d != nil && d.NowFn != nil {
		return d.NowFn()
	}
	return time.Now()
}

// secret resolves the HMAC secret, preferring an injected slice and
// falling back to POSTWAVE_PORTAL_JWT_SECRET. We deliberately do NOT
// fall through to a dev default so a misconfigured prod deploy fails
// closed (CreatePortalSession returns ErrSecretUnset) instead of
// minting tokens any attacker can forge.
func (d *PortalSessionDeps) secret() ([]byte, error) {
	if d != nil && len(d.Secret) > 0 {
		return d.Secret, nil
	}
	if v := strings.TrimSpace(os.Getenv("POSTWAVE_PORTAL_JWT_SECRET")); v != "" {
		return []byte(v), nil
	}
	return nil, ErrSecretUnset
}

// ErrSecretUnset signals a missing HMAC secret. Handlers translate
// this to HTTP 503 portal_unavailable.
var ErrSecretUnset = errors.New("audit portal: HMAC secret not configured")

// ErrInvalidToken signals the JWT failed signature / shape / expiry
// validation. Handlers translate this to HTTP 401 invalid_token.
var ErrInvalidToken = errors.New("audit portal: invalid token")

// ErrSessionRevoked signals the persisted session row has revoked_at
// set or expires_at in the past. Distinct from ErrInvalidToken so the
// handler can distinguish a forged token from a legit-but-expired one
// for UX purposes.
var ErrSessionRevoked = errors.New("audit portal: session revoked or expired")

// ErrBootstrapUsed deliberately covers used, unknown, revoked, and expired
// bootstrap credentials so callers cannot use the exchange endpoint as a
// portal-session oracle.
var ErrBootstrapUsed = errors.New("audit portal: bootstrap token is unavailable")

// ErrStoreUnavailable prevents a deployment without the durable one-time
// exchange store from silently degrading into a replayable bearer flow.
var ErrStoreUnavailable = errors.New("audit portal: session store unavailable")

// CreatePortalSession mints a new portal-session JWT and persists its
// metadata in audit_portal_sessions. The returned CreatedPortalSession
// carries the raw JWT (single use — never re-readable from the DB).
func CreatePortalSession(ctx context.Context, deps *PortalSessionDeps, in CreatePortalSessionInput) (*CreatedPortalSession, error) {
	if deps == nil {
		return nil, errors.New("audit portal: nil deps")
	}
	if strings.TrimSpace(in.TenantID) == "" {
		return nil, errors.New("audit portal: tenant_id required")
	}
	secret, err := deps.secret()
	if err != nil {
		return nil, err
	}
	ttl := in.TTL
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	if ttl > MaxSessionTTL {
		ttl = MaxSessionTTL
	}

	now := deps.now().UTC()
	exp := now.Add(ttl)
	sid, err := newRandomID()
	if err != nil {
		return nil, err
	}

	payload := SessionPayload{
		TenantID:    in.TenantID,
		SubTenantID: in.SubTenantID,
		Scope:       PortalScope,
		SessionID:   sid,
		Purpose:     portalPurposeBootstrap,
		IssuedAt:    now,
		ExpiresAt:   exp,
	}

	token, err := encodeJWT(secret, payload)
	if err != nil {
		return nil, fmt.Errorf("audit portal: encode jwt: %w", err)
	}
	tokenHash := hashToken(token)

	if deps.Pool != nil {
		tx, beginErr := deps.Pool.Begin(ctx)
		if beginErr != nil {
			return nil, fmt.Errorf("audit portal: begin tx: %w", beginErr)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, in.TenantID); err != nil {
			return nil, fmt.Errorf("audit portal: set tenant: %w", err)
		}
		var createdBy any
		if strings.TrimSpace(in.CreatedBy) != "" {
			createdBy = in.CreatedBy
		}
		var subTenantID any
		if strings.TrimSpace(in.SubTenantID) != "" {
			subTenantID = in.SubTenantID
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO audit_portal_sessions
       (id, tenant_id, token_hash, scope, sub_tenant_id, expires_at, created_by)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5::text, '')::uuid, $6, NULLIF($7::text, '')::uuid)`,
			sid, in.TenantID, tokenHash, PortalScope, subTenantID, exp, createdBy,
		); err != nil {
			return nil, fmt.Errorf("audit portal: insert session: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("audit portal: commit: %w", err)
		}
	}

	out := &CreatedPortalSession{
		SessionID: sid,
		Token:     token,
		ExpiresAt: exp,
		PortalURL: BuildPortalURL(deps.OriginURL, token),
	}
	return out, nil
}

// ValidatePortalSessionJWT verifies signature + expiry + DB revocation
// status. Returns the resolved SessionPayload on success.
func ValidatePortalSessionJWT(ctx context.Context, deps *PortalSessionDeps, token string) (*SessionPayload, error) {
	if deps == nil {
		return nil, errors.New("audit portal: nil deps")
	}
	secret, err := deps.secret()
	if err != nil {
		return nil, err
	}
	payload, err := decodeJWT(secret, token)
	if err != nil || payload.Purpose != portalPurposeBootstrap {
		return nil, ErrInvalidToken
	}
	now := deps.now().UTC()
	if !payload.ExpiresAt.IsZero() && now.After(payload.ExpiresAt) {
		return nil, ErrSessionRevoked
	}

	if deps.Pool != nil {
		tx, beginErr := deps.Pool.Begin(ctx)
		if beginErr != nil {
			return nil, fmt.Errorf("audit portal: begin tx: %w", beginErr)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, payload.TenantID); err != nil {
			return nil, fmt.Errorf("audit portal: set tenant: %w", err)
		}
		var revokedAt *time.Time
		var expiresAt time.Time
		if err := tx.QueryRow(ctx, `
SELECT revoked_at, expires_at
  FROM audit_portal_sessions
 WHERE token_hash = $1 AND id = $2::uuid AND tenant_id = $3::uuid
   AND exchanged_at IS NULL
 LIMIT 1`, hashToken(token), payload.SessionID, payload.TenantID).Scan(&revokedAt, &expiresAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrInvalidToken
			}
			return nil, fmt.Errorf("audit portal: lookup session: %w", err)
		}
		if revokedAt != nil || now.After(expiresAt) {
			return nil, ErrSessionRevoked
		}
		_ = tx.Commit(ctx)
	}
	return payload, nil
}

// ExchangePortalBootstrap atomically consumes a bootstrap credential and
// mints a distinct cookie credential. The raw cookie token is returned once
// to the HTTP layer and only its digest is persisted.
func ExchangePortalBootstrap(ctx context.Context, deps *PortalSessionDeps, token, ip string) (string, *SessionPayload, error) {
	if deps == nil || deps.Pool == nil {
		return "", nil, ErrStoreUnavailable
	}
	secret, err := deps.secret()
	if err != nil {
		return "", nil, err
	}
	payload, err := decodeJWT(secret, token)
	if err != nil || payload.Purpose != portalPurposeBootstrap {
		return "", nil, ErrBootstrapUsed
	}
	now := deps.now().UTC()
	if !now.Before(payload.ExpiresAt) {
		return "", nil, ErrBootstrapUsed
	}

	sessionPayload := *payload
	sessionPayload.Purpose = portalPurposeSession
	sessionPayload.IssuedAt = now
	sessionToken, err := encodeJWT(secret, sessionPayload)
	if err != nil {
		return "", nil, fmt.Errorf("audit portal: encode session jwt: %w", err)
	}
	ip = strings.TrimSpace(ip)
	if ip != "" && net.ParseIP(ip) == nil {
		ip = ""
	}

	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return "", nil, fmt.Errorf("audit portal: begin exchange tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, payload.TenantID); err != nil {
		return "", nil, fmt.Errorf("audit portal: set exchange tenant: %w", err)
	}
	var expiresAt time.Time
	err = tx.QueryRow(ctx, `
UPDATE audit_portal_sessions
   SET exchanged_at = $4,
       session_token_hash = $5,
       accessed_at = COALESCE(accessed_at, $4),
       ip_accessed = COALESCE(ip_accessed, NULLIF($6, '')::inet)
 WHERE token_hash = $1
   AND id = $2::uuid
   AND tenant_id = $3::uuid
   AND scope = 'audit:read'
   AND revoked_at IS NULL
   AND exchanged_at IS NULL
   AND expires_at > $4
 RETURNING expires_at`, hashToken(token), payload.SessionID, payload.TenantID,
		now, hashToken(sessionToken), ip).Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrBootstrapUsed
	}
	if err != nil {
		return "", nil, fmt.Errorf("audit portal: consume bootstrap: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", nil, fmt.Errorf("audit portal: commit exchange: %w", err)
	}
	sessionPayload.ExpiresAt = expiresAt.UTC()
	return sessionToken, &sessionPayload, nil
}

// ValidatePortalCookie validates the HttpOnly portal credential and its
// persisted revocation/expiry state, returning the exact tenant it may read.
func ValidatePortalCookie(ctx context.Context, deps *PortalSessionDeps, token string) (*SessionPayload, error) {
	if deps == nil || deps.Pool == nil {
		return nil, ErrStoreUnavailable
	}
	secret, err := deps.secret()
	if err != nil {
		return nil, err
	}
	payload, err := decodeJWT(secret, token)
	if err != nil || payload.Purpose != portalPurposeSession {
		return nil, ErrInvalidToken
	}
	now := deps.now().UTC()
	if !now.Before(payload.ExpiresAt) {
		return nil, ErrSessionRevoked
	}

	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("audit portal: begin cookie tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, payload.TenantID); err != nil {
		return nil, fmt.Errorf("audit portal: set cookie tenant: %w", err)
	}
	var (
		expiresAt   time.Time
		revokedAt   *time.Time
		scope       string
		subTenantID string
	)
	err = tx.QueryRow(ctx, `
SELECT expires_at, revoked_at, scope, COALESCE(sub_tenant_id::text, '')
  FROM audit_portal_sessions
 WHERE session_token_hash = $1
   AND id = $2::uuid
   AND tenant_id = $3::uuid
   AND exchanged_at IS NOT NULL
 LIMIT 1`, hashToken(token), payload.SessionID, payload.TenantID).
		Scan(&expiresAt, &revokedAt, &scope, &subTenantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidToken
	}
	if err != nil {
		return nil, fmt.Errorf("audit portal: lookup cookie session: %w", err)
	}
	if revokedAt != nil || !now.Before(expiresAt) {
		return nil, ErrSessionRevoked
	}
	if scope != PortalScope || scope != payload.Scope || subTenantID != payload.SubTenantID {
		return nil, ErrInvalidToken
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("audit portal: commit cookie validation: %w", err)
	}
	payload.ExpiresAt = expiresAt.UTC()
	return payload, nil
}

type portalSessionContextKey struct{}

func WithPortalSession(ctx context.Context, payload *SessionPayload) context.Context {
	if payload == nil {
		return ctx
	}
	copy := *payload
	return context.WithValue(ctx, portalSessionContextKey{}, &copy)
}

func PortalSessionFromContext(ctx context.Context) (*SessionPayload, bool) {
	payload, ok := ctx.Value(portalSessionContextKey{}).(*SessionPayload)
	return payload, ok && payload != nil
}

// RevokePortalSession marks revoked_at = now() for a session. Used by
// the admin "Revoke link" affordance.
func RevokePortalSession(ctx context.Context, deps *PortalSessionDeps, tenantID, sessionID string) error {
	if deps == nil || deps.Pool == nil {
		return ErrStoreUnavailable
	}
	tx, err := deps.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("audit portal: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE audit_portal_sessions
   SET revoked_at = now()
 WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL`,
		sessionID, tenantID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// BuildPortalURL composes the customer-visible URL.
//   - When origin is empty we fall back to a relative path so the
//     handler still returns a sane string in dev.
func BuildPortalURL(origin, token string) string {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	if origin == "" {
		return "/portal/audit#bootstrap=" + url.QueryEscape(token)
	}
	return origin + "/portal/audit#bootstrap=" + url.QueryEscape(token)
}

// hashToken returns sha256 hex of the JWT. Used as the persisted
// lookup key — we never store the raw JWT.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newRandomID returns a 16-byte cryptographically random ID encoded
// as a UUIDv4-shaped hex string. Suffices as audit_portal_sessions.id
// when the migration-default DEFAULT gen_random_uuid() isn't desired
// for tests.
func newRandomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("audit portal: random session id: %w", err)
	}
	// Set variant/version bits to look like a v4 UUID.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

/* ----------------------------- JWS codec ------------------------------ */

// jwtHeader is the static header shared by every portal JWT.
type jwtHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

// jwtPayloadWire is the on-the-wire claim set. Times serialise as unix
// seconds per RFC 7519 nbf/exp convention.
type jwtPayloadWire struct {
	Iss         string `json:"iss"`
	Sub         string `json:"sub"`
	Scope       string `json:"scope"`
	TenantID    string `json:"tenant_id"`
	SubTenantID string `json:"sub_tenant_id,omitempty"`
	IssuedAt    int64  `json:"iat"`
	ExpiresAt   int64  `json:"exp"`
	SessionID   string `json:"sid"`
	Purpose     string `json:"purpose"`
}

func encodeJWT(secret []byte, payload SessionPayload) (string, error) {
	header := jwtHeader{Alg: "HS256", Typ: "JWT"}
	hb, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	wire := jwtPayloadWire{
		Iss:         portalJWTIssuer,
		Sub:         payload.TenantID,
		Scope:       payload.Scope,
		TenantID:    payload.TenantID,
		SubTenantID: payload.SubTenantID,
		IssuedAt:    payload.IssuedAt.Unix(),
		ExpiresAt:   payload.ExpiresAt.Unix(),
		SessionID:   payload.SessionID,
		Purpose:     payload.Purpose,
	}
	pb, err := json.Marshal(wire)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(hb) + "." + enc.EncodeToString(pb)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	sig := enc.EncodeToString(mac.Sum(nil))
	return signingInput + "." + sig, nil
}

func decodeJWT(secret []byte, token string) (*SessionPayload, error) {
	if len(token) == 0 || len(token) > 2048 {
		return nil, ErrInvalidToken
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return nil, ErrInvalidToken
	}
	enc := base64.RawURLEncoding
	hb, err := enc.DecodeString(parts[0])
	if err != nil {
		return nil, ErrInvalidToken
	}
	var header jwtHeader
	if err := json.Unmarshal(hb, &header); err != nil || header.Alg != "HS256" || header.Typ != "JWT" {
		return nil, ErrInvalidToken
	}
	signingInput := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signingInput))
	want := enc.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[2])) {
		return nil, ErrInvalidToken
	}
	pb, err := enc.DecodeString(parts[1])
	if err != nil {
		return nil, ErrInvalidToken
	}
	var wire jwtPayloadWire
	if err := json.Unmarshal(pb, &wire); err != nil {
		return nil, ErrInvalidToken
	}
	if wire.Iss != portalJWTIssuer || wire.Sub != wire.TenantID {
		return nil, ErrInvalidToken
	}
	if strings.TrimSpace(wire.TenantID) == "" ||
		strings.TrimSpace(wire.SessionID) == "" ||
		wire.Scope != PortalScope ||
		(wire.Purpose != portalPurposeBootstrap && wire.Purpose != portalPurposeSession) ||
		wire.IssuedAt <= 0 || wire.ExpiresAt <= wire.IssuedAt ||
		wire.ExpiresAt-wire.IssuedAt > int64(MaxSessionTTL/time.Second) {
		return nil, ErrInvalidToken
	}
	out := &SessionPayload{
		TenantID:    wire.TenantID,
		SubTenantID: wire.SubTenantID,
		Scope:       wire.Scope,
		SessionID:   wire.SessionID,
		Purpose:     wire.Purpose,
		IssuedAt:    time.Unix(wire.IssuedAt, 0).UTC(),
		ExpiresAt:   time.Unix(wire.ExpiresAt, 0).UTC(),
	}
	return out, nil
}
