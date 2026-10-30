// SPDX-License-Identifier: AGPL-3.0-only
package compat

import (
	"testing"
	"time"
)

func TestVariantToken(t *testing.T) {
	key := []byte("test-signing-key-0123456789")
	now := time.Unix(1_700_000_000, 0)
	page := "page-abc"
	variant := "variant-xyz"

	tok := signVariantToken(key, page, variant, now)
	if tok == "" {
		t.Fatal("expected a token")
	}

	t.Run("round-trips for the same page within TTL", func(t *testing.T) {
		got, ok := verifyVariantToken(key, tok, page, now.Add(time.Hour))
		if !ok || got != variant {
			t.Fatalf("verify = (%q, %v), want (%q, true)", got, ok, variant)
		}
	})

	t.Run("rejects a token minted for a different page", func(t *testing.T) {
		if _, ok := verifyVariantToken(key, tok, "other-page", now); ok {
			t.Fatal("token accepted for the wrong page")
		}
	})

	t.Run("rejects after expiry", func(t *testing.T) {
		if _, ok := verifyVariantToken(key, tok, page, now.Add(variantTokenTTL+time.Second)); ok {
			t.Fatal("expired token accepted")
		}
	})

	t.Run("rejects a tampered mac", func(t *testing.T) {
		if _, ok := verifyVariantToken(key, tok+"x", page, now); ok {
			t.Fatal("tampered token accepted")
		}
	})

	t.Run("rejects under a different key", func(t *testing.T) {
		if _, ok := verifyVariantToken([]byte("other-key"), tok, page, now); ok {
			t.Fatal("token accepted under a different signing key")
		}
	})

	t.Run("rejects garbage / empty", func(t *testing.T) {
		for _, bad := range []string{"", "no-dot", "a.b.c", "!!!.###"} {
			if _, ok := verifyVariantToken(key, bad, page, now); ok {
				t.Fatalf("garbage token %q accepted", bad)
			}
		}
	})

	t.Run("no key = no token, and never verifies", func(t *testing.T) {
		if signVariantToken(nil, page, variant, now) != "" {
			t.Fatal("expected empty token with no key")
		}
		if _, ok := verifyVariantToken(nil, tok, page, now); ok {
			t.Fatal("verify should fail with no key")
		}
	})
}
