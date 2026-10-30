package crypto

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/kms"
)

func TestEnvKeyKMSRoundTrip(t *testing.T) {
	kek := bytes.Repeat([]byte{0x42}, 32)
	k, err := NewEnvKeyKMS(kek)
	if err != nil {
		t.Fatal(err)
	}
	c := NewEnvelopeCipher(k)
	for _, plain := range [][]byte{
		[]byte(""),
		[]byte("hello"),
		bytes.Repeat([]byte{0xAA}, 1024),
	} {
		blob, err := c.Encrypt(context.Background(), plain)
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}
		if blob[0] != VersionEnvelope {
			t.Fatalf("version: got 0x%02x want 0x%02x", blob[0], VersionEnvelope)
		}
		got, err := c.Decrypt(context.Background(), blob, nil)
		if err != nil {
			t.Fatalf("decrypt: %v", err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("round-trip mismatch: got %q want %q", got, plain)
		}
	}
}

func TestLegacyDirectDecrypt(t *testing.T) {
	kek := bytes.Repeat([]byte{0xCA}, 32)
	plain := []byte("legacy secret")
	// Build a v=0x01 blob: version byte + AES-GCM(nonce||ct).
	block, _ := aes.NewCipher(kek)
	g, _ := cipher.NewGCM(block)
	nonce := make([]byte, g.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		t.Fatal(err)
	}
	ct := g.Seal(nil, nonce, plain, nil)
	blob := append([]byte{VersionLegacyDirect}, append(nonce, ct...)...)

	c := &EnvelopeCipher{Key: nil} // not configured for envelope
	got, err := c.Decrypt(context.Background(), blob, kek)
	if err != nil {
		t.Fatalf("decrypt legacy: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("legacy mismatch")
	}
}

func TestStaticEnvelopeRoundTrip(t *testing.T) {
	kek := bytes.Repeat([]byte{0x55}, 32)
	c, err := NewStaticEnvelope(kek)
	if err != nil {
		t.Fatal(err)
	}
	plain := []byte("postmark-token-abcdef")
	blob, err := c.Encrypt(context.Background(), plain)
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.Decrypt(context.Background(), blob, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("round-trip mismatch")
	}
}

func TestEnvKeyKMSBadKeyLen(t *testing.T) {
	if _, err := NewEnvKeyKMS([]byte("short")); err == nil {
		t.Fatal("expected error for short key")
	}
}

func TestDecryptRejectsTruncated(t *testing.T) {
	c := NewEnvelopeCipher(&EnvKeyKMS{KEK: bytes.Repeat([]byte{1}, 32)})
	if _, err := c.Decrypt(context.Background(), []byte{}, nil); err == nil {
		t.Fatal("expected error for empty blob")
	}
	if _, err := c.Decrypt(context.Background(), []byte{VersionEnvelope}, nil); err == nil {
		t.Fatal("expected error for short envelope")
	}
}

// --- AwsKMSEnvelope (kms.go) tests ---

// fakeKMS lets us drive AwsKMSEnvelope round-trips without hitting AWS.
// Mirrors the kmsClient interface in kms.go.
type fakeKMS struct {
	// kek is a static AES-256 key used to "wrap" the data key — like
	// real KMS, the caller never sees it. We also use it to detect
	// tampering in TestAwsKMSEnvelopeTamperDetection.
	kek []byte
	// failGenerate / failDecrypt let tests assert the wrapping error
	// types (ErrKMSGenerateDataKeyFailed / ErrKMSDecryptFailed).
	failGenerate error
	failDecrypt  error
}

func newFakeKMS() *fakeKMS { return &fakeKMS{kek: bytes.Repeat([]byte{0x77}, 32)} }

func (f *fakeKMS) GenerateDataKey(_ context.Context, in *kms.GenerateDataKeyInput, _ ...func(*kms.Options)) (*kms.GenerateDataKeyOutput, error) {
	if f.failGenerate != nil {
		return nil, f.failGenerate
	}
	dek := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return nil, err
	}
	wrapped, err := aesGCMSeal(f.kek, dek)
	if err != nil {
		return nil, err
	}
	return &kms.GenerateDataKeyOutput{Plaintext: dek, CiphertextBlob: wrapped}, nil
}

func (f *fakeKMS) Decrypt(_ context.Context, in *kms.DecryptInput, _ ...func(*kms.Options)) (*kms.DecryptOutput, error) {
	if f.failDecrypt != nil {
		return nil, f.failDecrypt
	}
	pt, err := aesGCMOpen(f.kek, in.CiphertextBlob)
	if err != nil {
		return nil, err
	}
	return &kms.DecryptOutput{Plaintext: pt}, nil
}

// envelopeFromFake constructs an AwsKMSEnvelope wired to the fake KMS.
// We can't pass a *kms.Client here so we set Client directly via the
// internal interface — that's why kmsClient is unexported but the
// struct field accepts the interface.
func envelopeFromFake(t *testing.T, fk *fakeKMS) *AwsKMSEnvelope {
	t.Helper()
	return &AwsKMSEnvelope{Client: fk, KeyID: "alias/test", Timeout: 2 * time.Second}
}

func TestAwsKMSEnvelopeRoundTrip(t *testing.T) {
	fk := newFakeKMS()
	env := envelopeFromFake(t, fk)
	for _, plain := range [][]byte{
		[]byte("p"),
		[]byte("postmark-server-token-XYZ"),
		bytes.Repeat([]byte{0x33}, 4096),
	} {
		blob, err := env.Encrypt(context.Background(), plain)
		if err != nil {
			t.Fatalf("encrypt: %v", err)
		}
		if blob[0] != VersionEnvelope {
			t.Fatalf("version byte: got 0x%02x want 0x%02x", blob[0], VersionEnvelope)
		}
		got, err := env.Decrypt(context.Background(), blob, nil)
		if err != nil {
			t.Fatalf("decrypt: %v", err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("mismatch: got %q want %q", got, plain)
		}
	}
}

func TestAwsKMSEnvelopeTamperDetection(t *testing.T) {
	fk := newFakeKMS()
	env := envelopeFromFake(t, fk)
	plain := []byte("must-not-decode-after-tamper")
	blob, err := env.Encrypt(context.Background(), plain)
	if err != nil {
		t.Fatal(err)
	}
	// Flip a byte in the ciphertext+tag region (last few bytes).
	blob[len(blob)-1] ^= 0x01
	if _, err := env.Decrypt(context.Background(), blob, nil); err == nil {
		t.Fatal("expected decrypt failure on tampered ciphertext")
	}
}

func TestAwsKMSEnvelopeLegacyFallback(t *testing.T) {
	fk := newFakeKMS()
	env := envelopeFromFake(t, fk)
	// Build a v=0x01 blob with a static KEK and confirm fallback works.
	legacyKEK := bytes.Repeat([]byte{0xBB}, 32)
	plain := []byte("legacy-row")
	raw, err := aesGCMSeal(legacyKEK, plain)
	if err != nil {
		t.Fatal(err)
	}
	blob := append([]byte{VersionLegacyDirect}, raw...)
	got, err := env.Decrypt(context.Background(), blob, legacyKEK)
	if err != nil {
		t.Fatalf("legacy decrypt: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatal("legacy fallback mismatch")
	}
}

func TestAwsKMSEnvelopeRejectsMalformed(t *testing.T) {
	fk := newFakeKMS()
	env := envelopeFromFake(t, fk)
	if _, err := env.Decrypt(context.Background(), []byte{}, nil); !errors.Is(err, ErrInvalidCiphertextFormat) {
		t.Fatalf("expected ErrInvalidCiphertextFormat for empty blob, got %v", err)
	}
	// v=0x02 but length-prefix overflows the blob.
	bad := []byte{VersionEnvelope, 0xFF, 0xFF, 0x00}
	if _, err := env.Decrypt(context.Background(), bad, nil); !errors.Is(err, ErrInvalidCiphertextFormat) {
		t.Fatalf("expected ErrInvalidCiphertextFormat for overflow, got %v", err)
	}
}

func TestAwsKMSEnvelopeWrapsGenerateDataKeyError(t *testing.T) {
	fk := &fakeKMS{kek: bytes.Repeat([]byte{0x01}, 32), failGenerate: errors.New("kms boom")}
	env := envelopeFromFake(t, fk)
	if _, err := env.Encrypt(context.Background(), []byte("x")); !errors.Is(err, ErrKMSGenerateDataKeyFailed) {
		t.Fatalf("expected ErrKMSGenerateDataKeyFailed, got %v", err)
	}
}

func TestAwsKMSEnvelopeWrapsDecryptError(t *testing.T) {
	fk := newFakeKMS()
	env := envelopeFromFake(t, fk)
	blob, err := env.Encrypt(context.Background(), []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	fk.failDecrypt = errors.New("kms boom")
	if _, err := env.Decrypt(context.Background(), blob, nil); !errors.Is(err, ErrKMSDecryptFailed) {
		t.Fatalf("expected ErrKMSDecryptFailed, got %v", err)
	}
}

// TestAwsKMSEnvelopeWireFormat asserts the on-the-wire framing matches
// the documented format: [v=0x02][len2 BE][wrapped][nonce12][ct+tag].
func TestAwsKMSEnvelopeWireFormat(t *testing.T) {
	fk := newFakeKMS()
	env := envelopeFromFake(t, fk)
	blob, err := env.Encrypt(context.Background(), []byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	if blob[0] != VersionEnvelope {
		t.Fatalf("version: 0x%02x", blob[0])
	}
	wrappedLen := int(binary.BigEndian.Uint16(blob[1:3]))
	// nonce=12, ct=plaintext+tag(16) → 3 + wrappedLen + 12 + 3 + 16
	want := 1 + 2 + wrappedLen + 12 + 3 + 16
	if len(blob) != want {
		t.Fatalf("blob length: got %d want %d", len(blob), want)
	}
}

func TestValidateExactKMSKeyARN(t *testing.T) {
	const exact = "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789abc"
	if err := ValidateExactKMSKeyARN(exact, "us-west-2"); err != nil {
		t.Fatalf("exact key ARN rejected: %v", err)
	}
	for _, invalid := range []struct {
		name   string
		keyARN string
		region string
	}{
		{name: "alias", keyARN: "alias/postwave", region: "us-west-2"},
		{name: "alias ARN", keyARN: "arn:aws:kms:us-west-2:123456789012:alias/postwave", region: "us-west-2"},
		{name: "wildcard", keyARN: "arn:aws:kms:us-west-2:123456789012:key/*", region: "us-west-2"},
		{name: "different region", keyARN: exact, region: "us-east-1"},
	} {
		t.Run(invalid.name, func(t *testing.T) {
			if err := ValidateExactKMSKeyARN(invalid.keyARN, invalid.region); err == nil {
				t.Fatal("unsafe KMS provenance accepted")
			}
		})
	}
}

// --- Real-AWS integration tests (skipped without env) ---

// TestAwsKMSEnvelopeIntegration exercises a real KMS key. Skipped unless
// AWS_KMS_TEST_KEY_ID is set (alias or ARN). Requires AWS credentials in
// the default chain (env, ~/.aws, IMDS, etc.) and the configured key
// must allow kms:GenerateDataKey + kms:Decrypt for the principal.
func TestAwsKMSEnvelopeIntegration(t *testing.T) {
	keyID := os.Getenv("AWS_KMS_TEST_KEY_ID")
	if keyID == "" {
		t.Skip("AWS_KMS_TEST_KEY_ID not set; skipping integration test")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		t.Fatalf("load aws config: %v", err)
	}
	client := kms.NewFromConfig(cfg)
	env := NewKMSEnvelope(client, keyID)

	plain := []byte("postwave-integration-secret")
	blob, err := env.Encrypt(ctx, plain)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	got, err := env.Decrypt(ctx, blob, nil)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("integration round-trip mismatch")
	}
	// Tamper detection.
	blob[len(blob)-1] ^= 0x01
	if _, err := env.Decrypt(ctx, blob, nil); err == nil {
		t.Fatal("expected tamper-detection failure")
	}
}
