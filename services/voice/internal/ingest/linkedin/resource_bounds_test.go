package linkedin

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Resource bounds decide how much untrusted input this package will hold at
// once. Each was enforced and unpinned: raising the constant to 999999999 left
// the package green, so a bound could be widened in review with no test
// noticing.

// consultSites counts the lines in this package that USE a constant, excluding
// its own declaration. A value assertion alone passes on a bound nobody reads;
// a usage assertion alone passes on a bound raised to infinity. Both together
// make a change deliberate.
func consultSites(t *testing.T, constant string) int {
	t.Helper()
	decl := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(constant) + `\s+(?:int64\s+|int\s+)?=`)
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

// maxLinkedInCSVBytes: Bounds a user-UPLOADED CSV read into memory.
func TestBoundMaxLinkedInCSVBytes(t *testing.T) {
	if maxLinkedInCSVBytes != 10<<20 {
		t.Fatalf("maxLinkedInCSVBytes changed to %d; confirm the new ceiling is intended", maxLinkedInCSVBytes)
	}
	if sites := consultSites(t, "maxLinkedInCSVBytes"); sites < 1 {
		t.Errorf("maxLinkedInCSVBytes is consulted at %d sites, want at least 1 — the bound may no longer be enforced", sites)
	}
}
