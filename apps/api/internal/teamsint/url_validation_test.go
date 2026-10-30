// SPDX-License-Identifier: AGPL-3.0-only
package teamsint

import (
	"net/http"
	"testing"
)

func TestValidateURLRejectsUnsafeTeamsWebhookShapes(t *testing.T) {
	cases := []string{
		"",
		"http://outlook.office.com/webhook/abc",
		"https://outlook.office.com.evil.test/webhook/abc",
		"https://user:pass@outlook.office.com/webhook/abc",
		"https://outlook.office.com/webhook/abc?redirect=https://evil.example",
		"https://localhost/webhook/abc",
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
	req, err := http.NewRequest(http.MethodPost, "https://localhost/webhook/abc", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(req, nil); err == nil {
		t.Fatal("unsafe redirect accepted")
	}
}
