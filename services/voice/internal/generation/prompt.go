package generation

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/postwave/postwave/services/voice/internal/profile"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

//go:embed prompts/*.md
var embeddedPrompts embed.FS

const fallbackSequenceSystemPrompt = `You are a copy ghostwriter. Given a writer's voice profile and a sequence template, produce a sequence of emails in the writer's voice. Output JSON only matching the schema {emails: [{position, delay_seconds, subject, body}]}. Match the writer's sentence-length distribution and pronoun usage. Never copy phrasing from the samples verbatim.`

const fallbackRegenerateSystemPrompt = `Rewrite the given email in the writer's voice while preserving its purpose. Honor the optional user hint and style controls. Output JSON only: {position, delay_seconds, subject, body}.`

const maxVoicePromptFileBytes int64 = 256 << 10

var (
	promptCache struct {
		sync.RWMutex
		sequence   string
		regenerate string
		loaded     bool
	}
)

// loadPrompts reads the voice generation prompts from disk paths set via
// VOICE_PROMPTS_PATH, falling back to the embedded local prompt library.
// Result cached for the process lifetime.
func loadPrompts() (sequence, regenerate string) {
	promptCache.RLock()
	if promptCache.loaded {
		s, r := promptCache.sequence, promptCache.regenerate
		promptCache.RUnlock()
		return s, r
	}
	promptCache.RUnlock()

	promptCache.Lock()
	defer promptCache.Unlock()
	if promptCache.loaded {
		return promptCache.sequence, promptCache.regenerate
	}

	sequence = readEmbeddedPrompt("sequence_system.md", fallbackSequenceSystemPrompt)
	regenerate = readEmbeddedPrompt("regenerate_system.md", fallbackRegenerateSystemPrompt)
	dir := os.Getenv("VOICE_PROMPTS_PATH")
	if dir != "" {
		if b, err := readPromptFile(filepath.Join(dir, "sequence_system.md")); err == nil {
			sequence = string(b)
		}
		if b, err := readPromptFile(filepath.Join(dir, "regenerate_system.md")); err == nil {
			regenerate = string(b)
		}
	}

	promptCache.sequence = sequence
	promptCache.regenerate = regenerate
	promptCache.loaded = true
	return sequence, regenerate
}

// SequenceSystemPrompt returns the sequence-generation system prompt loaded
// from VOICE_PROMPTS_PATH or the embedded local default.
func SequenceSystemPrompt() string {
	s, _ := loadPrompts()
	return s
}

// RegenerateSystemPrompt returns the single-email regeneration prompt loaded
// from VOICE_PROMPTS_PATH or the embedded local default.
func RegenerateSystemPrompt() string {
	_, r := loadPrompts()
	return r
}

func readEmbeddedPrompt(name, fallback string) string {
	b, err := embeddedPrompts.ReadFile(filepath.ToSlash(filepath.Join("prompts", name)))
	if err != nil {
		return fallback
	}
	return string(b)
}

func readPromptFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	b, err := io.ReadAll(io.LimitReader(f, maxVoicePromptFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxVoicePromptFileBytes {
		return nil, fmt.Errorf("prompt file exceeds %d bytes", maxVoicePromptFileBytes)
	}
	return b, nil
}

// buildSequenceUserPrompt assembles the user-message side of a full-sequence
// generation call.
func buildSequenceUserPrompt(prof profile.VoiceProfile, tmpl templates.Template, vars map[string]string, controls StyleControls) (string, error) {
	profJSON, err := json.MarshalIndent(prof, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal profile: %w", err)
	}
	tmplJSON, err := json.MarshalIndent(struct {
		Slug      string                       `json:"slug"`
		Name      string                       `json:"name"`
		Length    int                          `json:"length"`
		Variables []templates.TemplateVariable `json:"variables"`
		Emails    []templates.TemplateEmail    `json:"emails"`
	}{
		Slug:      tmpl.Slug,
		Name:      tmpl.Name,
		Length:    tmpl.Length,
		Variables: tmpl.Variables,
		Emails:    tmpl.Emails,
	}, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal template: %w", err)
	}

	samples := formatSamples(prof.RepresentativeSamples)
	varsBlock := formatVariables(vars)
	controlsBlock := formatStyleControls(controls)

	var b strings.Builder
	b.WriteString("# Voice profile (JSON)\n\n```json\n")
	b.Write(profJSON)
	b.WriteString("\n```\n\n# Representative samples (3-8)\n\n")
	b.WriteString(samples)
	b.WriteString("\n# Template skeleton (JSON)\n\n```json\n")
	b.Write(tmplJSON)
	b.WriteString("\n```\n\n# Writer-supplied variables\n\n")
	b.WriteString(varsBlock)
	b.WriteString("\n# Style-control deltas\n\n")
	b.WriteString(controlsBlock)
	b.WriteString("\n# Task\n\nGenerate the full sequence as a JSON object matching the schema in the system prompt. Output the JSON and nothing else.\n")

	return b.String(), nil
}

// buildRegenerateUserPrompt assembles the user message for a single-email
// regeneration call.
func buildRegenerateUserPrompt(prof profile.VoiceProfile, seq Sequence, tmpl templates.Template, position int, vars map[string]string, controls StyleControls, hint string) (string, error) {
	profJSON, err := json.MarshalIndent(prof, "", "  ")
	if err != nil {
		return "", err
	}
	seqJSON, err := json.MarshalIndent(seq, "", "  ")
	if err != nil {
		return "", err
	}
	var skel templates.TemplateEmail
	for _, e := range tmpl.Emails {
		if e.Position == position {
			skel = e
			break
		}
	}
	skelJSON, err := json.MarshalIndent(skel, "", "  ")
	if err != nil {
		return "", err
	}
	samples := formatSamples(prof.RepresentativeSamples)
	varsBlock := formatVariables(vars)
	controlsBlock := formatStyleControls(controls)

	var b strings.Builder
	b.WriteString("# Voice profile (JSON)\n\n```json\n")
	b.Write(profJSON)
	b.WriteString("\n```\n\n# Representative samples\n\n")
	b.WriteString(samples)
	b.WriteString("\n# Existing sequence (JSON)\n\n```json\n")
	b.Write(seqJSON)
	b.WriteString("\n```\n\n# Email being regenerated\n\nposition: ")
	fmt.Fprintf(&b, "%d", position)
	b.WriteString("\n\n## Skeleton\n\n```json\n")
	b.Write(skelJSON)
	b.WriteString("\n```\n\n# Writer-supplied variables\n\n")
	b.WriteString(varsBlock)
	b.WriteString("\n# Style-control deltas\n\n")
	b.WriteString(controlsBlock)
	b.WriteString("\n# User hint\n\n")
	if hint == "" {
		b.WriteString("(none — apply a stronger voice-matching pass)\n")
	} else {
		b.WriteString(hint)
		b.WriteString("\n")
	}
	b.WriteString("\n# Task\n\nRegenerate the single email at the position above. Output a JSON object with shape `{\"email\": {position, delay_seconds, subject, body}}` and nothing else.\n")

	return b.String(), nil
}

func formatSamples(samples []profile.Sample) string {
	if len(samples) == 0 {
		return "(none — fall back to defaults; this will lower fidelity)\n\n"
	}
	var b strings.Builder
	for i, s := range samples {
		fmt.Fprintf(&b, "## Sample %d (source: %s, weight: %.2f)\n\n", i+1, s.SourceType, s.Weight)
		b.WriteString(s.Text)
		b.WriteString("\n\n")
	}
	return b.String()
}

func formatVariables(vars map[string]string) string {
	if len(vars) == 0 {
		return "(none supplied — write around any missing values)\n\n"
	}
	var b strings.Builder
	for k, v := range vars {
		fmt.Fprintf(&b, "- `%s` = %q\n", k, v)
	}
	b.WriteString("\n")
	return b.String()
}

func formatStyleControls(c StyleControls) string {
	var b strings.Builder
	fmt.Fprintf(&b, "- humor delta: %+0.2f\n", c.Humor)
	fmt.Fprintf(&b, "- directness delta: %+0.2f\n", c.Directness)
	fmt.Fprintf(&b, "- formality shift: %+0.2f\n", c.FormalityShift)
	length := c.Length
	if length == "" {
		length = "as-is"
	}
	fmt.Fprintf(&b, "- length: %s\n\n", length)
	return b.String()
}
