// SPDX-License-Identifier: AGPL-3.0-only

package db_test

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A SECURITY DEFINER function that does not name pg_temp is an escalation
// primitive.
//
// `SET search_path = pg_catalog, public` reads as exhaustive and is not. When
// pg_temp is not named, PostgreSQL still searches the caller's temporary schema
// — and searches it FIRST for relation and TYPE names. So every unqualified type
// or table in a definer body resolves to whatever the CALLER put in pg_temp.
//
// This was exploited against this schema, not merely predicted. As the ordinary
// application role:
//
//	CREATE FUNCTION pg_temp.evil(text) RETURNS boolean AS $$ ...any SQL... $$;
//	CREATE DOMAIN pg_temp.uuid AS text CHECK (pg_temp.evil(VALUE));
//	SELECT some_definer_function('...', '...');
//
// The body's `DECLARE x uuid` bound to the caller's domain, so the CHECK ran
// inside the definer context. It counted 283 subscribers across 159 tenants
// where the same read under RLS returns 2 rows and 1 tenant. Naming pg_temp last
// closed it, and re-running the attack against an unhardened copy confirmed that
// was the only thing that mattered.
//
// MIGRATION 1915 SWEPT THE 52 THAT EXISTED. This test is the half that lasts.
// The sweep ran at one point in the migration ordering, so a definer function
// introduced by any later migration is not covered by it — and the hole is
// invisible from outside, since the function works perfectly until someone
// shadows a type. Asserting it over the live catalogue is what turns "we fixed
// them all once" into "one cannot be added unhardened".
//
// ENUMERATED WITH A FLOOR, because a query returning nothing looks identical to
// a schema with no problems. If the catalogue suddenly holds almost no definer
// functions, the query is wrong and this test must say so rather than pass.
func TestEverySecurityDefinerFunctionNamesPgTemp(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping SECURITY DEFINER search_path contract test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	rows, err := pool.Query(ctx, `
SELECT p.oid::regprocedure::text AS signature,
       p.proowner::regrole::text AS owner,
       COALESCE(array_to_string(p.proconfig, ' | '), '(no settings at all)') AS settings,
       EXISTS (
           SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS setting
            WHERE setting LIKE 'search_path=%' AND setting ILIKE '%pg_temp%'
       ) AS names_pg_temp
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg_toast%'
 ORDER BY 1`)
	if err != nil {
		t.Fatalf("inspect SECURITY DEFINER functions: %v", err)
	}
	defer rows.Close()

	total := 0
	var offenders []string
	for rows.Next() {
		var signature, owner, settings string
		var namesPgTemp bool
		if scanErr := rows.Scan(&signature, &owner, &settings, &namesPgTemp); scanErr != nil {
			t.Fatalf("scan definer function: %v", scanErr)
		}
		total++
		if !namesPgTemp {
			offenders = append(offenders,
				"    "+signature+"\n      owner: "+owner+"\n      settings: "+settings)
		}
	}
	if rows.Err() != nil {
		t.Fatalf("iterate definer functions: %v", rows.Err())
	}

	// The schema had 63 at the time migration 1915 swept it. A floor well under
	// that catches a broken query or a database that never ran the migrations,
	// without failing every time a function is legitimately retired.
	const minDefinerFunctions = 40
	if total < minDefinerFunctions {
		t.Fatalf("found only %d SECURITY DEFINER functions, expected at least %d. "+
			"Refusing to report a clean result over a catalogue this query probably "+
			"failed to read — a green answer here would mean exactly what a schema "+
			"with no escalation risk looks like.", total, minDefinerFunctions)
	}

	if len(offenders) > 0 {
		t.Fatalf("%d of %d SECURITY DEFINER function(s) do not name pg_temp in "+
			"search_path, so a caller can shadow the unqualified types and tables in "+
			"the body and run its own SQL inside the definer's identity:\n%s\n"+
			"  Fix: ALTER FUNCTION <signature> SET search_path = pg_catalog, public, pg_temp;\n"+
			"  pg_temp must be LAST — naming it is what stops PostgreSQL searching it "+
			"FIRST. Use ALTER rather than CREATE OR REPLACE, which resets SECURITY "+
			"DEFINER and the search_path itself. See migration 1915.",
			len(offenders), total, strings.Join(offenders, "\n"))
	}
}
