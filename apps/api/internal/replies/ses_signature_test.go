// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The replies SES endpoint authenticated with a shared secret alone, while the
// deliverability path verified SNS signatures in full. A secret travels in
// every request and can leak into a log or a proxy; a signature cannot be
// replayed onto different content. These prove the second factor is now
// applied — and that turning it on is opt-in, so an existing deployment does
// not lose its inbound path on deploy.

func postSES(t *testing.T, deps *Deps, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/internal/webhooks/replies/ses",
		strings.NewReader(body))
	request.Header.Set(SESSharedSecretHeader, "shared-secret")
	recorder := httptest.NewRecorder()
	deps.HandleSES(recorder, request)
	return recorder
}

func envelopeJSON(t *testing.T, overrides map[string]any) string {
	t.Helper()
	envelope := map[string]any{
		"Type":             "Notification",
		"MessageId":        "11111111-2222-3333-4444-555555555555",
		"TopicArn":         "arn:aws:sns:eu-west-1:123456789012:postwave-replies",
		"Message":          "{}",
		"Timestamp":        "2026-08-15T10:00:00.000Z",
		"SignatureVersion": "2",
		"Signature":        "bm90LWEtcmVhbC1zaWduYXR1cmU=",
		"SigningCertURL":   "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-x.pem",
	}
	for key, value := range overrides {
		envelope[key] = value
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(raw)
}

// The headline: with verification configured, a payload carrying the correct
// shared secret but a bogus signature is refused.
func TestAForgedSignatureIsRejectedEvenWithTheSharedSecret(t *testing.T) {
	deps := &Deps{
		SESSharedSecret: "shared-secret",
		SESTopicARNs:    []string{"arn:aws:sns:eu-west-1:123456789012:postwave-replies"},
	}

	recorder := postSES(t, deps, envelopeJSON(t, nil))

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for an unverifiable signature", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "bad_signature") {
		t.Errorf("body should name the signature failure: %s", recorder.Body.String())
	}
}

// A signature from a topic we do not accept is refused before any processing,
// so a stranger's topic cannot inject replies even if it is genuinely signed.
func TestAnUnlistedTopicIsRejected(t *testing.T) {
	deps := &Deps{
		SESSharedSecret: "shared-secret",
		SESTopicARNs:    []string{"arn:aws:sns:eu-west-1:123456789012:postwave-replies"},
	}

	recorder := postSES(t, deps, envelopeJSON(t, map[string]any{
		"TopicArn": "arn:aws:sns:eu-west-1:999999999999:someone-else",
	}))

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 for an unlisted topic", recorder.Code)
	}
}

// Opt-in: with no topic ARNs configured the endpoint behaves exactly as before,
// so upgrading does not take a working inbound path down. It is weaker, and
// that is a deployment choice rather than something this code decides.
func TestVerificationIsSkippedWhenNoTopicIsConfigured(t *testing.T) {
	deps := &Deps{SESSharedSecret: "shared-secret"}

	recorder := postSES(t, deps, envelopeJSON(t, map[string]any{
		"Type": "SubscriptionConfirmation",
	}))

	if recorder.Code == http.StatusUnauthorized {
		t.Fatalf("unconfigured verification must not reject: %s", recorder.Body.String())
	}
}

// The shared secret still stands on its own. Removing it must fail before the
// signature is even considered.
func TestTheSharedSecretIsStillRequired(t *testing.T) {
	deps := &Deps{
		SESSharedSecret: "shared-secret",
		SESTopicARNs:    []string{"arn:aws:sns:eu-west-1:123456789012:postwave-replies"},
	}
	request := httptest.NewRequest(http.MethodPost, "/api/internal/webhooks/replies/ses",
		strings.NewReader(envelopeJSON(t, nil)))
	recorder := httptest.NewRecorder()

	deps.HandleSES(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 without the shared secret", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "missing_signature") {
		t.Errorf("the missing secret should be named: %s", recorder.Body.String())
	}
}
