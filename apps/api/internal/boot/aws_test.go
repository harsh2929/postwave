// SPDX-License-Identifier: AGPL-3.0-only

package boot

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/config"
)

type readinessCipher struct {
	encryptErr error
	decryptErr error
	corrupt    bool
}

func (cipher readinessCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	if cipher.encryptErr != nil {
		return nil, cipher.encryptErr
	}
	return append([]byte("sealed:"), plaintext...), nil
}

func (cipher readinessCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	if cipher.decryptErr != nil {
		return nil, cipher.decryptErr
	}
	if cipher.corrupt {
		return []byte("different"), nil
	}
	return append([]byte(nil), blob[len("sealed:"):]...), nil
}

func TestInitializeAWSDependenciesUsesLocalFallbacks(t *testing.T) {
	setLocalAWSEnvironment(t)
	t.Setenv("POSTWAVE_KMS_KEY_ID", "alias/not-loaded-without-region")
	t.Setenv("POSTWAVE_SECRETS_BACKEND", "aws")
	t.Setenv("POSTWAVE_TEST_STARTUP_SECRET", "resolved-locally")

	dependencies, err := InitializeAWSDependencies(config.Config{
		SendingKEK: bytes.Repeat([]byte{0x42}, 32),
	}, newDiscardLogger(), false)
	if err != nil {
		t.Fatalf("InitializeAWSDependencies() error = %v", err)
	}
	if dependencies.Config.Region != "" {
		t.Fatalf("AWS region = %q, want empty local configuration", dependencies.Config.Region)
	}
	if dependencies.KMSKeyID != "alias/not-loaded-without-region" {
		t.Fatalf("KMS key ID = %q", dependencies.KMSKeyID)
	}
	if err := VerifyEnvelopeCipher(context.Background(), dependencies.EnvelopeCipher); err != nil {
		t.Fatalf("static envelope fallback readiness = %v", err)
	}
	secret, err := dependencies.SecretsResolver.Get(context.Background(), "postwave/test-startup-secret")
	if err != nil {
		t.Fatalf("env secrets fallback Get() error = %v", err)
	}
	if secret != "resolved-locally" {
		t.Fatalf("env secrets fallback = %q", secret)
	}
}

func TestInitializeAWSDependenciesFailsClosedWithoutExactProductionKMSProvenance(t *testing.T) {
	setLocalAWSEnvironment(t)

	_, err := InitializeAWSDependencies(config.Config{}, newDiscardLogger(), true)
	if err == nil || !strings.Contains(err.Error(), "at-rest encryption KMS provenance") {
		t.Fatalf("InitializeAWSDependencies() error = %v, want exact-KMS provenance failure", err)
	}
}

func TestVerifyEnvelopeCipher(t *testing.T) {
	t.Parallel()

	if err := VerifyEnvelopeCipher(context.Background(), readinessCipher{}); err != nil {
		t.Fatalf("healthy cipher rejected: %v", err)
	}
	for _, test := range []struct {
		name   string
		cipher interface {
			Encrypt(context.Context, []byte) ([]byte, error)
			Decrypt(context.Context, []byte, []byte) ([]byte, error)
		}
	}{
		{name: "missing", cipher: nil},
		{name: "encrypt failure", cipher: readinessCipher{encryptErr: errors.New("kms unavailable")}},
		{name: "decrypt failure", cipher: readinessCipher{decryptErr: errors.New("kms denied")}},
		{name: "corrupt round trip", cipher: readinessCipher{corrupt: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := VerifyEnvelopeCipher(context.Background(), test.cipher); err == nil {
				t.Fatal("expected readiness failure")
			}
		})
	}
}

func setLocalAWSEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"AWS_REGION",
		"POSTWAVE_KMS_KEY_ID",
		"POSTWAVE_SECRETS_BACKEND",
	} {
		t.Setenv(key, "")
	}
}

func newDiscardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
