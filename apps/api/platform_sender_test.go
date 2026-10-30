// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"testing"
)

const testPlatformSender = "Staging <noreply@staging.example.test>"

// unsetEnv clears key for the rest of the test and restores it afterwards.
// t.Setenv registers the restore; the Unsetenv makes the variable absent,
// which is a different state from set-to-empty.
func unsetEnv(t *testing.T, key string) {
	t.Helper()
	t.Setenv(key, "")
	if err := os.Unsetenv(key); err != nil {
		t.Fatalf("unset %s: %v", key, err)
	}
}

func strPtr(s string) *string { return &s }

func TestConfiguredPlatformSenderReadsOnlyTheAuthSender(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *string
		want  string
	}{
		{name: "absent", value: nil, want: ""},
		{name: "empty", value: strPtr(""), want: ""},
		{name: "blank", value: strPtr(" \t\n"), want: ""},
		{name: "configured", value: strPtr(testPlatformSender), want: testPlatformSender},
		{name: "configured with padding", value: strPtr("  " + testPlatformSender + "\n"), want: testPlatformSender},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The campaign default sender is a different setting: it must not
			// leak into platform notifications when the platform sender is unset.
			t.Setenv("POSTWAVE_DEFAULT_FROM_EMAIL", "Campaigns <hello@campaigns.example.test>")
			if tc.value == nil {
				unsetEnv(t, platformSenderEnv)
			} else {
				t.Setenv(platformSenderEnv, *tc.value)
			}
			if got := configuredPlatformSender(); got != tc.want {
				t.Fatalf("configuredPlatformSender() = %q, want %q", got, tc.want)
			}
		})
	}
}

// The auth mail and the notification workers must agree on what counts as a
// configured sender: buildAuthDeps resolves the auth From from the same helper
// the workers are handed, and only falls back to its own default when that
// helper reports nothing.
func TestAuthFromAddressResolvesThroughTheConfiguredPlatformSender(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name  string
		value *string
		want  string
	}{
		{name: "absent keeps the default", value: nil, want: "Moosewave <noreply@moosewave.com>"},
		{name: "blank keeps the default", value: strPtr("   "), want: "Moosewave <noreply@moosewave.com>"},
		{name: "configured wins", value: strPtr(" " + testPlatformSender + " "), want: testPlatformSender},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.value == nil {
				unsetEnv(t, platformSenderEnv)
			} else {
				t.Setenv(platformSenderEnv, *tc.value)
			}
			from, deps := buildAuthDeps(buildAuthDepsDeps{logger: logger})
			if from != tc.want {
				t.Fatalf("buildAuthDeps From = %q, want %q", from, tc.want)
			}
			if deps == nil || deps.FromAddress != tc.want {
				t.Fatalf("auth.Deps.FromAddress does not match the resolved sender %q", tc.want)
			}
		})
	}
}

// platformSenderConsumer is a platform notification the composition root builds
// with its own sender field. Each keeps an @moosewave.com default when that field
// is empty, so the root must hand it configuredPlatformSender(): the configured
// sender when there is one, and "" (the worker's own default) when there is not.
// Handing it authFromAddress instead would change what an unconfigured
// deployment sends the digest and webhook alerts from; leaving the field out
// would make SES reject every message on any identity but moosewave.com.
type platformSenderConsumer struct {
	importPath string
	typeName   string
	field      string
}

var platformSenderConsumers = []platformSenderConsumer{
	{apiModulePath + "/internal/segments", "DecayWorker", "FromAddress"},
	{apiModulePath + "/internal/analytics", "DigestSender", "From"},
	{apiModulePath + "/internal/workers", "WebhookAlertSenderDeps", "From"},
}

func TestPlatformNotificationWorkersTakeTheConfiguredPlatformSender(t *testing.T) {
	root := readAPICompositionRoot(t)
	found := map[platformSenderConsumer]int{}
	senderEnvLiterals := 0
	for _, name := range root.names {
		fileSet := token.NewFileSet()
		file, err := parser.ParseFile(fileSet, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		imports := importLocalNames(t, file)
		ast.Inspect(file, func(node ast.Node) bool {
			switch value := node.(type) {
			case *ast.BasicLit:
				if value.Kind == token.STRING && value.Value == strconv.Quote(platformSenderEnv) {
					senderEnvLiterals++
				}
			case *ast.CompositeLit:
				selector, ok := value.Type.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				pkg, ok := selector.X.(*ast.Ident)
				if !ok {
					return true
				}
				for _, consumer := range platformSenderConsumers {
					if imports[pkg.Name] != consumer.importPath || selector.Sel.Name != consumer.typeName {
						continue
					}
					found[consumer]++
					where := fileSet.Position(value.Pos())
					sender, set := compositeField(value, consumer.field)
					if !set {
						t.Errorf("%s: %s.%s leaves %s unset; pass configuredPlatformSender() so a configured "+
							"deployment can send it", where, pkg.Name, consumer.typeName, consumer.field)
						continue
					}
					if !isConfiguredPlatformSenderCall(sender) {
						t.Errorf("%s: %s.%s sets %s to something other than configuredPlatformSender()",
							where, pkg.Name, consumer.typeName, consumer.field)
					}
				}
			}
			return true
		})
	}
	for _, consumer := range platformSenderConsumers {
		if found[consumer] == 0 {
			t.Errorf("the composition root no longer builds %s.%s; this contract would pass vacuously, so "+
				"update platformSenderConsumers", consumer.importPath, consumer.typeName)
		}
	}
	// One reader: a second os.Getenv of the variable could disagree with
	// configuredPlatformSender about blank values and split the auth mail from
	// the workers.
	if senderEnvLiterals != 1 {
		t.Errorf("composition root spells %q %d times, want exactly 1 (the platformSenderEnv constant)",
			platformSenderEnv, senderEnvLiterals)
	}
}

// importLocalNames maps each import's name in file to its path.
func importLocalNames(t *testing.T, file *ast.File) map[string]string {
	t.Helper()
	names := map[string]string{}
	for _, spec := range file.Imports {
		path, err := strconv.Unquote(spec.Path.Value)
		if err != nil {
			t.Fatalf("import path %s: %v", spec.Path.Value, err)
		}
		name := path[strings.LastIndex(path, "/")+1:]
		if spec.Name != nil {
			name = spec.Name.Name
		}
		names[name] = path
	}
	return names
}

// compositeField returns the value a keyed composite literal gives field.
func compositeField(literal *ast.CompositeLit, field string) (ast.Expr, bool) {
	for _, element := range literal.Elts {
		pair, ok := element.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if key, ok := pair.Key.(*ast.Ident); ok && key.Name == field {
			return pair.Value, true
		}
	}
	return nil, false
}

func isConfiguredPlatformSenderCall(expr ast.Expr) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok || len(call.Args) != 0 {
		return false
	}
	fn, ok := call.Fun.(*ast.Ident)
	return ok && fn.Name == "configuredPlatformSender"
}
