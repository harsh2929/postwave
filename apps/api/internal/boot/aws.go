// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"

	"github.com/postwave/postwave/apps/api/internal/config"
	pwcrypto "github.com/postwave/postwave/apps/api/internal/crypto"
	"github.com/postwave/postwave/apps/api/internal/sending"
	pwsecrets "github.com/postwave/postwave/packages/secrets"
)

// AWSDependencies is the single AWS boundary consumed by the API composition
// root. Keeping these values together prevents encryption, object-storage,
// BYOK, and integration-secret clients from loading divergent SDK
// configurations during one process start.
type AWSDependencies struct {
	Config          aws.Config
	KMSKeyID        string
	EnvelopeCipher  sending.EnvelopeEncryptor
	SecretsResolver pwsecrets.Resolver
}

// InitializeAWSDependencies loads optional AWS infrastructure and constructs
// the fallback chain used by downstream composition. Development remains
// usable without AWS; production fails closed unless the selected envelope
// cipher can complete an encrypt/decrypt readiness probe.
func InitializeAWSDependencies(cfg config.Config, logger *slog.Logger, production bool) (AWSDependencies, error) {
	dependencies := AWSDependencies{
		KMSKeyID:        os.Getenv("POSTWAVE_KMS_KEY_ID"),
		SecretsResolver: pwsecrets.NewEnvResolver(),
	}

	awsCtx, awsCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if region := os.Getenv("AWS_REGION"); region != "" {
		loaded, err := awsconfig.LoadDefaultConfig(awsCtx, awsconfig.WithRegion(region))
		if err != nil {
			logger.Warn("aws: failed to load config; falling back to legacy paths", "err", err.Error())
		} else {
			dependencies.Config = loaded
			logger.Info("aws: default config loaded", "region", region)
		}
	}
	awsCancel()

	// Keep the static cipher available as the legacy-decryption fallback even
	// when KMS handles all newly encrypted values.
	if key, err := pwcrypto.NewEnvKeyKMS(cfg.SendingKEK); err == nil {
		dependencies.EnvelopeCipher = pwcrypto.NewEnvelopeCipher(key)
	} else {
		logger.Warn("envelope cipher disabled, falling back to legacy direct AES-GCM", "err", err.Error())
	}
	if dependencies.Config.Region != "" && dependencies.KMSKeyID != "" {
		kmsClient := kms.NewFromConfig(dependencies.Config)
		dependencies.EnvelopeCipher = pwcrypto.NewKMSEnvelopeWithFallback(kmsClient, dependencies.KMSKeyID, cfg.SendingKEK)
		logger.Info("aws: KMS envelope encryption active", "key_id", dependencies.KMSKeyID)
	} else if dependencies.EnvelopeCipher != nil {
		logger.Warn("aws: KMS not configured (AWS_REGION/POSTWAVE_KMS_KEY_ID unset) — using static-key AES-GCM fallback")
	}

	if production {
		if err := pwcrypto.ValidateExactKMSKeyARN(
			dependencies.KMSKeyID, dependencies.Config.Region,
		); err != nil {
			return AWSDependencies{}, fmt.Errorf("at-rest encryption KMS provenance: %w", err)
		}
		verifyCtx, verifyCancel := context.WithTimeout(context.Background(), 12*time.Second)
		err := VerifyEnvelopeCipher(verifyCtx, dependencies.EnvelopeCipher)
		verifyCancel()
		if err != nil {
			return AWSDependencies{}, fmt.Errorf("at-rest encryption readiness: %w", err)
		}
		logger.Info("at-rest encryption readiness verified")
	}

	if backend := strings.ToLower(os.Getenv("POSTWAVE_SECRETS_BACKEND")); backend == "aws" && dependencies.Config.Region != "" {
		secretsManagerClient := secretsmanager.NewFromConfig(dependencies.Config)
		dependencies.SecretsResolver = pwsecrets.NewChain(
			pwsecrets.NewAwsResolver(secretsManagerClient, pwsecrets.DefaultCacheTTL),
			pwsecrets.NewEnvResolver(),
		)
		logger.Info("aws: Secrets Manager resolver active")
	}

	return dependencies, nil
}

// VerifyEnvelopeCipher checks both sides of the configured at-rest encryption
// boundary before production starts accepting traffic.
func VerifyEnvelopeCipher(ctx context.Context, cipher sending.EnvelopeEncryptor) error {
	if cipher == nil {
		return errors.New("envelope cipher is not configured")
	}
	probe := []byte("postwave-at-rest-readiness-v1")
	sealed, err := cipher.Encrypt(ctx, probe)
	if err != nil {
		return fmt.Errorf("encrypt probe: %w", err)
	}
	opened, err := cipher.Decrypt(ctx, sealed, nil)
	if err != nil {
		return fmt.Errorf("decrypt probe: %w", err)
	}
	if !bytes.Equal(opened, probe) {
		return errors.New("envelope cipher probe did not round-trip")
	}
	return nil
}
