package generation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/profile"
)

func draftEngine(llm profile.LLMClient) *Engine {
	// DraftFromBrief only needs the LLM; templates/fidelity stay nil to
	// prove the draft path doesn't accidentally depend on them.
	return &Engine{LLM: llm}
}

func TestDraftFromBrief_ParsesWellFormedResponse(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "Trial onboarding",
		"steps": [
			{"position": 1, "delay_hours": 0,  "subject": "Welcome aboard", "body": "Body one"},
			{"position": 2, "delay_hours": 48, "subject": "Getting value",  "body": "Body two"},
			{"position": 3, "delay_hours": 72, "subject": "Upgrade now",    "body": "Body three"}
		]
	}`)}
	draft, err := draftEngine(llm).DraftFromBrief(context.Background(), DraftRequest{
		Brief:     "Onboard new trial users of our analytics tool",
		StepCount: 3,
	})
	if err != nil {
		t.Fatalf("DraftFromBrief: %v", err)
	}
	if draft.Name != "Trial onboarding" {
		t.Errorf("name = %q, want Trial onboarding", draft.Name)
	}
	if len(draft.Steps) != 3 {
		t.Fatalf("steps = %d, want 3", len(draft.Steps))
	}
	for i, s := range draft.Steps {
		if s.Position != i+1 {
			t.Errorf("step[%d] position = %d, want %d", i, s.Position, i+1)
		}
	}
	if draft.Steps[1].DelayHours != 48 || draft.Steps[1].Subject != "Getting value" {
		t.Errorf("step[1] not preserved: %+v", draft.Steps[1])
	}
}

func TestDraftFromBrief_ToleratesProseWrappedJSON(t *testing.T) {
	// MockLLMClient doesn't strip fences/prose like GeminiClient does, so
	// this exercises the firstJSONObject fallback path directly.
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(
		"Here is your sequence:\n{\"name\":\"Launch\",\"steps\":[{\"position\":1,\"delay_hours\":0,\"subject\":\"Hi {\\\"quoted\\\"}\",\"body\":\"B\"}]}\nLet me know!",
	)}
	draft, err := draftEngine(llm).DraftFromBrief(context.Background(), DraftRequest{Brief: "launch"})
	if err != nil {
		t.Fatalf("DraftFromBrief: %v", err)
	}
	if draft.Name != "Launch" || len(draft.Steps) != 1 {
		t.Fatalf("unexpected draft: %+v", draft)
	}
}

func TestDraftFromBrief_NormalizesPositionsDelaysAndBlankSteps(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "  Messy  ",
		"steps": [
			{"position": 7, "delay_hours": -5, "subject": "Last",  "body": "L"},
			{"position": 2, "delay_hours": 24, "subject": "",      "body": ""},
			{"position": 1, "delay_hours": 12, "subject": "First", "body": "F"}
		]
	}`)}
	draft, err := draftEngine(llm).DraftFromBrief(context.Background(), DraftRequest{Brief: "messy output"})
	if err != nil {
		t.Fatalf("DraftFromBrief: %v", err)
	}
	if len(draft.Steps) != 2 {
		t.Fatalf("blank step should be dropped; steps = %d, want 2", len(draft.Steps))
	}
	// Sorted by model position (1 before 7), then renumbered 1..N.
	if draft.Steps[0].Subject != "First" || draft.Steps[0].Position != 1 {
		t.Errorf("step[0] = %+v, want First at position 1", draft.Steps[0])
	}
	if draft.Steps[1].Subject != "Last" || draft.Steps[1].Position != 2 {
		t.Errorf("step[1] = %+v, want Last at position 2", draft.Steps[1])
	}
	// First email always sends immediately; negative delay clamped (the
	// "Last" step's -5 became 0 and then it isn't first... it is second:
	// clamp applies regardless of slot).
	if draft.Steps[0].DelayHours != 0 {
		t.Errorf("step[0] delay = %d, want 0", draft.Steps[0].DelayHours)
	}
	if draft.Steps[1].DelayHours != 0 {
		t.Errorf("negative delay should clamp to 0, got %d", draft.Steps[1].DelayHours)
	}
}

func TestDraftFromBrief_TruncatesOverproducedSteps(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"name": "Over",
		"steps": [
			{"position": 1, "subject": "a", "body": "a"},
			{"position": 2, "subject": "b", "body": "b"},
			{"position": 3, "subject": "c", "body": "c"},
			{"position": 4, "subject": "d", "body": "d"}
		]
	}`)}
	draft, err := draftEngine(llm).DraftFromBrief(context.Background(), DraftRequest{Brief: "x", StepCount: 2})
	if err != nil {
		t.Fatalf("DraftFromBrief: %v", err)
	}
	if len(draft.Steps) != 2 {
		t.Fatalf("steps = %d, want 2 (truncated to step_count)", len(draft.Steps))
	}
}

func TestDraftFromBrief_FallsBackToBriefDerivedName(t *testing.T) {
	llm := &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{
		"steps": [{"position": 1, "subject": "s", "body": "b"}]
	}`)}
	draft, err := draftEngine(llm).DraftFromBrief(context.Background(), DraftRequest{
		Brief: "Re-engage lapsed customers of the spring collection with a three part winback offer",
	})
	if err != nil {
		t.Fatalf("DraftFromBrief: %v", err)
	}
	if draft.Name != "Re-engage lapsed customers of the spring collection with" {
		t.Errorf("fallback name = %q", draft.Name)
	}
}

func TestDraftFromBrief_ErrorPaths(t *testing.T) {
	cases := []struct {
		name    string
		llm     profile.LLMClient
		req     DraftRequest
		wantSub string
	}{
		{
			name:    "empty brief",
			llm:     &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{}`)},
			req:     DraftRequest{Brief: "   "},
			wantSub: "brief required",
		},
		{
			name:    "llm error propagates",
			llm:     &profile.MockLLMClient{Err: errors.New("boom")},
			req:     DraftRequest{Brief: "x"},
			wantSub: "llm: boom",
		},
		{
			name:    "non-JSON output",
			llm:     &profile.MockLLMClient{GenerateJSON: json.RawMessage(`total garbage, no braces`)},
			req:     DraftRequest{Brief: "x"},
			wantSub: "decode draft",
		},
		{
			name:    "no usable steps",
			llm:     &profile.MockLLMClient{GenerateJSON: json.RawMessage(`{"name":"n","steps":[{"position":1,"subject":"","body":""}]}`)},
			req:     DraftRequest{Brief: "x"},
			wantSub: "no usable steps",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := draftEngine(tc.llm).DraftFromBrief(context.Background(), tc.req)
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("err = %v, want substring %q", err, tc.wantSub)
			}
		})
	}
}

func TestDraftFromBrief_NilLLMReturnsErrLLMNotWired(t *testing.T) {
	_, err := (&Engine{}).DraftFromBrief(context.Background(), DraftRequest{Brief: "x"})
	if !errors.Is(err, profile.ErrLLMNotWired) {
		t.Fatalf("err = %v, want ErrLLMNotWired", err)
	}
}

func TestDraftFromBrief_PromptCarriesBriefToneCountAndSamples(t *testing.T) {
	var gotSystem, gotUser, gotSchema string
	llm := &profile.MockLLMClient{GenerateMock: func(_ context.Context, system, user, schemaHint string) (json.RawMessage, error) {
		gotSystem, gotUser, gotSchema = system, user, schemaHint
		return json.RawMessage(`{"name":"n","steps":[{"position":1,"subject":"s","body":"b"}]}`), nil
	}}
	prof := profile.VoiceProfile{RepresentativeSamples: []profile.Sample{{Text: "A very recognizable sample.", SourceType: "newsletter_archive", Weight: 1}}}
	_, err := draftEngine(llm).DraftFromBrief(context.Background(), DraftRequest{
		Brief:     "Promote the autumn webinar",
		StepCount: 99, // clamps to DraftStepCountMax
		Tone:      "playful",
		Profile:   prof,
	})
	if err != nil {
		t.Fatalf("DraftFromBrief: %v", err)
	}
	if !strings.Contains(gotUser, "Promote the autumn webinar") {
		t.Errorf("user prompt missing brief: %q", gotUser)
	}
	if !strings.Contains(gotUser, "tone: playful") {
		t.Errorf("user prompt missing tone: %q", gotUser)
	}
	if !strings.Contains(gotUser, "exactly 10") {
		t.Errorf("step count should clamp to %d: %q", DraftStepCountMax, gotUser)
	}
	if !strings.Contains(gotUser, "A very recognizable sample.") {
		t.Errorf("user prompt missing representative sample: %q", gotUser)
	}
	if !strings.Contains(gotSystem, "sequence strategist") {
		t.Errorf("unexpected system prompt: %q", gotSystem)
	}
	if !strings.Contains(gotSchema, `"delay_hours"`) {
		t.Errorf("schema hint missing delay_hours: %q", gotSchema)
	}
}
