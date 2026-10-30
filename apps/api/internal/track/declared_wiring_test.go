// SPDX-License-Identifier: AGPL-3.0-only

package track

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Both collectors must CALL the declared check.
//
// Everything else about this subsystem is testable in isolation and none of it
// proves the feature runs: `Validate` is a pure function, `CheckDeclared` works
// against a database, and both stay green while nothing calls them. That is the
// exact shape this package's observed half was built to end — a correct
// derivation nothing invokes — and it would be a poor joke to reintroduce it in
// the half added to complete the contract.
//
// A source scan rather than two integration tests, deliberately: there are two
// boundaries and they live in different packages with different fixtures, and a
// check that only covered the cheaper one would leave the importer — where a
// shape is MOST likely to drift, because no client library settles the types
// first — unguarded while looking covered.
func TestBothCollectorsCallTheDeclaredCheck(t *testing.T) {
	t.Parallel()
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}

	boundaries := []struct {
		file string
		why  string
	}{
		{
			file: "apps/api/internal/track/repo.go",
			why:  "POST /api/v1/track — the API collector",
		},
		{
			file: "apps/api/internal/warehouse/imports.go",
			why: "the warehouse importer, where drift is most likely because no " +
				"client library settles the types before they arrive",
		},
	}

	for _, b := range boundaries {
		source, readErr := os.ReadFile(filepath.Join(repoRoot, b.file))
		if readErr != nil {
			t.Fatalf("read %s: %v", b.file, readErr)
		}
		// A file that shrank to nothing would pass a `Contains` check for the
		// wrong reason.
		if len(source) < 1000 {
			t.Fatalf("%s is %d bytes; the path is wrong and a pass here would mean nothing",
				b.file, len(source))
		}
		if !strings.Contains(string(source), "CheckDeclared(") {
			t.Errorf("%s does not call CheckDeclared: %s.\n\n"+
				"Events arriving on this boundary are never checked against their "+
				"declaration, so a tenant can declare a schema, watch an app break "+
				"it, and see a violation count of zero — which is worse than having "+
				"no registry, because it reads as confirmation.", b.file, b.why)
		}
	}
}
