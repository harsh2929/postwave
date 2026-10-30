// SPDX-License-Identifier: AGPL-3.0-only
package privacy_portal

import "testing"

func TestValidPreferenceLogoURLRequiresPublicHTTPS(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		url  string
		want bool
	}{
		{name: "empty", url: "", want: true},
		{name: "public domain", url: "https://assets.example.com/logo.png", want: true},
		{name: "credentials", url: "https://user:pass@assets.example.com/logo.png"},
		{name: "data URI", url: "data:image/svg+xml,<svg/>"},
		{name: "localhost", url: "https://localhost/logo.png"},
		{name: "loopback", url: "https://127.0.0.1/logo.png"},
		{name: "private IPv4", url: "https://10.0.0.4/logo.png"},
		{name: "private IPv6", url: "https://[fd00::4]/logo.png"},
		{name: "single label", url: "https://intranet/logo.png"},
		{name: "local domain", url: "https://printer.local/logo.png"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := validPreferenceLogoURL(tc.url); got != tc.want {
				t.Fatalf("validPreferenceLogoURL(%q) = %v, want %v", tc.url, got, tc.want)
			}
		})
	}
}

func TestPreferenceCustomizationRejectsUnsafeFooterCharacters(t *testing.T) {
	t.Parallel()
	value := defaultPreferenceCustomization()
	value.FooterText = "safe\u202Eunsafe"
	if err := value.validate(); err != ErrInvalidFooterText {
		t.Fatalf("validate() error = %v, want %v", err, ErrInvalidFooterText)
	}
}

func TestRegionInputValidateCanonicalizesOnlyBoundedCodes(t *testing.T) {
	t.Parallel()
	valid := RegionInput{RegionCode: " us-ca ", Framework: " GDPR "}
	if err := valid.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if valid.RegionCode != "US-CA" || valid.Framework != "gdpr" {
		t.Fatalf("Validate() canonical result = %#v", valid)
	}
	for _, code := range []string{"", "A", "US_CA", "TOO-LONGSEGMENT", "EU\u202E"} {
		input := RegionInput{RegionCode: code, Framework: "gdpr"}
		if err := input.Validate(); err != ErrInvalidRegionCode {
			t.Fatalf("Validate(%q) error = %v, want %v", code, err, ErrInvalidRegionCode)
		}
	}
}
