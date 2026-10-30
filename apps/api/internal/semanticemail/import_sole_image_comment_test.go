// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import "testing"

// A conditional comment wrapped around a sole image must REFUSE the document.
//
// The sole-image shortcut in importParagraph returns as soon as it recognises
// an image-only paragraph, and soleImageChild deliberately ignores comment
// nodes when deciding whether the paragraph qualifies. Together those two
// correct decisions produced an incorrect one: importComment never ran on the
// skipped comments, so a conditional comment inside a sole-image paragraph was
// SILENTLY DROPPED rather than marking the import lossy.
//
// This is the exact shape the whole importer exists to refuse. The control
// below — <div><!--[if mso]>...<![endif]--><img></div> — is the single most
// common conditional construct in real campaign HTML, so the bypass was on the
// path most likely to be taken.
func TestAConditionalCommentAroundASoleImageIsRefusedNotDropped(t *testing.T) {
	// <p>, NOT <div>. The bypass lives in importParagraph, and a <div> is walked
	// as a container whose comment children reach importComment by the ordinary
	// route — so a <div> fixture refuses for an unrelated reason and proves
	// nothing about this defect. The first version of this test made exactly
	// that mistake and passed against the unfixed importer.
	const lossy = `<p><!--[if mso]><table><tr><td><![endif]--><img src="https://example.test/a.png" alt="Spring sale"></p>`

	result := ImportLegacyHTML(lossy, ImportOptions{Language: "en", SourceID: "rev-1"})
	if _, ok := result.Document(); ok {
		t.Fatal("a document was returned for an import containing a conditional " +
			"comment; a lossy tree must never be handed back as if it described the message")
	}
	found := false
	for _, unmapped := range result.Unmapped {
		if unmapped.Reason == UnmappedConditionalRendering {
			found = true
		}
	}
	if !found {
		t.Fatalf("the conditional comment was not reported as unmapped: %+v", result.Unmapped)
	}

	// Guard the guard, in the direction that costs something. The SAME markup
	// without the conditional comment must still import cleanly, or this test
	// would pass against an importer that refused every sole-image paragraph.
	const clean = `<p><img src="https://example.test/a.png" alt="Spring sale"></p>`
	cleanResult := ImportLegacyHTML(clean, ImportOptions{Language: "en", SourceID: "rev-2"})
	if _, ok := cleanResult.Document(); !ok {
		t.Fatalf("a sole image with no conditional comment was refused: %+v",
			cleanResult.Unmapped)
	}
}

// A display:none image inside a <p> must be refused, exactly as it is inside a
// <div>.
//
// The sole-image shortcut in importParagraph calls importImage DIRECTLY, so it
// used to skip the hidden-content check that importBlock and inlineRuns both
// apply. `<div><img style="display:none">` was refused; `<p><img
// style="display:none">` — one tag different — imported as a fully visible
// informative_image with nothing reported.
//
// That image is a TRACKING PIXEL. A tree that presents one as visible content
// tells every downstream check the message shows a picture the recipient never
// sees, and this is among the most common constructs in the legacy library the
// importer exists to read.
func TestAHiddenImageIsRefusedInAParagraphJustAsInADiv(t *testing.T) {
	for _, tc := range []struct{ name, markup string }{
		{"div", `<div><img style="display:none" src="https://example.test/px.gif" alt="Tracking pixel"></div>`},
		{"paragraph", `<p><img style="display:none" src="https://example.test/px.gif" alt="Tracking pixel"></p>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := ImportLegacyHTML(tc.markup, ImportOptions{Language: "en", SourceID: "rev"})
			if _, ok := result.Document(); ok {
				t.Fatal("a hidden image imported as visible content")
			}
			found := false
			for _, unmapped := range result.Unmapped {
				if unmapped.Reason == UnmappedHiddenContent {
					found = true
				}
			}
			if !found {
				t.Fatalf("hidden image not reported as unmapped: %+v", result.Unmapped)
			}
		})
	}

	// Guard the guard: a VISIBLE image in the same shapes must still import, or
	// this test would pass against an importer that refused every image.
	for _, markup := range []string{
		`<div><img src="https://example.test/a.png" alt="Sale"></div>`,
		`<p><img src="https://example.test/a.png" alt="Sale"></p>`,
	} {
		if _, ok := ImportLegacyHTML(markup, ImportOptions{Language: "en", SourceID: "rev"}).Document(); !ok {
			t.Fatalf("a visible image was refused: %s", markup)
		}
	}
}

// EVERY hidden-content guard in the importer, not the two that had tests.
//
// hiddenReason is called at four places — importBlock, importList's li loop,
// importImage and inlineRuns. Probing each by short-circuiting it showed two
// were undefended: the list-item check and, more seriously, the INLINE one,
// where hidden text reaches both the semantic tree and the text projection.
//
// Hidden text is the worst of the four to get wrong. A hidden image is a
// tracking pixel presented as a picture; hidden inline text is words the
// recipient never saw presented as words they read — and the text projection is
// exactly what an AI summariser consumes, so the summary would describe content
// that was deliberately invisible in the rendered message.
func TestEveryHiddenContentGuardRefusesTheDocument(t *testing.T) {
	for _, tc := range []struct{ name, markup string }{
		{"block", `<div style="display:none"><p>Invisible block</p></div>`},
		{"list item", `<ul><li>Visible</li><li style="display:none">Invisible item</li></ul>`},
		{"image in a paragraph", `<p><img style="display:none" src="https://example.test/px.gif" alt="Pixel"></p>`},
		{"inline text", `<p>Visible <span style="display:none">invisible words</span> tail</p>`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := ImportLegacyHTML(tc.markup, ImportOptions{Language: "en", SourceID: "rev"})
			if _, ok := result.Document(); ok {
				t.Fatalf("hidden content imported as visible: %s", tc.markup)
			}
			found := false
			for _, unmapped := range result.Unmapped {
				if unmapped.Reason == UnmappedHiddenContent {
					found = true
				}
			}
			if !found {
				t.Fatalf("hidden content not reported as unmapped: %+v", result.Unmapped)
			}
		})
	}

	// Guard the guard: the same shapes WITHOUT the hidden part must import, or
	// every assertion above would pass against an importer that refused
	// everything.
	for _, clean := range []string{
		`<div><p>Visible block</p></div>`,
		`<ul><li>Visible</li><li>Also visible</li></ul>`,
		`<p><img src="https://example.test/a.png" alt="Sale"></p>`,
		`<p>Visible <span>words</span> tail</p>`,
	} {
		if _, ok := ImportLegacyHTML(clean, ImportOptions{Language: "en", SourceID: "rev"}).Document(); !ok {
			t.Fatalf("a visible document was refused: %s", clean)
		}
	}
}
