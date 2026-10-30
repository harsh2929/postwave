package orchestrator

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Resource bounds decide how much untrusted input this package holds at once.
// Each was enforced and unpinned: raising the constant to 999999999 left the
// package green, so a bound could be widened with no test noticing.

// consultSites counts lines in this package that USE a constant, excluding its
// own declaration. A value assertion alone passes on a bound nobody reads; a
// usage assertion alone passes on a bound raised to infinity.
func consultSites(t *testing.T, constant string) int {
	t.Helper()
	decl := regexp.MustCompile(`^\s*(?:const\s+)?` + regexp.QuoteMeta(constant) + `\s+(?:int64\s+|int\s+)?=`)
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

// maxSubscriberTraversalPageCalls: The runaway-loop backstop for subscriber pagination. A source platform that never signals "done" would otherwise page forever.
func TestBoundMaxSubscriberTraversalPageCalls(t *testing.T) {
	if maxSubscriberTraversalPageCalls != 1_000_000 {
		t.Fatalf("maxSubscriberTraversalPageCalls changed to %d; confirm the new ceiling is intended", maxSubscriberTraversalPageCalls)
	}
	if sites := consultSites(t, "maxSubscriberTraversalPageCalls"); sites < 1 {
		t.Errorf("maxSubscriberTraversalPageCalls is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxArchiveTrackedIdentities: Bounds the in-memory identity set held during an archive import.
func TestBoundMaxArchiveTrackedIdentities(t *testing.T) {
	if maxArchiveTrackedIdentities != 1_000_000 {
		t.Fatalf("maxArchiveTrackedIdentities changed to %d; confirm the new ceiling is intended", maxArchiveTrackedIdentities)
	}
	if sites := consultSites(t, "maxArchiveTrackedIdentities"); sites < 1 {
		t.Errorf("maxArchiveTrackedIdentities is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxVerifierRetentionSweepRowsPerTenant: Bounds one retention sweep so a background job cannot become an unbounded statement against a tenant partition.
func TestBoundMaxVerifierRetentionSweepRowsPerTenant(t *testing.T) {
	if maxVerifierRetentionSweepRowsPerTenant != 10000 {
		t.Fatalf("maxVerifierRetentionSweepRowsPerTenant changed to %d; confirm the new ceiling is intended", maxVerifierRetentionSweepRowsPerTenant)
	}
	if sites := consultSites(t, "maxVerifierRetentionSweepRowsPerTenant"); sites < 1 {
		t.Errorf("maxVerifierRetentionSweepRowsPerTenant is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxArchiveTraversalPageCalls: The runaway-loop backstop for archive
// pagination. It was a bare 100000 inlined at two traversal sites with the
// number repeated in both error strings; naming it is only half the fix, since
// an unnamed bound and an unpinned one are equally free to drift.
func TestBoundMaxArchiveTraversalPageCalls(t *testing.T) {
	if maxArchiveTraversalPageCalls != 100000 {
		t.Fatalf("maxArchiveTraversalPageCalls changed to %d; confirm the new ceiling is intended", maxArchiveTraversalPageCalls)
	}
	// Both traversals must still consult it — extracting a constant that then
	// goes unread would look tidier and bound nothing.
	if sites := consultSites(t, "maxArchiveTraversalPageCalls"); sites < 4 {
		t.Errorf("maxArchiveTraversalPageCalls is consulted at %d sites, want >= 4 (2 comparisons + 2 error messages)", sites)
	}
}
