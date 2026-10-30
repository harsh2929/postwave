package secrets

import (
	"context"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// TestNoSecretValueReachesAnError is the property this package exists to keep.
//
// A Resolver returns credentials — API keys, provider tokens, signing secrets.
// Every caller wraps its errors and most log them, so a value that reaches an
// error string leaves the process and lands wherever the operator's logging
// goes. Unlike a request id, it cannot be redacted after the fact.
//
// The package is careful today: all three error sites name the SECRET, never
// its value — `fmt.Errorf("secretsmanager %q: %w", name, err)` — and
// ErrNotFound is a bare sentinel. Nothing enforces that, and "include the
// value so we can see what failed to parse" is the natural next change.
//
// Checked on the ARGUMENTS rather than the message: "secrets: not found"
// mentions secrets and leaks nothing, while `%q` with a value argument does
// the reverse.
func TestNoSecretValueReachesAnError(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "secrets.go", nil, 0)
	if err != nil {
		t.Fatalf("parse secrets.go: %v", err)
	}

	// Identifiers that hold a secret VALUE in this package. `name` is the
	// lookup key and is safe — it is what makes the errors useful.
	valueish := map[string]bool{
		"value": true, "secret": true, "raw": true, "payload": true,
		"plaintext": true, "SecretString": true, "body": true,
	}

	var checked int
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
		case "Errorf", "New", "Printf", "Println", "Print":
		default:
			return true
		}
		checked++
		for i, arg := range call.Args {
			if i == 0 {
				continue // the format string itself
			}
			var ident string
			switch e := arg.(type) {
			case *ast.Ident:
				ident = e.Name
			case *ast.SelectorExpr:
				ident = e.Sel.Name
			}
			if ident != "" && valueish[ident] {
				pos := fset.Position(call.Pos())
				t.Errorf(
					"secrets.go:%d: %s() interpolates %q — a secret value must "+
						"never reach an error string",
					pos.Line, sel.Sel.Name, ident,
				)
			}
		}
		return true
	})

	// Guard the guard: an AST walk that matched nothing reports perfect
	// hygiene while checking nothing at all.
	if checked < 2 {
		t.Fatalf("found only %d error/log calls; the scan is broken", checked)
	}
}

// TestParseFailureDoesNotEchoTheSecret covers the one path where a secret's
// CONTENT could plausibly reach an error: GetJSON wraps json.Unmarshal's
// failure, and the secret body is what failed to parse.
//
// Go's encoding/json reports offsets and type names, never the input — this
// asserts that rather than trusting it, because the guarantee is the reason
// the wrap is safe and it lives in the standard library, not in this repo.
func TestParseFailureDoesNotEchoTheSecret(t *testing.T) {
	const secret = "sk_live_do_not_log_me_9f3a"

	for _, payload := range []string{
		`{"token": "` + secret + `"`,  // truncated object
		`{"count": "` + secret + `"}`, // wrong type for the destination
		`[` + secret + `]`,            // bare word
	} {
		var dst struct {
			Count int `json:"count"`
		}
		err := json.Unmarshal([]byte(payload), &dst)
		if err == nil {
			continue
		}
		if strings.Contains(err.Error(), secret) {
			t.Errorf("json.Unmarshal echoed the secret: %q", err.Error())
		}
	}
}

// TestNotFoundIsASentinelWithNoDetail keeps the fallback contract usable
// without making it chatty. Callers errors.Is() this to decide it is safe to
// fall back to an env var, so it must stay comparable — and it must not grow
// detail, because "not found" is asked about names that do not exist and the
// answer travels further than a normal error.
func TestNotFoundIsASentinelWithNoDetail(t *testing.T) {
	if !errors.Is(ErrNotFound, ErrNotFound) {
		t.Fatal("ErrNotFound is not comparable with errors.Is")
	}
	if strings.Contains(ErrNotFound.Error(), "=") ||
		len(ErrNotFound.Error()) > 40 {
		t.Errorf("ErrNotFound carries detail it should not: %q", ErrNotFound.Error())
	}

	// The env resolver's miss must be the same sentinel, or a caller's
	// fallback branch silently stops firing.
	_, err := NewEnvResolver().Get(context.Background(), "definitely-not-set-"+t.Name())
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("EnvResolver miss is not ErrNotFound: %v", err)
	}
}

// TestSourceNamesTheSecretNotItsValue pins the shape of the two wrapped
// errors, since that is what makes them safe to log at all.
func TestSourceNamesTheSecretNotItsValue(t *testing.T) {
	src, err := os.ReadFile("secrets.go")
	if err != nil {
		t.Fatalf("read secrets.go: %v", err)
	}
	text := string(src)

	for _, want := range []string{
		`fmt.Errorf("secretsmanager %q: %w", name, err)`,
		`fmt.Errorf("secretsmanager %q: parse json: %w", name, err)`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("expected error to name the secret and wrap the cause: %s", want)
		}
	}
}
