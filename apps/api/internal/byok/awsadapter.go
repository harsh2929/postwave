// SPDX-License-Identifier: AGPL-3.0-only
//
// awsadapter.go bridges the AWS-SDK-v2 *kms.Client (concrete) to the
// narrow pwkms.AWSClient interface (abstract), and provides the
// registry-builder that main.go calls at boot to populate the BYOK
// provider registry.
//
// Until this file existed, main.go constructed an EMPTY registry
// (`pwkms.NewRegistry()`) and every BYOK HealthCheck/Encrypt call
// failed with "unknown provider 'aws'" — the BYOK admin endpoints
// were structurally complete but functionally inert. The audit
// flagged this as the "BYOK provider wiring" feature gap.

package byok

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"

	pwkms "github.com/postwave/postwave/packages/kms"
)

// AWSKMSAdapter wraps an AWS-SDK-v2 *kms.Client so it satisfies
// pwkms.AWSClient. The wrapper is a thin pass-through: it exists so
// the pwkms package can stay free of the aws-sdk-go-v2 import (keeps
// the abstraction testable without a network) while apps/api can
// still wire the real SDK client.
type AWSKMSAdapter struct {
	Client *kms.Client
}

// GenerateDataKey returns (plaintext_dek, wrapped_dek). KeySpec is
// fixed to AES_256 to match pwkms.DEKSize.
func (a *AWSKMSAdapter) GenerateDataKey(ctx context.Context, keyID string) ([]byte, []byte, error) {
	out, err := a.Client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:   aws.String(keyID),
		KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil {
		return nil, nil, mapAWSError(err)
	}
	return out.Plaintext, out.CiphertextBlob, nil
}

// Encrypt wraps an arbitrary plaintext (≤4 KB by AWS limit) under the
// referenced KMS key. Used by WrapDEK so callers may supply their own
// DEK rather than the one AWS generates.
func (a *AWSKMSAdapter) Encrypt(ctx context.Context, keyID string, plaintext []byte) ([]byte, error) {
	out, err := a.Client.Encrypt(ctx, &kms.EncryptInput{
		KeyId:     aws.String(keyID),
		Plaintext: plaintext,
	})
	if err != nil {
		return nil, mapAWSError(err)
	}
	return out.CiphertextBlob, nil
}

// Decrypt unwraps a previously-wrapped DEK. We pass KeyId explicitly
// even though AWS KMS can derive it from the blob — this catches a
// client that hands us a blob wrapped under the wrong key (the API
// returns AccessDenied rather than IncorrectKeyException in that
// case, which is the right failure mode for BYOK isolation).
func (a *AWSKMSAdapter) Decrypt(ctx context.Context, keyID string, wrapped []byte) ([]byte, error) {
	out, err := a.Client.Decrypt(ctx, &kms.DecryptInput{
		KeyId:          aws.String(keyID),
		CiphertextBlob: wrapped,
	})
	if err != nil {
		return nil, mapAWSError(err)
	}
	return out.Plaintext, nil
}

// mapAWSError translates AWS-specific permission errors into the
// generic pwkms sentinels so the cipher layer can branch on them
// without an aws-sdk-go-v2 dependency. Falls through unchanged on
// errors we don't recognize.
func mapAWSError(err error) error {
	if err == nil {
		return nil
	}
	var notFound *kmstypes.NotFoundException
	if errors.As(err, &notFound) {
		return pwkms.ErrInvalidKeyRef
	}
	var badState *kmstypes.KMSInvalidStateException
	if errors.As(err, &badState) {
		return pwkms.ErrPermissionDenied
	}
	return err
}

// BuildRegistry returns a pwkms.Registry populated with every
// configured provider. Called once at boot from main.go.
//
//   - awsClient non-nil  → registers an "aws" provider that wraps it.
//   - awsClient nil      → no AWS provider; tenants cannot create
//     aws-backed keys in this deployment.
//
// GCP / Vault / Tink providers are intentionally NOT wired here —
// each needs its own credential plumbing (GCP service-account JSON,
// Vault URL + token, Tink keyset bytes) that the operator supplies
// via deployment-specific env vars. Adding them follows the same
// pattern: build a pwkms.Provider, call Registry.Register(p).
func BuildRegistry(awsClient *kms.Client) *pwkms.Registry {
	reg := pwkms.NewRegistry()
	if awsClient != nil {
		reg.Register(pwkms.NewAWSProvider(&AWSKMSAdapter{Client: awsClient}))
	}
	return reg
}
