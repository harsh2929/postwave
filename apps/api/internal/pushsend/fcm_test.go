// SPDX-License-Identifier: AGPL-3.0-only
package pushsend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFCMProvider_NotConfigured(t *testing.T) {
	p := &FCMProvider{} // zero value: no credentials
	if p.Configured() {
		t.Fatalf("zero-value FCMProvider must report unconfigured")
	}
	err := p.SendPush(context.Background(), "device-token", "android", "title", "body", nil)
	if err == nil {
		t.Fatal("expected an error when FCM credentials are absent")
	}
	if !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("expected a clear not-configured error, got: %v", err)
	}
}

func TestFCMProvider_PartialConfig_StillNotConfigured(t *testing.T) {
	p := &FCMProvider{Config: FCMConfig{ProjectID: "my-project"}}
	// ClientEmail and PrivateKeyPEM still missing.
	if p.Configured() {
		t.Fatalf("partial FCM config must report unconfigured")
	}
	if err := p.SendPush(context.Background(), "tok", "android", "t", "b", nil); err == nil {
		t.Fatal("expected an error for partial FCM config")
	}
}

func TestFCMProvider_WrongPlatform_Rejected(t *testing.T) {
	p := &FCMProvider{}
	err := p.SendPush(context.Background(), "tok", "ios", "t", "b", nil)
	if err == nil || strings.Contains(err.Error(), "not configured") {
		t.Fatalf("wrong-platform send must be rejected before the configuration check: %v", err)
	}
}

func TestFCMProvider_AccessToken_SignsAssertionAndExchanges(t *testing.T) {
	pemKey, err := generateTestRSAKeyPEM()
	if err != nil {
		t.Fatalf("generate test key: %v", err)
	}

	var gotGrantType, gotAssertion string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse token request form: %v", err)
		}
		gotGrantType = r.FormValue("grant_type")
		gotAssertion = r.FormValue("assertion")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fake-access-token","expires_in":3600}`))
	}))
	defer server.Close()

	p := &FCMProvider{Config: FCMConfig{
		ProjectID:     "my-project",
		ClientEmail:   "svc@my-project.iam.gserviceaccount.com",
		PrivateKeyPEM: pemKey,
		TokenURL:      server.URL,
	}}
	if !p.Configured() {
		t.Fatal("expected provider to report configured with a full credential set")
	}

	token, err := p.accessToken(context.Background())
	if err != nil {
		t.Fatalf("accessToken with a real RSA key must succeed: %v", err)
	}
	if token != "fake-access-token" {
		t.Fatalf("expected the exchanged access token, got %q", token)
	}
	if gotGrantType != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
		t.Fatalf("unexpected grant_type sent to the token endpoint: %q", gotGrantType)
	}
	if parts := strings.Split(gotAssertion, "."); len(parts) != 3 {
		t.Fatalf("expected a 3-part signed JWT assertion, got %d parts", len(parts))
	}

	// A second call within the TTL window must return the cached token
	// without hitting the token endpoint again.
	gotAssertion = ""
	token2, err := p.accessToken(context.Background())
	if err != nil {
		t.Fatalf("second accessToken call failed: %v", err)
	}
	if token2 != token {
		t.Fatalf("expected the cached access token, got %q", token2)
	}
	if gotAssertion != "" {
		t.Fatal("expected the cached-token path to skip the token endpoint entirely")
	}
}
