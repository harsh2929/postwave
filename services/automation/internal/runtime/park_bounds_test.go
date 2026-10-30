package runtime

import (
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The parking bounds are a pair, and their comment makes an arithmetic claim
// about the pair: maxParkAttempts is described as "on the order of weeks — far
// longer than any approval TTL". That sentence is only true while
// attempts x capped-backoff stays large. Halve either one and it quietly stops
// being true, while both constants still read as deliberate.
//
// The "longer than any approval TTL" half cannot be checked here: no approval
// TTL constant exists in this service. So this pins the half that is local —
// that the give-up point really is on the order of weeks — and leaves the
// cross-service half stated rather than silently assumed.

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

// maxParkAttempts: The give-up point for a parked execution. Reaching it abandons a subscriber journey mid-flow, so it must stay unreachable under normal waiting.
func TestBoundMaxParkAttempts(t *testing.T) {
	if maxParkAttempts != 2000 {
		t.Fatalf("maxParkAttempts changed to %v; confirm the new ceiling is intended", maxParkAttempts)
	}
	if sites := consultSites(t, "maxParkAttempts"); sites < 1 {
		t.Errorf("maxParkAttempts is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// The invariant the value pin cannot express.
func TestParkGiveUpPointStaysOnTheOrderOfWeeks(t *testing.T) {
	// Worst case: every attempt has settled onto the capped backoff.
	giveUp := time.Duration(maxParkAttempts) * maxParkBackoff
	const floor = 14 * 24 * time.Hour
	if giveUp < floor {
		t.Errorf("parked executions now give up after %v, but the comment on maxParkAttempts promises weeks (>= %v); a paused flow would be abandoned while someone is still expected to approve it",
			giveUp, floor)
	}
	// And the backoff must still be capped, or "at the capped backoff" means
	// nothing and the product above is not a bound on anything.
	if maxParkBackoff <= 0 || maxParkBackoff > time.Hour {
		t.Errorf("maxParkBackoff = %v; the give-up arithmetic above assumes this is a small ceiling", maxParkBackoff)
	}
}
