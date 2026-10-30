package aidisclosure

import "strings"

import "testing"

// EU AI Act Article 50(2) (in force 2026-08-02) requires generative-AI output,
// including text, to be marked machine-readably as artificially generated.
func TestMarkHTML_EmbedsAMachineReadableMarkerInsideBody(t *testing.T) {
	in := `<html><head><title>Hi</title></head><body><p>Hello</p></body></html>`
	out := MarkHTML(in)

	if !IsMarkedHTML(out) {
		t.Fatal("marked HTML must carry the marker")
	}
	if !strings.Contains(out, "<!-- "+Marker+" -->") {
		t.Errorf("marker should be an HTML comment; got: %s", out)
	}
	// The visible content is untouched (a comment does not render).
	if !strings.Contains(out, "<p>Hello</p>") {
		t.Error("marking must not alter the visible body")
	}
	// Placed inside <body>.
	if strings.Index(out, Marker) < strings.Index(out, "<body") {
		t.Error("marker should sit inside <body>")
	}
}

func TestMarkHTML_IsIdempotent(t *testing.T) {
	once := MarkHTML(`<body>x</body>`)
	twice := MarkHTML(once)
	if once != twice {
		t.Fatal("marking already-marked HTML must not double-stamp")
	}
	if strings.Count(twice, Marker) != 1 {
		t.Fatalf("marker appears %d times, want 1", strings.Count(twice, Marker))
	}
}

func TestMarkHTML_MarksAFragmentWithNoBody(t *testing.T) {
	out := MarkHTML(`<p>fragment</p>`)
	if !IsMarkedHTML(out) {
		t.Fatal("even a body-less fragment must be marked")
	}
}

func TestMarkText_RecordsProvenanceWithoutMutatingText(t *testing.T) {
	subject, prov := MarkText("Your order shipped", "claude-sonnet-4-6")
	if subject != "Your order shipped" {
		t.Error("a subject line's visible text must not be mutated")
	}
	if !prov.Generated || prov.Marker != Marker || prov.Model != "claude-sonnet-4-6" {
		t.Fatalf("provenance not recorded: %+v", prov)
	}
}

func TestDisclosureAndHeaderAreStable(t *testing.T) {
	if DisclosureText == "" {
		t.Error("Article 50(1) needs a disclosure string for the agent UI")
	}
	if HeaderName == "" || Marker == "" {
		t.Error("marker + header constants must be set")
	}
}
