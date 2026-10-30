package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

var transactionLocalSetConfigRE = regexp.MustCompile(`(?is)set_config\s*\([^)]*,\s*true\s*\)`)

// bareTransactionLocalSetConfigCalls finds set_config(..., true) calls issued
// directly on a connection returned by pgxpool.Acquire. Such a GUC exists only
// for the implicit transaction containing that one call and cannot scope a
// later query on the same connection.
func bareTransactionLocalSetConfigCalls(fset *token.FileSet, file *ast.File) []token.Position {
	var violations []token.Position
	ast.Inspect(file, func(n ast.Node) bool {
		var body *ast.BlockStmt
		switch n := n.(type) {
		case *ast.FuncDecl:
			body = n.Body
		case *ast.FuncLit:
			body = n.Body
		default:
			return true
		}
		if body == nil {
			return false
		}

		acquired := map[string]struct{}{}
		ast.Inspect(body, func(n ast.Node) bool {
			assign, ok := n.(*ast.AssignStmt)
			if !ok {
				return true
			}
			for i, rhs := range assign.Rhs {
				call, ok := rhs.(*ast.CallExpr)
				if !ok {
					continue
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Acquire" || i >= len(assign.Lhs) {
					continue
				}
				if id, ok := assign.Lhs[i].(*ast.Ident); ok && id.Name != "_" {
					acquired[id.Name] = struct{}{}
				}
			}
			return true
		})

		ast.Inspect(body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			receiver, ok := sel.X.(*ast.Ident)
			if !ok {
				return true
			}
			if _, ok := acquired[receiver.Name]; !ok {
				return true
			}
			for _, arg := range call.Args {
				lit, ok := arg.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				sql, err := strconv.Unquote(lit.Value)
				if err == nil && transactionLocalSetConfigRE.MatchString(sql) {
					violations = append(violations, fset.Position(call.Pos()))
					break
				}
			}
			return true
		})
		return false // nested function literals are analyzed independently
	})
	return violations
}

func TestBareTransactionLocalSetConfigAnalyzer(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		src  string
		want int
	}{
		{
			name: "raw acquired connection is rejected",
			src: `package p
func f(ctx C, pool P) {
  conn, err := pool.Acquire(ctx)
  _, _ = conn.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)")
  _, _ = conn.Exec(ctx, "DELETE FROM jobs")
  _ = err
}`,
			want: 1,
		},
		{
			name: "explicit transaction is accepted",
			src: `package p
func f(ctx C, pool P) {
  conn, err := pool.Acquire(ctx)
  tx, err := conn.Begin(ctx)
  _, _ = tx.Exec(ctx, "SELECT set_config('app.outbox_worker', 'true', true)")
  _, _ = tx.Exec(ctx, "DELETE FROM jobs")
  _, _ = conn, err
}`,
			want: 0,
		},
		{
			name: "shared transaction helper is accepted",
			src: `package p
func f(ctx C, pool P) {
  tx, err := db.WithWorkerScope(ctx, pool)
  _, _ = tx.Exec(ctx, "DELETE FROM jobs")
  _ = err
}`,
			want: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, "fixture.go", tc.src, 0)
			if err != nil {
				t.Fatalf("parse fixture: %v", err)
			}
			if got := len(bareTransactionLocalSetConfigCalls(fset, f)); got != tc.want {
				t.Fatalf("violations = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestNoBareTransactionLocalSetConfig(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve checker path")
	}
	repoRoot := filepath.Clean(filepath.Join(filepath.Dir(thisFile), "..", "..", "..", ".."))
	roots := []string{filepath.Join(repoRoot, "apps", "api"), filepath.Join(repoRoot, "services")}

	var violations []string
	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				if entry.Name() == "vendor" || entry.Name() == "node_modules" || strings.HasPrefix(entry.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, path, nil, 0)
			if err != nil {
				return err
			}
			for _, pos := range bareTransactionLocalSetConfigCalls(fset, f) {
				rel, err := filepath.Rel(repoRoot, pos.Filename)
				if err != nil {
					rel = pos.Filename
				}
				violations = append(violations, rel+":"+strconv.Itoa(pos.Line))
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan %s: %v", root, err)
		}
	}
	if len(violations) > 0 {
		t.Fatalf("transaction-local set_config issued on raw pooled connection; begin a transaction or use db.WithWorkerScope/db.WithTenant:\n%s", strings.Join(violations, "\n"))
	}
}
