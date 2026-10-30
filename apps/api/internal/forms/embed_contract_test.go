package forms

import (
	"strings"
	"testing"
)

func TestBuildEmbedSnippetResponseCarriesCanonicalPublicLocation(t *testing.T) {
	payload, ok := buildEmbedSnippetResponse(
		"iframe",
		"https://api.example.test",
		"https://forms.example.test",
		"launch/test",
	)
	if !ok {
		t.Fatal("expected iframe flavor to be supported")
	}
	if payload.PublicHost != "https://forms.example.test" {
		t.Fatalf("public host = %q", payload.PublicHost)
	}
	if payload.PublicURL != "https://forms.example.test/forms/launch%2Ftest" {
		t.Fatalf("public URL = %q", payload.PublicURL)
	}
	if payload.Snippet == "" || payload.Language != "html" || payload.Instructions == "" {
		t.Fatalf("incomplete payload: %#v", payload)
	}
}

func TestBuildEmbedSnippetResponseRejectsUnknownFlavor(t *testing.T) {
	if _, ok := buildEmbedSnippetResponse(
		"unknown",
		"https://api.example.test",
		"https://forms.example.test",
		"launch",
	); ok {
		t.Fatal("expected unknown flavor to be rejected")
	}
}

func TestBuildEmbedSnippetResponseRejectsMissingPublicHost(t *testing.T) {
	if _, ok := buildEmbedSnippetResponse(
		"iframe",
		"https://api.example.test",
		"",
		"launch",
	); ok {
		t.Fatal("expected missing public host to be rejected")
	}
}

func TestCanonicalPublicFormURLRequiresConfiguredHost(t *testing.T) {
	if _, ok := canonicalPublicFormURL("", "launch"); ok {
		t.Fatal("expected missing host to fail closed")
	}
	got, ok := canonicalPublicFormURL(" https://forms.example.test/ ", "launch/test")
	if !ok {
		t.Fatal("expected configured host")
	}
	if got != "https://forms.example.test/forms/launch%2Ftest" {
		t.Fatalf("public form URL = %q", got)
	}
	for _, invalid := range []string{
		"//forms.example.test",
		"javascript:alert(1)",
		"https://user:pass@forms.example.test",
		"https://forms.example.test/prefix",
		"https://forms.example.test?next=evil.test",
	} {
		if _, ok := canonicalPublicFormURL(invalid, "launch"); ok {
			t.Errorf("expected invalid public host %q to fail closed", invalid)
		}
	}
}

func TestBuildEmbedSnippetResponseCanonicalizesConfiguredOrigin(t *testing.T) {
	payload, ok := buildEmbedSnippetResponse(
		"script",
		"https://api.example.test",
		" https://forms.example.test/ ",
		"launch",
	)
	if !ok {
		t.Fatal("expected canonical origin")
	}
	if payload.PublicHost != "https://forms.example.test" {
		t.Fatalf("public host = %q", payload.PublicHost)
	}
	if !strings.Contains(payload.Snippet, `src="https://forms.example.test/embed.js"`) {
		t.Fatalf("snippet uses non-canonical origin: %s", payload.Snippet)
	}
}
