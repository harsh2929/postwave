// SPDX-License-Identifier: AGPL-3.0-only

package sto_content_optimizer

import (
	"math"
	"testing"
)

func v(ids ...string) []ComponentVariant {
	out := make([]ComponentVariant, len(ids))
	for i, id := range ids {
		out[i] = ComponentVariant{ID: id, Text: id}
	}
	return out
}

func TestObjectiveValid(t *testing.T) {
	for _, o := range []Objective{ObjectiveOpenRate, ObjectiveClickRate, ObjectiveConversionRate} {
		if !o.Valid() {
			t.Errorf("%q should be valid", o)
		}
	}
	for _, o := range []Objective{"", "revenue", "ctr"} {
		if Objective(o).Valid() {
			t.Errorf("%q should be invalid", o)
		}
	}
}

func TestValidateManifest(t *testing.T) {
	if err := validateManifest(ComponentsManifest{Subject: v("s1", "s2"), CTA: v("c1")}); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	if err := validateManifest(ComponentsManifest{}); err == nil {
		t.Fatalf("empty manifest must be rejected")
	}
	if err := validateManifest(ComponentsManifest{Subject: v("s1", "s1")}); err == nil {
		t.Fatalf("duplicate variant id must be rejected")
	}
	if err := validateManifest(ComponentsManifest{Subject: []ComponentVariant{{ID: ""}}}); err == nil {
		t.Fatalf("empty variant id must be rejected")
	}
}

func TestCartesianCount(t *testing.T) {
	cases := []struct {
		name string
		m    ComponentsManifest
		want int
	}{
		{"2x2", ComponentsManifest{Subject: v("s1", "s2"), CTA: v("c1", "c2")}, 4},
		{"subject only", ComponentsManifest{Subject: v("s1", "s2", "s3")}, 3},
		{"empty", ComponentsManifest{}, 0},
		{"3x2x2", ComponentsManifest{Subject: v("a", "b", "c"), Header: v("h1", "h2"), CTA: v("c1", "c2")}, 12},
	}
	for _, c := range cases {
		if got := cartesianCount(c.m); got != c.want {
			t.Errorf("%s: cartesianCount = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestCartesianKeysMatchCount(t *testing.T) {
	m := ComponentsManifest{Subject: v("s1", "s2"), Header: v("h1"), CTA: v("c1", "c2")}
	keys := cartesianKeys(m)
	if len(keys) != cartesianCount(m) {
		t.Fatalf("cartesianKeys len %d != cartesianCount %d", len(keys), cartesianCount(m))
	}
	// keys must be unique
	seen := map[string]bool{}
	for _, k := range keys {
		if seen[k] {
			t.Fatalf("duplicate cartesian key %q", k)
		}
		seen[k] = true
	}
}

func TestUniformAllocation(t *testing.T) {
	m := ComponentsManifest{Subject: v("s1", "s2"), CTA: v("c1", "c2")}
	alloc := uniformAllocation(m)
	if len(alloc) != 4 {
		t.Fatalf("want 4 arms, got %d", len(alloc))
	}
	var sum float64
	for _, w := range alloc {
		if math.Abs(w-0.25) > 1e-9 {
			t.Errorf("arm weight = %v, want 0.25", w)
		}
		sum += w
	}
	if math.Abs(sum-1.0) > 1e-9 {
		t.Fatalf("allocation must sum to 1.0, got %v", sum)
	}
	// A single-variant single-slot manifest is the smallest real input
	// (validateManifest guarantees >=1 variant before uniformAllocation is
	// ever reached, so the empty-manifest case is unreachable in CreateRun).
	solo := uniformAllocation(ComponentsManifest{Subject: v("s1")})
	if len(solo) != 1 {
		t.Fatalf("single-variant manifest should yield 1 arm, got %d", len(solo))
	}
	for _, w := range solo {
		if math.Abs(w-1.0) > 1e-9 {
			t.Fatalf("sole arm should get full traffic, got %v", w)
		}
	}
}
