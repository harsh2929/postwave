// SPDX-License-Identifier: AGPL-3.0-only
package sending

import (
	"fmt"
	"testing"
)

func TestRouteMessenger_NilSafeFallback(t *testing.T) {
	// No dedicated IP → always shared, regardless of policy.
	if got := routeMessenger(&routingPolicy{Strategy: "dedicated_only"}, "", "a@b.test"); got != "" {
		t.Errorf("no dedicated messenger must route shared, got %q", got)
	}
	// No policy → legacy all-dedicated (unchanged behaviour).
	if got := routeMessenger(nil, "dedicated-pool1", "a@b.test"); got != "dedicated-pool1" {
		t.Errorf("no policy must preserve dedicated routing, got %q", got)
	}
	// Unknown strategy → legacy dedicated.
	if got := routeMessenger(&routingPolicy{Strategy: "weird"}, "dedicated-pool1", "a@b.test"); got != "dedicated-pool1" {
		t.Errorf("unknown strategy must preserve dedicated routing, got %q", got)
	}
}

func TestRouteMessenger_Strategies(t *testing.T) {
	ded := "dedicated-pool1"
	if got := routeMessenger(&routingPolicy{Strategy: "shared_only"}, ded, "a@b.test"); got != "" {
		t.Errorf("shared_only must route shared, got %q", got)
	}
	if got := routeMessenger(&routingPolicy{Strategy: "dedicated_only"}, ded, "a@b.test"); got != ded {
		t.Errorf("dedicated_only must route dedicated, got %q", got)
	}
}

func TestRouteMessenger_HybridSplitAndStability(t *testing.T) {
	ded := "dedicated-pool1"
	emails := make([]string, 0, 5000)
	for i := 0; i < 5000; i++ {
		emails = append(emails, fmt.Sprintf("user%d@example.test", i))
	}

	// 0 bp → everyone shared; 10000 bp → everyone dedicated.
	for _, e := range emails[:200] {
		if got := routeMessenger(&routingPolicy{Strategy: "hybrid", DedicatedBP: 0}, ded, e); got != "" {
			t.Fatalf("0bp must be all-shared, %q got %q", e, got)
		}
		if got := routeMessenger(&routingPolicy{Strategy: "hybrid", DedicatedBP: 10000}, ded, e); got != ded {
			t.Fatalf("10000bp must be all-dedicated, %q got %q", e, got)
		}
	}

	// 3000 bp (30%) → roughly 30% dedicated over the population.
	pol := &routingPolicy{Strategy: "hybrid", DedicatedBP: 3000}
	dedCount := 0
	for _, e := range emails {
		if routeMessenger(pol, ded, e) == ded {
			dedCount++
		}
	}
	frac := float64(dedCount) / float64(len(emails))
	if frac < 0.25 || frac > 0.35 {
		t.Errorf("hybrid 30%% split = %.1f%% dedicated, want ~30%% (tolerance 25-35%%)", frac*100)
	}

	// Stability: the same email routes the same way every time.
	for _, e := range emails[:200] {
		first := routeMessenger(pol, ded, e)
		second := routeMessenger(pol, ded, e)
		if first != second {
			t.Fatalf("routing for %q is not stable", e)
		}
	}
}
