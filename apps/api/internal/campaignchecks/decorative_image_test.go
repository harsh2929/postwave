// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"strings"
	"testing"
)

func imageFindingCodes(t *testing.T, html string) []string {
	t.Helper()
	analysis := &analysis{
		input:       Input{},
		deduplicate: map[string]struct{}{},
		images:      map[string]ImageMetadata{},
	}
	analysis.input.Compilation.HTML = html
	analysis.html = analyzeHTML(analysis)
	codes := make([]string, 0, len(analysis.findings))
	for _, finding := range analysis.findings {
		codes = append(codes, finding.Code)
	}
	return codes
}

func hasCode(codes []string, code string) bool {
	for _, candidate := range codes {
		if candidate == code {
			return true
		}
	}
	return false
}

// aria-hidden="true" is the standard way to mark a decorative image, and
// role="none" is role="presentation"'s synonym since ARIA 1.1. Accepting only
// role="presentation" means an author who follows the accessibility guidance
// gets penalised BY the accessibility check — the worst kind of false
// positive, because it teaches people to write worse markup.
//
// Found by running the analyzer over the assurance corpus: a fixture asserting
// a correctly-marked decorative spacer fired INFORMATIVE_IMAGE_ALT_EMPTY.
func TestDecorativeImagesAreRecognisedByEveryStandardMarking(t *testing.T) {
	for name, markup := range map[string]string{
		"role=presentation":      `<img src="https://cdn.example.com/s.png" alt="" role="presentation">`,
		"role=none":              `<img src="https://cdn.example.com/s.png" alt="" role="none">`,
		"aria-hidden":            `<img src="https://cdn.example.com/s.png" alt="" aria-hidden="true">`,
		"aria-hidden mixed case": `<img src="https://cdn.example.com/s.png" alt="" aria-hidden="TRUE">`,
	} {
		codes := imageFindingCodes(t, "<html><body>"+markup+"</body></html>")
		if hasCode(codes, "INFORMATIVE_IMAGE_ALT_EMPTY") {
			t.Errorf("%s: correctly-marked decorative image was reported as an "+
				"informative image with an empty alt: %s", name, strings.Join(codes, ","))
		}
	}
}

// The rule must not swing the other way: an image with no decorative marking
// and an empty alt is still the case the check exists to catch.
func TestAnUnmarkedImageWithEmptyAltIsStillReported(t *testing.T) {
	codes := imageFindingCodes(t,
		`<html><body><img src="https://cdn.example.com/hero.png" alt=""></body></html>`)
	if !hasCode(codes, "INFORMATIVE_IMAGE_ALT_EMPTY") {
		t.Fatalf("an unmarked image with an empty alt was not reported: %s",
			strings.Join(codes, ","))
	}
}

// aria-hidden="false" is an explicit statement that the image IS exposed, so it
// must not be read as decorative.
func TestAriaHiddenFalseDoesNotMarkAnImageDecorative(t *testing.T) {
	codes := imageFindingCodes(t,
		`<html><body><img src="https://cdn.example.com/hero.png" alt="" aria-hidden="false"></body></html>`)
	if !hasCode(codes, "INFORMATIVE_IMAGE_ALT_EMPTY") {
		t.Fatalf("aria-hidden=false was treated as decorative: %s", strings.Join(codes, ","))
	}
}
