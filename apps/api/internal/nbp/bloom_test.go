// SPDX-License-Identifier: AGPL-3.0-only
package nbp

import (
	"fmt"
	"testing"
)

func TestSizeBloomDefaults(t *testing.T) {
	// n=100 items, p=0.01: classic Bloom params yield m≈959, k=7.
	// After byte rounding we expect m in [960, 968].
	m, k := SizeBloom(100, 0.01)
	if m < 960 || m > 968 {
		t.Errorf("expected m near 960, got %d", m)
	}
	if m%8 != 0 {
		t.Errorf("m=%d not byte-aligned", m)
	}
	if k < 6 || k > 8 {
		t.Errorf("expected k near 7, got %d", k)
	}
}

func TestBloomNoFalseNegatives(t *testing.T) {
	b := NewBloom(500, 0.01)
	items := make([]string, 500)
	for i := range items {
		items[i] = fmt.Sprintf("product-%d", i)
		b.Add(items[i])
	}
	// Every inserted item MUST report present. This is the defining
	// property of Bloom filters — verifying it catches both broken
	// hashing and off-by-one bit-set bugs.
	for _, k := range items {
		if !b.Contains(k) {
			t.Fatalf("false negative for %q", k)
		}
	}
}

func TestBloomFalsePositiveRateBounded(t *testing.T) {
	const n = 500
	const target = 0.01
	b := NewBloom(n, target)
	for i := 0; i < n; i++ {
		b.Add(fmt.Sprintf("seen-%d", i))
	}
	// Probe 5_000 strings we never inserted; expect FPR well under
	// 10% (we set target 1% — some slack covers double-hashing
	// approximation quirks and the deterministic FNV hash family's
	// sampling variance at this scale). The point of this assertion
	// is to catch the catastrophic "we wired the bit indexing wrong"
	// regression where FPR explodes to 50%+, not to pin the exact
	// FPR — that would be flaky.
	const probes = 5000
	hits := 0
	for i := 0; i < probes; i++ {
		if b.Contains(fmt.Sprintf("unseen-%d", i)) {
			hits++
		}
	}
	rate := float64(hits) / float64(probes)
	if rate > 0.10 {
		t.Errorf("measured FPR %.4f exceeds 10%% ceiling", rate)
	}
}

func TestFromBytesRoundTrip(t *testing.T) {
	b := NewBloom(50, 0.01)
	b.Add("alpha")
	b.Add("beta")
	round, err := FromBytes(b.Bits(), b.M(), b.K())
	if err != nil {
		t.Fatalf("FromBytes: %v", err)
	}
	if !round.Contains("alpha") || !round.Contains("beta") {
		t.Fatal("round-trip lost an inserted key")
	}
	if round.M() != b.M() || round.K() != b.K() {
		t.Errorf("round-trip params drifted: got (m=%d, k=%d) want (m=%d, k=%d)",
			round.M(), round.K(), b.M(), b.K())
	}
}

func TestFromBytesValidatesShape(t *testing.T) {
	if _, err := FromBytes([]byte{0x00}, 64, 4); err == nil {
		t.Error("expected error for truncated bits buffer")
	}
	if _, err := FromBytes([]byte{0x00}, 8, 0); err == nil {
		t.Error("expected error for k=0")
	}
	if _, err := FromBytes([]byte{0x00}, 8, 17); err == nil {
		t.Error("expected error for k>16")
	}
}

func TestSizeBloomDegenerate(t *testing.T) {
	// n=0: should not panic, should return a minimal filter.
	m, k := SizeBloom(0, 0.01)
	if m < 8 || k < 1 {
		t.Errorf("degenerate SizeBloom returned (m=%d, k=%d)", m, k)
	}
	// Out-of-range p falls back to 1%.
	m, _ = SizeBloom(100, 0)
	if m == 0 {
		t.Error("SizeBloom returned m=0 for p=0 fallback")
	}
}
