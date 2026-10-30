// SPDX-License-Identifier: AGPL-3.0-only
//
// client_asn.go — the autonomous-system number of the client, when and only
// when an authenticated edge measured it.
//
// WHY THIS IS NOT A GEOIP LOOKUP. The engagement classifier's machine-source
// registry MATCHES ON ASN: an observation whose ASN is in the registry is
// classified as machine traffic of a named subtype. That makes the field an
// authorization-adjacent input, not a decoration. Two consequences follow and
// both are load-bearing:
//
//   - A header trusted unconditionally is attacker-controlled. A sender who can
//     set the ASN header can pick their own classification — assert a
//     residential ASN and have prefetch traffic scored as human, or assert a
//     known-bot ASN to poison a competitor's numbers. So the header is read
//     ONLY when the untouched TCP peer is itself inside the configured
//     trusted-proxy set, which is the same authentication boundary
//     ResolveClientIP already enforces. That logic is not re-implemented here;
//     isTrustedProxy and the process-global set from SetTrustedProxyCIDRs are
//     reused directly, because a second copy of a trust rule is a second place
//     for it to drift.
//
//   - A GUESSED ASN IS WORSE THAN NO ASN. internal/audit/ueba's impossible
//     travel detector deliberately hashes an unknown /16 into a pseudo-location
//     rather than take a MaxMind dependency; there, a wrong coordinate degrades
//     to a missed flag. Here the same trick would produce a CONFIDENT WRONG
//     classification — a fabricated ASN that happens to collide with a registry
//     entry marks a real person's open as machine traffic, and the resulting
//     number looks exactly as authoritative as a measured one. There is no
//     inference, no /16 heuristic, and no fallback in this file. Either the
//     trusted edge measured it or the answer is "not measured".
//
// The edge emits the value with a transform rule (Cloudflare: `ip.src.asnum`),
// and must SET rather than APPEND the header so a client-supplied copy cannot
// survive. This resolver additionally refuses a header that arrives more than
// once or carries anything but a single decimal ASN, because an ambiguous
// chain cannot be resolved into a measurement.

package middleware

import (
	"net/http"
	"strconv"
	"strings"
)

// ClientASNHeader is the request header an authenticated edge uses to report
// the client's autonomous-system number.
//
// Deliberately Moosewave-namespaced rather than a CDN-native name: a vendor
// header can be set by a different vendor sitting in front of the deployment,
// and the operator must be able to strip-and-set exactly one header they own.
const ClientASNHeader = "X-Postwave-Client-ASN"

// maxAutonomousSystemNumber is the top of the 32-bit ASN space (RFC 6793).
// AS 0 is reserved and never a valid origin, so the accepted range starts at 1
// and matches the database CHECK on subscriber_event_observations.network_asn.
const maxAutonomousSystemNumber = uint64(4294967295)

// ResolveClientASN returns the ASN an authenticated edge measured for this
// request's client, and whether it was measured at all.
//
// measured=false is the answer for every ambiguous case: header absent, headers
// trusted but no proxy boundary configured, TCP peer outside that boundary,
// duplicate headers, non-decimal text, or a value outside 1..4294967295. The
// caller must record the absence rather than substitute a value; see
// engagementclassification.ObservedNetworkASN for the provenance vocabulary
// that keeps "measured" distinguishable from "absent" once persisted.
func ResolveClientASN(r *http.Request, trustHeaders bool) (uint32, bool) {
	if r == nil || !trustHeaders {
		return 0, false
	}
	// An empty trusted set never authenticates anybody — the same fail-closed
	// default ResolveClientIP applies. A boolean alone cannot authenticate a
	// proxy, and this header carries more authority than XFF does.
	if len(loadTrustedProxies()) == 0 {
		return 0, false
	}
	// RemoteAddr is the untouched TCP peer. This check must run before any
	// middleware rewrites it.
	if !isTrustedProxy(parseIPLoose(stripPort(r.RemoteAddr))) {
		return 0, false
	}
	values := r.Header.Values(ClientASNHeader)
	if len(values) != 1 {
		// Zero: nothing to read. More than one: two hops disagreed, or a client
		// copy survived a proxy that appended instead of setting. Neither is a
		// measurement, and picking one would be a guess.
		return 0, false
	}
	return parseAutonomousSystemNumber(values[0])
}

// parseAutonomousSystemNumber accepts one bare decimal ASN and nothing else.
//
// No "AS1234" prefix, no comma list, no whitespace-separated pair: each of
// those is a differently-configured edge, and silently normalising one of them
// would make a misconfiguration invisible at exactly the moment a reader needs
// to know the value is untrustworthy.
func parseAutonomousSystemNumber(raw string) (uint32, bool) {
	// RFC 9110 optional whitespace around a field value is SP and HTAB only.
	// CR/LF are trimmed by nothing here on purpose: net/http rejects them in a
	// field value, and quietly accepting one would make this the second parser
	// in the process with an opinion about line endings.
	raw = strings.Trim(raw, " \t")
	if raw == "" || len(raw) > 10 {
		return 0, false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return 0, false
		}
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || value == 0 || value > maxAutonomousSystemNumber {
		return 0, false
	}
	return uint32(value), true
}
