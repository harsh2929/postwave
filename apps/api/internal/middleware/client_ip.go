// SPDX-License-Identifier: AGPL-3.0-only
//
// client_ip.go — single source of truth for resolving the client IP
// of an incoming HTTP request.
//
// Background. The codebase historically grew six near-duplicate
// resolvers (clientIPHeader, resolveClientIP, clientIPForAuth,
// bestEffortClientIP, requestIP, plus the splitHostPortLoose chain in
// auth/handlers.go's clearBruteforceBucket). They all answered the
// same question — "where did this request originate?" — with subtly
// different rules: some trusted X-Forwarded-For unconditionally, some
// took the leftmost XFF entry, some only honoured XFF when an opt-in
// flag was set, some forgot to strip the port from RemoteAddr in the
// IPv6 case. The discrepancies were a security finding: the public
// rate-limiter and the per-key allowlist could disagree on which IP
// they were rate-limiting / allowing, producing both bypass and
// false-block patterns.
//
// This file replaces all six. Public callers go through one of:
//
//   middleware.ResolveClientIP(r, trustHeaders)        → net.IP
//   middleware.ResolveClientIPString(r, trustHeaders)  → string
//
// Trust model.
//
//   trustHeaders=false (default for direct-to-internet listeners):
//     RemoteAddr only. X-Forwarded-For / X-Real-IP are ignored —
//     they're attacker-controlled.
//
//   trustHeaders=true (deployment is behind one or more explicitly
//   configured reverse proxies the operator controls):
//     We walk X-Forwarded-For from the RIGHT-most entry inward,
//     skipping entries that fall inside the configured trusted-proxy
//     CIDR set (see SetTrustedProxyCIDRs). Forwarded headers are ignored
//     unless the untouched TCP peer itself is in that set. The first non-trusted
//     entry is the original client; if every entry is a trusted
//     proxy, the leftmost is returned. When XFF is absent we fall
//     back to X-Real-IP and finally to the RemoteAddr host.
//
// Why rightmost-walk: the leftmost-trust pattern (the previous
// majority in this codebase) is forgeable — a client can prepend any
// XFF value before its request reaches your proxy. The proxy appends
// the real client IP to the right of whatever the client sent, so
// the rightmost entry that ISN'T a known proxy is the trustworthy
// origin. This matches the modern de-facto pattern: Cloudflare's
// CF-Connecting-IP, AWS ALB's X-Forwarded-For ordering, and the
// behaviour of chi-middleware's RealIP when given a trusted CIDR
// allowlist.
//
// The trusted-proxy CIDR set is process-global, configured once at startup via
// SetTrustedProxyCIDRs. An empty set never trusts forwarded headers. This is an
// intentional fail-closed default: a boolean alone cannot authenticate a proxy.

package middleware

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
)

// trustedProxies is the process-global set of CIDRs identifying
// reverse-proxy hops in front of this API. Set once at startup; reads
// are atomic-snapshot so the resolver never sees a half-written slice.
var trustedProxies atomic.Pointer[[]*net.IPNet]

// SetTrustedProxyCIDRs registers the trusted reverse-proxy CIDR set
// for the process. Pass the list of CIDRs that correspond to your
// load balancers, CDN egress ranges, and any other infrastructure that appends
// X-Forwarded-For entries. Invalid entries reject the entire configuration so
// a typo cannot silently turn a security boundary into a spoofable header.
// Pass nil/empty to clear.
func SetTrustedProxyCIDRs(cidrs []string) error {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		// Allow bare IPs as a convenience — they become /32 or /128.
		if !strings.Contains(c, "/") {
			if ip := net.ParseIP(c); ip != nil {
				if ip.To4() != nil {
					c += "/32"
				} else {
					c += "/128"
				}
			} else {
				return fmt.Errorf("invalid trusted proxy address %q", c)
			}
		}
		_, ipnet, err := net.ParseCIDR(c)
		if err != nil || ipnet == nil {
			return fmt.Errorf("invalid trusted proxy CIDR %q", c)
		}
		ones, _ := ipnet.Mask.Size()
		if ones == 0 {
			return fmt.Errorf("trusted proxy CIDR %q covers the entire address space", c)
		}
		out = append(out, ipnet)
	}
	trustedProxies.Store(&out)
	return nil
}

// TrustedProxyCIDRsConfigured reports whether at least one proxy network is
// configured. Startup validation uses it to reject a trust-headers flag that
// has no authenticated peer boundary.
func TrustedProxyCIDRsConfigured() bool { return len(loadTrustedProxies()) > 0 }

// loadTrustedProxies returns the current trusted-proxy CIDR set, or
// an empty slice when none configured.
func loadTrustedProxies() []*net.IPNet {
	p := trustedProxies.Load()
	if p == nil {
		return nil
	}
	return *p
}

// isTrustedProxy reports whether the given IP falls inside any
// configured trusted-proxy CIDR.
func isTrustedProxy(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, n := range loadTrustedProxies() {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ResolveClientIP returns the parsed client IP for the request. See
// the package-file header for the full trust model. Returns nil when
// no resolvable IP is found — callers must handle that as "unknown
// origin" and fail closed for security decisions.
func ResolveClientIP(r *http.Request, trustHeaders bool) net.IP {
	if r == nil {
		return nil
	}
	peer := parseIPLoose(stripPort(r.RemoteAddr))
	// Forwarded headers are meaningful only when the network peer that supplied
	// them is explicitly trusted. This check must happen before any middleware
	// mutates RemoteAddr (the gateway no longer mounts chi.RealIP).
	if trustHeaders && len(loadTrustedProxies()) > 0 && isTrustedProxy(peer) {
		// 1. X-Forwarded-For, walked rightmost-first.
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			// Walk from right (most-recent proxy hop) toward left
			// (the original client → forged headers prepended by the
			// client). Skip entries inside the trusted-proxy set; the
			// first non-trusted entry is the real origin.
			for i := len(parts) - 1; i >= 0; i-- {
				cand := parseIPLoose(parts[i])
				if cand == nil {
					// A malformed hop makes the chain ambiguous. Ignore the chain
					// instead of walking farther left into attacker-controlled data.
					return peer
				}
				if !isTrustedProxy(cand) {
					return cand
				}
			}
			// Every advertised hop was a proxy. The original client is not
			// represented, so use the authenticated TCP peer rather than a
			// caller-controlled leftmost value.
			return peer
		}
		// 2. X-Real-IP — single-value header set by some proxies
		// (nginx default). Trusted only when trustHeaders=true.
		if xri := r.Header.Get("X-Real-IP"); xri != "" {
			if ip := parseIPLoose(xri); ip != nil {
				return ip
			}
		}
	}
	// RemoteAddr is always the final fallback: it is the TCP peer address.
	return peer
}

// ResolveClientIPString returns the canonical string form of the
// resolved IP (net.IP.String) or "" when unresolvable. Most callers
// hash or string-compare; this saves an allocation per site.
func ResolveClientIPString(r *http.Request, trustHeaders bool) string {
	ip := ResolveClientIP(r, trustHeaders)
	if ip == nil {
		return ""
	}
	return ip.String()
}

// parseIPLoose trims whitespace and parses an IP, returning nil for
// anything that doesn't parse. Accepts bracketed IPv6 ("[::1]") that
// occasionally appears in mis-configured upstream headers.
func parseIPLoose(s string) net.IP {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// Strip optional zone suffix ("fe80::1%eth0") — net.ParseIP
	// rejects them otherwise.
	if i := strings.IndexByte(s, '%'); i >= 0 {
		s = s[:i]
	}
	// Strip bracketed IPv6 wrapping.
	if len(s) >= 2 && s[0] == '[' && s[len(s)-1] == ']' {
		s = s[1 : len(s)-1]
	}
	return net.ParseIP(s)
}

// stripPort returns the host portion of an "ip:port" or
// "[ipv6]:port" RemoteAddr value. Returns the input unchanged when
// no port is present (some test frameworks pass a bare IP).
func stripPort(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	// Bracket form without port, or bare IP.
	if len(addr) >= 2 && addr[0] == '[' && addr[len(addr)-1] == ']' {
		return addr[1 : len(addr)-1]
	}
	return addr
}

// AdminAllowlistMountError is returned by ValidateAdminAllowlistMount
// when the deployment posture would make per-tenant admin IP
// allowlists trivially bypassable. Callers (main.go) should treat
// this as a startup error — refuse to mount the AdminIPAllowlist
// middleware, log the misconfiguration, and either fail-fast or skip
// the allowlist gate per the operator's policy.
type AdminAllowlistMountError struct{ Reason string }

func (e *AdminAllowlistMountError) Error() string { return e.Reason }

// ValidateAdminAllowlistMount returns a non-nil error when mounting
// AdminIPAllowlist would be unsafe given the current process trust
// posture. The contract:
//
//	trustHeaders=true + trusted CIDRs  → safe (authenticated proxy sets
//	                                     XFF, we walk it from the right).
//	trustHeaders=false + directPeer    → safe (no proxy in front,
//	                                     RemoteAddr IS the client IP
//	                                     and we honour RemoteAddr).
//	trustHeaders=false + !directPeer   → UNSAFE: there's a proxy in
//	                                     front but we're not trusting
//	                                     its XFF; every request will
//	                                     appear to come from the
//	                                     proxy's IP and the allowlist
//	                                     will either let everything
//	                                     through (if proxy IP is
//	                                     allowed) or block everyone.
//
// `directPeer` is the operator's assertion that this listener
// receives TCP connections directly from end clients (no L7 proxy).
// In main.go this is wired to POSTWAVE_DIRECT_CLIENT_CONNECTIONS=1.
func ValidateAdminAllowlistMount(trustHeaders, directPeer bool) error {
	if trustHeaders && TrustedProxyCIDRsConfigured() {
		return nil
	}
	if directPeer {
		return nil
	}
	return &AdminAllowlistMountError{
		Reason: "admin IP allowlist refused: no authenticated client-IP source " +
			"(set POSTWAVE_TRUST_FORWARDED_IP_HEADERS=1 with non-empty trusted-proxy CIDRs, " +
			"or POSTWAVE_DIRECT_CLIENT_CONNECTIONS=1 " +
			"if this listener receives client connections directly)",
	}
}
