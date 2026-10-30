// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

func TestNewWebAuthnRPConfig(t *testing.T) {
	rp, err := NewWebAuthn("https://app.moosewave.com")
	if err != nil {
		t.Fatalf("NewWebAuthn: %v", err)
	}
	if rp.Config.RPID != "app.moosewave.com" {
		t.Fatalf("RPID = %q, want app.moosewave.com", rp.Config.RPID)
	}
	if len(rp.Config.RPOrigins) != 1 || rp.Config.RPOrigins[0] != "https://app.moosewave.com" {
		t.Fatalf("RPOrigins = %v, want [https://app.moosewave.com]", rp.Config.RPOrigins)
	}

	if _, err := NewWebAuthn(""); err == nil {
		t.Fatal("empty base URL should error")
	}
	if _, err := NewWebAuthn("not a url"); err == nil {
		t.Fatal("invalid base URL should error")
	}
}

func TestChallengeCodec(t *testing.T) {
	key := []byte("a-32-byte-or-longer-signing-key-abc")
	now := time.Unix(1_700_000_000, 0)
	sd := &webauthn.SessionData{Challenge: "abc123", RelyingPartyID: "app.moosewave.com", UserID: []byte("u1")}

	t.Run("registration round-trips with bound user/tenant", func(t *testing.T) {
		tok, err := signChallenge(key, "reg", "user-1", "tenant-1", sd, now)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		got, uid, tid, err := verifyChallenge(key, "reg", tok, now.Add(time.Minute))
		if err != nil {
			t.Fatalf("verify: %v", err)
		}
		if got.Challenge != "abc123" || uid != "user-1" || tid != "tenant-1" {
			t.Fatalf("decoded = (%q,%q,%q), want (abc123,user-1,tenant-1)", got.Challenge, uid, tid)
		}
	})

	t.Run("rejects a purpose mismatch (reg cookie on login finish)", func(t *testing.T) {
		tok, _ := signChallenge(key, "reg", "user-1", "tenant-1", sd, now)
		if _, _, _, err := verifyChallenge(key, "login", tok, now); err == nil {
			t.Fatal("reg cookie accepted for login purpose")
		}
	})

	t.Run("rejects after expiry", func(t *testing.T) {
		tok, _ := signChallenge(key, "login", "", "", sd, now)
		if _, _, _, err := verifyChallenge(key, "login", tok, now.Add(challengeCookieTTL+time.Second)); err == nil {
			t.Fatal("expired challenge accepted")
		}
	})

	t.Run("rejects a tampered mac", func(t *testing.T) {
		tok, _ := signChallenge(key, "login", "", "", sd, now)
		if _, _, _, err := verifyChallenge(key, "login", tok+"x", now); err == nil {
			t.Fatal("tampered challenge accepted")
		}
	})

	t.Run("rejects under a different key", func(t *testing.T) {
		tok, _ := signChallenge(key, "login", "", "", sd, now)
		if _, _, _, err := verifyChallenge([]byte("other-key-other-key-other-key-xx"), "login", tok, now); err == nil {
			t.Fatal("challenge accepted under a different key")
		}
	})

	t.Run("no key = no sign, no verify", func(t *testing.T) {
		if _, err := signChallenge(nil, "reg", "", "", sd, now); err == nil {
			t.Fatal("sign should fail with no key")
		}
		if _, _, _, err := verifyChallenge(nil, "reg", "x.y", now); err == nil {
			t.Fatal("verify should fail with no key")
		}
	})
}
