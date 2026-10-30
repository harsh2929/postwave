package webhooks

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
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func validateWebhookDestination(ctx context.Context, raw string) (*url.URL, error) {
	return validateWebhookDestinationWithResolver(ctx, raw, net.DefaultResolver)
}

func validateWebhookDestinationWithResolver(ctx context.Context, raw string, resolver ipResolver) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("URL is required")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return nil, errors.New("URL must use https")
	}
	if parsed.User != nil {
		return nil, errors.New("URL must not contain credentials")
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "" {
		return nil, errors.New("URL host is required")
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return nil, errors.New("URL must not target localhost")
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		if blockedDestinationIP(addr) {
			return nil, fmt.Errorf("URL resolves to a private or reserved address: %s", addr)
		}
		return parsed, nil
	}

	lookupCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	addrs, err := resolver.LookupIPAddr(lookupCtx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve host: %w", err)
	}
	if len(addrs) == 0 {
		return nil, errors.New("host resolved to no addresses")
	}
	for _, ip := range addrs {
		addr, err := netip.ParseAddr(ip.IP.String())
		if err != nil {
			return nil, fmt.Errorf("parse resolved address: %w", err)
		}
		if blockedDestinationIP(addr) {
			return nil, fmt.Errorf("URL resolves to a private or reserved address: %s", addr)
		}
	}
	return parsed, nil
}

func blockedDestinationIP(addr netip.Addr) bool {
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

func newSecureWebhookClient() *http.Client {
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           secureDialContext(net.DefaultResolver),
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if _, err := validateWebhookDestination(req.Context(), req.URL.String()); err != nil {
				return err
			}
			return nil
		},
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
