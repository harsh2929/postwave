// variants.go — step-level A/B variant validation + deterministic
// per-enrollment assignment (roadmap: sequence A/B branches).
//
// Assignment is a pure hash over (opaque subscriber id, sequence id, step
// position): no assignment table is needed because the same inputs
// always yield the same variant, across processes and restarts. The
// external sequence dispatcher (the sequence_funnel_events producer
// named in migration 0052) resolves the arm either by calling
// POST /v1/voice/sequences/{id}/steps/{position}/variant or by
// reimplementing this exact hash (documented below).
//
// Hash contract (KEEP STABLE — changing it reshuffles every live test):
//
//	key    = trim(subscriber_id) + "|" + sequence_id + "|p" + position
//	bucket = bigendian_uint64(sha256(key)[0:8]) % 10000
//
// then walk the variants in their stored order, accumulating weight_bp;
// the first variant whose cumulative weight exceeds the bucket wins.
package generation

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Variant split bounds. WeightBP values are basis points: the per-step
// sum must be exactly VariantWeightTotalBP.
const (
	VariantMin           = 2
	VariantMax           = 4
	VariantWeightTotalBP = 10000
	variantKeyMaxRunes   = 32
)

// ErrNoVariants is returned by AssignVariant when the step carries no
// variant list (callers should fall back to the step's base content).
var ErrNoVariants = errors.New("generation: step has no variants")

// ValidateVariants enforces the A/B split contract on one email step:
// 2..4 variants, unique non-empty keys, each arm with usable content
// and a positive weight, weights summing to exactly 10000 bp.
// An empty slice is valid — it means "no A/B test on this step".
func ValidateVariants(variants []EmailVariant) error {
	if len(variants) == 0 {
		return nil
	}
	if len(variants) < VariantMin {
		return fmt.Errorf("variants: at least %d variants required for an A/B split (got %d)", VariantMin, len(variants))
	}
	if len(variants) > VariantMax {
		return fmt.Errorf("variants: at most %d variants allowed (got %d)", VariantMax, len(variants))
	}
	seen := make(map[string]struct{}, len(variants))
	sum := 0
	for i, v := range variants {
		key := strings.TrimSpace(v.Key)
		if key == "" {
			return fmt.Errorf("variants[%d]: key required", i)
		}
		if utf8.RuneCountInString(key) > variantKeyMaxRunes {
			return fmt.Errorf("variants[%d]: key too long (max %d characters)", i, variantKeyMaxRunes)
		}
		lower := strings.ToLower(key)
		if _, dup := seen[lower]; dup {
			return fmt.Errorf("variants[%d]: duplicate key %q", i, key)
		}
		seen[lower] = struct{}{}
		if strings.TrimSpace(v.Subject) == "" {
			return fmt.Errorf("variants[%d] (%s): subject required", i, key)
		}
		if strings.TrimSpace(v.Body) == "" && strings.TrimSpace(v.BodyHTML) == "" {
			return fmt.Errorf("variants[%d] (%s): body or body_html required", i, key)
		}
		if v.WeightBP < 1 {
			return fmt.Errorf("variants[%d] (%s): weight_bp must be >= 1", i, key)
		}
		sum += v.WeightBP
	}
	if sum != VariantWeightTotalBP {
		return fmt.Errorf("variants: weight_bp values must sum to %d (got %d)", VariantWeightTotalBP, sum)
	}
	return nil
}

// AssignVariant deterministically picks the variant a subscriber sees
// for one email step. Same inputs always return the same variant (see
// the package-level hash contract), so resends, retries, and stats
// attribution stay stable without an assignment table.
//
// The variant list is validated first so a malformed split (weights
// not summing to 10000) fails loudly instead of skewing silently.
func AssignVariant(sequenceID string, stepPosition int, subscriberID string, variants []EmailVariant) (EmailVariant, error) {
	if len(variants) == 0 {
		return EmailVariant{}, ErrNoVariants
	}
	if err := ValidateVariants(variants); err != nil {
		return EmailVariant{}, err
	}
	bucket := variantBucket(sequenceID, stepPosition, subscriberID)
	acc := 0
	for _, v := range variants {
		acc += v.WeightBP
		if int(bucket) < acc {
			return v, nil
		}
	}
	// Unreachable when weights sum to 10000 (bucket < 10000), kept as a
	// defensive fallback.
	return variants[len(variants)-1], nil
}

// variantBucket maps (subscriber, sequence, step) onto [0, 10000).
func variantBucket(sequenceID string, stepPosition int, subscriberID string) uint64 {
	key := strings.TrimSpace(subscriberID) +
		"|" + sequenceID +
		"|p" + strconv.Itoa(stepPosition)
	sum := sha256.Sum256([]byte(key))
	return binary.BigEndian.Uint64(sum[:8]) % VariantWeightTotalBP
}
