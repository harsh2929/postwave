// SPDX-License-Identifier: MIT

package activecampaign

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func init() {
	allowInsecureActiveCampaignTestLoopback = true
}

func TestActiveCampaignProductionURLPolicy(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "")
	for _, raw := range []string{
		"https://tenant.api-us1.com/api/3",
		"https://tenant.activehosted.com/api/3",
		"https://tenant.api-us1.com:443/api/3",
	} {
		t.Run("accept_"+raw, func(t *testing.T) {
			if err := validateActiveCampaignAPIURL(raw, false); err != nil {
				t.Fatalf("validate %q: %v", raw, err)
			}
		})
	}

	for _, raw := range []string{
		"http://tenant.api-us1.com/api/3",
		"http://127.0.0.1:8080/api/3",
		"https://127.0.0.1/api/3",
		"https://localhost/api/3",
		"https://attacker.example/api/3",
		"https://tenant.api-us1.com.attacker.example/api/3",
		"https://nested.tenant.api-us1.com/api/3",
		"https://api-us1.com/api/3",
		"https://tenant.api-us1.com:8443/api/3",
		"https://tenant.api-us1.com/api/3/contacts",
	} {
		t.Run("reject_"+raw, func(t *testing.T) {
			if err := validateActiveCampaignAPIURL(raw, false); err == nil {
				t.Fatalf("validate %q unexpectedly succeeded", raw)
			}
		})
	}
}

func TestActiveCampaignConfiguredExactHostPolicy(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "tenant.eu.activecampaign.example, SECOND.provider.example.")

	for _, raw := range []string{
		"https://tenant.eu.activecampaign.example/api/3",
		"https://TENANT.EU.ACTIVECAMPAIGN.EXAMPLE:443/api/3",
		"https://second.provider.example/api/3",
	} {
		t.Run("accept_"+raw, func(t *testing.T) {
			if err := validateActiveCampaignAPIURL(raw, false); err != nil {
				t.Fatalf("validate %q: %v", raw, err)
			}
		})
	}

	for _, raw := range []string{
		"https://unconfigured.provider.example/api/3",
		"https://nested.tenant.eu.activecampaign.example/api/3",
		"https://tenant.eu.activecampaign.example.attacker.test/api/3",
		"http://tenant.eu.activecampaign.example/api/3",
		"https://tenant.eu.activecampaign.example:8443/api/3",
		"https://tenant.eu.activecampaign.example/api/3/contacts",
		"https://user:secret@tenant.eu.activecampaign.example/api/3",
		"https://tenant.eu.activecampaign.example/api/3?token=secret",
		"https://tenant.eu.activecampaign.example/api/3#developer",
		"https://127.0.0.1/api/3",
		"https://api.localhost/api/3",
	} {
		t.Run("reject_"+raw, func(t *testing.T) {
			if err := validateActiveCampaignAPIURL(raw, false); err == nil {
				t.Fatalf("validate %q unexpectedly succeeded", raw)
			}
		})
	}
}

func TestActiveCampaignConfiguredHostListRejectsUnsafeEntries(t *testing.T) {
	for _, configured := range []string{
		"https://tenant.provider.example",
		"tenant.provider.example:443",
		"127.0.0.1",
		"127.1",
		"127.001.000.001",
		"localhost",
		"api.localhost",
		"single-label",
		"*.provider.example",
		"tenant.provider.example,",
	} {
		t.Run(configured, func(t *testing.T) {
			t.Setenv(activeCampaignAllowedAPIHostsEnv, configured)
			if err := validateActiveCampaignAPIURL("https://tenant.provider.example/api/3", false); err == nil || !strings.Contains(err.Error(), activeCampaignAllowedAPIHostsEnv) {
				t.Fatalf("validate with configured host %q error = %v", configured, err)
			}
		})
	}
}

func TestActiveCampaignAuthenticateUsesConfiguredNonBuiltInHost(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "tenant.example.com")
	var gotHost, gotToken string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotToken = r.Header.Get("Api-Token")
		if r.URL.Path != "/api/3/users/me" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"user":{"id":"1"}}`))
	}))
	defer srv.Close()

	transport := srv.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	ad := New()
	ad.HTTPClient = &http.Client{Transport: transport}
	sess, err := ad.Authenticate(context.Background(), adapter.Credentials{
		APIKey:    "configured-host-token",
		AccountID: "https://tenant.example.com/api/3",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotHost != "tenant.example.com" {
		t.Fatalf("request host = %q", gotHost)
	}
	if gotToken != "configured-host-token" {
		t.Fatalf("Api-Token = %q", gotToken)
	}
	if sess.AccountID != "tenant.example.com" || AccountFingerprint(sess) == "" {
		t.Fatalf("authenticated session account = %q fingerprint = %q", sess.AccountID, AccountFingerprint(sess))
	}
}

func TestActiveCampaignDoRejectsRedirectWithoutForwardingToken(t *testing.T) {
	var targetToken string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetToken = r.Header.Get("Api-Token")
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/stolen", http.StatusFound)
	}))
	defer source.Close()

	sess := adapter.Session{
		AccessToken: "do-not-forward",
		Source:      canonical.SourceActiveCampaign,
		Extra:       map[string]string{"api_url": source.URL + "/api/3"},
	}
	err := New().do(context.Background(), sess, http.MethodGet, "/users/me", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "redirects are not allowed") {
		t.Fatalf("redirect error = %v", err)
	}
	if targetToken != "" {
		t.Fatalf("redirect target received Api-Token %q", targetToken)
	}
}

func TestActiveCampaignAccountFingerprintIsStableAcrossUserTokens(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "")
	raw := "https://Tenant.API-US1.COM:443/api/3"
	first, err := accountFingerprintFromAPIURL(raw)
	if err != nil {
		t.Fatal(err)
	}
	second, err := accountFingerprintFromAPIURL("https://tenant.api-us1.com/api/3")
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatalf("fingerprints = %q / %q, want stable non-empty identity", first, second)
	}
	alias, err := accountFingerprintFromAPIURL("https://tenant.activehosted.com/api/3")
	if err != nil {
		t.Fatal(err)
	}
	if alias != first {
		t.Fatalf("provider aliases produced different fingerprints: %q / %q", first, alias)
	}
}

func TestActiveCampaignConfiguredHostFingerprintUsesCanonicalExactHost(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "tenant.provider.example,other.provider.example")

	first, err := accountFingerprintFromAPIURL("https://TENANT.PROVIDER.EXAMPLE:443/api/3")
	if err != nil {
		t.Fatal(err)
	}
	second, err := accountFingerprintFromAPIURL("https://tenant.provider.example/api/3")
	if err != nil {
		t.Fatal(err)
	}
	other, err := accountFingerprintFromAPIURL("https://other.provider.example/api/3")
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || first != second {
		t.Fatalf("configured-host fingerprints = %q / %q, want stable exact-host identity", first, second)
	}
	if first == other {
		t.Fatalf("different configured hosts shared fingerprint %q", first)
	}
}

func TestActiveCampaignCredentialAPIFingerprintNormalizesAuthenticateInputs(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "tenant.provider.example")

	want, err := AccountFingerprintForAPIURL("https://tenant.api-us1.com/api/3")
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		"tenant.api-us1.com",
		"tenant.api-us1.com/api/3/contacts",
		"https://tenant.api-us1.com",
		"https://tenant.api-us1.com/",
		"https://tenant.api-us1.com/api/3/contacts/42",
	} {
		t.Run(raw, func(t *testing.T) {
			got, fingerprintErr := AccountFingerprintForCredentialAPIURL(raw)
			if fingerprintErr != nil {
				t.Fatalf("credential fingerprint %q: %v", raw, fingerprintErr)
			}
			if got != want {
				t.Fatalf("credential fingerprint %q = %q, want %q", raw, got, want)
			}
		})
	}

	configuredWant, err := AccountFingerprintForAPIURL("https://tenant.provider.example/api/3")
	if err != nil {
		t.Fatal(err)
	}
	configuredGot, err := AccountFingerprintForCredentialAPIURL("tenant.provider.example/api/3/contacts")
	if err != nil {
		t.Fatal(err)
	}
	if configuredGot != configuredWant {
		t.Fatalf("configured-host credential fingerprint = %q, want %q", configuredGot, configuredWant)
	}
}

func TestActiveCampaignCredentialAPIFingerprintRejectsUnsafeInputs(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "")
	for _, raw := range []string{
		"",
		"ftp://tenant.api-us1.com/api/3",
		"http://tenant.api-us1.com/api/3",
		"https://user:secret@tenant.api-us1.com/api/3",
		"https://tenant.api-us1.com/api/3?token=secret",
		"https://tenant.api-us1.com/api/3#fragment",
		"https://tenant.api-us1.com:8443/api/3",
		"https://tenant.api-us1.com/app/settings/developer",
		"https://127.0.0.1/api/3",
		"https://localhost/api/3",
		"https://unconfigured.provider.example/api/3",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := AccountFingerprintForCredentialAPIURL(raw); err == nil {
				t.Fatalf("credential fingerprint %q unexpectedly succeeded", raw)
			}
		})
	}
}

func TestActiveCampaignRequestAPIFingerprintRemainsStrict(t *testing.T) {
	t.Setenv(activeCampaignAllowedAPIHostsEnv, "")
	for _, raw := range []string{
		"tenant.api-us1.com",
		"https://tenant.api-us1.com",
		"https://tenant.api-us1.com/api/3/contacts",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := AccountFingerprintForAPIURL(raw); err == nil {
				t.Fatalf("strict request fingerprint %q unexpectedly succeeded", raw)
			}
		})
	}
}
