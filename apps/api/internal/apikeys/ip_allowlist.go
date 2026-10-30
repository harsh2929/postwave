// SPDX-License-Identifier: AGPL-3.0-only

package apikeys

import (
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// parseAllowlistEntry validates a single allowlist string. Accepts:
//
//   - CIDR ("203.0.113.0/24")
//   - bare IPv4 / IPv6 ("203.0.113.5", "::1")
//
// Returns the parsed IP + the network it came from (which equals
// "<ip>/32" or "<ip>/128" for bare addresses). The handler uses the
// returned values only for shape checking — Postgres normalises
// storage on its own.
func parseAllowlistEntry(s string) (net.IP, *net.IPNet, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil, errors.New("empty entry")
	}
	if ip, ipnet, err := net.ParseCIDR(s); err == nil {
		return ip, ipnet, nil
	}
	if ip := net.ParseIP(s); ip != nil {
		var mask net.IPMask
		if ip.To4() != nil {
			mask = net.CIDRMask(32, 32)
		} else {
			mask = net.CIDRMask(128, 128)
		}
		return ip, &net.IPNet{IP: ip, Mask: mask}, nil
	}
	return nil, nil, errors.New("not a valid IP or CIDR")
}

// ipAllowed reports whether the request IP falls inside any entry of
// the per-key allowlist.
//
//   - empty/nil allowlist → true (no restriction; default behaviour
//     for keys minted before 0046 + new keys created without an
//     allowlist).
//   - empty/invalid request IP with a non-empty allowlist → false
//     (fail closed; we can't make a security decision without
//     knowing where the request is from).
//   - any allowlist entry containing the IP → true.
//
// CIDRs in the allowlist are pre-validated by Postgres at INSERT time
// (the inet[] column rejects malformed values), so parsing here can't
// fail for stored entries — but we still guard against it for safety.
func ipAllowed(allowlist []string, requestIP string) bool {
	if len(allowlist) == 0 {
		return true
	}
	if requestIP == "" {
		return false
	}
	ip := net.ParseIP(requestIP)
	if ip == nil {
		return false
	}
	for _, entry := range allowlist {
		// Postgres returns single-host inets as `1.2.3.4/32`. Both
		// `net.ParseCIDR` and `net.ParseIP` see something there;
		// try CIDR first since the round-trip preserves the slash.
		if _, ipnet, err := net.ParseCIDR(entry); err == nil {
			if ipnet.Contains(ip) {
				return true
			}
			continue
		}
		// Fallback: bare IP equality. This path catches malformed
		// stored entries that snuck through (defence in depth) and
		// the future case where the column stores raw text.
		if other := net.ParseIP(entry); other != nil && other.Equal(ip) {
			return true
		}
	}
	return false
}

// requestIP extracts the client IP from the request. Honours the
// configured forwarded-IP header chain — same precedence as the
// per-IP rate limiter (apps/api/internal/middleware/ratelimit.go) —
// because a deployment running behind a load balancer needs to see
// the real client IP, not the LB's IP.
//
// X-Forwarded-For takes the LEFT-MOST value; X-Real-IP wins next.
// If neither is set we fall back to RemoteAddr's host portion.
//
// We do NOT validate the trust chain here. That's the deployer's
// responsibility (set TrustForwardedIPHeaders=false if you don't
// trust the upstream proxy and want to reject forwarded headers
// outright). Stripe and GitHub both make the same choice; the
// alternative — every middleware re-doing trust evaluation — leads
// to inconsistent enforcement.
func requestIP(r *http.Request, trustForwarded bool) string {
	return middleware.ResolveClientIPString(r, trustForwarded)
}
