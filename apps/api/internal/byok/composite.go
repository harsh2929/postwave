// SPDX-License-Identifier: AGPL-3.0-only
package byok

import (
	"context"
	"errors"
)

// PlatformCipher is the narrow surface composite cipher needs from the
// existing platform-wide AwsKMSEnvelope / EnvelopeCipher (defined in
// apps/api/internal/crypto). Mirroring it as an interface keeps this
// package free of the apps/api/internal/crypto dep and avoids an import
// cycle.
type PlatformCipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// Composite is the production cipher that routes by tenant:
//   - Tenants with an active BYOK key encrypt under the tenant cipher
//     (v=0x03 wire format).
//   - Tenants without BYOK encrypt under the platform cipher (v=0x02).
//   - Decrypt sniffs the version byte and dispatches accordingly, so
//     read paths Just Work regardless of which cipher wrote the blob.
//
// This means rolling out BYOK is purely a write-time decision per tenant:
// existing platform-encrypted rows decrypt unchanged forever, and a
// tenant can adopt BYOK without a bulk re-encryption job (their old
// rows stay readable; new rows get the new cipher).
type Composite struct {
	Tenant   *TenantCipher
	Platform PlatformCipher
	// LegacyKEK is forwarded to Platform.Decrypt for v=0x01 blobs.
	LegacyKEK []byte
}

// NewComposite wires the two ciphers + the legacy fallback.
func NewComposite(t *TenantCipher, p PlatformCipher, legacyKEK []byte) *Composite {
	return &Composite{Tenant: t, Platform: p, LegacyKEK: legacyKEK}
}

// EncryptForTenant routes by tenant: if BYOK is active, the tenant
// cipher writes a v=0x03 blob; otherwise the platform cipher writes a
// v=0x02 blob.
func (c *Composite) EncryptForTenant(ctx context.Context, tenantID string, plaintext []byte) ([]byte, error) {
	if c == nil {
		return nil, errors.New("byok composite: not configured")
	}
	if c.Tenant != nil {
		has, err := c.Tenant.HasActiveKey(ctx, tenantID)
		if err != nil {
			return nil, err
		}
		if has {
			return c.Tenant.EncryptForTenant(ctx, tenantID, plaintext)
		}
	}
	if c.Platform == nil {
		return nil, errors.New("byok composite: no platform cipher and tenant has no BYOK key")
	}
	return c.Platform.Encrypt(ctx, plaintext)
}

// DecryptForTenant sniffs the version byte and dispatches.
func (c *Composite) DecryptForTenant(ctx context.Context, tenantID string, blob []byte) ([]byte, error) {
	if c == nil {
		return nil, errors.New("byok composite: not configured")
	}
	if len(blob) == 0 {
		return nil, errors.New("byok composite: empty blob")
	}
	if IsTenantEnvelope(blob) {
		if c.Tenant == nil {
			return nil, errors.New("byok composite: v=0x03 blob but no tenant cipher wired")
		}
		return c.Tenant.DecryptForTenant(ctx, tenantID, blob)
	}
	if c.Platform == nil {
		return nil, errors.New("byok composite: platform cipher required for non-tenant envelope")
	}
	return c.Platform.Decrypt(ctx, blob, c.LegacyKEK)
}
