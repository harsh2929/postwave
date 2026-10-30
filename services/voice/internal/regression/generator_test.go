package regression

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// fakeLLM records the last call and returns a canned raw response.
type fakeLLM struct {
	raw        json.RawMessage
	err        error
	lastSystem string
	lastUser   string
	lastSchema string
}

func (f *fakeLLM) Generate(_ context.Context, system, user, schema string) (json.RawMessage, error) {
	f.lastSystem, f.lastUser, f.lastSchema = system, user, schema
	if f.err != nil {
		return nil, f.err
	}
	return f.raw, nil
}

func TestLLMReplayGenerator_NilClient(t *testing.T) {
	g := NewLLMReplayGenerator(nil)
	if _, err := g.Generate(context.Background(), "campaign_draft", "brief"); !errors.Is(err, ErrLLMNotConfigured) {
		t.Fatalf("err = %v, want ErrLLMNotConfigured", err)
	}
}

func TestLLMReplayGenerator_PropagatesError(t *testing.T) {
	g := NewLLMReplayGenerator(&fakeLLM{err: errors.New("boom")})
	if _, err := g.Generate(context.Background(), "subject_line", "brief"); err == nil {
		t.Fatal("expected error to propagate")
	}
}

func TestLLMReplayGenerator_CampaignDraftExtractsBody(t *testing.T) {
	llm := &fakeLLM{raw: json.RawMessage(`{"name":"n","subject":"Hello","body":"<p>Welcome back</p>"}`)}
	g := NewLLMReplayGenerator(llm)
	out, err := g.Generate(context.Background(), "campaign_draft", "re-engage")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	// Subject + body so the evaluator scores the whole drafted prose.
	if out != "Hello\n<p>Welcome back</p>" {
		t.Fatalf("out = %q", out)
	}
	// Brief is passed through as the user message; schema requested.
	if llm.lastUser != "re-engage" || llm.lastSchema == "" {
		t.Fatalf("user=%q schema=%q", llm.lastUser, llm.lastSchema)
	}
}

func TestLLMReplayGenerator_CampaignDraftFencedJSON(t *testing.T) {
	llm := &fakeLLM{raw: json.RawMessage("```json\n{\"subject\":\"\",\"body\":\"<p>Hi</p>\"}\n```")}
	g := NewLLMReplayGenerator(llm)
	out, err := g.Generate(context.Background(), "campaign_draft", "b")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if out != "<p>Hi</p>" {
		t.Fatalf("out = %q (fenced JSON should be parsed, body extracted)", out)
	}
}

func TestLLMReplayGenerator_SubjectLinePlainText(t *testing.T) {
	llm := &fakeLLM{raw: json.RawMessage(`"You won't believe this"`)}
	g := NewLLMReplayGenerator(llm)
	out, err := g.Generate(context.Background(), "subject_line", "b")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	// A JSON string literal is unwrapped to its content.
	if out != "You won't believe this" {
		t.Fatalf("out = %q", out)
	}
}
