// SPDX-License-Identifier: AGPL-3.0-only
//
// content.go — the content sub-score. All checks are pure-functional
// on Input.{Subject,HTML,Text}; no DNS, no DB. Score starts at 100 and
// each rule subtracts a small amount with a Reason attached, so the
// per-rule weighting stays visible in code review.

package eqscore

import (
	"regexp"
	"strings"
	"unicode"
)

// scoreContent grades the message body + subject. Returns a SubScore
// with .Weight unset (the caller sets the weight after picking the
// composition strategy).
func scoreContent(in Input) SubScore {
	score := 100
	reasons := []Reason{}

	subject := strings.TrimSpace(in.Subject)
	body := chooseBody(in)

	// Subject: empty.
	if subject == "" {
		score -= 25
		reasons = append(reasons, Reason{
			Code: "subject_empty", Severity: "fail", Bucket: "content",
			Message: "Subject line is empty. Most inbox providers down-rank or quarantine messages with no subject.",
		})
	}

	// Subject: all caps. We require > 6 letters before we flag so
	// short "FYI" / "FAQ" subjects don't trip the rule.
	if subject != "" && isMostlyUpper(subject) && countLetters(subject) > 6 {
		score -= 12
		reasons = append(reasons, Reason{
			Code: "subject_all_caps", Severity: "warning", Bucket: "content",
			Message: "Subject is all uppercase. ALL CAPS is one of the strongest spam signals at every major filter.",
		})
	}

	// Subject: excessive punctuation ("!!!", "!?!", ">>>").
	if hasExcessivePunctuation(subject) {
		score -= 8
		reasons = append(reasons, Reason{
			Code: "subject_punctuation", Severity: "warning", Bucket: "content",
			Message: "Subject contains repeated punctuation (e.g. \"!!!\"). Filter scores spike on runs of !, ?, or >.",
		})
	}

	// Subject: spammy phrase set (free money, act now, guaranteed, etc.).
	if hit := matchSpammyPhrase(subject); hit != "" {
		score -= 10
		reasons = append(reasons, Reason{
			Code: "subject_spammy_phrase", Severity: "warning", Bucket: "content",
			Message: "Subject contains a high-spam-correlation phrase (\"" + hit + "\"). Consider rewording.",
		})
	}

	// Image-only HTML check: images with little visible text may leave
	// recipients with no readable message when images are blocked. This
	// heuristic cannot distinguish a hero image from a tracking pixel.
	// Keep the historical reason code for existing consumers.
	if in.HTML != "" {
		text := strings.TrimSpace(stripTags(in.HTML))
		imgs := countTags(in.HTML, "img")
		if imgs > 0 && len(text) < 10 {
			score -= 30
			reasons = append(reasons, Reason{
				Code: "tracking_only_html", Severity: "fail", Bucket: "content",
				Message: "HTML contains images with little or no visible text. Add meaningful text so recipients can read the message when images are blocked.",
			})
			// We deliberately fall through to the rest of the checks so
			// other warnings (e.g. raw_ip_links inside the tracker URL)
			// can still be attached.
		}
	}

	// Body: empty. We only flag this when BOTH the HTML body strips
	// to nothing AND the text body is empty AND there's no image (so
	// a tracking-pixel-only message has already been caught above).
	if strings.TrimSpace(body) == "" && countTags(in.HTML, "img") == 0 {
		score -= 35
		reasons = append(reasons, Reason{
			Code: "body_empty", Severity: "fail", Bucket: "content",
			Message: "Message has no body content. Inbox providers treat empty bodies as spam probes.",
		})
		return SubScore{Score: clamp(score), Reasons: reasons}
	}

	// Body: too short. Anything under 60 chars of text body reads
	// like a phishing probe. Don't apply this when HTML is sent
	// (HTML emails carry the bulk of the content).
	textBody := strings.TrimSpace(in.Text)
	if in.HTML == "" && len(textBody) < 60 {
		score -= 8
		reasons = append(reasons, Reason{
			Code: "body_too_short", Severity: "warning", Bucket: "content",
			Message: "Body is under 60 characters. Short text-only messages without context score as probes.",
		})
	}

	// HTML: image-to-text ratio. Each <img> without enough surrounding
	// text trips a moderate deduction. Compute on a text approximation
	// of the HTML rather than the raw markup. Skipped when the
	// tracking-only check above already fired (no visible text at all).
	if in.HTML != "" {
		text := stripTags(in.HTML)
		imgs := countTags(in.HTML, "img")
		if imgs > 0 && len(text) >= 10 && len(text) < 50*imgs {
			score -= 10
			reasons = append(reasons, Reason{
				Code: "image_heavy", Severity: "warning", Bucket: "content",
				Message: "HTML uses many images relative to text. A 100% image email is the canonical spam shape; aim for at least 50 characters of text per image.",
			})
		}
	}

	// Links: too many raw-IP URLs.
	if rawIPs := countRawIPLinks(in.HTML, in.Text); rawIPs > 0 {
		score -= 6 + rawIPs // 1 raw IP -> -7, 2 -> -8, ...
		reasons = append(reasons, Reason{
			Code: "raw_ip_links", Severity: "warning", Bucket: "content",
			Message: "Message links to raw IP addresses. Reputable senders link to domain names; IP literals trigger phishing filters.",
		})
	}

	// Links: too many distinct domains (link farm).
	if domains := countLinkDomains(in.HTML, in.Text); domains > 10 {
		score -= 5
		reasons = append(reasons, Reason{
			Code: "many_link_domains", Severity: "warning", Bucket: "content",
			Message: "Message links to many distinct domains. Link-farm patterns trip Gmail and Outlook spam rules; keep destination domains under 10.",
		})
	}

	return SubScore{Score: clamp(score), Reasons: reasons}
}

// chooseBody picks the more substantive of HTML body text vs plain text.
func chooseBody(in Input) string {
	htmlText := stripTags(in.HTML)
	if len(htmlText) >= len(in.Text) {
		return htmlText
	}
	return in.Text
}

func clamp(n int) int {
	if n < 0 {
		return 0
	}
	if n > 100 {
		return 100
	}
	return n
}

// isMostlyUpper reports whether the letters in s are predominantly
// uppercase. We compute a ratio against alphabetic chars only so a
// subject with numbers + symbols doesn't dilute the test.
func isMostlyUpper(s string) bool {
	letters, upper := 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				upper++
			}
		}
	}
	if letters == 0 {
		return false
	}
	return float64(upper)/float64(letters) > 0.80
}

func countLetters(s string) int {
	n := 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			n++
		}
	}
	return n
}

var rePunctRun = regexp.MustCompile(`[!?>]{3,}|[!?][!?]{2,}`)

func hasExcessivePunctuation(s string) bool {
	return rePunctRun.MatchString(s)
}

// spammyPhrases is a small, conservative list of high-correlation
// patterns. We deliberately don't try to be exhaustive — false
// positives on legitimate marketing copy are worse than misses, and
// the auth + reputation sub-scores carry most of the deliverability
// signal.
var spammyPhrases = []string{
	"free money",
	"act now",
	"limited time only",
	"100% guaranteed",
	"risk free",
	"cash bonus",
	"earn $",
	"work from home",
	"viagra",
	"weight loss",
	"miracle cure",
	"nigerian prince",
}

// matchSpammyPhrase returns the lowercase phrase that matched, or ""
// for no match. Case-insensitive substring; we don't try to detect
// obfuscation (V1AGRA, w-e-i-g-h-t) because the false-positive cost
// gets ugly fast.
func matchSpammyPhrase(s string) string {
	low := strings.ToLower(s)
	for _, p := range spammyPhrases {
		if strings.Contains(low, p) {
			return p
		}
	}
	return ""
}

// stripTags removes HTML tags AND collapses whitespace. It's good
// enough for sub-scoring; the goal isn't perfect HTML parsing but a
// stable length comparison.
func stripTags(html string) string {
	if html == "" {
		return ""
	}
	var b strings.Builder
	inTag := false
	for _, r := range html {
		switch {
		case r == '<':
			inTag = true
		case r == '>':
			inTag = false
		case !inTag:
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// countTags counts non-self-closing tag opens by name. Case-insensitive.
func countTags(html, tagLower string) int {
	if html == "" {
		return 0
	}
	low := strings.ToLower(html)
	prefix := "<" + tagLower
	n := 0
	i := 0
	for {
		idx := strings.Index(low[i:], prefix)
		if idx < 0 {
			return n
		}
		// Require the next char to be whitespace, '/', or '>' so we
		// don't count "<imgsrc=..." matches or "<images>".
		j := i + idx + len(prefix)
		if j < len(low) {
			c := low[j]
			if c == ' ' || c == '\t' || c == '\n' || c == '/' || c == '>' {
				n++
			}
		}
		i = i + idx + len(prefix)
	}
}

// reIPLink matches http(s)://1.2.3.4 (with optional port + path).
var reIPLink = regexp.MustCompile(`https?://(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:/[^\s"'<>]*)?`)

func countRawIPLinks(html, text string) int {
	return len(reIPLink.FindAllStringIndex(html, -1)) +
		len(reIPLink.FindAllStringIndex(text, -1))
}

// reLink matches http(s)://host with as much of the host as we need.
var reLink = regexp.MustCompile(`https?://([^\s/?"'<>]+)`)

func countLinkDomains(html, text string) int {
	seen := map[string]struct{}{}
	for _, m := range reLink.FindAllStringSubmatch(html, -1) {
		seen[strings.ToLower(m[1])] = struct{}{}
	}
	for _, m := range reLink.FindAllStringSubmatch(text, -1) {
		seen[strings.ToLower(m[1])] = struct{}{}
	}
	return len(seen)
}
