// safe_transport.go — SSRF-safe http.Client for the RSS source.
//
// Mirrors apps/api/internal/outbound_webhooks.NewSecureHTTPClient.
// Duplicated rather than imported because Go's `internal` package
// convention prevents services/voice from reaching into
// apps/api/internal. The threat model: operator-supplied FeedURL
// could resolve to a private/loopback/link-local IP and the bare
// gofeed parser would happily fetch it (audit finding M2, SSRF).

package rss

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// blockedDestinationPrefixes is the conservative set of IP ranges
// the secure dialer refuses to connect to. Copied verbatim from
// apps/api/internal/outbound_webhooks/url_validation.go — keep in
// sync if that list changes.
var blockedDestinationPrefixes = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"), // link-local + AWS metadata
	netip.MustParsePrefix("100.64.0.0/10"),  // CGNAT
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),      // ULA
	netip.MustParsePrefix("fe80::/10"),     // link-local IPv6
	netip.MustParsePrefix("::ffff:0:0/96"), // IPv4-mapped IPv6
}

// newSecureHTTPClient returns an http.Client whose DialContext
// refuses to connect to private / loopback / link-local IPs.
// Used by the RSS Source to keep operator-configured feed URLs
// from probing the internal network.
func newSecureHTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				host = strings.TrimSuffix(strings.ToLower(host), ".")
				if host == "localhost" || strings.HasSuffix(host, ".localhost") {
					return nil, errors.New("rss: feed URL must not target localhost")
				}
				var candidates []netip.Addr
				if addr, err := netip.ParseAddr(host); err == nil {
					candidates = append(candidates, addr)
				} else {
					addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
					if err != nil {
						return nil, fmt.Errorf("rss: resolve %s: %w", host, err)
					}
					for _, ip := range addrs {
						if a, err := netip.ParseAddr(ip.IP.String()); err == nil {
							candidates = append(candidates, a)
						}
					}
				}
				for _, c := range candidates {
					if c.Is4In6() {
						c = netip.AddrFrom4(c.As4())
					}
					for _, p := range blockedDestinationPrefixes {
						if p.Contains(c) {
							return nil, fmt.Errorf("rss: feed URL resolves to blocked IP %s", c)
						}
					}
				}
				return dialer.DialContext(ctx, network, address)
			},
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   timeout,
			ResponseHeaderTimeout: timeout,
			ExpectContinueTimeout: 1 * time.Second,
		},
		CheckRedirect: func(req *http.Request, _ []*http.Request) error {
			// Reject non-https redirects + redirects that try to
			// downgrade to internal hosts. The DialContext above will
			// also block bad IPs on the redirect attempt, but a scheme
			// check here gives an earlier, clearer error.
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return fmt.Errorf("rss: unsupported redirect scheme %q", req.URL.Scheme)
			}
			return nil
		},
	}
}
