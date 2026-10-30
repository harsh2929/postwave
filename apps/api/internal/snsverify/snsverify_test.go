// SPDX-License-Identifier: AGPL-3.0-only

package snsverify

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// This package is the only thing standing between a forged HTTP POST and an
// inbound event ledger, so the tests sign real payloads with a real key rather
// than asserting that a helper was called.

const testCertURL = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem"

func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return key
}

// signedEnvelope returns an envelope carrying a genuine RSA signature over the
// AWS canonical string, with its public key seeded into the cache so no
// network call happens.
func signedEnvelope(t *testing.T, key *rsa.PrivateKey, env Envelope) Envelope {
	t.Helper()
	SeedCertCache(testCertURL, &key.PublicKey)
	env.SigningCertURL = testCertURL
	if env.SignatureVersion == "" {
		env.SignatureVersion = "2"
	}
	digest := sha256.Sum256([]byte(CanonicalString(env)))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	env.Signature = base64.StdEncoding.EncodeToString(signature)
	return env
}

func baseEnvelope() Envelope {
	return Envelope{
		Type:      "Notification",
		MessageID: "11111111-2222-3333-4444-555555555555",
		TopicArn:  "arn:aws:sns:eu-west-1:123456789012:postwave-ses-events",
		Message:   `{"eventType":"Bounce"}`,
		Timestamp: "2026-08-15T10:00:00.000Z",
	}
}

func allowingVerifier() Verifier {
	return Verifier{AllowedTopicARNs: []string{baseEnvelope().TopicArn}}
}

func TestAGenuinelySignedNotificationIsAccepted(t *testing.T) {
	key := testKey(t)
	env := signedEnvelope(t, key, baseEnvelope())

	if err := allowingVerifier().Verify(env); err != nil {
		t.Fatalf("a correctly signed envelope must verify, got %v", err)
	}
}

// The whole point. Any edit to a signed field must invalidate the signature —
// otherwise an attacker could take a real notification and swap its payload.
func TestTamperingWithTheMessageInvalidatesTheSignature(t *testing.T) {
	key := testKey(t)
	env := signedEnvelope(t, key, baseEnvelope())
	env.Message = `{"eventType":"Delivery"}`

	if err := allowingVerifier().Verify(env); !errors.Is(err, ErrSignatureMismatch) {
		t.Fatalf("tampered message error = %v, want ErrSignatureMismatch", err)
	}
}

func TestAnotherKeysSignatureIsRejected(t *testing.T) {
	env := signedEnvelope(t, testKey(t), baseEnvelope())
	// A different key now answers for the same cert URL.
	SeedCertCache(testCertURL, &testKey(t).PublicKey)

	if err := allowingVerifier().Verify(env); !errors.Is(err, ErrSignatureMismatch) {
		t.Fatalf("foreign-key signature error = %v, want ErrSignatureMismatch", err)
	}
}

// The cert URL is attacker-supplied. Accepting a non-Amazon host would let a
// sender nominate their own signing key, which defeats verification entirely
// and hands us an SSRF fetch as well.
func TestOnlyAmazonSNSCertURLsAreAccepted(t *testing.T) {
	for _, raw := range []string{
		"",
		"http://sns.eu-west-1.amazonaws.com/x.pem",            // not https
		"https://evil.example.com/x.pem",                      // wrong host
		"https://sns.eu-west-1.amazonaws.com.evil.test/x.pem", // suffix trick
		"https://sns.eu-west-1.amazonaws.com/x.txt",           // not a pem
		"https://user@sns.eu-west-1.amazonaws.com/x.pem",      // embedded user-info
	} {
		if ValidateCertURL(raw) {
			t.Errorf("cert URL %q must be rejected", raw)
		}
	}
	if !ValidateCertURL(testCertURL) {
		t.Errorf("a genuine SNS cert URL must be accepted")
	}
}

func TestMissingFieldsAreNamedRatherThanFailingAsAMismatch(t *testing.T) {
	key := testKey(t)
	verifier := allowingVerifier()

	missingID := signedEnvelope(t, key, baseEnvelope())
	missingID.MessageID = ""
	if err := verifier.Verify(missingID); !errors.Is(err, ErrMissingMessageID) {
		t.Errorf("missing MessageId error = %v", err)
	}

	missingSig := baseEnvelope()
	missingSig.SigningCertURL = testCertURL
	missingSig.SignatureVersion = "2"
	if err := verifier.Verify(missingSig); !errors.Is(err, ErrMissingSignature) {
		t.Errorf("missing Signature error = %v", err)
	}

	badVersion := signedEnvelope(t, key, baseEnvelope())
	badVersion.SignatureVersion = "9"
	if err := verifier.Verify(badVersion); !errors.Is(err, ErrUnsupportedSigVersion) {
		t.Errorf("unsupported version error = %v", err)
	}
}

// An empty allow-list must fail closed. Treating it as "any topic" would mean
// a half-configured deployment silently accepts a stranger's notifications.
func TestAnEmptyTopicAllowlistFailsClosed(t *testing.T) {
	env := signedEnvelope(t, testKey(t), baseEnvelope())

	if err := (Verifier{}).Verify(env); !errors.Is(err, ErrTopicAllowlistEmpty) {
		t.Fatalf("empty allow-list error = %v, want ErrTopicAllowlistEmpty", err)
	}
}

func TestAnUnlistedTopicIsRejectedEvenWhenSigned(t *testing.T) {
	env := signedEnvelope(t, testKey(t), baseEnvelope())
	verifier := Verifier{AllowedTopicARNs: []string{"arn:aws:sns:eu-west-1:123456789012:someone-else"}}

	if err := verifier.Verify(env); !errors.Is(err, ErrTopicNotAllowed) {
		t.Fatalf("unlisted topic error = %v, want ErrTopicNotAllowed", err)
	}
}

// A subscription confirmation signs a DIFFERENT field set than a
// notification. Using the notification layout for it would reject every real
// confirmation and leave the topic permanently unsubscribed.
func TestSubscriptionConfirmationUsesItsOwnCanonicalFields(t *testing.T) {
	confirmation := baseEnvelope()
	confirmation.Type = "SubscriptionConfirmation"
	confirmation.SubscribeURL = "https://sns.eu-west-1.amazonaws.com/confirm"
	confirmation.Token = "token-value"

	canonical := CanonicalString(confirmation)
	for _, field := range []string{"SubscribeURL", "Token"} {
		if !strings.Contains(canonical, field+"\n") {
			t.Errorf("a confirmation's canonical string must include %s", field)
		}
	}

	env := signedEnvelope(t, testKey(t), confirmation)
	if err := allowingVerifier().Verify(env); err != nil {
		t.Fatalf("a signed subscription confirmation must verify, got %v", err)
	}
}

// Subject is signed only when present. Emitting an empty Subject line would
// change the canonical string and break every notification without one.
func TestSubjectIsOnlyCanonicalWhenPresent(t *testing.T) {
	without := CanonicalString(baseEnvelope())
	if strings.Contains(without, "Subject\n") {
		t.Error("an absent Subject must not appear in the canonical string")
	}
	with := baseEnvelope()
	with.Subject = "hello"
	if !strings.Contains(CanonicalString(with), "Subject\nhello\n") {
		t.Error("a present Subject must be canonical")
	}
}

func TestParsePEMRSAPublicKeyRejectsNonRSAAndGarbage(t *testing.T) {
	if _, err := ParsePEMRSAPublicKey([]byte("not a pem")); !errors.Is(err, ErrCertParseFailed) {
		t.Errorf("garbage error = %v, want ErrCertParseFailed", err)
	}

	key := testKey(t)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if _, err := ParsePEMRSAPublicKey(encoded); err != nil {
		t.Errorf("a valid RSA cert must parse, got %v", err)
	}
}

// Metric labels are Prometheus cardinality. An unmapped error must collapse to
// a known bucket rather than emit its message as a label.
func TestFailureReasonIsBounded(t *testing.T) {
	if FailureReason(errors.New("something new")) != "unknown" {
		t.Error("an unmapped error must report unknown")
	}
	if FailureReason(ErrSignatureMismatch) != "signature_mismatch" {
		t.Error("a known error must report its stable reason")
	}
}

// A cert host that streams forever must not be able to exhaust memory. Moved
// here with the fetch path it exercises, so the size cap keeps its coverage.
func TestFetchCapsCertBodySize(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-pem-file")
		_, _ = w.Write([]byte(strings.Repeat("A", int(certMaxResponseBytes)+1)))
	}))
	defer server.Close()

	previous := certHTTPClient
	certHTTPClient = server.Client()
	t.Cleanup(func() {
		certHTTPClient = previous
		ForgetCertCache(server.URL)
	})

	_, err := fetchPublicKey(server.URL)
	if !errors.Is(err, ErrCertFetchFailed) || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("fetch error = %v, want cert fetch / response body too large", err)
	}
}
