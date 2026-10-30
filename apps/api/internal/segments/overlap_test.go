// SPDX-License-Identifier: AGPL-3.0-only
//
// overlap_test.go — pure tests for the placeholder shifter, jaccard
// math, and growth helpers. DB-backed overlap counting is covered by
// the compile tests' fragment guarantees (CompileAST output is
// parameterised) + the standard DB-skip suite.

package segments

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestShiftPlaceholders(t *testing.T) {
	t.Parallel()
	cases := []struct {
		frag   string
		offset int
		want   string
	}{
		{"TRUE", 3, "TRUE"},
		{"email = $1", 0, "email = $1"},
		{"email = $1", 2, "email = $3"},
		{"(a = $1 AND b = $2) OR c = $3", 10, "(a = $11 AND b = $12) OR c = $13"},
		// Double-digit placeholders must shift as a unit, not per-digit.
		{"x = $12", 1, "x = $13"},
	}
	for _, tc := range cases {
		if got := shiftPlaceholders(tc.frag, tc.offset); got != tc.want {
			t.Errorf("shiftPlaceholders(%q, %d) = %q, want %q",
				tc.frag, tc.offset, got, tc.want)
		}
	}
}

// TestShiftPlaceholders_CompiledFragment runs the shifter over a real
// compiler output to guard against the compiler emitting placeholder
// shapes the regexp misses.
func TestShiftPlaceholders_CompiledFragment(t *testing.T) {
	t.Parallel()
	ast := json.RawMessage(`{
		"op": "and",
		"children": [
			{"op": "condition", "field": "status", "comparator": "equals", "value": "enabled"},
			{"op": "condition", "field": "email", "comparator": "contains", "value": "@example.com"}
		]
	}`)
	frag, args, err := CompileAST(ast)
	if err != nil {
		t.Fatalf("CompileAST: %v", err)
	}
	if len(args) == 0 {
		t.Fatalf("expected parameterised fragment, got %q", frag)
	}
	shifted := shiftPlaceholders(frag, len(args))
	if strings.Contains(shifted, "$1 ") || strings.HasSuffix(shifted, "$1") {
		t.Errorf("shifted fragment still references $1: %q", shifted)
	}
	for i := 1; i <= len(args); i++ {
		want := "$" + strconv.Itoa(i+len(args))
		if !strings.Contains(shifted, want) {
			t.Errorf("shifted fragment missing %s: %q", want, shifted)
		}
	}
}

func TestJaccard(t *testing.T) {
	t.Parallel()
	cases := []struct {
		a, b, inter int64
		want        float64
	}{
		{0, 0, 0, 0},
		{10, 0, 0, 0},
		{10, 10, 10, 1},
		{100, 100, 50, 50.0 / 150.0},
		{5, 5, 0, 0},
	}
	for _, tc := range cases {
		if got := jaccard(tc.a, tc.b, tc.inter); got != tc.want {
			t.Errorf("jaccard(%d,%d,%d) = %v, want %v", tc.a, tc.b, tc.inter, got, tc.want)
		}
	}
}

func TestParseGrowthDays(t *testing.T) {
	t.Parallel()
	cases := map[string]int{
		"":     90,
		"30":   30,
		"90d":  90,
		"abc":  90,
		"-5":   90,
		"0":    90,
		"9999": 365,
	}
	for in, want := range cases {
		if got := parseGrowthDays(in); got != want {
			t.Errorf("parseGrowthDays(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestGrowthDelta(t *testing.T) {
	t.Parallel()
	now := time.Now()
	mk := func(counts ...int) []GrowthPoint {
		out := make([]GrowthPoint, 0, len(counts))
		for _, c := range counts {
			out = append(out, GrowthPoint{Date: "2026-06-01", EvaluatedAt: now, Count: c})
		}
		return out
	}
	if d, p := growthDelta(nil); d != 0 || p != 0 {
		t.Errorf("empty series: got (%d, %v)", d, p)
	}
	if d, p := growthDelta(mk(100)); d != 0 || p != 0 {
		t.Errorf("single point: got (%d, %v)", d, p)
	}
	if d, p := growthDelta(mk(100, 110, 150)); d != 50 || p != 50 {
		t.Errorf("growth: got (%d, %v), want (50, 50)", d, p)
	}
	if d, p := growthDelta(mk(0, 25)); d != 25 || p != 0 {
		t.Errorf("zero baseline: got (%d, %v), want (25, 0)", d, p)
	}
	if d, _ := growthDelta(mk(200, 150)); d != -50 {
		t.Errorf("shrink: got delta %d, want -50", d)
	}
}
