// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// Legacy HTML -> semantic import (PRD Foundations 2.2).
//
// # Why this exists
//
// Every campaign authored before the semantic model shipped is legacy HTML.
// Every downstream check that reads the semantic tree — agent legibility,
// certified plain text, hidden-content defenses — is therefore structurally
// unable to see the existing library. An importer is the difference between a
// model that describes new work and a model that describes the product.
//
// # The one rule that shapes everything below
//
// A semantic tree is a CLAIM about what a message says. An importer that turns
// an unrepresentable construct into the nearest node that happens to validate
// produces a tree that claims to describe a message it does not describe, and
// every check downstream then reports confidently about the wrong thing. A
// silent flattening is worse than a refusal, because a refusal is visible.
//
// So this importer is an ALLOWLIST, not a best effort. Only the constructs
// enumerated here map. Everything else — including everything invented after
// this file was written — is recorded as an UnmappedConstruct, and an element
// that is unmapped is NOT descended into: its content does not leak into the
// tree in some other shape.
//
// # What happens to unmappable input (the documented contract)
//
//  1. ImportLegacyHTML ALWAYS returns a full report. Every construct that could
//     not be represented appears in ImportResult.Unmapped with a reason, the
//     element, and its position in the source document.
//  2. ImportResult.Document REFUSES to hand back a document when anything was
//     unmapped or when the assembled tree failed v2 validation. There is no way
//     to obtain a DocumentV2 from a lossy import. This is the fail-closed gate.
//  3. ImportResult.PartialNodes exists for a human review surface and is named
//     so that no caller can reach for it believing it describes the message.
//
// # The documented, deliberate normalizations
//
// These are the only places the importer decides a shape rather than refusing,
// and each is a decision about PRESENTATION, which the semantic tree excludes
// by construction:
//
//   - Inline content sitting directly inside a flow container (a bare run of
//     text in a <div> or a layout <td>) becomes one paragraph. A run of prose in
//     a flow context IS body prose; HTML's own content model says so.
//   - An element whose entire content is empty or whitespace produces no node.
//     Spacer paragraphs and empty cells are layout. A link is the exception: an
//     anchor with no text is refused rather than dropped, because dropping it
//     would discard a URL that is genuinely in the message.
//   - A whitespace-only inline run is merged as a single space into the run that
//     follows it. It cannot survive as its own run — the union rejects an empty
//     text run — and DROPPING it would silently join two words.
//   - Image width/height are kept only as a pair, because the union only accepts
//     them as a pair. A lone or non-integer dimension is discarded; dimensions
//     are presentation.
//   - <style>, <title>, <meta>, <link>, <base> and non-conditional comments are
//     dropped. CSS and document metadata are not body content. A <style> that
//     declares any rule capable of HIDING content is NOT dropped: the importer
//     cannot resolve a cascade, and a tree built from it would assert that
//     content is visible which the stylesheet hides.
//
// # Things this importer deliberately refuses to guess
//
//   - Action ROLE. The union distinguishes a primary call to action from an
//     unsubscribe link, and HTML does not. A button-styled anchor and a footer
//     link are the same element. Every anchor therefore imports as an inline
//     link inside its block — which is what an anchor IS — and never as an
//     action node with an invented role.
//   - Layout vs data tables. A table that has not declared itself presentational
//     may carry meaning in its grid, and the union has no table node. Descending
//     into a data table and emitting its cells in reading order would silently
//     destroy exactly that meaning, so the table is refused with a message that
//     tells the author the one attribute that makes it importable.
//   - Whether an image is decorative. alt="" says decorative and a non-empty alt
//     says informative; a MISSING alt says nothing at all, and picking either
//     answer invents an accessibility claim.

// MaxLegacyHTMLBytes bounds importer input. It is smaller than the semantic
// document limit because HTML is the denser representation of the two.
const MaxLegacyHTMLBytes = 4 << 20

const defaultImportNodeIDPrefix = "imported"

var importNodeIDPrefixPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)

// hidingDeclarationPattern matches the CSS declarations that can make content
// invisible without removing it. It is deliberately a small closed list: the
// importer is not a CSS engine, and its job here is only to decide "I cannot
// prove this is visible", which is a refusal rather than an analysis.
var hidingDeclarationPattern = regexp.MustCompile(`(?i)(display\s*:\s*none|visibility\s*:\s*(hidden|collapse)|opacity\s*:\s*0(\.0+)?([^0-9.]|$)|font-size\s*:\s*0(\.0+)?(px|pt|em|rem|%)?([^0-9.a-z%]|$)|line-height\s*:\s*0([^0-9.]|$)|max-height\s*:\s*0([^0-9.]|$)|mso-hide\s*:\s*all|color\s*:\s*transparent|text-indent\s*:\s*-)`)

// UnmappedReason is a closed, machine-readable vocabulary. Callers switch on
// this; Detail is prose for a human and must not be parsed.
type UnmappedReason string

const (
	// UnmappedUnsupportedElement is the default outcome for anything outside the
	// allowlist. It is the reason a construct invented tomorrow is refused today.
	UnmappedUnsupportedElement UnmappedReason = "unsupported_element"
	// UnmappedNestedStructure covers structure that exists in HTML and has no
	// shape in the closed union: a list inside a list item, emphasis inside
	// emphasis, an image inside a link.
	UnmappedNestedStructure UnmappedReason = "nested_structure"
	// UnmappedHiddenContent covers content whose visibility the importer cannot
	// establish. Importing it would claim a reader sees it.
	UnmappedHiddenContent UnmappedReason = "hidden_content"
	// UnmappedConditionalRendering covers markup that renders differently per
	// client. One tree cannot describe two messages.
	UnmappedConditionalRendering UnmappedReason = "conditional_rendering"
	// UnmappedAmbiguousImage is an image with no alt attribute at all.
	UnmappedAmbiguousImage UnmappedReason = "ambiguous_image"
	// UnmappedUnrepresentableURL covers references the union cannot carry:
	// relative, mailto:, cid:, data:, credentialed, or fragment-bearing.
	UnmappedUnrepresentableURL UnmappedReason = "unrepresentable_url"
	// UnmappedEmptyConstruct covers a construct that carries a reference but no
	// representable content, such as an anchor with a URL and no text.
	UnmappedEmptyConstruct UnmappedReason = "empty_construct"
	// UnmappedInputRejected covers input the importer would not parse at all.
	UnmappedInputRejected UnmappedReason = "input_rejected"
)

// UnmappedConstruct is one thing in the source HTML that has no representation
// in the closed v2 node union.
type UnmappedConstruct struct {
	Reason UnmappedReason `json:"reason"`
	// Element is the tag name, or "#text"/"#comment"/"#document" for non-elements.
	Element string `json:"element"`
	// Path locates the construct among its siblings, e.g.
	// "/html[0]/body[1]/div[0]/blockquote[1]". Indices count all child nodes so
	// the path is stable under a re-parse of the same input.
	Path string `json:"path"`
	// Detail is human prose. Clients must switch on Reason, never on this.
	Detail string `json:"detail"`
}

// ImportOptions carries the context legacy HTML does not contain.
//
// Language is an option rather than being read from the <html lang> attribute
// on purpose: a wrong lang attribute is extremely common in email templates,
// and a document language is a claim the migration owner should make explicitly
// rather than inherit from markup nobody checked.
type ImportOptions struct {
	// Language is a BCP 47 tag. Empty means "en".
	Language string
	// Direction defaults to DirectionAuto.
	Direction Direction
	// NodeIDPrefix seeds generated stable node ids. Empty means "imported".
	NodeIDPrefix string
	// SourceID records what was imported, e.g. a campaign revision id. It lands
	// in every node's provenance alongside SourceMigration.
	SourceID string
}

// ImportResult is the whole outcome of one import.
//
// The imported nodes are unexported deliberately. The only complete-import exit
// is Document, which refuses to return anything when the import was lossy; the
// only lossy exit is PartialNodes, whose name is the warning.
type ImportResult struct {
	// Unmapped is every construct that has no representation. A non-empty
	// Unmapped means the tree does not describe the message.
	Unmapped []UnmappedConstruct `json:"unmapped"`
	// Diagnostics is v2 validation of the assembled tree. An importer bug or an
	// input past a documented limit surfaces here rather than as a silent repair.
	Diagnostics Diagnostics `json:"diagnostics"`

	language  string
	direction Direction
	nodes     []Node
}

// Complete reports whether the imported tree fully describes the source.
func (r ImportResult) Complete() bool {
	return len(r.Unmapped) == 0 && !r.Diagnostics.HasErrors() && len(r.nodes) > 0
}

// Document returns the imported semantic document, and false when the import
// was not complete.
//
// This is the fail-closed gate. A caller cannot obtain a DocumentV2 from an
// import that dropped or could not represent part of the message, because a
// partial tree presented as a document is precisely the failure this importer
// exists to avoid.
func (r ImportResult) Document() (DocumentV2, bool) {
	if !r.Complete() {
		return DocumentV2{}, false
	}
	return NormalizeV2(DocumentV2{
		SchemaVersion: SchemaVersionV2,
		Language:      r.language,
		Direction:     r.direction,
		Nodes:         r.nodes,
	}), true
}

// PartialNodes returns what could be mapped, for a human review surface.
//
// It is NOT a description of the message whenever Unmapped is non-empty. Nothing
// downstream may treat it as a semantic source; that is what Document is for.
func (r ImportResult) PartialNodes() []Node {
	if len(r.nodes) == 0 {
		return nil
	}
	return NormalizeV2(DocumentV2{Nodes: r.nodes}).Nodes
}

// ImportLegacyHTML maps legacy campaign HTML onto the closed v2 node union.
//
// It never widens the union and never guesses. See the file header for the
// documented contract on unmappable input.
func ImportLegacyHTML(raw string, options ImportOptions) ImportResult {
	importer := legacyImporter{options: normalizeImportOptions(options)}

	if len(raw) > MaxLegacyHTMLBytes {
		importer.markUnmapped(UnmappedInputRejected, "#document", "/",
			fmt.Sprintf("legacy HTML exceeds %d bytes", MaxLegacyHTMLBytes))
		return importer.result()
	}
	if !utf8.ValidString(raw) {
		importer.markUnmapped(UnmappedInputRejected, "#document", "/",
			"legacy HTML is not valid UTF-8; its text cannot be represented without inventing a decoding")
		return importer.result()
	}
	if !importNodeIDPrefixPattern.MatchString(importer.options.NodeIDPrefix) {
		importer.diagnostics.error("/import/options/node_id_prefix", "", CodeInvalidStableReference,
			"node id prefix must be 1-64 ASCII letters, digits, dot, underscore, colon, or hyphen")
		return importer.result()
	}

	document, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		importer.markUnmapped(UnmappedInputRejected, "#document", "/",
			"legacy HTML could not be parsed: "+err.Error())
		return importer.result()
	}
	importer.walkFlow(document, "")
	return importer.result()
}

func normalizeImportOptions(options ImportOptions) ImportOptions {
	if strings.TrimSpace(options.Language) == "" {
		options.Language = "en"
	}
	if options.Direction == "" {
		options.Direction = DirectionAuto
	}
	if strings.TrimSpace(options.NodeIDPrefix) == "" {
		options.NodeIDPrefix = defaultImportNodeIDPrefix
	}
	options.Language = strings.TrimSpace(options.Language)
	options.NodeIDPrefix = strings.TrimSpace(options.NodeIDPrefix)
	options.SourceID = strings.TrimSpace(options.SourceID)
	return options
}

type legacyImporter struct {
	options     ImportOptions
	nodes       []Node
	unmapped    []UnmappedConstruct
	diagnostics Diagnostics
	sequence    int
}

func (im *legacyImporter) result() ImportResult {
	document := DocumentV2{
		SchemaVersion: SchemaVersionV2,
		Language:      im.options.Language,
		Direction:     im.options.Direction,
		Nodes:         im.nodes,
	}
	normalized, diagnostics := NormalizeAndValidateV2(document)
	return ImportResult{
		Unmapped:    im.unmapped,
		Diagnostics: append(append(Diagnostics{}, im.diagnostics...), diagnostics...),
		language:    im.options.Language,
		direction:   im.options.Direction,
		nodes:       normalized.Nodes,
	}
}

func (im *legacyImporter) markUnmapped(reason UnmappedReason, element, path, detail string) {
	im.unmapped = append(im.unmapped, UnmappedConstruct{
		Reason: reason, Element: element, Path: path, Detail: detail,
	})
}

func (im *legacyImporter) appendNode(nodeType NodeType, role NodeRole, content NodeContent) {
	im.sequence++
	im.nodes = append(im.nodes, Node{
		ID:         NodeID(im.options.NodeIDPrefix + "_" + strconv.Itoa(im.sequence)),
		Type:       nodeType,
		Role:       role,
		Version:    NodeVersionV2,
		Content:    content,
		Provenance: Provenance{Source: SourceMigration, SourceID: im.options.SourceID},
	})
}

// importFlowContainers are elements that group other blocks and carry no
// meaning of their own. They are descended into and contribute no node.
var importFlowContainers = map[string]struct{}{
	"html": {}, "body": {}, "div": {}, "center": {}, "main": {},
	"section": {}, "article": {}, "header": {}, "footer": {}, "figure": {},
	"tbody": {}, "thead": {}, "tfoot": {}, "tr": {}, "td": {},
}

// importInlineElements are phrasing-level elements the inline union can carry.
var importInlineElements = map[string]struct{}{
	"strong": {}, "b": {}, "em": {}, "i": {}, "a": {}, "br": {}, "span": {},
}

var importHeadingLevels = map[string]int{
	"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6,
}

// walkFlow imports the block children of one container.
//
// Consecutive phrasing children accumulate into one implicit paragraph. If ANY
// piece of that phrasing run cannot be represented, the whole implicit paragraph
// is discarded rather than emitted with a hole in it: a paragraph missing its
// middle clause is a confident description of a sentence nobody wrote.
func (im *legacyImporter) walkFlow(parent *html.Node, path string) {
	var pending []InlineRun
	poisoned := false

	flush := func() {
		runs, wasPoisoned := mergeInlineWhitespace(pending), poisoned
		pending, poisoned = nil, false
		if wasPoisoned || len(runs) == 0 {
			return
		}
		im.appendNode(NodeParagraph, RoleBody, NodeContent{
			Paragraph: &ParagraphContent{Text: RichText{Runs: runs}},
		})
	}

	index := -1
	for child := parent.FirstChild; child != nil; child = child.NextSibling {
		index++
		childPath := importChildPath(path, child, index)
		switch child.Type {
		case html.TextNode:
			pending = append(pending, InlineRun{Kind: InlineText, Text: child.Data})
		case html.CommentNode:
			if !im.importComment(child, childPath) {
				poisoned = true
			}
		case html.DoctypeNode:
			continue
		case html.ElementNode:
			name := elementName(child)
			if _, inline := importInlineElements[name]; inline {
				runs, ok := im.inlineRuns(child, childPath)
				if !ok {
					poisoned = true
					continue
				}
				pending = append(pending, runs...)
				continue
			}
			flush()
			im.importBlock(child, childPath)
		default:
			flush()
			im.markUnmapped(UnmappedUnsupportedElement, "#node", childPath,
				"unsupported document node type")
		}
	}
	flush()
}

func (im *legacyImporter) importBlock(node *html.Node, path string) {
	name := elementName(node)
	if detail, hidden := hiddenReason(node); hidden {
		im.markUnmapped(UnmappedHiddenContent, name, path, detail)
		return
	}

	if level, isHeading := importHeadingLevels[name]; isHeading {
		runs, ok := im.inlineRuns(node, path)
		if !ok {
			return
		}
		runs = mergeInlineWhitespace(runs)
		if len(runs) == 0 {
			return
		}
		im.appendNode(NodeHeading, RoleHeading, NodeContent{
			Heading: &HeadingContent{Level: level, Text: RichText{Runs: runs}},
		})
		return
	}

	switch name {
	case "p":
		im.importParagraph(node, path)
	case "ul", "ol":
		im.importList(node, path, name == "ol")
	case "hr":
		im.appendNode(NodeDivider, RoleDivider, NodeContent{Divider: &DividerContent{}})
	case "img":
		im.importImage(node, path)
	case "table":
		im.importTable(node, path)
	case "head":
		im.importHead(node, path)
	case "style":
		im.importStyle(node, path)
	case "script", "noscript", "template":
		im.markUnmapped(UnmappedUnsupportedElement, name, path,
			"active or deferred content changes what the message does and has no semantic node")
	default:
		if _, container := importFlowContainers[name]; container {
			im.walkFlow(node, path)
			return
		}
		im.markUnmapped(UnmappedUnsupportedElement, name, path,
			"element is outside the closed v2 node union; it is refused rather than approximated by a node that would misdescribe it")
	}
}

func (im *legacyImporter) importParagraph(node *html.Node, path string) {
	// A paragraph whose only content is one image is an image block. The union
	// puts images at block level and legacy HTML writes a standalone image this
	// way; recognising the shape is not the same as inventing one.
	if image, imageIndex := soleImageChild(node); image != nil {
		// The comments this shortcut skips STILL have to be judged.
		//
		// soleImageChild ignores comment nodes when deciding whether the
		// paragraph is image-only — correct, because a comment is not content.
		// But taking the shortcut used to mean importComment never ran on them,
		// so a CONDITIONAL comment wrapped around a sole image was silently
		// dropped instead of marking the document unmapped.
		//
		// That is the one outcome this importer must never produce. A refusal is
		// safe and a report is safe; a tree that quietly omits markup which
		// changes how the message renders claims to describe a message it does
		// not describe, and every F06/F07/F11 check downstream then reports
		// confidently about the wrong document.
		commentIndex := -1
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			commentIndex++
			if child.Type != html.CommentNode {
				continue
			}
			if !im.importComment(child, importChildPath(path, child, commentIndex)) {
				return
			}
		}
		im.importImage(image, importChildPath(path, image, imageIndex))
		return
	}
	runs, ok := im.inlineRuns(node, path)
	if !ok {
		return
	}
	runs = mergeInlineWhitespace(runs)
	if len(runs) == 0 {
		return
	}
	im.appendNode(NodeParagraph, RoleBody, NodeContent{
		Paragraph: &ParagraphContent{Text: RichText{Runs: runs}},
	})
}

func (im *legacyImporter) importList(node *html.Node, path string, ordered bool) {
	items := make([]RichText, 0, 8)
	index := -1
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		index++
		childPath := importChildPath(path, child, index)
		switch child.Type {
		case html.TextNode:
			if strings.TrimSpace(child.Data) == "" {
				continue
			}
			im.markUnmapped(UnmappedNestedStructure, "#text", childPath,
				"text directly inside a list has no list item to belong to")
			return
		case html.CommentNode:
			if !im.importComment(child, childPath) {
				return
			}
		case html.ElementNode:
			if elementName(child) != "li" {
				im.markUnmapped(UnmappedNestedStructure, elementName(child), childPath,
					"a list may contain only list items in the closed union")
				return
			}
			if detail, hidden := hiddenReason(child); hidden {
				im.markUnmapped(UnmappedHiddenContent, "li", childPath, detail)
				return
			}
			runs, ok := im.inlineRuns(child, childPath)
			if !ok {
				// The failure is already recorded. The whole list is abandoned:
				// a list missing one item is a different list.
				return
			}
			runs = mergeInlineWhitespace(runs)
			if len(runs) == 0 {
				continue
			}
			items = append(items, RichText{Runs: runs})
		default:
			im.markUnmapped(UnmappedUnsupportedElement, "#node", childPath,
				"unsupported node inside a list")
			return
		}
	}
	if len(items) == 0 {
		return
	}
	im.appendNode(NodeList, RoleBody, NodeContent{List: &ListContent{Ordered: ordered, Items: items}})
}

func (im *legacyImporter) importImage(node *html.Node, path string) {
	// The hidden-content guard lives HERE, at the leaf, not only at the callers.
	//
	// importBlock checks hiddenReason before dispatching and inlineRuns checks it
	// for inline content, but importParagraph's sole-image shortcut calls this
	// function DIRECTLY. The result was that `<div><img style="display:none">`
	// was correctly refused while `<p><img style="display:none">` — one tag
	// different — imported as a fully visible informative_image with nothing
	// reported unmapped.
	//
	// A display:none image inside a paragraph is a TRACKING PIXEL, and it is one
	// of the most common constructs in exactly the legacy library this importer
	// exists to read. A tree that presents one as visible content tells every
	// downstream check that the message shows a picture it does not show.
	//
	// Guarding the leaf rather than the third call site is the point: the two
	// callers that already check are unaffected (they return before reaching
	// here), and any future caller inherits the guard instead of having to
	// remember it.
	if detail, hidden := hiddenReason(node); hidden {
		im.markUnmapped(UnmappedHiddenContent, "img", path, detail)
		return
	}
	alt, hasAlt := attributeLookup(node, "alt")
	if !hasAlt {
		// The union forces a choice between informative and decorative, and a
		// missing alt attribute states neither. Picking one invents an
		// accessibility claim on the sender's behalf.
		im.markUnmapped(UnmappedAmbiguousImage, "img", path,
			`image has no alt attribute; alt="" means decorative and a non-empty alt means informative, and a missing alt says neither`)
		return
	}
	source := strings.TrimSpace(attributeValue(node, "src"))
	if !importableURL(source, true) {
		im.markUnmapped(UnmappedUnrepresentableURL, "img", path,
			"image source is not an absolute, credential-free, fragment-free HTTPS URL")
		return
	}

	role := RoleInformativeImage
	if strings.TrimSpace(alt) == "" {
		role = RoleDecorativeImage
		alt = ""
	}
	width, height := importDimension(node, "width"), importDimension(node, "height")
	if width == 0 || height == 0 {
		// The union accepts dimensions only as a pair. Dimensions are
		// presentation, so discarding a lone one loses nothing the tree claims.
		width, height = 0, 0
	}
	im.appendNode(NodeImage, role, NodeContent{
		Image: &ImageContent{URL: source, Alt: alt, Width: width, Height: height},
	})
}

func (im *legacyImporter) importTable(node *html.Node, path string) {
	role := strings.ToLower(strings.TrimSpace(attributeValue(node, "role")))
	if role == "presentation" || role == "none" {
		// The author has declared the grid to be layout. Layout is presentation,
		// which the semantic tree excludes, so the cells are imported in reading
		// order and the grid itself contributes nothing.
		im.walkFlow(node, path)
		return
	}
	im.markUnmapped(UnmappedUnsupportedElement, "table", path,
		`a table that has not declared itself presentational may carry meaning in its rows and columns, and the closed union has no table node; add role="presentation" if it is layout only`)
}

func (im *legacyImporter) importHead(node *html.Node, path string) {
	index := -1
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		index++
		childPath := importChildPath(path, child, index)
		switch child.Type {
		case html.TextNode:
			continue
		case html.CommentNode:
			im.importComment(child, childPath)
		case html.ElementNode:
			switch elementName(child) {
			case "title", "meta", "link", "base":
				// Document metadata. Subject and preview text are revision
				// metadata outside the body tree by design.
				continue
			case "style":
				im.importStyle(child, childPath)
			default:
				im.markUnmapped(UnmappedUnsupportedElement, elementName(child), childPath,
					"unsupported document head element")
			}
		}
	}
}

func (im *legacyImporter) importStyle(node *html.Node, path string) {
	if hidingDeclarationPattern.MatchString(elementRawText(node)) {
		im.markUnmapped(UnmappedHiddenContent, "style", path,
			"stylesheet declares a rule that can hide content; the importer cannot resolve a cascade, so a tree built from it would claim content is visible that the stylesheet hides")
		return
	}
	// Dropped: CSS is presentation, which the semantic tree excludes by design.
}

// importComment returns false when the comment makes the document
// unrepresentable.
func (im *legacyImporter) importComment(node *html.Node, path string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(node.Data))
	if strings.HasPrefix(trimmed, "[if") || strings.Contains(trimmed, "<![endif]") {
		im.markUnmapped(UnmappedConditionalRendering, "#comment", path,
			"a conditional comment makes the message render differently in different clients; one tree cannot describe both")
		return false
	}
	return true
}

// inlineRuns walks phrasing content.
//
// It returns ok=false when ANY part could not be represented, and the caller
// abandons the whole enclosing block. Partial phrasing is the most dangerous
// failure available here: it validates, it reads naturally, and it is wrong.
func (im *legacyImporter) inlineRuns(parent *html.Node, path string) ([]InlineRun, bool) {
	var runs []InlineRun
	ok := true
	index := -1
	for child := parent.FirstChild; child != nil; child = child.NextSibling {
		index++
		childPath := importChildPath(path, child, index)
		switch child.Type {
		case html.TextNode:
			runs = append(runs, InlineRun{Kind: InlineText, Text: child.Data})
		case html.CommentNode:
			if !im.importComment(child, childPath) {
				ok = false
			}
		case html.ElementNode:
			name := elementName(child)
			if detail, hidden := hiddenReason(child); hidden {
				im.markUnmapped(UnmappedHiddenContent, name, childPath, detail)
				ok = false
				continue
			}
			switch name {
			case "br":
				runs = append(runs, InlineRun{Kind: InlineLineBreak})
			case "span":
				nested, nestedOK := im.inlineRuns(child, childPath)
				if !nestedOK {
					ok = false
					continue
				}
				runs = append(runs, nested...)
			case "strong", "b", "em", "i":
				value, textOnly := elementTextOnly(child)
				if !textOnly {
					im.markUnmapped(UnmappedNestedStructure, name, childPath,
						"markup nested inside emphasis has no representation in the closed inline union")
					ok = false
					continue
				}
				if strings.TrimSpace(value) == "" {
					// Emphasis around nothing emphasises nothing. Keep the
					// whitespace so the word boundary survives.
					runs = append(runs, InlineRun{Kind: InlineText, Text: value})
					continue
				}
				kind := InlineStrong
				if name == "em" || name == "i" {
					kind = InlineEmphasis
				}
				runs = append(runs, InlineRun{Kind: kind, Text: value})
			case "a":
				run, linkOK := im.importLink(child, childPath)
				if !linkOK {
					ok = false
					continue
				}
				runs = append(runs, run)
			default:
				im.markUnmapped(UnmappedUnsupportedElement, name, childPath,
					"element is outside the closed v2 inline union; the enclosing block is refused rather than emitted with a hole in it")
				ok = false
			}
		default:
			im.markUnmapped(UnmappedUnsupportedElement, "#node", childPath,
				"unsupported node inside phrasing content")
			ok = false
		}
	}
	return runs, ok
}

func (im *legacyImporter) importLink(node *html.Node, path string) (InlineRun, bool) {
	href, hasHref := attributeLookup(node, "href")
	if !hasHref {
		im.markUnmapped(UnmappedUnsupportedElement, "a", path,
			"an anchor without href is a document target, not a link, and has no node")
		return InlineRun{}, false
	}
	href = strings.TrimSpace(href)
	if !importableURL(href, false) {
		im.markUnmapped(UnmappedUnrepresentableURL, "a", path,
			"link target is not an absolute, credential-free, fragment-free http(s) URL")
		return InlineRun{}, false
	}
	value, textOnly := elementTextOnly(node)
	if !textOnly {
		im.markUnmapped(UnmappedNestedStructure, "a", path,
			"a link wrapping markup other than text has no representation in the closed inline union")
		return InlineRun{}, false
	}
	if strings.TrimSpace(value) == "" {
		// Refused rather than dropped: dropping it would discard a URL that is
		// genuinely in the message.
		im.markUnmapped(UnmappedEmptyConstruct, "a", path,
			"a link with no text cannot be represented, and dropping it would discard a URL the message contains")
		return InlineRun{}, false
	}
	run := InlineRun{Kind: InlineLink, Text: value, URL: href}
	if label := strings.TrimSpace(attributeValue(node, "aria-label")); label != "" {
		run.AccessibleLabel = label
	}
	return run, true
}

// mergeInlineWhitespace makes a run sequence representable without losing word
// boundaries.
//
// The union rejects an empty or whitespace-only text run, so a whitespace-only
// run cannot survive on its own. Dropping it would join two words: "<em>a</em>
// <em>b</em>" would become "ab". So the boundary is folded into the run that
// FOLLOWS it, where a leading space is preserved by inline normalization and is
// invisible in both projections. Leading and trailing whitespace of the block
// carries nothing and is discarded.
func mergeInlineWhitespace(runs []InlineRun) []InlineRun {
	out := make([]InlineRun, 0, len(runs))
	pendingSpace := false
	for _, run := range runs {
		if run.Kind == InlineLineBreak {
			pendingSpace = false
			if len(out) == 0 {
				continue
			}
			out = append(out, run)
			continue
		}
		if strings.TrimSpace(run.Text) == "" {
			if len(out) > 0 && out[len(out)-1].Kind != InlineLineBreak {
				pendingSpace = true
			}
			continue
		}
		if pendingSpace {
			// One boundary, not two. The neighbouring runs keep their own leading
			// and trailing whitespace, so adding a space next to one that is
			// already there would widen the gap the source never had.
			previousEndsInSpace := len(out) > 0 && endsWithSpace(out[len(out)-1].Text)
			if !previousEndsInSpace && !startsWithSpace(run.Text) {
				run.Text = " " + run.Text
			}
			pendingSpace = false
		}
		out = append(out, run)
	}
	for len(out) > 0 && out[len(out)-1].Kind == InlineLineBreak {
		out = out[:len(out)-1]
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func endsWithSpace(value string) bool {
	runes := []rune(value)
	return len(runes) > 0 && unicode.IsSpace(runes[len(runes)-1])
}

func startsWithSpace(value string) bool {
	for _, character := range value {
		return unicode.IsSpace(character)
	}
	return false
}

// importableURL delegates to the same validator the union enforces, so the
// importer can never emit a URL that validation would then reject.
func importableURL(value string, requireHTTPS bool) bool {
	diagnostics := Diagnostics{}
	validateHTTPURL(&diagnostics, "/", "", value, requireHTTPS)
	return !diagnostics.HasErrors()
}

func hiddenReason(node *html.Node) (string, bool) {
	for _, attribute := range node.Attr {
		switch strings.ToLower(attribute.Key) {
		case "hidden":
			return `the element carries the "hidden" attribute, so it is not part of what a reader sees`, true
		case "aria-hidden":
			if strings.EqualFold(strings.TrimSpace(attribute.Val), "true") {
				return "the element is aria-hidden, so an assistive reader is told it is not content", true
			}
		case "style":
			if hidingDeclarationPattern.MatchString(attribute.Val) {
				return "the element's inline style can hide it, and importing it would claim a reader sees it", true
			}
		}
	}
	return "", false
}

func elementName(node *html.Node) string {
	return strings.ToLower(node.Data)
}

// elementTextOnly returns the concatenated text of an element and false when it
// contains anything other than text.
func elementTextOnly(node *html.Node) (string, bool) {
	var out strings.Builder
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type != html.TextNode {
			return "", false
		}
		out.WriteString(child.Data)
	}
	return out.String(), true
}

// elementRawText concatenates the text of an element and its descendants. It is
// used for <style>, whose content is CSS rather than markup.
func elementRawText(node *html.Node) string {
	var out strings.Builder
	var walk func(*html.Node)
	walk = func(current *html.Node) {
		if current.Type == html.TextNode {
			out.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return out.String()
}

func soleImageChild(node *html.Node) (*html.Node, int) {
	var image *html.Node
	imageIndex := -1
	index := -1
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		index++
		switch child.Type {
		case html.TextNode:
			if strings.TrimSpace(child.Data) != "" {
				return nil, -1
			}
		case html.ElementNode:
			if elementName(child) != "img" || image != nil {
				return nil, -1
			}
			image, imageIndex = child, index
		case html.CommentNode:
			continue
		default:
			return nil, -1
		}
	}
	return image, imageIndex
}

func attributeLookup(node *html.Node, key string) (string, bool) {
	for _, attribute := range node.Attr {
		if strings.EqualFold(attribute.Key, key) {
			return attribute.Val, true
		}
	}
	return "", false
}

func attributeValue(node *html.Node, key string) string {
	value, _ := attributeLookup(node, key)
	return value
}

func importDimension(node *html.Node, key string) int {
	raw := strings.TrimSpace(attributeValue(node, key))
	if raw == "" {
		return 0
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 || value > maxImageDimension {
		return 0
	}
	return value
}

func importChildPath(parentPath string, node *html.Node, index int) string {
	name := "#node"
	switch node.Type {
	case html.ElementNode:
		name = elementName(node)
	case html.TextNode:
		name = "#text"
	case html.CommentNode:
		name = "#comment"
	case html.DoctypeNode:
		name = "#doctype"
	case html.DocumentNode:
		name = "#document"
	}
	return fmt.Sprintf("%s/%s[%d]", parentPath, name, index)
}
