package abtests

import (
	"crypto/sha256"
	"encoding/binary"
	"hash/fnv"
)

// AssignVariant deterministically picks a variant for (subscriberID, campaignID),
// respecting per-variant weights. Weights need not sum to 100 — they're
// normalized.
//
// The hash → bucket mapping is stable: re-calling with the same inputs returns
// the same VariantLabel forever. This is what lets us guarantee a recipient
// always sees the same variant across resends.
func AssignVariant(subscriberID, campaignID string, variants []Variant) string {
	if len(variants) == 0 {
		return ""
	}

	// Sum positive weights. Anything <=0 is ignored.
	var total float64
	for _, v := range variants {
		if v.Weight > 0 {
			total += v.Weight
		}
	}
	if total <= 0 {
		// All weights zero/negative — fall back to even split across the slice.
		idx := bucketIndex(subscriberID, campaignID, uint64(len(variants)))
		return variants[idx].VariantLabel
	}

	// Project the hash into [0, total). Then walk variants accumulating
	// weight; the first one to cross the target wins.
	const denom uint64 = 1 << 53 // safe for float64 mantissa
	bucket := bucketIndex(subscriberID, campaignID, denom)
	target := (float64(bucket) / float64(denom)) * total

	var cum float64
	for _, v := range variants {
		if v.Weight <= 0 {
			continue
		}
		cum += v.Weight
		if target < cum {
			return v.VariantLabel
		}
	}
	// Floating-point edge: return the last positive-weight variant.
	for i := len(variants) - 1; i >= 0; i-- {
		if variants[i].Weight > 0 {
			return variants[i].VariantLabel
		}
	}
	return variants[0].VariantLabel
}

// IsInSample deterministically decides whether a recipient belongs to the
// variant phase of an early-stopping test.  A value of 100 includes everyone;
// values below 100 reserve the remainder for the eventual winner rollout.
// This uses the same percent-bucket contract as campaigns.percentBucket so
// the winner rollout can select the exact complement without duplicates or
// omissions.
func IsInSample(subscriberID, campaignID string, samplePct float64) bool {
	if samplePct >= 100 {
		return true
	}
	if samplePct <= 0 {
		return false
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(campaignID))
	_, _ = h.Write([]byte{':'})
	_, _ = h.Write([]byte(subscriberID))
	bucket := int(h.Sum64() % 100)
	return bucket < int(samplePct)
}

func bucketIndex(subscriberID, campaignID string, mod uint64) uint64 {
	h := sha256.New()
	_, _ = h.Write([]byte(subscriberID))
	_, _ = h.Write([]byte{0x1f})
	_, _ = h.Write([]byte(campaignID))
	sum := h.Sum(nil)
	n := binary.BigEndian.Uint64(sum[:8])
	if mod == 0 {
		return 0
	}
	return n % mod
}
