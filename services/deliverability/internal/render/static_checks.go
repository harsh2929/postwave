// Source-level advisories for things a browser simulation cannot prove about
// an inbox. These are review prompts, not predictions of actual client output.
// In particular, Gmail supports standard CSS media queries:
// https://developers.google.com/workspace/gmail/design/css

package render

import (
	"regexp"
	"strings"
)

// RunStaticChecks returns the issue list for a single environment. The
// HCTI client (and the MockRenderer) call this before screenshotting so
// the UI can suggest real-inbox checks when a screenshot looks fine.
func RunStaticChecks(env Environment, html string) []string {
	low := strings.ToLower(html)
	var issues []string

	switch env.Name {
	case "outlook_2019_desktop":
		issues = append(issues, outlookDesktopChecks(low)...)
	case "outlook_365_web":
		// Positioning in a mail message should be tested in the actual client.
		if strings.Contains(low, "position:absolute") || strings.Contains(low, "position: absolute") {
			issues = append(issues, "Absolute positioning detected. Verify the layout in a real Outlook Web inbox.")
		}
	case "outlook_macos":
		if regexp.MustCompile(`@media[^{]*\{`).MatchString(low) {
			issues = append(issues, "Media queries detected. Verify responsive behavior in the installed Outlook for Mac version.")
		}
	case "apple_mail_macos_light":
		if strings.Contains(low, "@font-face") {
			issues = append(issues, "Custom web font detected. Provide a system-font fallback and verify the actual inbox render.")
		}
	case "apple_mail_macos_dark":
		issues = append(issues, appleDarkModeChecks(low)...)
	case "apple_mail_ios":
		if strings.Contains(low, "@font-face") {
			issues = append(issues, "Custom web font detected. Provide a system-font fallback and verify the actual inbox render.")
		}
	case "gmail_web_promotions":
		issues = append(issues, gmailPromotionsChecks(low)...)
	case "gmail_ios":
		if styleBlockSize(html) > 16384 {
			issues = append(issues, "Combined <style> blocks exceed 16 KiB. Review generated CSS size and verify styling in a real Gmail iOS inbox.")
		}
	case "yahoo_web":
		// Complex layout features are worth a real-client check.
		if strings.Contains(low, "display:flex") || strings.Contains(low, "display: flex") ||
			strings.Contains(low, "display:grid") || strings.Contains(low, "display: grid") {
			issues = append(issues, "Flex or grid layout detected. Verify a table-layout fallback in a real Yahoo Mail inbox.")
		}
	case "proton_mail_web":
		if regexp.MustCompile(`<img[^>]+src="https?://`).MatchString(low) {
			issues = append(issues, "Remote images detected. Verify the message remains readable when the recipient blocks images.")
		}
		if strings.Contains(low, "tracking") || strings.Contains(low, "open.png") || strings.Contains(low, "pixel.gif") {
			issues = append(issues, "Possible tracking pixel detected. Open tracking can be blocked and must not be treated as a reliable readership count.")
		}
	}

	return issues
}

func outlookDesktopChecks(low string) []string {
	var issues []string
	if strings.Contains(low, "background-image") && bodyHasBackgroundImage(low) {
		issues = append(issues, "Outlook 2019 ignores background-image on <body>; use VML or a fallback background-color.")
	}
	if strings.Contains(low, "position:absolute") || strings.Contains(low, "position: absolute") {
		issues = append(issues, "position:absolute is not supported in Outlook 2019.")
	}
	if strings.Contains(low, "display:flex") || strings.Contains(low, "display: flex") {
		issues = append(issues, "flexbox is not supported in Outlook 2019; use table-based layout.")
	}
	if strings.Contains(low, "display:grid") || strings.Contains(low, "display: grid") {
		issues = append(issues, "CSS grid is not supported in Outlook 2019.")
	}
	if strings.Contains(low, "<svg") {
		issues = append(issues, "SVG is not rendered in Outlook 2019; export as PNG with @2x sizing.")
	}
	if strings.Contains(low, "border-radius") {
		issues = append(issues, "border-radius is ignored in Outlook 2019; corners will appear square.")
	}
	if strings.Contains(low, "@media") {
		issues = append(issues, "@media queries are ignored in Outlook 2019 — make the desktop layout the default.")
	}
	if strings.Contains(low, "animation:") || strings.Contains(low, "@keyframes") {
		issues = append(issues, "CSS animations are not supported in Outlook 2019.")
	}
	return issues
}

func appleDarkModeChecks(low string) []string {
	var issues []string
	// Detect light-mode-only color choices that Apple Mail will auto-invert
	// (sometimes incorrectly): pure-white backgrounds + dark text on
	// images/buttons that contain the brand identity.
	if strings.Contains(low, "background-color:#ffffff") || strings.Contains(low, "background:#ffffff") ||
		strings.Contains(low, "background-color:white") || strings.Contains(low, "background: white") {
		issues = append(issues, "Pure-white background detected. Verify color contrast in a real Apple Mail dark-mode inbox; automatic color changes can vary.")
	}
	if !strings.Contains(low, "color-scheme") {
		issues = append(issues, "No color-scheme declaration found. Review dark-mode behavior in a real Apple Mail inbox.")
	}
	if strings.Contains(low, "<img") && !strings.Contains(low, "media (prefers-color-scheme: dark)") {
		issues = append(issues, "Images detected without an explicit dark-mode variant. Verify logos remain legible in Apple Mail dark mode.")
	}
	return issues
}

// gmailPromotionsChecks reports visible content characteristics only. Inbox
// placement cannot be inferred from HTML alone; it requires an actual send.
func gmailPromotionsChecks(low string) []string {
	var issues []string
	imgs := strings.Count(low, "<img")
	textLen := visibleTextLength(low)
	// Approximate "image-heavy": each <img> ~ 200 chars equivalent (matches
	// the heuristic used by content/scanner.go's ImageTextRatio).
	imageWeight := float64(imgs * 200)
	totalWeight := imageWeight + float64(textLen)
	if totalWeight > 0 && imageWeight/totalWeight > 0.40 {
		issues = append(issues, "Image-heavy body: verify readability with images blocked and run a real inbox-placement test.")
	}
	hits := 0
	for _, t := range gmailPromoTriggers {
		if strings.Contains(low, t) {
			hits++
		}
	}
	if hits >= 4 {
		issues = append(issues, "Several promotional phrases appear in the body; review the message and verify placement with a real test send.")
	}
	// List-Unsubscribe is a MIME header, not a body-HTML feature. The final
	// message assembler must check it; inspecting this HTML would invent a
	// missing-header result even when the send pipeline adds the header.
	return issues
}

// gmailPromoTriggers — short curated list. The deeper trigger-word weights
// live in `internal/content/scanner.go`; here we only need a *signal*, not
// a calibrated score.
var gmailPromoTriggers = []string{
	"free",
	"save",
	"discount",
	"% off",
	"limited time",
	"sale",
	"buy now",
	"order now",
	"act now",
	"deal",
	"clearance",
	"coupon",
	"exclusive offer",
}

// bodyHasBackgroundImage approximates "background-image on <body>" by
// looking for `body` + `background-image` within 200 chars of each other.
func bodyHasBackgroundImage(low string) bool {
	idx := 0
	for {
		i := strings.Index(low[idx:], "<body")
		if i < 0 {
			return false
		}
		i += idx
		end := i + 400
		if end > len(low) {
			end = len(low)
		}
		if strings.Contains(low[i:end], "background-image") {
			return true
		}
		idx = i + 5
	}
}

func styleBlockSize(html string) int {
	low := strings.ToLower(html)
	total := 0
	idx := 0
	for {
		open := strings.Index(low[idx:], "<style")
		if open < 0 {
			return total
		}
		open += idx
		close := strings.Index(low[open:], "</style>")
		if close < 0 {
			return total + (len(html) - open)
		}
		total += close
		idx = open + close + len("</style>")
	}
}

var tagStripper = regexp.MustCompile(`<[^>]+>`)

func visibleTextLength(low string) int {
	return len(strings.TrimSpace(tagStripper.ReplaceAllString(low, " ")))
}
