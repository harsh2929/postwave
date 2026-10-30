// SPDX-License-Identifier: AGPL-3.0-only
//
// device_trust.go — the credential half of AUTH#48 "remember this device".
//
// ── WHAT THIS DELIBERATELY WEAKENS ─────────────────────────────────────────
// MFA exists so that a stolen password is not enough. Device trust says: on
// THIS device, for a bounded window, it is. That is a real reduction in
// security, approved by the product owner with a hard cap, so everything in
// this file is written to make the reduction bounded, visible and revocable
// rather than convenient.
//
// ── THE THREE DURATIONS ARE A CONTRACT, NOT A DEFAULT ──────────────────────
// 30, 90 or 180 days. 180 is the maximum. There is no custom entry, no
// "forever", and no longer option. The set is enforced in THREE independent
// places so no single mistake can widen it:
//
//  1. AllowedTrustDays / IsAllowedTrustDays here, checked by the handler
//     BEFORE the TOTP code is consumed (so a rejected request does not burn
//     a recovery code).
//  2. A CHECK constraint on auth_trusted_devices.trust_days (migration 1844),
//     which no code path can route around.
//  3. The clients read the set off the wire (GET /auth/trusted-devices
//     returns allowed_durations) instead of hard-coding their own picker, so
//     a client cannot drift.
//
// ── THE TRUST TOKEN IS NOT THE SESSION COOKIE ──────────────────────────────
// It is a second, independent client credential:
//
//   - Its own cookie name (pw_device_trust), so it is never confused with
//     pw_session by a proxy, a client, or a logout that clears one of them.
//   - Its own random (id, verifier) pair. The verifier is 32 fresh random
//     bytes and is not derived from — and cannot be computed from — anything
//     in the session cookie. Stealing pw_session therefore does not yield a
//     trust credential, which matters because the trust credential is the
//     stronger one: it survives the session.
//   - Its own HMAC pepper. Configure it explicitly (Repo.TrustPepper) or let
//     it fall back to a domain-separated derivation of the session pepper.
//     Either way the two hash spaces are disjoint, so a verifier_hash lifted
//     from auth_sessions is not a valid auth_trusted_devices.verifier_hash
//     and vice versa. TestDeviceTrustPepperIsDisjointFromSessionPepper pins
//     that.
//
// ── EXPIRY IS ABSOLUTE ─────────────────────────────────────────────────────
// The cookie MaxAge and the row's expires_at are both fixed at issuance.
// Consumption touches last_used_at only. A device that is used every day for
// six months stops being trusted on day 180 like every other one.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// TrustCookieName is the device-trust credential's cookie. Deliberately a
// different name from SessionCookieName: the two have different lifetimes and
// different revocation surfaces, and logout must be able to end one without
// touching the other.
const TrustCookieName = "pw_device_trust"

// AllowedTrustDays is the COMPLETE set of trust durations. The product owner
// approved exactly these three; 180 is the maximum. Do not widen this, and do
// not add a custom escape hatch — the database CHECK constraint in migration
// 1844 will reject anything else anyway, as a bare 500 rather than a clean 400.
var AllowedTrustDays = []int{30, 90, 180}

// MaxTrustDays restates the ceiling as a constant so a reader does not have to
// infer it from the slice, and so a test can assert the two agree.
const MaxTrustDays = 180

// DefaultTrustDays is what a client should preselect when it offers the
// choice. The SHORTEST option, on purpose: the safe default for a feature
// whose entire job is to reduce how often MFA is enforced.
const DefaultTrustDays = 30

// MaxTrustedDevicesPerUser bounds how many live trust records one user can
// accumulate. Not a security boundary — each record is independently
// revocable and expiring — but an unbounded list is a list nobody reads, and
// the devices screen is the only place this credential is visible.
const MaxTrustedDevicesPerUser = 10

// ErrNoTrustCookie / ErrInvalidTrustCookie mirror the session cookie's
// sentinels. Both are treated identically by the consumption path (no trust),
// but they are distinct so a caller can tell "never trusted" from "tampered".
var (
	ErrNoTrustCookie      = errors.New("no device trust cookie")
	ErrInvalidTrustCookie = errors.New("invalid device trust token")
)

// IsAllowedTrustDays reports whether days is one of the three approved
// durations. Total and allocation-free; the handler calls it before doing any
// work so an out-of-range request costs nothing.
func IsAllowedTrustDays(days int) bool {
	for _, allowed := range AllowedTrustDays {
		if days == allowed {
			return true
		}
	}
	return false
}

// TrustToken is the (id, verifier) pair encoded into the trust cookie. Same
// shape as SessionToken, deliberately a DIFFERENT type: passing one where the
// other is expected is then a compile error rather than a silent credential
// confusion.
type TrustToken struct {
	ID       string // opaque PK, stored verbatim in auth_trusted_devices.id
	Verifier string // base64url; never persisted, only its peppered HMAC
}

// String renders the cookie value: <id>.<verifier>.
func (t TrustToken) String() string { return t.ID + "." + t.Verifier }

// IssueTrustToken mints a fresh (id, verifier). The verifier is 32 bytes of
// crypto/rand — independent of the session token, so possession of one says
// nothing about the other.
func IssueTrustToken() (TrustToken, error) {
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return TrustToken{}, fmt.Errorf("trust id: %w", err)
	}
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return TrustToken{}, fmt.Errorf("trust verifier: %w", err)
	}
	return TrustToken{
		ID:       base64.RawURLEncoding.EncodeToString(idBytes),
		Verifier: base64.RawURLEncoding.EncodeToString(verifierBytes),
	}, nil
}

// deviceTrustPepperLabel domain-separates the derived trust pepper from the
// session pepper. Versioned so a future rotation can introduce v2 alongside.
const deviceTrustPepperLabel = "postwave/auth/device-trust/v1"

// DeriveTrustPepper produces the device-trust pepper from the session pepper
// by domain separation. Used only when no explicit trust pepper is configured,
// so an existing deployment gains the feature without a new secret while still
// getting a hash space that is disjoint from the session one.
//
// This is safe because the input is a SERVER secret, not the session cookie:
// an attacker holding pw_session learns nothing about either pepper. What the
// brief forbids — deriving the trust credential from the session credential —
// is not what happens here; the trust verifier is independent randomness.
func DeriveTrustPepper(sessionPepper []byte) []byte {
	h := hmac.New(sha256.New, sessionPepper)
	h.Write([]byte(deviceTrustPepperLabel))
	return h.Sum(nil)
}

// HashTrustVerifier returns HMAC-SHA256(verifier, trustPepper). This is what
// goes in auth_trusted_devices.verifier_hash.
func HashTrustVerifier(verifier string, trustPepper []byte) []byte {
	h := hmac.New(sha256.New, trustPepper)
	h.Write([]byte(verifier))
	return h.Sum(nil)
}

// VerifyTrustVerifier compares a cookie-supplied verifier against the stored
// hash in constant time.
func VerifyTrustVerifier(verifier string, storedHash, trustPepper []byte) bool {
	got := HashTrustVerifier(verifier, trustPepper)
	return subtle.ConstantTimeCompare(got, storedHash) == 1
}

// ParseTrustCookie extracts (id, verifier) from a request. Returns
// ErrNoTrustCookie when the cookie is absent — the overwhelmingly common case,
// since most logins are from untrusted devices — and ErrInvalidTrustCookie
// when it is present but malformed.
func ParseTrustCookie(r *http.Request) (TrustToken, error) {
	c, err := r.Cookie(TrustCookieName)
	if err != nil {
		return TrustToken{}, ErrNoTrustCookie
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return TrustToken{}, ErrInvalidTrustCookie
	}
	if _, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil {
		return TrustToken{}, ErrInvalidTrustCookie
	}
	if _, err := base64.RawURLEncoding.DecodeString(parts[1]); err != nil {
		return TrustToken{}, ErrInvalidTrustCookie
	}
	return TrustToken{ID: parts[0], Verifier: parts[1]}, nil
}

// SetTrustCookie writes the trust credential. Attributes mirror the session
// cookie (HttpOnly + Secure + SameSite) but the MaxAge is the CHOSEN trust
// window, not the session lifetime — the browser drops it at the same instant
// the server row expires, so a stale cookie is never presented.
func SetTrustCookie(w http.ResponseWriter, tok TrustToken, opts CookieOptions, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- HttpOnly/SameSite are explicit; Secure defaults true and only drops under explicit local-dev settings
		Name:     TrustCookieName,
		Value:    tok.String(),
		Path:     "/",
		Domain:   opts.Domain,
		MaxAge:   int(ttl.Seconds()),
		Secure:   opts.Secure,
		HttpOnly: true,
		SameSite: opts.SameSite,
	})
}

// ClearTrustCookie expires the trust cookie in place. Written whenever the
// record behind it is revoked from this device, so the client stops presenting
// a credential the server will refuse.
func ClearTrustCookie(w http.ResponseWriter, opts CookieOptions) {
	http.SetCookie(w, &http.Cookie{ // #nosec G124 -- deletion mirrors the production-safe attributes of the cookie being cleared
		Name:     TrustCookieName,
		Value:    "",
		Path:     "/",
		Domain:   opts.Domain,
		MaxAge:   -1,
		Secure:   opts.Secure,
		HttpOnly: true,
		SameSite: opts.SameSite,
	})
}

// TrustDuration converts an approved day count into a duration. Returns
// (0, false) for anything outside the approved set, so a caller that forgets
// to validate cannot accidentally mint an unbounded window.
func TrustDuration(days int) (time.Duration, bool) {
	if !IsAllowedTrustDays(days) {
		return 0, false
	}
	return time.Duration(days) * 24 * time.Hour, true
}
