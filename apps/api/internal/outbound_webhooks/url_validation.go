// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type ipResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

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
	netip.MustParsePrefix("64:ff9b::/96"),   // RFC 6052 NAT64 (can embed private/loopback IPv4)
	netip.MustParsePrefix("64:ff9b:1::/48"), // RFC 8215 local-use NAT64
	netip.MustParsePrefix("2002::/16"),      // 6to4 (embeds an IPv4 that may be private/loopback)
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("3fff::/20"), // documentation prefix; not globally reachable
	netip.MustParsePrefix("5f00::/16"), // segment-routing SIDs; not globally reachable
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fec0::/10"), // deprecated site-local space
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

var internetIPv6Prefix = netip.MustParsePrefix("2000::/3")

// validateURL accepts only http(s) URLs. requireHTTPS enforces TLS in
// prod (set from POSTWAVE_ENV != "dev"). In production it also rejects
// credentials, localhost, and direct private/reserved IP destinations.
func validateURL(raw string, requireHTTPS bool) error {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > 2048 {
		return ErrInvalidURL
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ErrInvalidURL
	}
	lowerRaw := strings.ToLower(raw)
	if strings.Contains(raw, "…") || strings.Contains(lowerRaw, "%e2%80%a6") {
		// API reads deliberately replace capability-bearing path/query values
		// with this glyph. Rejecting it on writes prevents an edit form from
		// accidentally replacing the encrypted destination with its redacted
		// display projection.
		return ErrRedactedDestination
	}
	if u.Host == "" || u.Hostname() == "" || u.User != nil {
		return ErrInvalidURL
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
	case "http":
		if requireHTTPS {
			return ErrInvalidURL
		}
	default:
		return ErrInvalidURL
	}
	if u.Fragment != "" {
		// Fragments are never transmitted in an HTTP request. Accepting one
		// would make the UI show a destination capability that the receiver
		// can never observe and complicate exact endpoint replacement.
		return ErrInvalidURL
	}
	if requireHTTPS && unsafeDestinationHost(u.Hostname()) {
		return ErrInvalidURL
	}
	return nil
}

// ValidateURL applies the canonical outbound-webhook destination policy.
// Other webhook surfaces must call this instead of maintaining weaker URL
// checks of their own. DNS is deliberately re-validated by the transport at
// dial time; this function owns the URL-shape, credential, scheme, and direct
// private/reserved-address checks.
func ValidateURL(raw string, requireHTTPS bool) error {
	return validateURL(raw, requireHTTPS)
}

// RejectWebhookRedirects prevents a receiver from forwarding webhook
// credentials, custom authorization headers, or an mTLS client identity to a
// second origin. Redirect responses are returned to the caller as ordinary
// non-success responses and are never followed.
func RejectWebhookRedirects(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}

// HTTPClientRejectingRedirects returns a shallow copy of base with the
// canonical no-redirect policy. The copy lets each webhook send enforce the
// policy even when a caller supplied its own client.
func HTTPClientRejectingRedirects(base *http.Client) *http.Client {
	if base == nil {
		return NewSecureHTTPClient(nil)
	}
	clone := *base
	clone.CheckRedirect = RejectWebhookRedirects
	if clone.Timeout <= 0 {
		clone.Timeout = 10 * time.Second
	}
	return &clone
}

// NewSecureHTTPClient returns the default delivery client for production
// outbound webhooks. It refuses every redirect and uses a transport that
// resolves and dials approved IPs directly, which closes DNS-rebinding and
// cross-origin credential-forwarding gaps.
func NewSecureHTTPClient(transport http.RoundTripper) *http.Client {
	if transport == nil {
		transport = NewSecureTransport()
	}
	return &http.Client{
		Timeout:       10 * time.Second,
		Transport:     transport,
		CheckRedirect: RejectWebhookRedirects,
	}
}

// NewSecureTransport returns a transport that does not use process proxy
// settings and refuses localhost/private/reserved destination IPs after DNS
// resolution. Callers may wrap it with tracing transports.
func NewSecureTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           secureDialContext(net.DefaultResolver),
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

func unsafeDestinationHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return blockedDestinationIP(addr)
	}
	return false
}

func blockedDestinationIP(addr netip.Addr) bool {
	// Zone identifiers are meaningful only on the local host. A scoped address
	// must never be treated as an internet webhook destination, even if a
	// platform parser accepts it.
	if addr.Zone() != "" {
		return true
	}
	if addr.Is4In6() {
		addr = netip.AddrFrom4(addr.As4())
	}
	// Current public Internet IPv6 unicast space is allocated from 2000::/3.
	// Treat every other IPv6 family as non-dialable by default; this keeps
	// deprecated site-local, ULA, link-local, multicast, translation, and
	// special-purpose ranges fail-closed even when a new one is absent from the
	// explicit documentation list below. Future public allocations require a
	// deliberate policy update rather than silently expanding the SSRF surface.
	if addr.Is6() && !internetIPv6Prefix.Contains(addr) {
		return true
	}
	for _, prefix := range blockedDestinationPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
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
			return nil, errors.New("webhook destination must not target localhost")
		}

		var candidates []netip.Addr
		if addr, err := netip.ParseAddr(host); err == nil {
			candidates = append(candidates, addr)
		} else {
			addrs, err := resolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("resolve destination: %w", err)
			}
			if len(addrs) == 0 {
				return nil, errors.New("destination resolved to no addresses")
			}
			for _, ip := range addrs {
				if ip.Zone != "" {
					return nil, fmt.Errorf("destination resolved to a scoped address: %s%%%s", ip.IP, ip.Zone)
				}
				addr, err := netip.ParseAddr(ip.IP.String())
				if err != nil {
					return nil, fmt.Errorf("parse resolved destination: %w", err)
				}
				candidates = append(candidates, addr)
			}
		}

		for _, addr := range candidates {
			if blockedDestinationIP(addr) {
				return nil, fmt.Errorf("destination resolved to a private or reserved address: %s", addr)
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
		return nil, errors.New("destination resolved to no dialable addresses")
	}
}
