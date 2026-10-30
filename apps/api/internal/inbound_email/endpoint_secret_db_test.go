// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// endpointTestCipher is reversible test-only wrapping. Production uses the
// platform AES-GCM/KMS envelope implementation wired in main.go.
type endpointTestCipher struct{}

type endpointFailCipher struct{}

func (endpointFailCipher) Encrypt(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("kms unavailable")
}

func (endpointFailCipher) Decrypt(context.Context, []byte, []byte) ([]byte, error) {
	return nil, errors.New("kms unavailable")
}

func (endpointTestCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	out := make([]byte, len(plaintext)+1)
	out[0] = 0x7e
	for i, b := range plaintext {
		out[i+1] = b ^ 0xa5
	}
	return out, nil
}

func (endpointTestCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	if len(blob) < 2 || blob[0] != 0x7e {
		return nil, errors.New("invalid test envelope")
	}
	out := make([]byte, len(blob)-1)
	for i, b := range blob[1:] {
		out[i] = b ^ 0xa5
	}
	return out, nil
}

func TestInboundEmailEndpointSecretLifecycle(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()
	ctx := context.Background()
	repo := &Repo{Pool: pool, Cipher: endpointTestCipher{}}

	if _, err := repo.GetEndpoint(ctx, tenantID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("metadata before provisioning error = %v, want ErrNotFound", err)
	}
	first, lifecycleErr := repo.RotateSecret(ctx, tenantID)
	if lifecycleErr != nil {
		t.Fatalf("create secret: %v", lifecycleErr)
	}
	if first.Secret == "" || !first.SecretConfigured || first.RotationRequired || first.SecretRotatedAt == nil {
		t.Fatalf("bad one-shot create response: %+v", first)
	}

	metadata, lifecycleErr := repo.GetEndpoint(ctx, tenantID)
	if lifecycleErr != nil {
		t.Fatalf("get metadata: %v", lifecycleErr)
	}
	if metadata.Secret != "" || !metadata.SecretConfigured || metadata.RotationRequired {
		t.Fatalf("GET exposed or misreported secret state: %+v", metadata)
	}

	tx, lifecycleErr := db.WithTenant(ctx, pool, tenantID)
	if lifecycleErr != nil {
		t.Fatal(lifecycleErr)
	}
	var sentinel string
	var envelope []byte
	if err := tx.QueryRow(ctx, `
SELECT secret, secret_envelope
FROM inbound_email_endpoints
WHERE tenant_id = $1::uuid`, tenantID).Scan(&sentinel, &envelope); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if sentinel != "rotation-required" {
		t.Fatalf("legacy secret column = %q, want non-secret sentinel", sentinel)
	}
	if len(envelope) == 0 || bytes.Equal(envelope, []byte(first.Secret)) || bytes.Contains(envelope, []byte(first.Secret)) {
		t.Fatalf("secret was not envelope-wrapped at rest")
	}

	_, lookedUpTenant, unwrapped, lifecycleErr := repo.LookupBySlug(ctx, first.Slug)
	if lifecycleErr != nil {
		t.Fatalf("lookup encrypted secret: %v", lifecycleErr)
	}
	if lookedUpTenant != tenantID || string(unwrapped) != first.Secret {
		t.Fatalf("lookup = tenant %q secret match %v", lookedUpTenant, string(unwrapped) == first.Secret)
	}
	clearSecret(unwrapped)

	second, lifecycleErr := repo.RotateSecret(ctx, tenantID)
	if lifecycleErr != nil {
		t.Fatalf("rotate secret: %v", lifecycleErr)
	}
	if second.Slug != first.Slug || second.Secret == "" || second.Secret == first.Secret {
		t.Fatalf("rotation did not retain slug and replace secret: first=%+v second=%+v", first, second)
	}

	body := []byte(`{"From":"subscriber@example.com","MessageID":"provider-event"}`)
	now := time.Unix(1_800_000_000, 0)
	timestamp := "1800000000"
	sign := func(secret string) string {
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write(append([]byte(timestamp+"."), body...))
		return hex.EncodeToString(mac.Sum(nil))
	}
	if !errors.Is(authenticateInboundEmail([]byte(second.Secret), body, timestamp, sign(first.Secret), now), errInboundEmailBadSignature) {
		t.Fatal("pre-rotation secret remained valid")
	}
	if err := authenticateInboundEmail([]byte(second.Secret), body, timestamp, sign(second.Secret), now); err != nil {
		t.Fatalf("rotated secret rejected: %v", err)
	}

	tx, lifecycleErr = db.WithTenant(ctx, pool, tenantID)
	if lifecycleErr != nil {
		t.Fatal(lifecycleErr)
	}
	if _, err := tx.Exec(ctx, `
UPDATE inbound_email_endpoints
SET secret_envelope = NULL, secret_rotated_at = NULL
WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := repo.LookupBySlug(ctx, first.Slug); !errors.Is(err, ErrSecretUnavailable) {
		t.Fatalf("missing envelope error = %v, want ErrSecretUnavailable", err)
	}
}

func TestInboundEmailEndpointRejectsMissingCipherBeforeWrite(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.RotateSecret(t.Context(), "tenant"); !errors.Is(err, ErrSecretUnavailable) {
		t.Fatalf("missing cipher error = %v, want ErrSecretUnavailable", err)
	}
	repo.Cipher = endpointFailCipher{}
	if _, err := repo.RotateSecret(t.Context(), "tenant"); !errors.Is(err, ErrSecretUnavailable) {
		t.Fatalf("failed cipher error = %v, want ErrSecretUnavailable", err)
	}
}
