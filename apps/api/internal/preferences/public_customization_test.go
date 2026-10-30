// SPDX-License-Identifier: AGPL-3.0-only
package preferences

import "testing"

func TestSafePublicPreferenceLogoRequiresPublicHTTPS(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		url  string
		want bool
	}{
		{url: "", want: true},
		{url: "https://cdn.example.com/brand.svg", want: true},
		{url: "https://localhost/brand.svg"},
		{url: "https://192.168.1.10/brand.svg"},
		{url: "https://[::1]/brand.svg"},
		{url: "https://intranet/brand.svg"},
		{url: "javascript:alert(1)"},
	} {
		if got := safePublicPreferenceLogo(tc.url); got != tc.want {
			t.Fatalf("safePublicPreferenceLogo(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}
