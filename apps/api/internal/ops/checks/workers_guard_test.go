// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// The worker census is only useful if it matches reality, and it rots in two
// directions that fail differently:
//
//   - A worker added WITHOUT a declaration is invisible. The fleet check
//     downgrades to a WARN naming it, but nobody reads a warn about a worker
//     they did not know existed.
//   - A declaration left behind after a worker is DELETED is worse: it renders
//     RED forever for a worker that is never coming back, and a permanently
//     red row gets snoozed, and a snoozed row is how the whole lane starts
//     being ignored.
//
// So the source is the authority and this test enforces both directions.
func TestDeclaredWorkers_MatchesEverySafegoCallSite(t *testing.T) {
	found, err := safegoWorkerNames(apiRoot(t))
	if err != nil {
		t.Fatalf("scanning safego call sites: %v", err)
	}
	if len(found) == 0 {
		// A scan that finds nothing would make this test vacuously pass and
		// hide both failure modes at once.
		t.Fatal("found no safego.Go call sites — the scanner is broken, not the codebase")
	}

	declared := map[string]bool{}
	for _, w := range DeclaredWorkers {
		if declared[w.Name] {
			t.Fatalf("worker %q is declared twice", w.Name)
		}
		declared[w.Name] = true
	}

	var undeclared, phantom []string
	for name := range found {
		if !declared[name] {
			undeclared = append(undeclared, name)
		}
	}
	for name := range declared {
		if !found[name] {
			phantom = append(phantom, name)
		}
	}
	sort.Strings(undeclared)
	sort.Strings(phantom)

	if len(undeclared) > 0 {
		t.Errorf("these workers are spawned but not declared in workers.go, so the fleet check cannot notice them dying: %v", undeclared)
	}
	if len(phantom) > 0 {
		t.Errorf("these workers are declared but no longer spawned anywhere; they would render RED forever: %v", phantom)
	}
}

// Every declared worker must name a registered coverage domain, or the fleet
// silently serves a surface the board does not know exists.
func TestDeclaredWorkers_NameRegisteredDomains(t *testing.T) {
	for _, w := range DeclaredWorkers {
		if _, ok := ops.GetDomain(w.Domain); !ok {
			t.Errorf("worker %q names unregistered domain %q", w.Name, w.Domain)
		}
		if strings.TrimSpace(w.Owner) == "" {
			t.Errorf("worker %q has no owner", w.Name)
		}
		if strings.TrimSpace(w.Why) == "" {
			t.Errorf("worker %q has no Why: a dead worker nobody can describe the cost of is a dead worker nobody restarts", w.Name)
		}
	}
}

func apiRoot(t *testing.T) string {
	t.Helper()
	// .../apps/api/internal/ops/checks -> .../apps/api
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(filepath.Join(wd, "..", "..", ".."))
}

var safegoCall = regexp.MustCompile(`safego\.Go\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*,\s*"([^"]+)"`)

// safegoWorkerNames reads every .go file under root and collects the worker
// names passed to safego.Go.
//
// Comments are stripped FIRST, and in the order block-then-line would get
// wrong: a `//` line comment containing `/*` would otherwise open a block that
// swallows real code below it. Test files and the safego package itself are
// skipped — both contain example and fixture call sites that are not part of
// the running fleet.
func safegoWorkerNames(root string) (map[string]bool, error) {
	names := map[string]bool{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == "vendor" || info.Name() == "testdata" || info.Name() == "safego" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, m := range safegoCall.FindAllStringSubmatch(stripGoComments(string(raw)), -1) {
			names[m[1]] = true
		}
		return nil
	})
	return names, err
}

func stripGoComments(src string) string {
	var out strings.Builder
	inLine, inBlock, inString, inRaw := false, false, false, false
	for i := 0; i < len(src); i++ {
		switch {
		case inLine:
			if src[i] == '\n' {
				inLine = false
				out.WriteByte('\n')
			}
		case inBlock:
			if src[i] == '*' && i+1 < len(src) && src[i+1] == '/' {
				inBlock = false
				i++
			}
		case inRaw:
			out.WriteByte(src[i])
			if src[i] == '`' {
				inRaw = false
			}
		case inString:
			out.WriteByte(src[i])
			if src[i] == '\\' && i+1 < len(src) {
				i++
				out.WriteByte(src[i])
			} else if src[i] == '"' {
				inString = false
			}
		case src[i] == '/' && i+1 < len(src) && src[i+1] == '/':
			inLine = true
			i++
		case src[i] == '/' && i+1 < len(src) && src[i+1] == '*':
			inBlock = true
			i++
		case src[i] == '"':
			inString = true
			out.WriteByte(src[i])
		case src[i] == '`':
			inRaw = true
			out.WriteByte(src[i])
		default:
			out.WriteByte(src[i])
		}
	}
	return out.String()
}
