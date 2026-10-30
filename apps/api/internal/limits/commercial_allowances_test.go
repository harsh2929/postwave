package limits

import "testing"

func TestAssetStorageAllowanceBytes(t *testing.T) {
	tests := []struct {
		tier      string
		canonical string
		bytes     int64
	}{
		{"", "sandbox", 250 * 1024 * 1024},
		{"sending", "launch", 2 * gib},
		{"growth", "growth", 10 * gib},
		{"pro", "scale", 50 * gib},
		{"unknown", "sandbox", 250 * 1024 * 1024},
	}
	for _, tt := range tests {
		canonical, got := AssetStorageAllowanceBytes(tt.tier)
		if canonical != tt.canonical || got != tt.bytes {
			t.Errorf("tier %q: canonical=%q bytes=%d, want %q/%d", tt.tier, canonical, got, tt.canonical, tt.bytes)
		}
	}
}
