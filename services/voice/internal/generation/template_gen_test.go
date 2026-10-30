package generation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/profile"
)

func TestGenerateTemplateHappyPath(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "Monthly product update",
		"subject": "What's new in {{product_name}} this month",
		"body_html": "<h2>Hello {{first_name}}</h2><p>Here is the update.</p>",
		"body_mjml": "<mjml><mj-body><mj-text>Hello</mj-text></mj-body></mjml>"
	}`)}
	e := &Engine{LLM: llm}
	out, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{
		Brief: "Monthly update for our SaaS customers",
		Kind:  TemplateGenKindNewsletter,
	})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if out.Name != "Monthly product update" {
		t.Errorf("name = %q", out.Name)
	}
	if !strings.Contains(out.Subject, "{{product_name}}") {
		t.Errorf("subject = %q, want variable preserved", out.Subject)
	}
	if !strings.Contains(out.BodyHTML, "<h2>") {
		t.Errorf("body_html = %q", out.BodyHTML)
	}
	if !strings.Contains(out.BodyMJML, "<mjml>") {
		t.Errorf("body_mjml = %q, want MJML kept", out.BodyMJML)
	}
}

func TestGenerateTemplateProseWrappedJSON(t *testing.T) {
	// Model wraps the JSON in prose despite instructions — the parser
	// must extract the first balanced object.
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(
		`Here is your template! {"name":"Promo","subject":"48 hours only","body_html":"<p>Sale on now.</p>"} Hope it helps.`,
	)}
	e := &Engine{LLM: llm}
	out, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{Brief: "flash sale", Kind: TemplateGenKindPromo})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if out.Subject != "48 hours only" || !strings.Contains(out.BodyHTML, "Sale on now") {
		t.Fatalf("unexpected parse: %+v", out)
	}
	if out.BodyMJML != "" {
		t.Fatalf("body_mjml should be empty, got %q", out.BodyMJML)
	}
}

func TestGenerateTemplateDropsBogusMJML(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "x", "subject": "s", "body_html": "<p>b</p>",
		"body_mjml": "this is not mjml at all"
	}`)}
	e := &Engine{LLM: llm}
	out, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{Brief: "b"})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if out.BodyMJML != "" {
		t.Fatalf("non-MJML body_mjml should be dropped, got %q", out.BodyMJML)
	}
}

func TestGenerateTemplateFallbackName(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(
		`{"subject":"s","body_html":"<p>b</p>"}`,
	)}
	e := &Engine{LLM: llm}
	out, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{
		Brief: "Announce the new pricing page to existing customers",
	})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if out.Name == "" {
		t.Fatal("expected fallback name derived from brief")
	}
}

func TestGenerateTemplateRejectsUnusableOutput(t *testing.T) {
	for name, raw := range map[string]string{
		"missing subject":   `{"name":"x","body_html":"<p>b</p>"}`,
		"missing body_html": `{"name":"x","subject":"s"}`,
		"no json at all":    `sorry, I cannot help with that`,
		"empty fields":      `{"subject":"  ","body_html":" "}`,
	} {
		llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(raw)}
		e := &Engine{LLM: llm}
		if _, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{Brief: "b"}); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestGenerateTemplateValidation(t *testing.T) {
	e := &Engine{LLM: &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{}`)}}
	if _, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{Brief: "   "}); err == nil {
		t.Error("blank brief: expected error")
	}
	if _, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{Brief: "b", Kind: "sonnet"}); err == nil {
		t.Error("unknown kind: expected error")
	}
	var nilEngine *Engine
	if _, err := nilEngine.GenerateTemplate(context.Background(), TemplateGenRequest{Brief: "b"}); !errors.Is(err, profile.ErrLLMNotWired) {
		t.Errorf("nil engine: err = %v, want ErrLLMNotWired", err)
	}
}

func TestGenerateTemplatePromptIncludesProfileSamples(t *testing.T) {
	var seenUser string
	llm := &profile.MockLLMClient{GenerateMock: func(_ context.Context, _, user, _ string) (json.RawMessage, error) {
		seenUser = user
		return json.RawMessage(`{"name":"x","subject":"s","body_html":"<p>b</p>"}`), nil
	}}
	e := &Engine{LLM: llm}
	_, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{
		Brief: "b",
		Tone:  "playful",
		Profile: profile.VoiceProfile{
			RepresentativeSamples: []profile.Sample{{Text: "DISTINCTIVE-SAMPLE-TEXT"}},
		},
	})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if !strings.Contains(seenUser, "DISTINCTIVE-SAMPLE-TEXT") {
		t.Error("prompt missing representative sample")
	}
	if !strings.Contains(seenUser, "playful") {
		t.Error("prompt missing tone")
	}
}

func TestGenerateTemplatePromptUsesReferencesAsInspiration(t *testing.T) {
	var seenSystem, seenUser string
	llm := &profile.MockLLMClient{GenerateMock: func(_ context.Context, system, user, _ string) (json.RawMessage, error) {
		seenSystem, seenUser = system, user
		return json.RawMessage(`{"name":"Original","subject":"News","body_html":"<p>Fresh</p>"}`), nil
	}}
	e := &Engine{LLM: llm}
	_, err := e.GenerateTemplate(context.Background(), TemplateGenRequest{
		Brief: "Create our monthly digest",
		References: []TemplateGenReference{{
			Name: "Editorial grid", Brand: "Example", Style: "editorial", Layout: "multi-section",
			BodyHTML: `<table><tr><td>REFERENCE-STRUCTURE</td></tr></table>`,
		}},
	})
	if err != nil {
		t.Fatalf("GenerateTemplate: %v", err)
	}
	if !strings.Contains(seenUser, "REFERENCE-STRUCTURE") || !strings.Contains(seenUser, "editorial") {
		t.Fatalf("reference missing from prompt: %s", seenUser)
	}
	if !strings.Contains(seenSystem, "untrusted design data") || !strings.Contains(seenUser, "Do not reproduce") {
		t.Fatal("reference originality guardrails missing")
	}
}

func TestBoundedReferenceTextCapsUntrustedMetadata(t *testing.T) {
	got := boundedReferenceText(strings.Repeat("x", 400), 300)
	if len([]rune(got)) != 301 || !strings.HasSuffix(got, "…") {
		t.Fatalf("bounded text length/suffix = %d, %q", len([]rune(got)), got[len(got)-3:])
	}
}
