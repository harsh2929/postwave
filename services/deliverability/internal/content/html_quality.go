// HTML-quality analyzer. Surfaces structural defects, accessibility gaps,
// and classic spam-evasion patterns (hidden text, tiny text, encoded
// characters disguising trigger words, etc.). Runs entirely in-process
// over the parsed `golang.org/x/net/html` tree.
package content

import (
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// AnalyzeHTMLQuality returns a list of human-readable issues. Empty list
// means the body has no findings worth surfacing.
func AnalyzeHTMLQuality(htmlStr string) []string {
	issues := []string{}
	if strings.TrimSpace(htmlStr) == "" {
		return issues
	}
	// Tag-balance check via the tokenizer (counts opens vs closes).
	if mismatch := mismatchedTags(htmlStr); mismatch > 0 {
		issues = append(issues, "mismatched HTML tags: "+strconv.Itoa(mismatch)+" unbalanced element(s)")
	}

	doc, err := html.Parse(strings.NewReader(htmlStr))
	if err != nil {
		return append(issues, "HTML failed to parse: "+err.Error())
	}

	hasUnsubscribe := false
	inlineCSSBytes := 0

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch strings.ToLower(n.Data) {
			case "img":
				if !hasAttr(n, "alt") {
					issues = append(issues, "image missing alt attribute")
				}
			case "a":
				href := getAttr(n, "href")
				if href == "" {
					issues = append(issues, "anchor without href")
				}
				if strings.Contains(strings.ToLower(textOf(n)), "unsubscribe") {
					hasUnsubscribe = true
				}
			case "script":
				issues = append(issues, "<script> tag will be stripped by mailbox providers")
			case "iframe":
				issues = append(issues, "<iframe> not supported in email clients")
			case "form":
				issues = append(issues, "<form> elements are flagged by most mailbox classifiers")
			}
			// Inline-style heaviness — tally bytes of style="..." content.
			if styleVal := getAttr(n, "style"); styleVal != "" {
				inlineCSSBytes += len(styleVal)
				if hidden := suspiciousStyle(styleVal, textOf(n)); hidden != "" {
					issues = append(issues, hidden)
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)

	if !hasUnsubscribe {
		issues = append(issues, "no visible 'unsubscribe' text found in body")
	}
	// Whole-source patterns the tree-walker can't easily express.
	if matched, _ := regexp.MatchString(`(?i)<font[^>]+color="?#?fff`, htmlStr); matched {
		issues = append(issues, "white-on-white text detected (classic spam evasion pattern)")
	}
	// Encoded characters disguising trigger terms (e.g. f&#114;ee, &#x66;ree).
	if matched, _ := regexp.MatchString(`&#\d+;|&#x[0-9a-f]+;`, strings.ToLower(htmlStr)); matched {
		// Only flag if encoded chars appear inside a word context (not just &amp; etc.)
		if regexp.MustCompile(`[a-z]&#\d+;[a-z]`).MatchString(strings.ToLower(htmlStr)) {
			issues = append(issues, "numeric character entities embedded mid-word (possible obfuscation)")
		}
	}
	if inlineCSSBytes > 10*1024 {
		issues = append(issues, "inline-style payload exceeds 10KB; consider hoisting to <style> blocks")
	}
	return issues
}

// suspiciousStyle inspects a style="..." value and returns a non-empty
// finding when it matches a known evasion pattern.
func suspiciousStyle(style, content string) string {
	low := strings.ToLower(style)
	low = strings.ReplaceAll(low, " ", "")
	hasContent := strings.TrimSpace(content) != ""
	if hasContent {
		// White-on-white text via inline style.
		if (strings.Contains(low, "color:#fff") || strings.Contains(low, "color:#ffffff") ||
			strings.Contains(low, "color:white")) &&
			(strings.Contains(low, "background:#fff") || strings.Contains(low, "background-color:#fff") ||
				strings.Contains(low, "background:white") || strings.Contains(low, "background-color:white") ||
				!strings.Contains(low, "background")) {
			// We can't always verify background here; flag color:#fff anywhere.
			if strings.Contains(low, "color:#fff") || strings.Contains(low, "color:#ffffff") || strings.Contains(low, "color:white") {
				return "hidden white text detected via inline style"
			}
		}
		// Tiny text: font-size <8px.
		if m := regexp.MustCompile(`font-size:\s*(\d+(?:\.\d+)?)px`).FindStringSubmatch(strings.ToLower(style)); m != nil {
			if n, err := strconv.ParseFloat(m[1], 64); err == nil && n < 8.0 {
				return "tiny font-size (<8px) used with content"
			}
		}
		// display:none with visible content.
		if strings.Contains(low, "display:none") {
			return "display:none on a node containing text content"
		}
		// visibility:hidden with content.
		if strings.Contains(low, "visibility:hidden") {
			return "visibility:hidden on a node containing text content"
		}
	}
	return ""
}

// mismatchedTags is a cheap balance check using the html tokenizer. Returns
// the absolute imbalance between opens and closes ignoring void elements.
func mismatchedTags(htmlStr string) int {
	z := html.NewTokenizer(strings.NewReader(htmlStr))
	void := map[string]bool{
		"area": true, "base": true, "br": true, "col": true, "embed": true, "hr": true,
		"img": true, "input": true, "link": true, "meta": true, "param": true,
		"source": true, "track": true, "wbr": true,
	}
	stack := []string{}
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		switch tt {
		case html.StartTagToken:
			name, _ := z.TagName()
			n := strings.ToLower(string(name))
			if !void[n] {
				stack = append(stack, n)
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			n := strings.ToLower(string(name))
			// Pop nearest matching open; if none, count as mismatch via stack imbalance later.
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i] == n {
					stack = append(stack[:i], stack[i+1:]...)
					break
				}
			}
		}
	}
	return len(stack)
}
