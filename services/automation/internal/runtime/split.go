package runtime

import (
	"crypto/sha256"
	"encoding/binary"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// pickSplitVariant deterministically routes a subscriber down one leg of a
// percentage_split node. The bucket is a stable hash of the split key (a
// composite of automation+node+subscriber), so the SAME subscriber always
// takes the SAME leg on re-execution — no random(), which would make the
// at-least-once engine route a retried node down a different path.
//
// Variant percentages are treated as cumulative weights: a subscriber whose
// bucket (0-99) falls in [Σprev, Σprev+pct) takes that variant. Percentages
// need not sum to exactly 100 — any remainder routes to the last variant, so a
// graph that sums to <100 never drops a subscriber. Returns "" only when there
// are no variants (caller treats that as end-of-flow).
func pickSplitVariant(variants []canonical.AutomationSplitVariant, key string) string {
	if len(variants) == 0 {
		return ""
	}
	// #nosec G115 -- modulo 100 proves the result is in [0, 99].
	bucket := int(stableBucket(key, 100))
	cumulative := 0
	for _, v := range variants {
		pct := v.Percentage
		if pct < 0 {
			pct = 0
		}
		cumulative += pct
		if bucket < cumulative {
			return v.Next
		}
	}
	// Bucket beyond the summed weights (percentages < 100) → last leg.
	return variants[len(variants)-1].Next
}

// pickABVariant deterministically buckets a subscriber into one A/B variant,
// using the same stable-hash scheme as pickSplitVariant (so a retried node
// re-assigns the SAME variant). Unlike pickSplitVariant it returns the chosen
// variant itself — the engine needs its ID to record the assignment, plus its
// Next to route. Returns nil only when there are no variants.
func pickABVariant(variants []canonical.AutomationSplitVariant, key string) *canonical.AutomationSplitVariant {
	if len(variants) == 0 {
		return nil
	}
	// #nosec G115 -- modulo 100 proves the result is in [0, 99].
	bucket := int(stableBucket(key, 100))
	cumulative := 0
	for i := range variants {
		pct := variants[i].Percentage
		if pct < 0 {
			pct = 0
		}
		cumulative += pct
		if bucket < cumulative {
			return &variants[i]
		}
	}
	return &variants[len(variants)-1]
}

// stableBucket hashes key into [0, mod) deterministically (SHA-256 → first 8
// bytes → uint64 → mod). Stable across processes and restarts.
func stableBucket(key string, mod uint64) uint64 {
	if mod == 0 {
		return 0
	}
	sum := sha256.Sum256([]byte(key))
	return binary.BigEndian.Uint64(sum[:8]) % mod
}
