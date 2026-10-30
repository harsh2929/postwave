package sms

import "testing"

func TestProviderURLPreservesBasePathAndQuery(t *testing.T) {
	got, err := providerURL("https://twilio.example.test/proxy/", "/Messages.json?PageSize=50")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://twilio.example.test/proxy/Messages.json?PageSize=50" {
		t.Fatalf("providerURL = %q", got)
	}
}

func TestProviderURLRejectsUnsafeInputs(t *testing.T) {
	for _, tc := range []struct {
		base string
		path string
	}{
		{base: "https://u:p@twilio.example.test", path: "/Messages.json"},
		{base: "https://twilio.example.test?token=x", path: "/Messages.json"},
		{base: "https://twilio.example.test#frag", path: "/Messages.json"},
		{base: "file:///tmp/provider", path: "/Messages.json"},
		{base: "https://twilio.example.test", path: "/%2e%2e/Messages.json"},
		{base: "https://twilio.example.test", path: "/Accounts\\Messages.json"},
	} {
		if _, err := providerURL(tc.base, tc.path); err == nil {
			t.Fatalf("base=%q path=%q should be rejected", tc.base, tc.path)
		}
	}
}
