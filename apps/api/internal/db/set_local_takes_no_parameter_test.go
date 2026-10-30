package db_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// `SET LOCAL app.tenant_id = $1` is a syntax error, not a slow path.
//
// SET LOCAL is utility syntax and takes no bind parameters -- Postgres cannot
// even PREPARE it; the parser fails at the $1 with 42601. Two call sites shipped
// with it (audit/aivs.go, audit/session_link.go), so
// GET /api/v1/audit/ai-session/{id}/aivs-bundle failed on every request it had
// ever served.
//
// It is a plausible-looking line. It reads exactly like the parameterised SQL
// beside it, the driver accepts the call, and the failure only appears at
// runtime against a real server -- which is where it was found, not in review.
//
// set_config(name, value, is_local) is the function form and takes parameters
// normally; its third argument gives the same transaction-local scope.

var setLocalWithParam = regexp.MustCompile(`(?i)SET\s+LOCAL\s+[\w.]+\s*=\s*\$\d`)

func TestNoSetLocalCarriesABindParameter(t *testing.T) {
	root := "../.."
	var offenders []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if info.Name() == "node_modules" || info.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		for i, line := range strings.Split(string(body), "\n") {
			// Skip comments. The fix for this very bug documents the broken
			// form verbatim, and a guard that flags the explanation of a
			// deletion reports the opposite of the truth -- which is exactly
			// what happened on the first run of this test.
			if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "//") ||
				strings.HasPrefix(trimmed, "*") || strings.HasPrefix(trimmed, "/*") {
				continue
			}
			if setLocalWithParam.MatchString(line) {
				offenders = append(offenders, filepath.ToSlash(path)+":"+itoa(i+1))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("SET LOCAL takes no bind parameters; use SELECT set_config(name, $1, true):\n  %s",
			strings.Join(offenders, "\n  "))
	}
}

func TestTheGuardCanSeeGoSourceAtAll(t *testing.T) {
	// Guards the guard: a broken walk would make the assertion above vacuous.
	count := 0
	_ = filepath.Walk("../..", func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if strings.HasSuffix(path, ".go") {
			count++
		}
		return nil
	})
	if count < 500 {
		t.Fatalf("expected to scan hundreds of Go files, saw %d", count)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
