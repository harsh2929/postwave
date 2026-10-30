// SPDX-License-Identifier: AGPL-3.0-only
package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The audit trail used to read r.RemoteAddr on the premise that chi's RealIP
// middleware had rewritten it — but that middleware is mounted nowhere in this
// gateway. Behind the proxy the production template configures, every
// audit_log row therefore recorded the load balancer's address, and the UEBA
// impossible-travel detector (which returns early when an event's IP matches
// the previous one) could never fire because the IP was constant.
func TestAuditMetaResolvesForwardedClientIPUnderTrustedProxy(t *testing.T) {
	if err := SetTrustedProxyCIDRs([]string{"10.0.0.0/8"}); err != nil {
		t.Fatalf("set trusted proxies: %v", err)
	}
	t.Cleanup(func() {
		_ = SetTrustedProxyCIDRs(nil)
		SetAuditTrustForwardedIPHeaders(false)
	})
	SetAuditTrustForwardedIPHeaders(true)

	r := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	r.RemoteAddr = "10.0.0.7:44321"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.7")

	if got := AuditMetaFromRequest(r).IP; got != "203.0.113.9" {
		t.Fatalf("audit IP = %q, want the client 203.0.113.9 and not the proxy hop", got)
	}
}

// The mirror case: without the trust posture the TCP peer is authoritative, so
// a forged header must not be able to write an attacker-chosen origin into the
// compliance record.
func TestAuditMetaIgnoresForwardedHeaderWhenUntrusted(t *testing.T) {
	t.Cleanup(func() {
		_ = SetTrustedProxyCIDRs(nil)
		SetAuditTrustForwardedIPHeaders(false)
	})
	_ = SetTrustedProxyCIDRs(nil)
	SetAuditTrustForwardedIPHeaders(false)

	r := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", nil)
	r.RemoteAddr = "198.51.100.4:9999"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")

	if got := AuditMetaFromRequest(r).IP; got != "198.51.100.4" {
		t.Fatalf("audit IP = %q, want the TCP peer 198.51.100.4", got)
	}
}
