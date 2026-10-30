// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"html"
	"reflect"
	"strings"
	"testing"
)

// Both PRD block types exist in the closed union.
//
// §2.2 lists nine block types; `divider` and `poll` were the two missing, and
// `poll` is F14's hard dependency — a poll feature cannot store a poll in a
// tree that has no node for one.
func TestTheUnionCoversEveryPRDBlockType(t *testing.T) {
	for _, nodeType := range []NodeType{
		NodeHeading, NodeParagraph, NodeImage, NodeAction, NodeList,
		NodeDivider, NodeAnswer, NodeOffer, NodePoll,
	} {
		if _, ok := validNodeTypes[nodeType]; !ok {
			t.Errorf("%q is a PRD §2.2 block type and is not in the closed union", nodeType)
		}
	}
}

func TestNormalizationPreservesPollAndDividerContent(t *testing.T) {
	document := DocumentV2{
		SchemaVersion: SchemaVersionV2, Language: "en", Direction: DirectionAuto,
		Nodes: []Node{
			{
				ID: "divider", Type: NodeDivider, Role: RoleDivider, Version: NodeVersionV2,
				Content: NodeContent{Divider: &DividerContent{}}, Provenance: Provenance{Source: SourceUser},
			},
			{
				ID: "poll", Type: NodePoll, Role: RolePoll, Version: NodeVersionV2,
				Content: NodeContent{Poll: &PollContent{
					PollID:   " venue ",
					Question: RichText{Runs: []InlineRun{{Kind: InlineText, Text: " Which venue? "}}},
					Options: []PollOption{
						{OptionID: " north ", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: " North hall "}}}},
						{OptionID: " south ", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: " South hall "}}}},
					},
				}}, Provenance: Provenance{Source: SourceUser},
			},
		},
	}
	normalized, diagnostics := NormalizeAndValidateV2(document)
	if diagnostics.HasErrors() {
		t.Fatalf("NormalizeAndValidateV2() diagnostics = %v", diagnostics)
	}
	if normalized.Nodes[0].Content.Divider == nil {
		t.Fatal("normalization dropped divider content")
	}
	poll := normalized.Nodes[1].Content.Poll
	if poll == nil || poll.PollID != "venue" || len(poll.Options) != 2 ||
		poll.Options[0].OptionID != "north" || poll.Options[1].OptionID != "south" {
		t.Fatalf("normalization dropped or corrupted poll content: %+v", poll)
	}
}

// A divider is decoration, and every parser-facing projection drops it.
func TestADividerIsDroppedFromPlainText(t *testing.T) {
	got := renderTextNode(resolvedNode{
		node:    Node{ID: "sep", Type: NodeDivider, Role: RoleDivider, Version: 2},
		content: NodeContent{Divider: &DividerContent{}},
	})
	if got != "" {
		t.Fatalf("divider emitted %q into the plain-text part; it competes with "+
			"the content for a summariser's attention and means nothing to a parser", got)
	}
}

// A poll renders its question and every option.
func TestAPollRendersItsQuestionAndOptions(t *testing.T) {
	poll := NodeContent{Poll: &PollContent{
		PollID:   "venue",
		Question: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "Which venue?"}}},
		Options: []PollOption{
			{OptionID: "north", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "North hall"}}}},
			{OptionID: "south", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "South hall"}}}},
		},
	}}
	got := renderTextNode(resolvedNode{
		node:    Node{ID: "poll", Type: NodePoll, Role: RolePoll, Version: 2},
		content: poll,
	})
	for _, want := range []string{"Which venue?", "- North hall", "- South hall"} {
		if !strings.Contains(got, want) {
			t.Errorf("poll text %q is missing %q", got, want)
		}
	}
}

// The poll node carries no per-recipient URLs.
//
// A semantic tree is shared across every recipient by construction, so a
// per-(recipient, option) URL stored here would either be one recipient's URL
// sent to everyone — recording every vote against one person — or a template
// that is not a URL. The tree holds identity; send time mints the links.
func TestAPollNodeHoldsNoPerRecipientURLs(t *testing.T) {
	for _, target := range []reflect.Type{
		reflect.TypeOf(PollOption{}),
		reflect.TypeOf(PollContent{}),
	} {
		// Guard the guard: a zero-field read would pass vacuously.
		if target.NumField() == 0 {
			t.Fatalf("%s has no fields; this assertion would be vacuous", target.Name())
		}
		for i := 0; i < target.NumField(); i++ {
			name := strings.ToLower(target.Field(i).Name)
			if strings.Contains(name, "url") || strings.Contains(name, "link") {
				t.Errorf("%s.%s looks like a per-recipient link. A tree is shared by "+
					"every recipient, so a stored URL is either one person's link sent "+
					"to everyone or not a URL at all; mint them at send time",
					target.Name(), target.Field(i).Name)
			}
		}
	}
}

func TestPollLinksAreRecipientCompilerInputInBothRepresentations(t *testing.T) {
	document := DocumentV2{
		SchemaVersion: SchemaVersionV2,
		Language:      "en",
		Direction:     DirectionAuto,
		Nodes: []Node{{
			ID: "poll-node", Type: NodePoll, Role: RolePoll, Version: NodeVersionV2,
			Content: NodeContent{Poll: &PollContent{
				PollID:   "venue",
				Question: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "Which venue?"}}},
				Options: []PollOption{
					{OptionID: "north", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "North hall"}}}},
					{OptionID: "south", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "South hall"}}}},
				},
			}},
			Provenance: Provenance{Source: SourceUser},
		}},
	}
	links := PollOptionLinks{"venue": {
		"north": "https://api.example.test/api/public/polls/t/venue/north?r=opaque&t=token",
		"south": "https://api.example.test/api/public/polls/t/venue/south?r=opaque&t=token",
	}}

	result, diagnostics := CompileV2(document, CompileOptions{Locale: "en", PollOptionLinks: links})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	for _, want := range []string{links["venue"]["north"], links["venue"]["south"]} {
		if !strings.Contains(result.HTML, html.EscapeString(want)) || !strings.Contains(result.Text, want) {
			t.Fatalf("recipient poll link %q missing from projections\nHTML=%s\nText=%s", want, result.HTML, result.Text)
		}
	}
	if !strings.Contains(result.HTML, `data-postwave-poll-option="north"`) {
		t.Fatalf("HTML poll option identity missing: %s", result.HTML)
	}
}

func TestPollLinkCompilationFailsClosedOnPartialOrInsecureInput(t *testing.T) {
	document := DocumentV2{
		SchemaVersion: SchemaVersionV2, Language: "en", Direction: DirectionAuto,
		Nodes: []Node{{
			ID: "poll-node", Type: NodePoll, Role: RolePoll, Version: NodeVersionV2,
			Content: NodeContent{Poll: &PollContent{
				PollID:   "venue",
				Question: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "Which venue?"}}},
				Options: []PollOption{
					{OptionID: "north", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "North"}}}},
					{OptionID: "south", Label: RichText{Runs: []InlineRun{{Kind: InlineText, Text: "South"}}}},
				},
			}}, Provenance: Provenance{Source: SourceUser},
		}},
	}
	_, diagnostics := CompileV2(document, CompileOptions{Locale: "en", PollOptionLinks: PollOptionLinks{
		"venue": {"north": "http://example.test/north"},
	}})
	if !diagnostics.HasErrors() || !diagnostics.HasCode(CodeHTTPSRequired) || !diagnostics.HasCode(CodeRequired) {
		t.Fatalf("partial HTTP poll links did not fail closed: %v", diagnostics)
	}
}
