// SPDX-License-Identifier: AGPL-3.0-only
package runtime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// The Go half of the shared comparator contract.
//
// `apps/api/internal/segments` compiles a condition to SQL; this package
// evaluates the same condition in memory for a flow branch. They are two
// implementations of one user-visible rule, and they disagreed:
//
//   - the SQL compiler emits and accepts `equals`/`not_equals`; this evaluator
//     recognised only `eq`/`neq`, so a condition authored in the segment
//     vocabulary hit the trailing `return false` and routed EVERY subscriber
//     down the false leg, silently and forever;
//   - `contains` on a tag list compared tags for exact equality here and
//     compiled to `ILIKE '%value%'` there, so `vip-gold` matched the segment
//     "Tag contains vip" and failed the identically-worded flow branch;
//   - `contains` on a string was case-sensitive here and case-insensitive there;
//   - `starts_with`, `ends_with`, `is_null` and `is_not_null` existed only in
//     SQL, and every one of them silently evaluated false here.
//
// The fixture is deliberately shared rather than duplicated. Two test files
// asserting the same behaviour from their own copies of the expectations is the
// same defect one level up: each side stays internally consistent while they
// drift apart. One file, two engines, one answer.
func TestComparatorParityAgainstTheSharedFixture(t *testing.T) {
	fixture := loadComparatorFixture(t)

	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			sub, ok := fixture.Subscribers[c.Subscriber]
			if !ok {
				t.Fatalf("fixture names subscriber %q, which it does not define", c.Subscriber)
			}
			got := Evaluate(canonical.SegmentCondition{
				Op:         "condition",
				Field:      c.Field,
				Comparator: c.Comparator,
				Value:      c.Value,
			}, sub)
			if got != c.Expected {
				t.Errorf("%s %s %v -> %v, want %v.\n%s",
					c.Field, c.Comparator, c.Value, got, c.Expected, c.Why)
			}
		})
	}
}

func TestAnUnknownComparatorIsNotSilentlyFalse(t *testing.T) {
	// The trailing `return false` was the mechanism that made every other
	// divergence invisible. A comparator this engine does not implement must be
	// distinguishable from one that legitimately evaluated false, or a whole
	// vocabulary can go unimplemented while the flow reports healthy.
	if Supported("no_such_comparator") {
		t.Fatal("an unimplemented comparator reported as supported")
	}
	if !Supported("equals") {
		t.Fatal("`equals` — the canonical spelling the SQL compiler emits — is not supported")
	}
	for _, c := range []string{
		"equals", "not_equals", "eq", "neq", "contains", "not_contains",
		"starts_with", "ends_with", "is_null", "is_not_null", "exists",
		"not_exists", "gt", "gte", "lt", "lte",
	} {
		if !Supported(c) {
			t.Errorf("comparator %q is in the segment vocabulary but not supported here, "+
				"so every branch using it takes the false leg", c)
		}
	}
}

type comparatorFixture struct {
	Subscribers map[string]canonical.Subscriber `json:"subscribers"`
	Cases       []comparatorCase                `json:"cases"`
}

type comparatorCase struct {
	Name       string      `json:"name"`
	Subscriber string      `json:"subscriber"`
	Field      string      `json:"field"`
	Comparator string      `json:"comparator"`
	Value      interface{} `json:"value"`
	Expected   bool        `json:"expected"`
	SkipSQL    bool        `json:"skip_sql"`
	Why        string      `json:"why"`
}

func loadComparatorFixture(t *testing.T) comparatorFixture {
	t.Helper()
	// Resolved by walking up to the repo root rather than hard-coding a depth,
	// so moving this package does not silently start reading nothing.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	var path string
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "packages", "segment-semantics", "comparator-fixture.json")
		if _, err := os.Stat(candidate); err == nil {
			path = candidate
			break
		}
		dir = filepath.Dir(dir)
	}
	if path == "" {
		t.Fatal("packages/segment-semantics/comparator-fixture.json not found walking up " +
			"from the test directory. This test is the only thing binding the two " +
			"segment engines together; it must fail rather than skip.")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var out comparatorFixture
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if len(out.Cases) == 0 {
		t.Fatal("the shared fixture has no cases; parity is asserted over nothing")
	}
	return out
}
