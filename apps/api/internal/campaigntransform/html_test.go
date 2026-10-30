// SPDX-License-Identifier: AGPL-3.0-only

package campaigntransform

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestApplyHTMLProducesDeterministicReceipt(t *testing.T) {
	t.Parallel()
	body := `<html><body><a href="https://example.test/launch?existing=1">Launch</a><a href="mailto:help@example.test">Help</a></body></html>`
	tracking := json.RawMessage(`{"utm_medium":"email","google_analytics":true,"utm_source":"postwave"}`)
	first, err := ApplyHTML(body, `Preview <safe>`, tracking)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ApplyHTML(body, ` Preview <safe> `, json.RawMessage(`{"google_analytics":true,"utm_source":"postwave","utm_medium":"email"}`))
	if err != nil {
		t.Fatal(err)
	}
	if first.HTML != second.HTML || first.Receipt.OutputHTMLSHA256 != second.Receipt.OutputHTMLSHA256 {
		t.Fatal("equivalent transform inputs were not deterministic")
	}
	for _, fragment := range []string{
		`data-postwave-preheader`, `Preview &lt;safe&gt;`,
		`existing=1&amp;utm_medium=email&amp;utm_source=postwave`,
		`href="mailto:help@example.test"`,
	} {
		if !strings.Contains(first.HTML, fragment) {
			t.Errorf("transformed HTML missing %q: %s", fragment, first.HTML)
		}
	}
	if first.Receipt.Version != Version || !first.Receipt.PreviewInserted ||
		len(first.Receipt.PreviewTextHash) != 64 || len(first.Receipt.OutputHTMLSHA256) != 64 {
		t.Fatalf("receipt = %+v", first.Receipt)
	}
}

func TestApplyHTMLRejectsAmbiguousTrackingWhileLegacyFallsBack(t *testing.T) {
	t.Parallel()
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"google_analytics":"yes"}`),
		json.RawMessage(`{"google_analytics":true,"utm_source":42}`),
		json.RawMessage(`{broken`),
		json.RawMessage(`{} {}`),
		json.RawMessage(`{} trailing`),
		json.RawMessage(`null`),
	} {
		if _, err := ApplyHTML("<p>body</p>", "preview", raw); !errors.Is(err, ErrInvalidTrackingSettings) {
			t.Errorf("ApplyHTML(%s) error=%v", raw, err)
		}
		legacy := ApplyHTMLLegacy("<p>body</p>", "preview", raw)
		if !strings.Contains(legacy.HTML, "data-postwave-preheader") {
			t.Errorf("legacy fallback lost preview for %s", raw)
		}
	}
}

func TestAppendUTMParametersTouchesOnlyEligibleAnchors(t *testing.T) {
	t.Parallel()
	input := `<a href="https://example.test/a#section">A</a>` +
		`<a href="http://example.test/b">B</a>` +
		`<a href="/relative">R</a><a href="#local">F</a>` +
		`<a href="{{ unsubscribe_url }}">U</a>` +
		`<img src="https://example.test/image.png">`
	got := AppendUTMParameters(input, map[string]string{"utm_source": "x", "utm_campaign": "launch"})
	if strings.Count(got, "utm_source=x") != 2 || strings.Count(got, "utm_campaign=launch") != 2 {
		t.Fatalf("eligible link count changed: %s", got)
	}
	for _, untouched := range []string{`href="/relative"`, `href="#local"`, `href="{{ unsubscribe_url }}"`, `src="https://example.test/image.png"`} {
		if !strings.Contains(got, untouched) {
			t.Errorf("expected untouched %q in %s", untouched, got)
		}
	}
}

func TestInsertPreviewTextHandlesBodyCaseAndFragment(t *testing.T) {
	t.Parallel()
	withBody := InsertPreviewText(`<HTML><BODY class="mail"><p>x</p></BODY></HTML>`, "hello")
	if !strings.Contains(withBody, `<BODY class="mail"><div data-postwave-preheader`) {
		t.Fatalf("preheader not inserted after body: %s", withBody)
	}
	fragment := InsertPreviewText(`<p>x</p>`, "hello")
	if !strings.HasPrefix(fragment, `<div data-postwave-preheader`) {
		t.Fatalf("fragment preheader not prepended: %s", fragment)
	}
	if got := InsertPreviewText(`<p>x</p>`, "  "); got != `<p>x</p>` {
		t.Fatalf("blank preview changed body: %s", got)
	}
}
