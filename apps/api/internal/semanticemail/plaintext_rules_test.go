// SPDX-License-Identifier: AGPL-3.0-only
//
// The literal §9 plain-text rules, each with the reason it is literal.

package semanticemail

import (
	"strings"
	"testing"
)

func textFor(t *testing.T, node Node) string {
	t.Helper()
	return renderTextNode(resolvedNode{node: node, content: node.Content})
}

// An informative image contributes its alt text and nothing else.
//
// The PRD names the failure directly — "alt text only… Never `[image]`" — and a
// synthetic "Image: " prefix is the same mistake in different words: it spends
// the reader's attention on a rendering detail, and an extractor reads the
// prefix as part of the alt text.
func TestAnInformativeImageContributesAltTextAlone(t *testing.T) {
	got := textFor(t, Node{
		ID: "hero", Type: NodeImage, Role: RoleInformativeImage, Version: 2,
		Content: NodeContent{Image: &ImageContent{
			URL: "https://cdn.example.test/hero.png", Alt: "Doors open at 7pm", Width: 600, Height: 200,
		}},
	})
	if got != "Doors open at 7pm" {
		t.Fatalf("image text = %q, want the alt text alone", got)
	}
}

// A decorative image contributes nothing at all.
func TestADecorativeImageContributesNothing(t *testing.T) {
	got := textFor(t, Node{
		ID: "rule", Type: NodeImage, Role: RoleDecorativeImage, Version: 2,
		Content: NodeContent{Image: &ImageContent{URL: "https://cdn.example.test/x.png", Width: 1, Height: 1}},
	})
	if got != "" {
		t.Fatalf("decorative image emitted %q; it is not content", got)
	}
}

// The primary action is distinguishable from every other link.
//
// Before this, the one thing the message asks for rendered exactly like the
// unsubscribe link — in the representation AI summarisers prefer. The node model
// carried the role and the projection discarded it.
func TestThePrimaryActionIsMarkedAndSecondaryActionsAreNot(t *testing.T) {
	primary := textFor(t, Node{
		ID: "cta", Type: NodeAction, Role: RolePrimaryAction, Version: 2,
		Content: NodeContent{Action: &ActionContent{Label: "Reserve a seat", CanonicalURL: "https://example.test/rsvp"}},
	})
	secondary := textFor(t, Node{
		ID: "alt", Type: NodeAction, Role: RoleSecondaryAction, Version: 2,
		Content: NodeContent{Action: &ActionContent{Label: "Read the agenda", CanonicalURL: "https://example.test/agenda"}},
	})

	if !strings.HasPrefix(primary, primaryActionMarker+" ") {
		t.Errorf("primary action = %q, want the %q marker", primary, primaryActionMarker)
	}
	if strings.Contains(secondary, primaryActionMarker) {
		t.Errorf("secondary action = %q carries the primary marker; if everything is "+
			"marked, nothing is", secondary)
	}
	if strings.TrimPrefix(primary, primaryActionMarker+" ") == secondary {
		t.Error("primary and secondary actions are indistinguishable once the marker " +
			"is removed, which was the original defect")
	}
}

// Links use parentheses, not angle brackets.
func TestLinksRenderWithParentheses(t *testing.T) {
	got := renderTextRichText(RichText{Runs: []InlineRun{
		{Kind: InlineText, Text: "See the "},
		{Kind: InlineLink, Text: "agenda", URL: "https://example.test/agenda"},
	}})
	want := "See the agenda (https://example.test/agenda)"
	if got != want {
		t.Fatalf("link text = %q, want %q", got, want)
	}
	if strings.Contains(got, "<") {
		t.Error("angle brackets are auto-linkified by some clients and fold-parsed " +
			"by others, so the URL a reader sees and the one a parser extracts can differ")
	}
}

// A product does not announce its own image.
func TestAProductDoesNotPrintItsNameTwice(t *testing.T) {
	got := textFor(t, Node{
		ID: "p1", Type: NodeProduct, Role: RoleProduct, Version: 2,
		Content: NodeContent{Product: &ProductContent{
			Name: "Field Notes", ImageURL: "https://cdn.example.test/fn.png",
		}},
	})
	if strings.Count(got, "Field Notes") != 1 {
		t.Fatalf("product text = %q; the name appears %d times — the synthetic "+
			"image line duplicated it and an extractor reads two entities",
			got, strings.Count(got, "Field Notes"))
	}
	if strings.Contains(got, "Image:") {
		t.Errorf("product text = %q still carries a synthetic image prefix", got)
	}
}
