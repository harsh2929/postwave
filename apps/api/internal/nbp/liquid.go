// SPDX-License-Identifier: AGPL-3.0-only
//
// Liquid helper bindings. Exposes the recommendation set as the
// `recommended_products` variable to the merge engine so authors
// can write:
//
//   {% for p in recommended_products %}
//     <a href="{{ p.url }}">{{ p.title }}</a>
//   {% endfor %}
//
// The merge package already supports {% for ... %} over arrays of
// maps; we just need to produce that shape and stuff it into the
// per-render Vars map.

package nbp

import (
	"context"
	"strings"
)

// InjectMergeVars looks up recommendations for the subscriber and
// writes them into the merge variable bag under the canonical key
// `recommended_products`. The value is a []map[string]any so the
// merge package's existing dotted-path loop ({{ p.title }}) works
// without any new filters.
//
// This function is intentionally tolerant: any internal error in
// the recommender silently falls back to an empty array. The
// caller's render path is never blocked.
func InjectMergeVars(ctx context.Context, recommender *Recommender, vars map[string]any, in RecommendInput) {
	if recommender == nil || vars == nil {
		// Ensure the key is at least defined so {% for %} doesn't
		// error on a missing variable. The merge engine treats a
		// missing key the same as an empty array, but being explicit
		// here keeps the template behaviour predictable across
		// future merge-engine refactors.
		if vars != nil {
			if _, ok := vars["recommended_products"]; !ok {
				vars["recommended_products"] = []map[string]any{}
			}
		}
		return
	}
	recs, _ := recommender.RecommendForSubscriber(ctx, in)
	out := make([]map[string]any, 0, len(recs))
	for _, r := range recs {
		out = append(out, map[string]any{
			"product_id":  r.ProductID,
			"title":       r.Title,
			"url":         r.URL,
			"image_url":   r.ImageURL,
			"price_cents": r.PriceCents,
			"currency":    r.Currency,
			"score":       r.Score,
			"strategy":    string(r.Strategy),
			"anchors":     r.Anchors,
		})
	}
	vars["recommended_products"] = out
}

// LiquidHelperName is the canonical key the helper writes into the
// merge variable bag. Exposed as a constant so test code + the
// compose-time autocomplete UI can reference the same string.
const LiquidHelperName = "recommended_products"

// SyntaxExample returns the canonical operator-facing snippet for the
// Settings > Personalization > Recommendations help text. Kept
// in code (not a CMS string) so the example always matches the
// merge engine's actual grammar.
func SyntaxExample() string {
	return strings.TrimSpace(`
{% for p in recommended_products %}
  <a href="{{ p.url }}">
    <img src="{{ p.image_url }}" alt="{{ p.title }}" />
    <strong>{{ p.title }}</strong>
  </a>
{% endfor %}
`)
}
