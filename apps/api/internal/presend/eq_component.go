// SPDX-License-Identifier: AGPL-3.0-only

package presend

import (
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/eqscore"
)

const (
	// maxEQMessageReasons is how many causes the one-line message names. The
	// full list travels in Component.Reasons.
	maxEQMessageReasons = 3
	// maxComponentMessageBytes keeps a component message far inside the
	// 4,000-character bound the web and desktop decoders enforce, so a long
	// reason list can never make a whole verdict undecodable.
	maxComponentMessageBytes = 1000
)

// eqScoreComponent turns an EQ score into the verdict component.
//
// The message names what the score found — "The From domain (example.com) is
// not verified for this workspace…" — rather than a sentence that could
// describe any draft ("found a blocking content, sender-authentication, or
// reputation issue"). eqscore already sorts its reasons most severe first and
// writes each as a sentence for the sender; the verdict used to discard them.
func eqScoreComponent(res eqscore.Result) Component {
	score := float64(res.Score)
	component := Component{Name: "eq_score", Score: &score}
	switch {
	case res.Score < 40 || eqResultHasSeverity(res, "fail"):
		component.Status = "critical"
		component.Message = eqScoreMessage(res.Reasons, "fail",
			"Pre-send EQ Score found a blocking content, sender-authentication, or reputation issue.")
	case res.Score < 65 || eqResultHasSeverity(res, "warning"):
		component.Status = "warn"
		component.Message = eqScoreMessage(res.Reasons, "warning",
			"Pre-send EQ Score is below the recommended threshold; review content and sender authentication.")
	default:
		component.Status = "ok"
	}
	component.Reasons = actionableEQReasons(res.Reasons)
	return component
}

// eqScoreMessage joins the messages of the reasons at severity, most severe
// first. A score can be critical from accumulated warnings alone (below 40
// with no single failing reason), so a critical score with no "fail" reason
// names its warnings instead. fallback is used only when the score gave no
// reason at all.
func eqScoreMessage(reasons []eqscore.Reason, severity, fallback string) string {
	messages := reasonMessages(reasons, severity)
	if len(messages) == 0 && severity == "fail" {
		messages = reasonMessages(reasons, "warning")
	}
	if len(messages) == 0 {
		return fallback
	}
	shown := messages
	if len(shown) > maxEQMessageReasons {
		shown = shown[:maxEQMessageReasons]
	}
	message := strings.Join(shown, " ")
	if more := len(messages) - len(shown); more > 0 {
		message += " (+" + strconv.Itoa(more) + " more)"
	}
	return truncateMessage(message, maxComponentMessageBytes)
}

func reasonMessages(reasons []eqscore.Reason, severity string) []string {
	out := make([]string, 0, len(reasons))
	for _, reason := range reasons {
		if reason.Severity != severity {
			continue
		}
		if message := strings.TrimSpace(reason.Message); message != "" {
			out = append(out, message)
		}
	}
	return out
}

// actionableEQReasons keeps the failures and warnings — the reasons a sender
// can act on — in eqscore's most-severe-first order. Informational notes are
// left to the EQ score surface itself.
func actionableEQReasons(reasons []eqscore.Reason) []eqscore.Reason {
	var out []eqscore.Reason
	for _, reason := range reasons {
		if reason.Severity == "fail" || reason.Severity == "warning" {
			out = append(out, reason)
		}
	}
	return out
}

// truncateMessage shortens message to at most limit bytes on a rune boundary,
// marking the cut with an ellipsis.
func truncateMessage(message string, limit int) string {
	if len(message) <= limit {
		return message
	}
	const ellipsis = "…"
	cut := limit - len(ellipsis)
	for cut > 0 && !utf8.RuneStart(message[cut]) {
		cut--
	}
	return strings.TrimSpace(message[:cut]) + ellipsis
}
