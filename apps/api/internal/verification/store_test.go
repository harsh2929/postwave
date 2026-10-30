// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// fakeSecrets resolves credential refs from a map.
type fakeSecrets struct {
	values map[string]string
	err    error
	asked  []string
}

const verificationTestTenantID = "71000000-0000-4000-8000-000000000001"

func TestCacheInvalidationInputIsBoundedBeforeDatabaseWork(t *testing.T) {
	cache := &TenantCache{}
	overLimit := make([]string, MaxCacheInvalidationAddresses+1)
	for i := range overLimit {
		overLimit[i] = fmt.Sprintf("u%d@example.com", i)
	}
	if _, err := cache.Invalidate(context.Background(), overLimit); !errors.Is(err, ErrCacheInvalidationTooLarge) {
		t.Fatalf("oversized invalidation error = %v", err)
	}
	for _, invalid := range []string{
		"", "reader@example.com\u202e", strings.Repeat("a", maxPersistedVerificationEmailBytes+1),
	} {
		if _, err := cache.Invalidate(context.Background(), []string{invalid}); !errors.Is(err, ErrCacheInvalidationInput) {
			t.Fatalf("invalid cache address %q error = %v", invalid, err)
		}
	}
}

func TestCacheInvalidationNormalizationCollapsesFirstSeenDuplicates(t *testing.T) {
	got, err := normalizeCacheInvalidationAddresses([]string{
		" A@Example.com ", "a@example.com", "b@example.com",
	})
	if err != nil {
		t.Fatalf("normalizeCacheInvalidationAddresses: %v", err)
	}
	want := []string{"a@example.com", "b@example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized invalidation = %v, want %v", got, want)
	}
}

func verificationTestSecretName(provider, credentialID string) string {
	name, err := tenantVerificationSecretName(verificationTestTenantID, provider, credentialID)
	if err != nil {
		panic(err)
	}
	return name
}

func (f *fakeSecrets) Get(_ context.Context, name string) (string, error) {
	f.asked = append(f.asked, name)
	if f.err != nil {
		return "", f.err
	}
	v, ok := f.values[name]
	if !ok {
		return "", errors.New("secret not found: " + name)
	}
	return v, nil
}

func TestNewVendorVerifierBuildsZeroBounceWithResolvedKey(t *testing.T) {
	cfg := ProviderConfig{
		Provider: ProviderZeroBounce,
		Settings: ProviderSettings{IPAddress: "  1.2.3.4  "},
	}

	v, err := newVendorVerifier(cfg, "resolved-key")
	if err != nil {
		t.Fatalf("newVendorVerifier: %v", err)
	}
	zb, ok := v.(*ZeroBounceVerifier)
	if !ok {
		t.Fatalf("got %T, want *ZeroBounceVerifier", v)
	}
	if zb.APIKey != "resolved-key" {
		t.Fatalf("APIKey = %q", zb.APIKey)
	}
	if zb.baseURL() != ZeroBounceDefaultBaseURL {
		t.Fatalf("baseURL = %q, want official origin", zb.baseURL())
	}
	if zb.testHooks != nil {
		t.Fatal("production constructor installed test endpoint hooks")
	}
	if zb.IPAddress != "1.2.3.4" {
		t.Fatalf("IPAddress = %q", zb.IPAddress)
	}
}

func TestProviderIPAddressRejectsRawControlsBeforeResolutionOrEgress(t *testing.T) {
	for _, control := range []string{"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f"} {
		t.Run(fmt.Sprintf("U+%04X", []rune(control)[0]), func(t *testing.T) {
			secrets := &fakeSecrets{values: map[string]string{
				verificationTestSecretName(ProviderZeroBounce, "candidate"): "candidate-key",
			}}
			factoryCalled := false
			store := &Store{
				Secrets: secrets,
				vendorFactory: func(ProviderConfig, string) (Verifier, error) {
					factoryCalled = true
					return vendorStub(nil), nil
				},
			}
			_, err := store.vendorForConfig(context.Background(), verificationTestTenantID, ProviderConfig{
				Provider: ProviderZeroBounce, CredentialRef: "candidate", Enabled: true,
				Settings: ProviderSettings{IPAddress: "1.2.3.4" + control},
			})
			if err == nil {
				t.Fatal("provider settings accepted a raw control")
			}
			if len(secrets.asked) != 0 || factoryCalled {
				t.Fatalf("unsafe IP reached resolution/egress: secrets=%v factory=%t",
					secrets.asked, factoryCalled)
			}
		})
	}
}

func TestProviderIPAddressIsNormalizedBeforeDriverConstruction(t *testing.T) {
	secretName := verificationTestSecretName(ProviderZeroBounce, "candidate")
	var got ProviderConfig
	store := &Store{
		Secrets: &fakeSecrets{values: map[string]string{secretName: "candidate-key"}},
		vendorFactory: func(cfg ProviderConfig, _ string) (Verifier, error) {
			got = cfg
			return vendorStub(nil), nil
		},
	}
	if _, err := store.vendorForConfig(context.Background(), verificationTestTenantID, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "candidate", Enabled: true,
		Settings: ProviderSettings{IPAddress: "  2001:db8::1  "},
	}); err != nil {
		t.Fatalf("vendorForConfig: %v", err)
	}
	if got.Settings.IPAddress != "2001:db8::1" {
		t.Fatalf("driver IPAddress=%q, want normalized address", got.Settings.IPAddress)
	}
}

func TestNewVendorVerifierBuildsKickbox(t *testing.T) {
	cfg := ProviderConfig{Provider: ProviderKickbox}

	v, err := newVendorVerifier(cfg, "kb-key")
	if err != nil {
		t.Fatalf("newVendorVerifier: %v", err)
	}
	kb, ok := v.(*KickboxVerifier)
	if !ok {
		t.Fatalf("got %T, want *KickboxVerifier", v)
	}
	if kb.APIKey != "kb-key" {
		t.Fatalf("APIKey = %q", kb.APIKey)
	}
}

func TestNewVendorVerifierRejectsUnknownProvider(t *testing.T) {
	_, err := newVendorVerifier(ProviderConfig{Provider: "not-a-vendor"}, "k")
	if err == nil {
		t.Fatal("expected an error for an unknown provider")
	}
}

func TestNewVendorVerifierRejectsEmptyKey(t *testing.T) {
	// A blank secret means the resolver found nothing. Building a
	// driver anyway would produce ErrNotConfigured per-address instead
	// of one clear failure at wiring time.
	_, err := newVendorVerifier(ProviderConfig{Provider: ProviderZeroBounce}, "  ")
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}

func TestNewVendorVerifierRejectsInvisibleOrNonASCIIKeys(t *testing.T) {
	for _, key := range []string{" key", "key ", "key\v", "key\u0085", "key\u200b", "key\u202e", "key\ufeff"} {
		if _, err := newVendorVerifier(ProviderConfig{Provider: ProviderZeroBounce}, key); !errors.Is(err, ErrNotConfigured) {
			t.Fatalf("newVendorVerifier(%q) error=%v, want ErrNotConfigured", key, err)
		}
	}
}

func TestProviderConfigJSONNeverCarriesTheAPIKey(t *testing.T) {
	// The config is returned by the settings endpoint. A key leaking
	// into that response would put a live billable credential into
	// browser history, logs, and any UI error report.
	balance := 500
	cfg := ProviderConfig{
		TenantID:      "t1",
		Provider:      ProviderZeroBounce,
		CredentialRef: "zerobounce-production",
		Enabled:       true,
		LastError:     "boom",
		LastBalance:   &balance,
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	lowered := strings.ToLower(string(raw))
	for _, forbidden := range []string{"api_key", "apikey", "secret", "\"key\""} {
		if strings.Contains(lowered, forbidden) {
			t.Fatalf("serialized config contains %q: %s", forbidden, raw)
		}
	}
	if !strings.Contains(string(raw), "credential_ref") {
		t.Fatalf("credential_ref (an opaque tenant-local id) should be present: %s", raw)
	}
}

func TestProviderSettingsRoundTripThroughJSON(t *testing.T) {
	in := ProviderSettings{
		IPAddress:        "9.9.9.9",
		DegradeOnFailure: true,
		CacheTTLDays:     45,
	}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out ProviderSettings
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out != in {
		t.Fatalf("round trip changed the value:\n got %+v\nwant %+v", out, in)
	}
}

func TestCacheTTLDefaultsAndClamps(t *testing.T) {
	cases := []struct {
		name string
		days int
		want time.Duration
	}{
		{"zero uses the default", 0, DefaultCacheTTL},
		{"negative uses the default", -5, DefaultCacheTTL},
		{"in range is honoured", 45, 45 * 24 * time.Hour},
		{"above the ceiling clamps", 9999, MaxCacheTTL},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cacheTTLFromDays(tc.days); got != tc.want {
				t.Fatalf("cacheTTLFromDays(%d) = %v, want %v", tc.days, got, tc.want)
			}
		})
	}
}

func TestCacheTTLIsBoundedBecauseVerdictsGoStale(t *testing.T) {
	// A mailbox that was valid a year ago is not evidence it is valid
	// today; an unbounded cache would quietly turn into a stale list.
	if MaxCacheTTL > 180*24*time.Hour {
		t.Fatalf("MaxCacheTTL = %v; a verdict older than ~6 months is not trustworthy", MaxCacheTTL)
	}
	if DefaultCacheTTL < 7*24*time.Hour {
		t.Fatalf("DefaultCacheTTL = %v; too short to save any credits on repeat imports", DefaultCacheTTL)
	}
}

func TestBuildChainFallsBackToLocalOnlyWhenNoProviderConfigured(t *testing.T) {
	// The free tier must work with zero configuration. Returning an
	// error here would make every unconfigured tenant's import
	// preflight fail rather than simply do less.
	s := &Store{Secrets: &fakeSecrets{values: map[string]string{}}}

	chain, err := s.buildChainFrom(context.Background(), verificationTestTenantID, nil, nil)
	if err != nil {
		t.Fatalf("buildChainFrom: %v", err)
	}
	if chain.Vendor != nil {
		t.Fatal("Vendor should be nil with no provider configured")
	}
	if chain.Local == nil {
		t.Fatal("Local tier must always be present")
	}
}

func TestBuildChainWiresVendorAndDegradeSetting(t *testing.T) {
	secretName := verificationTestSecretName(ProviderZeroBounce, "zb-primary")
	secrets := &fakeSecrets{values: map[string]string{secretName: "zb-secret"}}
	s := &Store{Secrets: secrets}
	cfg := &ProviderConfig{
		Provider:      ProviderZeroBounce,
		CredentialRef: "zb-primary",
		Enabled:       true,
		Settings:      ProviderSettings{DegradeOnFailure: true},
	}

	chain, err := s.buildChainFrom(context.Background(), verificationTestTenantID, cfg, nil)
	if err != nil {
		t.Fatalf("buildChainFrom: %v", err)
	}
	if chain.Vendor == nil {
		t.Fatal("Vendor = nil, want a configured driver")
	}
	if chain.Vendor.Name() != ProviderZeroBounce {
		t.Fatalf("Vendor.Name() = %q", chain.Vendor.Name())
	}
	if !chain.DegradeOnVendorFailure {
		t.Fatal("DegradeOnFailure setting was not propagated to the chain")
	}
	if len(secrets.asked) != 1 || secrets.asked[0] != secretName {
		t.Fatalf("secrets asked %v, want [%s]", secrets.asked, secretName)
	}
}

func TestBuildChainSurfacesSecretResolutionFailure(t *testing.T) {
	// Silently degrading to local-only on a broken credential would
	// look identical to "verification ran and found nothing wrong".
	s := &Store{Secrets: &fakeSecrets{err: errors.New("vault down")}}
	cfg := &ProviderConfig{Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: true}

	if _, err := s.buildChainFrom(context.Background(), verificationTestTenantID, cfg, nil); err == nil {
		t.Fatal("expected an error when the credential cannot be resolved")
	}
}

func TestBuildChainIgnoresDisabledProvider(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]string{verificationTestSecretName(ProviderZeroBounce, "zb-primary"): "zb-secret"}}
	s := &Store{Secrets: secrets}
	cfg := &ProviderConfig{Provider: ProviderZeroBounce, CredentialRef: "zb-primary", Enabled: false}

	chain, err := s.buildChainFrom(context.Background(), verificationTestTenantID, cfg, nil)
	if err != nil {
		t.Fatalf("buildChainFrom: %v", err)
	}
	if chain.Vendor != nil {
		t.Fatal("a disabled provider must not be wired into the chain")
	}
	if len(secrets.asked) != 0 {
		t.Fatalf("resolved a secret for a disabled provider: %v", secrets.asked)
	}
}

func TestConfigureProviderRejectsFailedProbeBeforePersistence(t *testing.T) {
	secretName := verificationTestSecretName(ProviderZeroBounce, "candidate")
	secrets := &fakeSecrets{values: map[string]string{secretName: "candidate-key"}}
	probeCalls := 0
	s := &Store{
		Secrets: secrets,
		vendorFactory: func(cfg ProviderConfig, key string) (Verifier, error) {
			if cfg.Provider != ProviderZeroBounce || key != "candidate-key" {
				t.Fatalf("factory received cfg=%+v key=%q", cfg, key)
			}
			probeCalls++
			return &fakeVerifier{
				name:      cfg.Provider,
				creditErr: fmt.Errorf("upstream body canary: %w", ErrUnauthorized),
			}, nil
		},
	}

	_, err := s.ConfigureProvider(context.Background(), verificationTestTenantID, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "candidate", Enabled: true,
	})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("ConfigureProvider error = %v, want staged ErrUnauthorized", err)
	}
	if probeCalls != 1 {
		t.Fatalf("balance probe calls = %d, want 1", probeCalls)
	}
	if len(secrets.asked) != 1 || secrets.asked[0] != secretName {
		t.Fatalf("secret resolution = %v, want tenant-bound %q", secrets.asked, secretName)
	}
	// Pool is nil. Reaching persistence would replace the typed probe error with
	// "no database pool configured"; retaining ErrUnauthorized proves the failed
	// candidate was rejected during staging.
}

func TestConfigureProviderRejectsGlobalSecretNameBeforeResolution(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]string{}}
	s := &Store{Secrets: secrets}
	_, err := s.ConfigureProvider(context.Background(), verificationTestTenantID, ProviderConfig{
		Provider: ProviderZeroBounce, CredentialRef: "vault://global/key", Enabled: true,
	})
	if err == nil {
		t.Fatal("ConfigureProvider accepted a global secret name")
	}
	if len(secrets.asked) != 0 {
		t.Fatalf("global secret name reached resolver: %v", secrets.asked)
	}
}

func TestValidateProviderNameAcceptsOnlyKnownVendors(t *testing.T) {
	for _, ok := range []string{ProviderZeroBounce, ProviderKickbox} {
		if err := ValidateProviderName(ok); err != nil {
			t.Errorf("ValidateProviderName(%q) = %v, want nil", ok, err)
		}
	}
	// ProviderLocal is not configurable — it is always on and has no
	// credential. Accepting it here would create a row that can never
	// be used.
	for _, bad := range []string{ProviderLocal, "", "sendgrid", "ZeroBounce\x00"} {
		if err := ValidateProviderName(bad); err == nil {
			t.Errorf("ValidateProviderName(%q) = nil, want an error", bad)
		}
	}
}

func TestValidateCredentialRefAcceptsOnlyOpaqueTenantLocalIDs(t *testing.T) {
	if err := ValidateCredentialRef("zerobounce-prod_1.key"); err != nil {
		t.Fatalf("ValidateCredentialRef: %v", err)
	}
	for _, bad := range []string{
		"   ",
		"vault://global/secret",
		"postwave/tenants/71000000-0000-4000-8000-000000000001/verification/zerobounce/key",
		"../other-tenant",
		"a/b",
		"a:b",
		strings.Repeat("x", 129),
		"opaque\u202eid",
	} {
		if err := ValidateCredentialRef(bad); err == nil {
			t.Errorf("ValidateCredentialRef(%q) = nil, want rejection", bad)
		}
	}
}

func TestTenantVerificationSecretNameBindsTenantProviderAndCredential(t *testing.T) {
	got, err := tenantVerificationSecretName(verificationTestTenantID, ProviderZeroBounce, "primary")
	if err != nil {
		t.Fatal(err)
	}
	want := "postwave/tenants/" + verificationTestTenantID + "/verification/zerobounce/primary"
	if got != want {
		t.Fatalf("secret name = %q, want %q", got, want)
	}
	for _, tc := range []struct {
		tenant, provider, id string
	}{
		{"not-a-uuid", ProviderZeroBounce, "primary"},
		{verificationTestTenantID, "unknown", "primary"},
		{verificationTestTenantID, ProviderZeroBounce, "tenants/other/key"},
	} {
		if _, err := tenantVerificationSecretName(tc.tenant, tc.provider, tc.id); err == nil {
			t.Errorf("tenantVerificationSecretName(%q, %q, %q) accepted", tc.tenant, tc.provider, tc.id)
		}
	}
}

func TestVerificationAPIKeyFromSecretAcceptsBoundedRawOrJSONValues(t *testing.T) {
	for _, tc := range []struct {
		raw, want string
	}{
		{"raw-key", "raw-key"},
		{`{"api_key":"json-key","base_url":"https://attacker.invalid"}`, "json-key"},
		{"{\n  \"api_key\": \"pretty-json-key\"\n}", "pretty-json-key"},
		{`{"token":"token-key"}`, "token-key"},
	} {
		got, err := verificationAPIKeyFromSecret(tc.raw)
		if err != nil || got != tc.want {
			t.Errorf("verificationAPIKeyFromSecret(%q) = %q, %v; want %q", tc.raw, got, err, tc.want)
		}
	}
	for _, raw := range []string{"", `{}`, `{"base_url":"https://attacker.invalid"}`, strings.Repeat("x", maxVerificationCredentialBytes+1)} {
		if _, err := verificationAPIKeyFromSecret(raw); err == nil {
			t.Errorf("verificationAPIKeyFromSecret accepted unsafe payload of length %d", len(raw))
		}
	}
}

func TestVerificationAPIKeyFromSecretRejectsControlsAndInvalidUTF8(t *testing.T) {
	for _, control := range []string{
		"\x00", "\t", "\n", "\v", "\f", "\r", "\u0085", "\u009f",
		"\u200b", "\u202e", "\u2060", "\ufeff",
	} {
		t.Run(fmt.Sprintf("plain-U+%04X", []rune(control)[0]), func(t *testing.T) {
			if _, err := verificationAPIKeyFromSecret("printable-key" + control); err == nil {
				t.Fatalf("accepted plain credential control %q", control)
			}
		})
		t.Run(fmt.Sprintf("json-U+%04X", []rune(control)[0]), func(t *testing.T) {
			raw, err := json.Marshal(map[string]string{"api_key": "printable-key" + control})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := verificationAPIKeyFromSecret(string(raw)); err == nil {
				t.Fatalf("accepted JSON credential control %q", control)
			}
		})
	}

	invalidUTF8 := string([]byte{'k', 'e', 'y', 0xff})
	for _, raw := range []string{invalidUTF8, `{"api_key":"` + invalidUTF8 + `"}`} {
		if _, err := verificationAPIKeyFromSecret(raw); err == nil {
			t.Fatal("accepted an invalid UTF-8 credential")
		}
	}
	for _, raw := range []string{
		" printable-key", "printable-key ", `{"api_key":" printable-key"}`,
		`{"api_key":"printable-key "}`,
	} {
		if _, err := verificationAPIKeyFromSecret(raw); err == nil {
			t.Fatalf("accepted credential with surrounding whitespace: %q", raw)
		}
	}
	for _, raw := range []string{"AZaz09-._~+/=", `{"api_key":"AZaz09-._~+/="}`} {
		if got, err := verificationAPIKeyFromSecret(raw); err != nil || got != "AZaz09-._~+/=" {
			t.Fatalf("printable vendor key parsed as %q, %v", got, err)
		}
	}
}

func TestNormalizeEmailForCacheKeyLowercasesAndTrims(t *testing.T) {
	// The cache key must match what the chain looks up, or every
	// lookup misses and every re-verify costs a credit.
	if got := NormalizeEmail("  Someone@Example.COM "); got != "someone@example.com" {
		t.Fatalf("NormalizeEmail = %q", got)
	}
}
