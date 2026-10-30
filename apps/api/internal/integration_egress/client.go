// SPDX-License-Identifier: AGPL-3.0-only
package integration_egress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type ipResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

const defaultResponseHeaderTimeout = 15 * time.Second

var blockedDestinationPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

// NewClient creates the only production HTTP client integration adapters
// should use. It combines provider host allowlisting, proxy bypass, DNS and
// dial-time IP checks, same-origin redirects, a total timeout, and a bounded
// response body.
func NewClient(family, provider string, timeout time.Duration) *http.Client {
	return NewClientWithResponseHeaderTimeout(family, provider, timeout, defaultResponseHeaderTimeout)
}

// NewClientWithResponseHeaderTimeout creates a policy-bound client with an
// integration-specific response-header budget. Most integrations should use
// NewClient and its conservative default; this seam exists for documented
// provider operations whose server-side processing window is longer than that
// default. All destination, redirect, DNS, proxy, and body-size policy remains
// identical to NewClient.
func NewClientWithResponseHeaderTimeout(
	family, provider string,
	timeout, responseHeaderTimeout time.Duration,
) *http.Client {
	policy, ok := lookupPolicy(family, provider)
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if responseHeaderTimeout <= 0 {
		responseHeaderTimeout = defaultResponseHeaderTimeout
	}
	maxBytes := policy.maxResponseBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxResponseBytes
	}
	transport := &policyTransport{
		family:           strings.ToLower(strings.TrimSpace(family)),
		provider:         strings.ToLower(strings.TrimSpace(provider)),
		policyExists:     ok,
		maxResponseBytes: maxBytes,
		next:             newSecureTransportWithResponseHeaderTimeout(net.DefaultResolver, responseHeaderTimeout),
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if err := transport.validateURL(req.URL.String()); err != nil {
				return err
			}
			if len(via) > 0 && !sameOrigin(via[0].URL, req.URL) {
				return ErrCrossOrigin
			}
			return nil
		},
	}
}

// ConfiguredResponseHeaderTimeout reports the response-header budget on a
// policy-bound client. It is intentionally read-only and is used by diagnostics
// and regression tests to prove that long-running provider operations were
// composed with the deadline they require.
func ConfiguredResponseHeaderTimeout(client *http.Client) (time.Duration, bool) {
	if client == nil {
		return 0, false
	}
	policy, ok := client.Transport.(*policyTransport)
	if !ok {
		return 0, false
	}
	transport, ok := policy.next.(*http.Transport)
	if !ok {
		return 0, false
	}
	return transport.ResponseHeaderTimeout, true
}

// EnforceClient returns an already policy-bound client when it matches the
// requested provider. Tests may inject an httptest client; production callers
// cannot replace the no-proxy, DNS-safe transport with an arbitrary client.
func EnforceClient(client *http.Client, family, provider string, timeout time.Duration) *http.Client {
	return enforceClient(client, family, provider, timeout, runningUnderGoTest())
}

func enforceClient(client *http.Client, family, provider string, timeout time.Duration, allowTestInjection bool) *http.Client {
	family = strings.ToLower(strings.TrimSpace(family))
	provider = strings.ToLower(strings.TrimSpace(provider))
	if client != nil {
		if transport, ok := client.Transport.(*policyTransport); ok &&
			transport.family == family && transport.provider == provider {
			return client
		}
		if allowTestInjection {
			return client
		}
	}
	return NewClient(family, provider, timeout)
}

type policyTransport struct {
	family           string
	provider         string
	policyExists     bool
	maxResponseBytes int64
	next             http.RoundTripper
}

func (t *policyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, ErrDestination
	}
	if err := t.validateURL(req.URL.String()); err != nil {
		return nil, err
	}
	resp, err := t.next.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if resp == nil || resp.Body == nil {
		return resp, nil
	}
	if resp.ContentLength > t.maxResponseBytes {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("%w: content length %d > %d", ErrResponseTooLarge, resp.ContentLength, t.maxResponseBytes)
	}
	resp.Body = &boundedReadCloser{body: resp.Body, remaining: t.maxResponseBytes}
	return resp, nil
}

func (t *policyTransport) validateURL(raw string) error {
	if !t.policyExists {
		return fmt.Errorf("%w: %s/%s", ErrUnknownProvider, t.family, t.provider)
	}
	return ValidateURL(t.family, t.provider, raw)
}

type boundedReadCloser struct {
	body      io.ReadCloser
	remaining int64
	overflow  bool
}

func (r *boundedReadCloser) Read(p []byte) (int, error) {
	if r.overflow {
		return 0, ErrResponseTooLarge
	}
	if r.remaining == 0 {
		var probe [1]byte
		n, err := r.body.Read(probe[:])
		if n > 0 {
			r.overflow = true
			return 0, ErrResponseTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.body.Read(p)
	r.remaining -= int64(n)
	return n, err
}

func (r *boundedReadCloser) Close() error { return r.body.Close() }

func newSecureTransport(resolver ipResolver) *http.Transport {
	return newSecureTransportWithResponseHeaderTimeout(resolver, defaultResponseHeaderTimeout)
}

func newSecureTransportWithResponseHeaderTimeout(
	resolver ipResolver,
	responseHeaderTimeout time.Duration,
) *http.Transport {
	if responseHeaderTimeout <= 0 {
		responseHeaderTimeout = defaultResponseHeaderTimeout
	}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           secureDialContext(resolver),
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: responseHeaderTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
}

func secureDialContext(resolver ipResolver) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		host = strings.TrimSuffix(strings.ToLower(host), ".")
		if host == "localhost" || strings.HasSuffix(host, ".localhost") {
			return nil, errors.New("integration destination must not target localhost")
		}

		var candidates []netip.Addr
		if addr, err := netip.ParseAddr(host); err == nil {
			candidates = append(candidates, addr)
		} else {
			addrs, err := resolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("resolve integration destination: %w", err)
			}
			if len(addrs) == 0 {
				return nil, errors.New("integration destination resolved to no addresses")
			}
			for _, ip := range addrs {
				addr, err := netip.ParseAddr(ip.IP.String())
				if err != nil {
					return nil, fmt.Errorf("parse resolved integration destination: %w", err)
				}
				candidates = append(candidates, addr)
			}
		}

		for _, addr := range candidates {
			if blockedIP(addr) && !(runningUnderGoTest() && addr.IsLoopback()) {
				return nil, fmt.Errorf("integration destination resolved to a private or reserved address: %s", addr)
			}
		}

		var lastErr error
		for _, addr := range candidates {
			if addr.Is4In6() {
				addr = netip.AddrFrom4(addr.As4())
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		if lastErr != nil {
			return nil, lastErr
		}
		return nil, errors.New("integration destination resolved to no dialable addresses")
	}
}

func blockedIP(addr netip.Addr) bool {
	if addr.Is4In6() {
		addr = netip.AddrFrom4(addr.As4())
	}
	for _, prefix := range blockedDestinationPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func sameOrigin(a, b *url.URL) bool {
	if a == nil || b == nil {
		return false
	}
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(canonicalAuthority(a), canonicalAuthority(b))
}

func canonicalAuthority(u *url.URL) string {
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	port := u.Port()
	if port == "" {
		switch strings.ToLower(u.Scheme) {
		case "https":
			port = "443"
		case "http":
			port = "80"
		}
	}
	return net.JoinHostPort(host, port)
}
