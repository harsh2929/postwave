// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRejectProviderCapability(t *testing.T) {
	t.Parallel()

	for _, environment := range [][]string{
		{"POSTWAVE_CAMPAIGN_ASSURANCE_GEMINI_API_KEY=provider-secret"},
		{"GEMINI_API_KEY=provider-secret"},
		{"POSTWAVE_CAMPAIGN_ASSURANCE_PROVIDER_GATEWAY_SOCKET=/run/provider.sock"},
	} {
		err := rejectProviderCapability(environment)
		if err == nil {
			t.Fatalf("environment %v was accepted", environment)
		}
		if strings.Contains(err.Error(), "provider-secret") {
			t.Fatalf("error leaked a credential value: %v", err)
		}
	}
	if err := rejectProviderCapability([]string{
		"DATABASE_URL=postgres://worker",
		"POSTWAVE_CAMPAIGN_ASSURANCE_MODEL_SANDBOX_SOCKET=/run/model.sock",
	}); err != nil {
		t.Fatalf("worker-only dependencies were rejected: %v", err)
	}
}

func TestRetryReadinessRequiresSuccessOrCancellation(t *testing.T) {
	t.Parallel()

	attempts := 0
	if err := retryReadiness(t.Context(), func(context.Context) error {
		attempts++
		return nil
	}); err != nil || attempts != 1 {
		t.Fatalf("immediate readiness = (%v, %d attempts), want (nil, 1)", err, attempts)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	sentinel := errors.New("not ready")
	err := retryReadiness(ctx, func(context.Context) error { return sentinel })
	if !errors.Is(err, sentinel) || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled readiness error = %v, want dependency and cancellation", err)
	}
}

func TestRetryBackoffIsBounded(t *testing.T) {
	t.Parallel()

	if got := retryBackoff(1); got != time.Minute {
		t.Fatalf("first delay = %s, want 1m", got)
	}
	if got := retryBackoff(1_000); got != 64*time.Minute {
		t.Fatalf("bounded delay = %s, want 64m", got)
	}
}

func TestProjectionKMSKeyMustBeAnExactRegionalKeyARN(t *testing.T) {
	t.Parallel()

	for _, accepted := range []struct {
		arn    string
		region string
	}{
		{"arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012", "us-east-1"},
		{"arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/key-id", "us-gov-west-1"},
		{"arn:aws-cn:kms:cn-north-1:123456789012:key/key-id", "cn-north-1"},
	} {
		if err := validateProjectionKMSKeyARN(accepted.arn, accepted.region); err != nil {
			t.Errorf("exact ARN %q rejected: %v", accepted.arn, err)
		}
	}
	for _, rejected := range []struct {
		name   string
		arn    string
		region string
	}{
		{"empty", "", "us-east-1"},
		{"bare key id", "12345678-1234-1234-1234-123456789012", "us-east-1"},
		{"alias ARN", "arn:aws:kms:us-east-1:123456789012:alias/postwave", "us-east-1"},
		{"wildcard", "arn:aws:kms:us-east-1:123456789012:key/*", "us-east-1"},
		{"missing account", "arn:aws:kms:us-east-1::key/key-id", "us-east-1"},
		{"wrong region", "arn:aws:kms:us-east-1:123456789012:key/key-id", "us-west-2"},
		{"missing runtime region", "arn:aws:kms:us-east-1:123456789012:key/key-id", ""},
	} {
		t.Run(rejected.name, func(t *testing.T) {
			t.Parallel()
			if err := validateProjectionKMSKeyARN(rejected.arn, rejected.region); err == nil {
				t.Fatalf("unsafe KMS identity accepted: %q / %q", rejected.arn, rejected.region)
			}
		})
	}
}
