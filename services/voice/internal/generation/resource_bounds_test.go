package generation

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Resource bounds decide how much untrusted input this package holds at once.
// Each was enforced and unpinned: raising the constant to 999999999 left the
// package green, so a ceiling could be widened with nothing noticing.

// consultSites counts lines in this package that USE a constant, excluding its
// own declaration. A value assertion alone passes on a bound nobody reads; a
// usage assertion alone passes on a bound raised to infinity.
func consultSites(t *testing.T, constant string) int {
	t.Helper()
	decl := regexp.MustCompile(`^\s*(?:const\s+)?` + regexp.QuoteMeta(constant) + `\s+(?:int64\s+|int\s+|time\.Duration\s+)?=`)
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	total := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, line := range strings.Split(string(body), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || !strings.Contains(line, constant) {
				continue
			}
			if decl.MatchString(line) {
				continue
			}
			total++
		}
	}
	return total
}

// maxVoicePromptFileBytes: Caps a prompt file read from disk. The LimitReader and the comparison are two halves of one check — both must keep consulting it, or an oversized file is truncated silently instead of rejected.
func TestBoundMaxVoicePromptFileBytes(t *testing.T) {
	if maxVoicePromptFileBytes != 256<<10 {
		t.Fatalf("maxVoicePromptFileBytes changed to %v; confirm the new ceiling is intended", maxVoicePromptFileBytes)
	}
	if sites := consultSites(t, "maxVoicePromptFileBytes"); sites < 2 {
		t.Errorf("maxVoicePromptFileBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}
