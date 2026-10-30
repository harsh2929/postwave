// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

type xorAuthCipher struct {
	encryptErr error
	decryptErr error
}

func (c xorAuthCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	if c.encryptErr != nil {
		return nil, c.encryptErr
	}
	out := make([]byte, len(plaintext)+1)
	out[0] = 0xA9
	for i, b := range plaintext {
		out[i+1] = b ^ 0xFF
	}
	return out, nil
}

func (c xorAuthCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	if c.decryptErr != nil {
		return nil, c.decryptErr
	}
	if len(blob) == 0 || blob[0] != 0xA9 {
		return nil, errors.New("invalid test ciphertext")
	}
	out := make([]byte, len(blob)-1)
	for i, b := range blob[1:] {
		out[i] = b ^ 0xFF
	}
	return out, nil
}

func testMTLSKeypair(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "receiver-auth.test"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return string(certPEM), string(keyPEM)
}

func TestReceiverAuthStorageSeparatesMetadataFromAllCredentialValues(t *testing.T) {
	t.Parallel()

	certPEM, keyPEM := testMTLSKeypair(t)
	input := &AuthConfig{
		Type:        "combined",
		BearerToken: "bearer-secret-value",
		Headers: map[string]string{
			"X-API-Key": "header-secret-value",
		},
		MTLSCertPEM: certPEM,
		MTLSKeyPEM:  keyPEM,
	}
	store := &Store{Cipher: xorAuthCipher{}}
	metadata, ciphertext, err := store.encryptAuthConfig(context.Background(), input)
	if err != nil {
		t.Fatalf("encryptAuthConfig: %v", err)
	}
	if len(ciphertext) == 0 {
		t.Fatal("credential ciphertext is empty")
	}
	if !strings.Contains(string(metadata), `"type":"encrypted"`) ||
		!strings.Contains(string(metadata), `"configured_type":"combined"`) {
		t.Fatalf("metadata lacks rolling-deploy fail-closed sentinel: %s", metadata)
	}
	for name, material := range map[string]string{
		"bearer token": "bearer-secret-value",
		"header value": "header-secret-value",
		"certificate":  certPEM,
		"private key":  keyPEM,
	} {
		if strings.Contains(string(metadata), material) {
			t.Errorf("public metadata contains %s", name)
		}
		if strings.Contains(string(ciphertext), material) {
			t.Errorf("ciphertext contains plaintext %s", name)
		}
	}

	public := decodePublicAuthMetadata(metadata)
	if public == nil || !public.BearerConfigured || !public.MTLSConfigured || !public.SecretRedacted {
		t.Fatalf("public auth metadata = %#v", public)
	}
	if public.Type != "combined" {
		t.Fatalf("public auth type = %q, want combined", public.Type)
	}
	if !reflect.DeepEqual(public.HeaderNames, []string{"X-Api-Key"}) {
		t.Fatalf("public header names = %#v", public.HeaderNames)
	}
	if public.BearerToken != "" || len(public.Headers) != 0 || public.MTLSCertPEM != "" || public.MTLSKeyPEM != "" {
		t.Fatalf("public projection retained credential values: %#v", public)
	}

	plaintext, err := (xorAuthCipher{}).Decrypt(context.Background(), ciphertext, nil)
	if err != nil {
		t.Fatal(err)
	}
	roundTrip, err := decodeAuthConfig(plaintext, false)
	if err != nil {
		t.Fatal(err)
	}
	if roundTrip.BearerToken != input.BearerToken ||
		roundTrip.Headers["X-Api-Key"] != input.Headers["X-API-Key"] ||
		roundTrip.MTLSCertPEM != strings.TrimSpace(certPEM) ||
		roundTrip.MTLSKeyPEM != strings.TrimSpace(keyPEM) {
		t.Fatal("decrypted receiver auth did not round-trip")
	}
}

func TestReceiverAuthMetadataCannotBeReusedAsCredentialInput(t *testing.T) {
	t.Parallel()

	_, err := normalizeAuthConfig(&AuthConfig{
		Type:             "bearer",
		BearerConfigured: true,
		SecretRedacted:   true,
	})
	if err == nil {
		t.Fatal("redacted read metadata was accepted as credential input")
	}
}

func TestReceiverMTLSClonesInstrumentedProductionTransport(t *testing.T) {
	t.Parallel()

	certPEM, keyPEM := testMTLSKeypair(t)
	wrapCalls := 0
	baseTransport := NewSecureTransport()
	baseClient := NewSecureHTTPClient(NewClientCertificateCapableTransport(
		baseTransport,
		func(inner http.RoundTripper) http.RoundTripper {
			wrapCalls++
			return inner
		},
	))
	mtlsClient, err := clientWithAuth(baseClient, &AuthConfig{
		Type:        "mtls",
		MTLSCertPEM: certPEM,
		MTLSKeyPEM:  keyPEM,
	})
	if err != nil {
		t.Fatalf("clientWithAuth(instrumented transport): %v", err)
	}
	if mtlsClient == baseClient {
		t.Fatal("mTLS mutated the shared production client")
	}
	stack, ok := mtlsClient.Transport.(*composableClientTransport)
	if !ok {
		t.Fatalf("mTLS transport = %T, want composableClientTransport", mtlsClient.Transport)
	}
	if stack.base == baseTransport {
		t.Fatal("mTLS reused the shared SSRF-safe base transport instead of cloning")
	}
	if stack.base.DialContext == nil {
		t.Fatal("mTLS clone lost the SSRF-safe dialer")
	}
	if stack.base.TLSClientConfig == nil ||
		stack.base.TLSClientConfig.MinVersion < tls.VersionTLS12 ||
		len(stack.base.TLSClientConfig.Certificates) != 1 {
		t.Fatalf("mTLS clone lost TLS policy or certificate: %#v", stack.base.TLSClientConfig)
	}
	if wrapCalls != 2 {
		t.Fatalf("instrumentation wrapper calls = %d, want initial + mTLS clone", wrapCalls)
	}
}

func TestReceiverAuthValidationPreservesReservedSigningHeaders(t *testing.T) {
	t.Parallel()

	for _, name := range []string{
		SignatureHeader,
		KeyIDHeader,
		EventHeader,
		EventIDHeader,
		DeliveryHeader,
		TestHeader,
		"Content-Type",
		"Content-Length",
		"Host",
		"Connection",
		"Transfer-Encoding",
		"Proxy-Authorization",
		"User-Agent",
	} {
		_, err := normalizeAuthConfig(&AuthConfig{
			Type:    "headers",
			Headers: map[string]string{name: "override"},
		})
		if err == nil {
			t.Errorf("reserved header %q was accepted", name)
		}
	}
	_, err := normalizeAuthConfig(&AuthConfig{
		Type:    "headers",
		Headers: map[string]string{"X-Api-Key\r\nX-Evil": "secret"},
	})
	if err == nil {
		t.Fatal("header-name injection was accepted")
	}
	_, err = normalizeAuthConfig(&AuthConfig{
		Type:    "headers",
		Headers: map[string]string{"X-Api-Key": "secret\r\nX-Evil: injected"},
	})
	if err == nil {
		t.Fatal("header-value injection was accepted")
	}
}

func TestReceiverAuthExplicitTypesCannotSilentlyClearCredentials(t *testing.T) {
	t.Parallel()

	for _, authType := range []string{"bearer", "headers", "custom_headers", "mtls", "combined"} {
		authType := authType
		t.Run(authType, func(t *testing.T) {
			t.Parallel()
			if _, err := normalizeAuthConfig(&AuthConfig{Type: authType}); err == nil {
				t.Fatal("incomplete explicit auth replacement silently cleared credentials")
			}
		})
	}
	for _, clear := range []*AuthConfig{nil, {}, {Type: "none"}} {
		if normalized, err := normalizeAuthConfig(clear); err != nil || normalized != nil {
			t.Fatalf("explicit clear = %#v, %v; want nil, nil", normalized, err)
		}
	}
}

func TestUpdateInputDistinguishesReceiverAuthNoChangeReplaceAndClear(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		body        string
		wantChange  bool
		wantNilAuth bool
	}{
		{name: "omitted", body: `{"active":true}`, wantChange: false, wantNilAuth: true},
		{name: "null clears", body: `{"auth_config":null}`, wantChange: true, wantNilAuth: true},
		{name: "none clears", body: `{"auth_config":{"type":"none"}}`, wantChange: true, wantNilAuth: false},
		{name: "replace", body: `{"auth_config":{"type":"bearer","bearer_token":"new-secret"}}`, wantChange: true, wantNilAuth: false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var input UpdateInput
			if err := json.Unmarshal([]byte(tc.body), &input); err != nil {
				t.Fatal(err)
			}
			if got := input.changesAuthConfig(); got != tc.wantChange {
				t.Fatalf("changesAuthConfig() = %v, want %v", got, tc.wantChange)
			}
			if got := input.AuthConfig == nil; got != tc.wantNilAuth {
				t.Fatalf("AuthConfig nil = %v, want %v", got, tc.wantNilAuth)
			}
		})
	}
}

func TestUpdateInputPresenceDecoderRemainsStrict(t *testing.T) {
	t.Parallel()

	for _, body := range []string{
		`{"auth_config":null,"unknown":true}`,
		`{"auth_config":{"type":"bearer","bearer_token":"secret","unknown":true}}`,
	} {
		var input UpdateInput
		if err := json.Unmarshal([]byte(body), &input); err == nil {
			t.Errorf("unknown field accepted in %s", body)
		}
	}
}

func TestReceiverAuthCipherFailuresFailClosed(t *testing.T) {
	t.Parallel()

	store := &Store{Cipher: xorAuthCipher{encryptErr: errors.New("kms unavailable")}}
	metadata, ciphertext, err := store.encryptAuthConfig(context.Background(), &AuthConfig{
		Type:        "bearer",
		BearerToken: "secret",
	})
	if err == nil {
		t.Fatal("cipher failure was accepted")
	}
	if errors.Is(err, ErrInvalidAuthConfig) {
		t.Fatalf("cipher outage was misclassified as operator validation: %v", err)
	}
	if metadata != nil || ciphertext != nil {
		t.Fatal("cipher failure returned persistable auth material")
	}
}

func TestAuthRewrapWorkerSourceKeepsBoundedWorkerRLSContract(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("auth_rewrap.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, contract := range []string{
		"db.WithWorkerScope(ctx, s.Pool)",
		"FOR UPDATE SKIP LOCKED",
		"LIMIT $1",
		"maxAuthRewrapBatchSize",
		"auth_config_state = 'legacy_pending'",
		"auth_config_state = 'invalid'",
		"active = false",
		"resumePausedDeliveries",
	} {
		if !strings.Contains(source, contract) {
			t.Errorf("auth rewrap worker missing contract %q", contract)
		}
	}
}

func TestApplyAuthConfigStillCannotReplacePostwaveIdentityHeaders(t *testing.T) {
	t.Parallel()

	req, err := http.NewRequest(http.MethodPost, "https://example.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(SignatureHeader, "signed")
	req.Header.Set(EventIDHeader, "event-id")
	applyAuthConfig(req, &AuthConfig{Headers: map[string]string{
		SignatureHeader: "forged",
		EventIDHeader:   "forged-event",
		"X-Api-Key":     "allowed",
	}})
	if req.Header.Get(SignatureHeader) != "signed" || req.Header.Get(EventIDHeader) != "event-id" {
		t.Fatal("receiver auth replaced Moosewave identity headers")
	}
	if req.Header.Get("X-Api-Key") != "allowed" {
		t.Fatal("valid receiver auth header was not applied")
	}
}
