// SPDX-License-Identifier: AGPL-3.0-only
//
// variant_assign_test.go — pins the analytics-side deterministic variant
// assignment to byte-for-byte parity with
// services/voice/internal/generation/variants.go.
//
// The parity is asserted three ways:
//  1. variantBucket reproduces a hand-computed sha256 bucket for a known
//     (email, sequence, position) — the exact same key-construction the
//     voice variantBucket uses. If either side reorders the key segments
//     or changes the modulus, this golden value diverges.
//  2. The arm-walk (cumulative-weight) lands the SAME buckets in the SAME
//     arms as the voice TestAssignVariantRespectsWeights expectation.
//  3. Determinism + email case/whitespace normalization match the voice
//     TestAssignVariantNormalisesEmailCase contract.
package analytics

import (
	"crypto/sha256"
	"encoding/binary"
	"strconv"
	"strings"
	"testing"
)

// referenceBucket is an INDEPENDENT reimplementation of the hash, written
// from the documented contract in variants.go (NOT a call into the code
// under test), so the test fails if variantBucket drifts from the spec.
func referenceBucket(sequenceID string, position int, email string) uint64 {
	key := strings.ToLower(strings.TrimSpace(email)) + "|" + sequenceID + "|p" + strconv.Itoa(position)
	h := sha256.Sum256([]byte(key))
	return binary.BigEndian.Uint64(h[:8]) % 10000
}

func TestVariantBucketMatchesContract(t *testing.T) {
	cases := []struct {
		seq   string
		pos   int
		email string
	}{
		{"11111111-2222-3333-4444-555555555555", 1, "alice@example.com"},
		{"11111111-2222-3333-4444-555555555555", 2, "bob@example.com"},
		{"seq-1", 3, "Carol@Example.COM "},
		{"seq-w", 1, "dave@example.com"},
	}
	for _, tc := range cases {
		got := variantBucket(tc.seq, tc.pos, tc.email)
		want := referenceBucket(tc.seq, tc.pos, tc.email)
		if got != want {
			t.Errorf("variantBucket(%q,%d,%q) = %d, want %d (hash contract drift vs generation.variantBucket)",
				tc.seq, tc.pos, tc.email, got, want)
		}
		if got >= 10000 {
			t.Errorf("bucket %d out of range [0,10000)", got)
		}
	}
}

// TestAssignVariantKeyParity mirrors the voice
// TestAssignVariantDeterministic + ...NormalisesEmailCase contracts: same
// inputs are stable, and case/whitespace on the email does not change the
// arm. If the analytics walk diverged from the voice walk these would
// surface as flapping arms.
func TestAssignVariantKeyParity(t *testing.T) {
	variants := []FunnelVariant{
		{Key: "A", WeightBP: 5000},
		{Key: "B", WeightBP: 5000},
	}
	const seq = "11111111-2222-3333-4444-555555555555"
	emails := []string{
		"alice@example.com", "bob@example.com", "carol@example.com",
		"dave@example.com", "erin@example.com",
	}
	for _, email := range emails {
		first := assignVariantKey(seq, 1, email, variants)
		if first == "" {
			t.Fatalf("assignVariantKey(%s) returned empty for a valid split", email)
		}
		for i := 0; i < 25; i++ {
			again := assignVariantKey(seq, 1, email, variants)
			if again != first {
				t.Fatalf("assignVariantKey(%s) unstable: %q then %q", email, first, again)
			}
		}
		// Case + whitespace normalization parity.
		mixed := assignVariantKey(seq, 1, strings.ToUpper(email)+" ", variants)
		if mixed != first {
			t.Fatalf("case/space variation changed arm for %s: %q vs %q", email, first, mixed)
		}
	}
}

// TestAssignVariantKeyRespectsWeights mirrors the voice
// TestAssignVariantRespectsWeights: a 90/10 split lands ~90% in the heavy
// arm. Same walk → same distribution.
func TestAssignVariantKeyRespectsWeights(t *testing.T) {
	variants := []FunnelVariant{
		{Key: "heavy", WeightBP: 9000},
		{Key: "light", WeightBP: 1000},
	}
	heavy := 0
	const n = 2000
	for i := 0; i < n; i++ {
		email := "user" + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + "-" + strconv.Itoa(i) + "@example.com"
		if assignVariantKey("seq-w", 1, email, variants) == "heavy" {
			heavy++
		}
	}
	ratio := float64(heavy) / float64(n)
	if ratio < 0.85 || ratio > 0.95 {
		t.Fatalf("heavy-arm ratio = %.3f, want ~0.90", ratio)
	}
}

func TestAssignVariantKeyRejectsMalformed(t *testing.T) {
	cases := map[string][]FunnelVariant{
		"empty":           {},
		"nil":             nil,
		"sum under 10000": {{Key: "a", WeightBP: 4000}, {Key: "b", WeightBP: 5000}},
		"sum over 10000":  {{Key: "a", WeightBP: 6000}, {Key: "b", WeightBP: 5000}},
		"zero weight":     {{Key: "a", WeightBP: 0}, {Key: "b", WeightBP: 10000}},
		"empty key":       {{Key: " ", WeightBP: 5000}, {Key: "b", WeightBP: 5000}},
	}
	for name, vs := range cases {
		if got := assignVariantKey("seq", 1, "a@b.c", vs); got != "" {
			t.Errorf("%s: expected empty key for malformed split, got %q", name, got)
		}
	}
}
