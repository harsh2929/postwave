package adapter

import "testing"

func TestBuildURLPreservesBasePathAndQuery(t *testing.T) {
	got, err := BuildURL("https://api.example.test/root///", "/api/v1/items?cursor=a%2Fb")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://api.example.test/root/api/v1/items?cursor=a%2Fb"
	if got != want {
		t.Fatalf("BuildURL = %q, want %q", got, want)
	}
}

func TestBuildURLPreservesEscapedPathSegmentExactlyOnce(t *testing.T) {
	got, err := BuildURL(
		"https://api.example.test/root",
		"/communication-preferences/2026-03/statuses/a%2Fb@example.com?channel=EMAIL",
	)
	if err != nil {
		t.Fatal(err)
	}
	want := "https://api.example.test/root/communication-preferences/2026-03/statuses/a%2Fb@example.com?channel=EMAIL"
	if got != want {
		t.Fatalf("BuildURL = %q, want %q", got, want)
	}
}

func TestBuildURLTreatsAbsoluteLookingPathAsRelative(t *testing.T) {
	got, err := BuildURL("https://api.example.test/root", "https://evil.example/x")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://api.example.test/root/https://evil.example/x"
	if got != want {
		t.Fatalf("BuildURL = %q, want %q", got, want)
	}
}

func TestBuildURLRejectsUnsafeInputs(t *testing.T) {
	cases := []struct {
		name string
		base string
		path string
	}{
		{name: "credentialed base", base: "https://u:p@example.test", path: "/api"},
		{name: "base query", base: "https://example.test?x=1", path: "/api"},
		{name: "bad scheme", base: "file:///tmp/x", path: "/api"},
		{name: "path traversal", base: "https://example.test", path: "../api"},
		{name: "encoded path traversal", base: "https://example.test", path: "%2e%2e/api"},
		{name: "path fragment", base: "https://example.test", path: "/api#token"},
		{name: "backslash path", base: "https://example.test", path: `api\secret`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := BuildURL(tc.base, tc.path); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
