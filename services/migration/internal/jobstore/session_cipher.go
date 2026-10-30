package jobstore

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
)

const sessionCipherVersion byte = 0x01

// SessionCipher protects adapter.Session blobs before they are stored.
type SessionCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, ciphertext []byte) ([]byte, error)
}

// AESSessionCipher is the local and private-beta implementation. It keeps the
// KMS seam small: production can replace the env KEK with an AWS KMS data-key
// wrapper without changing the store contract.
type AESSessionCipher struct {
	key []byte
}

// NewAESSessionCipher accepts raw, hex, or base64 keys. Keys must decode to
// 16, 24, or 32 bytes because AES-GCM requires a valid AES key length.
func NewAESSessionCipher(raw string) (*AESSessionCipher, error) {
	key, err := decodeSessionKey(raw)
	if err != nil {
		return nil, err
	}
	switch len(key) {
	case 16, 24, 32:
		cp := make([]byte, len(key))
		copy(cp, key)
		return &AESSessionCipher{key: cp}, nil
	default:
		return nil, fmt.Errorf("migration session KEK must be 16/24/32 bytes, got %d", len(key))
	}
}

func (c *AESSessionCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	if c == nil || len(c.key) == 0 {
		return nil, errors.New("migration session cipher not configured")
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce gen: %w", err)
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+gcm.Overhead())
	out = append(out, sessionCipherVersion)
	out = append(out, nonce...)
	out = gcm.Seal(out, nonce, plaintext, nil)
	return out, nil
}

func (c *AESSessionCipher) Decrypt(_ context.Context, blob []byte) ([]byte, error) {
	if c == nil || len(c.key) == 0 {
		return nil, errors.New("migration session cipher not configured")
	}
	if len(blob) < 1 || blob[0] != sessionCipherVersion {
		return nil, errors.New("unsupported migration session ciphertext")
	}
	block, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < 1+gcm.NonceSize() {
		return nil, errors.New("migration session ciphertext truncated")
	}
	nonce := blob[1 : 1+gcm.NonceSize()]
	ct := blob[1+gcm.NonceSize():]
	return gcm.Open(nil, nonce, ct, nil)
}

func decodeSessionKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("migration session KEK is required")
	}
	if strings.HasPrefix(raw, "base64:") {
		return base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, "base64:"))
	}
	if strings.HasPrefix(raw, "hex:") {
		return hex.DecodeString(strings.TrimPrefix(raw, "hex:"))
	}
	if len(raw)%2 == 0 {
		if decoded, err := hex.DecodeString(raw); err == nil {
			return decoded, nil
		}
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil {
		return decoded, nil
	}
	return []byte(raw), nil
}
