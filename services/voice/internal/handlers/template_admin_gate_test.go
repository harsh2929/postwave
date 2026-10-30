package handlers

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestTemplateMutatorsAreAdminGated pins the only thing standing between one
// tenant and every other tenant's sequence templates.
//
// voice_templates is deliberately platform-level and carries NO row-level
// security — migration 0010 says so outright: "Templates are platform-level
// (shared across tenants). No RLS — admin role gate at the API layer." The
// grant that follows hands postwave_app INSERT, UPDATE and DELETE on the whole
// table. So the API layer is not a second line of defence here, it is the only
// one, and it is currently held by an isTemplateAdmin call repeated by hand in
// three separate handlers.
//
// That convention is one new route away from lapsing. POST /templates/generate
// already looks like a fourth mutator and is not admin-gated — correctly, it
// generates a template and returns it without touching the shared library —
// which is exactly the sort of neighbour that makes "everything here is gated"
// stop being obviously true.
//
// The test parses the route table rather than issuing requests: what matters
// is that no mutating template route can be registered without the gate, and a
// request-level test would only cover the routes someone remembered to add.
func TestTemplateMutatorsAreAdminGated(t *testing.T) {
	fset := token.NewFileSet()
	dir := "."
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}

	// handlerName -> true when its body calls isTemplateAdmin.
	gated := map[string]bool{}
	// method + path -> handler name, for template routes only.
	routes := map[string]string{}

	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, perr := parser.ParseFile(fset, filepath.Join(dir, name), nil, 0)
		if perr != nil {
			t.Fatalf("parse %s: %v", name, perr)
		}

		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "isTemplateAdmin" {
					gated[fn.Name.Name] = true
				}
				// r.Post("/templates", h.createTemplate) and friends.
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || len(call.Args) != 2 {
					return true
				}
				method := sel.Sel.Name
				switch method {
				case "Post", "Put", "Patch", "Delete", "Get":
				default:
					return true
				}
				lit, ok := call.Args[0].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				path := strings.Trim(lit.Value, `"`)
				if !strings.HasPrefix(path, "/templates") {
					return true
				}
				handler, ok := call.Args[1].(*ast.SelectorExpr)
				if !ok {
					return true
				}
				routes[method+" "+path] = handler.Sel.Name
				return true
			})
		}
	}

	// Guard the guard: an AST walk that silently matched nothing would make
	// every assertion below vacuous, which reads exactly like a pass.
	if len(routes) < 4 {
		t.Fatalf("found only %d /templates routes (%v); the route scan is broken", len(routes), routes)
	}
	if len(gated) == 0 {
		t.Fatal("no handler calls isTemplateAdmin; the gate scan is broken")
	}

	// Routes that write to the shared library must be gated. GET is a read of
	// a deliberately shared library and needs no role.
	//
	// /templates/generate is the documented exception: it composes a template
	// from the caller's own brand voice, is metered against that tenant's AI
	// quota, and returns it in the response body without persisting. If it
	// ever starts writing, it belongs on the gated side and this list must
	// shrink, not grow.
	// Keyed by chi's Go method name as it appears in the AST ("Post"), not the
	// HTTP verb — the first version of this used "POST" and the exemption
	// silently never matched, reporting a correct handler as an ungated writer.
	const generateRoute = "Post /templates/generate"

	for route, handler := range routes {
		method := strings.SplitN(route, " ", 2)[0]
		if method == "Get" {
			continue
		}
		if route == generateRoute {
			if gated[handler] {
				continue // gating it is stricter than required; still fine.
			}
			continue
		}
		if !gated[handler] {
			t.Errorf(
				"%s is served by %s, which never calls isTemplateAdmin — "+
					"voice_templates has no RLS, so this writes across every tenant",
				route, handler,
			)
		}
	}
}

// TestGenerateTemplateDoesNotPersist keeps the one ungated mutating-looking
// route honest. It is exempt from the admin gate only because it returns the
// generated template instead of writing it to the shared library; the moment
// that changes, the exemption above becomes a cross-tenant write.
func TestGenerateTemplateDoesNotPersist(t *testing.T) {
	src, err := os.ReadFile("template_generate.go")
	if err != nil {
		t.Fatalf("read template_generate.go: %v", err)
	}
	body := string(src)

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "template_generate.go", src, 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	var found bool
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "generateTemplateFromBrief" {
			continue
		}
		found = true
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			// Delete belongs here as much as Create: removing a template from the
			// shared library from an ungated route harms every tenant. It was
			// missing from the first version of this list, and the mutation that
			// should have caught that passed clean.
			case "Create", "Save", "Upsert", "Update", "Insert", "Put", "Delete":
				t.Errorf(
					"generateTemplateFromBrief calls %s — it is not admin-gated, "+
						"so persisting here writes to the cross-tenant template library",
					sel.Sel.Name,
				)
			}
			return true
		})
	}
	if !found {
		t.Fatal("generateTemplateFromBrief not found")
	}

	// It must stay tenant-scoped and metered; both are what make an ungated
	// LLM call acceptable at all.
	if !strings.Contains(body, "h.TenantFromRequest(r)") {
		t.Error("generateTemplateFromBrief no longer resolves a tenant")
	}
	if !strings.Contains(body, "CheckAndConsume") {
		t.Error("generateTemplateFromBrief no longer consumes AI quota")
	}
}
