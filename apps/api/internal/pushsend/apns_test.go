// SPDX-License-Identifier: AGPL-3.0-only
package pushsend

import (
	"context"
	"strings"
	"testing"
)

func TestAPNsProvider_NotConfigured(t *testing.T) {
	p := &APNsProvider{} // zero value: no credentials
	if p.Configured() {
		t.Fatalf("zero-value APNsProvider must report unconfigured")
	}
	err := p.SendPush(context.Background(), "device-token", "ios", "title", "body", nil)
	if err == nil {
		t.Fatal("expected an error when APNs credentials are absent")
	}
	if !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("expected a clear not-configured error, got: %v", err)
	}
}

func TestAPNsProvider_PartialConfig_StillNotConfigured(t *testing.T) {
	p := &APNsProvider{Config: APNsConfig{KeyID: "ABC1234567", TeamID: "TEAM123456"}}
	// AuthKeyPEM and BundleID still missing.
	if p.Configured() {
		t.Fatalf("partial APNs config must report unconfigured")
	}
	if err := p.SendPush(context.Background(), "tok", "ios", "t", "b", nil); err == nil {
		t.Fatal("expected an error for partial APNs config")
	}
}

func TestAPNsProvider_WrongPlatform_Rejected(t *testing.T) {
	p := &APNsProvider{}
	err := p.SendPush(context.Background(), "tok", "android", "t", "b", nil)
	if err == nil || strings.Contains(err.Error(), "not configured") {
		t.Fatalf("wrong-platform send must be rejected before the configuration check: %v", err)
	}
}

func TestAPNsProvider_ProviderToken_SignsWithRealKey(t *testing.T) {
	pemKey, err := generateTestECKeyPEM()
	if err != nil {
		t.Fatalf("generate test key: %v", err)
	}
	p := &APNsProvider{Config: APNsConfig{
		KeyID:      "KEY1234567",
		TeamID:     "TEAM123456",
		AuthKeyPEM: pemKey,
		BundleID:   "com.moosewave.app",
	}}
	if !p.Configured() {
		t.Fatal("expected provider to report configured with a full credential set")
	}
	jwt, err := p.providerToken()
	if err != nil {
		t.Fatalf("providerToken with a real EC key must succeed: %v", err)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("expected a 3-part JWT, got %d parts", len(parts))
	}
	// A second call within the TTL window must return the cached token.
	jwt2, err := p.providerToken()
	if err != nil {
		t.Fatalf("second providerToken call failed: %v", err)
	}
	if jwt != jwt2 {
		t.Fatal("expected the provider token to be cached within the TTL window")
	}
}
