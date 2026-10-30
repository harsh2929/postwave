// SPDX-License-Identifier: MIT

package kms

import (
	"context"
	"fmt"
	"time"
)

// AWSClient is the narrow surface the AWS provider consumes. We keep
// the dependency one-way (this package -> the client) so the kms package
// doesn't pull aws-sdk-go-v2 into its import set. Wiring sites in
// apps/api pass a real *kms.Client through the AWSClient adapter
// implemented there.
//
// The three operations:
//   - GenerateDataKey: used by HealthCheck (round-trips a fresh DEK)
//   - Encrypt: wraps an arbitrary plaintext (≤4 KB) under the KMS key.
//     Used by WrapDEK so callers can supply their own DEK (matching the
//     abstract Provider contract).
//   - Decrypt: unwraps a wrapped DEK.
type AWSClient interface {
	GenerateDataKey(ctx context.Context, keyID string) (plaintextDEK, wrappedDEK []byte, err error)
	Encrypt(ctx context.Context, keyID string, plaintext []byte) (wrapped []byte, err error)
	Decrypt(ctx context.Context, keyID string, wrapped []byte) (plaintextDEK []byte, err error)
}

// AWSProvider wraps DEKs against an AWS KMS key. Each tenant_keys row
// stores the AWS KMS key ARN/alias as KeyRef. The provider is stateless;
// the AWSClient handle is goroutine-safe.
type AWSProvider struct {
	Client  AWSClient
	Timeout time.Duration
}

// NewAWSProvider constructs an AWSProvider with the default timeout.
func NewAWSProvider(c AWSClient) *AWSProvider {
	return &AWSProvider{Client: c, Timeout: DefaultTimeout}
}

// Name returns "aws".
func (p *AWSProvider) Name() string { return "aws" }

// WrapDEK calls kms:Encrypt to wrap an arbitrary plaintext DEK under
// the customer's KMS key. Matches the abstract Provider contract
// (caller-supplied DEK) at the cost of one extra round trip vs.
// GenerateDataKey — acceptable since wrap operations happen at
// rotation time, not per-request.
func (p *AWSProvider) WrapDEK(ctx context.Context, keyRef string, plainDEK []byte) ([]byte, error) {
	if p == nil || p.Client == nil {
		return nil, ErrProviderUnconfigured
	}
	if len(plainDEK) != DEKSize {
		return nil, fmt.Errorf("%w: aws: expected %d-byte DEK, got %d", ErrInvalidKeyRef, DEKSize, len(plainDEK))
	}
	if keyRef == "" {
		return nil, fmt.Errorf("%w: aws: empty keyRef", ErrInvalidKeyRef)
	}
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	wrapped, err := p.Client.Encrypt(ctx, keyRef, plainDEK)
	if err != nil {
		return nil, fmt.Errorf("aws kms encrypt: %w", err)
	}
	return wrapped, nil
}

// UnwrapDEK delegates to AWSClient.Decrypt.
func (p *AWSProvider) UnwrapDEK(ctx context.Context, keyRef string, wrapped []byte) ([]byte, error) {
	if p == nil || p.Client == nil {
		return nil, ErrProviderUnconfigured
	}
	if keyRef == "" {
		return nil, fmt.Errorf("%w: aws: empty keyRef", ErrInvalidKeyRef)
	}
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	dek, err := p.Client.Decrypt(ctx, keyRef, wrapped)
	if err != nil {
		return nil, fmt.Errorf("aws kms decrypt: %w", err)
	}
	if len(dek) != DEKSize {
		return nil, fmt.Errorf("aws kms returned %d-byte DEK, expected %d", len(dek), DEKSize)
	}
	return dek, nil
}

// HealthCheck performs a cheap GenerateDataKey to validate the keyRef.
func (p *AWSProvider) HealthCheck(ctx context.Context, keyRef string) error {
	if p == nil || p.Client == nil {
		return ErrProviderUnconfigured
	}
	if keyRef == "" {
		return fmt.Errorf("%w: aws: empty keyRef", ErrInvalidKeyRef)
	}
	ctx, cancel := context.WithTimeout(ctx, p.timeout())
	defer cancel()
	dek, wrapped, err := p.Client.GenerateDataKey(ctx, keyRef)
	if err != nil {
		return fmt.Errorf("aws kms health-check failed: %w", err)
	}
	// Round-trip: re-decrypt to verify permissions in both directions.
	if _, err := p.Client.Decrypt(ctx, keyRef, wrapped); err != nil {
		zero(dek)
		return fmt.Errorf("aws kms decrypt-after-generate failed: %w", err)
	}
	zero(dek)
	return nil
}

func (p *AWSProvider) timeout() time.Duration {
	if p.Timeout <= 0 {
		return DefaultTimeout
	}
	return p.Timeout
}

// zero overwrites b with zeros. Helper duplicated locally so this
// package has no internal deps.
func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
