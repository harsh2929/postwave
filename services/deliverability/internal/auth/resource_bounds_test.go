package auth

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Resource bounds decide how much untrusted input this package holds at once.
// Each was enforced and unpinned: raising the constant to 999999999 left the
// package green, so a ceiling could be widened with nothing noticing.
//
// The three DMARC bounds are not independent numbers, they are a CHAIN, and the
// chain is currently documented only in a comment: line 62 of dmarc_imap.go
// says the encoded cap carries "enough base64 headroom for a 10 MiB compressed
// part". Base64 inflates by 4/3, so that sentence is an arithmetic claim about
// two other constants. Raise the compressed cap to 12 MiB alone and the comment
// becomes false and legitimate 12 MiB reports fail at the base64 stage with an
// error naming the wrong limit. TestDMARCBoundsFormAConsistentChain turns that
// sentence into a check.

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

// maxRawDMARCMessageBytes: Caps one RFC822 message fetched from a third-party IMAP mailbox. Every byte below is carved out of this.
func TestBoundMaxRawDMARCMessageBytes(t *testing.T) {
	if maxRawDMARCMessageBytes != 25<<20 {
		t.Fatalf("maxRawDMARCMessageBytes changed to %d; confirm the new ceiling is intended", maxRawDMARCMessageBytes)
	}
	if sites := consultSites(t, "maxRawDMARCMessageBytes"); sites < 2 {
		t.Errorf("maxRawDMARCMessageBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxDMARCCompressedPartBytes: Caps a compressed attachment BEFORE decompression — the zip-bomb frontier.
func TestBoundMaxDMARCCompressedPartBytes(t *testing.T) {
	if maxDMARCCompressedPartBytes != 10<<20 {
		t.Fatalf("maxDMARCCompressedPartBytes changed to %d; confirm the new ceiling is intended", maxDMARCCompressedPartBytes)
	}
	if sites := consultSites(t, "maxDMARCCompressedPartBytes"); sites < 3 {
		t.Errorf("maxDMARCCompressedPartBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// maxDMARCEncodedPartBytes: Caps a base64-encoded part, sized to admit exactly the compressed cap once decoded.
func TestBoundMaxDMARCEncodedPartBytes(t *testing.T) {
	if maxDMARCEncodedPartBytes != 14<<20 {
		t.Fatalf("maxDMARCEncodedPartBytes changed to %d; confirm the new ceiling is intended", maxDMARCEncodedPartBytes)
	}
	if sites := consultSites(t, "maxDMARCEncodedPartBytes"); sites < 1 {
		t.Errorf("maxDMARCEncodedPartBytes is consulted at %d sites — the bound may no longer be enforced", sites)
	}
}

// The invariants the individual value pins cannot express.
func TestDMARCBoundsFormAConsistentChain(t *testing.T) {
	// Stated as inequalities, not equalities: the point is that these three may
	// be retuned, but only together.
	if maxDMARCCompressedPartBytes > maxRawDMARCMessageBytes {
		t.Errorf("compressed-part cap %d exceeds the whole-message cap %d, so it can never be the binding limit",
			maxDMARCCompressedPartBytes, maxRawDMARCMessageBytes)
	}
	// Base64 encodes 3 bytes as 4. A compressed part at the cap therefore needs
	// at least 4/3 of that budget once encoded, or it is rejected before anyone
	// gets to apply the cap that was meant to govern it.
	needed := maxDMARCCompressedPartBytes * 4 / 3
	if maxDMARCEncodedPartBytes < needed {
		t.Errorf("encoded cap %d cannot carry a %d-byte compressed part (needs >= %d); a legitimate report at the documented limit would be refused with the wrong error",
			maxDMARCEncodedPartBytes, maxDMARCCompressedPartBytes, needed)
	}
}
