// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integration_egress"
)

type providerRoundTripFunc func(*http.Request) (*http.Response, error)

func (f providerRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestOfficialProviderOriginsAreExactHTTPSOrigins(t *testing.T) {
	for _, tc := range []struct {
		provider string
		kind     providerOriginKind
		want     string
	}{
		{ProviderZeroBounce, providerPrimaryOrigin, ZeroBounceDefaultBaseURL},
		{ProviderZeroBounce, providerBulkOrigin, ZeroBounceDefaultBulkURL},
		{ProviderKickbox, providerPrimaryOrigin, KickboxDefaultBaseURL},
	} {
		got, err := officialProviderOrigin(tc.provider, tc.kind)
		if err != nil {
			t.Fatalf("officialProviderOrigin(%s, %d): %v", tc.provider, tc.kind, err)
		}
		if got != tc.want {
			t.Fatalf("officialProviderOrigin(%s, %d) = %q, want %q", tc.provider, tc.kind, got, tc.want)
		}
	}
}

func TestZeroBounceRealtimeBatchUsesPrimaryAPIOrigin(t *testing.T) {
	if ZeroBounceDefaultBulkURL != ZeroBounceDefaultBaseURL {
		t.Fatalf("real-time batch origin=%q base=%q, want official primary API host",
			ZeroBounceDefaultBulkURL, ZeroBounceDefaultBaseURL)
	}
	if ZeroBounceDefaultBulkURL != "https://api.zerobounce.net" {
		t.Fatalf("real-time batch origin=%q, want official primary API host", ZeroBounceDefaultBulkURL)
	}
}

func TestOfficialProviderOriginRejectsAdversarialURLForms(t *testing.T) {
	tests := []string{
		"http://api.zerobounce.net",
		"https://user:password@api.zerobounce.net",
		"https://api.zerobounce.net:443",
		"https://api.zerobounce.net:8443",
		"https://api.zerobounce.net/v2/validate",
		"https://api.zerobounce.net?api_key=secret",
		"https://api.zerobounce.net#fragment",
		"https://api.zerobounce.net.attacker.example",
		"https://api.zerobounce.net.",
		"https://127.0.0.1",
		"https://169.254.169.254",
		"https://[::1]",
		"https://[fe80::1]",
		"https://[::ffff:169.254.169.254]",
		"https://api.kickbox.com",
	}
	for _, raw := range tests {
		if err := validateOfficialProviderOrigin(ProviderZeroBounce, providerPrimaryOrigin, raw); err == nil {
			t.Errorf("validateOfficialProviderOrigin accepted %q", raw)
		}
	}
}

func TestProductionProviderClientsRejectAllRedirects(t *testing.T) {
	clients := map[string]*http.Client{
		ProviderZeroBounce:            productionProviderHTTPClient(ProviderZeroBounce),
		ProviderZeroBounce + "-batch": productionZeroBounceBatchHTTPClient(),
		ProviderKickbox:               productionProviderHTTPClient(ProviderKickbox),
	}
	for provider, client := range clients {
		from, _ := url.Parse("https://api.kickbox.com/v2/balance")
		to, _ := url.Parse("https://api.kickbox.com/v2/other")
		err := client.CheckRedirect(
			&http.Request{URL: to},
			[]*http.Request{{URL: from}},
		)
		if !errors.Is(err, errProviderRedirect) {
			t.Errorf("%s redirect error = %v, want errProviderRedirect", provider, err)
		}
	}
}

func TestProviderClientsUseDocumentedTimeoutCeilings(t *testing.T) {
	if got := productionProviderHTTPClient(ProviderZeroBounce).Timeout; got != DefaultProviderTimeout {
		t.Fatalf("ZeroBounce single timeout=%s, want %s", got, DefaultProviderTimeout)
	}
	if got := productionProviderHTTPClient(ProviderKickbox).Timeout; got != DefaultProviderTimeout {
		t.Fatalf("Kickbox timeout=%s, want %s", got, DefaultProviderTimeout)
	}
	if got := productionZeroBounceBatchHTTPClient().Timeout; got != ZeroBounceBatchHTTPTimeout {
		t.Fatalf("ZeroBounce batch timeout=%s, want %s", got, ZeroBounceBatchHTTPTimeout)
	}
	gotHeader, ok := integration_egress.ConfiguredResponseHeaderTimeout(
		productionZeroBounceBatchHTTPClient(),
	)
	if !ok {
		t.Fatal("ZeroBounce batch client is not backed by a policy-bound secure transport")
	}
	if gotHeader != ZeroBounceBatchResponseHeaderTimeout {
		t.Fatalf("ZeroBounce batch response-header timeout=%s, want %s",
			gotHeader, ZeroBounceBatchResponseHeaderTimeout)
	}
	providerCeiling := time.Duration(zeroBounceBatchProviderTimeoutSeconds) * time.Second
	if gotHeader <= providerCeiling {
		t.Fatalf("ZeroBounce batch response-header timeout=%s must exceed provider ceiling %s",
			gotHeader, providerCeiling)
	}
	if gotHeader >= ZeroBounceBatchHTTPTimeout {
		t.Fatalf("ZeroBounce batch response-header timeout=%s must leave body budget below total %s",
			gotHeader, ZeroBounceBatchHTTPTimeout)
	}
}

func TestZeroBounceSingleEndpointClientFitsHostedRequestBudget(t *testing.T) {
	single := productionProviderHTTPClient(ProviderZeroBounce).Timeout
	batch := productionZeroBounceBatchHTTPClient().Timeout
	if single != 30*time.Second {
		t.Fatalf("ZeroBounce /v2/validate timeout=%s, want 30s", single)
	}
	if single >= 45*time.Second {
		t.Fatalf("ZeroBounce single timeout=%s must remain below hosted browser 45s abort", single)
	}
	if batch <= single {
		t.Fatalf("ZeroBounce batch timeout=%s must remain distinct from single timeout=%s", batch, single)
	}
}

func TestProductionProviderClientRejectsNonAllowlistedLiteralDestinations(t *testing.T) {
	client := productionProviderHTTPClient(ProviderZeroBounce)
	for _, raw := range []string{
		"https://127.0.0.1/v2/getcredits",
		"https://169.254.169.254/latest/meta-data",
		"https://[::1]/v2/getcredits",
		"https://[fe80::1]/v2/getcredits",
		"https://attacker.example/v2/getcredits",
	} {
		req, err := http.NewRequest(http.MethodGet, raw, nil)
		if err != nil {
			t.Fatalf("NewRequest(%q): %v", raw, err)
		}
		if resp, err := client.Do(req); err == nil {
			if resp != nil && resp.Body != nil {
				_ = resp.Body.Close()
			}
			t.Errorf("production provider client accepted %q", raw)
		}
	}
}

func TestProviderErrorsNeverExposeRequestURLsOrUpstreamBodies(t *testing.T) {
	const (
		secret = "tenant-super-secret"
		canary = "upstream-body-canary"
	)

	networkClient := &http.Client{Transport: providerRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("dial failed for %s", req.URL.String())
	})}
	_, err := providerGet(t.Context(), networkClient,
		"https://api.kickbox.com/v2/balance?apikey="+secret)
	if err == nil {
		t.Fatal("expected network error")
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "api.kickbox.com") {
		t.Fatalf("network error exposed credential-bearing URL: %v", err)
	}

	_, err = providerGet(t.Context(), networkClient, "://invalid?apikey="+secret)
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("request-construction error = %v, want ErrProviderUnavailable", err)
	}
	if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "://invalid") {
		t.Fatalf("request-construction error exposed credential-bearing URL: %v", err)
	}

	bodyClient := &http.Client{Transport: providerRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusBadRequest,
			Body:       io.NopCloser(strings.NewReader(canary + " " + secret)),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	})}
	_, err = providerGet(t.Context(), bodyClient,
		"https://api.zerobounce.net/v2/getcredits?api_key="+secret)
	if err == nil {
		t.Fatal("expected 400 error")
	}
	if strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), secret) {
		t.Fatalf("HTTP error exposed upstream body: %v", err)
	}
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("unclassified upstream 4xx error = %v, want ErrProviderUnavailable", err)
	}

	for _, err := range []error{
		zbEnvelopeError([]byte(`{"error":"` + canary + ` api key ` + secret + `"}`)),
		kbMessageError(canary + " unauthorized " + secret),
	} {
		if err == nil {
			t.Fatal("expected sanitized provider envelope error")
		}
		if strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), secret) {
			t.Fatalf("provider envelope exposed upstream body: %v", err)
		}
	}
}

func TestProviderConfigAPIRejectsGlobalRefsAndEndpointOverridesBeforeSideEffects(t *testing.T) {
	secrets := &fakeSecrets{values: map[string]string{}}
	store := &Store{Secrets: secrets}
	router := newHandlerRouter(t, &Deps{Store: store})

	tests := []map[string]any{
		{"credential_ref": "vault://global/verification-key", "enabled": true},
		{
			"credential_ref": "zb-primary",
			"enabled":        true,
			"settings": map[string]any{
				"base_url": "https://user:pass@[::ffff:169.254.169.254]:8443/private",
			},
		},
		{
			"credential_ref": "zb-primary",
			"enabled":        true,
			"settings": map[string]any{
				"bulk_url": "https://bulkapi.zerobounce.net.attacker.example/v2",
			},
		},
	}
	for _, body := range tests {
		rec := doJSON(t, router, verificationTestTenantID, http.MethodPut,
			"/api/v1/verification/providers/zerobounce", body)
		if rec.Code < 400 || rec.Code >= 500 {
			t.Errorf("status = %d, want 4xx; body = %s", rec.Code, rec.Body.String())
		}
	}
	if len(secrets.asked) != 0 {
		t.Fatalf("rejected config reached the secret resolver: %v", secrets.asked)
	}
}
