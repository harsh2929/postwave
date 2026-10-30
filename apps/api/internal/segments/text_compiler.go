package segments

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// compileText is the deterministic, rules-based natural-language → AST
// compiler (SUB-064 engine=rules). It is intentionally conservative: it
// only emits an AST it can stand behind, and returns an error (mapped to
// HTTP 422 by the handler) when the phrase doesn't match a known pattern
// so the desktop can retry with engine=ai.
//
// The matcher order matters — more-specific patterns must come before
// the broad status fallbacks so e.g. "active subscribers tagged vip"
// resolves on the tag pattern, and a domain phrase wins over a bare
// status keyword. Each return carries (ast, rationale, suggested_name).
func compileText(text string) (map[string]any, string, string, error) {
	q := strings.ToLower(strings.TrimSpace(text))
	if q == "" {
		return nil, "", "", errors.New("text is required")
	}
	if hasExplicitBooleanComposition(q) || hasRepeatedRuleIntent(q) || countRuleIntents(q) > 1 {
		return nil, "", "", errors.New("this description contains multiple audience intents; use Try AI or the visual builder so every clause can be reviewed")
	}
	for _, match := range textMatchers {
		ast, rationale, name, ok, err := match(q)
		if err != nil {
			return nil, "", "", err
		}
		if ok {
			return ast, rationale, name, nil
		}
	}
	return nil, "", "", errors.New("could not safely compile this description; use the visual segment builder")
}

// textMatcher inspects one normalised phrase for one family of patterns. It
// returns ok=false to hand the phrase to the next family, or a non-nil error to
// stop the chain with a 422-class message.
type textMatcher func(q string) (ast map[string]any, rationale, name string, ok bool, err error)

// textMatchers is the ordered matcher chain compileText walks. The order is
// load-bearing (see the compileText doc comment): more-specific families come
// first and the broad status fallbacks stay near the end, with the email
// domain last so a status word in the same phrase still wins.
var textMatchers = []textMatcher{
	matchTierText,
	matchTagText,
	matchCountryText,
	matchLanguageText,
	matchNegativeOpenText,
	matchOpenText,
	matchClickText,
	matchColdText,
	matchLifecycleText,
	matchPredictiveText,
	matchStatusText,
	matchEmailDomainText,
}

func matched(ast map[string]any, rationale, name string) (map[string]any, string, string, bool, error) {
	return ast, rationale, name, true, nil
}

func unmatched() (map[string]any, string, string, bool, error) {
	return nil, "", "", false, nil
}

func matchFailed(message string) (map[string]any, string, string, bool, error) {
	return nil, "", "", false, errors.New(message)
}

// matchTierText — tier / plan membership.
func matchTierText(q string) (map[string]any, string, string, bool, error) {
	if strings.Contains(q, "premium") {
		return matched(condition("custom.tier", "equals", "premium"),
			"Matched the word premium to the custom tier field.",
			"Premium subscribers")
	}
	if strings.Contains(q, "free tier") || strings.Contains(q, "free plan") || strings.Contains(q, "free users") {
		return matched(condition("custom.tier", "equals", "free"),
			"Matched free tier/plan to the custom tier field.",
			"Free-tier subscribers")
	}
	return unmatched()
}

// matchTagText — tags (explicit verbs).
func matchTagText(q string) (map[string]any, string, string, bool, error) {
	if tag, ok := phraseValue(q, "tagged "); ok {
		return matched(condition("tag", "equals", tag),
			"Matched tagged <value> to subscriber tag membership.",
			titleName(tag+" tag"))
	}
	if tag, ok := phraseValue(q, "with tag "); ok {
		return matched(condition("tag", "equals", tag),
			"Matched with tag <value> to subscriber tag membership.",
			titleName(tag+" tag"))
	}
	if tag, ok := phraseValue(q, "tag "); ok {
		return matched(condition("tag", "equals", tag),
			"Matched tag <value> to subscriber tag membership.",
			titleName(tag+" tag"))
	}
	return unmatched()
}

// matchCountryText — country / location.
func matchCountryText(q string) (map[string]any, string, string, bool, error) {
	if country, ok := phraseValue(q, "in country "); ok {
		code, valid := normalizeCountry(country)
		if !valid {
			return matchFailed("country must be a 2-letter ISO country code or a supported country name")
		}
		return matched(condition("country", "equals", code),
			"Matched in country <value> to the subscriber country field.",
			titleName(country+" subscribers"))
	}
	if country, ok := phraseValue(q, "from "); ok && looksLikeCountry(country) {
		code, valid := normalizeCountry(country)
		if !valid {
			return matchFailed("country must be a 2-letter ISO country code or a supported country name")
		}
		return matched(condition("country", "equals", code),
			"Matched from <value> to the subscriber country field.",
			titleName(country+" subscribers"))
	}
	return unmatched()
}

// matchLanguageText — language.
func matchLanguageText(q string) (map[string]any, string, string, bool, error) {
	if lang, ok := phraseValue(q, "language "); ok {
		code, valid := normalizeLanguage(lang)
		if !valid {
			return matchFailed("language must be a 2-letter ISO language code or a supported language name")
		}
		return matched(condition("language", "equals", code),
			"Matched language <value> to the subscriber language field.",
			titleName(lang+" speakers"))
	}
	return unmatched()
}

// matchNegativeOpenText — engagement: cold / never (negative; checked before
// the positive "opened"/"clicked" families so "never opened" / "not opened"
// don't get swallowed by the positive-open patterns).
func matchNegativeOpenText(q string) (map[string]any, string, string, bool, error) {
	if strings.Contains(q, "never engaged") {
		return matched(condition("last_event_at", "is_null", nil),
			"Matched never engaged to a null last-engagement field.",
			"Never engaged")
	}
	if strings.Contains(q, "never opened") {
		return matched(condition("last_opened_at", "is_null", nil),
			"Matched never opened to a null last-opened field.",
			"Never opened")
	}
	if days, ok := windowDays(q, "not opened"); ok {
		return matched(condition("last_opened_at", "more_than_days_ago", days),
			"Matched no open within the last "+strconv.Itoa(days)+" days to the last-opened engagement field.",
			"Not opened in "+strconv.Itoa(days)+"d")
	}
	if strings.Contains(q, "not opened") || strings.Contains(q, "hasn't opened") || strings.Contains(q, "has not opened") {
		return matched(condition("last_opened_at", "more_than_days_ago", 30),
			"Matched not opened without an explicit window to no open in the last 30 days.",
			"Not opened in 30d")
	}
	return unmatched()
}

// matchOpenText — engagement: opens.
func matchOpenText(q string) (map[string]any, string, string, bool, error) {
	if days, ok := windowDays(q, "opened"); ok {
		return matched(condition("last_opened_at", "in_last_days", days),
			"Matched an open within the last "+strconv.Itoa(days)+" days to the last-opened engagement field.",
			"Opened in last "+strconv.Itoa(days)+"d")
	}
	if strings.Contains(q, "opened") || strings.Contains(q, "openers") {
		return matched(condition("last_opened_at", "in_last_days", 30),
			"Matched openers to a 30-day last-opened window.",
			"Recent openers (30d)")
	}
	return unmatched()
}

// matchClickText — engagement: clicks (negative forms first).
func matchClickText(q string) (map[string]any, string, string, bool, error) {
	if strings.Contains(q, "never clicked") {
		return matched(condition("last_clicked_at", "is_null", nil),
			"Matched never clicked to a null last-clicked field.",
			"Never clicked")
	}
	if days, ok := windowDays(q, "not clicked"); ok {
		return matched(condition("last_clicked_at", "more_than_days_ago", days),
			"Matched no click within the last "+strconv.Itoa(days)+" days to the last-clicked engagement field.",
			"Not clicked in "+strconv.Itoa(days)+"d")
	}
	if strings.Contains(q, "not clicked") || strings.Contains(q, "hasn't clicked") || strings.Contains(q, "has not clicked") {
		return matched(condition("last_clicked_at", "more_than_days_ago", 30),
			"Matched not clicked without an explicit window to no click in the last 30 days.",
			"Not clicked in 30d")
	}
	if days, ok := windowDays(q, "clicked"); ok {
		return matched(condition("last_clicked_at", "in_last_days", days),
			"Matched a click within the last "+strconv.Itoa(days)+" days to the last-clicked engagement field.",
			"Clicked in last "+strconv.Itoa(days)+"d")
	}
	if strings.Contains(q, "clicked") || strings.Contains(q, "clickers") {
		return matched(condition("last_clicked_at", "in_last_days", 30),
			"Matched clickers to a 30-day last-clicked window.",
			"Recent clickers (30d)")
	}
	return unmatched()
}

// matchColdText — engagement: cold / inactive / unengaged.
func matchColdText(q string) (map[string]any, string, string, bool, error) {
	if strings.Contains(q, "inactive") || strings.Contains(q, "unengaged") ||
		strings.Contains(q, "cold") || strings.Contains(q, "dormant") {
		return matched(condition("last_event_at", "more_than_days_ago", 60),
			"Matched inactive/cold/unengaged to a 60-day last-activity window.",
			"Cold subscribers (60d)")
	}
	return unmatched()
}

// matchLifecycleText — lifecycle: new / recently joined.
func matchLifecycleText(q string) (map[string]any, string, string, bool, error) {
	if days, ok := windowDays(q, "joined"); ok {
		return matched(condition("created_at", "gte", relWindow(days)),
			"Matched joined within the last "+strconv.Itoa(days)+" days to the created-at field.",
			"Joined in last "+strconv.Itoa(days)+"d")
	}
	if days, ok := windowDays(q, "signed up"); ok {
		return matched(condition("created_at", "gte", relWindow(days)),
			"Matched signed up within the last "+strconv.Itoa(days)+" days to the created-at field.",
			"Signed up in last "+strconv.Itoa(days)+"d")
	}
	if strings.Contains(q, "new subscriber") || strings.Contains(q, "new subscribers") ||
		strings.Contains(q, "recently joined") || strings.Contains(q, "recently signed up") {
		return matched(condition("created_at", "gte", "now-7d"),
			"Matched new/recently-joined to a 7-day created-at window.",
			"New subscribers (7d)")
	}
	return unmatched()
}

// matchPredictiveText — predictive churn risk, high value / CLV, RFM
// champions, and SMS consent.
func matchPredictiveText(q string) (map[string]any, string, string, bool, error) {
	if strings.Contains(q, "churn risk") || strings.Contains(q, "likely to churn") ||
		strings.Contains(q, "at risk") {
		return matched(condition("predictive.churn_risk", "gte", 0.7),
			"Matched churn risk to a predictive churn-risk threshold of 0.7.",
			"High churn risk")
	}
	if strings.Contains(q, "high value") || strings.Contains(q, "high-value") ||
		strings.Contains(q, "vip customer") || strings.Contains(q, "high clv") {
		return matched(condition("predictive.total_clv_cents", "gte", 5000),
			"Matched high-value/CLV to a predicted total CLV threshold of $50.",
			"High-value customers")
	}
	if strings.Contains(q, "champion") || strings.Contains(q, "best customer") {
		return matched(condition("rfm.segment_key", "equals", "champions"),
			"Matched champions/best-customers to the RFM champions bucket.",
			"Champions (RFM)")
	}
	if strings.Contains(q, "sms consent") || strings.Contains(q, "can receive sms") ||
		strings.Contains(q, "sms opted") || strings.Contains(q, "sms subscriber") {
		return matched(condition("channel_consent.sms", "equals", true),
			"Matched SMS consent to the per-channel SMS consent flag.",
			"Can receive SMS")
	}
	return unmatched()
}

// matchStatusText — status (broad fallbacks; keep late).
func matchStatusText(q string) (map[string]any, string, string, bool, error) {
	if strings.Contains(q, "unsubscribed") || strings.Contains(q, "disabled") || strings.Contains(q, "opted out") {
		if strings.Contains(q, "disabled") && !strings.Contains(q, "unsubscribed") && !strings.Contains(q, "opted out") {
			return matched(condition("status", "equals", "disabled"),
				"Matched disabled to the inactive subscriber status.",
				"Inactive subscribers")
		}
		return matched(condition("status", "equals", "blocklisted"),
			"Matched unsubscribed/opted-out to the blocklisted subscriber status.",
			"Unsubscribed subscribers")
	}
	if strings.Contains(q, "active") || strings.Contains(q, "enabled") || strings.Contains(q, "subscribed") {
		return matched(condition("status", "equals", "enabled"),
			"Matched active/enabled/subscribed to subscriber status.",
			"Active subscribers")
	}
	return unmatched()
}

// matchEmailDomainText — email domain (very specific; checked last so a
// status word in the same phrase still wins, but a bare "@acme.com" lands).
func matchEmailDomainText(q string) (map[string]any, string, string, bool, error) {
	if domain, ok := emailDomain(q); ok {
		return matched(condition("email", "ends_with", "@"+domain),
			"Matched the email domain to an email suffix filter.",
			titleName(domain+" subscribers"))
	}
	return unmatched()
}

func condition(field, comparator string, value any) map[string]any {
	return map[string]any{
		"op":         "condition",
		"field":      field,
		"comparator": comparator,
		"value":      value,
	}
}

func phraseValue(text, prefix string) (string, bool) {
	idx := strings.Index(text, prefix)
	if idx == -1 {
		return "", false
	}
	rest := strings.TrimSpace(text[idx+len(prefix):])
	if rest == "" {
		return "", false
	}
	value := strings.Fields(rest)[0]
	value = strings.Trim(value, ".,;:!?\"'")
	return value, value != ""
}

func emailDomain(text string) (string, bool) {
	for _, word := range strings.Fields(text) {
		word = strings.Trim(word, ".,;:!?\"'")
		if strings.Contains(word, "@") {
			parts := strings.SplitN(word, "@", 2)
			if len(parts) == 2 && strings.Contains(parts[1], ".") {
				return parts[1], true
			}
		}
	}
	if domain, ok := phraseValue(text, "domain "); ok && strings.Contains(domain, ".") {
		return domain, true
	}
	return "", false
}

// windowDays extracts an "N days/weeks/months" window that appears AFTER
// the verb phrase (e.g. "opened in the last 14 days"). Returns the window
// in days. When the verb is present but no explicit number is found, a
// sensible 30-day default is returned. ok is false when the verb phrase
// is absent entirely.
func windowDays(text, verb string) (int, bool) {
	idx := strings.Index(text, verb)
	if idx == -1 {
		return 0, false
	}
	rest := text[idx+len(verb):]
	if m := windowRE.FindStringSubmatch(rest); m != nil {
		n, _ := strconv.Atoi(m[1])
		if n <= 0 {
			return 30, true
		}
		switch {
		case strings.HasPrefix(m[2], "w"):
			return n * 7, true
		case strings.HasPrefix(m[2], "mo") || m[2] == "m" || strings.HasPrefix(m[2], "month"):
			return n * 30, true
		default:
			return n, true
		}
	}
	// Verb present, no explicit window — only treat as a windowed match
	// when the phrase contains a recency cue so plain "opened" still
	// hits the broad 30-day fallback in the caller instead.
	if strings.Contains(rest, "last ") || strings.Contains(rest, "past ") ||
		strings.Contains(rest, "recent") || strings.Contains(rest, "within") {
		return 30, true
	}
	return 0, false
}

// windowRE captures "14 days", "2 weeks", "3 months", "30d", "12w".
var windowRE = regexp.MustCompile(`(\d+)\s*(days?|d|weeks?|w|months?|mo|m)\b`)

func relWindow(days int) string {
	return "now-" + strconv.Itoa(days) + "d"
}

// countRuleIntents is a conservative ambiguity gate. The deterministic
// compiler deliberately produces one reviewed intent; returning the first
// match from a compound request would silently discard later AND/OR/NOT
// clauses. Compound descriptions therefore go to the explicit AI or visual
// builder paths, both of which preserve and display the whole boolean tree.
func countRuleIntents(q string) int {
	intents := []bool{
		strings.Contains(q, "premium") || strings.Contains(q, "free tier") || strings.Contains(q, "free plan") || strings.Contains(q, "free users"),
		strings.Contains(q, "tagged ") || strings.Contains(q, "with tag ") || strings.Contains(q, "tag "),
		strings.Contains(q, "in country ") || func() bool { country, ok := phraseValue(q, "from "); return ok && looksLikeCountry(country) }(),
		strings.Contains(q, "language "),
		strings.Contains(q, "opened") || strings.Contains(q, "openers") || strings.Contains(q, "hasn't opened") || strings.Contains(q, "has not opened") || strings.Contains(q, "never engaged"),
		strings.Contains(q, "clicked") || strings.Contains(q, "clickers") || strings.Contains(q, "hasn't clicked") || strings.Contains(q, "has not clicked"),
		hasAnyWord(q, "inactive", "unengaged", "cold", "dormant"),
		strings.Contains(q, "joined") || strings.Contains(q, "signed up") || strings.Contains(q, "new subscriber"),
		strings.Contains(q, "churn risk") || strings.Contains(q, "likely to churn") || strings.Contains(q, "at risk"),
		strings.Contains(q, "high value") || strings.Contains(q, "high-value") || strings.Contains(q, "vip customer") || strings.Contains(q, "high clv"),
		strings.Contains(q, "champion") || strings.Contains(q, "best customer"),
		strings.Contains(q, "sms consent") || strings.Contains(q, "can receive sms") || strings.Contains(q, "sms opted") || strings.Contains(q, "sms subscriber"),
		hasAnyWord(q, "unsubscribed", "disabled", "active", "enabled", "subscribed") || strings.Contains(q, "opted out"),
		func() bool { _, ok := emailDomain(q); return ok }(),
	}
	count := 0
	for _, matched := range intents {
		if matched {
			count++
		}
	}
	return count
}

func hasExplicitBooleanComposition(q string) bool {
	padded := " " + strings.Join(strings.Fields(q), " ") + " "
	return strings.Contains(padded, " and ") ||
		strings.Contains(padded, " or ") ||
		strings.Contains(padded, " but ") ||
		strings.Contains(padded, " except ") ||
		strings.Contains(padded, " unless ") ||
		strings.Contains(padded, " excluding ") ||
		strings.ContainsAny(q, ",;")
}

// hasRepeatedRuleIntent closes the remaining first-match ambiguity inside a
// single intent family. For example, "tagged vip tagged trial" has no boolean
// connector and countRuleIntents sees one tag family, but choosing the first
// tag would silently discard the second. Repeated family anchors are therefore
// escalated to AI/the visual builder just like explicit compound language.
func hasRepeatedRuleIntent(q string) bool {
	families := []*regexp.Regexp{
		regexp.MustCompile(`\b(?:premium|free\s+(?:tier|plan|users?))\b`),
		regexp.MustCompile(`\b(?:tagged|tag)\b`),
		regexp.MustCompile(`\b(?:in\s+country|from)\b`),
		regexp.MustCompile(`\blanguage\b`),
		regexp.MustCompile(`\b(?:opened|openers?)\b`),
		regexp.MustCompile(`\b(?:clicked|clickers?)\b`),
		regexp.MustCompile(`\b(?:joined|signed\s+up|new\s+subscribers?)\b`),
		regexp.MustCompile(`\b(?:unsubscribed|disabled|active|enabled|subscribed|opted\s+out)\b`),
	}
	for _, family := range families {
		if len(family.FindAllStringIndex(q, 2)) > 1 {
			return true
		}
	}
	return false
}

func hasAnyWord(text string, candidates ...string) bool {
	words := strings.FieldsFunc(text, func(r rune) bool {
		return !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'))
	})
	for _, word := range words {
		for _, candidate := range candidates {
			if word == candidate {
				return true
			}
		}
	}
	return false
}

func normalizeCountry(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) == 2 {
		return strings.ToUpper(value), true
	}
	codes := map[string]string{
		"usa": "US", "canada": "CA", "germany": "DE", "france": "FR",
		"spain": "ES", "india": "IN", "australia": "AU", "brazil": "BR",
		"japan": "JP", "mexico": "MX", "italy": "IT", "netherlands": "NL",
		"uk": "GB",
	}
	code, ok := codes[value]
	return code, ok
}

func normalizeLanguage(value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) == 2 {
		return value, true
	}
	codes := map[string]string{
		"english": "en", "french": "fr", "german": "de", "spanish": "es",
		"hindi": "hi", "italian": "it", "japanese": "ja", "portuguese": "pt",
	}
	code, ok := codes[value]
	return code, ok
}

// looksLikeCountry is a coarse gate so "from acme" (a vendor) does not
// land on the country pattern: we only treat a 2-letter ISO-ish token, or
// a small allow-list of common country words, as a country.
func looksLikeCountry(s string) bool {
	_, ok := normalizeCountry(s)
	return ok
}

func titleName(s string) string {
	parts := strings.Fields(strings.ReplaceAll(s, "-", " "))
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}
