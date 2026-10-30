package kms

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// providerFiles are the four KMS backends. Adding one here costs a line;
// discovering later that it shipped without a configuration gate costs a
// tenant's key material.
var providerFiles = []string{"aws.go", "gcp.go", "vault.go", "tink.go"}

// TestEveryProviderGatesWrapAndUnwrap holds the property that makes a
// multi-backend KMS safe: no provider may attempt key work without first
// proving it is configured for the key it was handed.
//
// The four backends express the gate differently and all four are correct —
// aws.go checks ErrProviderUnconfigured inline, gcp.go and vault.go delegate to
// validate(keyRef), tink.go to lookup(keyRef). What matters is not which shape
// they use but that SOME gate runs on both paths, so this asserts the property
// rather than one implementation of it.
//
// The failure being prevented is quiet. An ungated provider does not refuse; it
// proceeds to an API call with missing credentials or an unknown key and
// surfaces whatever the backend says — a 403, a timeout, an "invalid key" —
// somewhere far from the misconfiguration, on a path that is handling a
// tenant's data-encryption key at the time.
func TestEveryProviderGatesWrapAndUnwrap(t *testing.T) {
	// Any of these, called before the key work, counts as a gate.
	gates := map[string]bool{
		"validate": true, "lookup": true, "ensureConfigured": true,
	}

	for _, file := range providerFiles {
		fset := token.NewFileSet()
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}

		seen := map[string]bool{}
		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			if fn.Name.Name != "WrapDEK" && fn.Name.Name != "UnwrapDEK" {
				continue
			}
			seen[fn.Name.Name] = true

			gated := false
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				switch node := n.(type) {
				case *ast.Ident:
					if node.Name == "ErrProviderUnconfigured" {
						gated = true
					}
				case *ast.CallExpr:
					if sel, ok := node.Fun.(*ast.SelectorExpr); ok && gates[sel.Sel.Name] {
						gated = true
					}
					if id, ok := node.Fun.(*ast.Ident); ok && gates[id.Name] {
						gated = true
					}
				}
				return true
			})
			if !gated {
				t.Errorf(
					"%s: %s performs key work without a configuration gate — an "+
						"unconfigured provider would reach the backend holding a "+
						"plaintext DEK", file, fn.Name.Name,
				)
			}
		}

		// Guard the guard: a provider whose methods were renamed or moved would
		// otherwise pass by having nothing to check.
		for _, method := range []string{"WrapDEK", "UnwrapDEK"} {
			if !seen[method] {
				t.Errorf("%s: no %s found; the scan is broken or the provider is incomplete", file, method)
			}
		}
	}
}

// TestNoProviderReturnsThePlaintextDEK is the catastrophic case stated
// directly: a "wrap" that returns its input is a no-op that looks like
// encryption. The wrapped blob is what gets persisted, so a passthrough writes
// a tenant's data-encryption key to the database in the clear, and every
// subsequent unwrap succeeds — nothing ever surfaces an error.
func TestNoProviderReturnsThePlaintextDEK(t *testing.T) {
	for _, file := range providerFiles {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		fset := token.NewFileSet()
		parsed, perr := parser.ParseFile(fset, file, src, 0)
		if perr != nil {
			t.Fatalf("parse %s: %v", file, perr)
		}

		for _, decl := range parsed.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Name.Name != "WrapDEK" {
				continue
			}
			// The plaintext parameter, whatever it is called here.
			var plainParam string
			for _, p := range fn.Type.Params.List {
				for _, n := range p.Names {
					if strings.Contains(strings.ToLower(n.Name), "plain") ||
						strings.ToLower(n.Name) == "dek" {
						plainParam = n.Name
					}
				}
			}
			if plainParam == "" {
				t.Errorf("%s: WrapDEK has no recognisable plaintext parameter", file)
				continue
			}

			ast.Inspect(fn.Body, func(n ast.Node) bool {
				ret, ok := n.(*ast.ReturnStmt)
				if !ok || len(ret.Results) == 0 {
					return true
				}
				if id, ok := ret.Results[0].(*ast.Ident); ok && id.Name == plainParam {
					pos := fset.Position(ret.Pos())
					t.Errorf(
						"%s:%d: WrapDEK returns %s unchanged — the plaintext DEK "+
							"would be persisted as if it were wrapped",
						file, pos.Line, plainParam,
					)
				}
				return true
			})
		}
	}
}

// TestProviderSetIsComplete stops the list above going stale. A fifth backend
// added without an entry here is a backend nobody checks.
func TestProviderSetIsComplete(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	known := map[string]bool{}
	for _, f := range providerFiles {
		known[f] = true
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, rerr := os.ReadFile(name)
		if rerr != nil {
			t.Fatalf("read %s: %v", name, rerr)
		}
		// A file that implements WrapDEK is a provider.
		if !strings.Contains(string(src), ") WrapDEK(") {
			continue
		}
		if !known[name] {
			t.Errorf("%s implements WrapDEK but is not in providerFiles; it is unchecked", name)
		}
	}
}
