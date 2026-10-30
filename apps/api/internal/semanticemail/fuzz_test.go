// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"encoding/json"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func FuzzCompileV2EscapesUntrustedVisibleText(f *testing.F) {
	f.Add("Ordinary heading", "Ordinary action")
	f.Add(`</h1><script>alert(1)</script>`, `" onmouseover="alert(1)`)
	f.Add("Résumé 🚀 مرحبًا", "انضم الآن")
	f.Add("line\r\nbreak", "control\x00")

	f.Fuzz(func(t *testing.T, heading, actionLabel string) {
		document := goldenProjectionDocument()
		document.Nodes[0].Content.Heading.Text = text(heading)
		document.Nodes[2].Content.Action.Label = actionLabel
		result, diagnostics := CompileV2(document, CompileOptions{})
		if diagnostics.HasErrors() {
			return
		}
		root, err := html.Parse(strings.NewReader(result.HTML))
		if err != nil {
			t.Fatalf("successful compile emitted unparsable HTML: %v", err)
		}
		if scripts := countElements(root, "script"); scripts != 0 {
			t.Fatalf("visible text injected %d script elements: %s", scripts, result.HTML)
		}
		if result.Hashes.HTML != digestString(result.HTML) || result.Hashes.Text != digestString(result.Text) {
			t.Fatal("successful compile returned a stale projection hash")
		}
	})
}

func FuzzCompileV2JSONLDCannotTerminateScript(f *testing.F) {
	f.Add("Save twenty percent", "SAVE20")
	f.Add(`</script><script>alert(1)</script>`, `</script>`)
	f.Add("خصم خاص 🚀", "خصم٢٠")

	f.Fuzz(func(t *testing.T, description, code string) {
		document := validDocumentV2()
		document.Nodes[10].Content.Offer.Description = text(description)
		document.Nodes[10].Content.Offer.Code = code
		result, diagnostics := CompileV2(document, validCompileOptions())
		if diagnostics.HasErrors() {
			return
		}
		if !json.Valid(result.JSONLD) {
			t.Fatalf("successful compile emitted invalid JSON-LD: %s", result.JSONLD)
		}
		if strings.Contains(strings.ToLower(string(result.JSONLD)), "</script") {
			t.Fatalf("JSON-LD contains a literal script terminator: %s", result.JSONLD)
		}
		root, err := html.Parse(strings.NewReader(result.HTML))
		if err != nil {
			t.Fatalf("successful compile emitted unparsable HTML: %v", err)
		}
		if scripts := countElements(root, "script"); scripts != 1 {
			t.Fatalf("expected one compiler-owned JSON-LD script, got %d", scripts)
		}
	})
}

func FuzzNormalizeAndValidateV2NeverPanics(f *testing.F) {
	valid, err := json.Marshal(validDocumentV2())
	if err != nil {
		f.Fatal(err)
	}
	f.Add(valid)
	f.Add([]byte(`{"schema_version":2,"language":"en-US","direction":"ltr","nodes":[]}`))
	f.Add([]byte(`{"schema_version":2,"nodes":[{"content":{"heading":{"text":{"runs":[{"kind":"text","text":"x"}]}}}}]}`))
	f.Add([]byte{0xff, 0x00, '{', '}'})

	f.Fuzz(func(t *testing.T, raw []byte) {
		var document DocumentV2
		if err := json.Unmarshal(raw, &document); err != nil {
			return
		}
		normalized, diagnostics := NormalizeAndValidateV2(document)
		_ = normalized
		for _, diagnostic := range diagnostics {
			if diagnostic.Path == "" || diagnostic.Code == "" || diagnostic.Severity == "" {
				t.Fatalf("incomplete stable diagnostic: %#v", diagnostic)
			}
		}
	})
}

func countElements(node *html.Node, name string) int {
	if node == nil {
		return 0
	}
	count := 0
	if node.Type == html.ElementNode && node.Data == name {
		count++
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		count += countElements(child, name)
	}
	return count
}
