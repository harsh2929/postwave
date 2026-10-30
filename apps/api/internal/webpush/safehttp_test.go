// SPDX-License-Identifier: AGPL-3.0-only

package webpush

import (
	"net"
	"testing"
)

func TestAllowedPushHost(t *testing.T) {
	allowed := []string{
		"https://fcm.googleapis.com/fcm/send/abc123",
		"https://updates.push.services.mozilla.com/wpush/v2/xyz",
		"https://abc123.notify.windows.com/w/?token=foo",
		"https://web.push.apple.com/QABC",
	}
	for _, e := range allowed {
		if !allowedPushHost(e) {
			t.Errorf("want allowed: %s", e)
		}
	}

	rejected := []string{
		"https://evil.com/x",                       // unknown host
		"http://fcm.googleapis.com/x",              // not https
		"https://user:pass@fcm.googleapis.com/x",   // userinfo
		"https://fcm.googleapis.com.evil.com/x",    // suffix-confusion (host ends .evil.com)
		"https://169.254.169.254/latest/meta-data", // cloud metadata IP
		"https://internal-service/x",               // internal hostname
		"ftp://fcm.googleapis.com/x",               // wrong scheme
		"https://localhost/x",                      // loopback name
		"",
	}
	for _, e := range rejected {
		if allowedPushHost(e) {
			t.Errorf("want rejected: %s", e)
		}
	}
}

func TestIsPublicIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"1.1.1.1", true},
		{"2606:4700:4700::1111", true},
		{"127.0.0.1", false},       // loopback
		{"10.0.0.5", false},        // RFC1918
		{"192.168.1.1", false},     // RFC1918
		{"172.16.5.5", false},      // RFC1918
		{"169.254.169.254", false}, // link-local (cloud metadata)
		{"100.64.0.1", false},      // CGNAT
		{"0.0.0.0", false},         // unspecified
		{"::1", false},             // IPv6 loopback
		{"fc00::1", false},         // IPv6 ULA
		{"fe80::1", false},         // IPv6 link-local
	}
	for _, c := range cases {
		if got := isPublicIP(net.ParseIP(c.ip)); got != c.want {
			t.Errorf("isPublicIP(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
}
