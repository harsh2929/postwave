// SPDX-License-Identifier: AGPL-3.0-only
package exports

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"testing"
)

// Every response that reports `status` must also report `state`.
//
// This is a structural test because the defect it guards is structural. The
// canonical lifecycle (internal/operation) was first wired into `List` alone —
// and `List` is the one endpoint a poller does not use. The package header
// points callers at `Get` to watch an export finish, so a client building on
// `state` saw it undefined on every poll and on create, while a review of the
// change saw the field present and called the consumer wired.
//
// Exercising the three handlers would need a database, a tenant, a session and
// three fixtures to assert one key's presence. Reading the response literals
// asserts the same property against the thing that was actually wrong, and it
// keeps working when a fourth endpoint is added — which is the real risk, since
// nothing about writing a new handler reminds anyone this pairing exists.
func TestEveryStatusResponseAlsoCarriesState(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "exports.go", nil, 0)
	if err != nil {
		t.Fatalf("parse exports.go: %v", err)
	}

	found := 0
	ast.Inspect(file, func(n ast.Node) bool {
		lit, ok := n.(*ast.CompositeLit)
		if !ok {
			return true
		}
		// Only map literals with string keys — the response bodies.
		if _, ok := lit.Type.(*ast.MapType); !ok {
			return true
		}
		keys := map[string]bool{}
		for _, elt := range lit.Elts {
			kv, ok := elt.(*ast.KeyValueExpr)
			if !ok {
				continue
			}
			bl, ok := kv.Key.(*ast.BasicLit)
			if !ok || bl.Kind != token.STRING {
				continue
			}
			if s, err := strconv.Unquote(bl.Value); err == nil {
				keys[s] = true
			}
		}
		if !keys["status"] {
			return true
		}
		found++
		if !keys["state"] {
			t.Errorf("%s: a response reports `status` without `state`. The raw "+
				"status is the published per-family contract and stays; `state` is "+
				"the canonical lifecycle position that makes a cross-family view "+
				"possible. A response carrying one and not the other is how that "+
				"view silently loses a row.", fset.Position(lit.Pos()))
		}
		return true
	})

	// Without this the test passes vacuously the moment the literals are
	// refactored into a struct or a helper — reporting green over a file it can
	// no longer see into.
	if found < 3 {
		t.Fatalf("found only %d status-reporting response literals in exports.go; "+
			"expected at least 3 (create, list, get). If the responses were "+
			"refactored, this test can no longer see them and must be rewritten "+
			"rather than left passing.", found)
	}
}
