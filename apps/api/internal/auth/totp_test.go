// SPDX-License-Identifier: AGPL-3.0-only
package auth

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"testing"
	"time"
)

// TestCode_RFC6238Vectors covers the SHA-1 reference vectors from
// RFC 6238 Appendix B. The published table includes higher digits
// (truncated to 8) — for our 6-digit configuration we take the last
// 6 digits of each value.
//
// The shared secret is the ASCII string "12345678901234567890" (exactly
// 20 bytes, which is what RFC 6238 §B specifies for the SHA-1 line).
func TestCode_RFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")

	// (unix time, 8-digit value from the RFC table) — we slice the last
	// 6 digits when comparing against our 6-digit configuration.
	cases := []struct {
		unixT  int64
		digit8 string
	}{
		{59, "94287082"},
		{1111111109, "07081804"},
		{1111111111, "14050471"},
		{1234567890, "89005924"},
		{2000000000, "69279037"},
		{20000000000, "65353130"},
	}

	for _, c := range cases {
		want := c.digit8[len(c.digit8)-6:]
		got := Code(secret, time.Unix(c.unixT, 0))
		if got != want {
			t.Errorf("Code(t=%d) = %q, want %q (RFC 6238 8-digit %q)",
				c.unixT, got, want, c.digit8)
		}
	}
}

func TestVerifyCode_AcceptsCurrentStep(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111111, 0) // RFC vector → 14050471 → "050471"
	if !VerifyCode(secret, "050471", now, 1) {
		t.Errorf("expected current-step verify to succeed")
	}
}

func TestVerifyCode_AcceptsPreviousAndNextWithSkew(t *testing.T) {
	secret := []byte("12345678901234567890")
	base := time.Unix(1111111111, 0)
	prev := Code(secret, base.Add(-30*time.Second))
	next := Code(secret, base.Add(30*time.Second))
	if !VerifyCode(secret, prev, base, 1) {
		t.Errorf("expected -1 step to verify with skew=1, prev=%s", prev)
	}
	if !VerifyCode(secret, next, base, 1) {
		t.Errorf("expected +1 step to verify with skew=1, next=%s", next)
	}
}

func TestVerifyCode_RejectsOutOfWindow(t *testing.T) {
	secret := []byte("12345678901234567890")
	base := time.Unix(1111111111, 0)
	farFuture := Code(secret, base.Add(2*time.Minute))
	if VerifyCode(secret, farFuture, base, 1) {
		t.Errorf("expected far-future code to be rejected")
	}
}

func TestVerifyCode_RejectsWrongLength(t *testing.T) {
	secret := []byte("12345678901234567890")
	if VerifyCode(secret, "12345", time.Now(), 1) {
		t.Errorf("expected 5-digit code to be rejected")
	}
	if VerifyCode(secret, "1234567", time.Now(), 1) {
		t.Errorf("expected 7-digit code to be rejected")
	}
	if VerifyCode(secret, "", time.Now(), 1) {
		t.Errorf("expected empty code to be rejected")
	}
}

func TestVerifyCode_TrimsWhitespace(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1111111111, 0)
	if !VerifyCode(secret, "  050471 ", now, 1) {
		t.Errorf("expected whitespace-padded code to verify")
	}
}

func TestCode_PreEpochClampsToInitialStep(t *testing.T) {
	secret := []byte("12345678901234567890")
	if got, want := Code(secret, time.Unix(-1, 0)), Code(secret, time.Unix(0, 0)); got != want {
		t.Fatalf("pre-epoch code = %q, want initial-step code %q", got, want)
	}
}

func TestVerifyCode_PreEpochFailsClosed(t *testing.T) {
	secret := []byte("12345678901234567890")
	if VerifyCode(secret, Code(secret, time.Unix(0, 0)), time.Unix(-1, 0), 1) {
		t.Fatal("expected verification before Unix epoch to fail closed")
	}
}

func TestGenerateSecret_LengthAndBase32(t *testing.T) {
	raw, b32, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != TOTPSecretBytes {
		t.Errorf("raw secret = %d bytes, want %d", len(raw), TOTPSecretBytes)
	}
	// 20 bytes → ceil(20*8/5) = 32 base32 chars (no padding).
	if len(b32) != 32 {
		t.Errorf("base32 secret = %d chars, want 32", len(b32))
	}
	if strings.Contains(b32, "=") {
		t.Errorf("base32 secret has padding: %q", b32)
	}
}

func TestBuildOtpauthURI(t *testing.T) {
	uri := BuildOtpauthURI("alice@example.com", "JBSWY3DPEHPK3PXP")
	// We don't pin the exact URI byte-for-byte (query encoder may reorder)
	// — instead, sanity-check the fields a parsing authenticator app
	// would key off of.
	checks := []string{
		"otpauth://totp/Moosewave:alice@example.com?",
		"secret=JBSWY3DPEHPK3PXP",
		"issuer=Moosewave",
		"algorithm=SHA1",
		"digits=6",
		"period=30",
	}
	for _, want := range checks {
		if !strings.Contains(uri, want) {
			t.Errorf("URI %q missing %q", uri, want)
		}
	}
}

func TestGenerateRecoveryCodes_FormatAndHashIntegrity(t *testing.T) {
	plain, hashes, err := GenerateRecoveryCodes(8)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) != 8 || len(hashes) != 8 {
		t.Fatalf("expected 8/8, got %d/%d", len(plain), len(hashes))
	}
	seen := map[string]bool{}
	for i, code := range plain {
		// Format: xxxx-xxxx-xxxx (12 hex + 2 hyphens).
		if len(code) != 14 {
			t.Errorf("code %d wrong length: %q", i, code)
		}
		if code[4] != '-' || code[9] != '-' {
			t.Errorf("code %d wrong shape: %q", i, code)
		}
		// Hash matches.
		expected := sha256.Sum256([]byte(code))
		if !bytes.Equal(expected[:], hashes[i]) {
			t.Errorf("code %d hash mismatch", i)
		}
		// Uniqueness.
		if seen[code] {
			t.Errorf("duplicate recovery code: %q", code)
		}
		seen[code] = true
	}
}

func TestHashRecoveryCode_NormalizesInput(t *testing.T) {
	a := HashRecoveryCode("ABCD-1234-EF56")
	b := HashRecoveryCode("  abcd-1234-ef56  ")
	if !bytes.Equal(a, b) {
		t.Errorf("HashRecoveryCode should normalize case + trim whitespace")
	}
}
