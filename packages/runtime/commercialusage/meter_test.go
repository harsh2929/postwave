package commercialusage

import "testing"

func TestCanonicalCatalog(t *testing.T) {
	tests := []struct {
		tier      string
		canonical string
		ai        int64
		runs      int64
		events    int64
		api       int64
	}{
		{"", "sandbox", 25_000, 10_000, 50_000, 10_000},
		{"sending", "launch", 250_000, 25_000, 250_000, 100_000},
		{"growth", "growth", 1_250_000, 250_000, 1_000_000, 500_000},
		{"pro", "scale", 5_000_000, 2_500_000, 4_000_000, 1_500_000},
		{"unknown", "sandbox", 25_000, 10_000, 50_000, 10_000},
	}
	for _, tt := range tests {
		if got := CanonicalTier(tt.tier); got != tt.canonical {
			t.Errorf("CanonicalTier(%q)=%q want %q", tt.tier, got, tt.canonical)
		}
		if got := LimitForTier(tt.tier, ResourceAICreditMillis); got != tt.ai {
			t.Errorf("ai(%q)=%d want %d", tt.tier, got, tt.ai)
		}
		if got := LimitForTier(tt.tier, ResourceAutomationRuns); got != tt.runs {
			t.Errorf("runs(%q)=%d want %d", tt.tier, got, tt.runs)
		}
		if got := LimitForTier(tt.tier, ResourceTrackedEvents); got != tt.events {
			t.Errorf("events(%q)=%d want %d", tt.tier, got, tt.events)
		}
		if got := LimitForTier(tt.tier, ResourceAPIOperations); got != tt.api {
			t.Errorf("api(%q)=%d want %d", tt.tier, got, tt.api)
		}
	}
}

func TestUnknownResourceFailsClosed(t *testing.T) {
	if got := LimitForTier("scale", Resource("future")); got != 0 {
		t.Fatalf("unknown resource limit=%d want 0", got)
	}
}
