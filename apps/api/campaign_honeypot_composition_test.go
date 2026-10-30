package main

import (
	"testing"

	"github.com/postwave/postwave/apps/api/internal/engagementhoneypot"
)

// A non-nil interface holding a nil pointer passes `!= nil` and is then called.
// The send runtime guards on exactly that check, so an unconfigured deployment
// must get an UNTYPED nil back, not an empty box that looks configured.
func TestUnconfiguredHoneypotYieldsAnUntypedNil(t *testing.T) {
	minter, err := engagementhoneypot.NewMinter([]byte("test-secret-with-enough-length-000000"), "k1")
	if err != nil {
		t.Fatalf("NewMinter: %v", err)
	}
	for name, got := range map[string]any{
		"no minter":   campaignHoneypotMinter(nil, "https://track.example.test", nil),
		"no base url": campaignHoneypotMinter(minter, "", nil),
		"blank base":  campaignHoneypotMinter(minter, "   ", nil),
	} {
		if got != nil {
			t.Errorf("%s: returned a non-nil interface (%T); the send runtime would treat it as configured", name, got)
		}
	}
}

func TestConfiguredHoneypotYieldsAMinter(t *testing.T) {
	minter, err := engagementhoneypot.NewMinter([]byte("test-secret-with-enough-length-000000"), "k1")
	if err != nil {
		t.Fatalf("NewMinter: %v", err)
	}
	if campaignHoneypotMinter(minter, "https://track.example.test", nil) == nil {
		t.Error("a fully configured honeypot produced no minter")
	}
}
