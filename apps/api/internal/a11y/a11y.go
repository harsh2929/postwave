// SPDX-License-Identifier: AGPL-3.0-only
//
// Package a11y implements a pre-send email accessibility checker.
//
// The EU Accessibility Act (in force since 2025) requires
// commercial digital services targeting EU consumers to meet
// WCAG 2.1 AA. For ESPs that means flagging the most common email-
// specific failures BEFORE send so operators can fix them.
//
// Heuristic checks (the standard checklist):
//
//   * Missing alt text on <img> tags (WCAG 1.1.1).
//   * <html lang="..."> attribute present (WCAG 3.1.1).
//   * Color contrast of text vs background — we surface inline
//     color/background-color pairs that fall below 4.5:1 (AA).
//   * Empty link text (WCAG 2.4.4) — <a href="..."></a>.
//   * Generic link text ("click here") (WCAG 2.4.4 supplemental).
//   * Font size < 12px (WCAG 1.4.4 supplemental for email; tiny
//     text is universally bad for older readers).
//   * Missing <title> element when the email is rendered as a
//     standalone HTML doc (some clients use it).
//   * Image-only emails (image:text ratio > 4:1) — accessible
//     readers can't surface the message at all.
//
// Each finding has a severity (info / warn / error) so the editor
// can render badges of the right weight. We deliberately don't
// auto-fix — accessibility is a judgment call (a button labelled
// "submit" might be fine in context). The editor surfaces the
// findings inline next to the affected element.

package a11y

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

// Severity is the finding severity tier.
type Severity string

const (
	SeverityInfo  Severity = "info"
	SeverityWarn  Severity = "warn"
	SeverityError Severity = "error"
)

// Finding is one accessibility issue surfaced by the checker.
type Finding struct {
	Rule     string   `json:"rule"` // stable rule id for filtering
	Severity Severity `json:"severity"`
	Message  string   `json:"message"`
	Snippet  string   `json:"snippet,omitempty"` // truncated offending element
	WCAG     string   `json:"wcag,omitempty"`    // e.g. "1.1.1"
}

// Report is the wire shape.
type Report struct {
	Findings []Finding `json:"findings"`
	Counts   struct {
		Info  int `json:"info"`
		Warn  int `json:"warn"`
		Error int `json:"error"`
	} `json:"counts"`
	Score int `json:"score"` // 0..100; 100 = no findings, 0 = many errors
}

// Deps wires the handler. Stateless.
type Deps struct{}

// MountRoutes registers POST /api/v1/a11y/check. Read-reports scope
// because the editor calls this on every paste — no admin gate.
func MountRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadReports)).
		Post("/api/v1/a11y/check", d.Check)
}

// checkRequest is the editor body.
type checkRequest struct {
	HTML string `json:"html"`
	// Subject is optional; some rules (empty subject) check it.
	Subject string `json:"subject,omitempty"`
}

// Check POST /api/v1/a11y/check.
func (d *Deps) Check(w http.ResponseWriter, r *http.Request) {
	var in checkRequest
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	rep := Analyze(in.HTML, in.Subject)
	writeJSON(w, http.StatusOK, rep)
}

// Analyze runs the heuristic ruleset against the HTML body + subject.
// Pure function — no I/O, fully testable.
func Analyze(html, subject string) Report {
	rep := Report{}
	findings := []Finding{}
	findings = append(findings, ruleMissingAlt(html)...)
	findings = append(findings, ruleLangAttribute(html)...)
	findings = append(findings, ruleEmptyLinks(html)...)
	findings = append(findings, ruleGenericLinkText(html)...)
	findings = append(findings, ruleSmallFontSize(html)...)
	findings = append(findings, ruleMissingTitle(html)...)
	findings = append(findings, ruleImageHeavy(html)...)
	findings = append(findings, ruleLowContrast(html)...)
	findings = append(findings, ruleSubjectLength(subject)...)
	rep.Findings = findings
	for _, f := range findings {
		switch f.Severity {
		case SeverityInfo:
			rep.Counts.Info++
		case SeverityWarn:
			rep.Counts.Warn++
		case SeverityError:
			rep.Counts.Error++
		}
	}
	// Score: 100 - (errors*15 + warns*5 + info*1), floor 0.
	rep.Score = 100 - rep.Counts.Error*15 - rep.Counts.Warn*5 - rep.Counts.Info*1
	if rep.Score < 0 {
		rep.Score = 0
	}
	return rep
}

// --- rule implementations ---

var (
	imgTagRE     = regexp.MustCompile(`(?i)<img\b[^>]*>`)
	imgAltAttrRE = regexp.MustCompile(`(?i)\salt\s*=\s*("[^"]*"|'[^']*')`)
	htmlLangRE   = regexp.MustCompile(`(?i)<html\b[^>]*\blang\s*=`)
	htmlOpenRE   = regexp.MustCompile(`(?i)<html\b`)
	emptyLinkRE  = regexp.MustCompile(`(?i)<a\b[^>]*>\s*</a>`)
	allLinksRE   = regexp.MustCompile(`(?i)<a\b[^>]*>([^<]*)</a>`)
	smallFontRE  = regexp.MustCompile(`(?i)font-size\s*:\s*(\d+(\.\d+)?)\s*px`)
	titleRE      = regexp.MustCompile(`(?i)<title\b[^>]*>[^<]*</title>`)
	colorPairRE  = regexp.MustCompile(`(?i)color\s*:\s*(#[0-9a-fA-F]{3,8})[^;}]*;\s*background-color\s*:\s*(#[0-9a-fA-F]{3,8})`)
)

func ruleMissingAlt(html string) []Finding {
	out := []Finding{}
	for _, m := range imgTagRE.FindAllString(html, -1) {
		if imgAltAttrRE.MatchString(m) {
			// Has alt attribute. If alt="" that's INTENTIONALLY empty
			// (decorative image) — accept; surface only the truly
			// missing case.
			continue
		}
		out = append(out, Finding{
			Rule:     "img_missing_alt",
			Severity: SeverityError,
			WCAG:     "1.1.1",
			Message:  "<img> tag is missing an alt attribute. Add alt=\"\" for decorative images, or alt=\"...\" describing the content.",
			Snippet:  truncate(m, 120),
		})
	}
	return out
}

func ruleLangAttribute(html string) []Finding {
	if !htmlOpenRE.MatchString(html) {
		// No <html> wrapper — the email is a fragment. Not a finding;
		// some clients wrap automatically.
		return nil
	}
	if htmlLangRE.MatchString(html) {
		return nil
	}
	return []Finding{{
		Rule:     "html_missing_lang",
		Severity: SeverityWarn,
		WCAG:     "3.1.1",
		Message:  "<html> tag is missing a lang attribute. Add lang=\"en\" (or the appropriate ISO code) so screen readers select the right voice.",
	}}
}

func ruleEmptyLinks(html string) []Finding {
	out := []Finding{}
	for _, m := range emptyLinkRE.FindAllString(html, -1) {
		out = append(out, Finding{
			Rule:     "link_empty_text",
			Severity: SeverityError,
			WCAG:     "2.4.4",
			Message:  "Empty <a> tag — link has no visible text. Screen readers will announce only the URL.",
			Snippet:  truncate(m, 120),
		})
	}
	return out
}

var genericPhrases = []string{
	"click here", "here", "read more", "more", "learn more", "this link",
}

func ruleGenericLinkText(html string) []Finding {
	out := []Finding{}
	matches := allLinksRE.FindAllStringSubmatch(html, -1)
	for _, m := range matches {
		text := strings.ToLower(strings.TrimSpace(m[1]))
		if text == "" {
			continue // covered by ruleEmptyLinks
		}
		for _, generic := range genericPhrases {
			if text == generic {
				out = append(out, Finding{
					Rule:     "link_generic_text",
					Severity: SeverityWarn,
					WCAG:     "2.4.4",
					Message:  "Link text is generic (\"" + text + "\"). Describe the destination instead, e.g. \"View your invoice\".",
					Snippet:  truncate(m[0], 120),
				})
				break
			}
		}
	}
	return out
}

func ruleSmallFontSize(html string) []Finding {
	out := []Finding{}
	for _, m := range smallFontRE.FindAllStringSubmatch(html, -1) {
		px, err := strconv.ParseFloat(m[1], 64)
		if err != nil || px >= 12 {
			continue
		}
		out = append(out, Finding{
			Rule:     "font_size_too_small",
			Severity: SeverityWarn,
			Message:  "Font size " + m[1] + "px is below 12px; readers find it difficult.",
			Snippet:  truncate(m[0], 80),
		})
	}
	return out
}

func ruleMissingTitle(html string) []Finding {
	if !htmlOpenRE.MatchString(html) {
		return nil
	}
	if titleRE.MatchString(html) {
		return nil
	}
	return []Finding{{
		Rule:     "html_missing_title",
		Severity: SeverityInfo,
		Message:  "<head> has no <title>. Add a brief title — some webmail clients use it for the browser tab when the email opens full-screen.",
	}}
}

func ruleImageHeavy(html string) []Finding {
	// Rough heuristic: count chars inside <img> tags vs chars NOT in
	// img / script / style. When images dominate, the email is
	// inaccessible to anyone who blocks images by default (most
	// corporate filters).
	imgChars := 0
	for _, m := range imgTagRE.FindAllString(html, -1) {
		imgChars += len(m)
	}
	textChars := len(stripTags(html))
	if textChars == 0 && imgChars > 0 {
		return []Finding{{
			Rule:     "image_only",
			Severity: SeverityError,
			Message:  "Email contains images but no text. Recipients with image blocking will see a blank email; add text or use alt attributes.",
		}}
	}
	if textChars > 0 && imgChars > textChars*4 {
		return []Finding{{
			Rule:     "image_heavy",
			Severity: SeverityWarn,
			Message:  "Image-to-text ratio is high. Add more body text so the email is readable when images are blocked.",
		}}
	}
	return nil
}

// ruleLowContrast surfaces inline color + background-color pairs
// that fall below the WCAG AA threshold of 4.5:1. We only check
// inline-style hex pairs; CSS rules, named colors, or external
// stylesheets are out of scope (most email clients strip those
// anyway).
func ruleLowContrast(html string) []Finding {
	out := []Finding{}
	for _, m := range colorPairRE.FindAllStringSubmatch(html, -1) {
		ratio := contrastRatio(m[1], m[2])
		if ratio < 4.5 && ratio > 0 {
			out = append(out, Finding{
				Rule:     "low_contrast",
				Severity: SeverityWarn,
				WCAG:     "1.4.3",
				Message:  "Color contrast ratio " + formatRatio(ratio) + ":1 is below WCAG AA (4.5:1) for " + m[1] + " on " + m[2] + ".",
			})
		}
	}
	return out
}

func ruleSubjectLength(subject string) []Finding {
	s := strings.TrimSpace(subject)
	if s == "" {
		return nil
	}
	if len(s) > 70 {
		return []Finding{{
			Rule:     "subject_too_long",
			Severity: SeverityInfo,
			Message:  "Subject is " + strconv.Itoa(len(s)) + " characters; most mail clients truncate around 60-70.",
		}}
	}
	return nil
}

// --- helpers ---

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

var tagStrip = regexp.MustCompile(`<[^>]*>`)

func stripTags(html string) string {
	return strings.TrimSpace(tagStrip.ReplaceAllString(html, " "))
}

// contrastRatio implements the WCAG relative-luminance formula.
// Accepts hex colors like #abc / #aabbcc / #aabbccff. Returns 0 if
// either parse fails (caller treats as "skip").
func contrastRatio(fg, bg string) float64 {
	fr, fg2, fb, ok1 := parseHex(fg)
	br, bg2, bb, ok2 := parseHex(bg)
	if !ok1 || !ok2 {
		return 0
	}
	l1 := relLuminance(fr, fg2, fb)
	l2 := relLuminance(br, bg2, bb)
	lighter, darker := l1, l2
	if l2 > l1 {
		lighter, darker = l2, l1
	}
	return (lighter + 0.05) / (darker + 0.05)
}

func parseHex(s string) (r, g, b float64, ok bool) {
	s = strings.TrimPrefix(strings.ToLower(s), "#")
	switch len(s) {
	case 3:
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	case 6, 8:
		// keep first 6
		s = s[:6]
	default:
		return 0, 0, 0, false
	}
	parse := func(part string) (float64, bool) {
		n, err := strconv.ParseInt(part, 16, 64)
		if err != nil {
			return 0, false
		}
		return float64(n) / 255.0, true
	}
	var ok2 bool
	if r, ok2 = parse(s[0:2]); !ok2 {
		return 0, 0, 0, false
	}
	if g, ok2 = parse(s[2:4]); !ok2 {
		return 0, 0, 0, false
	}
	if b, ok2 = parse(s[4:6]); !ok2 {
		return 0, 0, 0, false
	}
	return r, g, b, true
}

// relLuminance implements WCAG 2.x relative-luminance.
func relLuminance(r, g, b float64) float64 {
	channel := func(c float64) float64 {
		if c <= 0.03928 {
			return c / 12.92
		}
		return powApprox((c+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(r) + 0.7152*channel(g) + 0.0722*channel(b)
}

// powApprox wraps math.Pow. Kept as a one-line indirection so we
// can swap to a fixed-exponent fast path later if profiling shows
// the WCAG channel transform on the hot path.
func powApprox(x, exp float64) float64 {
	return math.Pow(x, exp)
}

func formatRatio(r float64) string {
	// Render to 1 decimal.
	return strconv.FormatFloat(r, 'f', 1, 64)
}

// --- helpers + handler infra ---

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
