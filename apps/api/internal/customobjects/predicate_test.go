// SPDX-License-Identifier: AGPL-3.0-only
package customobjects

import (
	"strings"
	"testing"
)

func TestBuildSegmentPredicate_EqualityFragment(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Property:      "status",
		Comparator:    "eq",
		Value:         "shipped",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, "EXISTS") {
		t.Errorf("expected EXISTS subquery, got %q", frag.SQL)
	}
	if !strings.Contains(frag.SQL, "r.properties ->> $2") {
		t.Errorf("expected single-property accessor with $2, got %q", frag.SQL)
	}
	wantArgs := []any{"order", "status", "shipped"}
	if !equalArgs(frag.Args, wantArgs) {
		t.Errorf("args = %v, want %v", frag.Args, wantArgs)
	}
}

func TestBuildSegmentPredicate_NumericComparison(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Property:      "total",
		Comparator:    "gte",
		Value:         "100",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, "::numeric") {
		t.Errorf("numeric comparison must cast to ::numeric, got %q", frag.SQL)
	}
	if !strings.Contains(frag.SQL, ">=") {
		t.Errorf("expected >= operator, got %q", frag.SQL)
	}
}

func TestBuildSegmentPredicate_DottedPathUsesArrayAccessor(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Property:      "shipping_address.country",
		Comparator:    "eq",
		Value:         "US",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, "string_to_array") {
		t.Errorf("dotted path should use string_to_array, got %q", frag.SQL)
	}
}

func TestBuildSegmentPredicate_ContainsUsesILIKE(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "wishlist",
		Property:      "title",
		Comparator:    "contains",
		Value:         "hoodie",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, "ILIKE") {
		t.Errorf("contains should use ILIKE, got %q", frag.SQL)
	}
	// Last arg should be the wildcard-wrapped pattern.
	if last, ok := frag.Args[len(frag.Args)-1].(string); !ok || last != "%hoodie%" {
		t.Errorf("contains arg should be wrapped with %%, got %v", frag.Args[len(frag.Args)-1])
	}
}

func TestBuildSegmentPredicate_InProducesAlternates(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Property:      "status",
		Comparator:    "in",
		Value:         "shipped,delivered,returned",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, " IN (") {
		t.Errorf("expected IN (...) clause, got %q", frag.SQL)
	}
	// 1 obj key + 1 property + 3 values = 5 args
	if len(frag.Args) != 5 {
		t.Errorf("in-clause should produce 5 args (1 key + 1 prop + 3 values), got %d", len(frag.Args))
	}
}

func TestBuildSegmentPredicate_ExistsEmptyClause(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Comparator:    "exists",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, "EXISTS (") || strings.Contains(frag.SQL, "NOT EXISTS") {
		t.Errorf("exists should produce plain EXISTS, got %q", frag.SQL)
	}
	if len(frag.Args) != 1 {
		t.Errorf("exists should produce only the type-key arg, got %v", frag.Args)
	}
}

func TestBuildSegmentPredicate_NotExistsWrapsCorrectly(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "wishlist",
		Comparator:    "not_exists",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.HasPrefix(frag.SQL, "NOT EXISTS") {
		t.Errorf("not_exists must produce NOT EXISTS, got %q", frag.SQL)
	}
}

func TestBuildSegmentPredicate_RejectsBadInputs(t *testing.T) {
	cases := []struct {
		name string
		spec PredicateSpec
	}{
		{"missing object type", PredicateSpec{Comparator: "eq", Property: "x", Value: "y"}},
		{"unknown comparator", PredicateSpec{ObjectTypeKey: "order", Comparator: "wat", Property: "x", Value: "y"}},
		{"missing property on eq", PredicateSpec{ObjectTypeKey: "order", Comparator: "eq", Value: "y"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := BuildSegmentPredicate(c.spec)
			if err == nil {
				t.Errorf("expected error for %s", c.name)
			}
		})
	}
}

func TestBuildSegmentPredicate_NoCustomerValueInlinedIntoSQL(t *testing.T) {
	// Security pin: the customer-supplied Value MUST never appear in
	// the SQL string. It must always be parameterised.
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Property:      "status",
		Comparator:    "eq",
		Value:         "'; DROP TABLE subscribers; --",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(frag.SQL, "DROP TABLE") {
		t.Fatalf("customer value leaked into SQL: %q", frag.SQL)
	}
	if strings.Contains(frag.SQL, "';") {
		t.Fatalf("customer value leaked into SQL: %q", frag.SQL)
	}
}

// SUB-011: LinkedToProfile scopes the EXISTS subquery through
// profile_object_links to the subscriber's own linked records, making
// profile links queryable in segmentation.
func TestBuildSegmentPredicate_LinkedToProfileScopesViaLinks(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey:   "order",
		Property:        "total",
		Comparator:      "gte",
		Value:           "100",
		LinkedToProfile: true,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(frag.SQL, "FROM profile_object_links pol") {
		t.Errorf("linked predicate must join profile_object_links, got %q", frag.SQL)
	}
	if !strings.Contains(frag.SQL, "pol.subscriber_id = subscribers.id") {
		t.Errorf("linked predicate must scope to the subscriber's links, got %q", frag.SQL)
	}
}

// Without LinkedToProfile the predicate keeps the historic tenant-wide
// record-presence behaviour (no profile_object_links join).
func TestBuildSegmentPredicate_DefaultIsTenantWide(t *testing.T) {
	frag, err := BuildSegmentPredicate(PredicateSpec{
		ObjectTypeKey: "order",
		Property:      "total",
		Comparator:    "gte",
		Value:         "100",
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if strings.Contains(frag.SQL, "profile_object_links") {
		t.Errorf("default predicate must NOT join profile_object_links, got %q", frag.SQL)
	}
	if !strings.Contains(frag.SQL, "r.tenant_id = subscribers.tenant_id") {
		t.Errorf("default predicate must scope by tenant, got %q", frag.SQL)
	}
}

func equalArgs(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
