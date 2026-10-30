// SPDX-License-Identifier: AGPL-3.0-only
package discordint

import (
	"net/http"
	"testing"
)

func TestValidateURLRejectsUnsafeDiscordWebhookShapes(t *testing.T) {
	cases := []string{
		"",
		"http://discord.com/api/webhooks/123/token",
		"https://discord.com.evil.test/api/webhooks/123/token",
		"https://user:pass@discord.com/api/webhooks/123/token",
		"https://discord.com/api/webhooks/123/token?redirect=https://evil.example",
		"https://localhost/api/webhooks/123/token",
	}
	for _, tc := range cases {
		if err := validateURL(tc); err == nil {
			t.Fatalf("validateURL(%q) accepted unsafe URL", tc)
		}
	}
}

func TestDefaultHTTPClientRejectsUnsafeRedirects(t *testing.T) {
	client := defaultHTTPClient()
	if client.CheckRedirect == nil {
		t.Fatal("default client has no redirect guard")
	}
	req, err := http.NewRequest(http.MethodPost, "https://localhost/api/webhooks/123/token", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(req, nil); err == nil {
		t.Fatal("unsafe redirect accepted")
	}
}
