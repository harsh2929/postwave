// SPDX-License-Identifier: AGPL-3.0-only
//
// G10 (campaigns 2026): merge-tag preservation guardrail. When the
// voice service rewrites or varies copy that already carries
// {{merge_tag}} personalization tokens, the LLM occasionally drops or
// mangles them — which silently breaks personalization at send time.
// These helpers do a pre/post token diff so callers can reject or
// repair output that lost a required tag.

package aicompose

import (
	"regexp"
	"strings"
)

// mergeTagRe matches Listmonk/Moosewave merge tags: {{ first_name }},
// {{ .Subscriber.Name }}, {% if x %} is intentionally excluded — only
// the double-brace value tokens are personalization that must survive a
// rewrite verbatim.
var mergeTagRe = regexp.MustCompile(`{{[^{}]+}}`)

// extractMergeTags returns the set of distinct merge tags in s, keyed by
// a normalized form (inner whitespace collapsed) so "{{first_name}}" and
// "{{ first_name }}" are treated as the same token.
func extractMergeTags(s string) map[string]string {
	out := map[string]string{}
	for _, m := range mergeTagRe.FindAllString(s, -1) {
		out[normalizeMergeTag(m)] = m
	}
	return out
}

func normalizeMergeTag(tag string) string {
	inner := strings.TrimSuffix(strings.TrimPrefix(tag, "{{"), "}}")
	return strings.Join(strings.Fields(inner), " ")
}

// MissingMergeTags returns the merge tags present in `original` but
// absent from `generated` — i.e. the personalization tokens the LLM
// dropped. Comparison is whitespace-insensitive inside the braces.
// Returns nil when nothing was dropped.
func MissingMergeTags(original, generated string) []string {
	want := extractMergeTags(original)
	if len(want) == 0 {
		return nil
	}
	have := extractMergeTags(generated)
	var missing []string
	for norm, raw := range want {
		if _, ok := have[norm]; !ok {
			missing = append(missing, raw)
		}
	}
	return missing
}

// PreservesMergeTags reports whether `generated` retains every merge tag
// found in `original`. A true result means the rewrite is safe to use as
// far as personalization is concerned.
func PreservesMergeTags(original, generated string) bool {
	return len(MissingMergeTags(original, generated)) == 0
}
