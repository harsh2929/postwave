// SPDX-License-Identifier: AGPL-3.0-only
//
// Bloom-filter implementation for the recent-purchase dedupe set.
//
// Why a Bloom filter (matches Klaviyo's NBP design):
//
//   The recommender needs to answer "did this subscriber buy product
//   X in the last 2 years?" at render time, for many candidate X per
//   subscriber per send. A SQL EXISTS lookup against
//   commerce_order_items would round-trip per candidate and burn
//   tens of ms on a popular newsletter. A Bloom filter encodes the
//   purchase set in a small bytea blob we load once per subscriber,
//   then probe in constant time per candidate.
//
//   The false-positive cost is benign: a "false positive" here
//   means "we skip a product we actually could recommend" — the
//   recommender just picks the next best candidate. False
//   negatives are impossible (the defining property of Bloom
//   filters), so we never re-recommend a recently-bought product.
//
// Math:
//
//   For n items and target FPR p, the optimal parameters are:
//     m = -n * ln(p) / (ln(2))^2     bits
//     k = (m/n) * ln(2)              hashes (rounded to nearest int)
//
//   The Klaviyo default (n=100 items, p=0.01) gives m ≈ 959 bits
//   (120 bytes) and k = 7. We cap k at 16 to keep probe cost flat.
//
// Hashing:
//
//   We use the double-hashing trick (Kirsch-Mitzenmacher 2006):
//   only two independent hashes are computed per item, and the k
//   bit positions are derived as h1 + i*h2 mod m for i in 0..k-1.
//   This gives essentially the same FPR as k independent hashes
//   while avoiding the cost of k FNV passes.

package nbp

import (
	"errors"
	"hash/fnv"
	"math"
)

// Bloom is a fixed-size Bloom filter parameterised by (m, k).
type Bloom struct {
	bits []byte
	m    int // bit width
	k    int // hash functions
}

// SizeBloom returns the optimal (m bits, k hashes) for n expected
// items and target false-positive rate p. The returned m is rounded
// up to the next multiple of 8 so the bitfield aligns to bytes.
// k is clamped to [1, 16].
func SizeBloom(n int, p float64) (m, k int) {
	if n <= 0 {
		// Degenerate: pick a tiny filter so the bytea isn't empty.
		// The recommender treats item_count=0 rows specially anyway.
		return 8, 1
	}
	if p <= 0 || p >= 1 {
		p = 0.01
	}
	mFloat := -float64(n) * math.Log(p) / (math.Ln2 * math.Ln2)
	m = int(math.Ceil(mFloat))
	if m < 8 {
		m = 8
	}
	// Round up to the next byte boundary so bits aligns cleanly.
	if rem := m % 8; rem != 0 {
		m += 8 - rem
	}
	kFloat := math.Round((float64(m) / float64(n)) * math.Ln2)
	k = int(kFloat)
	if k < 1 {
		k = 1
	}
	if k > 16 {
		k = 16
	}
	return m, k
}

// NewBloom allocates an empty Bloom filter sized for n items at FPR p.
func NewBloom(n int, p float64) *Bloom {
	m, k := SizeBloom(n, p)
	return &Bloom{
		bits: make([]byte, m/8),
		m:    m,
		k:    k,
	}
}

// FromBytes reconstructs a Bloom filter from a persisted (bits, m, k)
// triple loaded from nbp_user_recent_bloom. Validates the shape so a
// truncated bytea doesn't silently corrupt probes.
func FromBytes(bits []byte, m, k int) (*Bloom, error) {
	if m <= 0 || k <= 0 {
		return nil, errors.New("nbp/bloom: invalid (m, k)")
	}
	if len(bits)*8 < m {
		return nil, errors.New("nbp/bloom: bits buffer smaller than declared m")
	}
	if k > 16 {
		return nil, errors.New("nbp/bloom: k > 16 (cap exceeded)")
	}
	// Copy so the caller's bytea slice can't mutate the filter.
	buf := make([]byte, len(bits))
	copy(buf, bits)
	return &Bloom{bits: buf, m: m, k: k}, nil
}

// Bits returns the packed bit array for persistence. The slice is
// a copy — callers can't mutate the filter through it.
func (b *Bloom) Bits() []byte {
	out := make([]byte, len(b.bits))
	copy(out, b.bits)
	return out
}

// M returns the bit width (the m parameter), suitable for storage in
// nbp_user_recent_bloom.bloom_m.
func (b *Bloom) M() int { return b.m }

// K returns the hash count.
func (b *Bloom) K() int { return b.k }

// Add inserts key into the filter. Subsequent Contains(key) returns
// true. Idempotent.
func (b *Bloom) Add(key string) {
	h1, h2 := doubleHash(key)
	for i := 0; i < b.k; i++ {
		idx := int((h1 + uint64(i)*h2) % uint64(b.m))
		b.bits[idx/8] |= 1 << uint(idx%8)
	}
}

// Contains probes for key. A true return is a "probably present" —
// the filter has a non-zero false-positive rate by construction.
// A false return is definitive ("not present").
func (b *Bloom) Contains(key string) bool {
	h1, h2 := doubleHash(key)
	for i := 0; i < b.k; i++ {
		idx := int((h1 + uint64(i)*h2) % uint64(b.m))
		if b.bits[idx/8]&(1<<uint(idx%8)) == 0 {
			return false
		}
	}
	return true
}

// EstimateFPR returns the expected false-positive rate of the
// filter at its current fill, assuming the population reported in
// itemCount. Useful for telemetry — if the Builder over-shot the
// item_count estimate, this number tells us how much headroom we
// have. Formula: (1 - exp(-k*n/m))^k.
func (b *Bloom) EstimateFPR(itemCount int) float64 {
	if itemCount <= 0 || b.m == 0 {
		return 0
	}
	x := 1 - math.Exp(-float64(b.k)*float64(itemCount)/float64(b.m))
	return math.Pow(x, float64(b.k))
}

// doubleHash returns two independent uint64 hashes of key using FNV-1a
// over (key) and (key + "\x00salt"). The Kirsch-Mitzenmacher result
// shows this approximates k independent hashes for Bloom purposes.
func doubleHash(key string) (uint64, uint64) {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	h1 := h.Sum64()
	h.Reset()
	_, _ = h.Write([]byte(key))
	_, _ = h.Write([]byte{0x00, 's', 'a', 'l', 't'})
	h2 := h.Sum64()
	if h2 == 0 {
		// Make sure h2 never zeros out — that would collapse the k
		// probes onto a single bit. Off-by-one is the cheapest fix.
		h2 = 1
	}
	return h1, h2
}
