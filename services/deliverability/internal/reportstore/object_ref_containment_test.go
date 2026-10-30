package reportstore

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestObjectRefIsNeverEmitted enforces the containment rule this package states
// in prose and nothing checks:
//
//	"ObjectRef is service-internal and must never be emitted to logs, metrics,
//	 or customer responses."
//
// An ObjectRef is a durable locator for a stored seed observation — the raw
// captured message behind an Inbox Reality placement result. Leaking it into a
// log line or an API response hands out a direct pointer to another tenant's
// captured mail, and unlike a credential it never rotates.
//
// The package is careful today in a specific way worth preserving: the
// append-only deletion receipt records ObjectRefSHA256, a digest, and
// verifyDeletionRecord re-derives that digest from the ref so a receipt cannot
// be written against a mismatched one. The ref itself stays in the query, the
// delete call, and nowhere else.
//
// Two ways that regresses, both of which look like ordinary debugging:
//
//	slog.Info("deleting object", "ref", object.ObjectRef)
//	type SeedObservationObject struct { ObjectRef string `json:"object_ref"` }
//
// The first reaches the log pipeline. The second reaches any handler that ever
// marshals the struct — and nothing would fail until someone read a response.
func TestObjectRefIsNeverEmitted(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}

	// Calls that leave the process: structured logs, metrics labels, JSON
	// encoding, direct response writes.
	emitters := map[string]bool{
		"Info": true, "Warn": true, "Error": true, "Debug": true,
		"Printf": true, "Println": true, "Print": true,
		"Encode": true, "Marshal": true, "MarshalIndent": true,
		"WithLabelValues": true, "Write": true, "WriteString": true,
	}

	var scanned, refSites int
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, filepath.Join(".", name), nil, parser.ParseComments)
		if perr != nil {
			t.Fatalf("parse %s: %v", name, perr)
		}
		scanned++

		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.CallExpr:
				sel, ok := node.Fun.(*ast.SelectorExpr)
				if !ok || !emitters[sel.Sel.Name] {
					return true
				}
				for _, arg := range node.Args {
					if !mentionsRawObjectRef(arg) {
						continue
					}
					pos := fset.Position(node.Pos())
					t.Errorf(
						"%s:%d: %s() receives a raw ObjectRef — it must never reach "+
							"a log, metric, or response; pass digestString(...) instead",
						name, pos.Line, sel.Sel.Name,
					)
				}
			case *ast.Field:
				// A json tag on the field makes it serialisable everywhere.
				if node.Tag == nil {
					return true
				}
				for _, ident := range node.Names {
					if ident.Name != "ObjectRef" {
						continue
					}
					refSites++
					if strings.Contains(node.Tag.Value, "json:") &&
						!strings.Contains(node.Tag.Value, `json:"-"`) {
						pos := fset.Position(node.Pos())
						t.Errorf(
							"%s:%d: ObjectRef carries a json tag (%s) — any handler that "+
								"marshals this struct publishes the locator",
							name, pos.Line, node.Tag.Value,
						)
					}
				}
			}
			return true
		})
	}

	// Guard the guard: a walk that found no files, or a package where the
	// field vanished, would report perfect containment while checking nothing.
	if scanned < 3 {
		t.Fatalf("only scanned %d files; the walk is broken", scanned)
	}
	if !strings.Contains(readAll(t, "seed_retention.go"), "ObjectRef") {
		t.Fatal("ObjectRef no longer present; this guard is testing nothing")
	}
}

// mentionsRawObjectRef reports whether the expression is `x.ObjectRef` itself,
// as opposed to a digest of it. digestString(x.ObjectRef) is the sanctioned
// form and must keep passing, or the guard pushes callers away from the one
// safe way to reference an object in a receipt.
func mentionsRawObjectRef(expr ast.Expr) bool {
	switch e := expr.(type) {
	case *ast.SelectorExpr:
		return e.Sel.Name == "ObjectRef"
	case *ast.CallExpr:
		if id, ok := e.Fun.(*ast.Ident); ok && strings.HasPrefix(id.Name, "digest") {
			return false // hashed — this is the approved path
		}
		for _, a := range e.Args {
			if mentionsRawObjectRef(a) {
				return true
			}
		}
	case *ast.BinaryExpr:
		return mentionsRawObjectRef(e.X) || mentionsRawObjectRef(e.Y)
	}
	return false
}

// TestDeletionReceiptStoresOnlyADigest pins the shape that makes the receipt
// safe to keep forever: it records a hash of the locator, and the writer
// re-derives that hash so a receipt cannot claim a deletion it did not make.
func TestDeletionReceiptStoresOnlyADigest(t *testing.T) {
	src := readAll(t, "seed_retention.go")

	if !strings.Contains(src, "ObjectRefSHA256: digestString(") {
		t.Error("the deletion record no longer stores a digest of the ObjectRef")
	}
	if !strings.Contains(src, "record.ObjectRefSHA256 != digestString(object.ObjectRef)") {
		t.Error(
			"nothing re-derives the digest from the ref — a receipt could be " +
				"written against an object it does not describe",
		)
	}
	// The digest is what may be persisted; the ref is not.
	if strings.Contains(src, "ObjectRef:     candidate.ObjectRef,\n\t\t\t\tReceipt") {
		t.Error("the deletion record appears to persist the raw ObjectRef")
	}
}

func readAll(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(b)
}
