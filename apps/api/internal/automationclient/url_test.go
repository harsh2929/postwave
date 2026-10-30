package automationclient

import (
	"strings"
	"testing"
)

func TestEventURLPreservesBasePath(t *testing.T) {
	got, err := EventURL("https://automation.example.test/internal/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://automation.example.test/internal/v1/automations/event" {
		t.Fatalf("EventURL = %q", got)
	}
}

func TestEventURLRejectsUnsafeBase(t *testing.T) {
	for _, base := range []string{
		"https://user:pass@automation.example.test",
		"https://automation.example.test?token=x",
		"https://automation.example.test#frag",
		"file:///tmp/automation",
	} {
		_, err := EventURL(base)
		if err == nil || (!strings.Contains(err.Error(), "unsafe automation base URL") &&
			!strings.Contains(err.Error(), "invalid automation base URL") &&
			!strings.Contains(err.Error(), "unsupported automation base URL scheme")) {
			t.Fatalf("base %q err = %v, want unsafe/invalid", base, err)
		}
	}
}
