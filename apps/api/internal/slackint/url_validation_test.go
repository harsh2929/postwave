// SPDX-License-Identifier: AGPL-3.0-only
package slackint

import (
	"net/http"
	"testing"
)

func TestValidateURLRejectsUnsafeSlackWebhookShapes(t *testing.T) {
	cases := []string{
		"",
		"http://hooks.slack.com/services/T123/B456/secret",
		"https://hooks.slack.com.evil.test/services/T123/B456/secret",
		"https://user:pass@hooks.slack.com/services/T123/B456/secret",
		"https://hooks.slack.com/services/T123/B456/secret?redirect=https://evil.example",
		"https://localhost/services/T123/B456/secret",
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
	req, err := http.NewRequest(http.MethodPost, "https://localhost/services/T123/B456/secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(req, nil); err == nil {
		t.Fatal("unsafe redirect accepted")
	}
}

func TestSafeOAuthSuccessRedirect(t *testing.T) {
	cases := map[string]string{
		"/app/settings":                         "/app/settings",
		"https://app.moosewave.com/settings#ok": "https://app.moosewave.com/settings",
		"http://localhost:3000/slack/callback":  "http://localhost:3000/slack/callback",
	}
	for raw, want := range cases {
		if got := safeOAuthSuccessRedirect(raw); got != want {
			t.Fatalf("safeOAuthSuccessRedirect(%q) = %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{
		"http://app.moosewave.com/settings",
		"https://user:pass@app.moosewave.com/settings",
		"//evil.example/settings",
		"/app%0d%0aLocation:https://evil.example",
		"javascript:alert(1)",
	} {
		if got := safeOAuthSuccessRedirect(raw); got != "" {
			t.Fatalf("safeOAuthSuccessRedirect(%q) = %q, want empty", raw, got)
		}
	}
}
