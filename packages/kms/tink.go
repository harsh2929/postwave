// SPDX-License-Identifier: MIT

package kms

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// TinkProvider wraps DEKs using a local AES-256-GCM keyset stored in the
// Tink JSON keyset format (subset). It is the BYOK option for customers
// who want to keep all key material on disk or in a vault that hands them
// a key file (air-gapped, on-prem, or sovereign-cloud deployments where
// no managed KMS exists).
//
// Compatibility note: this is a *subset* of the Tink keyset format. We
// only support AES-256-GCM primary keys (Tink's most common symmetric
// envelope choice). The keyset JSON shape mirrors the Tink format so
// keysets exported by `tinkey create-keyset --key-template AES256_GCM`
// can be loaded by setting BasicKey or rebuilt with the bundled helper.
//
// Why Tink: customers using google/tink elsewhere in their stack can
// re-use the same key-management story; auditors recognise the format.
type TinkProvider struct {
	mu      sync.RWMutex
	keysets map[string]*tinkKeyset // keyRef -> loaded keyset
	Timeout time.Duration
}

// NewTinkProvider returns an empty provider; load keysets via
// LoadKeyset.
func NewTinkProvider() *TinkProvider {
	return &TinkProvider{
		keysets: map[string]*tinkKeyset{},
		Timeout: DefaultTimeout,
	}
}

// Name returns "tink".
func (p *TinkProvider) Name() string { return "tink" }

// LoadKeyset registers a Tink JSON keyset under keyRef. Subsequent
// WrapDEK / UnwrapDEK calls for that keyRef will route to this keyset.
// Pass the keyset JSON bytes (the same format `tinkey export-keyset`
// emits or that this package's GenerateKeyset emits).
func (p *TinkProvider) LoadKeyset(keyRef string, keysetJSON []byte) error {
	if keyRef == "" {
		return fmt.Errorf("%w: tink: empty keyRef", ErrInvalidKeyRef)
	}
	ks, err := parseTinkKeyset(keysetJSON)
	if err != nil {
		return fmt.Errorf("tink: parse keyset: %w", err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.keysets[keyRef] = ks
	return nil
}

// GenerateKeyset produces a fresh AES-256-GCM keyset JSON suitable for
// registration via LoadKeyset. Useful for bootstrapping a new tenant
// when the operator wants a managed-by-Moosewave Tink key rather than
// importing their own.
func GenerateKeyset(keyID uint32) ([]byte, error) {
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	if keyID == 0 {
		// Pick a non-zero keyID from random bytes. Tink rejects 0.
		idBuf := make([]byte, 4)
		if _, err := io.ReadFull(rand.Reader, idBuf); err != nil {
			return nil, err
		}
		keyID = uint32(idBuf[0])<<24 | uint32(idBuf[1])<<16 | uint32(idBuf[2])<<8 | uint32(idBuf[3])
		if keyID == 0 {
			keyID = 1
		}
	}
	ks := tinkKeysetJSON{
		PrimaryKeyID: keyID,
		Key: []tinkKeyJSON{{
			KeyID:            keyID,
			Status:           "ENABLED",
			OutputPrefixType: "RAW",
			KeyData: tinkKeyDataJSON{
				TypeURL:         "type.googleapis.com/google.crypto.tink.AesGcmKey",
				KeyMaterialType: "SYMMETRIC",
				Value:           base64.StdEncoding.EncodeToString(key),
			},
		}},
	}
	zero(key)
	return json.Marshal(ks)
}

// WrapDEK encrypts plainDEK with the registered keyset's primary key.
func (p *TinkProvider) WrapDEK(_ context.Context, keyRef string, plainDEK []byte) ([]byte, error) {
	if len(plainDEK) != DEKSize {
		return nil, fmt.Errorf("%w: tink: expected %d-byte DEK, got %d", ErrInvalidKeyRef, DEKSize, len(plainDEK))
	}
	ks, err := p.lookup(keyRef)
	if err != nil {
		return nil, err
	}
	primary, ok := ks.keys[ks.primaryKeyID]
	if !ok {
		return nil, fmt.Errorf("tink: keyset %q has no primary key", keyRef)
	}
	ct, err := primary.seal(plainDEK)
	if err != nil {
		return nil, fmt.Errorf("tink: seal: %w", err)
	}
	// Prepend the 4-byte key ID so UnwrapDEK can pick the right key when
	// the keyset has multiple versions (rotation).
	out := make([]byte, 0, 4+len(ct))
	out = append(out, byte(ks.primaryKeyID>>24), byte(ks.primaryKeyID>>16), byte(ks.primaryKeyID>>8), byte(ks.primaryKeyID))
	out = append(out, ct...)
	return out, nil
}

// UnwrapDEK decrypts wrapped using the keyset version pinned in the
// wire format prefix.
func (p *TinkProvider) UnwrapDEK(_ context.Context, keyRef string, wrapped []byte) ([]byte, error) {
	if len(wrapped) < 4 {
		return nil, fmt.Errorf("%w: tink: wrapped blob too short", ErrInvalidKeyRef)
	}
	ks, err := p.lookup(keyRef)
	if err != nil {
		return nil, err
	}
	keyID := uint32(wrapped[0])<<24 | uint32(wrapped[1])<<16 | uint32(wrapped[2])<<8 | uint32(wrapped[3])
	key, ok := ks.keys[keyID]
	if !ok {
		return nil, fmt.Errorf("tink: keyset %q has no key with id %d", keyRef, keyID)
	}
	dek, err := key.open(wrapped[4:])
	if err != nil {
		return nil, fmt.Errorf("tink: open: %w", err)
	}
	if len(dek) != DEKSize {
		return nil, fmt.Errorf("tink returned %d-byte DEK, expected %d", len(dek), DEKSize)
	}
	return dek, nil
}

// HealthCheck wraps+unwraps a probe.
func (p *TinkProvider) HealthCheck(ctx context.Context, keyRef string) error {
	probe := make([]byte, DEKSize)
	probe[0] = 0xc5
	w, err := p.WrapDEK(ctx, keyRef, probe)
	if err != nil {
		return err
	}
	back, err := p.UnwrapDEK(ctx, keyRef, w)
	if err != nil {
		return err
	}
	for i := range probe {
		if probe[i] != back[i] {
			return errors.New("tink: round-trip mismatch")
		}
	}
	zero(probe)
	zero(back)
	return nil
}

// --- internals: Tink keyset parsing ---

type tinkKeyset struct {
	primaryKeyID uint32
	keys         map[uint32]*tinkAesGcmKey
}

type tinkAesGcmKey struct {
	keyMaterial []byte // 32 bytes
}

func (k *tinkAesGcmKey) seal(plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(k.keyMaterial)
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

func (k *tinkAesGcmKey) open(blob []byte) ([]byte, error) {
	block, err := aes.NewCipher(k.keyMaterial)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(blob) < g.NonceSize() {
		return nil, errors.New("blob too short")
	}
	nonce, ct := blob[:g.NonceSize()], blob[g.NonceSize():]
	return g.Open(nil, nonce, ct, nil)
}

// tinkKeysetJSON / tinkKeyJSON / tinkKeyDataJSON mirror the Tink keyset
// wire format. Tink itself emits additional metadata (created_at, etc.);
// we ignore unknowns when parsing.
type tinkKeysetJSON struct {
	PrimaryKeyID uint32        `json:"primaryKeyId"`
	Key          []tinkKeyJSON `json:"key"`
}

type tinkKeyJSON struct {
	KeyID            uint32          `json:"keyId"`
	Status           string          `json:"status"`
	OutputPrefixType string          `json:"outputPrefixType"`
	KeyData          tinkKeyDataJSON `json:"keyData"`
}

type tinkKeyDataJSON struct {
	TypeURL         string `json:"typeUrl"`
	KeyMaterialType string `json:"keyMaterialType"`
	Value           string `json:"value"` // base64
}

func parseTinkKeyset(raw []byte) (*tinkKeyset, error) {
	var doc tinkKeysetJSON
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if doc.PrimaryKeyID == 0 {
		return nil, errors.New("missing primaryKeyId")
	}
	out := &tinkKeyset{primaryKeyID: doc.PrimaryKeyID, keys: map[uint32]*tinkAesGcmKey{}}
	for _, k := range doc.Key {
		if k.Status != "ENABLED" {
			continue
		}
		if k.KeyData.TypeURL != "type.googleapis.com/google.crypto.tink.AesGcmKey" {
			return nil, fmt.Errorf("unsupported key type %q (only AES256_GCM)", k.KeyData.TypeURL)
		}
		// Tink wraps the raw key material in a protobuf with a leading
		// field tag. For AES256_GCM the format is { field 2 = bytes(32) }
		// encoded as varint(0x12), varint(0x20), <32 bytes>. We accept
		// both the bare 32-byte form (from our GenerateKeyset) and the
		// real Tink protobuf form (Tinkey export).
		raw, err := base64.StdEncoding.DecodeString(k.KeyData.Value)
		if err != nil {
			return nil, fmt.Errorf("key %d: bad base64: %w", k.KeyID, err)
		}
		mat, err := extractAesGcmMaterial(raw)
		if err != nil {
			return nil, fmt.Errorf("key %d: %w", k.KeyID, err)
		}
		out.keys[k.KeyID] = &tinkAesGcmKey{keyMaterial: mat}
	}
	if _, ok := out.keys[doc.PrimaryKeyID]; !ok {
		return nil, fmt.Errorf("primaryKeyId %d not present in keys", doc.PrimaryKeyID)
	}
	return out, nil
}

// extractAesGcmMaterial pulls the 32-byte key material out of the
// Tink protobuf-encoded AesGcmKey, the GenerateKeyset shortcut form,
// or both.
//
// The Tink AesGcmKey proto is:
//
//	message AesGcmKey {
//	    uint32 version  = 1;  // field 1, wire type 0 (varint)
//	    bytes  key_value = 2; // field 2, wire type 2 (length-delimited)
//	}
//
// Real `tinkey export-keyset` emits the version field even when it's
// zero, so the wire bytes are commonly `0x08 0x00 0x12 0x20 ...32...`
// (36 bytes) — not the 34-byte `0x12 0x20 ...32...` shortcut. The
// original parser only accepted the 34-byte shortcut and rejected
// every real Tink keyset.
//
// This implementation walks the proto looking for field 2 (key_value)
// length-delimited bytes of length 32, skipping any leading version
// field (or other unknown fields, which Tink permits as forward-
// compat). The 32-byte bare form (no proto wrapper, emitted by our
// own GenerateKeyset) is still accepted as a fast-path.
func extractAesGcmMaterial(raw []byte) ([]byte, error) {
	// Fast path: bare 32 bytes (GenerateKeyset's compact form).
	if len(raw) == 32 {
		out := make([]byte, 32)
		copy(out, raw)
		return out, nil
	}
	// Proto path. Iterate field-by-field. Each field starts with a
	// varint tag (field_number << 3 | wire_type).
	i := 0
	for i < len(raw) {
		tag, n, err := readVarint(raw[i:])
		if err != nil {
			return nil, fmt.Errorf("aes-gcm key proto: bad tag at offset %d: %w", i, err)
		}
		i += n
		fieldNumber := tag >> 3
		wireType := tag & 0x07
		switch wireType {
		case 0: // varint — skip
			_, n, err := readVarint(raw[i:])
			if err != nil {
				return nil, fmt.Errorf("aes-gcm key proto: bad varint at offset %d: %w", i, err)
			}
			i += n
		case 2: // length-delimited
			length, n, err := readVarint(raw[i:])
			if err != nil {
				return nil, fmt.Errorf("aes-gcm key proto: bad length at offset %d: %w", i, err)
			}
			i += n
			if length > uint64(len(raw)-i) {
				return nil, fmt.Errorf("aes-gcm key proto: length %d overflows buffer", length)
			}
			if fieldNumber == 2 {
				// key_value. Must be 32 bytes for AES-256-GCM.
				if length != 32 {
					return nil, fmt.Errorf("aes-gcm key_value must be 32 bytes, got %d", length)
				}
				out := make([]byte, 32)
				copy(out, raw[i:i+32])
				return out, nil
			}
			i += int(length)
		case 1: // 64-bit fixed — skip 8 bytes
			if len(raw)-i < 8 {
				return nil, fmt.Errorf("aes-gcm key proto: truncated 64-bit field")
			}
			i += 8
		case 5: // 32-bit fixed — skip 4 bytes
			if len(raw)-i < 4 {
				return nil, fmt.Errorf("aes-gcm key proto: truncated 32-bit field")
			}
			i += 4
		default:
			return nil, fmt.Errorf("aes-gcm key proto: unsupported wire type %d at field %d", wireType, fieldNumber)
		}
	}
	return nil, fmt.Errorf("aes-gcm key proto: no key_value field found (len=%d)", len(raw))
}

// readVarint decodes a protobuf varint from b and returns
// (value, bytes consumed, error). Bounded at 10 bytes (max uint64).
func readVarint(b []byte) (uint64, int, error) {
	var v uint64
	var shift uint
	for i := 0; i < len(b); i++ {
		if i >= 10 {
			return 0, 0, fmt.Errorf("varint too long")
		}
		c := b[i]
		v |= uint64(c&0x7F) << shift
		if c&0x80 == 0 {
			return v, i + 1, nil
		}
		shift += 7
	}
	return 0, 0, fmt.Errorf("truncated varint")
}

func (p *TinkProvider) lookup(keyRef string) (*tinkKeyset, error) {
	if p == nil {
		return nil, ErrProviderUnconfigured
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	ks, ok := p.keysets[keyRef]
	if !ok {
		return nil, fmt.Errorf("tink: no keyset registered for %q", keyRef)
	}
	_ = time.Now() // hint: future audit-log timestamping
	return ks, nil
}
