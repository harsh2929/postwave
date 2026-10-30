package runtime

import (
	"context"
	"net"
	"testing"
)

func TestIsPublicIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"8.8.8.8", true},
		{"1.1.1.1", true},
		{"203.0.113.10", true},         // TEST-NET-3 is globally-routable-shaped
		{"127.0.0.1", false},           // loopback
		{"10.0.0.5", false},            // RFC1918
		{"192.168.1.1", false},         // RFC1918
		{"172.16.0.1", false},          // RFC1918
		{"169.254.0.1", false},         // link-local
		{"100.64.0.1", false},          // CGNAT (RFC6598)
		{"0.0.0.0", false},             // unspecified
		{"::1", false},                 // IPv6 loopback
		{"fc00::1", false},             // IPv6 ULA (private)
		{"fe80::1", false},             // IPv6 link-local
		{"2606:4700:4700::1111", true}, // public IPv6
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if got := isPublicIP(ip); got != c.want {
			t.Errorf("isPublicIP(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
}

func TestWebhookSendValidation(t *testing.T) {
	e := NewHTTPWebhookEmitter("")
	ctx := context.Background()

	if err := e.Send(ctx, WebhookRequest{URL: ""}); err == nil {
		t.Error("empty url should error")
	}
	if err := e.Send(ctx, WebhookRequest{URL: "ftp://example.com/x"}); err == nil {
		t.Error("non-http(s) scheme should error")
	}
	if err := e.Send(ctx, WebhookRequest{URL: "https://example.com/x", Method: "DELETE"}); err == nil {
		t.Error("unsupported method should error")
	}
}

// TestWebhookSendBlocksLoopback verifies the dialer guard refuses to connect to
// a loopback address even when the URL looks ordinary — the core SSRF defense.
func TestWebhookSendBlocksLoopback(t *testing.T) {
	e := NewHTTPWebhookEmitter("")
	err := e.Send(context.Background(), WebhookRequest{URL: "http://127.0.0.1:9/blocked"})
	if err == nil {
		t.Fatal("expected SSRF guard to block loopback dial")
	}
}
