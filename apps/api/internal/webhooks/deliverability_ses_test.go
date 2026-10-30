package webhooks

// SES SNS RSA verification tests.
//
// Strategy: generate a throwaway RSA key in setup, build a self-signed
// X.509 cert wrapping its public key, seed snsCertCache so verifySES
// never makes a real HTTP call, then exercise:
//
//   - happy path (valid signature → nil)
//   - tampered Message body (signature mismatch → errSignatureMismatch)
//   - garbage Signature (decode error → errSignatureNotBase64
//     or signature mismatch depending on the byte shape)
//   - SigningCertURL outside the AWS pattern (→ errInvalidCertURL)
//   - TopicArn outside the allow-list (→ errTopicNotAllowed)

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"github.com/postwave/postwave/apps/api/internal/snsverify"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type sesTenantResolverStub struct {
	tenantID string
	err      error
}

func (s *sesTenantResolverStub) LookupTenantByESPMessageID(context.Context, string) (string, error) {
	return s.tenantID, s.err
}

func TestResolveSESTenantUsesOnlyMessageBoundAttribution(t *testing.T) {
	const tenantA = "11111111-1111-4111-8111-111111111111"
	const tenantB = "22222222-2222-4222-8222-222222222222"
	var msg sesMessage
	if err := json.Unmarshal([]byte(`{
		"mail": {
			"messageId": "esp-message-1"
		}
	}`), &msg); err != nil {
		t.Fatal(err)
	}

	deps := &DeliverabilityDeps{TenantResolver: &sesTenantResolverStub{tenantID: tenantA}}
	if got := deps.resolveSESTenant(context.Background(), msg); got != tenantA {
		t.Fatalf("message-id tenant = %q, want %q", got, tenantA)
	}

	deps.TenantResolver = &sesTenantResolverStub{}
	msg.Mail.Tags = map[string][]string{sesTenantTagName: {tenantB}}
	if got := deps.resolveSESTenant(context.Background(), msg); got != tenantB {
		t.Fatalf("signed SES-tag tenant = %q, want %q", got, tenantB)
	}

	msg.Mail.Tags = nil
	msg.Mail.Headers = append(msg.Mail.Headers, struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}{Name: DeliverabilityTenantHeader, Value: tenantB})
	if got := deps.resolveSESTenant(context.Background(), msg); got != tenantB {
		t.Fatalf("signed original-header tenant = %q, want %q", got, tenantB)
	}

	msg.Mail.Headers = nil
	if got := deps.resolveSESTenant(context.Background(), msg); got != "" {
		t.Fatalf("unbound recipient fallback returned %q; want fail-closed empty", got)
	}
}

func TestResolveSESTenantFailsClosedOnConflictingOrInvalidBindings(t *testing.T) {
	const tenantA = "11111111-1111-4111-8111-111111111111"
	const tenantB = "22222222-2222-4222-8222-222222222222"
	deps := &DeliverabilityDeps{TenantResolver: &sesTenantResolverStub{tenantID: tenantA}}
	var msg sesMessage
	msg.Mail.MessageID = "esp-message-1"
	msg.Mail.Tags = map[string][]string{sesTenantTagName: {tenantB}}
	if got := deps.resolveSESTenant(context.Background(), msg); got != "" {
		t.Fatalf("conflicting message-id/tag attribution returned %q; want empty", got)
	}
	if _, state := deps.resolveSESTenantState(context.Background(), msg); state != sesTenantAmbiguous {
		t.Fatalf("conflicting attribution state = %q, want ambiguous", state)
	}

	deps.TenantResolver = &sesTenantResolverStub{}
	msg.Mail.Tags = map[string][]string{sesTenantTagName: {"not-a-uuid"}}
	if got := deps.resolveSESTenant(context.Background(), msg); got != "" {
		t.Fatalf("invalid signed tag returned %q; want empty", got)
	}
	if _, state := deps.resolveSESTenantState(context.Background(), msg); state != sesTenantInvalid {
		t.Fatalf("invalid attribution state = %q, want invalid", state)
	}

	msg.Mail.Tags = nil
	deps.TenantResolver = &sesTenantResolverStub{err: errors.New("temporary lookup failure")}
	if _, state := deps.resolveSESTenantState(context.Background(), msg); state != sesTenantLookupFailed {
		t.Fatalf("lookup failure state = %q, want lookup_failed", state)
	}
}

func TestSESRecipientEventIDIsStableAndRecipientScoped(t *testing.T) {
	first := sesRecipientEventID("sns-1", " First@Example.com ")
	if first != sesRecipientEventID("sns-1", "first@example.com") {
		t.Fatal("recipient event id must normalize case and surrounding whitespace")
	}
	if first == sesRecipientEventID("sns-1", "second@example.com") {
		t.Fatal("different recipients in one SNS event must not share a dedupe key")
	}
	if first == sesRecipientEventID("sns-2", "first@example.com") {
		t.Fatal("different SNS events must not share a dedupe key")
	}
}

func TestResolveSESCampaignIDRequiresOneValidSignedBinding(t *testing.T) {
	const campaignID = "33333333-3333-4333-8333-333333333333"
	var msg sesMessage
	msg.Mail.Headers = append(msg.Mail.Headers, struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}{Name: sesCampaignHeaderName, Value: campaignID})
	if got := resolveSESCampaignID(msg); got != campaignID {
		t.Fatalf("campaign binding = %q, want %q", got, campaignID)
	}

	msg.Mail.Headers = append(msg.Mail.Headers, struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	}{Name: sesCampaignHeaderName, Value: "44444444-4444-4444-8444-444444444444"})
	if got := resolveSESCampaignID(msg); got != "" {
		t.Fatalf("conflicting campaign binding returned %q; want empty", got)
	}
}

func TestHandleSESUnresolvedMailboxOutcomeRequestsRetry(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "test")
	t.Setenv("ENVIRONMENT", "test")
	t.Setenv("NODE_ENV", "test")
	inner, err := json.Marshal(map[string]any{
		"eventType": "Bounce",
		"mail":      map[string]any{"messageId": "unmapped-ses-message"},
		"bounce": map[string]any{
			"bounceType": "Permanent",
			"bouncedRecipients": []map[string]string{{
				"emailAddress": "nobody@example.test",
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(snsEnvelope{
		Type:      "Notification",
		MessageID: "sns-unresolved-1",
		Message:   string(inner),
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/webhooks/ses", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	deps := &DeliverabilityDeps{
		AllowUnverifiedSignatures: true,
		TenantResolver:            &sesTenantResolverStub{},
	}
	deps.HandleSES(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" ||
		!strings.Contains(rec.Body.String(), `"code":"provider_correlation_pending"`) {
		t.Fatalf("unexpected receipt: %s", rec.Body.String())
	}
}

// testFixture bundles the throwaway key + cached cert URL we share
// across cases. Every test seeds the cache so verifySES bypasses the
// HTTP fetch.
type sesTestFixture struct {
	priv    *rsa.PrivateKey
	certURL string
}

func newSESFixture(t *testing.T) *sesTestFixture {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa.GenerateKey: %v", err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "sns.us-east-1.amazonaws.com"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	derBytes, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	pub, err := parsePEMRSAPublicKey(pemBytes)
	if err != nil {
		t.Fatalf("parsePEMRSAPublicKey: %v", err)
	}
	// Use a unique URL per test invocation so concurrent runs don't
	// share cached state across t.Parallel boundaries.
	// Sanitise t.Name() for URL safety. The regex requires
	// [A-Za-z0-9_./-]+ before .pem; '/' isn't valid as part of a path
	// component name, so swap.
	certURL := "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-" +
		strings.ReplaceAll(t.Name(), "/", "-") + ".pem"
	// Seeded through the shared verifier: the cache moved there with the rest
	// of the crypto, and these tests still prove this package's behaviour by
	// exercising the same code path production uses.
	snsverify.SeedCertCache(certURL, pub)
	t.Cleanup(func() { snsverify.ForgetCertCache(certURL) })
	return &sesTestFixture{priv: priv, certURL: certURL}
}

// signEnvelope computes the RSA-PKCS1v15 signature over the canonical
// SNS string of env, using SignatureVersion=1 (SHA1) for parity with
// the AWS default.
func signEnvelope(t *testing.T, fx *sesTestFixture, env *snsEnvelope) {
	t.Helper()
	canonical := canonicalSNSString(env)
	var hashFn crypto.Hash
	var digest []byte
	switch env.SignatureVersion {
	case "1":
		hashFn = crypto.SHA1
		sum := sha1.Sum([]byte(canonical))
		digest = sum[:]
	case "2":
		hashFn = crypto.SHA256
		sum := sha256.Sum256([]byte(canonical))
		digest = sum[:]
	default:
		t.Fatalf("unsupported sig version: %q", env.SignatureVersion)
	}
	sig, err := rsa.SignPKCS1v15(rand.Reader, fx.priv, hashFn, digest)
	if err != nil {
		t.Fatalf("SignPKCS1v15: %v", err)
	}
	env.Signature = base64.StdEncoding.EncodeToString(sig)
}

func baseEnv(certURL string) *snsEnvelope {
	return &snsEnvelope{
		Type:             "Notification",
		MessageID:        "test-message-id-1234",
		TopicArn:         "arn:aws:sns:us-east-1:123456789012:test-topic",
		Subject:          "Amazon SES Email Event Notification",
		Message:          `{"eventType":"Bounce"}`,
		Timestamp:        "2026-05-09T12:00:00.000Z",
		SignatureVersion: "1",
		SigningCertURL:   certURL,
	}
}

func TestVerifySES_HappyPath(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	if err := d.verifySES(env); err != nil {
		t.Fatalf("verifySES: want nil, got %v", err)
	}
}

func TestVerifySES_HappyPath_SigVersion2(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	env.SignatureVersion = "2"
	signEnvelope(t, fx, env)

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	if err := d.verifySES(env); err != nil {
		t.Fatalf("verifySES (v2): want nil, got %v", err)
	}
}

func TestVerifySES_TamperedMessage(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)

	// Tamper AFTER signing so the canonical string changes.
	env.Message = `{"eventType":"Bounce","tampered":true}`

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errSignatureMismatch) {
		t.Fatalf("verifySES tampered: want errSignatureMismatch, got %v", err)
	}
}

func TestVerifySES_GarbageSignature(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	// Valid base64, but it's all zeros — won't match the real signature.
	env.Signature = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0}, 256))

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errSignatureMismatch) {
		t.Fatalf("verifySES garbage: want errSignatureMismatch, got %v", err)
	}
}

func TestVerifySES_NonBase64Signature(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	env.Signature = "not-valid-base64!@#$%^&*()"

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errSignatureNotBase64) {
		t.Fatalf("verifySES non-base64: want errSignatureNotBase64, got %v", err)
	}
}

func TestVerifySES_EvilCertURL(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)
	// Swap the cert URL to attacker-controlled host AFTER signing so the
	// signature would otherwise match. The URL check must reject this
	// before the cert is fetched.
	env.SigningCertURL = "https://evil.com/cert.pem"

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errInvalidCertURL) {
		t.Fatalf("verifySES evil cert URL: want errInvalidCertURL, got %v", err)
	}
}

func TestVerifySES_HostSuffixAttack(t *testing.T) {
	// Real-world attack: a host that contains the AWS suffix as a
	// substring but is NOT actually amazonaws.com. The regex anchors
	// must reject this.
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)
	env.SigningCertURL = "https://sns.us-east-1.amazonaws.com.evil.com/cert.pem"

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errInvalidCertURL) {
		t.Fatalf("verifySES host-suffix attack: want errInvalidCertURL, got %v", err)
	}
}

func TestVerifySES_HTTPCertURL(t *testing.T) {
	// http:// (not https) must reject — protects against in-flight
	// tampering of the cert.
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)
	env.SigningCertURL = "http://sns.us-east-1.amazonaws.com/cert.pem"

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errInvalidCertURL) {
		t.Fatalf("verifySES http cert URL: want errInvalidCertURL, got %v", err)
	}
}

func TestVerifySES_TopicNotInAllowList(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)

	// Allow-list configured but env.TopicArn doesn't match. Signature
	// passes — but defense-in-depth catches it.
	d := &DeliverabilityDeps{
		SESTopicARNs: []string{"arn:aws:sns:us-east-1:000000000000:other-topic"},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errTopicNotAllowed) {
		t.Fatalf("verifySES topic mismatch: want errTopicNotAllowed, got %v", err)
	}
}

func TestVerifySES_EmptyTopicAllowlist(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	signEnvelope(t, fx, env)

	d := &DeliverabilityDeps{
		SESTopicARNs: nil, // refuse to accept any SES events
	}
	err := d.verifySES(env)
	if !errors.Is(err, errTopicAllowlistEmpty) {
		t.Fatalf("verifySES empty allowlist: want errTopicAllowlistEmpty, got %v", err)
	}
}

func TestVerifySES_UnsupportedSignatureVersion(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	env.SignatureVersion = "9"
	env.Signature = "stub"

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errUnsupportedSigVersion) {
		t.Fatalf("verifySES bad version: want errUnsupportedSigVersion, got %v", err)
	}
}

func TestVerifySES_MissingMessageID(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	env.MessageID = ""

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errMissingMessageID) {
		t.Fatalf("verifySES missing message id: want errMissingMessageID, got %v", err)
	}
}

func TestVerifySES_MissingSignature(t *testing.T) {
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	env.Signature = ""

	d := &DeliverabilityDeps{
		SESTopicARNs: []string{env.TopicArn},
	}
	err := d.verifySES(env)
	if !errors.Is(err, errMissingSignature) {
		t.Fatalf("verifySES missing signature: want errMissingSignature, got %v", err)
	}
}

func TestVerifySES_AllowUnverifiedBypass_NotProduction(t *testing.T) {
	// The bypass is gated on !isProductionEnvForWebhooks(). The Go test
	// binary does NOT set POSTWAVE_ENV/ENVIRONMENT/NODE_ENV so the
	// helper returns false here — bypass succeeds.
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	// No signature at all — would normally reject, but the bypass
	// short-circuits before the field guards.
	d := &DeliverabilityDeps{
		AllowUnverifiedSignatures: true,
	}
	if err := d.verifySES(env); err != nil {
		t.Fatalf("verifySES bypass: want nil, got %v", err)
	}
}

func TestVerifySES_AllowUnverifiedBypass_Production(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	fx := newSESFixture(t)
	env := baseEnv(fx.certURL)
	// Bypass set — but production gate refuses to honour it. Envelope
	// also has no Signature so we expect errMissingSignature once the
	// bypass is rejected (fall-through to the strict path).
	d := &DeliverabilityDeps{
		AllowUnverifiedSignatures: true,
	}
	err := d.verifySES(env)
	if errors.Is(err, nil) || err == nil {
		t.Fatalf("verifySES production bypass: want non-nil error, got nil")
	}
	if !errors.Is(err, errMissingSignature) {
		t.Fatalf("verifySES production bypass: want errMissingSignature (bypass refused), got %v", err)
	}
}

func TestValidateSNSCertURL_AcceptedHosts(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"https://sns.us-east-1.amazonaws.com/SimpleNotificationService-1.pem", true},
		{"https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-2.pem", true},
		{"https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-3.pem", true},
		{"http://sns.us-east-1.amazonaws.com/foo.pem", false},
		{"https://evil.com/cert.pem", false},
		{"https://sns.us-east-1.amazonaws.com.evil.com/foo.pem", false},
		{"https://attacker.sns.us-east-1.amazonaws.com/foo.pem", false},
		{"https://sns.us-east-1.amazonaws.com/foo.txt", false},
		{"", false},
	}
	for _, tc := range cases {
		got := validateSNSCertURL(tc.in)
		if got != tc.want {
			t.Errorf("validateSNSCertURL(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestCanonicalSNSString_NotificationWithSubject(t *testing.T) {
	env := &snsEnvelope{
		Type:      "Notification",
		MessageID: "msg-1",
		TopicArn:  "arn",
		Subject:   "subj",
		Message:   "body",
		Timestamp: "ts",
	}
	got := canonicalSNSString(env)
	want := "Message\nbody\nMessageId\nmsg-1\nSubject\nsubj\nTimestamp\nts\nTopicArn\narn\nType\nNotification\n"
	if got != want {
		t.Errorf("canonicalSNSString notification (subject)\n got: %q\nwant: %q", got, want)
	}
}

func TestCanonicalSNSString_NotificationNoSubject(t *testing.T) {
	env := &snsEnvelope{
		Type:      "Notification",
		MessageID: "msg-1",
		TopicArn:  "arn",
		Message:   "body",
		Timestamp: "ts",
	}
	got := canonicalSNSString(env)
	want := "Message\nbody\nMessageId\nmsg-1\nTimestamp\nts\nTopicArn\narn\nType\nNotification\n"
	if got != want {
		t.Errorf("canonicalSNSString notification (no subject)\n got: %q\nwant: %q", got, want)
	}
}

func TestCanonicalSNSString_SubscriptionConfirmation(t *testing.T) {
	env := &snsEnvelope{
		Type:         "SubscriptionConfirmation",
		MessageID:    "msg-1",
		TopicArn:     "arn",
		Message:      "body",
		Timestamp:    "ts",
		SubscribeURL: "https://example.com/confirm",
		Token:        "tok",
	}
	got := canonicalSNSString(env)
	want := "Message\nbody\nMessageId\nmsg-1\nSubscribeURL\nhttps://example.com/confirm\nTimestamp\nts\nToken\ntok\nTopicArn\narn\nType\nSubscriptionConfirmation\n"
	if got != want {
		t.Errorf("canonicalSNSString subscription\n got: %q\nwant: %q", got, want)
	}
}
