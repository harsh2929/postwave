// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"

	apiboot "github.com/postwave/postwave/apps/api/internal/boot"
	"github.com/postwave/postwave/apps/api/internal/conversions"
	pwcrypto "github.com/postwave/postwave/apps/api/internal/crypto"
	"github.com/postwave/postwave/apps/api/internal/db"
)

func validateProjectionKMSKeyARN(keyARN, region string) error {
	if strings.TrimSpace(region) == "" {
		return fmt.Errorf("AWS_REGION is required for email-HMAC projection")
	}
	if err := pwcrypto.ValidateExactKMSKeyARN(keyARN, region); err != nil {
		return fmt.Errorf("POSTWAVE_KMS_KEY_ID email-HMAC projection provenance: %w", err)
	}
	return nil
}

// emailHMACProjectionWorkerFromEnvironment deliberately has no static-cipher
// fallback. Production projection is permitted to unwrap signing credentials
// only through the exact immutable KMS key ARN supplied to the worker task.
func emailHMACProjectionWorkerFromEnvironment(
	ctx context.Context,
	pool *db.Pool,
	awsConfiguration aws.Config,
	workerID string,
) (*conversions.EmailHMACProjectionWorker, error) {
	keyARN := strings.TrimSpace(os.Getenv("POSTWAVE_KMS_KEY_ID"))
	if err := validateProjectionKMSKeyARN(keyARN, awsConfiguration.Region); err != nil {
		return nil, err
	}
	cipher := pwcrypto.NewKMSEnvelope(kms.NewFromConfig(awsConfiguration), keyARN)
	if err := apiboot.VerifyEnvelopeCipher(ctx, cipher); err != nil {
		return nil, fmt.Errorf("email-HMAC projection exact-KMS readiness: %w", err)
	}
	repository, err := conversions.NewEmailHMACProjectionRepository(pool)
	if err != nil {
		return nil, err
	}
	worker, err := conversions.NewEmailHMACProjectionWorker(
		repository, cipher,
		conversions.DefaultEmailHMACProjectionWorkerConfiguration(
			workerID+"-email-hmac",
		),
	)
	if err != nil {
		return nil, err
	}
	if err := worker.Ready(ctx); err != nil {
		return nil, fmt.Errorf("email-HMAC projection schema readiness: %w", err)
	}
	return worker, nil
}

func logEmailHMACProjection(
	logger *slog.Logger,
	result conversions.EmailHMACProjectionSweepResult,
	err error,
) {
	attributes := []any{
		"claimed", result.Claimed,
		"pages", result.Pages,
		"subscribers_projected", result.Subscribers,
		"completed", result.Completed,
		"retried", result.Retried,
		"lease_lost", result.LeaseLost,
		"failed_visible", result.FailedVisible,
		"stale_present", result.StalePresent,
	}
	if result.FailedVisible > 0 || result.FailureSignal {
		logger.Error("conversion email-HMAC identity projection requires operator attention",
			append(attributes, "error_class", "email_hmac_projection_failed")...)
		return
	}
	if result.StaleSignal {
		logger.Error("conversion email-HMAC identity projection backlog is stale",
			append(attributes, "error_class", "email_hmac_projection_stale")...)
		return
	}
	if err != nil {
		// The stable class is actionable and safe; do not serialize arbitrary
		// dependency errors next to a credential-processing worker.
		logger.Warn("conversion email-HMAC identity projection sweep degraded",
			append(attributes, "error_class", "email_hmac_projection_retry")...)
		return
	}
	if result.Claimed > 0 {
		logger.Info("conversion email-HMAC identity projection sweep completed", attributes...)
	}
}
