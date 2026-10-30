// SPDX-License-Identifier: AGPL-3.0-only
//
// generator.go — a generation-backed Generator adapter. The replayer's
// Generator interface (Generate(ctx, surfaceKind, brief) -> output) is the
// seam that runs a stored brief through the explicitly versioned replay
// policy. It shares the production LLM transport, but its prompts remain a
// separate evaluation contract and must not be described as byte-equivalent
// to every authoring surface.
package regression

import (
	"context"
	"encoding/json"
	"strings"
)

// LLMGenerator is the minimal LLM surface the replay generator needs. Both
// the production GeminiClient and the test MockLLMClient implement it (it is
// a subset of handlers.ChatStreamer / profile.LLMClient). A nil client makes
// Generate return ErrLLMNotConfigured so the endpoint degrades honestly.
type LLMGenerator interface {
	Generate(ctx context.Context, system, user, schemaHint string) (json.RawMessage, error)
}

// ErrLLMNotConfigured is returned by LLMReplayGenerator.Generate when no LLM
// client is wired (e.g. GEMINI_API_KEY missing). The replayer records it as a
// severity="error" result rather than a fabricated score.
var ErrLLMNotConfigured = errInvalidConfig("regression: LLM client not configured")

type errInvalidConfig string

func (e errInvalidConfig) Error() string { return string(e) }

// LLMReplayGenerator implements Generator by calling an LLMGenerator with a
// per-surface system prompt.
type LLMReplayGenerator struct {
	LLM LLMGenerator
}

// NewLLMReplayGenerator constructs a Generator backed by the given LLM.
func NewLLMReplayGenerator(llm LLMGenerator) *LLMReplayGenerator {
	return &LLMReplayGenerator{LLM: llm}
}

// Generate implements Generator. It builds the surface-appropriate system
// prompt, asks the LLM for an output, and extracts the prose body so the
// fidelity evaluator scores prose (not a JSON envelope). campaign_draft asks
// for the structured JSON shape and pulls the "body" field out; the other
// surfaces are plain text.
func (g *LLMReplayGenerator) Generate(ctx context.Context, surfaceKind, brief string) (string, error) {
	if g == nil || g.LLM == nil {
		return "", ErrLLMNotConfigured
	}
	system, schema := systemPromptForSurface(surfaceKind)
	raw, err := g.LLM.Generate(ctx, system, brief, schema)
	if err != nil {
		return "", err
	}
	return extractOutput(surfaceKind, raw), nil
}

// systemPromptForSurface returns the (system, schemaHint) pair for a surface
// kind. Mirrors handlers.promptForKind for the surfaces the harness replays;
// unknown surfaces fall back to a generic on-brand drafting prompt.
func systemPromptForSurface(surfaceKind string) (system, schema string) {
	switch surfaceKind {
	case "campaign_draft":
		const sys = "You are Moosewave's email marketing assistant. The user wants " +
			"a campaign draft. Produce a concise, on-brand email with a clear " +
			"subject line, an attention-grabbing first line, and a single call " +
			"to action. Aim for 120–250 words of body copy. Use plain HTML — " +
			"wrap paragraphs in <p>. Do NOT include <html>, <head>, <body>."
		const sch = "Respond with ONLY a JSON object: " +
			"{\"name\": string, \"subject\": string, \"preview_text\": string, \"body\": string}"
		return sys, sch
	case "subject_line":
		const sys = "You are Moosewave's subject-line strategist. Given a brief, propose " +
			"a single strong subject line for a marketing inbox, ≤ 70 characters. " +
			"Respond with the subject line only, no numbering, no quotes."
		return sys, ""
	case "campaign_summary":
		const sys = "You are Moosewave's analyst. Summarise the supplied context into " +
			"3–5 concise bullet points. Lead with the headline finding."
		return sys, ""
	case "reply_intent":
		const sys = "You are Moosewave's reply-intent classifier. Given a reply, state " +
			"the intent and a one-line rationale in plain prose."
		return sys, ""
	default: // sequence_draft and any future surface
		const sys = "You are Moosewave's email marketing assistant. Produce a concise, " +
			"on-brand email body from the brief. Use plain HTML paragraphs."
		return sys, ""
	}
}

// extractOutput pulls the scorable prose from an LLM response. For
// campaign_draft we expect a JSON envelope and extract the "body" (falling
// back to the raw text when parsing fails). Other surfaces are plain text.
func extractOutput(surfaceKind string, raw json.RawMessage) string {
	text := strings.TrimSpace(string(raw))
	if surfaceKind != "campaign_draft" {
		return unquoteIfJSONString(text)
	}
	var env struct {
		Body    string `json:"body"`
		Subject string `json:"subject"`
	}
	cleaned := stripJSONFence(text)
	if err := json.Unmarshal([]byte(cleaned), &env); err == nil && strings.TrimSpace(env.Body) != "" {
		if s := strings.TrimSpace(env.Subject); s != "" {
			return s + "\n" + env.Body
		}
		return env.Body
	}
	return text
}

// unquoteIfJSONString unwraps a JSON string literal ("...") to its content;
// returns s unchanged when it isn't a quoted JSON string.
func unquoteIfJSONString(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var out string
		if err := json.Unmarshal([]byte(s), &out); err == nil {
			return out
		}
	}
	return s
}

// stripJSONFence removes a leading ```json / ``` fence and trailing ``` so a
// fenced response parses. Best-effort; mirrors the chat handler's loose
// fence stripper.
func stripJSONFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```")
		s = strings.TrimPrefix(s, "json")
		s = strings.TrimPrefix(s, "JSON")
		if i := strings.LastIndex(s, "```"); i >= 0 {
			s = s[:i]
		}
	}
	return strings.TrimSpace(s)
}
