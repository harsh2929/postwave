// SPDX-License-Identifier: AGPL-3.0-only
package integration_egress

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

var guardedIntegrationPackages = []string{
	"commerce",
	"review_integrations",
	"support_integrations",
	"subscription_integrations",
	"loyalty_integrations",
	"analytics_integrations",
	"crm_integrations",
	"marketing_integrations",
	"lead_integrations",
	// Added after TestEveryIntegrationPackageIsGuarded found it absent while
	// seven of its provider adapters built bare clients and dialled
	// tenant-supplied hosts. They now route through integration_writeback's
	// egressClient, so the guard below holds for them too.
	"integration_writeback",
}

func TestNativeIntegrationPackagesCannotCreateRawHTTPClients(t *testing.T) {
	t.Parallel()

	root := integrationInternalRoot(t)
	for _, packageName := range guardedIntegrationPackages {
		packageDir := filepath.Join(root, packageName)
		entries, err := os.ReadDir(packageDir)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			path := filepath.Join(packageDir, name)
			guardRawHTTPConstruction(t, path)
		}
	}
}

// settingsConsumerPackages OWN no provider settings — they receive an already
// stored settings map and act on it. They therefore have no `providers.go`
// normalizer to check, and requiring one would be asking them to re-validate
// something at the wrong layer.
//
// This is a named list rather than "skip the file if it is absent" on purpose.
// A missing providers.go is exactly what a package looks like when somebody has
// forgotten to write its normalizer, and silently tolerating absence would turn
// this guard into one that passes for the wrong reason — the failure mode this
// whole file is a reaction to.
var settingsConsumerPackages = map[string]string{
	"integration_writeback": "receives a stored settings map and writes back through it; the " +
		"settings themselves are normalized and policy-checked when they are SAVED, by the " +
		"owning integration package (e.g. commerce/providers.go calls ValidateSettings). Its " +
		"outbound calls are still policy-bound — see integration_writeback/egress.go.",
}

func TestEveryIntegrationNormalizerCallsSettingsPolicy(t *testing.T) {
	t.Parallel()

	root := integrationInternalRoot(t)
	checked := 0
	for _, packageName := range guardedIntegrationPackages {
		if _, consumerOnly := settingsConsumerPackages[packageName]; consumerOnly {
			continue
		}
		path := filepath.Join(root, packageName, "providers.go")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s has no providers.go normalizer to check, and is not listed in "+
				"settingsConsumerPackages: %v", packageName, err)
		}
		checked++
		if !strings.Contains(string(raw), "integration_egress.ValidateSettings(") {
			t.Errorf("%s normalizer does not enforce integration egress settings policy", packageName)
		}
	}
	// Vacuity floor: if every package became "consumer-only" this would pass
	// having checked nothing.
	if checked < 8 {
		t.Fatalf("only %d normalizers checked; too much of the guarded set has been "+
			"waived for this test to mean anything", checked)
	}
}

func guardRawHTTPConstruction(t *testing.T, path string) {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	httpAliases := map[string]bool{}
	for _, imp := range file.Imports {
		importPath, err := strconv.Unquote(imp.Path.Value)
		if err != nil || importPath != "net/http" {
			continue
		}
		alias := "http"
		if imp.Name != nil {
			alias = imp.Name.Name
		}
		httpAliases[alias] = true
	}
	if len(httpAliases) == 0 {
		return
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.AssignStmt:
			for _, expression := range n.Rhs {
				if directHTTPClientField(expression) {
					t.Errorf("%s:%d assigns an injected HTTPClient without applying the provider-bound egress helper", path, fset.Position(expression.Pos()).Line)
				}
			}
		case *ast.ReturnStmt:
			for _, expression := range n.Results {
				if directHTTPClientField(expression) {
					t.Errorf("%s:%d returns an injected HTTPClient without applying the provider-bound egress helper", path, fset.Position(expression.Pos()).Line)
				}
			}
		case *ast.ValueSpec:
			for _, expression := range n.Values {
				if directHTTPClientField(expression) {
					t.Errorf("%s:%d stores an injected HTTPClient without applying the provider-bound egress helper", path, fset.Position(expression.Pos()).Line)
				}
			}
		case *ast.SelectorExpr:
			if receiver, ok := n.X.(*ast.SelectorExpr); ok && receiver.Sel.Name == "HTTPClient" {
				t.Errorf("%s:%d calls an injected HTTPClient directly; apply the provider-bound egress helper first", path, fset.Position(n.Pos()).Line)
			}
			ident, ok := n.X.(*ast.Ident)
			if !ok || !httpAliases[ident.Name] {
				return true
			}
			switch n.Sel.Name {
			case "DefaultClient", "DefaultTransport", "ProxyFromEnvironment":
				t.Errorf("%s:%d uses http.%s; native integrations must use their provider-bound egress helper", path, fset.Position(n.Pos()).Line, n.Sel.Name)
			}
		case *ast.CompositeLit:
			selector, ok := n.Type.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			ident, ok := selector.X.(*ast.Ident)
			if !ok || !httpAliases[ident.Name] {
				return true
			}
			if selector.Sel.Name == "Client" || selector.Sel.Name == "Transport" {
				t.Errorf("%s:%d constructs raw http.%s; native integrations must use their provider-bound egress helper", path, fset.Position(n.Pos()).Line, selector.Sel.Name)
			}
		}
		return true
	})
}

func directHTTPClientField(expression ast.Expr) bool {
	selector, ok := expression.(*ast.SelectorExpr)
	return ok && selector.Sel.Name == "HTTPClient"
}

func integrationInternalRoot(t *testing.T) string {
	t.Helper()
	_, current, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve integration egress package path")
	}
	return filepath.Dir(filepath.Dir(current))
}

// TestEveryIntegrationPackageIsGuarded is the REVERSE of the two tests above,
// and it exists because they could not have caught what it found.
//
// Both iterate `guardedIntegrationPackages`, a HAND-WRITTEN list. That shape
// answers "do the packages we remembered obey the rule?" and never "did we
// remember every package?". `integration_writeback` was not on the list, and
// while these tests were green all seven of its provider adapters constructed a
// bare `&http.Client` and dialled tenant-supplied destinations with no host
// policy at all — the exact violation the list exists to prevent.
//
// The discovery rule is the package NAMING FAMILY: `*_integrations` and
// `integration_*`. It is mechanical, so a new integration package is caught the
// day it is created rather than the day somebody remembers to edit a slice. A
// package that legitimately needs no guarding must be named in `exempt` with
// its reason, which turns a silent omission into a written decision.
//
// This is the same shape as schemaguard's TestEveryServiceIsCovered, applied to
// the surface where the cost of a gap is an SSRF rather than a missing column.
func TestEveryIntegrationPackageIsGuarded(t *testing.T) {
	t.Parallel()

	// Packages in the naming family that make no outbound request of their own.
	exempt := map[string]string{
		"integration_egress": "this package IS the guard; it owns the policy and the enforced client",
		"integration_backfill": "schedules and records backfills; it constructs no HTTP client and " +
			"delegates every outbound call to the provider adapters, which are guarded",
	}

	root := integrationInternalRoot(t)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read internal dir: %v", err)
	}

	guarded := make(map[string]bool, len(guardedIntegrationPackages))
	for _, name := range guardedIntegrationPackages {
		guarded[name] = true
	}

	var family, missing []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, "_integrations") && !strings.HasPrefix(name, "integration_") {
			continue
		}
		family = append(family, name)
		if guarded[name] {
			continue
		}
		if _, ok := exempt[name]; ok {
			continue
		}
		missing = append(missing, name)
	}

	// Vacuity floor: a rename or a moved directory would otherwise leave this
	// scanning nothing and passing.
	if len(family) < 8 {
		t.Fatalf("found only %d integration-family packages; the discovery rule has "+
			"stopped matching and this test is no longer measuring anything", len(family))
	}
	if len(missing) > 0 {
		t.Errorf("these integration packages are outside the raw-client guard:\n  %s\n"+
			"Add each to guardedIntegrationPackages, or add it to `exempt` with the "+
			"reason it makes no outbound request. An unguarded package that dials a "+
			"tenant-supplied host with tenant credentials is an SSRF surface.",
			strings.Join(missing, "\n  "))
	}
}
