// SPDX-License-Identifier: AGPL-3.0-only
//
// variant_assign.go — legacy email-keyed A/B reconstruction for old funnel
// rows that lack a send-time variant stamp.
//
// WHY a copy and not an import: apps/api does not depend on
// services/voice (separate module / service boundary — voice wraps the
// AGPL engine over HTTP). Duplicating the ~10 lines of hash here keeps
// the dependency graph clean; the parity is pinned by
// variant_assign_test.go, which asserts the bucket + arm-walk match the
// historical email-keyed buckets. Voice authoring previews now accept an
// opaque subscriber ID and intentionally use a different identity contract.
// This fallback is therefore NOT evidence of delivery/preview parity. A
// qualified dispatcher must stamp variant_key at send time (or migrate both
// sides to the same trustworthy opaque ID) before sequence delivery is enabled.
//
// Legacy reconstruction hash contract (keep stable for old unstamped rows):
//
//	key    = lower(trim(subscriber_email)) + "|" + sequence_id + "|p" + position
//	bucket = bigendian_uint64(sha256(key)[0:8]) % 10000
//
// then walk the variants in their stored order, accumulating weight_bp;
// the first variant whose cumulative weight exceeds the bucket wins.
package analytics

import (
	"crypto/sha256"
	"encoding/binary"
	"strconv"
	"strings"
)

// variantWeightTotalBP is the basis-point total an A/B split's weights
// must sum to (mirrors generation.VariantWeightTotalBP).
const variantWeightTotalBP = 10000

// FunnelVariant is the minimal arm shape the aggregation needs: the key
// it groups by and the weight that drives the deterministic walk. It is
// the (key, weight_bp) projection of generation.EmailVariant — the
// analytics package never needs the subject/body.
type FunnelVariant struct {
	Key      string
	WeightBP int
}

// assignVariantKey returns the variant key a subscriber is assigned for
// one email step using the legacy email-keyed reconstruction hash. It does not
// claim parity with the opaque-ID Voice preview. Returns "" when the variant list is empty or its
// weights do not sum to the expected total (a malformed split that the
// PATCH path would have rejected) — callers treat "" as "no variant
// breakdown for this row" rather than guessing an arm.
//
// position is the value the dispatcher passed to AssignVariant when it
// resolved the arm; the caller is responsible for supplying it in the
// same convention (see deriveVariantPosition in funnel aggregation).
func assignVariantKey(sequenceID string, position int, subscriberEmail string, variants []FunnelVariant) string {
	if len(variants) == 0 {
		return ""
	}
	sum := 0
	for _, v := range variants {
		if v.WeightBP < 1 || strings.TrimSpace(v.Key) == "" {
			return ""
		}
		sum += v.WeightBP
	}
	if sum != variantWeightTotalBP {
		return ""
	}
	bucket := variantBucket(sequenceID, position, subscriberEmail)
	acc := 0
	for _, v := range variants {
		acc += v.WeightBP
		if int(bucket) < acc {
			return v.Key
		}
	}
	// Unreachable when weights sum to 10000 (bucket < 10000); defensive.
	return variants[len(variants)-1].Key
}

// variantBucket maps (subscriber, sequence, position) onto [0, 10000).
// Byte-for-byte identical to generation.variantBucket.
func variantBucket(sequenceID string, position int, subscriberEmail string) uint64 {
	key := strings.ToLower(strings.TrimSpace(subscriberEmail)) +
		"|" + sequenceID +
		"|p" + strconv.Itoa(position)
	h := sha256.Sum256([]byte(key))
	return binary.BigEndian.Uint64(h[:8]) % variantWeightTotalBP
}
