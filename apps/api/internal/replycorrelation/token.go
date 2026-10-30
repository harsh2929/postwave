// SPDX-License-Identifier: AGPL-3.0-only

// Package replycorrelation owns the compact, opaque reply-address token shared
// by canonical campaign send and inbound reply matching. A token contains no
// tenant, campaign, delivery, subscriber, or mailbox identifier. Those values
// are authenticated as associated data and recovered only through the durable
// send ledger.
package replycorrelation

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	Version           = 1
	TokenPrefix       = "reply+"
	TokenBytes        = 35
	ReferenceBytes    = 12
	MACBytes          = 16
	KeyTagBytes       = 2
	MaxLocalPartBytes = 64
	MinSecretBytes    = 32
	MinTTL            = 24 * time.Hour
	MaxTTL            = 365 * 24 * time.Hour
	DefaultTTL        = 90 * 24 * time.Hour

	configVersion = "postwave.reply-correlation-keyring.v1"
)

var (
	ErrInvalidConfiguration = errors.New("reply correlation: invalid configuration")
	ErrInvalidToken         = errors.New("reply correlation: invalid token")
	ErrExpired              = errors.New("reply correlation: token expired")
	ErrBindingMismatch      = errors.New("reply correlation: ledger binding mismatch")

	tokenEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)
)

// Key describes one issuance window. NotAfter retires the key for new token
// issuance; the key must remain configured for verification until every token
// it issued has expired. Windows may touch but must never overlap, which makes
// immutable send-bound timestamps select one stable key across replay.
type Key struct {
	ID        string
	Secret    []byte
	NotBefore time.Time
	NotAfter  time.Time
}

type keyConfig struct {
	ID           string `json:"id"`
	SecretBase64 string `json:"secret_base64"`
	NotBefore    string `json:"not_before"`
	NotAfter     string `json:"not_after"`
}

type keyringConfig struct {
	Version string      `json:"version"`
	Keys    []keyConfig `json:"keys"`
}

type preparedKey struct {
	Key
	tag [KeyTagBytes]byte
}

// Service is immutable and safe for concurrent mint/verify calls.
type Service struct {
	domain string
	ttl    time.Duration
	keys   []preparedKey
	byID   map[string]preparedKey
	byTag  map[[KeyTagBytes]byte]preparedKey
	now    func() time.Time
}

// MintInput is the exact immutable delivery identity authenticated by a token.
// DeliveryID is allocated deterministically before MIME composition and is the
// primary key later inserted into campaign_send_deliveries.
type MintInput struct {
	TenantID   string
	CampaignID string
	DeliveryID string
	IssuedAt   time.Time
}

// Correlation is safe delivery-ledger material. Address is exact RFC Reply-To;
// TokenHash is a lookup commitment, never the recoverable token itself.
type Correlation struct {
	Address    string
	TokenHash  string
	Version    int
	KeyID      string
	ExpiresAt  time.Time
	DeliveryID string
}

// Binding is loaded under tenant scope from campaign_send_deliveries before
// verification. A valid wire MAC is insufficient unless every ledger field
// also agrees.
type Binding struct {
	TenantID   string
	CampaignID string
	DeliveryID string
	Address    string
	TokenHash  string
	Version    int
	KeyID      string
	ExpiresAt  time.Time
}

// Parsed is the non-secret routing portion of an address. Reference is opaque;
// it cannot be decoded into an application identifier.
type Parsed struct {
	Address   string
	Token     string
	TokenHash string
	Version   int
	ExpiresAt time.Time
	keyTag    [KeyTagBytes]byte
	reference [ReferenceBytes]byte
	mac       [MACBytes]byte
}

// ParseConfig accepts one closed, versioned JSON object. Secrets are standard
// base64 and must contain at least 256 bits after decoding.
func ParseConfig(raw, domain string, ttl time.Duration) (*Service, error) {
	var config keyringConfig
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("%w: keyring JSON: %v", ErrInvalidConfiguration, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: keyring JSON must contain exactly one object", ErrInvalidConfiguration)
	}
	if config.Version != configVersion || len(config.Keys) == 0 {
		return nil, fmt.Errorf("%w: version %q or empty key set", ErrInvalidConfiguration, config.Version)
	}
	keys := make([]Key, 0, len(config.Keys))
	for _, item := range config.Keys {
		secret, err := base64.StdEncoding.DecodeString(strings.TrimSpace(item.SecretBase64))
		if err != nil {
			return nil, fmt.Errorf("%w: key %q secret_base64", ErrInvalidConfiguration, item.ID)
		}
		notBefore, err := time.Parse(time.RFC3339, strings.TrimSpace(item.NotBefore))
		if err != nil {
			return nil, fmt.Errorf("%w: key %q not_before", ErrInvalidConfiguration, item.ID)
		}
		notAfter, err := time.Parse(time.RFC3339, strings.TrimSpace(item.NotAfter))
		if err != nil {
			return nil, fmt.Errorf("%w: key %q not_after", ErrInvalidConfiguration, item.ID)
		}
		keys = append(keys, Key{ID: item.ID, Secret: secret, NotBefore: notBefore.UTC(), NotAfter: notAfter.UTC()})
	}
	return NewService(domain, ttl, keys, nil)
}

// NewService validates domain, TTL, key identifiers/tags, and the complete
// non-overlapping rotation schedule. now is test-only; nil uses time.Now.
func NewService(domain string, ttl time.Duration, keys []Key, now func() time.Time) (*Service, error) {
	domain = strings.ToLower(strings.TrimSpace(domain))
	if !validDomain(domain) {
		return nil, fmt.Errorf("%w: invalid inbound domain", ErrInvalidConfiguration)
	}
	if ttl == 0 {
		ttl = DefaultTTL
	}
	if ttl < MinTTL || ttl > MaxTTL || ttl%time.Second != 0 {
		return nil, fmt.Errorf("%w: TTL must be whole seconds in [%s,%s]", ErrInvalidConfiguration, MinTTL, MaxTTL)
	}
	if len(keys) == 0 || len(keys) > 256 {
		return nil, fmt.Errorf("%w: key count must be 1..256", ErrInvalidConfiguration)
	}
	prepared := make([]preparedKey, 0, len(keys))
	byID := make(map[string]preparedKey, len(keys))
	byTag := make(map[[KeyTagBytes]byte]preparedKey, len(keys))
	for _, input := range keys {
		input.ID = strings.TrimSpace(input.ID)
		if !validKeyID(input.ID) || len(input.Secret) < MinSecretBytes || input.NotBefore.IsZero() || input.NotAfter.IsZero() || !input.NotBefore.Before(input.NotAfter) {
			return nil, fmt.Errorf("%w: invalid key %q", ErrInvalidConfiguration, input.ID)
		}
		input.NotBefore = input.NotBefore.UTC()
		input.NotAfter = input.NotAfter.UTC()
		if _, duplicate := byID[input.ID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate key id %q", ErrInvalidConfiguration, input.ID)
		}
		entry := preparedKey{Key: Key{ID: input.ID, Secret: append([]byte(nil), input.Secret...), NotBefore: input.NotBefore, NotAfter: input.NotAfter}, tag: keyTag(input.ID)}
		if prior, collision := byTag[entry.tag]; collision {
			return nil, fmt.Errorf("%w: key-tag collision between %q and %q", ErrInvalidConfiguration, prior.ID, input.ID)
		}
		prepared = append(prepared, entry)
		byID[input.ID] = entry
		byTag[entry.tag] = entry
	}
	sort.Slice(prepared, func(i, j int) bool { return prepared[i].NotBefore.Before(prepared[j].NotBefore) })
	for index := 1; index < len(prepared); index++ {
		if prepared[index].NotBefore.Before(prepared[index-1].NotAfter) {
			return nil, fmt.Errorf("%w: issuance windows overlap for %q and %q", ErrInvalidConfiguration, prepared[index-1].ID, prepared[index].ID)
		}
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{domain: domain, ttl: ttl, keys: prepared, byID: byID, byTag: byTag, now: now}, nil
}

func (s *Service) Mint(input MintInput) (Correlation, error) {
	if s == nil {
		return Correlation{}, fmt.Errorf("%w: service unavailable", ErrInvalidConfiguration)
	}
	tenant, campaign, delivery, err := canonicalUUIDs(input.TenantID, input.CampaignID, input.DeliveryID)
	if err != nil || input.IssuedAt.IsZero() {
		return Correlation{}, fmt.Errorf("%w: invalid delivery identity", ErrBindingMismatch)
	}
	issuedAt := input.IssuedAt.UTC()
	key, ok := s.issuanceKey(issuedAt)
	if !ok {
		return Correlation{}, fmt.Errorf("%w: no key covers immutable issued_at", ErrInvalidConfiguration)
	}
	expiresAt := issuedAt.Add(s.ttl).Truncate(time.Second)
	if !expiresAt.After(s.now().UTC()) || expiresAt.Unix() <= 0 || expiresAt.Unix() > int64(^uint32(0)) {
		return Correlation{}, ErrExpired
	}

	var wire [TokenBytes]byte
	wire[0] = byte(Version)
	copy(wire[1:1+KeyTagBytes], key.tag[:])
	binary.BigEndian.PutUint32(wire[1+KeyTagBytes:1+KeyTagBytes+4], uint32(expiresAt.Unix()))
	reference := correlationReference(key.Secret, tenant, campaign, delivery)
	referenceStart := 1 + KeyTagBytes + 4
	copy(wire[referenceStart:referenceStart+ReferenceBytes], reference[:])
	mac := correlationMAC(key.Secret, wire[:referenceStart+ReferenceBytes], tenant, campaign, delivery)
	copy(wire[referenceStart+ReferenceBytes:], mac[:])
	token := strings.ToLower(tokenEncoding.EncodeToString(wire[:]))
	local := TokenPrefix + token
	if len(local) > MaxLocalPartBytes {
		return Correlation{}, fmt.Errorf("%w: local-part exceeds RFC limit", ErrInvalidConfiguration)
	}
	address := local + "@" + s.domain
	return Correlation{
		Address: address, TokenHash: tokenDigest(token), Version: Version,
		KeyID: key.ID, ExpiresAt: expiresAt, DeliveryID: delivery.String(),
	}, nil
}

// ParseAddress validates only the closed wire shape. Trust is established by
// Verify after the tenant-scoped delivery row has been loaded.
func ParseAddress(raw string) (Parsed, error) {
	address, err := mail.ParseAddress(strings.TrimSpace(raw))
	if err != nil || address == nil || strings.TrimSpace(address.Address) == "" {
		return Parsed{}, ErrInvalidToken
	}
	addr := strings.ToLower(strings.TrimSpace(address.Address))
	at := strings.LastIndexByte(addr, '@')
	if at <= 0 || at == len(addr)-1 {
		return Parsed{}, ErrInvalidToken
	}
	local := addr[:at]
	if len(local) > MaxLocalPartBytes || !strings.HasPrefix(local, TokenPrefix) {
		return Parsed{}, ErrInvalidToken
	}
	token := strings.TrimPrefix(local, TokenPrefix)
	decoded, err := tokenEncoding.DecodeString(strings.ToUpper(token))
	if err != nil || len(decoded) != TokenBytes || strings.ToLower(tokenEncoding.EncodeToString(decoded)) != token {
		return Parsed{}, ErrInvalidToken
	}
	if int(decoded[0]) != Version {
		return Parsed{}, ErrInvalidToken
	}
	parsed := Parsed{Address: addr, Token: token, TokenHash: tokenDigest(token), Version: Version}
	copy(parsed.keyTag[:], decoded[1:1+KeyTagBytes])
	expiresUnix := binary.BigEndian.Uint32(decoded[1+KeyTagBytes : 1+KeyTagBytes+4])
	if expiresUnix == 0 {
		return Parsed{}, ErrInvalidToken
	}
	parsed.ExpiresAt = time.Unix(int64(expiresUnix), 0).UTC()
	referenceStart := 1 + KeyTagBytes + 4
	copy(parsed.reference[:], decoded[referenceStart:referenceStart+ReferenceBytes])
	copy(parsed.mac[:], decoded[referenceStart+ReferenceBytes:])
	return parsed, nil
}

func (s *Service) Verify(raw string, binding Binding) error {
	if s == nil {
		return fmt.Errorf("%w: verifier unavailable", ErrInvalidConfiguration)
	}
	parsed, err := ParseAddress(raw)
	if err != nil {
		return err
	}
	tenant, campaign, delivery, err := canonicalUUIDs(binding.TenantID, binding.CampaignID, binding.DeliveryID)
	if err != nil {
		return ErrBindingMismatch
	}
	key, ok := s.byID[strings.TrimSpace(binding.KeyID)]
	if !ok || key.tag != parsed.keyTag || binding.Version != Version ||
		!binding.ExpiresAt.UTC().Equal(parsed.ExpiresAt) ||
		!hmac.Equal([]byte(strings.ToLower(strings.TrimSpace(binding.TokenHash))), []byte(parsed.TokenHash)) ||
		!strings.EqualFold(strings.TrimSpace(binding.Address), parsed.Address) {
		return ErrBindingMismatch
	}
	if !parsed.ExpiresAt.After(s.now().UTC()) {
		return ErrExpired
	}
	expectedReference := correlationReference(key.Secret, tenant, campaign, delivery)
	if !hmac.Equal(expectedReference[:], parsed.reference[:]) {
		return ErrBindingMismatch
	}
	wirePrefix := make([]byte, 0, 1+KeyTagBytes+4+ReferenceBytes)
	wirePrefix = append(wirePrefix, byte(parsed.Version))
	wirePrefix = append(wirePrefix, parsed.keyTag[:]...)
	var expiry [4]byte
	binary.BigEndian.PutUint32(expiry[:], uint32(parsed.ExpiresAt.Unix()))
	wirePrefix = append(wirePrefix, expiry[:]...)
	wirePrefix = append(wirePrefix, parsed.reference[:]...)
	expectedMAC := correlationMAC(key.Secret, wirePrefix, tenant, campaign, delivery)
	if !hmac.Equal(expectedMAC[:], parsed.mac[:]) {
		return ErrBindingMismatch
	}
	return nil
}

func (s *Service) issuanceKey(at time.Time) (preparedKey, bool) {
	for _, key := range s.keys {
		if !at.Before(key.NotBefore) && at.Before(key.NotAfter) {
			return key, true
		}
	}
	return preparedKey{}, false
}

func canonicalUUIDs(values ...string) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	if len(values) != 3 {
		return uuid.Nil, uuid.Nil, uuid.Nil, errors.New("three UUIDs required")
	}
	parsed := make([]uuid.UUID, 3)
	for index, value := range values {
		candidate, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil || candidate.String() != strings.TrimSpace(value) {
			return uuid.Nil, uuid.Nil, uuid.Nil, errors.New("canonical UUID required")
		}
		parsed[index] = candidate
	}
	return parsed[0], parsed[1], parsed[2], nil
}

func correlationReference(secret []byte, tenant, campaign, delivery uuid.UUID) [ReferenceBytes]byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("postwave.reply-correlation.reference.v1\x00"))
	_, _ = mac.Write(tenant[:])
	_, _ = mac.Write(campaign[:])
	_, _ = mac.Write(delivery[:])
	var out [ReferenceBytes]byte
	copy(out[:], mac.Sum(nil))
	return out
}

func correlationMAC(secret, wire []byte, tenant, campaign, delivery uuid.UUID) [MACBytes]byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("postwave.reply-correlation.mac.v1\x00"))
	_, _ = mac.Write(wire)
	_, _ = mac.Write(tenant[:])
	_, _ = mac.Write(campaign[:])
	_, _ = mac.Write(delivery[:])
	var out [MACBytes]byte
	copy(out[:], mac.Sum(nil))
	return out
}

func keyTag(id string) [KeyTagBytes]byte {
	sum := sha256.Sum256([]byte("postwave.reply-correlation.key-id.v1\x00" + id))
	var out [KeyTagBytes]byte
	copy(out[:], sum[:])
	return out
}

func tokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func validKeyID(value string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for _, current := range value {
		if (current >= 'a' && current <= 'z') || (current >= '0' && current <= '9') || current == '_' || current == '-' {
			continue
		}
		return false
	}
	return true
}

func validDomain(value string) bool {
	if len(value) < 1 || len(value) > 253 || strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, current := range label {
			if (current >= 'a' && current <= 'z') || (current >= '0' && current <= '9') || current == '-' {
				continue
			}
			return false
		}
	}
	return true
}
