// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// ErrInvalidToken is returned for every rejection reason. Callers answering an
// unauthenticated GET must not learn WHICH check failed — the difference
// between "bad signature" and "expired" is an oracle for probing the scheme.
var ErrInvalidToken = errors.New("honeypot token is not valid")

// ErrInvalidInput marks a caller mistake at mint time, where detail is safe
// and useful because the caller is our own sending path.
var ErrInvalidInput = errors.New("invalid honeypot input")

const (
	// TokenContractV1 is carried inside the payload so a future scheme can be
	// distinguished from a forgery rather than guessed at.
	TokenContractV1 = "pw.hp.v1"

	// TokenLifetime bounds how long a decoy stays admissible. A URL sits in a
	// mailbox forever; without a bound the corpus would keep accruing labels
	// from archived mail long after the scanner population it measured stopped
	// existing, and a 2026 recall figure would quietly rest on 2029 fetches.
	TokenLifetime = 90 * 24 * time.Hour

	// MaxClockSkew tolerates disagreement between the signing host and the
	// receiving host without letting a badly-skewed issuer mint a token that
	// outlives its window.
	MaxClockSkew = 10 * time.Minute

	// minSecretBytes keeps a deployment from signing with something guessable.
	minSecretBytes = 32
)

var (
	uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	hmacPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Claim is what a decoy URL asserts once its signature checks out.
//
// There is no recipient address here and there is no room for one. The decoy
// crosses every hop between us and the mailbox — including the security
// gateways whose behaviour we are trying to measure — so it carries the same
// recipient HMAC the rest of the engagement pipeline uses.
type Claim struct {
	TenantID              string    `json:"t"`
	CampaignID            string    `json:"c"`
	RecipientIdentityHMAC string    `json:"r"`
	Technique             Technique `json:"h"`
	IssuedAt              time.Time `json:"i"`
}

type wireClaim struct {
	Contract              string    `json:"v"`
	TenantID              string    `json:"t"`
	CampaignID            string    `json:"c"`
	RecipientIdentityHMAC string    `json:"r"`
	Technique             Technique `json:"h"`
	IssuedAtUnix          int64     `json:"i"`
}

// Minter signs and verifies decoy tokens. It holds no database handle on
// purpose: a send fans out to millions of recipients, and a scheme that needed
// a row per decoy would put a write in front of every message.
type Minter struct {
	secret []byte
	keyID  string
}

// NewMinter returns a Minter for one signing key. keyID travels in the token
// so a rotation can verify against the retired key while new mail is signed
// with the current one.
func NewMinter(secret []byte, keyID string) (*Minter, error) {
	if len(secret) < minSecretBytes {
		return nil, fmt.Errorf("%w: honeypot signing secret must be at least %d bytes", ErrInvalidInput, minSecretBytes)
	}
	if strings.TrimSpace(keyID) == "" {
		return nil, fmt.Errorf("%w: honeypot signing key id is required", ErrInvalidInput)
	}
	return &Minter{secret: append([]byte(nil), secret...), keyID: keyID}, nil
}

// Mint returns the opaque token for one decoy.
//
// It refuses a technique that can never certify a label. That refusal is the
// cheap place to catch the mistake: a decoy hidden a way a human can reach
// carries the spam-filter cost of hidden content and buys no evidence, so
// issuing one is pure downside.
func (m *Minter) Mint(claim Claim) (string, error) {
	if !uuidPattern.MatchString(claim.TenantID) {
		return "", fmt.Errorf("%w: honeypot tenant id must be a uuid", ErrInvalidInput)
	}
	if !uuidPattern.MatchString(claim.CampaignID) {
		return "", fmt.Errorf("%w: honeypot campaign id must be a uuid", ErrInvalidInput)
	}
	if !hmacPattern.MatchString(claim.RecipientIdentityHMAC) {
		return "", fmt.Errorf("%w: honeypot recipient identity must be a 64-character hex hmac", ErrInvalidInput)
	}
	if !claim.Technique.Certifies() {
		return "", fmt.Errorf(
			"%w: technique %q can never certify a machine label, so a decoy using it must not be issued",
			ErrInvalidInput, claim.Technique)
	}
	if claim.IssuedAt.IsZero() {
		return "", fmt.Errorf("%w: honeypot issue time is required", ErrInvalidInput)
	}

	payload, err := json.Marshal(wireClaim{
		Contract:              TokenContractV1,
		TenantID:              claim.TenantID,
		CampaignID:            claim.CampaignID,
		RecipientIdentityHMAC: claim.RecipientIdentityHMAC,
		Technique:             claim.Technique,
		IssuedAtUnix:          claim.IssuedAt.Unix(),
	})
	if err != nil {
		return "", fmt.Errorf("marshal honeypot claim: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + m.sign(encoded), nil
}

// Verify authenticates a token and returns its claim.
//
// Order matters: the signature is checked BEFORE the payload is interpreted,
// so unauthenticated bytes never reach the JSON decoder.
func (m *Minter) Verify(token string, now time.Time) (Claim, error) {
	encoded, signature, found := strings.Cut(token, ".")
	if !found {
		return Claim{}, ErrInvalidToken
	}
	if !hmac.Equal([]byte(signature), []byte(m.sign(encoded))) {
		return Claim{}, ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return Claim{}, ErrInvalidToken
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	// A signed token is ours, but an unknown field still means the sender and
	// the receiver disagree about the contract, and guessing is how a decoy
	// silently changes meaning across a deploy.
	decoder.DisallowUnknownFields()
	var wire wireClaim
	if err := decoder.Decode(&wire); err != nil {
		return Claim{}, ErrInvalidToken
	}
	if wire.Contract != TokenContractV1 {
		return Claim{}, ErrInvalidToken
	}

	issued := time.Unix(wire.IssuedAtUnix, 0).UTC()
	if now.Sub(issued) > TokenLifetime {
		return Claim{}, ErrInvalidToken
	}
	if issued.Sub(now) > MaxClockSkew {
		return Claim{}, ErrInvalidToken
	}
	return Claim{
		TenantID:              wire.TenantID,
		CampaignID:            wire.CampaignID,
		RecipientIdentityHMAC: wire.RecipientIdentityHMAC,
		Technique:             wire.Technique,
		IssuedAt:              issued,
	}, nil
}

// KeyID names the signing key in use, for rotation bookkeeping.
func (m *Minter) KeyID() string { return m.keyID }

func (m *Minter) sign(encodedPayload string) string {
	mac := hmac.New(sha256.New, m.secret)
	// The key id is signed rather than merely carried, so a token cannot be
	// re-attributed to a different key by editing it.
	mac.Write([]byte(TokenContractV1))
	mac.Write([]byte{0x1f})
	mac.Write([]byte(m.keyID))
	mac.Write([]byte{0x1f})
	mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
