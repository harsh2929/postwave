// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"strings"
	"testing"
	"time"
)

func buildTestDecoys(t *testing.T) []Decoy {
	t.Helper()
	minter := testMinter(t)
	decoys, err := Build(minter, testClaim(time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)),
		"https://track.example.test/base")
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if len(decoys) == 0 {
		t.Fatal("Build produced no decoys")
	}
	return decoys
}

func TestEveryBuiltDecoyUsesACertifyingTechnique(t *testing.T) {
	for _, decoy := range buildTestDecoys(t) {
		if !decoy.Technique.Certifies() {
			t.Errorf("Build emitted technique %q, which cannot certify a label", decoy.Technique)
		}
	}
}

func TestBuildEmitsACommentDecoyThatSurvivesStyleStripping(t *testing.T) {
	// The residual risk in every CSS-hidden decoy: a client that strips the
	// style attribute turns display:none into a plainly visible link, and the
	// next human who clicks it is certified as a machine. A URL inside an HTML
	// comment has no such failure mode — a comment is a comment whatever
	// happens to the CSS, and there is no rendering, no tab stop and no
	// accessibility node to activate.
	var found bool
	for _, decoy := range buildTestDecoys(t) {
		if decoy.Technique != TechniqueHTMLComment {
			continue
		}
		found = true
		markup := string(decoy.HTMLMarkup)
		if !strings.HasPrefix(strings.TrimSpace(markup), "<!--") || !strings.HasSuffix(strings.TrimSpace(markup), "-->") {
			t.Errorf("comment decoy markup is not wholly a comment: %q", markup)
		}
		if strings.Contains(markup, "<a") || strings.Contains(markup, "href") {
			t.Errorf("comment decoy carries an anchor, which a style-stripping client could render: %q", markup)
		}
	}
	if !found {
		t.Error("Build emitted no HTML-comment decoy, so every decoy depends on CSS surviving")
	}
}

func TestDisplayNoneDecoyCarriesNoAnchorText(t *testing.T) {
	// Defence in depth for the same failure. If the style attribute is stripped,
	// an anchor with no content generates no clickable box, so there is still
	// nothing for a human to hit.
	var found bool
	for _, decoy := range buildTestDecoys(t) {
		if decoy.Technique != TechniqueDisplayNone {
			continue
		}
		found = true
		markup := string(decoy.HTMLMarkup)
		opening := strings.Index(markup, "</a>")
		if opening < 0 {
			t.Fatalf("display:none decoy has no closing anchor: %q", markup)
		}
		inner := markup[strings.Index(markup, ">")+1 : opening]
		if strings.TrimSpace(inner) != "" {
			t.Errorf("display:none decoy anchor has text %q; stripped CSS would leave it clickable", inner)
		}
		if !strings.Contains(markup, "display:none") {
			t.Errorf("display:none decoy does not carry an inline display:none: %q", markup)
		}
	}
	if !found {
		t.Error("Build emitted no display:none decoy, so this test proved nothing")
	}
}

func TestNoDecoyUsesTheOffScreenIdiom(t *testing.T) {
	// A regression guard with a specific history: off-screen positioning is the
	// tempting way to hide things and the one that captures screen-reader users.
	for _, decoy := range buildTestDecoys(t) {
		markup := strings.ToLower(string(decoy.HTMLMarkup))
		for _, banned := range []string{"sr-only", "position:absolute", "left:-", "text-indent", "clip:"} {
			if strings.Contains(markup, banned) {
				t.Errorf("decoy %q uses %q, which assistive technology can still reach: %q",
					decoy.Technique, banned, markup)
			}
		}
	}
}

func TestDecoyMarkupIsNotHTMLInjectable(t *testing.T) {
	// The URL is built from a signed token and a caller-supplied base. A base
	// carrying markup must not be able to close the attribute and escape into
	// the surrounding document.
	minter := testMinter(t)
	claim := testClaim(time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	_, err := Build(minter, claim, `https://evil.test/"><script>alert(1)</script>`)
	if err == nil {
		t.Fatal("Build accepted a base URL containing markup")
	}
}

func TestBuildRejectsANonHTTPSBase(t *testing.T) {
	// A decoy fetched over plaintext would expose the recipient HMAC to the
	// network, and the fetch we are measuring is exactly the hop we do not
	// control.
	minter := testMinter(t)
	claim := testClaim(time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	if _, err := Build(minter, claim, "http://track.example.test/base"); err == nil {
		t.Error("Build accepted a plaintext base URL")
	}
}

func TestEachDecoyGetsADistinctToken(t *testing.T) {
	// One label per technique per recipient. Sharing a token across techniques
	// would make it impossible to tell which hiding method a scanner actually
	// followed, which is the measurement that tells us whether the CSS decoy is
	// still earning its spam-filter cost.
	decoys := buildTestDecoys(t)
	seen := make(map[string]Technique, len(decoys))
	for _, decoy := range decoys {
		if previous, duplicate := seen[decoy.Token]; duplicate {
			t.Errorf("techniques %q and %q share a token", previous, decoy.Technique)
		}
		seen[decoy.Token] = decoy.Technique
	}
}

func TestDecoyURLVerifiesBackToItsClaim(t *testing.T) {
	minter := testMinter(t)
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	decoys := buildTestDecoys(t)
	for _, decoy := range decoys {
		claim, err := minter.Verify(decoy.Token, issued.Add(time.Hour))
		if err != nil {
			t.Fatalf("token for %q did not verify: %v", decoy.Technique, err)
		}
		if claim.Technique != decoy.Technique {
			t.Errorf("token for %q claims technique %q", decoy.Technique, claim.Technique)
		}
		if !strings.Contains(string(decoy.HTMLMarkup), decoy.Token) {
			t.Errorf("markup for %q does not contain its own token", decoy.Technique)
		}
	}
}
