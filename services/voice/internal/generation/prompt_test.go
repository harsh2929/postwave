package generation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmbeddedPromptsAreDefault(t *testing.T) {
	t.Setenv("VOICE_PROMPTS_PATH", "")
	promptCache.Lock()
	promptCache.loaded = false
	promptCache.sequence = ""
	promptCache.regenerate = ""
	promptCache.Unlock()

	sequence := SequenceSystemPrompt()
	regenerate := RegenerateSystemPrompt()
	if !strings.Contains(sequence, "Voice Sequence Stub Prompt") {
		t.Fatalf("default sequence prompt did not load embedded prompt")
	}
	if !strings.Contains(regenerate, "Voice Regeneration Stub Prompt") {
		t.Fatalf("default regenerate prompt did not load embedded prompt")
	}
	if sequence == fallbackSequenceSystemPrompt || regenerate == fallbackRegenerateSystemPrompt {
		t.Fatalf("loaded fallback prompt instead of embedded prompt")
	}
}

func TestReadPromptFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sequence_system.md")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create prompt: %v", err)
	}
	if err := f.Truncate(maxVoicePromptFileBytes + 1); err != nil {
		_ = f.Close()
		t.Fatalf("truncate prompt: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close prompt: %v", err)
	}

	_, err = readPromptFile(path)
	if err == nil || !strings.Contains(err.Error(), "prompt file exceeds") {
		t.Fatalf("expected oversized prompt error, got %v", err)
	}
}
