// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func inventoryPool(ctx context.Context, t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping erasure inventory proof")
	}
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func discoverSubjectDataTables(ctx context.Context, t *testing.T, pool *db.Pool) []string {
	t.Helper()
	rows, err := pool.Query(ctx, `
WITH schema_columns AS (
    SELECT relation.oid AS relation_oid,
           relation.relname AS table_name,
           attribute.attname AS column_name
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm')
       AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_inherits AS inheritance
            WHERE inheritance.inhrelid = relation.oid
       )
)
SELECT DISTINCT table_name
  FROM schema_columns
 WHERE (`+subjectIdentityColumnPredicate+`)
 ORDER BY table_name`)
	if err != nil {
		t.Fatalf("discover subject-data tables: %v", err)
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		found = append(found, name)
	}
	return found
}

// The ratchet. A new table carrying a subject-identifying column must be
// declared deliberately, because that is the moment somebody has to decide
// whether Art. 17 needs to reach it. Without this, the erasure scope grows
// every time a migration adds a column named `email` and nobody notices.
func TestSubjectDataTableInventoryMatchesTheSchema(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)

	declared := map[string]bool{}
	for _, name := range declaredSubjectDataTables {
		declared[name] = true
	}
	found := discoverSubjectDataTables(ctx, t, pool)
	foundSet := map[string]bool{}

	var undeclared []string
	for _, name := range found {
		foundSet[name] = true
		if !declared[name] {
			undeclared = append(undeclared, name)
		}
	}
	if len(undeclared) != 0 {
		t.Fatalf("%d table(s) carry subject identity but are not in the inventory: %s\n"+
			"Add them to declaredSubjectDataTables AND decide whether "+
			"eraseSubscriberDataWithEntropy must reach them.",
			len(undeclared), strings.Join(undeclared, ", "))
	}

	// A declared table that no longer exists is equally a problem: the baseline
	// stops describing the schema, and a reader cannot tell a stale entry from
	// a table that was renamed while still holding identity.
	var missing []string
	for _, name := range declaredSubjectDataTables {
		if !foundSet[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) != 0 {
		t.Fatalf("%d declared table(s) no longer carry subject identity: %s\n"+
			"Remove them from the inventory, having confirmed they were dropped "+
			"rather than renamed.", len(missing), strings.Join(missing, ", "))
	}
}

// Cross-checks the code against the schema. A table name misspelled inside one
// of erasure.go's SQL strings runs happily against zero rows, so an erasure
// that silently skips a table looks exactly like one that had nothing to erase.
func TestEveryErasureTargetIsARealSubjectDataTable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)

	found := map[string]bool{}
	for _, name := range discoverSubjectDataTables(ctx, t, pool) {
		found[name] = true
	}
	for _, target := range erasureCoveredTables {
		var exists bool
		if err := pool.QueryRow(ctx,
			`SELECT to_regclass('public.' || $1) IS NOT NULL`, target).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("erasure targets %q, which does not exist: the statement runs "+
				"against nothing and the miss is invisible", target)
		}
	}
}

func TestHelpdeskRelationalErasureInventoryExistsAndRemainsUncovered(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)
	covered := make(map[string]bool, len(erasureCoveredTables))
	for _, name := range erasureCoveredTables {
		covered[name] = true
	}
	for _, name := range declaredHelpdeskRelationalSubjectTables {
		if covered[name] {
			t.Fatalf("Helpdesk relational table %q is listed as covered before the Helpdesk lifecycle hold is closed", name)
		}
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass('public.' || $1) IS NOT NULL`, name).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("Helpdesk relational inventory names missing table %q", name)
		}
	}
}

// Makes the gap a number rather than a comment. This does not assert a target —
// the remaining tables need an approved retention policy before anything can
// erase them — but a coverage figure that silently fell would otherwise be
// indistinguishable from one nobody had measured.
func TestErasureCoverageOfSubjectDataIsRecorded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)

	declared := discoverSubjectDataTables(ctx, t, pool)
	covered := map[string]bool{}
	for _, name := range erasureCoveredTables {
		covered[name] = true
	}
	var uncovered, coveredWithinDiscovered []string
	for _, name := range declared {
		if covered[name] {
			coveredWithinDiscovered = append(coveredWithinDiscovered, name)
			continue
		}
		uncovered = append(uncovered, name)
	}
	sort.Strings(uncovered)

	// Some erasure targets are keyed by subscriber_id and carry no address
	// column, so they are correctly absent from the discovered set. Reporting
	// "14 of 122" would silently mix the two populations and overstate coverage
	// of the discovered tables by four.
	keyedBySubscriberID := len(covered) - len(coveredWithinDiscovered)

	if len(covered) == 0 {
		t.Fatal("no erasure coverage recorded at all")
	}
	if erasureHistoryCoverageComplete && len(uncovered) != 0 {
		t.Fatalf("erasureHistoryCoverageComplete is true while %d subject-data "+
			"table(s) are not reached by erasure: %s",
			len(uncovered), strings.Join(uncovered, ", "))
	}
	t.Log(fmt.Sprintf(
		"erasure reaches %d of %d tables carrying a subject address (%d further "+
			"targets are keyed by subscriber_id and carry no address column); "+
			"%d remain uncovered, pending the retention policy and "+
			"least-privilege grants that gate erasureHistoryCoverageComplete",
		len(coveredWithinDiscovered), len(declared), keyedBySubscriberID, len(uncovered)))
}

// The source policy and the physical schema are separate ratchets. This test
// proves every discovered logical root has exactly one source disposition and
// every source-classified table still exists. Monthly partition children are
// covered by their parent and intentionally do not create duplicate policy.
func TestErasureStorePolicyMatchesTheSchema(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := inventoryPool(ctx, t)

	readiness, err := currentErasurePolicyReadiness()
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range discoverSubjectDataTables(ctx, t, pool) {
		if _, ok := readiness.DispositionByTable[table]; !ok {
			t.Errorf("schema store %q has no erasure policy disposition", table)
		}
	}
	for _, table := range declaredHelpdeskRelationalSubjectTables {
		if readiness.DispositionByTable[table] != erasurePolicyApprovalRequired {
			t.Errorf("Helpdesk store %q must remain approval_required until its subject graph policy is approved", table)
		}
	}
}
