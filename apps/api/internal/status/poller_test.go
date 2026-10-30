package status

import "testing"

func TestHealthURLPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	got, err := healthURL("https://status.example.com/internal/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://status.example.com/internal/health" {
		t.Fatalf("healthURL = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@status.example.com",
		"https://status.example.com?tenant=one",
		"https://status.example.com#fragment",
		"file:///tmp/status",
	} {
		if _, err := healthURL(base); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
}
