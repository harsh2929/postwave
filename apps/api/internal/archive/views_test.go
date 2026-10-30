// SPDX-License-Identifier: AGPL-3.0-only
//
// views_test.go — regression coverage for the DailyVisitorID
// X-Forwarded-For spoofing fix (Phase 4 p4b-daily-visitor-id-xff).
//
// The bug: DailyVisitorID used to incorporate the raw X-Forwarded-For
// header into the anon_visitor_id hash via
// `middleware.ResolveClientIPString(r, true)` regardless of deployment
// posture. Any anonymous archive visitor could therefore set their own
// X-Forwarded-For and pin themselves to an arbitrary daily-visitor id —
// either inflating uniques for a competitor's issue or
// fingerprint-poisoning their own tracking row.
//
// The fix: DailyVisitorID now takes `trustHeaders bool`. When false,
// ResolveClientIPString ignores XFF / X-Real-IP and uses RemoteAddr
// only — so a forged XFF can't change the resulting hash.

package archive

import (
	"net/http"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// TestDailyVisitorID_IgnoresXFFWhenUntrusted is the primary regression
// gate. Two requests from the SAME RemoteAddr with DIFFERENT forged
// X-Forwarded-For values must hash to the SAME visitor id when
// trustHeaders=false — i.e. the attacker cannot manipulate the hash
// via a header they control.
func TestDailyVisitorID_IgnoresXFFWhenUntrusted(t *testing.T) {
	t.Parallel()

	req1, _ := http.NewRequest("GET", "/pixel.gif", nil)
	req1.RemoteAddr = "203.0.113.7:443"
	req1.Header.Set("User-Agent", "Mozilla/5.0 test")
	req1.Header.Set("X-Forwarded-For", "10.0.0.1")

	req2, _ := http.NewRequest("GET", "/pixel.gif", nil)
	req2.RemoteAddr = "203.0.113.7:443"
	req2.Header.Set("User-Agent", "Mozilla/5.0 test")
	req2.Header.Set("X-Forwarded-For", "10.0.0.2") // forged different XFF

	id1 := DailyVisitorID(req1, false)
	id2 := DailyVisitorID(req2, false)

	if id1 == "" || id2 == "" {
		t.Fatalf("empty visitor id: id1=%q id2=%q", id1, id2)
	}
	if id1 != id2 {
		t.Fatalf("forged X-Forwarded-For changed visitor id with trustHeaders=false: id1=%q id2=%q (must be identical)", id1, id2)
	}
}

// TestDailyVisitorID_HonoursXFFWhenTrusted asserts the symmetric
// guarantee: when trustHeaders=true (deployment behind a known
// reverse-proxy) the resolver DOES consume X-Forwarded-For. Different
// XFF values from the same RemoteAddr must hash to different visitor
// ids — otherwise legitimate traffic behind a real CDN would be
// collapsed into a single visitor id per proxy IP.
func TestDailyVisitorID_HonoursXFFWhenTrusted(t *testing.T) {
	// The trust flag is deliberately insufficient by itself: the untouched TCP
	// peer must also belong to the operator-configured proxy allowlist.
	if err := middleware.SetTrustedProxyCIDRs([]string{"203.0.113.7/32"}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = middleware.SetTrustedProxyCIDRs(nil) }()

	req1, _ := http.NewRequest("GET", "/pixel.gif", nil)
	req1.RemoteAddr = "203.0.113.7:443"
	req1.Header.Set("User-Agent", "Mozilla/5.0 test")
	req1.Header.Set("X-Forwarded-For", "198.51.100.1")

	req2, _ := http.NewRequest("GET", "/pixel.gif", nil)
	req2.RemoteAddr = "203.0.113.7:443"
	req2.Header.Set("User-Agent", "Mozilla/5.0 test")
	req2.Header.Set("X-Forwarded-For", "198.51.100.2")

	id1 := DailyVisitorID(req1, true)
	id2 := DailyVisitorID(req2, true)

	if id1 == "" || id2 == "" {
		t.Fatalf("empty visitor id: id1=%q id2=%q", id1, id2)
	}
	if id1 == id2 {
		t.Fatalf("trustHeaders=true collapsed two distinct XFF values: id1=%q id2=%q (must differ)", id1, id2)
	}
}

// TestDailyVisitorID_StableForSameRemoteAddr verifies the "same
// browser counts once" property still holds after the signature
// change — two requests from the same RemoteAddr + same UA without
// any XFF tampering must hash identically regardless of trustHeaders.
func TestDailyVisitorID_StableForSameRemoteAddr(t *testing.T) {
	t.Parallel()

	make := func() *http.Request {
		req, _ := http.NewRequest("GET", "/pixel.gif", nil)
		req.RemoteAddr = "203.0.113.7:443"
		req.Header.Set("User-Agent", "Mozilla/5.0 test")
		return req
	}

	if a, b := DailyVisitorID(make(), false), DailyVisitorID(make(), false); a != b {
		t.Fatalf("trustHeaders=false: same request hashed to different ids: %q vs %q", a, b)
	}
	if a, b := DailyVisitorID(make(), true), DailyVisitorID(make(), true); a != b {
		t.Fatalf("trustHeaders=true: same request hashed to different ids: %q vs %q", a, b)
	}
}
