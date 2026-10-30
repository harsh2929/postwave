package nql

import "testing"

// estimate() translated only status/domain predicates to SQL. tag/segment/list/
// newsletter/tier were dropped from the WHERE clause entirely, so
// "status:enabled tag:vip" counted ALL enabled subscribers — a superset — and
// the caller got only a subtle confidence=false hint. A superset labelled
// "approximate" is still a wrong number an operator plans against.
//
// The fix: build exact SQL for what we can (status, domain, tag), and refuse to
// return a count at all when any predicate is untranslatable — no superset ever.
func TestBuildEstimateClauses(t *testing.T) {
	t.Run("status + domain translate exactly", func(t *testing.T) {
		clauses, args, exact := buildEstimateClauses("t1", []Predicate{
			{Field: "status", Value: "enabled"},
			{Field: "domain", Value: "example.com"},
		})
		if !exact {
			t.Fatal("status + domain are fully translatable")
		}
		if len(clauses) != 3 { // tenant + status + domain
			t.Fatalf("clauses = %v", clauses)
		}
		if len(args) != 3 {
			t.Fatalf("args = %v", args)
		}
	})

	t.Run("tag translates to a real array-contains, not a drop", func(t *testing.T) {
		clauses, args, exact := buildEstimateClauses("t1", []Predicate{
			{Field: "status", Value: "enabled"},
			{Field: "tag", Value: "vip"},
		})
		if !exact {
			t.Fatal("status + tag are both translatable")
		}
		joined := ""
		for _, c := range clauses {
			joined += c + " | "
		}
		if !containsSub(joined, "tags @>") {
			t.Fatalf("tag must become a real tags @> predicate, got: %s", joined)
		}
		if args[len(args)-1] == nil {
			t.Fatal("tag value must be bound")
		}
	})

	t.Run("an untranslatable predicate yields NO exact count (never a superset)", func(t *testing.T) {
		_, _, exact := buildEstimateClauses("t1", []Predicate{
			{Field: "status", Value: "enabled"},
			{Field: "segment", Value: "abc"}, // not translatable to a flat WHERE
		})
		if exact {
			t.Fatal("a segment predicate cannot be represented here; must NOT report an exact count, or the count is a superset")
		}
	})

	t.Run("no predicates is not an exact count", func(t *testing.T) {
		if _, _, exact := buildEstimateClauses("t1", nil); exact {
			t.Fatal("no predicates cannot produce a count")
		}
	})
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
