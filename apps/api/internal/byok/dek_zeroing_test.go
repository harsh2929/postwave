package byok

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPlainDEKIsAlwaysZeroed enforces the obligation packages/kms puts on us in
// prose and cannot enforce itself.
//
// The Provider contract says it twice:
//
//	WrapDEK  — "plainDEK is always 32 bytes (AES-256). Callers MUST zero
//	            plainDEK after a successful call."
//	UnwrapDEK — "The returned plaintext must be 32 bytes; callers MUST zero it
//	            after use."
//
// A 32-byte AES-256 data encryption key left in a live heap outlives the
// request: it can reach a core dump, a swap page, or a memory-scraping
// profiler, and it decrypts a tenant's stored credentials. Both call sites in
// cipher.go get this right today with `defer zero(dek)` placed immediately
// after acquisition, which is what makes it cover the error returns as well as
// the happy path.
//
// Nothing checks that. This is two lines of discipline guarding per-tenant
// secrets, in a file that will be edited again — a `return` added between the
// acquisition and the defer, or a new call site that forgets entirely, looks
// like ordinary code.
//
// The check is deliberately structural rather than behavioural: whether the
// bytes are wiped is a property of the deferred call existing on every path,
// which the compiler already guarantees once the defer is there. What can
// regress is the defer being absent, late, or attached to the wrong variable.
func TestPlainDEKIsAlwaysZeroed(t *testing.T) {
	const dekProducers = "GenerateDEK UnwrapDEK"

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}

	var checked int
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
		if perr != nil {
			t.Fatalf("parse %s: %v", name, perr)
		}

		ast.Inspect(file, func(n ast.Node) bool {
			fn, ok := n.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				return true
			}
			stmts := fn.Body.List
			for i, stmt := range stmts {
				assign, ok := stmt.(*ast.AssignStmt)
				if !ok || len(assign.Lhs) == 0 {
					continue
				}
				// Does this statement acquire plaintext key material?
				call := findCall(assign.Rhs)
				if call == nil {
					continue
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || !strings.Contains(dekProducers, sel.Sel.Name) {
					continue
				}
				target, ok := assign.Lhs[0].(*ast.Ident)
				if !ok {
					continue
				}
				checked++

				// The very next statement that is not the paired error check
				// must be `defer zero(<target>)`. Anything else means there is
				// a path — an early return, a wrapped error — on which the key
				// survives.
				if !zeroedRightAfter(stmts, i, target.Name) {
					pos := fset.Position(stmt.Pos())
					t.Errorf(
						"%s:%d: %s is assigned from %s but not immediately "+
							"followed by `defer zero(%s)` — plaintext key material "+
							"survives on some return path",
						name, pos.Line, target.Name, sel.Sel.Name, target.Name,
					)
				}
			}
			return true
		})
	}

	// Guard the guard: if the AST walk stops finding the call sites, this test
	// reports a perfectly zeroed package while checking nothing at all.
	if checked < 2 {
		t.Fatalf("found only %d DEK acquisition sites; the scan is broken", checked)
	}
}

func findCall(exprs []ast.Expr) *ast.CallExpr {
	for _, e := range exprs {
		if call, ok := e.(*ast.CallExpr); ok {
			return call
		}
	}
	return nil
}

// zeroedRightAfter reports whether `defer zero(name)` appears after index i,
// skipping only the immediately-following `if err != nil { … }` guard.
func zeroedRightAfter(stmts []ast.Stmt, i int, name string) bool {
	for j := i + 1; j < len(stmts) && j <= i+3; j++ {
		switch s := stmts[j].(type) {
		case *ast.IfStmt:
			// The paired error check is allowed to come between.
			continue
		case *ast.DeferStmt:
			call, ok := s.Call.Fun.(*ast.Ident)
			if !ok || call.Name != "zero" || len(s.Call.Args) != 1 {
				return false
			}
			arg, ok := s.Call.Args[0].(*ast.Ident)
			return ok && arg.Name == name
		default:
			return false
		}
	}
	return false
}

// TestZeroActuallyWipes keeps the helper honest. A `zero` that ranged over a
// copy, or returned early on an empty slice in a way that skipped the loop,
// would satisfy every structural check above while wiping nothing.
func TestZeroActuallyWipes(t *testing.T) {
	buf := []byte{1, 2, 3, 4, 5}
	zero(buf)
	for i, b := range buf {
		if b != 0 {
			t.Fatalf("byte %d not wiped: got %d", i, b)
		}
	}
	zero(nil)      // must not panic
	zero([]byte{}) // must not panic
}
