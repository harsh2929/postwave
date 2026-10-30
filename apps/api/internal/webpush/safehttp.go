// SPDX-License-Identifier: AGPL-3.0-only
//
// safehttp.go — SSRF defenses for the outbound push delivery. Two layers:
//   1. an allowlist of known push-service hosts (Subscribe rejects anything
//      else, so an attacker can't register an internal endpoint at all), and
//   2. a connect-time dialer that refuses private/loopback/link-local/CGNAT
//      addresses and dials the validated IP directly (so a public hostname
//      that DNS-rebinds to an internal IP still can't smuggle through).

package webpush

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// pushHostSuffixes is the set of hosts browser push services use. A leading "."
// matches that host and any subdomain; an entry without a dot matches exactly.
var pushHostSuffixes = []string{
	"fcm.googleapis.com",                // Chrome / Android (FCM)
	".googleapis.com",                   // FCM variants
	"updates.push.services.mozilla.com", // Firefox
	".push.services.mozilla.com",        // Firefox autopush nodes
	".notify.windows.com",               // Edge / WNS
	".push.apple.com",                   // Safari Web Push (APNs)
	".web.push.apple.com",               //
}

// allowedPushHost reports whether endpoint is an https URL whose host belongs
// to a known push service (no userinfo, no odd schemes).
func allowedPushHost(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, suf := range pushHostSuffixes {
		if strings.HasPrefix(suf, ".") {
			if host == suf[1:] || strings.HasSuffix(host, suf) {
				return true
			}
		} else if host == suf {
			return true
		}
	}
	return false
}

// safePushClient is the SSRF-guarded client used for all push delivery. Built
// once: it refuses non-public destinations at connect time and never follows
// redirects.
var safePushClient = newSafePushClient()

func newSafePushClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			// Dial the validated IP directly so a second resolution can't
			// swap in a private address after the check (DNS rebinding).
			for _, ip := range ips {
				if isPublicIP(ip.IP) {
					return dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
				}
			}
			return nil, fmt.Errorf("webpush: refusing to dial non-public host %q", host)
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConns:          20,
	}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: transport,
		// Never follow redirects on push delivery.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// isPublicIP reports whether ip is globally routable unicast — NOT loopback,
// link-local, private (RFC1918 / ULA), unspecified, multicast, or CGNAT
// (100.64/10).
func isPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
		ip.IsPrivate() {
		return false
	}
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return false
	}
	return true
}
