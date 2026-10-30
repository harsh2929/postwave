// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

// This source-level guard runs without Postgres. The package's integration
// tests exercise the database trigger when DATABASE_URL is available; this
// test keeps the HTTP deletion path from regressing to a broad DELETE in the
// lightweight/default test matrix.
func TestDeletePreservesDecidedHoldoutEvidence(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	sourceBytes, err := os.ReadFile(strings.TrimSuffix(filename, "delete_invariant_test.go") + "holdout.go")
	if err != nil {
		t.Fatalf("read holdout.go: %v", err)
	}
	source := string(sourceBytes)
	start := strings.Index(source, "func (d *Deps) Delete(")
	if start < 0 {
		t.Fatal("could not find Delete handler")
	}
	end := strings.Index(source[start:], "// Lift GET")
	if end < 0 {
		t.Fatal("could not isolate Delete handler")
	}
	block := source[start : start+end]
	for _, required := range []string{
		"SELECT decided_at",
		"FOR UPDATE",
		"if decidedAt != nil",
		`http.StatusConflict, "holdout_already_decided"`,
		"AND decided_at IS NULL",
	} {
		if !strings.Contains(block, required) {
			t.Fatalf("Delete handler is missing frozen-evidence guard %q", required)
		}
	}
	if strings.Contains(block, "DELETE FROM campaign_holdouts WHERE campaign_id") {
		t.Fatal("Delete handler regressed to an unguarded broad holdout delete")
	}
}
