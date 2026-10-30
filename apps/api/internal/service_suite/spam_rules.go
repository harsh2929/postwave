// SPDX-License-Identifier: AGPL-3.0-only
//
// spam_rules.go is a deterministic, rule-based spam scorer. The spam-assessment
// endpoint only stored an operator-supplied verdict; this auto-scores inbound
// messages as they are mirrored into the support spine. No AI dependency — pure
// heuristics so it is unit-testable and stable.
package service_suite

import (
	"regexp"
	"strings"
)

var (
	spamTagRe  = regexp.MustCompile(`(?is)<[^>]+>`)
	spamLinkRe = regexp.MustCompile(`(?i)https?://`)
	spamWordRe = regexp.MustCompile(`(?i)\b(viagra|cialis|casino|lottery|jackpot|crypto\s*giveaway|bitcoin\s*doubl|wire\s*transfer|nigerian\s*prince|you\s*have\s*won|claim\s*your\s*prize|act\s*now|risk[-\s]?free|100%\s*free|earn\s*\$|work\s*from\s*home|weight\s*loss|enlarge)\b`)
)

// ScoreSpam scores one message 0..100 and returns a verdict (>=80 spam, >=50
// review, else ham) with a signals map explaining the score. knownSubscriber
// dampens the score: a message from a recognized subscriber is far less likely
// to be spam.
func ScoreSpam(msg Message, knownSubscriber bool) SpamAssessment {
	body := strings.TrimSpace(msg.BodyText)
	if body == "" {
		body = strings.TrimSpace(spamTagRe.ReplaceAllString(msg.BodyHTML, " "))
	}
	signals := map[string]any{}
	score := 0

	// Link density — count distinct link markers across text + raw HTML.
	links := len(spamLinkRe.FindAllString(msg.BodyText+" "+msg.BodyHTML, -1))
	if links >= 10 {
		score += 35
		signals["links"] = links
	} else if links >= 5 {
		score += 20
		signals["links"] = links
	}

	// Spam keyword hits.
	if kw := spamWordRe.FindAllString(strings.ToLower(body), -1); len(kw) > 0 {
		add := 15 * len(kw)
		if add > 45 {
			add = 45
		}
		score += add
		signals["keyword_hits"] = len(kw)
	}

	// ALL-CAPS shouting (only meaningful on a body with enough letters).
	if upper, total := letterCaseCounts(body); total >= 20 && float64(upper)/float64(total) >= 0.6 {
		score += 20
		signals["all_caps"] = true
	}

	// Very short body that is essentially "click this link".
	if links >= 1 && len([]rune(body)) <= 40 {
		score += 20
		signals["link_only"] = true
	}

	// Unknown sender — not a recognized subscriber.
	if !knownSubscriber {
		score += 15
		signals["unknown_sender"] = true
	} else {
		// Strong ham signal: recognized subscribers rarely send spam.
		score -= 20
		signals["known_subscriber"] = true
	}

	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}
	verdict := "ham"
	switch {
	case score >= 80:
		verdict = "spam"
	case score >= 50:
		verdict = "review"
	}
	return SpamAssessment{
		Score:      score,
		Verdict:    verdict,
		Signals:    signals,
		AssessedBy: "rule",
	}
}

// letterCaseCounts returns (uppercase letters, total letters) in s.
func letterCaseCounts(s string) (upper, total int) {
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z':
			upper++
			total++
		case r >= 'a' && r <= 'z':
			total++
		}
	}
	return upper, total
}
