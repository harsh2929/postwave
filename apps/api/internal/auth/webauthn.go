// SPDX-License-Identifier: AGPL-3.0-only
//
// AUTH-023 — WebAuthn / passkey plumbing. This file owns the go-webauthn
// relying-party config, the User adapter the library needs, and a STATELESS
// challenge codec: the per-ceremony SessionData is HMAC-signed (domain-
// separated from the magic-link signer) and round-tripped through a short-lived
// cookie, so no challenges table is needed and a challenge can only be spent on
// the same relying party that minted it.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// WebauthnCredential is a stored webauthn_credentials row (AUTH-023). Distinct
// from Credential (the auth_credentials password row).
type WebauthnCredential struct {
	ID             string     `json:"id"`
	UserID         string     `json:"-"`
	TenantID       string     `json:"-"`
	CredentialID   []byte     `json:"-"`
	PublicKey      []byte     `json:"-"`
	SignCount      int64      `json:"-"`
	AAGUID         []byte     `json:"-"`
	Transports     []string   `json:"transports,omitempty"`
	BackupEligible bool       `json:"backup_eligible"`
	BackupState    bool       `json:"backup_state"`
	Name           string     `json:"name"`
	CreatedAt      time.Time  `json:"created_at"`
	LastUsedAt     *time.Time `json:"last_used_at,omitempty"`
}

// rpDisplayName is the human-facing relying-party name shown by authenticators.
const rpDisplayName = "Moosewave"

// challengeCookieTTL bounds how long a begun ceremony can be finished.
const challengeCookieTTL = 5 * time.Minute

// newWebAuthn builds the relying-party config from the app's public base URL.
// RPID is the effective domain (host, no scheme/port) and the origin is the
// full base URL. An empty/invalid base URL is a wiring error, not a runtime one.
func NewWebAuthn(publicBaseURL string) (*webauthn.WebAuthn, error) {
	u, err := url.Parse(strings.TrimSpace(publicBaseURL))
	if err != nil || u.Host == "" {
		return nil, errors.New("auth: webauthn requires a valid PublicBaseURL")
	}
	return webauthn.New(&webauthn.Config{
		RPID:          u.Hostname(),
		RPDisplayName: rpDisplayName,
		RPOrigins:     []string{strings.TrimRight(u.Scheme+"://"+u.Host, "/")},
	})
}

// webauthnUser adapts a Moosewave user + their stored credentials to the
// go-webauthn User interface. WebAuthnID is the user's opaque handle (their
// UUID bytes) — the value the authenticator returns on a discoverable login.
type webauthnUser struct {
	id          []byte
	name        string
	displayName string
	creds       []webauthn.Credential
}

func (u *webauthnUser) WebAuthnID() []byte                         { return u.id }
func (u *webauthnUser) WebAuthnName() string                       { return u.name }
func (u *webauthnUser) WebAuthnDisplayName() string                { return u.displayName }
func (u *webauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// --- stored-credential <-> library-credential mapping ---

// toWebauthnCredential rebuilds the library credential from a stored row, with
// exactly the fields assertion verification needs (id, key, counter, aaguid,
// backup flags, transports).
func toWebauthnCredential(c WebauthnCredential) webauthn.Credential {
	transports := make([]protocol.AuthenticatorTransport, 0, len(c.Transports))
	for _, trans := range c.Transports {
		transports = append(transports, protocol.AuthenticatorTransport(trans))
	}
	wc := webauthn.Credential{
		ID:        c.CredentialID,
		PublicKey: c.PublicKey,
		Transport: transports,
	}
	wc.Authenticator.AAGUID = c.AAGUID
	if c.SignCount > math.MaxUint32 {
		// A persisted counter outside WebAuthn's uint32 domain is corrupt.
		// Saturate instead of wrapping to a smaller value, which could weaken
		// the authenticator-cloning signal during the next assertion.
		wc.Authenticator.SignCount = math.MaxUint32
	} else if c.SignCount >= 0 {
		wc.Authenticator.SignCount = uint32(c.SignCount)
	}
	wc.Flags.BackupEligible = c.BackupEligible
	wc.Flags.BackupState = c.BackupState
	return wc
}

// --- stateless signed-cookie challenge codec ---

// challengeKey domain-separates the WebAuthn challenge signer from every other
// use of the auth HMAC key.
func challengeKey(base []byte) []byte {
	m := hmac.New(sha256.New, base)
	m.Write([]byte("postwave.webauthn.challenge.v1"))
	return m.Sum(nil)
}

// challengeEnvelope is the signed cookie payload: the library SessionData plus
// the ceremony purpose, the user/tenant it was minted for (registration only),
// and an independent expiry. Binding purpose+user prevents a registration
// cookie from satisfying a login finish or being replayed under another session.
type challengeEnvelope struct {
	SD       webauthn.SessionData `json:"sd"`
	Purpose  string               `json:"p"`
	UserID   string               `json:"u,omitempty"`
	TenantID string               `json:"t,omitempty"`
	Exp      int64                `json:"e"`
}

// signChallenge serializes the envelope and returns "payload.mac" (base64url).
func signChallenge(base []byte, purpose, userID, tenantID string, sd *webauthn.SessionData, now time.Time) (string, error) {
	if len(base) == 0 {
		return "", errors.New("auth: webauthn challenge signing key not configured")
	}
	raw, err := json.Marshal(challengeEnvelope{
		SD: *sd, Purpose: purpose, UserID: userID, TenantID: tenantID,
		Exp: now.Add(challengeCookieTTL).Unix(),
	})
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding.EncodeToString(raw)
	return enc + "." + challengeMAC(base, enc), nil
}

// verifyChallenge validates the signature, purpose, and expiry, returning the
// SessionData and the bound user/tenant. A mangled/forged/wrong-purpose/expired
// token is rejected here (before go-webauthn re-validates the challenge nonce).
func verifyChallenge(base []byte, purpose, token string, now time.Time) (sd *webauthn.SessionData, userID, tenantID string, err error) {
	if len(base) == 0 || token == "" {
		return nil, "", "", errors.New("auth: missing webauthn challenge")
	}
	enc, mac, ok := strings.Cut(token, ".")
	if !ok || !hmac.Equal([]byte(mac), []byte(challengeMAC(base, enc))) {
		return nil, "", "", errors.New("auth: invalid webauthn challenge")
	}
	raw, derr := base64.RawURLEncoding.DecodeString(enc)
	if derr != nil {
		return nil, "", "", errors.New("auth: malformed webauthn challenge")
	}
	var env challengeEnvelope
	if uerr := json.Unmarshal(raw, &env); uerr != nil {
		return nil, "", "", uerr
	}
	if env.Purpose != purpose {
		return nil, "", "", errors.New("auth: webauthn challenge purpose mismatch")
	}
	if now.Unix() > env.Exp {
		return nil, "", "", errors.New("auth: webauthn challenge expired")
	}
	return &env.SD, env.UserID, env.TenantID, nil
}

func challengeMAC(base []byte, enc string) string {
	m := hmac.New(sha256.New, challengeKey(base))
	m.Write([]byte(enc))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// challengeNonceHash is the single-use key stored in webauthn_challenges — a
// plain SHA-256 of the ceremony challenge (not keyed; the value is already a
// high-entropy nonce and the table holds nothing else to protect).
func challengeNonceHash(challenge string) []byte {
	sum := sha256.Sum256([]byte(challenge))
	return sum[:]
}
