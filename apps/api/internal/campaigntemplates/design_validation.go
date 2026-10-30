// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"context"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"

	"github.com/postwave/postwave/apps/api/internal/emailpreview"
	"github.com/postwave/postwave/apps/api/internal/unsubscribetoken"
)

var forbiddenGeneratedElements = map[string]struct{}{
	"applet": {}, "audio": {}, "base": {}, "embed": {}, "foreignobject": {},
	"form": {}, "frame": {}, "frameset": {}, "iframe": {}, "math": {},
	"object": {}, "script": {}, "svg": {}, "video": {},
}

var generatedURLAttributes = map[string]struct{}{
	"action": {}, "background": {}, "formaction": {}, "href": {},
	"poster": {}, "src": {}, "xlink:href": {},
}

type generatedHTMLInspection struct {
	Images                   int
	ImagesWithoutAlt         int
	Links                    int
	InvalidLinks             int
	PossibleContrastFailures int
	HasUnsubscribe           bool
	HasFooter                bool
	Changed                  bool
}

var generatedRGBColorPattern = regexp.MustCompile(
	`(?i)^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})`,
)

func repairAndValidateGeneratedDesign(
	ctx context.Context,
	generated GeneratedDesign,
	fallbackName, fallbackSubject string,
) (GeneratedDesign, DesignValidation, []TemplateWarning, error) {
	checks := make([]DesignValidationCheck, 0, 10)
	warnings := make([]TemplateWarning, 0, 6)

	generated.Name = strings.TrimSpace(generated.Name)
	if generated.Name == "" {
		generated.Name = boundedString(fallbackName, 180)
		if generated.Name == "" {
			generated.Name = "Untitled newsletter design"
		}
		checks = append(checks, DesignValidationCheck{
			Code: "name_present", Status: "warn",
			Message:  "The generator omitted a name, so Moosewave supplied one.",
			Repaired: true,
		})
		warnings = append(warnings, TemplateWarning{
			Code: "name_repaired", Message: "Moosewave supplied a missing design name.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "name_present", Status: "pass", Message: "The design has a name.",
		})
	}
	generated.Name = truncateUTF8Bytes(generated.Name, MaxNameLength)

	generated.Subject = strings.TrimSpace(generated.Subject)
	if generated.Subject == "" {
		generated.Subject = boundedString(fallbackSubject, reviewedDesignMaxSubjectRunes)
		if generated.Subject == "" {
			generated.Subject = "A newsletter update for you"
		}
		checks = append(checks, DesignValidationCheck{
			Code: "subject_present", Status: "warn",
			Message:  "The generator omitted a subject, so Moosewave supplied one.",
			Repaired: true,
		})
		warnings = append(warnings, TemplateWarning{
			Code: "subject_repaired", Message: "Moosewave supplied a missing subject line.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "subject_present", Status: "pass", Message: "The design has a subject line.",
		})
	}
	if utf8.RuneCountInString(generated.Subject) > reviewedDesignMaxSubjectRunes {
		generated.Subject = boundedString(generated.Subject, reviewedDesignMaxSubjectRunes)
		checks = append(checks, DesignValidationCheck{
			Code: "subject_length", Status: "warn",
			Message:  "The subject was shortened to the supported email limit.",
			Repaired: true,
		})
		warnings = append(warnings, TemplateWarning{
			Code: "subject_shortened", Message: "The generated subject exceeded the supported length and was shortened.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "subject_length", Status: "pass", Message: "The subject length is supported.",
		})
	}
	generated.PreviewText = strings.TrimSpace(generated.PreviewText)
	if generated.PreviewText == "" {
		checks = append(checks, DesignValidationCheck{
			Code: "preview_text", Status: "warn",
			Message: "Preview text is empty. Add a short inbox summary so mailbox snippets do not expose body copy.",
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "preview_text_missing",
			Message:           "Add preview text before sending for a clearer inbox impression.",
			RecommendedAction: "review_campaign_template_design",
		})
	} else {
		if utf8.RuneCountInString(generated.PreviewText) > reviewedDesignMaxPreviewRunes {
			generated.PreviewText = boundedString(
				generated.PreviewText, reviewedDesignMaxPreviewRunes,
			)
			checks = append(checks, DesignValidationCheck{
				Code: "preview_text", Status: "warn",
				Message:  "Preview text was shortened to the supported email limit.",
				Repaired: true,
			})
			warnings = append(warnings, TemplateWarning{
				Code:    "preview_text_shortened",
				Message: "The generated preview text exceeded the supported length and was shortened.",
			})
		} else {
			checks = append(checks, DesignValidationCheck{
				Code: "preview_text", Status: "pass",
				Message: "The design includes inbox preview text.",
			})
		}
	}

	generated.BodyHTML = strings.TrimSpace(generated.BodyHTML)
	generated.BodyMJML = strings.TrimSpace(generated.BodyMJML)
	if generated.BodyHTML == "" && generated.BodyMJML != "" {
		rendered, renderWarnings, err := emailpreview.RenderMJML(ctx, generated.BodyMJML, nil)
		if err == nil && strings.TrimSpace(rendered) != "" {
			generated.BodyHTML = rendered
			checks = append(checks, DesignValidationCheck{
				Code: "html_render", Status: "warn",
				Message:  "Moosewave rendered the generated MJML into reviewable HTML.",
				Repaired: true,
			})
			warnings = append(warnings, TemplateWarning{
				Code: "html_rendered_from_mjml", Message: "Review HTML was rendered from the generated MJML.",
			})
			for _, warning := range renderWarnings {
				warnings = append(warnings, TemplateWarning{
					Code: "mjml_render_warning", Message: boundedString(warning, 500),
				})
			}
		}
	}
	// MJML remains executable source: campaign creation renders it again and
	// prefers that result over stored HTML. Validate the rendered form now. If
	// rendering fails or active content would be removed, downgrade this
	// revision to the already-sanitized HTML path so unsafe MJML cannot
	// reintroduce scripts/forms/handlers after review.
	if generated.BodyMJML != "" {
		rendered, _, renderErr := emailpreview.RenderMJML(ctx, generated.BodyMJML, nil)
		if renderErr != nil {
			generated.BodyMJML = ""
			checks = append(checks, DesignValidationCheck{
				Code: "mjml_source_safety", Status: "warn",
				Message:  "MJML could not be validated consistently, so this revision will use safe HTML.",
				Repaired: true,
			})
			warnings = append(warnings, TemplateWarning{
				Code:    "mjml_downgraded_to_html",
				Message: "Moosewave removed unverified MJML source and retained the safe rendered HTML.",
			})
		} else {
			_, renderedInspection, inspectErr := sanitizeGeneratedHTML(rendered)
			if inspectErr != nil || renderedInspection.Changed {
				generated.BodyMJML = ""
				checks = append(checks, DesignValidationCheck{
					Code: "mjml_source_safety", Status: "warn",
					Message:  "MJML rendered active or invalid content, so this revision will use safe HTML.",
					Repaired: true,
				})
				warnings = append(warnings, TemplateWarning{
					Code:    "mjml_downgraded_to_html",
					Message: "Moosewave removed unsafe MJML source and retained the safe rendered HTML.",
				})
			} else {
				checks = append(checks, DesignValidationCheck{
					Code: "mjml_source_safety", Status: "pass",
					Message: "The MJML source renders without active browser content.",
				})
			}
		}
	}
	if generated.BodyHTML == "" {
		return generated, failedDesignValidation(checks, "body_present",
				"The generator did not return reviewable email HTML."), warnings,
			fmt.Errorf("%w: missing body_html", ErrGeneratedDesignInvalid)
	}
	if len(generated.BodyHTML) > reviewedDesignMaxBodyBytes ||
		len(generated.BodyMJML) > reviewedDesignMaxBodyBytes ||
		len(generated.BodyHTML)+len(generated.BodyMJML) > reviewedDesignMaxCombinedBodyBytes {
		return generated, failedDesignValidation(checks, "body_size",
				"The generated design exceeds the supported size."), warnings,
			fmt.Errorf("%w: body is too large", ErrGeneratedDesignInvalid)
	}

	safeHTML, inspection, err := sanitizeGeneratedHTML(generated.BodyHTML)
	if err != nil {
		return generated, failedDesignValidation(checks, "html_parse",
				"The generated HTML could not be parsed safely."), warnings,
			fmt.Errorf("%w: %v", ErrGeneratedDesignInvalid, err)
	}
	generated.BodyHTML = safeHTML
	if strings.TrimSpace(generated.BodyHTML) == "" {
		return generated, failedDesignValidation(checks, "body_present",
				"The generated design was empty after safety validation."), warnings,
			fmt.Errorf("%w: empty sanitized body", ErrGeneratedDesignInvalid)
	}
	if inspection.Changed {
		checks = append(checks, DesignValidationCheck{
			Code: "active_content", Status: "warn",
			Message:  "Moosewave removed active or unsafe browser content from the email.",
			Repaired: true,
		})
		warnings = append(warnings, TemplateWarning{
			Code:    "active_content_removed",
			Message: "Unsafe scripts, forms, embeds, handlers, or URLs were removed before review.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "active_content", Status: "pass",
			Message: "No active browser content was found.",
		})
	}
	if inspection.ImagesWithoutAlt > 0 {
		checks = append(checks, DesignValidationCheck{
			Code: "image_alt_text", Status: "warn",
			Message: fmt.Sprintf("%d image(s) still need useful alt text before sending.", inspection.ImagesWithoutAlt),
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "image_alt_text_missing",
			Message:           "One or more images need alt text. Add it during review for screen-reader users.",
			RecommendedAction: "review_campaign_template_design",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "image_alt_text", Status: "pass",
			Message: "Every generated image has an alt attribute.",
		})
	}
	if inspection.Links == 0 {
		checks = append(checks, DesignValidationCheck{
			Code: "cta_link", Status: "warn",
			Message: "The design has no link. Add a CTA if the newsletter should drive an action.",
		})
		warnings = append(warnings, TemplateWarning{
			Code:    "cta_link_missing",
			Message: "No CTA link was detected; this can be fine for a text-only update.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "cta_link", Status: "pass", Message: "The design contains at least one link.",
		})
	}
	if inspection.InvalidLinks > 0 {
		checks = append(checks, DesignValidationCheck{
			Code: "link_validity", Status: "warn",
			Message: fmt.Sprintf(
				"%d link(s) are incomplete or use an unsupported destination.",
				inspection.InvalidLinks,
			),
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "invalid_links",
			Message:           "Review incomplete, relative, or unsupported links before sending.",
			RecommendedAction: "review_campaign_template_design",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "link_validity", Status: "pass",
			Message: "Every detected link has a supported destination.",
		})
	}
	if inspection.HasUnsubscribe {
		checks = append(checks, DesignValidationCheck{
			Code: "unsubscribe_link", Status: "pass",
			Message: "The unsubscribe link uses {{ unsubscribe_url }}, so each recipient gets their own.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "unsubscribe_link", Status: "warn",
			Message: "Add an unsubscribe link that uses {{ unsubscribe_url }}. Campaigns without one can't be sent, and a fixed link or the word \"unsubscribe\" doesn't count.",
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "unsubscribe_link_missing",
			Message:           "Add an unsubscribe link that uses {{ unsubscribe_url }}; campaigns without one can't be sent.",
			RecommendedAction: "review_campaign_template_design",
		})
	}
	if inspection.HasFooter {
		checks = append(checks, DesignValidationCheck{
			Code: "compliance_footer", Status: "pass",
			Message: "A footer region was detected for sender and compliance details.",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "compliance_footer", Status: "warn",
			Message: "No explicit footer region was detected. Confirm sender identity, postal details, and required legal copy before sending.",
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "compliance_footer_missing",
			Message:           "Confirm the campaign footer includes the sender identity and legally required details.",
			RecommendedAction: "review_campaign_template_design",
		})
	}
	if inspection.PossibleContrastFailures > 0 {
		checks = append(checks, DesignValidationCheck{
			Code: "color_contrast", Status: "warn",
			Message: fmt.Sprintf(
				"%d inline text/background color pair(s) may be below the 4.5:1 accessibility target.",
				inspection.PossibleContrastFailures,
			),
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "color_contrast_review",
			Message:           "Review low-contrast text in the visual preview; inherited and image-backed colors still need human checking.",
			RecommendedAction: "review_campaign_template_design",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "color_contrast", Status: "pass",
			Message: "No low-contrast inline color pair was detected.",
		})
	}
	if len(generated.BodyHTML) > 90*1024 {
		checks = append(checks, DesignValidationCheck{
			Code: "inbox_clip_risk", Status: "warn",
			Message: "The rendered HTML is approaching common mailbox clipping thresholds. Shorten or simplify it before sending.",
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "inbox_clip_risk",
			Message:           "This email may be clipped by some inboxes because its HTML is large.",
			RecommendedAction: "review_campaign_template_design",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "inbox_clip_risk", Status: "pass",
			Message: "The rendered HTML is below the conservative clipping-risk threshold.",
		})
	}
	if !strings.Contains(strings.ToLower(generated.BodyHTML), "viewport") {
		checks = append(checks, DesignValidationCheck{
			Code: "mobile_viewport", Status: "warn",
			Message: "No explicit viewport metadata was found; use the mobile preview before saving.",
		})
		warnings = append(warnings, TemplateWarning{
			Code:              "mobile_preview_recommended",
			Message:           "Check the simulated mobile preview before using this design.",
			RecommendedAction: "review_campaign_template_design",
		})
	} else {
		checks = append(checks, DesignValidationCheck{
			Code: "mobile_viewport", Status: "pass",
			Message: "The design declares a mobile viewport.",
		})
	}

	status := "pass"
	for _, check := range checks {
		if check.Status == "warn" {
			status = "warn"
			break
		}
	}
	return generated, DesignValidation{Status: status, Checks: checks}, warnings, nil
}

func failedDesignValidation(
	checks []DesignValidationCheck,
	code, message string,
) DesignValidation {
	checks = append(checks, DesignValidationCheck{
		Code: code, Status: "fail", Message: message,
	})
	return DesignValidation{Status: "fail", Checks: checks}
}

func sanitizeGeneratedHTML(input string) (string, generatedHTMLInspection, error) {
	var inspection generatedHTMLInspection
	document, err := html.Parse(strings.NewReader(input))
	if err != nil {
		return "", inspection, err
	}
	sanitizeGeneratedNode(document, &inspection)
	var rendered bytes.Buffer
	if err := html.Render(&rendered, document); err != nil {
		return "", inspection, err
	}
	return rendered.String(), inspection, nil
}

func sanitizeGeneratedNode(node *html.Node, inspection *generatedHTMLInspection) {
	for child := node.FirstChild; child != nil; {
		next := child.NextSibling
		if generatedNodeForbidden(child) {
			node.RemoveChild(child)
			inspection.Changed = true
			child = next
			continue
		}
		sanitizeGeneratedAttributes(child, inspection)
		if child.Type == html.ElementNode {
			switch strings.ToLower(child.Data) {
			case "img":
				inspection.Images++
				hasAlt, decorative := false, false
				for _, attr := range child.Attr {
					if strings.EqualFold(attr.Key, "alt") {
						hasAlt = true
						if strings.TrimSpace(attr.Val) != "" {
							decorative = true
						}
					}
					if (strings.EqualFold(attr.Key, "role") &&
						(strings.EqualFold(strings.TrimSpace(attr.Val), "presentation") ||
							strings.EqualFold(strings.TrimSpace(attr.Val), "none"))) ||
						(strings.EqualFold(attr.Key, "aria-hidden") &&
							strings.EqualFold(strings.TrimSpace(attr.Val), "true")) {
						decorative = true
					}
				}
				if !hasAlt {
					child.Attr = append(child.Attr, html.Attribute{Key: "alt", Val: ""})
					inspection.ImagesWithoutAlt++
					inspection.Changed = true
				} else if !decorative {
					inspection.ImagesWithoutAlt++
				}
			case "a":
				for _, attr := range child.Attr {
					if strings.EqualFold(attr.Key, "href") && strings.TrimSpace(attr.Val) != "" {
						inspection.Links++
						if !validGeneratedLink(attr.Val) {
							inspection.InvalidLinks++
						}
						if unsubscribetoken.Contains(attr.Val) {
							inspection.HasUnsubscribe = true
						}
						break
					}
				}
			case "footer":
				inspection.HasFooter = true
			}
			if generatedElementHasFooterRole(child) {
				inspection.HasFooter = true
			}
			if generatedInlineContrastFails(child) {
				inspection.PossibleContrastFailures++
			}
		}
		sanitizeGeneratedNode(child, inspection)
		if child.Type == html.TextNode &&
			unsubscribetoken.Contains(child.Data) {
			inspection.HasUnsubscribe = true
		}
		child = next
	}
}

func generatedNodeForbidden(node *html.Node) bool {
	if node.Type != html.ElementNode {
		return false
	}
	name := strings.ToLower(node.Data)
	if _, forbidden := forbiddenGeneratedElements[name]; forbidden {
		return true
	}
	if name == "style" && generatedUnsafeCSS(generatedNodeText(node)) {
		return true
	}
	if name == "meta" {
		for _, attr := range node.Attr {
			if strings.EqualFold(attr.Key, "http-equiv") &&
				strings.EqualFold(strings.TrimSpace(attr.Val), "refresh") {
				return true
			}
		}
	}
	return false
}

func sanitizeGeneratedAttributes(node *html.Node, inspection *generatedHTMLInspection) {
	if node.Type != html.ElementNode || len(node.Attr) == 0 {
		return
	}
	safe := node.Attr[:0]
	for _, attr := range node.Attr {
		key := strings.ToLower(strings.TrimSpace(attr.Key))
		if strings.HasPrefix(key, "on") || key == "srcdoc" {
			inspection.Changed = true
			continue
		}
		if _, isURL := generatedURLAttributes[key]; isURL &&
			unsafeGeneratedURLAttribute(node, key, attr.Val) {
			inspection.Changed = true
			continue
		}
		if key == "style" && generatedUnsafeCSS(attr.Val) {
			inspection.Changed = true
			continue
		}
		safe = append(safe, attr)
	}
	node.Attr = safe
}

func unsafeGeneratedURL(raw string) bool {
	value := strings.ToLower(strings.TrimSpace(strings.Map(func(r rune) rune {
		switch r {
		case '\x00', '\t', '\n', '\r', '\f':
			return -1
		default:
			return r
		}
	}, raw)))
	return strings.HasPrefix(value, "javascript:") ||
		strings.HasPrefix(value, "vbscript:") ||
		strings.HasPrefix(value, "data:text/html") ||
		strings.HasPrefix(value, "data:application/xhtml")
}

func unsafeGeneratedURLAttribute(node *html.Node, key, raw string) bool {
	if unsafeGeneratedURL(raw) {
		return true
	}
	value := strings.TrimSpace(raw)
	lower := strings.ToLower(value)
	if value == "" || strings.HasPrefix(value, "#") ||
		strings.HasPrefix(value, "//") ||
		strings.Contains(value, "{{") || strings.Contains(value, "[[") {
		return false
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		// Relative URLs are not executable. Link validation reports them as
		// incomplete, but stripping them here would lose useful review context.
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https", "http", "mailto", "tel", "cid":
		return false
	case "data":
		return !(node != nil &&
			strings.EqualFold(node.Data, "img") &&
			key == "src" &&
			(strings.HasPrefix(lower, "data:image/png;") ||
				strings.HasPrefix(lower, "data:image/jpeg;") ||
				strings.HasPrefix(lower, "data:image/gif;") ||
				strings.HasPrefix(lower, "data:image/webp;")))
	default:
		return true
	}
}

func generatedUnsafeCSS(value string) bool {
	lower := strings.ToLower(strings.Map(func(r rune) rune {
		switch r {
		case '\x00', '\t', '\n', '\r', '\f':
			return -1
		default:
			return r
		}
	}, value))
	for _, marker := range []string{
		"javascript:", "vbscript:", "expression(", "behavior:",
		"-moz-binding", "data:text/html", "data:application/xhtml",
		"data:image/svg",
	} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

func generatedNodeText(node *html.Node) string {
	if node == nil {
		return ""
	}
	var text strings.Builder
	var visit func(*html.Node)
	visit = func(current *html.Node) {
		if current.Type == html.TextNode {
			text.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(node)
	return text.String()
}

func validGeneratedLink(raw string) bool {
	value := strings.TrimSpace(raw)
	if value == "" {
		return false
	}
	// The send loop replaces this placeholder with each recipient's own
	// preference-centre URL; it is the one templated href that is complete.
	if unsubscribetoken.Contains(value) {
		return true
	}
	if strings.HasPrefix(value, "#") {
		return len(value) > 1
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https", "http":
		return parsed.Host != ""
	case "mailto":
		return strings.Contains(parsed.Opaque, "@") ||
			strings.Contains(parsed.Path, "@")
	case "tel":
		return strings.TrimSpace(parsed.Opaque+parsed.Path) != ""
	default:
		return false
	}
}

func generatedElementHasFooterRole(node *html.Node) bool {
	if node == nil || node.Type != html.ElementNode {
		return false
	}
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, "role") &&
			strings.EqualFold(strings.TrimSpace(attr.Val), "contentinfo") {
			return true
		}
	}
	return false
}

func generatedInlineContrastFails(node *html.Node) bool {
	if node == nil || node.Type != html.ElementNode ||
		!generatedElementHasVisibleText(node) {
		return false
	}
	var foregroundRaw, backgroundRaw string
	for _, attr := range node.Attr {
		switch strings.ToLower(strings.TrimSpace(attr.Key)) {
		case "color":
			foregroundRaw = attr.Val
		case "bgcolor":
			backgroundRaw = attr.Val
		case "style":
			for _, declaration := range strings.Split(attr.Val, ";") {
				pair := strings.SplitN(declaration, ":", 2)
				if len(pair) != 2 {
					continue
				}
				switch strings.ToLower(strings.TrimSpace(pair[0])) {
				case "color":
					foregroundRaw = pair[1]
				case "background", "background-color":
					// A background shorthand can include images/gradients. Only
					// score it when the entire value is a parseable solid color.
					backgroundRaw = pair[1]
				}
			}
		}
	}
	foreground, foregroundOK := parseGeneratedColor(foregroundRaw)
	background, backgroundOK := parseGeneratedColor(backgroundRaw)
	if !foregroundOK || !backgroundOK {
		return false
	}
	lighter := math.Max(generatedRelativeLuminance(foreground), generatedRelativeLuminance(background))
	darker := math.Min(generatedRelativeLuminance(foreground), generatedRelativeLuminance(background))
	return (lighter+0.05)/(darker+0.05) < 4.5
}

func generatedElementHasVisibleText(node *html.Node) bool {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.TextNode && strings.TrimSpace(child.Data) != "" {
			return true
		}
	}
	return false
}

type generatedRGB struct {
	red, green, blue float64
}

func parseGeneratedColor(raw string) (generatedRGB, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	named := map[string]string{
		"black": "#000000", "white": "#ffffff", "red": "#ff0000",
		"blue": "#0000ff", "green": "#008000", "gray": "#808080",
		"grey": "#808080", "yellow": "#ffff00",
	}
	if replacement, ok := named[value]; ok {
		value = replacement
	}
	if strings.HasPrefix(value, "#") {
		hexValue := strings.TrimPrefix(value, "#")
		if len(hexValue) == 3 {
			hexValue = string([]byte{
				hexValue[0], hexValue[0], hexValue[1],
				hexValue[1], hexValue[2], hexValue[2],
			})
		}
		if len(hexValue) != 6 {
			return generatedRGB{}, false
		}
		parsed, err := strconv.ParseUint(hexValue, 16, 24)
		if err != nil {
			return generatedRGB{}, false
		}
		return generatedRGB{
			red:   float64((parsed >> 16) & 0xff),
			green: float64((parsed >> 8) & 0xff),
			blue:  float64(parsed & 0xff),
		}, true
	}
	match := generatedRGBColorPattern.FindStringSubmatch(value)
	if len(match) != 4 {
		return generatedRGB{}, false
	}
	components := [3]float64{}
	for index := range components {
		component, err := strconv.Atoi(match[index+1])
		if err != nil || component > 255 {
			return generatedRGB{}, false
		}
		components[index] = float64(component)
	}
	return generatedRGB{
		red: components[0], green: components[1], blue: components[2],
	}, true
}

func generatedRelativeLuminance(color generatedRGB) float64 {
	channel := func(value float64) float64 {
		value /= 255
		if value <= 0.03928 {
			return value / 12.92
		}
		return math.Pow((value+0.055)/1.055, 2.4)
	}
	return 0.2126*channel(color.red) +
		0.7152*channel(color.green) +
		0.0722*channel(color.blue)
}

func truncateUTF8Bytes(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return strings.TrimSpace(value)
}
