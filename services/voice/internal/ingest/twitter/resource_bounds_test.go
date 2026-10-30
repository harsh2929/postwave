package twitter

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

// maxTwitterArchiveBytes: Bounds a user-UPLOADED Twitter archive read into memory. The uploader chooses the file; this chooses how much of it we agree to hold.
func TestBoundMaxTwitterArchiveBytes(t *testing.T) {
	if maxTwitterArchiveBytes != 25<<20 {
		t.Fatalf("maxTwitterArchiveBytes changed to %d; confirm the new ceiling is intended", maxTwitterArchiveBytes)
	}
	if sites := consultSites(t, "maxTwitterArchiveBytes"); sites < 1 {
		t.Errorf("maxTwitterArchiveBytes is consulted at %d sites, want at least 1 — the bound may no longer be enforced", sites)
	}
}

// maxTwitterAPIBytes: Bounds a third-party API response. A compromised or misbehaving upstream should not be able to size our allocation.
func TestBoundMaxTwitterAPIBytes(t *testing.T) {
	if maxTwitterAPIBytes != 1<<20 {
		t.Fatalf("maxTwitterAPIBytes changed to %d; confirm the new ceiling is intended", maxTwitterAPIBytes)
	}
	if sites := consultSites(t, "maxTwitterAPIBytes"); sites < 1 {
		t.Errorf("maxTwitterAPIBytes is consulted at %d sites, want at least 1 — the bound may no longer be enforced", sites)
	}
}

// maxAPILimit: Bounds how many items one ingest run requests. Raising it turns a single job into an unbounded pull against a rate-limited API.
func TestBoundMaxAPILimit(t *testing.T) {
	if maxAPILimit != 3200 {
		t.Fatalf("maxAPILimit changed to %d; confirm the new ceiling is intended", maxAPILimit)
	}
	if sites := consultSites(t, "maxAPILimit"); sites < 1 {
		t.Errorf("maxAPILimit is consulted at %d sites, want at least 1 — the bound may no longer be enforced", sites)
	}
}
