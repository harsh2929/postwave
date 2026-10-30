// Package crypto implements envelope encryption for Moosewave secrets at rest.
//
// Why envelope:
//   - The KEK (Key-Encryption Key) lives in a managed system (AWS KMS in
//     production, or an env-provided static KEK for local/private beta). It
//     NEVER touches plaintext secrets.
//   - Per-payload DEKs (Data-Encryption Keys) are generated on the fly and
//     used to encrypt the actual ciphertext. The wrapped DEK is stored
//     alongside the ciphertext.
//   - Rotation is cheap: rewrap DEKs against the new KEK without re-encrypting
//     the (potentially large) payloads.
//
// Storage format (single bytea blob in the DB):
//
//	[ version:1 ] [ wrapped-dek-len:2 (BE) ] [ wrapped-dek ] [ nonce:12 ] [ ciphertext ]
//
// Versions:
//   - 0x01 — legacy direct AES-GCM (12-byte nonce + ciphertext, no wrapped
//     dek; the SendingKEK encrypted the payload directly). Detected and
//     decrypted for backward compatibility; new writes use 0x02.
//   - 0x02 — envelope (this scheme).
package crypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Format version bytes.
const (
	VersionLegacyDirect byte = 0x01
	VersionEnvelope     byte = 0x02
)

// EnvelopeKey wraps + unwraps a per-payload DEK.
type EnvelopeKey interface {
	Wrap(ctx context.Context, plainDEK []byte) (wrappedDEK []byte, err error)
	Unwrap(ctx context.Context, wrappedDEK []byte) (plainDEK []byte, err error)
}

// EnvKeyKMS wraps DEKs with AES-256-GCM using a KEK loaded from env. This is
// the local/private-beta fallback; AwsKMSEnvelope in kms.go is the production
// AWS KMS-backed implementation.
type EnvKeyKMS struct {
	KEK []byte // 16/24/32 bytes
}

// NewEnvKeyKMS validates the key length up front.
func NewEnvKeyKMS(kek []byte) (*EnvKeyKMS, error) {
	switch len(kek) {
	case 16, 24, 32:
		return &EnvKeyKMS{KEK: kek}, nil
	default:
		return nil, fmt.Errorf("kek must be 16/24/32 bytes, got %d", len(kek))
	}
}

// Wrap implements EnvelopeKey.
func (e *EnvKeyKMS) Wrap(_ context.Context, dek []byte) ([]byte, error) {
	return aesGCMSeal(e.KEK, dek)
}

// Unwrap implements EnvelopeKey.
func (e *EnvKeyKMS) Unwrap(_ context.Context, wrapped []byte) ([]byte, error) {
	return aesGCMOpen(e.KEK, wrapped)
}

// ErrAwsKMSNotConfigured is retained for backward-compat with callers that
// asserted on it pre-AWS-SDK. Today AwsKMSEnvelope (see kms.go) is a
// real KMS-backed implementation; this sentinel is no longer returned by
// the standard path and exists only for legacy error-checks.
var ErrAwsKMSNotConfigured = errors.New("aws kms envelope is not configured")

// EnvelopeCipher is the high-level encrypt/decrypt API. Construct with the
// KEK, then use Encrypt + Decrypt for opaque blobs that include the wrapped
// DEK in their on-the-wire format.
type EnvelopeCipher struct {
	Key EnvelopeKey
}

// NewEnvelopeCipher is a tiny constructor for nicer call sites.
func NewEnvelopeCipher(k EnvelopeKey) *EnvelopeCipher { return &EnvelopeCipher{Key: k} }

// Encrypt generates a fresh 32-byte DEK, AES-256-GCM-encrypts plaintext with
// it, then wraps the DEK with the configured KEK and returns the framed blob
// described at the top of this file.
func (c *EnvelopeCipher) Encrypt(ctx context.Context, plaintext []byte) ([]byte, error) {
	if c == nil || c.Key == nil {
		return nil, errors.New("envelope cipher not configured")
	}
	dek := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return nil, fmt.Errorf("dek gen: %w", err)
	}
	wrapped, err := c.Key.Wrap(ctx, dek)
	if err != nil {
		return nil, fmt.Errorf("wrap dek: %w", err)
	}
	ct, err := aesGCMSeal(dek, plaintext)
	if err != nil {
		return nil, fmt.Errorf("seal payload: %w", err)
	}
	if len(wrapped) > 0xFFFF {
		return nil, fmt.Errorf("wrapped dek too large: %d", len(wrapped))
	}
	out := make([]byte, 0, 1+2+len(wrapped)+len(ct))
	out = append(out, VersionEnvelope)
	var lenBuf [2]byte
	binary.BigEndian.PutUint16(lenBuf[:], uint16(len(wrapped)))
	out = append(out, lenBuf[:]...)
	out = append(out, wrapped...)
	out = append(out, ct...)
	return out, nil
}

// Decrypt detects the format-version byte and decrypts accordingly. legacyKEK
// is required to decrypt 0x01 blobs (use the SendingKEK from config); pass
// nil if you know the blob is envelope-format.
func (c *EnvelopeCipher) Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error) {
	if len(blob) < 1 {
		return nil, errors.New("blob empty")
	}
	switch blob[0] {
	case VersionLegacyDirect:
		// Direct AES-GCM with legacy KEK: 12-byte nonce + ciphertext.
		if legacyKEK == nil {
			return nil, errors.New("legacy blob requires legacyKEK")
		}
		return aesGCMOpen(legacyKEK, blob[1:])
	case VersionEnvelope:
		if c == nil || c.Key == nil {
			return nil, errors.New("envelope cipher not configured")
		}
		if len(blob) < 3 {
			return nil, errors.New("envelope blob too short")
		}
		wrappedLen := int(binary.BigEndian.Uint16(blob[1:3]))
		if 3+wrappedLen > len(blob) {
			return nil, errors.New("envelope blob truncated")
		}
		wrapped := blob[3 : 3+wrappedLen]
		ct := blob[3+wrappedLen:]
		dek, err := c.Key.Unwrap(ctx, wrapped)
		if err != nil {
			return nil, fmt.Errorf("unwrap dek: %w", err)
		}
		return aesGCMOpen(dek, ct)
	default:
		// No version byte at all? Assume it is a raw legacy blob with no
		// version prefix (some early staging data). Try the legacy path.
		if legacyKEK == nil {
			return nil, fmt.Errorf("unknown blob version 0x%02x", blob[0])
		}
		return aesGCMOpen(legacyKEK, blob)
	}
}

// --- internals ----------------------------------------------------------

// aesGCMSeal emits nonce || ciphertext.
func aesGCMSeal(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	ct := g.Seal(nil, nonce, plaintext, nil)
	return append(nonce, ct...), nil
}

// aesGCMOpen reverses aesGCMSeal.
func aesGCMOpen(key, blob []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < g.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := blob[:g.NonceSize()], blob[g.NonceSize():]
	return g.Open(nil, nonce, ct, nil)
}
