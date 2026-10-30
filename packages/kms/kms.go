// SPDX-License-Identifier: MIT

// Package kms is the provider abstraction layer for Bring-Your-Own-Key (BYOK).
//
// Why a separate package: apps/api/internal/crypto already implements
// envelope encryption against a single platform-wide AWS KMS key. BYOK
// requires routing wrap/unwrap calls to the *tenant's* KMS — which may be
// AWS KMS, GCP KMS, HashiCorp Vault, or a Tink-formatted local keyset —
// and surfacing key references through a stable Go interface so the
// cipher layer never has to grow conditionals per provider.
//
// Wire format integration: this package only handles "wrap a 32-byte DEK
// to produce an opaque blob, unwrap an opaque blob back to the DEK". The
// envelope framing ([version][len][wrapped][nonce][ciphertext]) is owned
// by apps/api/internal/crypto. A new envelope version (0x03) prepends a
// provider+key_ref prefix so Decrypt knows which provider's UnwrapDEK
// to call without an out-of-band lookup.
//
// Concurrency: every provider must be safe for concurrent WrapDEK /
// UnwrapDEK calls. Wrap/unwrap operations never expose plaintext DEKs in
// long-lived data structures (the cipher layer zeroes them before
// return).
package kms

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// Provider is the contract every KMS backend implements. KeyRef is the
// provider-specific identifier (KMS key id/alias/ARN for AWS, resource
// name for GCP, transit-key name for Vault, keyset id for Tink). The
// caller never inspects KeyRef — it's just an opaque string the resolver
// hands to the right provider.
type Provider interface {
	// Name returns the provider's stable identifier ("aws", "gcp",
	// "vault", "tink"). Used for routing + audit logging.
	Name() string

	// WrapDEK encrypts the plaintext DEK with the KEK referenced by
	// keyRef and returns the wrapped blob. plainDEK is always 32 bytes
	// (AES-256). Callers MUST zero plainDEK after a successful call.
	WrapDEK(ctx context.Context, keyRef string, plainDEK []byte) (wrapped []byte, err error)

	// UnwrapDEK reverses WrapDEK. The returned plaintext must be 32
	// bytes; callers MUST zero it after use.
	UnwrapDEK(ctx context.Context, keyRef string, wrapped []byte) (plainDEK []byte, err error)

	// HealthCheck performs a cheap round-trip against the provider to
	// validate connectivity + permissions. Used by the admin "test
	// key" endpoint to surface misconfiguration early (wrong region,
	// missing kms:Decrypt permission, etc.).
	HealthCheck(ctx context.Context, keyRef string) error
}

// Errors callers can branch on.
var (
	// ErrProviderUnconfigured is returned when a provider is constructed
	// without the credentials it needs (e.g. Vault URL missing, GCP
	// service-account JSON missing).
	ErrProviderUnconfigured = errors.New("kms provider unconfigured")

	// ErrInvalidKeyRef is returned when keyRef doesn't match the
	// provider's expected format.
	ErrInvalidKeyRef = errors.New("kms: invalid key reference")

	// ErrUnknownProvider is returned by Registry.Get when a provider
	// name doesn't resolve.
	ErrUnknownProvider = errors.New("kms: unknown provider")

	// ErrPermissionDenied is returned by providers when the caller
	// lacks permission to use the referenced key (e.g. AWS KMS
	// AccessDenied, Vault permission denied). Distinguished from
	// generic errors so the admin "test key" UI can surface a
	// specific remediation hint.
	ErrPermissionDenied = errors.New("kms: permission denied")
)

// DefaultTimeout caps every provider round trip. KMS control planes are
// occasionally slow; 5s is generous enough to absorb burst latency but
// tight enough to keep handlers responsive.
const DefaultTimeout = 5 * time.Second

// DEKSize is the canonical DEK length (AES-256 = 32 bytes). Providers
// reject DEKs that aren't this size.
const DEKSize = 32

// GenerateDEK returns a cryptographically random 32-byte DEK. Pulled out
// of the cipher layer so callers can pre-allocate the DEK before deciding
// which provider to wrap with.
func GenerateDEK() ([]byte, error) {
	dek := make([]byte, DEKSize)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return nil, fmt.Errorf("kms: generate dek: %w", err)
	}
	return dek, nil
}

// Registry is the central lookup of provider name → Provider. Most
// deployments configure providers once at boot and consult the Registry
// for routing decisions per-request.
type Registry struct {
	mu        sync.RWMutex
	providers map[string]Provider
}

// NewRegistry returns an empty registry. Use Register to populate.
func NewRegistry() *Registry {
	return &Registry{providers: map[string]Provider{}}
}

// Register installs a provider under its Name(). Later calls with the
// same name overwrite — useful when swapping a real backend for a fake
// in tests.
func (r *Registry) Register(p Provider) {
	if p == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[p.Name()] = p
}

// Get returns the provider registered under name or ErrUnknownProvider.
func (r *Registry) Get(name string) (Provider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.providers[strings.ToLower(name)]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownProvider, name)
	}
	return p, nil
}

// Names returns the registered provider names, sorted by registration
// order is NOT guaranteed — callers that need a stable order should sort
// the result.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.providers))
	for n := range r.providers {
		out = append(out, n)
	}
	return out
}

// TenantKey is the cipher-layer view of a tenant's active KEK. The
// repository layer (apps/api/internal/byok) hydrates this from the
// tenant_keys table.
type TenantKey struct {
	// ID is the database-level identifier (UUID). Stamped onto envelope
	// blobs in the v=0x03 wire format so Decrypt routes to the right
	// provider + KeyRef without a second DB lookup per call.
	ID string

	// TenantID owns this key. Mismatch on Decrypt is a hard error.
	TenantID string

	// Provider is one of "aws" | "gcp" | "vault" | "tink".
	Provider string

	// KeyRef is the provider-specific reference (KMS ARN, GCP resource
	// name, Vault transit key name, Tink keyset id).
	KeyRef string

	// Status indicates the lifecycle state of the key.
	Status TenantKeyStatus

	// Description is operator-facing free text ("EU prod KEK",
	// "rotated 2025-11").
	Description string

	// CreatedAt / RotatedAt let the admin UI surface key age.
	CreatedAt time.Time
	RotatedAt *time.Time
}

// TenantKeyStatus is the lifecycle state.
type TenantKeyStatus string

const (
	// StatusActive means new writes are encrypted under this key.
	// Exactly one TenantKey per tenant must be active.
	StatusActive TenantKeyStatus = "active"

	// StatusInactive means the key exists and can decrypt existing
	// blobs but new writes don't use it. Result of rotation.
	StatusInactive TenantKeyStatus = "inactive"

	// StatusDeleted means the key is soft-deleted. Decrypt should
	// still work as long as the KEK itself is reachable in the
	// provider (the row is preserved for forensics).
	StatusDeleted TenantKeyStatus = "deleted"
)

// IsValidStatus returns true if s is one of the canonical statuses.
func IsValidStatus(s TenantKeyStatus) bool {
	switch s {
	case StatusActive, StatusInactive, StatusDeleted:
		return true
	}
	return false
}

// IsValidProvider returns true if p is one of the four canonical
// providers.
func IsValidProvider(p string) bool {
	switch strings.ToLower(p) {
	case "aws", "gcp", "vault", "tink":
		return true
	}
	return false
}
