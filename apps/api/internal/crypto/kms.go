// Package crypto — AWS KMS-backed envelope encryption.
//
// AwsKMSEnvelope replaces the historical stub by talking to AWS KMS via
// aws-sdk-go-v2. Per `kms:GenerateDataKey` semantics, KMS hands us a fresh
// AES-256 plaintext data key plus its KMS-wrapped form in one round trip.
// We AES-GCM-encrypt the payload locally with the plaintext key, write the
// wrapped key alongside the ciphertext, and zero out the plaintext key
// before returning. Decryption is the mirror: parse the blob, ask KMS to
// unwrap the data key, AES-GCM-decrypt locally, zero the key.
//
// Wire format produced by Encrypt is the same as crypto/envelope.go's
// VersionEnvelope (0x02) framing, so legacy 0x02 blobs stay readable
// independent of which EnvelopeKey originally wrote them:
//
//	[ version:1 = 0x02 ] [ wrapped-dek-len:2 BE ] [ wrapped-dek ] [ nonce:12 ] [ ciphertext+tag ]
//
// Decrypt also auto-falls-back to the static-AES-GCM legacy paths
// (VersionLegacyDirect 0x01 with legacyKEK, or no-version-byte blobs) so
// existing rows can be read while we lazily re-encrypt under KMS.
package crypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	kmstypes "github.com/aws/aws-sdk-go-v2/service/kms/types"
)

// kmsClient is the narrow surface AwsKMSEnvelope consumes. The aws-sdk
// concrete *kms.Client satisfies it; tests substitute a fake.
type kmsClient interface {
	GenerateDataKey(ctx context.Context, in *kms.GenerateDataKeyInput, optFns ...func(*kms.Options)) (*kms.GenerateDataKeyOutput, error)
	Decrypt(ctx context.Context, in *kms.DecryptInput, optFns ...func(*kms.Options)) (*kms.DecryptOutput, error)
}

// Errors returned by AwsKMSEnvelope. Callers can errors.Is() these to
// distinguish format-validation problems (likely non-retryable) from
// transient AWS failures (retryable / page on-call).
var (
	// ErrInvalidCiphertextFormat is returned when the on-the-wire blob
	// can't be parsed: too short, length prefix overflows, etc.
	ErrInvalidCiphertextFormat = errors.New("invalid envelope ciphertext format")
	// ErrKMSGenerateDataKeyFailed wraps a kms:GenerateDataKey error.
	ErrKMSGenerateDataKeyFailed = errors.New("kms GenerateDataKey failed")
	// ErrKMSDecryptFailed wraps a kms:Decrypt error.
	ErrKMSDecryptFailed = errors.New("kms Decrypt failed")
)

// DefaultKMSTimeout caps every KMS round trip so a flaky control plane
// doesn't stall request handlers indefinitely.
const DefaultKMSTimeout = 5 * time.Second

var exactKMSKeyARNPattern = regexp.MustCompile(
	`^arn:(?:aws|aws-us-gov|aws-cn):kms:([a-z0-9-]+):[0-9]{12}:key/[A-Za-z0-9-]{1,128}$`,
)

// ValidateExactKMSKeyARN rejects aliases and incomplete identifiers. Callers
// that persist key provenance must be able to name the immutable key that
// produced an envelope; an alias can be retargeted after issuance and is not
// provenance.
func ValidateExactKMSKeyARN(keyARN, region string) error {
	match := exactKMSKeyARNPattern.FindStringSubmatch(strings.TrimSpace(keyARN))
	if len(match) != 2 {
		return errors.New("KMS key id must be an exact immutable key ARN")
	}
	region = strings.TrimSpace(region)
	if region != "" && region != match[1] {
		return errors.New("KMS key ARN region does not match the configured AWS region")
	}
	return nil
}

// AwsKMSEnvelope is the production EnvelopeEncryptor backed by AWS KMS.
// Construct with NewKMSEnvelope.
//
// Concurrency: safe for concurrent use; the underlying *kms.Client is
// itself goroutine-safe. We also keep a no-state struct here (no caching
// of plaintext data keys — that would defeat envelope encryption).
type AwsKMSEnvelope struct {
	// Client is the kms.Client to use; required.
	Client kmsClient
	// KeyID is a KMS key alias ("alias/postwave-sending-kek") or full
	// ARN ("arn:aws:kms:us-east-1:123:key/uuid"). Required.
	KeyID string
	// Timeout caps a single KMS round trip; defaults to DefaultKMSTimeout
	// when zero.
	Timeout time.Duration

	// LegacyKEK lets Decrypt fall back to the historical static-key
	// AES-GCM path for blobs encrypted before KMS was wired (or for
	// blobs we re-wrote under static-key for some reason). Exposed as
	// a slice rather than wired through a sibling EnvelopeKey because
	// fallback is intentionally cheap and one-shot.
	LegacyKEK []byte
}

// NewKMSEnvelope is a small constructor that fills in the Timeout default.
func NewKMSEnvelope(client *kms.Client, keyID string) *AwsKMSEnvelope {
	return &AwsKMSEnvelope{Client: client, KeyID: keyID, Timeout: DefaultKMSTimeout}
}

// NewKMSEnvelopeWithFallback wires a static-AES-GCM legacyKEK so that
// Decrypt of legacy blobs continues to work during the rolling migration.
// Pass the same SendingKEK the platform used pre-KMS.
func NewKMSEnvelopeWithFallback(client *kms.Client, keyID string, legacyKEK []byte) *AwsKMSEnvelope {
	e := NewKMSEnvelope(client, keyID)
	e.LegacyKEK = legacyKEK
	return e
}

// KMSKeyARN returns the exact configured wrapping-key provenance. It is
// intentionally a narrow interface method so credential writers and workers
// can fail closed when handed a static cipher, alias, or different KMS key.
func (e *AwsKMSEnvelope) KMSKeyARN() string {
	if e == nil {
		return ""
	}
	return strings.TrimSpace(e.KeyID)
}

// Encrypt generates a fresh AES-256 data key via kms:GenerateDataKey,
// AES-GCM-seals the plaintext under it, then frames the wrapped key +
// nonce + ciphertext into the standard 0x02 envelope blob.
//
// Plaintext key bytes are zeroed before return.
func (e *AwsKMSEnvelope) Encrypt(ctx context.Context, plaintext []byte) ([]byte, error) {
	if e == nil || e.Client == nil || e.KeyID == "" {
		return nil, errors.New("aws kms envelope not configured")
	}
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = DefaultKMSTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	out, err := e.Client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:   aws.String(e.KeyID),
		KeySpec: kmstypes.DataKeySpecAes256,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrKMSGenerateDataKeyFailed, err)
	}
	if len(out.Plaintext) != 32 || len(out.CiphertextBlob) == 0 {
		return nil, fmt.Errorf("%w: kms returned malformed data key", ErrKMSGenerateDataKeyFailed)
	}

	// Defensive: ensure the plaintext data key never escapes this
	// function. We zero it on every return path.
	dek := out.Plaintext
	defer zero(dek)

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, fmt.Errorf("aes cipher: %w", err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	nonce := make([]byte, g.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("rand nonce: %w", err)
	}
	ct := g.Seal(nil, nonce, plaintext, nil)

	wrapped := out.CiphertextBlob
	if len(wrapped) > 0xFFFF {
		return nil, fmt.Errorf("%w: wrapped key too large (%d)", ErrInvalidCiphertextFormat, len(wrapped))
	}
	blob := make([]byte, 0, 1+2+len(wrapped)+len(nonce)+len(ct))
	blob = append(blob, VersionEnvelope)
	var lenBuf [2]byte
	binary.BigEndian.PutUint16(lenBuf[:], uint16(len(wrapped)))
	blob = append(blob, lenBuf[:]...)
	blob = append(blob, wrapped...)
	blob = append(blob, nonce...)
	blob = append(blob, ct...)
	return blob, nil
}

// Decrypt parses the framed envelope, asks KMS to unwrap the data key,
// then AES-GCM-opens the ciphertext. legacyKEK overrides AwsKMSEnvelope's
// LegacyKEK for this call only when both are non-nil; pass nil to use the
// configured fallback.
//
// On a v=0x02 blob: KMS unwrap path. On v=0x01 or unknown: static-key
// fallback (uses legacyKEK or e.LegacyKEK, whichever is set).
//
// Plaintext data key is zeroed before return.
func (e *AwsKMSEnvelope) Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, fmt.Errorf("%w: empty blob", ErrInvalidCiphertextFormat)
	}
	switch blob[0] {
	case VersionEnvelope:
		return e.decryptV2(ctx, blob)
	case VersionLegacyDirect:
		kek := pickKEK(legacyKEK, e.LegacyKEK)
		if kek == nil {
			return nil, fmt.Errorf("%w: legacy blob requires legacyKEK", ErrInvalidCiphertextFormat)
		}
		return aesGCMOpen(kek, blob[1:])
	default:
		// No version byte at all? Try legacy direct as a last resort —
		// some early staging data lacked the version prefix.
		kek := pickKEK(legacyKEK, e.LegacyKEK)
		if kek == nil {
			return nil, fmt.Errorf("%w: unknown blob version 0x%02x", ErrInvalidCiphertextFormat, blob[0])
		}
		return aesGCMOpen(kek, blob)
	}
}

// decryptV2 handles the standard envelope wire format.
func (e *AwsKMSEnvelope) decryptV2(ctx context.Context, blob []byte) ([]byte, error) {
	if e == nil || e.Client == nil {
		return nil, errors.New("aws kms envelope not configured")
	}
	if len(blob) < 1+2+12 {
		return nil, fmt.Errorf("%w: envelope blob too short (%d)", ErrInvalidCiphertextFormat, len(blob))
	}
	wrappedLen := int(binary.BigEndian.Uint16(blob[1:3]))
	if 3+wrappedLen+12 > len(blob) {
		return nil, fmt.Errorf("%w: wrapped-dek length %d overflows blob", ErrInvalidCiphertextFormat, wrappedLen)
	}
	wrapped := blob[3 : 3+wrappedLen]
	rest := blob[3+wrappedLen:]
	nonce := rest[:12]
	ct := rest[12:]

	timeout := e.Timeout
	if timeout <= 0 {
		timeout = DefaultKMSTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := e.Client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob: wrapped,
		KeyId:          aws.String(e.KeyID),
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrKMSDecryptFailed, err)
	}
	dek := out.Plaintext
	defer zero(dek)
	if len(dek) == 0 {
		return nil, fmt.Errorf("%w: empty plaintext key", ErrKMSDecryptFailed)
	}

	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, fmt.Errorf("aes cipher: %w", err)
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("gcm: %w", err)
	}
	if len(nonce) != g.NonceSize() {
		return nil, fmt.Errorf("%w: bad nonce size %d", ErrInvalidCiphertextFormat, len(nonce))
	}
	pt, err := g.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("aes-gcm open: %w", err)
	}
	return pt, nil
}

// NewStaticEnvelope wraps the legacy static-key AES-GCM path in a type
// that satisfies the same Encrypt/Decrypt surface as AwsKMSEnvelope.
// Use when AWS KMS isn't configured (e.g. local dev, test, or before the
// production cutover). Backed by EnvKeyKMS+EnvelopeCipher.
func NewStaticEnvelope(kek []byte) (*EnvelopeCipher, error) {
	k, err := NewEnvKeyKMS(kek)
	if err != nil {
		return nil, err
	}
	return NewEnvelopeCipher(k), nil
}

// MustStaticEnvelope is the panic-on-bad-key variant for wiring sites
// that have already validated the KEK length.
func MustStaticEnvelope(kek []byte) *EnvelopeCipher {
	c, err := NewStaticEnvelope(kek)
	if err != nil {
		panic(err)
	}
	return c
}

// zero overwrites b with zeros. Best-effort: the Go runtime is allowed
// to copy slice contents around (e.g. on growth) and we have no way to
// chase those copies. Still, scrubbing the slice we hold makes
// post-mortem heap dumps materially less useful to an attacker.
func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// pickKEK picks the first non-nil KEK; lets a Decrypt caller override
// the configured fallback per-call.
func pickKEK(call, configured []byte) []byte {
	if len(call) > 0 {
		return call
	}
	return configured
}
