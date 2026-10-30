// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

type ingestSecretCipherStub struct {
	mu       sync.Mutex
	envelope []byte
	err      error
	saw      []byte
	kmsARN   string
}

func (cipher *ingestSecretCipherStub) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	cipher.mu.Lock()
	defer cipher.mu.Unlock()
	cipher.saw = append([]byte(nil), plaintext...)
	return append([]byte(nil), cipher.envelope...), cipher.err
}

func (cipher *ingestSecretCipherStub) plaintextSeen() []byte {
	cipher.mu.Lock()
	defer cipher.mu.Unlock()
	return append([]byte(nil), cipher.saw...)
}

func (*ingestSecretCipherStub) Decrypt(context.Context, []byte, []byte) ([]byte, error) {
	return nil, errors.New("not used")
}

func (cipher *ingestSecretCipherStub) KMSKeyARN() string {
	if cipher.kmsARN != "" {
		return cipher.kmsARN
	}
	return testConversionKMSKeyARN
}

func TestIngestSecretStorageUsesEnvelopeWithoutPlaintextFallback(t *testing.T) {
	cipher := &ingestSecretCipherStub{envelope: []byte{0x02, 's', 'e', 'a', 'l', 'e', 'd'}}
	legacy, envelope, keyARN, err := (&IngestSecretStore{Cipher: cipher}).
		encodeSecretForStorage(context.Background(), "one-time-secret")
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if legacy != ingestSecretEnvelopeSentinel {
		t.Fatalf("legacy value = %q, want non-secret sentinel", legacy)
	}
	if !bytes.Equal(envelope, []byte{0x02, 's', 'e', 'a', 'l', 'e', 'd'}) {
		t.Fatalf("envelope = %q", envelope)
	}
	if keyARN != testConversionKMSKeyARN {
		t.Fatalf("KMS provenance = %q", keyARN)
	}
	if saw := cipher.plaintextSeen(); !bytes.Equal(saw, []byte("one-time-secret")) {
		t.Fatalf("cipher plaintext = %q", saw)
	}
}

func TestIngestSecretStorageFailsClosedWhenEncryptionFails(t *testing.T) {
	tests := []struct {
		name   string
		cipher *ingestSecretCipherStub
	}{
		{name: "error", cipher: &ingestSecretCipherStub{err: errors.New("kms unavailable")}},
		{name: "empty", cipher: &ingestSecretCipherStub{}},
		{name: "legacy framing", cipher: &ingestSecretCipherStub{envelope: []byte{0x01, 0x00}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			legacy, envelope, keyARN, err := (&IngestSecretStore{Cipher: test.cipher}).
				encodeSecretForStorage(context.Background(), "must-not-persist")
			if err == nil {
				t.Fatal("expected encryption failure")
			}
			if legacy != "" || envelope != nil || keyARN != "" {
				t.Fatalf("failed encryption returned storage values: %q %q %q", legacy, envelope, keyARN)
			}
		})
	}
}

func TestIngestSecretStorageRejectsCipherlessIssuance(t *testing.T) {
	legacy, envelope, keyARN, err := (&IngestSecretStore{}).
		encodeSecretForStorage(context.Background(), "must-not-persist")
	if err == nil {
		t.Fatal("cipherless issuance persisted a plaintext signing key")
	}
	if legacy != "" || envelope != nil || keyARN != "" {
		t.Fatalf("failed cipherless issuance returned storage values: %q %q %q", legacy, envelope, keyARN)
	}
}

func TestIngestSecretStorageRejectsAliasOrMismatchedKMSProvenance(t *testing.T) {
	for _, provenance := range []string{
		"alias/postwave",
		"arn:aws:kms:us-east-1:123456789012:alias/postwave",
		"arn:aws:kms:us-east-1:123456789012:key/*",
	} {
		cipher := &ingestSecretCipherStub{
			envelope: []byte{0x02, 's', 'e', 'a', 'l', 'e', 'd'},
			kmsARN:   provenance,
		}
		legacy, envelope, keyARN, err := (&IngestSecretStore{Cipher: cipher}).
			encodeSecretForStorage(context.Background(), "must-not-persist")
		if err == nil || legacy != "" || envelope != nil || keyARN != "" || cipher.plaintextSeen() != nil {
			t.Fatalf("unsafe provenance %q reached encryption/storage: legacy=%q envelope=%q arn=%q err=%v",
				provenance, legacy, envelope, keyARN, err)
		}
	}
}

func TestIngestSecretLabelLimitCountsUnicodeCharacters(t *testing.T) {
	if _, err := normalizeSecretLabel(strings.Repeat("é", maxSecretLabel)); err != nil {
		t.Fatalf("128 Unicode characters rejected: %v", err)
	}
	if _, err := normalizeSecretLabel(strings.Repeat("é", maxSecretLabel+1)); !errors.Is(err, ErrSecretLabelInvalid) {
		t.Fatalf("129 Unicode characters = %v, want ErrSecretLabelInvalid", err)
	}
}
