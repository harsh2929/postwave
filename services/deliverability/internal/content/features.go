package content

// features.go — feature extraction for the logistic-regression spam scorer.
//
// The Extract function returns a fixed-length, fixed-order []float64 vector
// suitable for dot-product against the Weights vector in weights.go. The
// FeatureNames slice documents the meaning of every index — the two slices
// MUST stay aligned, and a runtime sanity check in init() in weights.go
// asserts len(Weights) == len(FeatureNames).
//
// Each feature is documented inline. Where applicable we normalise to a
// roughly comparable scale (typically [0,1] for ratios, log1p() / k for
// unbounded counts) so that hand-calibrated weights can stay in a small
// range and so that L2 regularisation in the calibrate tool treats every
// feature fairly.
//
// HTML parsing reuses helpers already in scanner.go (stripHTML, extractLinks,
// imageTextRatioStr, capsRatio, etc.) — we deliberately do not introduce a
// second HTML parser path. No new dependencies are added.

import (
	"math"
	"regexp"
	"strings"
	"unicode"
)

// FeatureCount is the number of features in the vector. Must equal
// len(FeatureNames) and len(Weights).
const FeatureCount = 25

// FeatureNames documents each index in the feature vector. Order is locked —
// re-ordering this slice silently invalidates every stored Weights vector.
var FeatureNames = [FeatureCount]string{
	"subject_length_chars",                       // 0  log1p(len) / 7.0
	"subject_caps_ratio",                         // 1  uppercase letters / total letters
	"subject_has_excessive_punctuation",          // 2  >=2 of !,?,$ or trailing !!! pattern
	"subject_word_count",                         // 3  log1p(n) / 4.0
	"subject_starts_with_re_or_fwd",              // 4  boolean — slight POSITIVE inbox signal (negative weight)
	"body_length_chars",                          // 5  log1p(len) / 10.0
	"body_link_count",                            // 6  log1p(n) / 4.0
	"body_link_density",                          // 7  links per 1000 chars, clamped at 50, then /50 to keep in [0,1]
	"body_image_count",                           // 8  log1p(n) / 4.0
	"body_image_to_text_ratio",                   // 9  <img> count * 200 / visible text len, clamped at 5
	"body_caps_ratio",                            // 10 uppercase letters / total letters in visible text
	"body_all_caps_word_count",                   // 11 count of all-caps words >=4 chars, clamped at 20
	"body_exclamation_density",                   // 12 ! per 1000 chars, clamped at 30
	"body_url_shortener_count",                   // 13 number of shortener hosts present
	"body_unicode_obfuscation",                   // 14 cyrillic-look-alike or zero-width chars present (boolean)
	"body_misspelled_words_proxy",                // 15 count of long char-repeat sequences (e.g. "freeeee")
	"urgency_phrase_count",                       // 16 act now / limited time / last chance ...
	"money_phrase_count",                         // 17 free / $$$ / no cost / earn money / %off ...
	"prize_phrase_count",                         // 18 winner / you've won / claim now / prize ...
	"pharma_phrase_count",                        // 19 viagra / weight loss / hot singles / xxx / ... (adult and pharma folded together — all "shady products" from an inbox standpoint)
	"from_display_name_mismatches_local_part",    // 20 count of brand-tokens in body suggesting impersonation
	"link_text_mismatches_href",                  // 21 count of anchors whose visible text host != href host
	"body_text_to_html_ratio",                    // 22 visible text length / html length — low is suspicious
	"subject_contains_re_pattern_without_thread", // 23 fake-reply pattern (set to 0 unless caller passes thread context)
	"intercept",                                  // 24 always 1.0; paired with bias weight
}

// Phrase lists for the count-style features. These are intentionally short,
// hand-curated, and case-insensitively matched. They are NOT exhaustive — the
// goal is to surface a stable count signal that the trained weight can
// amplify or attenuate, not to enumerate every spam phrase known to mankind.
var (
	urgencyPhrases = []string{
		"act now", "limited time", "last chance", "today only",
		"order now", "buy now", "expires today", "expires soon",
		"hurry", "don't miss", "don't wait", "while supplies last",
		"final notice", "urgent", "immediately", "right now",
	}
	moneyPhrases = []string{
		"free", "$$$", "no cost", "no fee", "earn money",
		"% off", "%off", "save big", "save up to", "lowest price",
		"cheap", "discount", "cash bonus", "extra income", "make money",
		"double your", "investment opportunity", "risk free", "risk-free",
		"100% free", "no obligation",
	}
	prizePhrases = []string{
		"winner", "you've won", "you have won", "claim now",
		"claim your prize", "prize", "selected", "congratulations you",
		"lottery", "jackpot", "reward", "you are the winner",
		"this is your lucky day",
	}
	pharmaPhrases = []string{
		// Pharma / weight-loss
		"viagra", "cialis", "weight loss", "lose pounds", "lose weight",
		"miracle cure", "all natural", "pharmacy", "prescription free",
		"diet pill", "anti-aging", "fat burner", "no prescription",
		// Adult / dating-scam (folded into the same bucket — these are all
		// "shady products/services" from a deliverability standpoint).
		"hot singles", "meet singles", "singles in your area",
		"adult content", "xxx", "escort",
	}
	// Brand tokens used to spot "display says PayPal but link/local-part is
	// random" patterns. We look for these tokens appearing in the visible
	// body text and count them — combined with link mismatches the model
	// can learn to weight impersonation attempts.
	brandTokens = []string{
		"paypal", "amazon", "apple", "microsoft", "google",
		"netflix", "fedex", "ups", "dhl", "irs", "bank of america",
		"chase", "wells fargo", "citibank", "venmo", "zelle",
	}
	// URL shorteners checked at the *string* level (not requiring HTML
	// parsing). Mirrors the curated list in link_reputation.go.
	shortenerHosts = []string{
		"bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "buff.ly",
		"is.gd", "tiny.cc", "rebrand.ly", "shorturl.at", "cutt.ly",
		"rb.gy", "lnkd.in", "youtu.be", "fb.me", "ift.tt",
		"po.st", "hyperurl.co", "tr.im", "snip.ly", "v.gd", "x.gd",
	}
)

var (
	// RE2 has no backreferences, so the "freeeee"-style run detector is a
	// hand-rolled scanner — see countRepeatedCharRuns below.
	httpURLRe     = regexp.MustCompile(`(?i)https?://[^\s"'<>)]+`)
	imgTagRe      = regexp.MustCompile(`(?is)<img\b[^>]*>`)
	excessPunctRe = regexp.MustCompile(`[!?$]`)
)

// ThreadContext lets callers pass optional thread metadata so the
// "claims to be a reply but no References header" feature can fire. When
// nil, feature 23 is forced to 0.
type ThreadContext struct {
	HasReferencesHeader bool
	HasInReplyTo        bool
}

// Extract returns a fixed-length feature vector. subject is the raw subject
// line; bodyHTML is the raw HTML body. thread may be nil — when nil, the
// "fake reply" feature is set to 0 (we can't tell without the header).
func Extract(subject, bodyHTML string, thread *ThreadContext) []float64 {
	out := make([]float64, FeatureCount)

	// --- subject features ----------------------------------------------------
	subj := subject
	subjLow := strings.ToLower(subj)
	subjLen := len(subj)
	out[0] = math.Log1p(float64(subjLen)) / 7.0       // ~normalised: 100 chars -> ~0.66
	out[1] = capsRatio(subj)                          // 0..1
	out[2] = boolFloat(hasExcessivePunctuation(subj)) // 0 or 1
	out[3] = math.Log1p(float64(wordsIn(subj))) / 4.0 // ~normalised: 30 words -> ~0.85
	out[4] = boolFloat(startsWithReOrFwd(subjLow))    // 0 or 1

	// --- body features (need stripped text + html string) -------------------
	bodyText := stripHTML(bodyHTML)
	bodyLow := strings.ToLower(bodyText)
	bodyHTMLLow := strings.ToLower(bodyHTML)
	bodyLen := len(bodyText)
	htmlLen := len(bodyHTML)

	out[5] = math.Log1p(float64(bodyLen)) / 10.0

	// link count: anchors + bare URLs in plaintext
	anchors := extractLinks(bodyHTML)
	bareURLs := httpURLRe.FindAllString(bodyText, -1)
	linkCount := len(anchors) + len(bareURLs)
	out[6] = math.Log1p(float64(linkCount)) / 4.0

	if bodyLen > 0 {
		// Per-1000-char link density, clamped at 50 (anything above
		// is degenerate — a 20-char body with a link). We then divide
		// by 50 so the feature lives in [0,1] alongside the other
		// ratio-style features. Without this normalization a single
		// link in a short body produced a feature value of ~20-50,
		// which dominated any reasonably weighted logit (the v0.1
		// hand-tuned weight was 0.02 specifically to compensate for
		// the un-normalized scale; the trained model now sees a
		// uniform [0,1] feature space and trains a more interpretable
		// weight).
		density := float64(linkCount) / float64(bodyLen) * 1000.0
		if density > 50 {
			density = 50
		}
		out[7] = density / 50.0
	}

	// image count + image/text ratio
	imgs := imgTagRe.FindAllString(bodyHTMLLow, -1)
	out[8] = math.Log1p(float64(len(imgs))) / 4.0
	itr := imageTextRatioStr(bodyHTML)
	if itr > 5 {
		itr = 5
	}
	out[9] = itr

	out[10] = capsRatio(bodyText)
	out[11] = clampFloat(float64(allCapsWordsLong(bodyText)), 0, 20)

	if bodyLen > 0 {
		excl := strings.Count(bodyText, "!")
		d := float64(excl) / float64(bodyLen) * 1000.0
		if d > 30 {
			d = 30
		}
		out[12] = d
	}

	out[13] = float64(countShorteners(bodyHTMLLow))
	out[14] = boolFloat(hasUnicodeObfuscation(bodyText))
	out[15] = float64(countRepeatedCharRuns(bodyLow))

	out[16] = float64(countPhrases(bodyLow, urgencyPhrases) + countPhrases(subjLow, urgencyPhrases))
	out[17] = float64(countPhrases(bodyLow, moneyPhrases) + countPhrases(subjLow, moneyPhrases))
	out[18] = float64(countPhrases(bodyLow, prizePhrases) + countPhrases(subjLow, prizePhrases))
	out[19] = float64(countPhrases(bodyLow, pharmaPhrases) + countPhrases(subjLow, pharmaPhrases))

	out[20] = float64(countBrandImpersonation(bodyLow, anchors))
	out[21] = float64(linkTextMismatchCount(anchors))

	if htmlLen > 0 {
		ratio := float64(bodyLen) / float64(htmlLen)
		if ratio > 1 {
			ratio = 1
		}
		out[22] = ratio
	}

	if thread != nil && startsWithReOrFwd(subjLow) &&
		!thread.HasReferencesHeader && !thread.HasInReplyTo {
		out[23] = 1
	}

	out[24] = 1.0 // intercept
	return out
}

// FeatureMap returns a map view of the extracted features keyed by
// FeatureNames. Useful for API responses and debugging.
func FeatureMap(vec []float64) map[string]float64 {
	m := make(map[string]float64, FeatureCount)
	for i := 0; i < FeatureCount && i < len(vec); i++ {
		m[FeatureNames[i]] = vec[i]
	}
	return m
}

// --- helpers ----------------------------------------------------------------

func boolFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// hasExcessivePunctuation: ≥2 of `!`, `?`, `$` collectively, or runs of `!!!`.
func hasExcessivePunctuation(s string) bool {
	if strings.Contains(s, "!!!") || strings.Contains(s, "???") {
		return true
	}
	hits := len(excessPunctRe.FindAllStringIndex(s, -1))
	return hits >= 2
}

func startsWithReOrFwd(lowSubject string) bool {
	t := strings.TrimSpace(lowSubject)
	return strings.HasPrefix(t, "re:") || strings.HasPrefix(t, "fwd:") ||
		strings.HasPrefix(t, "fw:")
}

// allCapsWordsLong counts words that are entirely uppercase letters and
// at least 4 chars long. Stricter than the legacy allCapsWords in scanner.go
// (which is ≥3) because the spec asks for ≥4 here.
func allCapsWordsLong(s string) int {
	n := 0
	for _, w := range strings.Fields(s) {
		if len(w) < 4 {
			continue
		}
		letters, ups := 0, 0
		for _, r := range w {
			if unicode.IsLetter(r) {
				letters++
				if unicode.IsUpper(r) {
					ups++
				}
			}
		}
		if letters >= 4 && ups == letters {
			n++
		}
	}
	return n
}

// countRepeatedCharRuns counts maximal runs of >=4 consecutive identical
// ASCII letters (case-insensitive). "freeeee" → 1, "ooohhh nooooo" → 1
// (only "ooooo" qualifies; "ooo" and "hhh" are 3 and below the threshold).
// We treat only ASCII letters to avoid false positives on emoji repeats.
func countRepeatedCharRuns(s string) int {
	const minRun = 4
	n := 0
	runLen := 0
	var prev byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		isLetter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if isLetter && c == prev {
			runLen++
			if runLen == minRun {
				n++
			}
			continue
		}
		runLen = 1
		prev = c
		if !isLetter {
			runLen = 0
			prev = 0
		}
	}
	return n
}

func countShorteners(htmlLow string) int {
	n := 0
	for _, h := range shortenerHosts {
		// Match the host only after a scheme prefix so "is.gd" doesn't trip
		// on "this.gdhi.com". `://` covers both http:// and https://.
		n += strings.Count(htmlLow, "://"+h+"/")
		// also catch a bare URL ending the link, e.g. "https://bit.ly"
		// without trailing slash. We require the next char (if present) to
		// not be alphanumeric so we don't match "bit.lyabc".
		key := "://" + h
		idx := 0
		for {
			i := strings.Index(htmlLow[idx:], key)
			if i < 0 {
				break
			}
			pos := idx + i + len(key)
			if pos == len(htmlLow) {
				n++
				break
			}
			c := htmlLow[pos]
			// already counted above when followed by '/'; here count only
			// when followed by a non-alphanumeric, non-dot terminator.
			if c != '/' && (c == ' ' || c == '"' || c == '\'' || c == '<' ||
				c == '\n' || c == '\r' || c == '\t' || c == ')' || c == ',') {
				n++
			}
			idx = pos
		}
	}
	return n
}

// hasUnicodeObfuscation returns true if the body contains zero-width chars
// or cyrillic letters that look like latin (a small, conservative subset
// of the Unicode confusables list — Wikipedia "IDN homograph attack").
func hasUnicodeObfuscation(s string) bool {
	for _, r := range s {
		switch r {
		// Zero-width: ZWSP, ZWNJ, ZWJ, BOM.
		case '\u200B', '\u200C', '\u200D', '\uFEFF':
			return true
		// Cyrillic confusables for lowercase Latin.
		case 'а', // а -> a
			'е', // е -> e
			'о', // о -> o
			'р', // р -> p
			'с', // с -> c
			'у', // у -> y
			'х': // х -> x
			return true
		// Cyrillic confusables for uppercase Latin.
		case 'А', // А -> A
			'В', // В -> B
			'Е', // Е -> E
			'К', // К -> K
			'М', // М -> M
			'Н', // Н -> H
			'О', // О -> O
			'Р', // Р -> P
			'С', // С -> C
			'Т', // Т -> T
			'Х': // Х -> X
			return true
		}
	}
	return false
}

func countPhrases(low string, phrases []string) int {
	n := 0
	for _, p := range phrases {
		if p == "" {
			continue
		}
		n += strings.Count(low, p)
	}
	return n
}

// countBrandImpersonation counts brand tokens that appear in the body text
// only when at least one anchor host does NOT contain that brand. The
// intuition: "Click here to log in to PayPal" with a link to
// `paypal-secure.example.ru` should fire; "PayPal blog post" with a link to
// `paypal.com` should not.
func countBrandImpersonation(bodyLow string, anchors []anchor) int {
	if len(anchors) == 0 {
		return 0
	}
	hosts := make([]string, 0, len(anchors))
	for _, a := range anchors {
		h := strings.ToLower(hostOf(a.Href))
		if h != "" {
			hosts = append(hosts, h)
		}
	}
	n := 0
	for _, brand := range brandTokens {
		if !strings.Contains(bodyLow, brand) {
			continue
		}
		hasMatchingHost := false
		brandKey := strings.ReplaceAll(brand, " ", "")
		for _, h := range hosts {
			if strings.Contains(h, brandKey) {
				hasMatchingHost = true
				break
			}
		}
		if !hasMatchingHost {
			n++
		}
	}
	return n
}

// linkTextMismatchCount counts anchors whose visible text *looks like* a URL
// or brand and whose host disagrees with the href host.
func linkTextMismatchCount(anchors []anchor) int {
	n := 0
	for _, a := range anchors {
		hrefHost := strings.ToLower(hostOf(a.Href))
		display := strings.ToLower(strings.TrimSpace(a.Display))
		if display == "" || hrefHost == "" {
			continue
		}
		// (1) display looks like a URL but resolves to a different host
		if looksLikeURL(display) {
			displayHost := strings.ToLower(hostOf(display))
			if displayHost != "" && displayHost != hrefHost &&
				!hostsRelated(displayHost, hrefHost) {
				n++
				continue
			}
		}
		// (2) display contains a brand token but href host doesn't
		for _, brand := range brandTokens {
			brandKey := strings.ReplaceAll(brand, " ", "")
			if strings.Contains(display, brand) && !strings.Contains(hrefHost, brandKey) {
				n++
				break
			}
		}
	}
	return n
}

// hostOf returns the host portion of a URL-ish string. We intentionally do
// not import net/url here to keep this file independent of scanner.go's
// helpers — but stripHTML/extractLinks below ARE in scanner.go.
func hostOf(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if i := strings.Index(s, "@"); i >= 0 { // strip userinfo
		s = s[i+1:]
	}
	if i := strings.LastIndex(s, ":"); i >= 0 { // strip port
		s = s[:i]
	}
	return s
}

// hostsRelated returns true when two hosts share their last two labels
// (so "mail.paypal.com" vs "paypal.com" doesn't trigger a mismatch).
func hostsRelated(a, b string) bool {
	if a == b {
		return true
	}
	return strings.HasSuffix(a, "."+b) || strings.HasSuffix(b, "."+a)
}
