package engagementhoneypot_test

import (
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/engagementhoneypot"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// End to end across the seam that matters: a decoy minted by the send adapter
// must survive compilation into the HTML alternative and must be absent from
// text/plain, where nothing can be hidden.
func TestDecoyReachesCompiledHTMLAndNeverPlainText(t *testing.T) {
	minter, err := engagementhoneypot.NewMinter([]byte("test-secret-with-enough-length-000000"), "k1")
	if err != nil {
		t.Fatal(err)
	}
	sender := &engagementhoneypot.SendMinter{Minter: minter, BaseURL: "https://track.example.test"}
	decoys, err := sender.MintDecoys(
		"8e3d1c6a-0000-4000-8000-000000000001",
		"8e3d1c6a-0000-4000-8000-000000000002",
		4242, time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(decoys) == 0 {
		t.Fatal("no decoys minted")
	}
	document := semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2,
		Language:      "en-US",
		Direction:     semanticemail.DirectionLTR,
		Nodes: []semanticemail.Node{{
			ID: "title", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading,
			Version: semanticemail.NodeVersionV2,
			Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
				Level: 1,
				Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{
					{Kind: semanticemail.InlineText, Text: "Hi"},
				}},
			}},
			Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
		}},
	}
	result, diagnostics := semanticemail.CompileV2(document, semanticemail.CompileOptions{
		Locale: "en-US", HoneypotDecoys: decoys,
	})
	if diagnostics.HasErrors() {
		t.Fatalf("compile: %v", diagnostics)
	}
	for _, decoy := range decoys {
		if !strings.Contains(result.HTML, decoy) {
			t.Errorf("compiled HTML is missing a decoy:\n%s", result.HTML)
		}
	}
	if strings.Contains(result.Text, "engagement/hp") {
		t.Errorf("plain text carries a decoy:\n%s", result.Text)
	}
}
