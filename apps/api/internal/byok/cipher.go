// SPDX-License-Identifier: AGPL-3.0-only

package byok

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	pwkms "github.com/postwave/postwave/packages/kms"
)

// VersionTenantEnvelope is the wire-format byte for v=0x03 envelopes
// that embed a tenant_keys.id reference. Lets Decrypt route to the
// correct provider + key_ref without an out-of-band lookup.
//
// Wire format:
//
//	[ 0x03 ][ key_id_len:1 ][ key_id ASCII ][ wrapped_len:2 BE ][ wrapped ][ nonce:12 ][ ciphertext ]
//
// key_id is the tenant_keys.id UUID written as 36 ASCII bytes (no
// braces, no leading "urn:uuid:"). We pad with the 1-byte length prefix
// for forward-compatibility in case we want non-UUID key ids later.
const VersionTenantEnvelope byte = 0x03

// KeyStore is the narrow surface TenantCipher needs from the repo. The
// production *Repo satisfies it; tests pass a fake. Keeping this as an
// interface (rather than *Repo) makes the cipher unit-testable without
// a live Postgres connection.
type KeyStore interface {
	GetActive(ctx context.Context, tenantID string) (*Key, error)
	Get(ctx context.Context, tenantID, id string) (*Key, error)
}

// TenantCipher is the per-tenant envelope cipher. It consults the
// tenant_keys repo + the kms provider registry to wrap/unwrap DEKs
// against the customer-controlled KEK.
//
// The fallback path: if a tenant has no active key, callers receive
// ErrNoActiveKey. Higher-level code in apps/api decides whether to
// fall back to the platform cipher (current behaviour for non-BYOK
// tenants) or refuse the operation (BYOK-required policy).
type TenantCipher struct {
	Keys     KeyStore
	Registry *pwkms.Registry
}

// NewTenantCipher constructs a TenantCipher.
func NewTenantCipher(keys KeyStore, reg *pwkms.Registry) *TenantCipher {
	return &TenantCipher{Keys: keys, Registry: reg}
}

// EncryptForTenant encrypts plaintext under the tenant's active KEK.
// Returns ErrNoActiveKey if BYOK isn't configured for this tenant.
func (c *TenantCipher) EncryptForTenant(ctx context.Context, tenantID string, plaintext []byte) ([]byte, error) {
	if c == nil || c.Keys == nil || c.Registry == nil {
		return nil, errors.New("byok: cipher not configured")
	}
	key, err := c.Keys.GetActive(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	provider, err := c.Registry.Get(key.Provider)
	if err != nil {
		return nil, fmt.Errorf("byok: provider %q for tenant %s: %w", key.Provider, tenantID, err)
	}

	dek, err := pwkms.GenerateDEK()
	if err != nil {
		return nil, fmt.Errorf("byok: generate dek: %w", err)
	}
	defer zero(dek)

	wrapped, err := provider.WrapDEK(ctx, key.KeyRef, dek)
	if err != nil {
		return nil, fmt.Errorf("byok: wrap dek: %w", err)
	}
	if len(wrapped) > 0xFFFF {
		return nil, fmt.Errorf("byok: wrapped dek too large (%d)", len(wrapped))
	}

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, fmt.Errorf("aes cipher: %w", err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	ct := g.Seal(nil, nonce, plaintext, nil)

	keyIDBytes := []byte(key.ID)
	if len(keyIDBytes) > 0xFF {
		return nil, fmt.Errorf("byok: key_id too long (%d)", len(keyIDBytes))
	}

	out := make([]byte, 0, 1+1+len(keyIDBytes)+2+len(wrapped)+len(nonce)+len(ct))
	out = append(out, VersionTenantEnvelope)
	out = append(out, byte(len(keyIDBytes)))
	out = append(out, keyIDBytes...)
	var lenBuf [2]byte
	binary.BigEndian.PutUint16(lenBuf[:], uint16(len(wrapped)))
	out = append(out, lenBuf[:]...)
	out = append(out, wrapped...)
	out = append(out, nonce...)
	out = append(out, ct...)
	return out, nil
}

// DecryptForTenant parses a v=0x03 envelope, resolves the tenant_keys
// row by id, and unwraps via the matching provider.
//
// A cross-tenant Decrypt attempt (blob's key_id belongs to a different
// tenant) returns ErrNotFound so the operation fails-closed. This is
// the security boundary the BYOK story rests on.
func (c *TenantCipher) DecryptForTenant(ctx context.Context, tenantID string, blob []byte) ([]byte, error) {
	if c == nil || c.Keys == nil || c.Registry == nil {
		return nil, errors.New("byok: cipher not configured")
	}
	if len(blob) < 1+1+1+2+12 {
		return nil, errors.New("byok: blob too short")
	}
	if blob[0] != VersionTenantEnvelope {
		return nil, fmt.Errorf("byok: unsupported version 0x%02x", blob[0])
	}
	keyIDLen := int(blob[1])
	if len(blob) < 2+keyIDLen+2+12 {
		return nil, errors.New("byok: blob truncated (key_id)")
	}
	keyID := string(blob[2 : 2+keyIDLen])
	wrappedLen := int(binary.BigEndian.Uint16(blob[2+keyIDLen : 2+keyIDLen+2]))
	if len(blob) < 2+keyIDLen+2+wrappedLen+12 {
		return nil, errors.New("byok: blob truncated (wrapped)")
	}
	wrapped := blob[2+keyIDLen+2 : 2+keyIDLen+2+wrappedLen]
	rest := blob[2+keyIDLen+2+wrappedLen:]
	nonce := rest[:12]
	ct := rest[12:]

	key, err := c.Keys.Get(ctx, tenantID, keyID)
	if err != nil {
		return nil, err // includes the cross-tenant boundary
	}
	provider, err := c.Registry.Get(key.Provider)
	if err != nil {
		return nil, fmt.Errorf("byok: provider %q: %w", key.Provider, err)
	}
	dek, err := provider.UnwrapDEK(ctx, key.KeyRef, wrapped)
	if err != nil {
		return nil, fmt.Errorf("byok: unwrap dek: %w", err)
	}
	defer zero(dek)

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, fmt.Errorf("aes cipher: %w", err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	if len(nonce) != g.NonceSize() {
		return nil, fmt.Errorf("byok: bad nonce size %d", len(nonce))
	}
	pt, err := g.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("aes-gcm open: %w", err)
	}
	return pt, nil
}

// HasActiveKey returns true iff the tenant has BYOK configured (used
// by call sites that want to choose between platform and tenant cipher
// without bubbling up ErrNoActiveKey).
func (c *TenantCipher) HasActiveKey(ctx context.Context, tenantID string) (bool, error) {
	if c == nil || c.Keys == nil {
		return false, nil
	}
	_, err := c.Keys.GetActive(ctx, tenantID)
	if errors.Is(err, ErrNoActiveKey) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// IsTenantEnvelope returns true if blob is a v=0x03 tenant envelope.
// Lets call sites pick the right cipher before calling Decrypt.
func IsTenantEnvelope(blob []byte) bool {
	return len(blob) >= 1 && blob[0] == VersionTenantEnvelope
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
