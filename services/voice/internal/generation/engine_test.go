package generation

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// stubEvaluator returns a constant score regardless of input.
type stubEvaluator struct {
	Score_ float64
}

func (s *stubEvaluator) Score(_ context.Context, _ string, _ profile.VoiceProfile) (float64, FidelityBreakdown, error) {
	return s.Score_, FidelityBreakdown{Combined: s.Score_}, nil
}

// fakeLLM returns a canned generation response built dynamically based on
// the template length asked for via the user prompt.
type fakeLLM struct {
	emailCount int
}

func (f *fakeLLM) AnalyzeTonal(_ context.Context, _ []string) (profile.Tonal, profile.Persona, []string, error) {
	return profile.Tonal{}, profile.Persona{}, nil, nil
}

func (f *fakeLLM) Generate(_ context.Context, _, _, _ string) (json.RawMessage, error) {
	type em struct {
		Position     int    `json:"position"`
		DelaySeconds int    `json:"delay_seconds"`
		Subject      string `json:"subject"`
		Body         string `json:"body"`
	}
	out := struct {
		Emails []em `json:"emails"`
	}{}
	for i := 1; i <= f.emailCount; i++ {
		out.Emails = append(out.Emails, em{
			Position:     i,
			DelaySeconds: 0,
			Subject:      "Generated subject " + itoa(i),
			Body:         "Generated body for {{newsletter_name}} email " + itoa(i) + ".\n\nWith multiple sentences here. And another one. Thanks,\nMaya",
		})
	}
	b, _ := json.Marshal(out)
	return b, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

func TestEngine_Generate_EndToEnd(t *testing.T) {
	store, err := templates.SeededMemoryStore()
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := store.Get(context.Background(), "public-welcome-example")
	if err != nil {
		t.Fatal(err)
	}
	llm := &fakeLLM{emailCount: tmpl.Length}
	eval := &stubEvaluator{Score_: 75}
	eng := NewEngine(llm, store, eval)

	prof := profile.VoiceProfile{
		TenantID: "tenant-1",
		Stylistic: profile.Stylistic{
			AvgSentenceLength:  10,
			AvgParagraphLength: 3,
		},
	}
	req := GenerateRequest{
		TenantID:   "tenant-1",
		TemplateID: "public-welcome-example",
		Name:       "My welcome",
		Profile:    prof,
		Variables: map[string]string{
			"newsletter_name":   "The Margin",
			"audience":          "indie SaaS founders",
			"writer_first_name": "Maya",
			"best_of_url":       "https://example.com/x",
			"best_of_title":     "X",
		},
	}
	seq, err := eng.Generate(context.Background(), req)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if got, want := len(seq.Emails), tmpl.Length; got != want {
		t.Fatalf("emails count = %d, want %d", got, want)
	}
	if seq.LowFidelityFlag {
		t.Errorf("LowFidelityFlag should be false at score 75")
	}
	for i, em := range seq.Emails {
		if em.Position != i+1 {
			t.Errorf("email[%d] position=%d, want %d", i, em.Position, i+1)
		}
		if em.VoiceFidelityScore != 75 {
			t.Errorf("email[%d] score=%v, want 75", i, em.VoiceFidelityScore)
		}
		if em.FidelityBreakdown == nil || em.FidelityBreakdown.Combined != 75 {
			t.Errorf("email[%d] missing fidelity breakdown: %+v", i, em.FidelityBreakdown)
		}
		if em.Subject == "" || em.Body == "" {
			t.Errorf("email[%d] missing subject or body", i)
		}
		// Variable substitution happened — no leftover {{newsletter_name}}.
		if contains(em.Body, "{{newsletter_name}}") {
			t.Errorf("email[%d] body still has {{newsletter_name}} placeholder", i)
		}
		if !contains(em.Body, "The Margin") {
			t.Errorf("email[%d] body missing substituted newsletter_name", i)
		}
	}
}

func TestEngine_Generate_LowFidelityTriggersRetryAndFlag(t *testing.T) {
	store, err := templates.SeededMemoryStore()
	if err != nil {
		t.Fatal(err)
	}
	tmpl, err := store.Get(context.Background(), "public-welcome-example")
	if err != nil {
		t.Fatal(err)
	}
	llm := &fakeLLM{emailCount: tmpl.Length}
	// Score is always below the floor — triggers retry, retry stays low,
	// LowFidelityFlag should be set.
	eval := &stubEvaluator{Score_: 30}
	eng := NewEngine(llm, store, eval)

	req := GenerateRequest{
		TenantID:   "t",
		TemplateID: "public-welcome-example",
		Profile:    profile.VoiceProfile{},
		Variables: map[string]string{
			"newsletter_name":   "X",
			"audience":          "y",
			"writer_first_name": "z",
			"best_of_url":       "u",
			"best_of_title":     "t",
		},
	}
	seq, err := eng.Generate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if !seq.LowFidelityFlag {
		t.Fatal("expected LowFidelityFlag at score 30")
	}
	for _, em := range seq.Emails {
		if em.RegenerationCount == 0 {
			t.Errorf("email at position %d should have RegenerationCount > 0", em.Position)
		}
	}
}

func TestSubstituteVars_HandlesSpacedPlaceholders(t *testing.T) {
	got := substituteVars("hi {{name}} and {{ name }}", map[string]string{"name": "Maya"})
	if got != "hi Maya and Maya" {
		t.Fatalf("got %q", got)
	}
}

// contains is a small inline strings.Contains to avoid an import.
func contains(s, sub string) bool {
	if sub == "" {
		return true
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
