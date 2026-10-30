package generation

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/postwave/postwave/services/voice/internal/profile"
)

// Whole-sequence drafting from a free-text brief (desktop gap A26).
//
// Unlike Engine.Generate, drafting has no template skeleton: the model
// invents the arc (welcome → value → CTA → ...) from the brief alone.
// The output is NOT persisted — the handler returns the draft directly
// and the desktop feeds it into the sequence canvas, where the normal
// POST /sequences manual-draft path saves whatever the user keeps.

// DraftStepCountDefault is used when the caller omits step_count.
const DraftStepCountDefault = 5

// DraftStepCountMax bounds the per-request email count. One Gemini call
// produces the whole sequence; past ~10 emails the output quality (and
// the 4096-token output cap) degrade sharply.
const DraftStepCountMax = 10

// DraftRequest is the input to Engine.DraftFromBrief.
type DraftRequest struct {
	Brief     string `json:"brief"`
	StepCount int    `json:"step_count,omitempty"`
	Tone      string `json:"tone,omitempty"`
	// Profile is optional, handler-injected (never decoded from the
	// wire). When the tenant has a built voice profile the drafting
	// prompt includes its representative samples so the draft starts
	// in the writer's voice instead of generic marketing-speak.
	Profile profile.VoiceProfile `json:"-"`
}

// DraftStep is one email of a drafted sequence. delay_hours (not
// delay_seconds) is deliberate: the draft surface is a planning tool
// and hours are the unit the desktop's brief tab renders.
type DraftStep struct {
	Subject    string `json:"subject"`
	Body       string `json:"body"`
	DelayHours int    `json:"delay_hours"`
	Position   int    `json:"position"`
}

// SequenceDraft is the output of Engine.DraftFromBrief.
//
// Rationale is the model's own short explanation of the sequence arc —
// why it ordered the emails this way and what each one is for. It powers
// the agent-routine "trust" surface (an approver sees the reasoning
// behind an autonomously-drafted sequence). Always the model's genuine
// output; an empty value honestly means "no rationale given", never a
// fabricated one.
type SequenceDraft struct {
	Name      string      `json:"name"`
	Steps     []DraftStep `json:"steps"`
	Rationale string      `json:"rationale,omitempty"`
}

const draftSystemPrompt = `You are Moosewave's email-marketing sequence strategist. ` +
	`Given a campaign brief, design a complete drip sequence of marketing emails. ` +
	`Each email must have a clear single purpose within the arc (e.g. welcome, ` +
	`value/education, social proof, objection handling, call to action) and a ` +
	`subject line of at most 70 characters. Bodies are plain text, 80-200 words, ` +
	`with short paragraphs separated by blank lines and exactly one call to action. ` +
	`delay_hours is the wait AFTER the previous email (0 for the first email). ` +
	`Space later emails 24-96 hours apart unless the brief says otherwise. ` +
	`Never invent facts, prices, or URLs that the brief does not supply.`

const draftSchemaHint = `Respond with ONLY a JSON object with this exact shape (no prose, no markdown fences):
{
  "name": string,           // short internal label for the sequence
  "rationale": string,      // 1-3 sentences: the arc you chose and why each email exists
  "steps": [
    {
      "position": number,     // 1-based order within the sequence
      "delay_hours": number,  // hours after the previous email; 0 for the first
      "subject": string,      // inbox subject line, <= 70 chars
      "body": string          // plain-text email body
    }
  ]
}`

// DraftFromBrief runs one structured-JSON Gemini call and returns the
// parsed, validated draft. The engine only needs its LLM for this path —
// no template store or fidelity evaluator is involved, so callers
// constructed for tests with a bare LLM work too.
func (e *Engine) DraftFromBrief(ctx context.Context, req DraftRequest) (SequenceDraft, error) {
	if e == nil || e.LLM == nil {
		return SequenceDraft{}, fmt.Errorf("generation: draft: %w", profile.ErrLLMNotWired)
	}
	brief := strings.TrimSpace(req.Brief)
	if brief == "" {
		return SequenceDraft{}, fmt.Errorf("generation: draft: brief required")
	}
	stepCount := req.StepCount
	if stepCount <= 0 {
		stepCount = DraftStepCountDefault
	}
	if stepCount > DraftStepCountMax {
		stepCount = DraftStepCountMax
	}

	user := buildDraftUserPrompt(brief, stepCount, strings.TrimSpace(req.Tone), req.Profile)
	raw, err := e.LLM.Generate(ctx, draftSystemPrompt, user, draftSchemaHint)
	if err != nil {
		return SequenceDraft{}, fmt.Errorf("generation: draft: llm: %w", err)
	}
	draft, err := parseSequenceDraftJSON(raw, stepCount)
	if err != nil {
		return SequenceDraft{}, fmt.Errorf("generation: draft: %w", err)
	}
	if draft.Name == "" {
		draft.Name = fallbackDraftName(brief)
	}
	return draft, nil
}

// buildDraftUserPrompt assembles the user-message side of a draft call.
// Mirrors buildSequenceUserPrompt's sectioned-markdown layout.
func buildDraftUserPrompt(brief string, stepCount int, tone string, prof profile.VoiceProfile) string {
	var b strings.Builder
	b.WriteString("# Campaign brief\n\n")
	b.WriteString(brief)
	b.WriteString("\n\n# Requirements\n\n")
	fmt.Fprintf(&b, "- email count: exactly %d\n", stepCount)
	if tone != "" {
		fmt.Fprintf(&b, "- tone: %s\n", tone)
	} else {
		b.WriteString("- tone: infer from the brief; default to warm and direct\n")
	}
	if len(prof.RepresentativeSamples) > 0 {
		b.WriteString("\n# Writer's representative samples (match this voice)\n\n")
		b.WriteString(formatSamples(prof.RepresentativeSamples))
	}
	b.WriteString("\n# Task\n\nDraft the full sequence as a JSON object matching the schema in the system prompt. Output the JSON and nothing else.\n")
	return b.String()
}

// parseSequenceDraftJSON decodes the model output defensively:
//
//  1. direct unmarshal of the raw bytes (the Gemini client already
//     strips ```json fences);
//  2. fall back to the first balanced {...} block, which survives the
//     "Here's your sequence: {...} Let me know!" failure mode;
//  3. validate: drop steps with no subject AND no body, clamp negative
//     delays to 0, sort by the model's position then renumber densely
//     1..N, truncate when the model over-produced past stepCount.
//
// Returns an error when no usable steps remain — the handler maps that
// to a 502 so the client knows the model (not the request) failed.
func parseSequenceDraftJSON(raw json.RawMessage, stepCount int) (SequenceDraft, error) {
	var env struct {
		Name      string `json:"name"`
		Rationale string `json:"rationale"`
		Steps     []struct {
			Position   int    `json:"position"`
			DelayHours int    `json:"delay_hours"`
			Subject    string `json:"subject"`
			Body       string `json:"body"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		obj := firstJSONObject(string(raw))
		if obj == "" {
			return SequenceDraft{}, fmt.Errorf("decode draft: %w", err)
		}
		if err2 := json.Unmarshal([]byte(obj), &env); err2 != nil {
			return SequenceDraft{}, fmt.Errorf("decode draft: %w", err2)
		}
	}
	steps := make([]DraftStep, 0, len(env.Steps))
	for _, s := range env.Steps {
		subject := strings.TrimSpace(s.Subject)
		body := strings.TrimSpace(s.Body)
		if subject == "" && body == "" {
			continue
		}
		delay := s.DelayHours
		if delay < 0 {
			delay = 0
		}
		steps = append(steps, DraftStep{
			Subject:    subject,
			Body:       body,
			DelayHours: delay,
			Position:   s.Position,
		})
	}
	if len(steps) == 0 {
		return SequenceDraft{}, fmt.Errorf("decode draft: no usable steps returned")
	}
	sort.SliceStable(steps, func(i, j int) bool { return steps[i].Position < steps[j].Position })
	if stepCount > 0 && len(steps) > stepCount {
		steps = steps[:stepCount]
	}
	for i := range steps {
		steps[i].Position = i + 1
	}
	// The first email of a drafted sequence always sends immediately on
	// enrollment; a model-invented lead-in delay is a planning bug.
	steps[0].DelayHours = 0
	return SequenceDraft{
		Name:      strings.TrimSpace(env.Name),
		Rationale: strings.TrimSpace(env.Rationale),
		Steps:     steps,
	}, nil
}

// fallbackDraftName derives a short sequence label from the brief when
// the model omitted one: the first 8 words, capped at 60 runes.
func fallbackDraftName(brief string) string {
	words := strings.Fields(brief)
	if len(words) > 8 {
		words = words[:8]
	}
	name := strings.Join(words, " ")
	if r := []rune(name); len(r) > 60 {
		name = string(r[:60])
	}
	if name == "" {
		return "Drafted sequence"
	}
	return name
}

// firstJSONObject returns the first balanced { ... } substring, counting
// braces so nested objects and braces inside strings don't confuse the
// boundary. Mirrors the chat handler's extractor; duplicated here because
// handlers imports generation (the reverse import would cycle).
func firstJSONObject(s string) string {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && inString {
			escaped = true
			continue
		}
		if c == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		switch c {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}
