// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"reflect"
	"strings"
	"testing"
)

// cleanLegacyMessage uses only constructs the closed union can carry.
const cleanLegacyMessage = `<!doctype html>
<html>
<head><title>Launch</title><meta charset="utf-8"></head>
<body>
<div>
  <h1>Workflow Automation Live</h1>
  <p>Hello, see our <strong>new workflow</strong> in action.</p>
  <p>Read the <a href="https://example.test/notes" aria-label="Release notes">release notes</a>.<br>It takes two minutes.</p>
  <ul><li>Live demonstration</li><li>Question and answer</li></ul>
  <hr>
  <img src="https://cdn.example.test/promo.jpg" alt="Speakers on stage" width="1910" height="1000">
  <img src="https://cdn.example.test/spacer.png" alt="">
</div>
</body>
</html>`

func importCleanMessage(t *testing.T) DocumentV2 {
	t.Helper()
	result := ImportLegacyHTML(cleanLegacyMessage, ImportOptions{SourceID: "rev_1"})
	document, ok := result.Document()
	if !ok {
		t.Fatalf("a message built only from mappable constructs was refused: unmapped=%+v diagnostics=%s",
			result.Unmapped, result.Diagnostics.Error())
	}
	return document
}

// A construct outside the union must never become a paragraph.
//
// This is the whole thesis of the importer. An importer that quietly turns an
// unrepresentable construct into the nearest node that validates produces a tree
// that claims to describe a message it does not describe, and every check
// downstream then reports confidently about the wrong thing. So for each case
// below the sentinel text must be absent from EVERY node the importer produced —
// not merely absent from a paragraph, absent entirely.
func TestUnmappableConstructsAreNeverSilentlyFlattened(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		markup   string
		sentinel string
		reason   UnmappedReason
	}{
		{
			name:     "a quotation is not a paragraph the sender wrote",
			markup:   `<div><blockquote>SENTINEL</blockquote></div>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "a table that has not declared itself layout keeps its meaning or is refused",
			markup:   `<table><tr><td>SENTINEL</td></tr></table>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "an interactive form has no semantic node",
			markup:   `<div><form><label>SENTINEL</label><input name="q"></form></div>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "a button is not a paragraph",
			markup:   `<div><button>SENTINEL</button></div>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "embedded media is not text",
			markup:   `<div><video src="https://cdn.example.test/v.mp4">SENTINEL</video></div>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "preformatted text loses its meaning under whitespace normalization",
			markup:   "<div><pre>SENTINEL\n  indented</pre></div>",
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "an inline construct outside the union refuses its whole block",
			markup:   `<p>He said <q>SENTINEL</q> loudly.</p>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "a list inside a list item has no shape in the union",
			markup:   `<ul><li>SENTINEL<ul><li>deeper</li></ul></li></ul>`,
			sentinel: "SENTINEL", reason: UnmappedUnsupportedElement,
		},
		{
			name:     "content hidden by an inline style is not content a reader sees",
			markup:   `<div style="display:none">SENTINEL</div>`,
			sentinel: "SENTINEL", reason: UnmappedHiddenContent,
		},
		{
			name:     "aria-hidden content is declared not to be content",
			markup:   `<div aria-hidden="true"><p>SENTINEL</p></div>`,
			sentinel: "SENTINEL", reason: UnmappedHiddenContent,
		},
		{
			name:     "a conditional comment describes two different messages",
			markup:   `<div><!--[if mso]><p>SENTINEL</p><![endif]--></div>`,
			sentinel: "SENTINEL", reason: UnmappedConditionalRendering,
		},
		{
			name:     "a mailto link is not an http link",
			markup:   `<p>Write to <a href="mailto:sales@example.test">SENTINEL</a> today.</p>`,
			sentinel: "SENTINEL", reason: UnmappedUnrepresentableURL,
		},
		{
			name:     "a relative link cannot be resolved without inventing a base",
			markup:   `<p>Go <a href="/deals">SENTINEL</a> now.</p>`,
			sentinel: "SENTINEL", reason: UnmappedUnrepresentableURL,
		},
		{
			name:     "a fragment-bearing link is not a canonical URL",
			markup:   `<p>Jump <a href="https://example.test/page#top">SENTINEL</a>.</p>`,
			sentinel: "SENTINEL", reason: UnmappedUnrepresentableURL,
		},
		{
			name:     "an image wrapped in a link has no representation",
			markup:   `<p><a href="https://example.test/x"><img src="https://cdn.example.test/i.png" alt="SENTINEL"></a></p>`,
			sentinel: "SENTINEL", reason: UnmappedNestedStructure,
		},
		{
			name:     "emphasis inside emphasis has no representation",
			markup:   `<p>Try <strong>SENTINEL <em>now</em></strong>.</p>`,
			sentinel: "SENTINEL", reason: UnmappedNestedStructure,
		},
		{
			name:     "an anchor carrying a URL and no text is refused rather than dropped",
			markup:   `<p>before<a href="https://example.test/pixel"></a>after</p>`,
			sentinel: "before", reason: UnmappedEmptyConstruct,
		},
		{
			name:   "an image with no alt attribute states neither informative nor decorative",
			markup: `<div><img src="https://cdn.example.test/x.png"></div>`,
			reason: UnmappedAmbiguousImage,
		},
		{
			name:   "an image the union cannot reference is refused",
			markup: `<div><img src="cid:logo123" alt="Logo"></div>`,
			reason: UnmappedUnrepresentableURL,
		},
		{
			name:   "a stylesheet that can hide content leaves visibility unprovable",
			markup: `<html><head><style>.preheader{display:none}</style></head><body><p>kept</p></body></html>`,
			reason: UnmappedHiddenContent,
		},
		{
			name:   "active content changes what the message does",
			markup: `<div><script>var a=1;</script><p>kept</p></div>`,
			reason: UnmappedUnsupportedElement,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result := ImportLegacyHTML(testCase.markup, ImportOptions{})

			if len(result.Unmapped) == 0 {
				t.Fatalf("construct imported with nothing reported unmapped; nodes=%+v", result.PartialNodes())
			}
			if !hasUnmappedReason(result.Unmapped, testCase.reason) {
				t.Fatalf("unmapped reasons = %+v, want one %q", result.Unmapped, testCase.reason)
			}
			if result.Complete() {
				t.Fatal("import reported itself complete while a construct was unmapped")
			}
			if _, ok := result.Document(); ok {
				t.Fatal("a lossy import handed back a document; downstream checks would then " +
					"report confidently about a message the tree does not describe")
			}
			if testCase.sentinel != "" {
				if found := nodeTreeContainsText(result.PartialNodes(), testCase.sentinel); found {
					t.Fatalf("unmappable content %q was flattened into the tree: %+v",
						testCase.sentinel, result.PartialNodes())
				}
			}
		})
	}
}

// A block is never emitted with a hole where an unmappable piece was.
//
// This is the most dangerous shape available to an importer, because the result
// validates, reads naturally, and is a sentence the sender did not write. The
// surrounding words must go with the refused piece.
func TestABlockIsNeverEmittedWithAHoleInIt(t *testing.T) {
	for _, testCase := range []struct{ name, markup string }{
		{"an unsupported inline element mid-sentence", `<p>He said <q>maybe</q> loudly.</p>`},
		{"an unresolvable link mid-sentence", `<p>Write to <a href="mailto:x@example.test">sales</a> today.</p>`},
		{"an unsupported inline element inside a heading", `<h2>Spring <code>SALE</code> begins</h2>`},
		{"an unsupported inline element inside a list item", `<ul><li>first</li><li>second <q>maybe</q></li></ul>`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result := ImportLegacyHTML(testCase.markup, ImportOptions{})
			if nodes := result.PartialNodes(); len(nodes) != 0 {
				t.Fatalf("the block was emitted without its refused piece: %+v", nodes)
			}
			if len(result.Unmapped) == 0 {
				t.Fatal("nothing was reported unmapped")
			}
		})
	}
}

// The refusal must be driven by the unmapped report itself.
//
// The previous test's cases mostly map nothing at all, so an implementation that
// forgot to check Unmapped could still refuse them for being empty. This case
// maps a heading, a paragraph and a divider cleanly, produces no validation
// error at all, and contains exactly one unmappable construct — so the ONLY
// reason to refuse is the unmapped report.
func TestALossyImportIsRefusedEvenWhenAlmostEverythingMapped(t *testing.T) {
	result := ImportLegacyHTML(`<div>
  <h1>Spring release</h1>
  <p>Everything here maps cleanly.</p>
  <hr>
  <blockquote>Except this.</blockquote>
</div>`, ImportOptions{})

	if len(result.PartialNodes()) != 3 {
		t.Fatalf("expected the mappable part to map (heading, paragraph, divider); got %+v",
			result.PartialNodes())
	}
	if result.Diagnostics.HasErrors() {
		t.Fatalf("the mapped part is valid; the refusal must come from the unmapped report, "+
			"not from validation: %s", result.Diagnostics.Error())
	}
	if len(result.Unmapped) != 1 {
		t.Fatalf("unmapped = %+v, want exactly the blockquote", result.Unmapped)
	}
	if result.Complete() {
		t.Fatal("Complete reported true while one construct was unmapped")
	}
	if _, ok := result.Document(); ok {
		t.Fatal("Document handed back a tree that is missing part of the message")
	}
}

// The other half of the gate: a tree that is complete but INVALID is refused too.
//
// Isolated from the unmapped report on purpose. Nothing here is unmappable —
// there are simply more paragraphs than the union permits — so only the
// validation half of the gate can refuse it.
func TestAnImportThatBreaksAUnionLimitIsRefused(t *testing.T) {
	var markup strings.Builder
	markup.WriteString("<div>")
	for index := range maxNodes + 1 {
		markup.WriteString("<p>paragraph ")
		markup.WriteString(strings.Repeat("x", 1))
		markup.WriteString(string(rune('a' + index%26)))
		markup.WriteString("</p>")
	}
	markup.WriteString("</div>")

	result := ImportLegacyHTML(markup.String(), ImportOptions{})
	if len(result.Unmapped) != 0 {
		t.Fatalf("nothing here is unmappable; unmapped = %+v", result.Unmapped)
	}
	if !result.Diagnostics.HasCode(CodeLimitExceeded) {
		t.Fatalf("expected the node-count limit to be reported; diagnostics = %s",
			result.Diagnostics.Error())
	}
	if result.Complete() {
		t.Fatal("Complete reported true for a tree the union rejects")
	}
	if _, ok := result.Document(); ok {
		t.Fatal("Document handed back a tree that fails v2 validation")
	}
}

// A clean message survives import -> compile -> import unchanged.
//
// This is the strongest available statement that the importer and the
// projections agree about what the union means: the tree the importer builds
// from HTML, and the tree the importer builds from the HTML the compiler
// projects from that tree, are the same tree.
func TestACleanMessageRoundTripsThroughCompilation(t *testing.T) {
	first := importCleanMessage(t)

	compiled, diagnostics := CompileV2(first, CompileOptions{})
	if diagnostics.HasErrors() {
		t.Fatalf("compiling an imported tree failed: %s", diagnostics.Error())
	}

	reimported := ImportLegacyHTML(compiled.HTML, ImportOptions{SourceID: "rev_1"})
	second, ok := reimported.Document()
	if !ok {
		t.Fatalf("the compiler's own HTML did not re-import: unmapped=%+v diagnostics=%s",
			reimported.Unmapped, reimported.Diagnostics.Error())
	}

	if !reflect.DeepEqual(first, second) {
		t.Fatalf("round trip changed the tree.\nfirst:  %+v\nsecond: %+v", first.Nodes, second.Nodes)
	}
	if len(first.Nodes) != 7 {
		t.Fatalf("expected heading, two paragraphs, list, divider and two images; got %d nodes", len(first.Nodes))
	}
}

// The projections of an imported tree say what the union promises they say.
func TestImportedTreeProjectionsMatchTheUnionsPromises(t *testing.T) {
	document := importCleanMessage(t)
	compiled, diagnostics := CompileV2(document, CompileOptions{})
	if diagnostics.HasErrors() {
		t.Fatalf("compile failed: %s", diagnostics.Error())
	}

	for _, want := range []string{
		`<h1 data-postwave-node="imported_1" data-postwave-role="heading">Workflow Automation Live</h1>`,
		`<strong>new workflow</strong>`,
		`<a href="https://example.test/notes" aria-label="Release notes">release notes</a>`,
		`<li>Live demonstration</li>`,
		`<hr data-postwave-node="imported_5" data-postwave-role="divider" role="presentation">`,
		`alt="Speakers on stage" width="1910" height="1000"`,
		`alt="" role="presentation"`,
	} {
		if !strings.Contains(compiled.HTML, want) {
			t.Errorf("compiled HTML is missing %q", want)
		}
	}

	text := compiled.Text
	for _, want := range []string{
		"Workflow Automation Live",
		"Hello, see our new workflow in action.",
		"release notes (https://example.test/notes)",
		"- Live demonstration",
		"Speakers on stage",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("plain-text projection is missing %q\n%s", want, text)
		}
	}
	// The union promises the text projection is authored, not an HTML strip: a
	// decorative image and a divider contribute nothing to it.
	if strings.Contains(text, "spacer") || strings.Contains(text, "Image:") {
		t.Errorf("decorative image leaked into the text projection:\n%s", text)
	}
	if strings.Contains(text, "---") || strings.Contains(text, "___") {
		t.Errorf("the divider leaked into the text projection:\n%s", text)
	}
}

// A whitespace-only inline run cannot survive as a run, and dropping it would
// join two words. It has to be merged.
func TestImportPreservesWordBoundariesBetweenInlineSpans(t *testing.T) {
	for _, testCase := range []struct{ name, markup, want string }{
		{"between two emphasised spans", `<p><em>alpha</em> <em>beta</em></p>`, "alpha beta"},
		{"across an empty span", `<p>one <span> </span>two</p>`, "one two"},
		{"around a strong span", `<p>read <strong>this</strong> now</p>`, "read this now"},
		{"across a newline in the source", "<p>read\n<strong>this</strong>\nnow</p>", "read this now"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			result := ImportLegacyHTML(testCase.markup, ImportOptions{})
			document, ok := result.Document()
			if !ok {
				t.Fatalf("refused: unmapped=%+v diagnostics=%s", result.Unmapped, result.Diagnostics.Error())
			}
			compiled, diagnostics := CompileV2(document, CompileOptions{})
			if diagnostics.HasErrors() {
				t.Fatalf("compile failed: %s", diagnostics.Error())
			}
			if got := strings.TrimSpace(compiled.Text); got != testCase.want {
				t.Fatalf("text projection = %q, want %q", got, testCase.want)
			}
		})
	}
}

// Whatever the importer hands back must be a tree the union accepts. An importer
// that emits an invalid tree pushes its own bug into every consumer.
func TestAnImporterOutputIsAlwaysAValidTree(t *testing.T) {
	corpus := []string{
		cleanLegacyMessage,
		`<div><p>   </p><p>&nbsp;</p><h2>Only heading</h2></div>`,
		`<table role="presentation"><tr><td>Cell text</td><td><p>Wrapped</p></td></tr></table>`,
		`<div><p><img src="https://cdn.example.test/a.png" alt="Solo image"></p></div>`,
		`<ol><li>first</li><li></li><li>third</li></ol>`,
		`<div><blockquote>refused</blockquote><p>kept</p></div>`,
		``,
		`<html><body></body></html>`,
	}
	completeCount := 0
	for _, markup := range corpus {
		result := ImportLegacyHTML(markup, ImportOptions{})
		if document, ok := result.Document(); ok {
			completeCount++
			if _, diagnostics := NormalizeAndValidateV2(document); diagnostics.HasErrors() {
				t.Fatalf("importer returned a document the union rejects for %q: %s",
					markup, diagnostics.Error())
			}
			continue
		}
		// Even a refused import must not produce nodes that would not validate,
		// because a review surface renders them.
		partial := result.PartialNodes()
		if len(partial) == 0 {
			continue
		}
		if _, diagnostics := NormalizeAndValidateV2(DocumentV2{
			SchemaVersion: SchemaVersionV2, Language: "en", Direction: DirectionAuto, Nodes: partial,
		}); diagnostics.HasErrors() {
			t.Fatalf("partial nodes for %q do not validate: %s", markup, diagnostics.Error())
		}
	}
	if completeCount < 4 {
		t.Fatalf("only %d corpus entries imported completely; this test would be vacuous", completeCount)
	}
}

// A layout table is importable only once its author says it is layout.
func TestOnlyADeclaredLayoutTableIsDescendedInto(t *testing.T) {
	layout := ImportLegacyHTML(`<table role="presentation"><tr><td><h2>Deal</h2></td><td>Save today</td></tr></table>`, ImportOptions{})
	document, ok := layout.Document()
	if !ok {
		t.Fatalf("a declared layout table was refused: unmapped=%+v diagnostics=%s",
			layout.Unmapped, layout.Diagnostics.Error())
	}
	if len(document.Nodes) != 2 ||
		document.Nodes[0].Type != NodeHeading || document.Nodes[1].Type != NodeParagraph {
		t.Fatalf("layout table cells did not import in reading order: %+v", document.Nodes)
	}

	data := ImportLegacyHTML(`<table><tr><th>Item</th><th>Price</th></tr><tr><td>Shirt</td><td>10</td></tr></table>`, ImportOptions{})
	if data.Complete() {
		t.Fatal("a table that never declared itself layout was imported; its grid may carry " +
			"meaning the union cannot express")
	}
	if nodeTreeContainsText(data.PartialNodes(), "Shirt") {
		t.Fatalf("data table cells leaked into the tree: %+v", data.PartialNodes())
	}
}

// alt="" and a missing alt are different claims and must stay different.
func TestImageAltDistinguishesDecorativeFromUnknown(t *testing.T) {
	decorative := ImportLegacyHTML(`<div><img src="https://cdn.example.test/s.png" alt=""></div>`, ImportOptions{})
	document, ok := decorative.Document()
	if !ok {
		t.Fatalf(`alt="" is a decorative claim and must import: %+v`, decorative.Unmapped)
	}
	if document.Nodes[0].Role != RoleDecorativeImage {
		t.Fatalf(`alt="" imported as %q, want decorative`, document.Nodes[0].Role)
	}

	unknown := ImportLegacyHTML(`<div><img src="https://cdn.example.test/s.png"></div>`, ImportOptions{})
	if unknown.Complete() {
		t.Fatal("an image with no alt attribute was imported; the union forces a choice " +
			"between informative and decorative and the markup made neither claim")
	}
	for _, node := range unknown.PartialNodes() {
		if node.Type == NodeImage {
			t.Fatalf("a missing alt was resolved into a %q image node", node.Role)
		}
	}
}

// Imported nodes must be identifiable as imported.
func TestImportedNodesRecordMigrationProvenance(t *testing.T) {
	result := ImportLegacyHTML(`<div><h1>Title</h1><p>Body</p></div>`,
		ImportOptions{SourceID: "campaign_rev_42", NodeIDPrefix: "legacy"})
	document, ok := result.Document()
	if !ok {
		t.Fatalf("refused: %+v %s", result.Unmapped, result.Diagnostics.Error())
	}
	for index, node := range document.Nodes {
		if node.Provenance.Source != SourceMigration {
			t.Errorf("node %d provenance = %q, want migration: an imported node that claims to be "+
				"user-authored cannot be told apart from one a person wrote", index, node.Provenance.Source)
		}
		if node.Provenance.SourceID != "campaign_rev_42" {
			t.Errorf("node %d source id = %q", index, node.Provenance.SourceID)
		}
		if !strings.HasPrefix(string(node.ID), "legacy_") {
			t.Errorf("node %d id = %q, want the configured prefix", index, node.ID)
		}
	}
}

// An anchor never becomes an action node with an invented role.
func TestAnchorsImportAsLinksRatherThanInventedActions(t *testing.T) {
	result := ImportLegacyHTML(
		`<div><p><a href="https://example.test/buy">Buy now</a></p><p><a href="https://example.test/unsub">Unsubscribe</a></p></div>`,
		ImportOptions{})
	document, ok := result.Document()
	if !ok {
		t.Fatalf("refused: %+v %s", result.Unmapped, result.Diagnostics.Error())
	}
	for _, node := range document.Nodes {
		if node.Type == NodeAction {
			t.Fatalf("an anchor became an action node with role %q; HTML does not say which "+
				"link is the call to action and which is the unsubscribe", node.Role)
		}
	}
	if len(document.Nodes) != 2 {
		t.Fatalf("expected two paragraphs, got %+v", document.Nodes)
	}
}

// An unusable option is reported rather than silently replaced with a default.
func TestAnInvalidNodeIDPrefixIsReportedNotRepaired(t *testing.T) {
	result := ImportLegacyHTML(`<p>Body</p>`, ImportOptions{NodeIDPrefix: "bad prefix/"})
	if result.Complete() {
		t.Fatal("an invalid node id prefix was silently replaced")
	}
	if !result.Diagnostics.HasCode(CodeInvalidStableReference) {
		t.Fatalf("diagnostics = %s", result.Diagnostics.Error())
	}
}

func hasUnmappedReason(constructs []UnmappedConstruct, reason UnmappedReason) bool {
	for _, construct := range constructs {
		if construct.Reason == reason {
			return true
		}
	}
	return false
}

// nodeTreeContainsText looks for a string anywhere a projection could reach it.
func nodeTreeContainsText(nodes []Node, needle string) bool {
	for _, node := range nodes {
		resolved := resolvedNode{node: node, content: node.Content}
		if strings.Contains(renderTextNode(resolved), needle) {
			return true
		}
		var html strings.Builder
		renderHTMLNode(&html, resolved)
		if strings.Contains(html.String(), needle) {
			return true
		}
	}
	return false
}
