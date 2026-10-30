// SPDX-License-Identifier: AGPL-3.0-only

package polls

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	linkTokenPrefix          = "pwpt3"
	confirmationTokenPrefix  = "pwpc1"
	linkTokenDomain          = "postwave.poll.link-token.v3"
	confirmationTokenDomain  = "postwave.poll.confirmation-token.v1"
	defaultLinkTokenValidity = 30 * 24 * time.Hour
	minimumLinkTokenValidity = time.Hour
	maximumLinkTokenValidity = 90 * 24 * time.Hour
	maximumTokenClockSkew    = 2 * time.Minute
	maximumEncodedTokenBytes = 4096
)

var tokenKeyIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,63}$`)

// TokenKey is one explicitly bounded poll signing key. Mint windows must not
// overlap. Verification windows normally do overlap so a newly active key can
// mint links while already-delivered links signed by its predecessor continue
// to work. RevokedAt is an emergency stop and overrides both windows.
type TokenKey struct {
	ID             string
	Secret         []byte
	MintNotBefore  time.Time
	MintNotAfter   time.Time
	VerifyNotAfter time.Time
	RevokedAt      *time.Time
}

// TokenKeyring is immutable process configuration. Selecting a mint key by the
// message's durable issued_at (rather than wall-clock retry time) makes the
// rendered MIME byte-stable across a delivery retry that straddles a cutover.
type TokenKeyring struct {
	ActiveKeyID string
	TokenTTL    time.Duration
	Keys        []TokenKey
}

func (ring TokenKeyring) Validate(now time.Time) error {
	now = now.UTC()
	if ring.TokenTTL < minimumLinkTokenValidity || ring.TokenTTL > maximumLinkTokenValidity {
		return fmt.Errorf("%w: poll token TTL must be between %s and %s",
			ErrInvalidConfiguration, minimumLinkTokenValidity, maximumLinkTokenValidity)
	}
	if !tokenKeyIDPattern.MatchString(ring.ActiveKeyID) {
		return fmt.Errorf("%w: active poll token key id is invalid", ErrInvalidConfiguration)
	}
	if len(ring.Keys) == 0 || len(ring.Keys) > 16 {
		return fmt.Errorf("%w: poll token keyring must contain 1..16 keys", ErrInvalidConfiguration)
	}
	seen := make(map[string]struct{}, len(ring.Keys))
	activeNow := ""
	for index, key := range ring.Keys {
		if !tokenKeyIDPattern.MatchString(key.ID) {
			return fmt.Errorf("%w: poll token key %d has an invalid id", ErrInvalidConfiguration, index)
		}
		if _, duplicate := seen[key.ID]; duplicate {
			return fmt.Errorf("%w: duplicate poll token key id %q", ErrInvalidConfiguration, key.ID)
		}
		seen[key.ID] = struct{}{}
		if len(key.Secret) < MinTokenSecretBytes {
			return fmt.Errorf("%w: poll token key %q must contain at least %d bytes",
				ErrInvalidConfiguration, key.ID, MinTokenSecretBytes)
		}
		if key.MintNotBefore.IsZero() || key.MintNotAfter.IsZero() || key.VerifyNotAfter.IsZero() ||
			!key.MintNotBefore.Before(key.MintNotAfter) ||
			key.VerifyNotAfter.Before(key.MintNotAfter.Add(ring.TokenTTL)) {
			return fmt.Errorf("%w: poll token key %q has unsafe mint/verification windows",
				ErrInvalidConfiguration, key.ID)
		}
		if key.RevokedAt != nil && key.RevokedAt.Before(key.MintNotBefore) {
			return fmt.Errorf("%w: poll token key %q is revoked before its mint window",
				ErrInvalidConfiguration, key.ID)
		}
		if keyCanMintAt(key, now) {
			if activeNow != "" {
				return fmt.Errorf("%w: poll token mint windows overlap for %q and %q",
					ErrInvalidConfiguration, activeNow, key.ID)
			}
			activeNow = key.ID
		}
		for otherIndex := 0; otherIndex < index; otherIndex++ {
			other := ring.Keys[otherIndex]
			if key.MintNotBefore.Before(other.MintNotAfter) && other.MintNotBefore.Before(key.MintNotAfter) {
				return fmt.Errorf("%w: poll token mint windows overlap for %q and %q",
					ErrInvalidConfiguration, other.ID, key.ID)
			}
		}
	}
	if activeNow == "" || activeNow != ring.ActiveKeyID {
		return fmt.Errorf("%w: active poll token key %q is not the sole key minting now",
			ErrInvalidConfiguration, ring.ActiveKeyID)
	}
	return nil
}

func keyCanMintAt(key TokenKey, at time.Time) bool {
	at = at.UTC()
	if at.Before(key.MintNotBefore.UTC()) || !at.Before(key.MintNotAfter.UTC()) {
		return false
	}
	return key.RevokedAt == nil || at.Before(key.RevokedAt.UTC())
}

func keyCanVerifyAt(key TokenKey, at time.Time) bool {
	at = at.UTC()
	if !at.Before(key.VerifyNotAfter.UTC()) {
		return false
	}
	return key.RevokedAt == nil || at.Before(key.RevokedAt.UTC())
}

func (ring TokenKeyring) keyByID(id string) (TokenKey, bool) {
	for _, key := range ring.Keys {
		if key.ID == id {
			key.Secret = append([]byte(nil), key.Secret...)
			return key, true
		}
	}
	return TokenKey{}, false
}

func (ring TokenKeyring) mintKey(at time.Time) (TokenKey, error) {
	var selected *TokenKey
	for _, key := range ring.Keys {
		if !keyCanMintAt(key, at) {
			continue
		}
		if selected != nil {
			return TokenKey{}, fmt.Errorf("%w: more than one poll token key can mint at issued_at",
				ErrInvalidConfiguration)
		}
		copyKey := key
		selected = &copyKey
	}
	if selected == nil {
		return TokenKey{}, fmt.Errorf("%w: no non-revoked poll token key covers issued_at",
			ErrInvalidConfiguration)
	}
	selected.Secret = append([]byte(nil), selected.Secret...)
	return *selected, nil
}

// LinkTokenInput is the complete immutable capability boundary.
type LinkTokenInput struct {
	TenantID           string
	PollKey            string
	OptionKey          string
	RecipientReference string
	ContentRevisionID  string
	IssuedAt           time.Time
	ExpiresAt          time.Time
}

type linkTokenClaims struct {
	Version           int    `json:"v"`
	KeyID             string `json:"kid"`
	TenantID          string `json:"tenant_id"`
	PollKey           string `json:"poll_key"`
	OptionKey         string `json:"option_key"`
	RecipientSHA256   string `json:"recipient_sha256"`
	ContentRevisionID string `json:"content_revision_id"`
	IssuedAt          int64  `json:"issued_at"`
	ExpiresAt         int64  `json:"expires_at"`
}

func canonicalLinkTokenInput(input LinkTokenInput) (LinkTokenInput, error) {
	input.TenantID = strings.ToLower(strings.TrimSpace(input.TenantID))
	input.PollKey = strings.TrimSpace(input.PollKey)
	input.OptionKey = strings.TrimSpace(input.OptionKey)
	input.RecipientReference = strings.TrimSpace(input.RecipientReference)
	input.ContentRevisionID = strings.ToLower(strings.TrimSpace(input.ContentRevisionID))
	input.IssuedAt = input.IssuedAt.UTC().Truncate(time.Second)
	input.ExpiresAt = input.ExpiresAt.UTC().Truncate(time.Second)
	if parsed, err := uuid.Parse(input.TenantID); err != nil || parsed.String() != input.TenantID {
		return LinkTokenInput{}, ErrUnknownToken
	}
	if parsed, err := uuid.Parse(input.ContentRevisionID); err != nil || parsed.String() != input.ContentRevisionID {
		return LinkTokenInput{}, ErrUnknownToken
	}
	if input.PollKey == "" || len(input.PollKey) > 256 || input.OptionKey == "" || len(input.OptionKey) > 128 ||
		!opaqueRecipientReference.MatchString(input.RecipientReference) || input.IssuedAt.IsZero() ||
		!input.ExpiresAt.After(input.IssuedAt) {
		return LinkTokenInput{}, ErrUnknownToken
	}
	return input, nil
}

func recipientReferenceSHA256(reference string) string {
	digest := sha256.Sum256([]byte("postwave.poll.recipient-reference.v3\x00" + reference))
	return hex.EncodeToString(digest[:])
}

func pollRecipientHash(tenantID, pollKey, contentRevisionID, reference string) string {
	digest := sha256.Sum256([]byte("postwave.poll.response-recipient.v3\x00" + tenantID + "\x00" +
		pollKey + "\x00" + contentRevisionID + "\x00" + reference))
	return hex.EncodeToString(digest[:])
}

func (r *Repo) MintToken(input LinkTokenInput) (string, error) {
	if err := r.validateTokenKeyring(); err != nil {
		return "", err
	}
	input, err := canonicalLinkTokenInput(input)
	if err != nil {
		return "", err
	}
	if input.ExpiresAt.Sub(input.IssuedAt) > r.TokenKeyring.TokenTTL ||
		input.ExpiresAt.Sub(input.IssuedAt) < time.Second || !r.now().Before(input.ExpiresAt) ||
		input.IssuedAt.After(r.now().Add(maximumTokenClockSkew)) {
		return "", ErrUnknownToken
	}
	key, err := r.TokenKeyring.mintKey(input.IssuedAt)
	if err != nil {
		return "", err
	}
	if !keyCanVerifyAt(key, r.now()) || input.ExpiresAt.After(key.VerifyNotAfter.UTC()) {
		return "", fmt.Errorf("%w: poll token key cannot verify for the requested lifetime",
			ErrInvalidConfiguration)
	}
	claims := linkTokenClaims{
		Version: 3, KeyID: key.ID, TenantID: input.TenantID, PollKey: input.PollKey,
		OptionKey: input.OptionKey, RecipientSHA256: recipientReferenceSHA256(input.RecipientReference),
		ContentRevisionID: input.ContentRevisionID,
		IssuedAt:          input.IssuedAt.Unix(), ExpiresAt: input.ExpiresAt.Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := signToken(linkTokenDomain, key.ID, encoded, key.Secret)
	return strings.Join([]string{linkTokenPrefix, key.ID, encoded,
		base64.RawURLEncoding.EncodeToString(signature)}, "."), nil
}

func signToken(domain, keyID, payload string, secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(domain))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(keyID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(payload))
	return mac.Sum(nil)
}

func strictTokenJSON(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing token data")
	}
	return nil
}

func (r *Repo) verifyLinkToken(token string, expected LinkTokenInput) (linkTokenClaims, error) {
	if err := r.validateTokenKeyring(); err != nil {
		return linkTokenClaims{}, err
	}
	if len(token) > maximumEncodedTokenBytes {
		return linkTokenClaims{}, ErrUnknownToken
	}
	parts := strings.Split(token, ".")
	if len(parts) != 4 || parts[0] != linkTokenPrefix || !tokenKeyIDPattern.MatchString(parts[1]) {
		return linkTokenClaims{}, ErrUnknownToken
	}
	key, ok := r.TokenKeyring.keyByID(parts[1])
	if !ok || !keyCanVerifyAt(key, r.now()) {
		return linkTokenClaims{}, ErrUnknownToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || base64.RawURLEncoding.EncodeToString(signature) != parts[3] || len(signature) != sha256.Size ||
		!hmac.Equal(signature, signToken(linkTokenDomain, parts[1], parts[2], key.Secret)) {
		return linkTokenClaims{}, ErrUnknownToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || base64.RawURLEncoding.EncodeToString(payload) != parts[2] {
		return linkTokenClaims{}, ErrUnknownToken
	}
	var claims linkTokenClaims
	if err := strictTokenJSON(payload, &claims); err != nil {
		return linkTokenClaims{}, ErrUnknownToken
	}
	if claims.Version != 3 || claims.KeyID != parts[1] || claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt ||
		time.Unix(claims.ExpiresAt, 0).UTC().Sub(time.Unix(claims.IssuedAt, 0).UTC()) > r.TokenKeyring.TokenTTL ||
		!keyCanMintAt(key, time.Unix(claims.IssuedAt, 0).UTC()) ||
		time.Unix(claims.ExpiresAt, 0).UTC().After(key.VerifyNotAfter.UTC()) ||
		time.Unix(claims.IssuedAt, 0).UTC().After(r.now().Add(maximumTokenClockSkew)) ||
		!r.now().Before(time.Unix(claims.ExpiresAt, 0).UTC()) {
		return linkTokenClaims{}, ErrUnknownToken
	}
	expected.TenantID = strings.ToLower(strings.TrimSpace(expected.TenantID))
	expected.PollKey = strings.TrimSpace(expected.PollKey)
	expected.OptionKey = strings.TrimSpace(expected.OptionKey)
	expected.RecipientReference = strings.TrimSpace(expected.RecipientReference)
	expected.ContentRevisionID = strings.ToLower(strings.TrimSpace(expected.ContentRevisionID))
	if claims.TenantID != expected.TenantID || claims.PollKey != expected.PollKey ||
		claims.OptionKey != expected.OptionKey ||
		(expected.ContentRevisionID != "" && claims.ContentRevisionID != expected.ContentRevisionID) ||
		!hmac.Equal([]byte(claims.RecipientSHA256), []byte(recipientReferenceSHA256(expected.RecipientReference))) {
		return linkTokenClaims{}, ErrUnknownToken
	}
	if parsed, err := uuid.Parse(claims.TenantID); err != nil || parsed.String() != claims.TenantID {
		return linkTokenClaims{}, ErrUnknownToken
	}
	if parsed, err := uuid.Parse(claims.ContentRevisionID); err != nil || parsed.String() != claims.ContentRevisionID {
		return linkTokenClaims{}, ErrUnknownToken
	}
	return claims, nil
}

type confirmationClaims struct {
	Version         int    `json:"v"`
	KeyID           string `json:"kid"`
	LinkTokenSHA256 string `json:"link_token_sha256"`
	Nonce           string `json:"nonce"`
	IssuedAt        int64  `json:"issued_at"`
	ExpiresAt       int64  `json:"expires_at"`
}

func (r *Repo) mintConfirmationToken(linkToken string, link linkTokenClaims) (string, error) {
	key, ok := r.TokenKeyring.keyByID(link.KeyID)
	if !ok || !keyCanVerifyAt(key, r.now()) {
		return "", ErrUnknownToken
	}
	rawNonce := make([]byte, 32)
	if _, err := rand.Read(rawNonce); err != nil {
		return "", err
	}
	now := r.now().Truncate(time.Second)
	expires := now.Add(confirmationValidity)
	if linkExpiry := time.Unix(link.ExpiresAt, 0).UTC(); expires.After(linkExpiry) {
		expires = linkExpiry
	}
	if !expires.After(now) {
		return "", ErrUnknownToken
	}
	claims := confirmationClaims{
		Version: 1, KeyID: key.ID, LinkTokenSHA256: tokenHash(linkToken),
		Nonce:    base64.RawURLEncoding.EncodeToString(rawNonce),
		IssuedAt: now.Unix(), ExpiresAt: expires.Unix(),
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := signToken(confirmationTokenDomain, key.ID, encoded, key.Secret)
	return strings.Join([]string{confirmationTokenPrefix, key.ID, encoded,
		base64.RawURLEncoding.EncodeToString(signature)}, "."), nil
}

func (r *Repo) verifyConfirmationToken(token, linkToken string, link linkTokenClaims) error {
	if len(token) > maximumEncodedTokenBytes {
		return ErrConfirmationRequired
	}
	parts := strings.Split(token, ".")
	if len(parts) != 4 || parts[0] != confirmationTokenPrefix || parts[1] != link.KeyID {
		return ErrConfirmationRequired
	}
	key, ok := r.TokenKeyring.keyByID(parts[1])
	if !ok || !keyCanVerifyAt(key, r.now()) {
		return ErrConfirmationRequired
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || base64.RawURLEncoding.EncodeToString(signature) != parts[3] || len(signature) != sha256.Size ||
		!hmac.Equal(signature, signToken(confirmationTokenDomain, parts[1], parts[2], key.Secret)) {
		return ErrConfirmationRequired
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || base64.RawURLEncoding.EncodeToString(payload) != parts[2] {
		return ErrConfirmationRequired
	}
	var claims confirmationClaims
	if err := strictTokenJSON(payload, &claims); err != nil || claims.Version != 1 ||
		claims.KeyID != parts[1] || !isLowerHexSHA256(claims.LinkTokenSHA256) ||
		!hmac.Equal([]byte(claims.LinkTokenSHA256), []byte(tokenHash(linkToken))) ||
		claims.IssuedAt <= 0 || claims.ExpiresAt <= claims.IssuedAt ||
		time.Unix(claims.ExpiresAt, 0).UTC().Sub(time.Unix(claims.IssuedAt, 0).UTC()) > confirmationValidity ||
		time.Unix(claims.IssuedAt, 0).UTC().After(r.now().Add(maximumTokenClockSkew)) ||
		!r.now().Before(time.Unix(claims.ExpiresAt, 0).UTC()) {
		return ErrConfirmationRequired
	}
	nonce, err := base64.RawURLEncoding.DecodeString(claims.Nonce)
	if err != nil || len(nonce) != 32 || base64.RawURLEncoding.EncodeToString(nonce) != claims.Nonce {
		return ErrConfirmationRequired
	}
	return nil
}

func isLowerHexSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}
