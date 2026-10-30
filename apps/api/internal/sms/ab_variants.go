// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"hash/fnv"
	"strings"
)

// ab_variants adds A/B message testing to SMS campaigns (SMS-036, bounded
// core). Variants ride on sms_campaigns.metadata (no migration) as:
//
//	"ab_variants": [
//	  {"label": "A", "body": "...", "weight": 60},
//	  {"label": "B", "body": "...", "weight": 40}
//	]
//
// At send time each recipient is bucketed deterministically by a stable hash
// of their phone number, so re-sends and reports agree on which variant a
// recipient received; the chosen variant label is stamped onto the recipient
// row's metadata for per-variant reporting (Store.CampaignVariantStats).
//
// Winner auto-selection, held-back rollout of the winning variant, and
// cross-table delivery/click attribution are intentionally out of this slice
// (see the SMS-036 audit note) — this delivers the variant-send + per-variant
// send-outcome foundation they build on.

const (
	abMinVariants = 2
	abMaxVariants = 5
)

// abVariant is one message variant with its split weight.
type abVariant struct {
	Label  string
	Body   string
	Weight int
}

// parseABVariants extracts A/B variants from campaign metadata. It returns nil
// (no A/B) unless at least abMinVariants variants carry a non-empty body, so a
// malformed or single-variant config transparently falls back to the campaign
// single-body send. Weights default to 1 (even split) and negatives are
// treated as 0.
func parseABVariants(meta map[string]any) []abVariant {
	if meta == nil {
		return nil
	}
	raw, ok := meta["ab_variants"].([]any)
	if !ok || len(raw) < abMinVariants {
		return nil
	}
	out := make([]abVariant, 0, len(raw))
	for i, item := range raw {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		body := strings.TrimSpace(stringFromMeta(m["body"]))
		if body == "" {
			continue
		}
		label := strings.TrimSpace(stringFromMeta(m["label"]))
		if label == "" {
			label = string(rune('A' + i))
		}
		weight := 1
		if w, ok := intFromMeta(m["weight"]); ok {
			if w < 0 {
				w = 0
			}
			weight = w
		}
		out = append(out, abVariant{Label: label, Body: body, Weight: weight})
		if len(out) >= abMaxVariants {
			break
		}
	}
	if len(out) < abMinVariants {
		return nil
	}
	return out
}

// pickVariant deterministically selects a variant for a phone using weighted
// buckets. A stable FNV hash keeps the assignment identical across the send
// loop, retries, and reporting. If all weights are zero it falls back to an
// even hash split so no recipient is ever left without a variant.
func pickVariant(variants []abVariant, phone string) abVariant {
	total := 0
	for _, v := range variants {
		total += v.Weight
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(phone))
	if total <= 0 {
		return variants[int(h.Sum32())%len(variants)]
	}
	bucket := int(h.Sum32() % uint32(total))
	acc := 0
	for _, v := range variants {
		acc += v.Weight
		if bucket < acc {
			return v
		}
	}
	return variants[len(variants)-1]
}
