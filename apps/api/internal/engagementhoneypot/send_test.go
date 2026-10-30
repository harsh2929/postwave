// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"strings"
	"testing"
	"time"
)

func TestSendMinterProducesOneMarkupPerCertifyingTechnique(t *testing.T) {
	sender := &SendMinter{Minter: testMinter(t), BaseURL: "https://track.example.test"}
	markup, err := sender.MintDecoys(
		"8e3d1c6a-0000-4000-8000-000000000001",
		"8e3d1c6a-0000-4000-8000-000000000002",
		4242, time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("MintDecoys: %v", err)
	}
	if len(markup) != len(CertifyingTechniques()) {
		t.Fatalf("got %d decoys, want one per certifying technique (%d)",
			len(markup), len(CertifyingTechniques()))
	}
	for _, entry := range markup {
		if !strings.Contains(entry, DecoyPath) {
			t.Errorf("decoy markup does not point at the decoy path: %q", entry)
		}
	}
}

func TestSendMinterNeverFailsASend(t *testing.T) {
	// A decoy is measurement. A send that fails because the instrument failed
	// is strictly worse than a send carrying one fewer label, so every
	// misconfiguration must degrade to "no decoy" rather than surface an error.
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	for name, sender := range map[string]*SendMinter{
		"no minter":      {BaseURL: "https://track.example.test"},
		"no base url":    {Minter: testMinter(t)},
		"plaintext base": {Minter: testMinter(t), BaseURL: "http://track.example.test"},
		"markup in base": {Minter: testMinter(t), BaseURL: `https://x.test/"><script>`},
	} {
		markup, err := sender.MintDecoys(
			"8e3d1c6a-0000-4000-8000-000000000001",
			"8e3d1c6a-0000-4000-8000-000000000002", 1, issued)
		if err != nil {
			t.Errorf("%s: returned an error that would be seen by the send path: %v", name, err)
		}
		if len(markup) != 0 {
			t.Errorf("%s: returned %d decoys, want none", name, len(markup))
		}
	}
}

func TestSendMinterCarriesNoRecipientAddress(t *testing.T) {
	sender := &SendMinter{Minter: testMinter(t), BaseURL: "https://track.example.test"}
	markup, err := sender.MintDecoys(
		"8e3d1c6a-0000-4000-8000-000000000001",
		"8e3d1c6a-0000-4000-8000-000000000002",
		4242, time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("MintDecoys: %v", err)
	}
	for _, entry := range markup {
		if strings.Contains(entry, "@") {
			t.Errorf("decoy markup contains an at-sign: %q", entry)
		}
	}
}
