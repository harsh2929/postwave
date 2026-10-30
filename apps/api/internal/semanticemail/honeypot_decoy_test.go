// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"strings"
	"testing"
)

// Honeypot decoys are recipient-specific compiler input, on the same footing as
// PollOptionLinks: never part of the immutable semantic revision and never part
// of a stored assurance artifact. These tests pin the two properties that make
// that safe.

func TestHoneypotDecoysAreRenderedOutsideTheContentMain(t *testing.T) {
	document := goldenProjectionDocument()
	result, diagnostics := CompileV2(document, CompileOptions{
		HoneypotDecoys: []string{`<!-- https://track.example.test/api/public/engagement/hp/AAA.BBB -->`},
	})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	decoy := `<!-- https://track.example.test/api/public/engagement/hp/AAA.BBB -->`
	if !strings.Contains(result.HTML, decoy) {
		t.Fatalf("compiled HTML does not carry the decoy:\n%s", result.HTML)
	}
	// A decoy is not content. Placing it inside <main> would put it in the
	// document outline and in the reading order of anything that walks the
	// content tree.
	mainEnd := strings.Index(result.HTML, "</main>")
	if mainEnd < 0 {
		t.Fatal("compiled HTML has no closing main")
	}
	if strings.Index(result.HTML, decoy) < mainEnd {
		t.Error("the decoy was rendered inside <main>, where it is part of the content")
	}
	if !strings.Contains(result.HTML, decoy+"\n</body>") {
		t.Errorf("the decoy is not immediately before </body>:\n%s", result.HTML)
	}
}

func TestHoneypotDecoysNeverReachThePlainTextAlternative(t *testing.T) {
	// The load-bearing one. In text/plain nothing can be hidden: the decoy URL
	// would sit in the body where a human can read it and click it, and the
	// first curious recipient would be certified as a machine — the exact
	// inversion the whole design exists to avoid.
	result, diagnostics := CompileV2(goldenProjectionDocument(), CompileOptions{
		HoneypotDecoys: []string{`<!-- https://track.example.test/api/public/engagement/hp/AAA.BBB -->`},
	})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	for _, fragment := range []string{"engagement/hp", "AAA.BBB", "track.example.test"} {
		if strings.Contains(result.Text, fragment) {
			t.Errorf("plain-text alternative contains %q:\n%s", fragment, result.Text)
		}
	}
}

func TestNoDecoysLeavesTheProjectionByteIdentical(t *testing.T) {
	// Synthetic assurance projections compile with no decoys, and they are
	// hashed into the frozen artifact. If the decoy feature perturbed that
	// output at all — even by a newline — every stored artifact would stop
	// matching its own live compilation.
	document := goldenProjectionDocument()
	withoutField, diagnostics := CompileV2(document, CompileOptions{})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	withEmpty, diagnostics := CompileV2(document, CompileOptions{HoneypotDecoys: []string{}})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	if withoutField.HTML != withEmpty.HTML {
		t.Error("an empty decoy slice changed the HTML projection")
	}
	if withoutField.Hashes != withEmpty.Hashes {
		t.Error("an empty decoy slice changed the projection hashes")
	}
}

func TestABlankDecoyIsIgnored(t *testing.T) {
	// A minter that returns nothing must not punch a stray blank line into
	// every message of a send.
	document := goldenProjectionDocument()
	baseline, _ := CompileV2(document, CompileOptions{})
	result, diagnostics := CompileV2(document, CompileOptions{
		HoneypotDecoys: []string{"", "   ", "\n"},
	})
	if diagnostics.HasErrors() {
		t.Fatalf("CompileV2() diagnostics = %v", diagnostics)
	}
	if result.HTML != baseline.HTML {
		t.Errorf("blank decoys changed the projection:\n%s", result.HTML)
	}
}
