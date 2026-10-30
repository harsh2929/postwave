// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"html"
	"regexp"
	"sort"
	"testing"
)

var renderedHref = regexp.MustCompile(`href="([^"]*)"`)

func linkRun(label, url string) InlineRun {
	return InlineRun{Kind: InlineLink, Text: label, URL: url}
}

func withLink(prefix, label, url string) RichText {
	return RichText{Runs: []InlineRun{{Kind: InlineText, Text: prefix}, linkRun(label, url)}}
}

// linkParityDocument is validDocumentV2 with a link in every place the HTML
// renderer can put one, and a node only one scenario includes.
func linkParityDocument() DocumentV2 {
	doc := validDocumentV2()
	provenance := Provenance{Source: SourceUser}
	for i := range doc.Nodes {
		content := &doc.Nodes[i].Content
		switch {
		case content.Heading != nil:
			content.Heading.Text = withLink("Workflow Automation ", "Live", "https://example.test/heading")
		case content.List != nil:
			content.List.Items[0] = withLink("Live ", "demonstration", "https://example.test/list")
		case content.Answer != nil:
			content.Answer.Question = withLink("When ", "is it?", "https://example.test/question")
			content.Answer.Answer = withLink("14 August, ", "see the agenda", "https://example.test/answer")
		case content.Offer != nil:
			content.Offer.Description = withLink("Save ₹200 on ", "your reservation", "https://example.test/offer")
			content.Offer.Terms = withLink("Valid for Pro customers, ", "terms", "https://example.test/terms")
		}
	}
	doc.Nodes = append(doc.Nodes,
		Node{
			ID: "blk_free_only", Type: NodeParagraph, Role: RoleBody, Version: NodeVersionV2,
			Content:    NodeContent{Paragraph: &ParagraphContent{Text: withLink("Upgrade ", "today", "https://example.test/free-only")}},
			Conditions: []Condition{{ID: "cond_free", SlotID: "segment", Operator: ConditionEquals, Value: "free"}},
			Provenance: provenance,
		},
		Node{
			ID: "blk_poll", Type: NodePoll, Role: RolePoll, Version: NodeVersionV2,
			Content: NodeContent{Poll: &PollContent{
				PollID:   "venue",
				Question: withLink("Which venue? ", "Compare them", "https://example.test/poll-question"),
				Options: []PollOption{
					{OptionID: "north", Label: withLink("North hall, ", "map", "https://example.test/poll-north")},
					{OptionID: "south", Label: text("South hall")},
				},
			}},
			Provenance: provenance,
		},
		Node{
			ID: "blk_divider", Type: NodeDivider, Role: RoleDivider, Version: NodeVersionV2,
			Content: NodeContent{Divider: &DividerContent{}}, Provenance: provenance,
		},
	)
	return doc
}

// localizedLinkDocument re-points links in a French localization. A locale
// scenario needs every node localized, so it is kept to the three nodes that
// carry links.
func localizedLinkDocument() DocumentV2 {
	provenance := Provenance{Source: SourceUser}
	return DocumentV2{
		SchemaVersion: SchemaVersionV2, Language: "en", Direction: DirectionLTR,
		Nodes: []Node{
			{
				ID: "blk_heading", Type: NodeHeading, Role: RoleHeading, Version: NodeVersionV2,
				Content: NodeContent{Heading: &HeadingContent{Level: 1, Text: withLink("Our ", "launch", "https://example.test/launch")}},
				Localizations: map[string]NodeContent{"fr": {Heading: &HeadingContent{
					Level: 1, Text: withLink("Notre ", "lancement", "https://example.test/fr/launch"),
				}}},
				Provenance: provenance,
			},
			{
				ID: "blk_action", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2,
				Content: NodeContent{Action: &ActionContent{ActionID: "act_buy", Label: "Buy", CanonicalURL: "https://example.test/buy"}},
				Localizations: map[string]NodeContent{"fr": {Action: &ActionContent{
					ActionID: "act_buy", Label: "Acheter", CanonicalURL: "https://example.test/fr/buy",
				}}},
				Provenance: provenance,
			},
			{
				ID: "blk_product", Type: NodeProduct, Role: RoleProduct, Version: NodeVersionV2,
				Content: NodeContent{Product: &ProductContent{Name: "Workshop", CanonicalURL: "https://example.test/workshop"}},
				Localizations: map[string]NodeContent{"fr": {Product: &ProductContent{
					Name: "Atelier", CanonicalURL: "https://example.test/fr/workshop",
				}}},
				Provenance: provenance,
			},
		},
	}
}

func renderedHrefs(t *testing.T, doc DocumentV2, options CompileOptions) map[string]bool {
	t.Helper()
	result, diagnostics := CompileV2(doc, options)
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2: %s", diagnostics.Error())
	}
	out := map[string]bool{}
	for _, match := range renderedHref.FindAllStringSubmatch(result.HTML, -1) {
		out[html.UnescapeString(match[1])] = true
	}
	return out
}

// LinkURLs must name every href any scenario of the tree renders — base and
// localized content, whichever nodes the conditions include — and nothing the
// renderer never writes. A walker that drifts from render.go would let a link
// through the pre-send check unchecked.
func TestLinkURLsCoverEveryRenderedHref(t *testing.T) {
	doc := linkParityDocument()

	covered := map[NodeType]bool{}
	for _, node := range doc.Nodes {
		covered[node.Type] = true
	}
	for nodeType := range validNodeTypes {
		if !covered[nodeType] {
			t.Fatalf("the parity document has no %q node; add one (with a link, if the type can carry one) so a new link field cannot go unwalked", nodeType)
		}
	}

	pro := validCompileOptions()
	free := validCompileOptions()
	free.Slots["segment"] = "free"
	assertWalkMatchesRenderer(t, doc, pro, free)

	localized := localizedLinkDocument()
	french := CompileOptions{Locale: "fr"}
	assertWalkMatchesRenderer(t, localized, CompileOptions{}, french)

	walked := map[string]bool{}
	for _, url := range append(LinkURLs(doc.Nodes), LinkURLs(localized.Nodes)...) {
		walked[url] = true
	}
	for _, want := range []string{"https://example.test/free-only", "https://example.test/fr/buy", "https://example.test/poll-north"} {
		if !walked[want] {
			t.Fatalf("LinkURLs missed %s", want)
		}
	}
}

// assertWalkMatchesRenderer compiles doc under every scenario and requires the
// union of rendered hrefs to be exactly LinkURLs(doc.Nodes).
func assertWalkMatchesRenderer(t *testing.T, doc DocumentV2, scenarios ...CompileOptions) {
	t.Helper()
	rendered := map[string]bool{}
	for _, options := range scenarios {
		for href := range renderedHrefs(t, doc, options) {
			rendered[href] = true
		}
	}
	walked := map[string]bool{}
	for _, url := range LinkURLs(doc.Nodes) {
		walked[url] = true
	}
	if missing, extra := diffKeys(rendered, walked), diffKeys(walked, rendered); len(missing) > 0 || len(extra) > 0 {
		t.Fatalf("LinkURLs disagrees with the renderer:\n  rendered but not walked: %v\n  walked but never rendered: %v", missing, extra)
	}
}

func TestLinkURLsDropsDuplicatesInFirstSeenOrder(t *testing.T) {
	nodes := []Node{
		{Type: NodeAction, Content: NodeContent{Action: &ActionContent{CanonicalURL: "https://example.test/a"}}},
		{Type: NodeParagraph, Content: NodeContent{Paragraph: &ParagraphContent{Text: RichText{Runs: []InlineRun{
			linkRun("b", "https://example.test/b"), linkRun("a again", "https://example.test/a"),
		}}}}},
		{Type: NodeImage, Content: NodeContent{Image: &ImageContent{URL: "https://cdn.example.test/not-a-link.png"}}},
	}
	got := LinkURLs(nodes)
	if len(got) != 2 || got[0] != "https://example.test/a" || got[1] != "https://example.test/b" {
		t.Fatalf("LinkURLs = %v, want [a b] with the image source excluded", got)
	}
}

func diffKeys(a, b map[string]bool) []string {
	var out []string
	for key := range a {
		if !b[key] {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}
