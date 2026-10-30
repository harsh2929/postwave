// SPDX-License-Identifier: AGPL-3.0-only
package integration_egress

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProviderPoliciesRejectSSRFAndArbitraryOverrides(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		family   string
		provider string
		settings map[string]any
	}{
		{
			name:     "Adobe Commerce metadata IP",
			family:   FamilyCommerce,
			provider: "adobe-commerce",
			settings: map[string]any{"base_url": "https://169.254.169.254/latest/meta-data"},
		},
		{
			name:     "Zendesk lookalike domain",
			family:   FamilySupport,
			provider: "zendesk",
			settings: map[string]any{"api_base_url": "https://customer.zendesk.com.attacker.example"},
		},
		{
			name:     "Klaviyo undeclared credential endpoint",
			family:   FamilyMarketing,
			provider: "klaviyo",
			settings: map[string]any{"oauth_base_url": "https://attacker.example"},
		},
		{
			name:     "Salesforce non Salesforce instance",
			family:   FamilyCRM,
			provider: "salesforce",
			settings: map[string]any{"instance_url": "https://attacker.example"},
		},
		{
			name:     "PostHog loopback self hosted instance",
			family:   FamilyAnalytics,
			provider: "posthog",
			settings: map[string]any{"host": "127.0.0.1"},
		},
	}
	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if err := ValidateSettings(tt.family, tt.provider, tt.settings); err == nil {
				t.Fatal("expected settings to be rejected")
			}
		})
	}
}

func TestProviderPoliciesAcceptDeclaredProviderDestinations(t *testing.T) {
	t.Parallel()

	tests := []struct {
		family   string
		provider string
		settings map[string]any
	}{
		{FamilyCommerce, "adobe-commerce", map[string]any{"base_url": "https://shop.example.com", "api_base_url": "https://commerce-api.example.com"}},
		{FamilySupport, "zendesk", map[string]any{"subdomain": "brand.zendesk.com", "api_base_url": "https://brand.zendesk.com/api/v2"}},
		{FamilyReviews, "judge-me", map[string]any{"shop_domain": "brand.myshopify.com"}},
		{FamilyAnalytics, "posthog", map[string]any{"host": "https://analytics.example.com", "api_base_url": "https://analytics.example.com"}},
		{FamilyCRM, "salesforce", map[string]any{"instance_url": "https://acme.my.salesforce.com"}},
		{FamilySubscription, "shippo", map[string]any{"store_domain": "shop.example.com"}},
		{FamilySubscription, "bold-subscriptions", map[string]any{"store_domain": "shop.example.com", "api_base_url": "https://api.boldcommerce.com"}},
	}
	for _, tt := range tests {
		if err := ValidateSettings(tt.family, tt.provider, tt.settings); err != nil {
			t.Errorf("ValidateSettings(%s/%s): %v", tt.family, tt.provider, err)
		}
	}
}

func TestRegionalRuntimeEndpointsStayAllowlisted(t *testing.T) {
	t.Parallel()

	tests := []struct {
		family   string
		provider string
		url      string
	}{
		{FamilyAnalytics, "mixpanel", "https://in.mixpanel.com/api/2.0/export"},
		{FamilyCRM, "zoho-crm", "https://www.zohoapis.eu/crm/v6/Contacts"},
		{FamilyCRM, "zoho-crm", "https://www.zohoapis.com.cn/crm/v6/Contacts"},
		{FamilyCRM, "zoho-crm", "https://accounts.zohocloud.ca/oauth/v2/token"},
	}
	for _, tt := range tests {
		if err := ValidateURL(tt.family, tt.provider, tt.url); err != nil {
			t.Errorf("ValidateURL(%s/%s, %q): %v", tt.family, tt.provider, tt.url, err)
		}
	}
}

func TestClientBlocksCrossOriginRedirectBeforeCredentialsLeak(t *testing.T) {
	t.Parallel()

	client := NewClient(FamilyCommerce, "square", time.Second)
	transport := client.Transport.(*policyTransport)
	var requests []*http.Request
	transport.next = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		requests = append(requests, req.Clone(req.Context()))
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": []string{"https://connect.squareupsandbox.com/v2/customers"}},
			Body:       io.NopCloser(strings.NewReader("redirect")),
			Request:    req,
		}, nil
	})
	req, err := http.NewRequest(http.MethodGet, "https://connect.squareup.com/v2/customers", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("X-Api-Key", "also-secret")
	resp, err := client.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if !errors.Is(err, ErrCrossOrigin) {
		t.Fatalf("expected ErrCrossOrigin, got %v", err)
	}
	if len(requests) != 1 {
		t.Fatalf("credentials reached redirect target: got %d requests", len(requests))
	}
}

func TestCredentialPayloadURLCannotEscapeProviderAllowlist(t *testing.T) {
	t.Parallel()

	client := NewClient(FamilyReviews, "yotpo", time.Second)
	transport := client.Transport.(*policyTransport)
	called := false
	transport.next = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("unexpected request")
	})
	req, err := http.NewRequest(http.MethodGet, "https://credentials.example/api/reviews", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer tenant-secret")
	resp, err := client.Do(req)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err == nil || !strings.Contains(err.Error(), "provider allowlist") {
		t.Fatalf("expected provider allowlist rejection, got %v", err)
	}
	if called {
		t.Fatal("credential-bearing request reached the underlying transport")
	}
}

func TestClientBoundsChunkedResponses(t *testing.T) {
	t.Parallel()

	client := NewClient(FamilyReviews, "yotpo", time.Second)
	transport := client.Transport.(*policyTransport)
	transport.maxResponseBytes = 4
	transport.next = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode:    http.StatusOK,
			ContentLength: -1,
			Header:        make(http.Header),
			Body:          io.NopCloser(strings.NewReader("12345")),
			Request:       req,
		}, nil
	})
	resp, err := client.Get("https://api.yotpo.com/v1/reviews")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, err = io.ReadAll(resp.Body)
	if !errors.Is(err, ErrResponseTooLarge) {
		t.Fatalf("expected ErrResponseTooLarge, got %v", err)
	}
}

func TestSecureDialRejectsPrivateDNSAnswer(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{
		"10.0.0.8",
		"169.254.169.254",
		"fc00::8",
		"fe80::8",
		"::ffff:169.254.169.254",
	} {
		dial := secureDialContext(staticResolver{addrs: []net.IPAddr{{IP: net.ParseIP(raw)}}})
		conn, err := dial(context.Background(), "tcp", "api.yotpo.com:443")
		if conn != nil {
			_ = conn.Close()
		}
		if err == nil || !strings.Contains(err.Error(), "private or reserved") {
			t.Errorf("expected private DNS answer %s to be rejected, got %v", raw, err)
		}
	}
}

func TestSecureTransportDoesNotUseEnvironmentProxy(t *testing.T) {
	t.Parallel()

	transport := newSecureTransport(staticResolver{})
	if transport.Proxy != nil {
		t.Fatal("secure transport must not consult environment proxy settings")
	}
}

func TestResponseHeaderTimeoutOverrideIsNarrowAndEffective(t *testing.T) {
	t.Parallel()

	ordinary := NewClient(FamilyReviews, "yotpo", time.Second)
	if got, ok := ConfiguredResponseHeaderTimeout(ordinary); !ok || got != defaultResponseHeaderTimeout {
		t.Fatalf("ordinary response-header timeout = %s, %v; want %s, true",
			got, ok, defaultResponseHeaderTimeout)
	}

	const (
		shortBudget = 20 * time.Millisecond
		longBudget  = 200 * time.Millisecond
		headerDelay = 60 * time.Millisecond
	)
	overridden := NewClientWithResponseHeaderTimeout(
		FamilyReviews,
		"yotpo",
		time.Second,
		longBudget,
	)
	if got, ok := ConfiguredResponseHeaderTimeout(overridden); !ok || got != longBudget {
		t.Fatalf("overridden response-header timeout = %s, %v; want %s, true",
			got, ok, longBudget)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(headerDelay)
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)

	shortClient := &http.Client{
		Timeout:   time.Second,
		Transport: newSecureTransportWithResponseHeaderTimeout(net.DefaultResolver, shortBudget),
	}
	if resp, err := shortClient.Get(srv.URL); err == nil {
		_ = resp.Body.Close()
		t.Fatal("request unexpectedly survived the shorter response-header budget")
	}

	longClient := &http.Client{
		Timeout:   time.Second,
		Transport: newSecureTransportWithResponseHeaderTimeout(net.DefaultResolver, longBudget),
	}
	resp, err := longClient.Get(srv.URL)
	if err != nil {
		t.Fatalf("request with provider-specific response-header budget: %v", err)
	}
	_ = resp.Body.Close()
}

func TestProductionEnforcementReplacesRawOrMismatchedClients(t *testing.T) {
	t.Parallel()

	raw := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("raw transport must not run")
	})}
	got := enforceClient(raw, FamilyReviews, "yotpo", time.Second, false)
	if got == raw {
		t.Fatal("production enforcement preserved an arbitrary injected client")
	}
	transport, ok := got.Transport.(*policyTransport)
	if !ok || transport.family != FamilyReviews || transport.provider != "yotpo" {
		t.Fatalf("production enforcement returned an unbound transport: %#v", got.Transport)
	}

	mismatched := NewClient(FamilyCommerce, "stripe", time.Second)
	got = enforceClient(mismatched, FamilyReviews, "yotpo", time.Second, false)
	if got == mismatched {
		t.Fatal("production enforcement preserved a client bound to another provider")
	}

	bound := NewClient(FamilyReviews, "yotpo", time.Second)
	if got := enforceClient(bound, FamilyReviews, "yotpo", time.Second, false); got != bound {
		t.Fatal("production enforcement replaced an already matching provider-bound client")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

type staticResolver struct {
	addrs []net.IPAddr
	err   error
}

func (r staticResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return r.addrs, r.err
}
