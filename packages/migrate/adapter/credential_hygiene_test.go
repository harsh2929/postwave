package adapter_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// credentialish matches identifiers that hold a secret value rather than
// merely mentioning one. The distinction is the whole point: an error reading
// "mailchimp: missing API token" is fine, and `fmt.Errorf("bad: %s", token)`
// is not.
func credentialish(name string) bool {
	lower := strings.ToLower(name)
	for _, needle := range []string{
		"token", "secret", "password", "passwd", "apikey", "api_key",
		"credential", "creds", "bearer", "authorization", "privatekey",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

// argName renders the interesting part of an argument expression: `tok`,
// `creds.APIKey`, `resp.Body`. Anything else returns "".
func argName(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		if base, ok := e.X.(*ast.Ident); ok {
			return base.Name + "." + e.Sel.Name
		}
		return e.Sel.Name
	case *ast.CallExpr:
		return argName(e.Fun)
	}
	return ""
}

// TestNoCredentialValuesInErrorsOrLogs sweeps every adapter in the module for
// a secret reaching an error string or a log line.
//
// This module is MIT-licensed and published: people run it against their own
// Mailchimp, HubSpot and Klaviyo accounts, with their own long-lived tokens,
// and pipe its output wherever their tooling sends logs. A token in an error
// message leaves the process, and neither we nor they can recall it.
//
// The adapters are careful today, and the OAuth paths are the reason to keep
// them that way: mailchimp/oauth.go and convertkit/oauth.go read the token
// endpoint's response body and then report ONLY the status code on a 4xx —
// never the body — because an OAuth error payload can echo back the client_id
// or the authorization code that was just exchanged.
//
// The check is on ARGUMENTS, not format strings. "missing API token: %w" names
// a secret and leaks nothing; `%s` with a `token` argument leaks one while
// naming nothing.
func TestNoCredentialValuesInErrorsOrLogs(t *testing.T) {
	root := ".."
	var scanned int
	var offenders []string

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			switch info.Name() {
			case ".git", "fixtures", "examples", "testdata":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return perr
		}
		scanned++

		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			case "Errorf", "Printf", "Sprintf", "Println", "Print",
				"Info", "Debug", "Warn", "Error", "Fatalf":
			default:
				return true
			}
			// Skip the format string itself; only the interpolated values can
			// carry a secret.
			for i, arg := range call.Args {
				if i == 0 {
					if _, isLit := arg.(*ast.BasicLit); isLit {
						continue
					}
				}
				name := argName(arg)
				if name == "" || !credentialish(name) {
					continue
				}
				pos := fset.Position(call.Pos())
				offenders = append(offenders, pos.Filename+":"+
					strings.TrimSpace(strings.Split(pos.String(), ":")[1])+
					" interpolates "+name)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}

	// Guard the guard: a walk that parsed nothing would pass silently, and a
	// credential sweep that proves nothing reads exactly like a clean one.
	if scanned < 20 {
		t.Fatalf("only scanned %d files; the walk is broken", scanned)
	}
	if !credentialish("accessToken") || credentialish("subscriber") {
		t.Fatal("credentialish() no longer classifies correctly")
	}

	for _, o := range offenders {
		t.Errorf("credential value reaches an error or log: %s", o)
	}
}

// TestOAuthFailuresDoNotEchoResponseBodies pins the specific decision that
// makes the OAuth paths safe.
//
// A token endpoint's 4xx body is attacker-adjacent data that routinely
// contains the client_id, the redirect_uri, and sometimes the authorization
// code itself. Both OAuth adapters deliberately report the status code alone.
// Wrapping the body here would be the natural "more helpful error" change, and
// it is the one that must not happen.
func TestOAuthFailuresDoNotEchoResponseBodies(t *testing.T) {
	for _, rel := range []string{"../mailchimp/oauth.go", "../convertkit/oauth.go"} {
		src, err := os.ReadFile(rel)
		if err != nil {
			t.Fatalf("read %s: %v", rel, err)
		}
		text := string(src)

		// Guard the guard: if the status-code branch disappears entirely this
		// test would pass while proving nothing.
		if !strings.Contains(text, "resp.StatusCode >= 400") && !strings.Contains(text, "resp.StatusCode >= 300") {
			t.Fatalf("%s: no status-code branch found", rel)
		}
		if !strings.Contains(text, "token endpoint %d") {
			t.Errorf("%s: the 4xx error no longer reports the status code", rel)
		}
		for _, leak := range []string{
			"token endpoint %d: %s",
			"%d: %s\", resp.StatusCode, body",
			"string(body)",
		} {
			if strings.Contains(text, leak) {
				t.Errorf("%s: OAuth failure echoes the response body (%q)", rel, leak)
			}
		}
	}
}
