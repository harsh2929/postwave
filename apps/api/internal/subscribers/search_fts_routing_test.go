// SPDX-License-Identifier: AGPL-3.0-only
//
// search_fts_routing_test.go — SUB-039: pins the wiring that routes the
// /subscribers/search box through the FTS + pg_trgm structured path
// (ParseSearch → buildSearchWhere against search_tsv / email-trgm,
// mig 0242) instead of the legacy per-row ILIKE-on-jsonb scan
// (the ten-column ILIKE that subscriberFreeTextPredicate replaced).
//
// These are pure-function tests so they run without a DATABASE_URL: the
// handler now feeds ParseSearch(q) into Repo.SearchWithQuery, which builds
// its WHERE entirely from buildSearchWhere. Asserting the SQL that pair
// produces is the same thing as asserting the live route — the handler
// adds no SQL of its own.

package subscribers

import (
	"context"
	"strings"
	"testing"
)

// legacyILIKEMarker is a fragment from the retired ILIKE-on-jsonb predicate.
// Nothing emits it any more — the list, /search and the CSV export all share
// subscriberFreeTextPredicate — so its reappearance anywhere means the
// per-row jsonb scan came back.
const legacyILIKEMarker = "custom_fields::text ILIKE"

// TestSearchRoutesThroughFTSNotILIKE verifies that the operator/free-text
// queries the handler now parses produce the FTS + pg_trgm structured
// predicates from buildSearchWhere — and never the legacy ILIKE jsonb scan.
func TestSearchRoutesThroughFTSNotILIKE(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantParts []string // FTS/structured fragments that MUST appear
	}{
		{
			name:      "tag:vip → array containment",
			raw:       "tag:vip",
			wantParts: []string{"tags && ARRAY["},
		},
		{
			name:      "@acme.com → trgm email domain",
			raw:       "@acme.com",
			wantParts: []string{"lower(email::text) LIKE '%@'"},
		},
		{
			name:      "-tag:churned → negated containment",
			raw:       "-tag:churned",
			wantParts: []string{"NOT (tags && ARRAY["},
		},
		{
			name:      "name:jane → merge/custom name match",
			raw:       "name:jane",
			wantParts: []string{"merge_fields->>'FNAME'", "merge_fields->>'LNAME'"},
		},
		{
			name:      "plain free text → tsv + trgm fast path",
			raw:       "alice",
			wantParts: []string{"search_tsv @@ websearch_to_tsquery", "lower(email::text) LIKE"},
		},
		{
			name: "mixed operators stay structured",
			raw:  "tag:vip @acme.com -tag:churned name:jane alice",
			wantParts: []string{
				"search_tsv @@ websearch_to_tsquery",
				"tags && ARRAY[",
				"NOT (tags && ARRAY[",
				"lower(email::text) LIKE '%@'",
				"merge_fields->>'FNAME'",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := ParseSearch(tc.raw)
			if q.IsEmpty() {
				t.Fatalf("ParseSearch(%q) parsed to empty — handler would 400, not route to FTS", tc.raw)
			}
			// This is exactly what Repo.SearchWithQuery builds its WHERE from.
			sql, args := buildSearchWhere(q, []any{"00000000-0000-4000-8000-000000000000"})

			// Must take the FTS/structured path…
			for _, p := range tc.wantParts {
				if !strings.Contains(sql, p) {
					t.Fatalf("missing FTS/structured fragment %q in WHERE:\n%s", p, sql)
				}
			}
			// …and never the legacy ILIKE jsonb scan.
			if strings.Contains(sql, legacyILIKEMarker) {
				t.Fatalf("query %q leaked into the legacy ILIKE path (found %q):\n%s",
					tc.raw, legacyILIKEMarker, sql)
			}
			// Tenant scope is always present and is $1.
			if !strings.Contains(sql, "WHERE tenant_id = $1::uuid") {
				t.Fatalf("structured WHERE dropped the tenant scope:\n%s", sql)
			}
			// At least the tenant arg must be bound; structured terms add more.
			if len(args) < 1 {
				t.Fatalf("expected ≥1 bound arg (tenant), got %d", len(args))
			}
		})
	}
}

// TestSearchEmptyAfterParseIs400Shape proves the handler's guard: a query
// made entirely of dropped operators (e.g. a half-typed `tag:`) parses to
// empty, so the handler short-circuits to 400 rather than routing a
// no-op WHERE that would scan the whole tenant.
func TestSearchEmptyAfterParseIs400Shape(t *testing.T) {
	for _, raw := range []string{"tag:", "  ", "tag:   "} {
		if !ParseSearch(raw).IsEmpty() {
			t.Fatalf("ParseSearch(%q) should be empty so the handler 400s", raw)
		}
	}
}

// TestSearchWithQuerySignature is a compile-time pin that the new repo
// method matches the structured-search shape the handler depends on (so the
// handler swap stays a drop-in and callers/tests stay aligned). Assigning
// the method to a typed func var fails to compile if the signature drifts.
func TestSearchWithQuerySignature(t *testing.T) {
	var r *Repo
	var _ func(context.Context, string, SearchQuery, int, int, bool) (*Page, error) = r.SearchWithQuery
}
