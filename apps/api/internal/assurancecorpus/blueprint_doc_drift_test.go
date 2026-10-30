// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The blueprint's tracker is a handoff surface. Its old 15-case statement
// survived after the corpus grew tenfold, so treat the number as generated
// evidence rather than prose somebody must remember to update.
func TestBlueprintCorpusCountMatchesEmbeddedManifest(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Clean("../../../../docs/moosewave-ai-inbox-campaign-assurance-implementation-blueprint-2026-08-09.md")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read blueprint: %v", err)
	}
	want := fmt.Sprintf("binds %d exact-CRLF", len(corpus.Cases))
	if !strings.Contains(string(body), want) {
		t.Fatalf("blueprint corpus status drifted: want %q for %d embedded cases", want, len(corpus.Cases))
	}
}
