package seedlist

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Resource bounds are the values that decide how much untrusted input this
// service will hold in memory at once. Every one of them was enforced and
// unpinned: raising the constant to 999999999 left the package green, so a cap
// could be widened in review without a single test noticing.
//
// Each assertion pins the VALUE and re-checks that the constant is still
// CONSULTED. A bare value check would pass on a cap nobody reads any more, and
// a bare usage check would pass on a cap raised to infinity. Both together mean
// a change has to be deliberate.

func consultSites(t *testing.T, constant string) int {
	t.Helper()
	total := 0
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
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
			// The declaration itself is not a consult site. Matched
			// structurally: the earlier heuristic excluded lines containing
			// "<", which a "= 32 << 20" declaration satisfies, so declarations
			// were counted and every minimum was one too generous to fail.
			if declarationLine(constant).MatchString(line) {
				continue
			}
			total++
		}
	}
	return total
}

// maxSeedlistConfigBytes: Bounds an operator-supplied seedlist configuration document.
func TestBoundSeedlistconfigbytes(t *testing.T) {
	if maxSeedlistConfigBytes != 1<<20 {
		t.Fatalf("maxSeedlistConfigBytes changed to %d; confirm the new ceiling is intended", maxSeedlistConfigBytes)
	}
	if sites := consultSites(t, "maxSeedlistConfigBytes"); sites < 1 {
		t.Errorf("maxSeedlistConfigBytes is consulted at %d sites, want at least 1 — the bound may no longer be enforced", sites)
	}
}

// defaultMaxUIDsPerFolderPoll: Bounds how many IMAP UIDs one poll pulls. The server decides how many exist; this decides how many we agree to fetch at once.
func TestBoundMaxuidsperfolderpoll(t *testing.T) {
	if defaultMaxUIDsPerFolderPoll != 1000 {
		t.Fatalf("defaultMaxUIDsPerFolderPoll changed to %d; confirm the new ceiling is intended", defaultMaxUIDsPerFolderPoll)
	}
	if sites := consultSites(t, "defaultMaxUIDsPerFolderPoll"); sites < 1 {
		t.Errorf("defaultMaxUIDsPerFolderPoll is consulted at %d sites, want at least 1 — the bound may no longer be enforced", sites)
	}
}

// declarationLine matches "\tname [int64 ]= value" — the constant's own
// declaration, which is not a use of it.
func declarationLine(constant string) *regexp.Regexp {
	return regexp.MustCompile(`^\s*` + regexp.QuoteMeta(constant) + `\s+(?:int64\s+|int\s+)?=`)
}
