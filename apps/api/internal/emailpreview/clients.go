// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-client HTML transforms. Each function takes rendered HTML and
// returns a modified copy with adjustments that approximate what the
// target client will actually display. These are well-documented quirks
// from the email-dev community (see e.g. https://www.caniemail.com,
// https://email.spec.whatwg.org isn't a thing, refer to MS Outlook KB).
//
// All functions are pure: no I/O, no globals modified, safe to call
// concurrently.
package emailpreview

import (
	"regexp"
	"strings"
)

// ApplyGmailWeb adjusts HTML for Gmail web's quirks.
//
// Documented quirks targeted:
//   - Gmail strips <style> tags that aren't in <head>, and strips ALL
//     style tags in some configurations (Gmail clipping at 102KB also
//     drops <style> blocks in the second half). We don't try to inline
//     here — that's a job for a real CSS inliner like Premailer — but
//     we DO inject a meta to make the preview honest about what Gmail
//     web shows.
//   - Gmail treats `class` selectors per-element only and will drop any
//     <style> rules referencing pseudo-classes like :hover.
//
// The transform is conservative: we don't want to break legitimate
// HTML, just label it for the preview.
func ApplyGmailWeb(html string) string {
	out := injectClientLabel(html, "gmail-web")
	// Gmail wraps everything in its own div with font-family: Arial,
	// sans-serif unless overridden. Approximating by injecting a wrapper
	// with that default makes the preview less surprising.
	out = injectBodyOpenStyle(out, "font-family: Arial, sans-serif; line-height: 1.5;")
	return out
}

// ApplyOutlookDesktop adjusts HTML for Outlook 2007–365 desktop, which
// uses Microsoft Word's HTML rendering engine. This is where most
// "looks broken" tickets originate.
//
// Documented quirks targeted:
//   - Outlook desktop ignores most modern CSS: border-radius, transform,
//     gap, flex/grid layouts. We strip those declarations so the preview
//     shows the squared-off, gap-less reality the recipient sees.
//   - Outlook reads MSO conditional comments — wrapping critical layout
//     in <!--[if mso]>...<![endif]--> is the canonical workaround. We
//     wrap the body to make that visible in the preview.
//   - Outlook adds extra whitespace around <p> and <li>. We don't try
//     to fix that — the preview should show it.
//   - Outlook substitutes its own font fallbacks if the requested font
//     is unavailable; we leave that alone since Cambria/Calibri are
//     hard to replicate in the browser.
func ApplyOutlookDesktop(html string) string {
	out := injectClientLabel(html, "outlook-desktop")

	// Strip CSS properties Outlook ignores. We do this with regex
	// rather than a real parser because we're operating on rendered HTML
	// where styles can be inline; a real CSS parser is overkill for a
	// "approximate the bad render" use case.
	out = stripUnsupportedCSS(out, []string{
		"border-radius",
		"transform",
		"gap",
		"box-shadow",
		"backdrop-filter",
	})

	// Replace flex/grid display:flex with the table fallback Outlook
	// would force you to write anyway.
	out = reDisplayFlex.ReplaceAllString(out, "display: block")
	out = reDisplayGrid.ReplaceAllString(out, "display: block")

	// Wrap body content in MSO conditional so reviewers see the marker
	// the email-dev community treats as the Outlook escape hatch. The
	// conditional itself is harmless to non-Outlook clients.
	out = wrapBodyInMSO(out)
	return out
}

// ApplyAppleMail adjusts HTML for Apple Mail (macOS + iOS).
//
// Apple Mail is the most permissive major client — it's a WebKit shell
// and renders almost any HTML/CSS the way a browser would. The main
// adjustments are:
//   - iOS auto-styles phone numbers, addresses, and dates as links unless
//     told not to. We inject the canonical x-apple-disable-message-reformatting
//     meta + a -webkit-touch-callout suppressor.
//   - iOS Mail occasionally up-scales small fonts; the
//     -webkit-text-size-adjust: 100% rule prevents that.
func ApplyAppleMail(html string) string {
	out := injectClientLabel(html, "apple-mail")
	out = injectIntoHead(out, `<meta name="x-apple-disable-message-reformatting" />`+
		`<style>body{-webkit-text-size-adjust:100%;}`+
		`a[x-apple-data-detectors]{color:inherit !important;text-decoration:none !important;}`+
		`</style>`)
	return out
}

// ApplyDarkMode wraps the HTML with @media (prefers-color-scheme: dark)
// rules that swap backgrounds and text colors. This previews how the
// email LOOKS in dark mode for clients that respect the media query
// (Apple Mail, iOS Mail, Outlook.com web). Gmail doesn't respect
// prefers-color-scheme cleanly (it has its own dark-mode mangler) but
// the preview is still useful as a "what should this look like" target.
//
// We inject the rule into <head>; if no <head> exists we insert one.
// The rule is intentionally conservative: it only swaps the white/black
// extremes, not arbitrary colors, because clients vary in which colors
// they auto-invert.
func ApplyDarkMode(html string) string {
	out := injectClientLabel(html, "dark-mode")
	out = injectIntoHead(out, `<style>
@media (prefers-color-scheme: dark) {
  body, .pw-bg { background: #0a0a0a !important; color: #f4f4f4 !important; }
  .pw-card, table { background: #1a1a1a !important; }
  a { color: #8ab4f8 !important; }
}
</style>`)
	// Force the preview iframe into dark by also setting a data attribute
	// the page CSS can pick up — clients render dark per device, but the
	// preview iframe is just a static HTML doc, so we toggle it ourselves.
	out = strings.Replace(out, "<body", `<body data-pw-dark="1" style="background:#0a0a0a;color:#f4f4f4;"`, 1)
	return out
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

var (
	reBodyOpen    = regexp.MustCompile(`(?i)<body([^>]*)>`)
	reHeadOpen    = regexp.MustCompile(`(?i)<head([^>]*)>`)
	reHtmlOpen    = regexp.MustCompile(`(?i)<html([^>]*)>`)
	reDisplayFlex = regexp.MustCompile(`(?i)display\s*:\s*(?:inline-)?flex`)
	reDisplayGrid = regexp.MustCompile(`(?i)display\s*:\s*(?:inline-)?grid`)
)

// injectClientLabel adds a tiny attribute to <body> so QA can see which
// transform produced the HTML. Pure cosmetic; helps when debugging.
func injectClientLabel(html, label string) string {
	if reBodyOpen.MatchString(html) {
		return reBodyOpen.ReplaceAllString(html, `<body$1 data-pw-client="`+label+`">`)
	}
	return html
}

// injectBodyOpenStyle merges a style fragment into the existing <body>
// open tag's style attribute, or adds one if absent.
func injectBodyOpenStyle(html, style string) string {
	return reBodyOpen.ReplaceAllStringFunc(html, func(match string) string {
		// If body already has a style="...", append; otherwise add fresh.
		if strings.Contains(strings.ToLower(match), "style=") {
			return regexp.MustCompile(`(?i)style="([^"]*)"`).ReplaceAllString(match,
				`style="$1; `+style+`"`)
		}
		// Insert style before the closing >.
		return strings.TrimSuffix(match, ">") + ` style="` + style + `">`
	})
}

// injectIntoHead inserts a fragment immediately after <head>. If no
// <head> tag exists, we wrap by inserting one after <html>. If neither
// exists, we prepend the fragment + a minimal head — degenerate input
// shouldn't crash the preview.
func injectIntoHead(html, fragment string) string {
	if reHeadOpen.MatchString(html) {
		return reHeadOpen.ReplaceAllString(html, "<head$1>"+fragment)
	}
	if reHtmlOpen.MatchString(html) {
		return reHtmlOpen.ReplaceAllString(html, "<html$1><head>"+fragment+"</head>")
	}
	return "<head>" + fragment + "</head>" + html
}

// wrapBodyInMSO inserts MSO conditional comment markers around the body
// content. This is the "show that this would need a table fallback in
// Outlook" preview cue — the conditional is invisible to non-Outlook
// clients and harmless if the existing HTML already has its own.
func wrapBodyInMSO(html string) string {
	const open = `<!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%"><tr><td><![endif]-->`
	const close = `<!--[if mso]></td></tr></table><![endif]-->`
	out := reBodyOpen.ReplaceAllStringFunc(html, func(m string) string {
		return m + open
	})
	// Insert the close before </body>. If no </body>, append.
	if strings.Contains(strings.ToLower(out), "</body>") {
		out = regexp.MustCompile(`(?i)</body>`).ReplaceAllString(out, close+"</body>")
	} else {
		out += close
	}
	return out
}

// stripUnsupportedCSS removes a list of CSS property names from inline
// style="..." attributes and from any <style> blocks. We do a coarse
// "delete the whole declaration" pass — Outlook ignores them anyway, so
// removing them from the preview accurately reflects what ships.
func stripUnsupportedCSS(html string, props []string) string {
	out := html
	for _, p := range props {
		// Match `prop : value;` (with optional trailing semicolon and
		// surrounding whitespace) inside any context. The regex is
		// case-insensitive and tolerates both kebab and the various
		// whitespace patterns CSS allows.
		re := regexp.MustCompile(`(?i)(^|[\s;{"])` + regexp.QuoteMeta(p) + `\s*:\s*[^;"}]+;?`)
		out = re.ReplaceAllString(out, "$1")
	}
	return out
}
