package runtime

import (
	"fmt"
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

func TestPickSplitVariant(t *testing.T) {
	variants := []canonical.AutomationSplitVariant{
		{ID: "a", Percentage: 50, Next: "na"},
		{ID: "b", Percentage: 50, Next: "nb"},
	}

	// Deterministic: the same key always routes the same way.
	key := "auto|node|x@y.com"
	first := pickSplitVariant(variants, key)
	second := pickSplitVariant(variants, key)
	if first != second {
		t.Fatal("pickSplitVariant is not deterministic for a stable key")
	}

	// Both legs are reachable across many subscribers, and roughly balanced.
	seen := map[string]int{}
	for i := 0; i < 1000; i++ {
		seen[pickSplitVariant(variants, fmt.Sprintf("k%d", i))]++
	}
	if seen["na"] == 0 || seen["nb"] == 0 {
		t.Fatalf("a 50/50 split never took one leg: %v", seen)
	}
	if seen["na"] < 350 || seen["nb"] < 350 {
		t.Fatalf("50/50 split badly skewed: %v", seen)
	}

	// Percentages summing to <100: the remainder routes to the last leg, so
	// every subscriber still gets a destination (no empty Next).
	partial := []canonical.AutomationSplitVariant{
		{Percentage: 10, Next: "x"},
		{Percentage: 10, Next: "y"},
	}
	for i := 0; i < 200; i++ {
		if pickSplitVariant(partial, fmt.Sprintf("z%d", i)) == "" {
			t.Fatal("partial-sum split produced an empty Next")
		}
	}

	// No variants → empty (caller treats as end-of-flow).
	if pickSplitVariant(nil, key) != "" {
		t.Fatal("want empty Next for zero variants")
	}
}

func TestStableBucketRange(t *testing.T) {
	for i := 0; i < 500; i++ {
		b := stableBucket(fmt.Sprintf("key-%d", i), 100)
		if b >= 100 {
			t.Fatalf("bucket out of range: %d", b)
		}
	}
	if stableBucket("k", 0) != 0 {
		t.Fatal("mod 0 must not panic and returns 0")
	}
}
