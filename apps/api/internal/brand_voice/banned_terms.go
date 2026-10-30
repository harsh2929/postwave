// SPDX-License-Identifier: AGPL-3.0-only
//
// G10 follow-up: derive banned terms from authored writing rules so the
// voice-service drift check can penalize off-voice wording. Operators
// write rules like "Avoid the word 'cheap'" or "Never say synergy" —
// this pulls the quoted/trailing term out so the drift overlay
// (services/voice authoredAdjustment) has something concrete to match.

package brand_voice

import (
	"regexp"
	"strings"
)

// banExpr matches the term after a prohibition cue. Captures a quoted
// phrase first, else the run of words after the cue.
var banExpr = regexp.MustCompile(
	`(?i)\b(?:avoid|never use|never say|don'?t use|don'?t say|do not use|do not say|no)\b[:\s]+(?:the (?:word|phrase) )?["']?([^"'.;,\n]{2,40})["']?`)

// BannedTermsFromRules extracts lowercased banned terms from free-text
// writing rules. Returns nil when none are found. Deduplicated, capped.
func BannedTermsFromRules(rules []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, rule := range rules {
		for _, m := range banExpr.FindAllStringSubmatch(rule, -1) {
			term := strings.ToLower(strings.TrimSpace(m[1]))
			// Trim a trailing helper word the regex may grab ("the word X").
			term = strings.TrimPrefix(term, "the word ")
			term = strings.TrimPrefix(term, "the phrase ")
			term = strings.TrimSpace(term)
			if len(term) < 2 {
				continue
			}
			if _, dup := seen[term]; dup {
				continue
			}
			seen[term] = struct{}{}
			out = append(out, term)
			if len(out) >= 20 {
				return out
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
