// SPDX-License-Identifier: AGPL-3.0-only
package custom_domains

import "testing"

func TestRewriteClick_SwapsHost(t *testing.T) {
	got := RewriteClick("https://track.moosewave.com/c/abc?u=https%3A%2F%2Facme.com",
		"go.acme.com")
	want := "https://go.acme.com/c/abc?u=https%3A%2F%2Facme.com"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestRewriteClick_EmptyHostPassthrough(t *testing.T) {
	in := "https://track.moosewave.com/c/abc"
	if got := RewriteClick(in, ""); got != in {
		t.Fatalf("expected passthrough, got %q", got)
	}
}

func TestRewriteClick_BadURLReturnsOriginal(t *testing.T) {
	in := "://not-a-url"
	if got := RewriteClick(in, "go.acme.com"); got != in {
		t.Fatalf("got %q want passthrough", got)
	}
}

func TestBuildPixelURL_AddsLeadingSlash(t *testing.T) {
	if got := BuildPixelURL("pixel.acme.com", "pixel.gif?m=1"); got != "https://pixel.acme.com/pixel.gif?m=1" {
		t.Fatalf("got %q", got)
	}
}

func TestBuildPixelURL_EmptyHostIsEmpty(t *testing.T) {
	if got := BuildPixelURL("", "/pixel.gif"); got != "" {
		t.Fatalf("got %q want empty", got)
	}
}
