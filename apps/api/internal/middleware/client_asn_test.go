// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Deliberately NOT t.Parallel: the trusted-proxy set is process-global, exactly
// as client_ip_test.go treats it.
func asnRequest(remoteAddr string, headers ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/px.gif", nil)
	r.RemoteAddr = remoteAddr
	for _, value := range headers {
		r.Header.Add(ClientASNHeader, value)
	}
	return r
}

// THE SECURITY PROPERTY. The machine-source registry matches on ASN, so a
// header honoured from an unauthenticated peer lets a sender choose their own
// classification. The peer — not the header, and not a boolean — is what
// authorises the read.
func TestResolveClientASNIgnoresTheHeaderUnlessTheTCPPeerIsTrusted(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}

	// Trusted peer: measured. This is the control — without it every assertion
	// below would pass on a resolver that always returns false.
	asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444", "13335"), true)
	if !measured || asn != 13335 {
		t.Fatalf("trusted peer = %d/%v, want 13335/true", asn, measured)
	}

	for _, test := range []struct {
		name string
		peer string
	}{
		{name: "direct attacker", peer: "203.0.113.9:5555"},
		{name: "adjacent private range outside the trusted set", peer: "192.168.4.4:5555"},
		{name: "loopback", peer: "127.0.0.1:5555"},
		{name: "ipv6 peer outside the set", peer: "[2001:db8::1]:5555"},
		{name: "unparseable peer", peer: "not-an-address"},
	} {
		t.Run(test.name, func(t *testing.T) {
			asn, measured := ResolveClientASN(asnRequest(test.peer, "13335"), true)
			if measured || asn != 0 {
				t.Fatalf("untrusted peer %q was honoured: %d/%v", test.peer, asn, measured)
			}
		})
	}
}

func TestResolveClientASNFailsClosedOnPostureAndAmbiguity(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()

	// No trusted set configured at all: a trusted-looking peer proves nothing.
	_ = SetTrustedProxyCIDRs(nil)
	if asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444", "13335"), true); measured || asn != 0 {
		t.Fatalf("unconfigured boundary honoured a header: %d/%v", asn, measured)
	}

	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	if asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444", "13335"), false); measured || asn != 0 {
		t.Fatalf("trustHeaders=false honoured a header: %d/%v", asn, measured)
	}
	if asn, measured := ResolveClientASN(nil, true); measured || asn != 0 {
		t.Fatalf("nil request = %d/%v", asn, measured)
	}
	if asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444"), true); measured || asn != 0 {
		t.Fatalf("absent header = %d/%v, want an absence rather than 0-as-a-value", asn, measured)
	}
	// Two hops disagreed, or a proxy appended instead of setting. Neither is a
	// measurement, and choosing one of them would be a guess.
	if asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444", "13335", "15169"), true); measured || asn != 0 {
		t.Fatalf("duplicate headers were resolved to %d/%v", asn, measured)
	}
}

func TestResolveClientASNRejectsEveryNonDecimalRendering(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		"", " ", "AS13335", "as13335", "0", "-1", "+13335", "13335.0",
		"13335,15169", "13335 15169", "0x3417", "4294967296", "99999999999",
		"1e5", "13335\n", "١٣٣٣٥",
	} {
		if asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444", raw), true); measured || asn != 0 {
			t.Fatalf("malformed ASN header %q accepted as %d", raw, asn)
		}
	}
	// The boundary values that ARE valid, so the rejections above are testing
	// the parser rather than a function that always says no.
	for raw, want := range map[string]uint32{
		"1": 1, "13335": 13335, "4294967295": 4294967295, " 15169 ": 15169,
	} {
		asn, measured := ResolveClientASN(asnRequest("10.1.2.3:4444", raw), true)
		if !measured || asn != want {
			t.Fatalf("valid ASN header %q = %d/%v, want %d/true", raw, asn, measured, want)
		}
	}
}

// The ASN read must share ResolveClientIP's boundary rather than invent a
// second one: two copies of a trust rule are two places for it to drift.
func TestResolveClientASNSharesTheClientIPTrustBoundary(t *testing.T) {
	defer func() { _ = SetTrustedProxyCIDRs(nil) }()
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	trusted := asnRequest("10.9.9.9:1111", "13335")
	trusted.Header.Set("X-Forwarded-For", "198.51.100.7")
	if ip := ResolveClientIPString(trusted, true); ip != "198.51.100.7" {
		t.Fatalf("client IP = %q, want the forwarded origin", ip)
	}
	if _, measured := ResolveClientASN(trusted, true); !measured {
		t.Fatal("the peer trusted for XFF was not trusted for ASN")
	}

	untrusted := asnRequest("198.51.100.7:1111", "13335")
	untrusted.Header.Set("X-Forwarded-For", "203.0.113.1")
	if ip := ResolveClientIPString(untrusted, true); ip != "198.51.100.7" {
		t.Fatalf("client IP = %q, want the untrusted peer itself", ip)
	}
	if _, measured := ResolveClientASN(untrusted, true); measured {
		t.Fatal("the peer NOT trusted for XFF was trusted for ASN")
	}
}
