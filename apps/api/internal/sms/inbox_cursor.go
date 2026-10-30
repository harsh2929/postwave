package sms

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

var (
	errInboxInvalidCursor     = errors.New("invalid inbox cursor")
	errInboxCursorMismatch    = errors.New("inbox cursor does not match query")
	errInboxCursorExpired     = errors.New("inbox cursor expired")
	errInboxCursorUnavailable = errors.New("inbox cursor encryption unavailable")
)

const (
	minInboxCursorKeyBytes = 32
	inboxCursorTTL         = 15 * time.Minute
	maxInboxCursorBytes    = 4096
)

// inboxCursor is deliberately route-specific. In addition to the keyset it
// pins the first page's message snapshot and a one-way digest of all query
// dimensions. A cursor therefore cannot silently be reused with a different
// filter/search, and its base64 payload does not echo a sensitive search term
// into logs or browser history.
type inboxCursor struct {
	Version    int    `json:"v"`
	Kind       string `json:"k"`
	Binding    string `json:"b"`
	TenantID   string `json:"w"`
	SnapshotAt string `json:"s"`
	ExpiresAt  string `json:"x"`
	KeyAt      string `json:"t"`
	KeyID      string `json:"i"`
	Rank       int    `json:"r,omitempty"`
	KeyAtNull  bool   `json:"n,omitempty"`
}

type inboxCursorPosition struct {
	SnapshotAt time.Time
	KeyAt      time.Time
	KeyID      string
	Rank       int
	KeyAtNull  bool
}

func inboxCursorBinding(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = io.WriteString(h, part)
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func validInboxCursorKey(key []byte) bool {
	return len(key) >= minInboxCursorKeyBytes
}

func inboxCursorAEAD(key []byte) (cipher.AEAD, error) {
	if !validInboxCursorKey(key) {
		return nil, errInboxCursorUnavailable
	}
	// Hashing domain-separates variable-length secret material into the exact
	// 256-bit AES key size without weakening the >=32-byte entropy contract.
	digest := sha256.Sum256(append([]byte("postwave/sms-inbox/cursor/aes-gcm/v1\x00"), key...))
	block, err := aes.NewCipher(digest[:])
	if err != nil {
		return nil, errInboxCursorUnavailable
	}
	return cipher.NewGCM(block)
}

func inboxCursorAAD(tenantID, kind string) []byte {
	return []byte("postwave/sms-inbox/cursor/v1\x00" + tenantID + "\x00" + kind)
}

func encodeInboxCursor(key []byte, tenantID, kind, binding string, p inboxCursorPosition) (string, error) {
	if p.KeyID == "" || p.SnapshotAt.IsZero() {
		return "", nil
	}
	env := inboxCursor{
		Version:    1,
		Kind:       kind,
		Binding:    binding,
		TenantID:   tenantID,
		SnapshotAt: p.SnapshotAt.UTC().Format(time.RFC3339Nano),
		ExpiresAt:  p.SnapshotAt.UTC().Add(inboxCursorTTL).Format(time.RFC3339Nano),
		KeyID:      p.KeyID,
		Rank:       p.Rank,
		KeyAtNull:  p.KeyAtNull,
	}
	if !p.KeyAtNull {
		env.KeyAt = p.KeyAt.UTC().Format(time.RFC3339Nano)
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return "", err
	}
	aead, err := inboxCursorAEAD(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nil, nonce, raw, inboxCursorAAD(tenantID, kind))
	token := append(nonce, sealed...)
	return "v1." + base64.RawURLEncoding.EncodeToString(token), nil
}

func decryptInboxCursor(key []byte, token, tenantID, kind, binding string) ([]byte, error) {
	aead, err := inboxCursorAEAD(key)
	if err != nil {
		return nil, err
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) <= aead.NonceSize() || len(decoded) > maxInboxCursorBytes {
		return nil, errInboxInvalidCursor
	}
	nonce, ciphertext := decoded[:aead.NonceSize()], decoded[aead.NonceSize():]
	plain, err := aead.Open(nil, nonce, ciphertext, inboxCursorAAD(tenantID, kind))
	if err != nil {
		return nil, errInboxInvalidCursor
	}
	return plain, nil
}

func decodeInboxCursor(keys [][]byte, raw, tenantID, kind, binding string, now time.Time) (inboxCursorPosition, error) {
	if len(keys) == 0 || !validInboxCursorKey(keys[0]) {
		return inboxCursorPosition{}, errInboxCursorUnavailable
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return inboxCursorPosition{SnapshotAt: now.UTC()}, nil
	}
	if len(raw) > maxInboxCursorBytes || !strings.HasPrefix(raw, "v1.") {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	var decoded []byte
	var err error
	for _, key := range keys {
		if !validInboxCursorKey(key) {
			continue
		}
		decoded, err = decryptInboxCursor(key, strings.TrimPrefix(raw, "v1."), tenantID, kind, binding)
		if err == nil {
			break
		}
	}
	if err != nil || len(decoded) == 0 {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	dec := json.NewDecoder(bytes.NewReader(decoded))
	dec.DisallowUnknownFields()
	var env inboxCursor
	if err := dec.Decode(&env); err != nil {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	if env.Version != 1 || env.Kind != kind || env.TenantID != tenantID || env.Binding == "" || env.KeyID == "" || env.SnapshotAt == "" || env.ExpiresAt == "" {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	if !hmac.Equal([]byte(env.Binding), []byte(binding)) {
		return inboxCursorPosition{}, errInboxCursorMismatch
	}
	snapshotAt, err := time.Parse(time.RFC3339Nano, env.SnapshotAt)
	if err != nil || snapshotAt.IsZero() || snapshotAt.After(now.Add(time.Minute)) {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, env.ExpiresAt)
	if err != nil || !expiresAt.Equal(snapshotAt.Add(inboxCursorTTL)) {
		return inboxCursorPosition{}, errInboxInvalidCursor
	}
	if !now.Before(expiresAt) {
		return inboxCursorPosition{}, errInboxCursorExpired
	}
	var keyAt time.Time
	if !env.KeyAtNull {
		keyAt, err = time.Parse(time.RFC3339Nano, env.KeyAt)
		if err != nil || keyAt.IsZero() {
			return inboxCursorPosition{}, errInboxInvalidCursor
		}
	}
	if env.Rank < 0 || env.Rank > 1 {
		return inboxCursorPosition{}, fmt.Errorf("%w: rank", errInboxInvalidCursor)
	}
	return inboxCursorPosition{
		SnapshotAt: snapshotAt.UTC(),
		KeyAt:      keyAt.UTC(),
		KeyID:      env.KeyID,
		Rank:       env.Rank,
		KeyAtNull:  env.KeyAtNull,
	}, nil
}
