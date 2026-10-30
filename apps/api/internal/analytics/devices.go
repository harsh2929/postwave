package analytics

import "strings"

// ClassifyClient maps a User-Agent string to a coarse mail-client family.
// Order matters: Apple Mail strings frequently embed "Safari", and Outlook
// strings sometimes embed "MSIE", so we check the most specific markers
// first and fall through to "Other".
func ClassifyClient(ua string) string {
	s := strings.ToLower(ua)
	if s == "" {
		return "Other"
	}
	switch {
	case strings.Contains(s, "googleimageproxy") || strings.Contains(s, "gmail"):
		return "Gmail"
	case strings.Contains(s, "outlook") || strings.Contains(s, "microsoft office") ||
		strings.Contains(s, "msoffice"):
		return "Outlook"
	case strings.Contains(s, "applemail") || strings.Contains(s, "apple-mail") ||
		strings.Contains(s, "mail/") ||
		(strings.Contains(s, "iphone") && strings.Contains(s, "mobile")) ||
		strings.Contains(s, "ipad"):
		return "Apple Mail"
	case strings.Contains(s, "yahoo") || strings.Contains(s, "ymail"):
		return "Yahoo"
	default:
		return "Other"
	}
}

// CategorizeBounce maps a free-form bounce_type string to one of the
// canonical buckets used by the bounce report. Returns "" when the input
// does not look like a bounce classification at all.
func CategorizeBounce(bt string) string {
	s := strings.ToLower(strings.TrimSpace(bt))
	if s == "" {
		return ""
	}
	if strings.Contains(s, "trap") {
		return "spam_trap"
	}
	if s == "hard" || strings.HasPrefix(s, "5") {
		return "hard"
	}
	if s == "soft" || strings.HasPrefix(s, "4") {
		return "soft"
	}
	return ""
}
