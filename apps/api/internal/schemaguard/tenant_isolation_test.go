// Package schemaguard holds static checks over infra/migrations that need no
// database. They complement the DB-backed RLS tests elsewhere in this module:
// those prove a specific table isolates correctly, this proves no table was
// added without anyone deciding whether it should.
package schemaguard_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var (
	commentRE    = regexp.MustCompile(`(?m)^\s*--.*$`)
	createRE     = regexp.MustCompile(`(?is)CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z0-9_]+)\s*\((.*?)\n\)\s*;`)
	enableRLSRE  = regexp.MustCompile(`(?i)ALTER TABLE (?:public\.)?([a-z0-9_]+)\s+ENABLE ROW LEVEL SECURITY`)
	dynamicRLSRE = regexp.MustCompile(`(?i)ENABLE ROW LEVEL SECURITY`)
	exceptionRE  = regexp.MustCompile(`(?is)COMMENT ON COLUMN (?:public\.)?([a-z0-9_]+)\.tenant_id IS\s*'postwave:tenant-scope-exception=([a-z-]+)`)
	tenantColRE  = regexp.MustCompile(`(?m)^\s*tenant_id\b`)
)

// TestEveryTenantTableIsolatesOrIsDocumented is the cross-tenant isolation
// invariant for the whole schema.
//
// A table with a tenant_id column and no row-level security is a table where
// every postwave_app session can read every tenant's rows. Migration 1730
// records the deliberate exceptions in-band, as machine-readable comments on
// the columns themselves — "intentionally comments on the effective objects,
// not assumptions held only in a linter allow-list":
//
//	COMMENT ON COLUMN web_vitals_events.tenant_id IS
//	  'postwave:tenant-scope-exception=global-telemetry; …'
//
// That phrasing anticipates a verifier reading them back. Nothing in the repo
// did: `tenant-scope-exception` appeared in exactly one file, the migration
// that writes it. So the classification existed, the exceptions were sound,
// and the rule they are exceptions TO was unenforced — the next table to
// arrive without RLS would have been indistinguishable from the two that were
// reviewed.
//
// Checked statically against the migration text so it runs without a database,
// alongside the DB-backed per-table RLS tests rather than instead of them.
func TestEveryTenantTableIsolatesOrIsDocumented(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "infra", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}

	tenantTables := map[string]string{} // table -> defining file
	rlsTables := map[string]bool{}
	exceptions := map[string]string{} // table -> exception reason
	var dynamicRLSFiles int

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		raw, rerr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if rerr != nil {
			t.Fatalf("read %s: %v", entry.Name(), rerr)
		}
		text := commentRE.ReplaceAllString(string(raw), "")

		for _, m := range createRE.FindAllStringSubmatch(text, -1) {
			if tenantColRE.MatchString(m[2]) {
				if _, seen := tenantTables[m[1]]; !seen {
					tenantTables[m[1]] = entry.Name()
				}
			}
		}
		for _, m := range enableRLSRE.FindAllStringSubmatch(text, -1) {
			rlsTables[m[1]] = true
		}
		if dynamicRLSRE.MatchString(text) {
			dynamicRLSFiles++
		}
		// Exceptions are written as comments, so read them from the raw text.
		for _, m := range exceptionRE.FindAllStringSubmatch(string(raw), -1) {
			exceptions[m[1]] = m[2]
		}
	}

	// Guard the guard. A regex that stopped matching would report a clean
	// schema, which is the most dangerous possible false pass here.
	if len(tenantTables) < 400 {
		t.Fatalf("only found %d tenant_id tables; the CREATE TABLE parse is broken", len(tenantTables))
	}
	if len(rlsTables) < 400 {
		t.Fatalf("only found %d RLS-enabled tables; the ALTER TABLE parse is broken", len(rlsTables))
	}
	if len(exceptions) == 0 {
		t.Fatal("found no tenant-scope-exception comments; the exception parse is broken")
	}

	var undecided []string
	for table, file := range tenantTables {
		if rlsTables[table] {
			continue
		}
		if reason, ok := exceptions[table]; ok {
			if strings.TrimSpace(reason) == "" {
				undecided = append(undecided, table+" ("+file+"): empty exception reason")
			}
			continue
		}
		undecided = append(undecided, table+" ("+file+")")
	}
	sort.Strings(undecided)

	for _, u := range undecided {
		t.Errorf(
			"table has tenant_id but neither row-level security nor a "+
				"postwave:tenant-scope-exception comment: %s", u,
		)
	}
}

// TestDocumentedExceptionsStayNarrow keeps the escape hatch from becoming the
// rule. Every exception is a table where cross-tenant reads are possible by
// design, so the set should be small enough to hold in your head and each
// entry should say which reviewed category it belongs to.
func TestDocumentedExceptionsStayNarrow(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "infra", "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	reasons := map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		raw, rerr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if rerr != nil {
			t.Fatalf("read %s: %v", entry.Name(), rerr)
		}
		for _, m := range exceptionRE.FindAllStringSubmatch(string(raw), -1) {
			reasons[m[1]] = m[2]
		}
	}
	if len(reasons) == 0 {
		t.Fatal("no exceptions parsed; the guard is not testing anything")
	}

	// The reviewed categories as of migration 1730. A new category is a new
	// class of cross-tenant visibility and deserves the review this list
	// forces, rather than arriving as free text in a comment.
	// The full reviewed set, taken from every exception comment in the
	// migrations — not from the excerpt of 1730 that happened to be on screen.
	// The first version of this list omitted shared-infrastructure and
	// preauth-secret and reported three correct tables as unreviewed: a
	// baseline assembled from a partial read is a guard that cries wolf, and a
	// guard that cries wolf gets its expectations widened until it says
	// nothing.
	known := map[string]bool{
		"global-accounting":        true,
		"platform-operator-audit":  true,
		"durable-audit-set-null":   true,
		"platform-default":         true,
		"global-telemetry":         true,
		"unresolved-public-ingest": true,
		"shared-infrastructure":    true,
		"preauth-secret":           true,
	}
	var novel []string
	for table, reason := range reasons {
		if !known[reason] {
			novel = append(novel, table+" => "+reason)
		}
	}
	sort.Strings(novel)
	for _, n := range novel {
		t.Errorf("tenant-scope exception uses an unreviewed category: %s", n)
	}
}
